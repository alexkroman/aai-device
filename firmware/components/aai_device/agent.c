#include "agent.h"

#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "aai_events.h"
#include "board.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "protocol.h"
#include "resample.h"
#include "sdkconfig.h"

static const char *TAG = "agent";

#define MIC_BUF_BYTES     (2 * BOARD_SAMPLE_RATE * 2)  // 2 s pre-roll while connecting
#define SPK_BUF_BYTES     (8 * BOARD_SAMPLE_RATE * 2)  // server paces ~1.5 s ahead
#define SEND_CHUNK        512                          // samples, 32 ms @ 16 kHz
#define WS_BUFFER_SIZE    4096
#define TEXT_MAX          8192
#define RESUME_WINDOW_US  (110LL * 1000 * 1000)  // server keeps sessions 120 s
#define PROGRESS_EVERY_US (500 * 1000)
#define AMP_IDLE_OFF_US   (1000 * 1000)

static esp_websocket_client_handle_t s_ws;
static StreamBufferHandle_t s_mic_sb, s_spk_sb;

static atomic_bool s_active;      // session open (mic audio accepted)
static atomic_bool s_configured;  // session.configured received
static atomic_bool s_flush;       // player should drop buffered audio
static atomic_int_fast64_t s_last_activity_us, s_last_play_us;
static int s_in_rate = BOARD_SAMPLE_RATE, s_tts_rate = 24000;

static volatile int64_t s_convert_max_us;  // diagnostics: slowest TTS conversion call
static resampler_t s_tts_rs;               // agent TTS rate -> board rate; owned by the websocket task
static char s_session_id[96];
// Only resume sessions with a conversation: the server re-greets (on purpose) when
// a resumed session has no history, and that greeting would mute the question.
static bool s_session_has_turns;
static int64_t s_session_end_us;

static int64_t now_us(void) { return esp_timer_get_time(); }
static void touch(void) { s_last_activity_us = now_us(); }

static void send_json(const char *json)
{
    if (s_ws && esp_websocket_client_is_connected(s_ws)) {
        if (esp_websocket_client_send_text(s_ws, json, strlen(json), pdMS_TO_TICKS(500)) < 0) {
            ESP_LOGW(TAG, "send failed: %s", json);
        }
    }
}

// ---- server -> device -------------------------------------------------------

static void on_audio(const uint8_t *data, size_t len)
{
    // Large buffers live in PSRAM (EXT_RAM_BSS_ATTR): internal RAM is reserved for Wi-Fi/lwIP
    // and the websocket task stack. All are CPU-copied, never DMA'd or used with cache off.
    EXT_RAM_BSS_ATTR static int16_t in[WS_BUFFER_SIZE / 2 + 1];
    EXT_RAM_BSS_ATTR static int16_t out[WS_BUFFER_SIZE];
    static pcm_aligner_t aligner;

    size_t n = pcm_align(&aligner, data, len, in);
    // Slice so the output fits `out` at any negotiated rate (e.g. 8 kHz TTS upsamples 2x).
    size_t slice = resampler_max_in(&s_tts_rs, sizeof(out) / sizeof(out[0]));
    for (size_t pos = 0; slice > 0 && pos < n; pos += slice) {
        size_t chunk = n - pos < slice ? n - pos : slice;
        int64_t t0 = now_us();
        size_t produced = resampler_process(&s_tts_rs, in + pos, chunk, out);
        int64_t took = now_us() - t0;
        s_convert_max_us = took > s_convert_max_us ? took : s_convert_max_us;
        if (xStreamBufferSend(s_spk_sb, out, produced * 2, 0) != produced * 2) {
            ESP_LOGW(TAG, "speaker buffer overflow");
        }
    }
}

static void on_event(const char *json, size_t len)
{
    EXT_RAM_BSS_ATTR static proto_msg_t msg;  // ~650 bytes; keep it off the websocket task stack
    if (!proto_parse(json, len, &msg)) {
        return;
    }
    touch();
    if (msg.type != PROTO_OTHER) {
        aai_events_post(AAI_EVENT_MESSAGE, &msg, sizeof(msg));
    }

    switch (msg.type) {
    case PROTO_SESSION_CONFIGURED:
        s_in_rate = msg.sample_rate;
        s_tts_rate = msg.tts_sample_rate;
        if (msg.session_id[0]) {
            strlcpy(s_session_id, msg.session_id, sizeof(s_session_id));
        }
        ESP_LOGI(TAG, "session %s: mic %d Hz, tts %d Hz", s_session_id, s_in_rate, s_tts_rate);
        resampler_init(&s_tts_rs, s_tts_rate, BOARD_SAMPLE_RATE);
        send_json("{\"type\":\"audio_ready\"}");
        s_configured = true;
        aai_events_post(AAI_EVENT_SESSION_READY, NULL, 0);
        break;
    case PROTO_REPLY_CANCELLED:
    case PROTO_SESSION_RESET:
        // Barge-in. Note: speech.started is NOT an interruption signal; only this is.
        ESP_LOGI(TAG, "%s: flushing playback", msg.type == PROTO_REPLY_CANCELLED ? "reply.cancelled" : "session.reset");
        s_flush = true;
        break;
    case PROTO_USER_TRANSCRIPT:
        s_session_has_turns = true;
        ESP_LOGI(TAG, "you: %s", msg.text);
        break;
    case PROTO_AGENT_TRANSCRIPT:
        ESP_LOGI(TAG, "agent: %s", msg.text);
        break;
    case PROTO_TOOL_CALLED:
        ESP_LOGI(TAG, "tool: %s", msg.text);
        break;
    case PROTO_ERROR:
        ESP_LOGE(TAG, "error (%s%s): %s", msg.code, msg.fatal ? ", fatal" : "", msg.text);
        if (msg.fatal) {
            s_session_id[0] = '\0';
            aai_events_post(AAI_EVENT_SESSION_CLOSED, NULL, 0);
        }
        break;
    case PROTO_TIMED_OUT:
        s_session_id[0] = '\0';
        aai_events_post(AAI_EVENT_SESSION_CLOSED, NULL, 0);
        break;
    case PROTO_OTHER:
        break;
    }
}

static void ws_handler(void *arg, esp_event_base_t base, int32_t id, void *event_data)
{
    esp_websocket_event_data_t *ev = event_data;
    EXT_RAM_BSS_ATTR static char text[TEXT_MAX];
    static uint8_t frame_op;

    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "connected");
        break;
    case WEBSOCKET_EVENT_DATA: {
        uint8_t op = ev->op_code & 0x0F;
        if (op == 0x1 || op == 0x2) {
            frame_op = op;
        } else if (op != 0x0) {
            break;  // ping/pong/close are handled by the client library
        }
        if (frame_op == 0x2) {
            on_audio((const uint8_t *)ev->data_ptr, ev->data_len);
        } else if (ev->payload_len < TEXT_MAX) {
            memcpy(text + ev->payload_offset, ev->data_ptr, ev->data_len);
            if (ev->payload_offset + ev->data_len >= ev->payload_len) {
                on_event(text, ev->payload_len);
            }
        }
        break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGW(TAG, "socket closed (event %ld)", (long)id);
        if (s_active) {
            aai_events_post(AAI_EVENT_SESSION_CLOSED, NULL, 0);
        }
        break;
    default:
        break;
    }
}

// ---- device -> server -------------------------------------------------------

static void sender_task(void *arg)
{
    EXT_RAM_BSS_ATTR static int16_t in[SEND_CHUNK];
    EXT_RAM_BSS_ATTR static int16_t out[SEND_CHUNK * 2 + 4];
    resampler_t rs;  // board rate -> agent input rate; owned by this task
    bool was_configured = false;
    int64_t last_progress = 0;

    for (;;) {
        if (!s_active || !s_configured) {
            if (!s_active) {
                xStreamBufferReset(s_mic_sb);  // drop leftovers so the next session starts clean
            }
            was_configured = false;
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (!was_configured) {
            resampler_init(&rs, BOARD_SAMPLE_RATE, s_in_rate);
            was_configured = true;
        }
        // Read only as much as fits `out` after resampling (48 kHz agents upsample 3x).
        size_t want = resampler_max_in(&rs, sizeof(out) / sizeof(out[0]));
        want = want < SEND_CHUNK ? want : SEND_CHUNK;
        size_t got = xStreamBufferReceive(s_mic_sb, in, want * 2, pdMS_TO_TICKS(50)) / 2;
        if (got > 0) {
            size_t n = resampler_process(&rs, in, got, out);
            // A stalled socket must not back up the mic: drop instead of queueing.
            esp_websocket_client_send_bin(s_ws, (const char *)out, n * 2, pdMS_TO_TICKS(50));
        }
        size_t buffered = xStreamBufferBytesAvailable(s_spk_sb);
        if (buffered > 0 && now_us() - last_progress > PROGRESS_EVERY_US) {
            char msg[64];
            snprintf(msg, sizeof(msg), "{\"type\":\"playback_progress\",\"bufferedMs\":%u}",
                     (unsigned)(buffered * 1000 / (BOARD_SAMPLE_RATE * 2)));
            send_json(msg);
            last_progress = now_us();
        }
    }
}

static void player_task(void *arg)
{
    EXT_RAM_BSS_ATTR static int16_t buf[256];
    int64_t burst_start = 0;  // 0 = idle
    size_t burst_samples = 0;
    unsigned underruns = 0;  // buffer ran dry mid-burst (audible gap)
    int64_t max_gap_us = 0;
    for (;;) {
        if (s_flush) {
            size_t dropped = xStreamBufferBytesAvailable(s_spk_sb);
            if (xStreamBufferReset(s_spk_sb) == pdPASS) {
                ESP_LOGI(TAG, "flushed %u ms of playback", (unsigned)(dropped * 1000 / (BOARD_SAMPLE_RATE * 2)));
                s_flush = false;
            } else {
                ESP_LOGW(TAG, "flush deferred: buffer busy");  // retried next loop
            }
        }
        size_t got = xStreamBufferReceive(s_spk_sb, buf, sizeof(buf), pdMS_TO_TICKS(20)) / 2;
        if (got > 0) {
            if (!burst_start) {
                burst_start = now_us();
                burst_samples = 0;
                underruns = 0;
                max_gap_us = 0;
                ESP_LOGI(TAG, "playback started");
            } else if (now_us() - s_last_play_us > 30 * 1000) {
                // Audio resumed after the DMA would have drained: the listener heard a gap.
                underruns++;
                int64_t gap = now_us() - s_last_play_us;
                max_gap_us = gap > max_gap_us ? gap : max_gap_us;
            }
            burst_samples += got;
            board_speaker_enable(true);  // amp only on while there is audio to play
            board_speaker_write(buf, got);
            s_last_play_us = now_us();
        } else {
            if (burst_start && now_us() - s_last_play_us > 200 * 1000) {
                ESP_LOGI(TAG, "playback ended (%u ms of audio, %u underruns, longest gap %u ms, convert max %u us)",
                         (unsigned)(burst_samples * 1000 / BOARD_SAMPLE_RATE), underruns, (unsigned)(max_gap_us / 1000),
                         (unsigned)s_convert_max_us);
                s_convert_max_us = 0;
                burst_start = 0;
            }
            if (now_us() - s_last_play_us > AMP_IDLE_OFF_US) {
                board_speaker_enable(false);
            }
        }
    }
}

// ---- public API -------------------------------------------------------------

static StreamBufferHandle_t psram_stream_buffer(size_t size)
{
    uint8_t *storage = heap_caps_malloc(size + 1, MALLOC_CAP_SPIRAM);
    StaticStreamBuffer_t *sb = heap_caps_malloc(sizeof(*sb), MALLOC_CAP_INTERNAL);
    return xStreamBufferCreateStatic(size, 1, storage, sb);
}

void agent_init(void)
{
    s_mic_sb = psram_stream_buffer(MIC_BUF_BYTES);
    s_spk_sb = psram_stream_buffer(SPK_BUF_BYTES);
    // Stacks in PSRAM: internal RAM is scarce, and the websocket client can only
    // put its own task stack there (none of these tasks touch flash).
    xTaskCreatePinnedToCoreWithCaps(player_task, "player", 4096, NULL, 7, NULL, 0, MALLOC_CAP_SPIRAM);
    xTaskCreatePinnedToCoreWithCaps(sender_task, "sender", 4096, NULL, 6, NULL, 0, MALLOC_CAP_SPIRAM);

    // One client for the device's lifetime. Creating/destroying it per session
    // fragments internal RAM until its task stack can no longer be allocated.
    esp_websocket_client_config_t cfg = {
        .uri = CONFIG_AAI_AGENT_URL,
        .buffer_size = WS_BUFFER_SIZE,
        .task_stack = 6144,
        .task_prio = 8,
        .disable_auto_reconnect = true,
        .network_timeout_ms = 5000,
    };
    s_ws = esp_websocket_client_init(&cfg);
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_handler, NULL);
    // Its per-session INFO lines are noise, and stop() on an already-stopped client
    // warns "Client was not started" by design (see agent_stop). Errors still show.
    esp_log_level_set("websocket_client", ESP_LOG_ERROR);
}

void agent_start(void)
{
    char uri[256];
    bool resume = s_session_id[0] && s_session_has_turns && now_us() - s_session_end_us < RESUME_WINDOW_US;
    if (!resume) {
        s_session_has_turns = false;
    }
    proto_session_url(CONFIG_AAI_AGENT_URL, resume ? s_session_id : NULL, uri, sizeof(uri));
    ESP_LOGI(TAG, "connecting to %s (internal heap free %u, largest block %u)", uri,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    s_configured = false;
    s_active = true;
    touch();
    esp_websocket_client_set_uri(s_ws, uri);
    if (esp_websocket_client_start(s_ws) != ESP_OK) {
        ESP_LOGE(TAG, "websocket start failed");
        aai_events_post(AAI_EVENT_SESSION_CLOSED, NULL, 0);
    }
}

void agent_stop(void)
{
    if (!s_active) {
        return;
    }
    s_active = false;
    s_configured = false;
    s_session_end_us = now_us();
    if (esp_websocket_client_is_connected(s_ws)) {
        esp_websocket_client_close(s_ws, pdMS_TO_TICKS(1000));  // polite close frame
    }
    // close() returns early without waiting if the server hung up first (and after its
    // timeout); stop() is the only call that waits for the client task to exit, so the
    // next agent_start() can't find it still running. No-op when already stopped.
    esp_websocket_client_stop(s_ws);
    ESP_LOGI(TAG, "session ended");
}

void agent_push_mic(const int16_t *pcm, size_t samples)
{
    if (s_active && s_mic_sb) {
        xStreamBufferSend(s_mic_sb, pcm, samples * 2, 0);
    }
}

void agent_cancel(void)
{
    s_flush = true;
    ESP_LOGI(TAG, "cancel requested");
    send_json("{\"type\":\"cancel\"}");
}

void agent_play_tone(int freq_hz, int ms)
{
    int n = BOARD_SAMPLE_RATE * ms / 1000;
    int16_t buf[160];
    for (int i = 0; i < n; i += 160) {
        int chunk = n - i < 160 ? n - i : 160;
        for (int j = 0; j < chunk; j++) {
            int k = i + j;
            float env = fminf(1.0f, fminf(k, n - k) / 160.0f);  // 10 ms fade in/out, no clicks
            buf[j] = (int16_t)(6000 * env * sinf(2 * M_PI * freq_hz * k / BOARD_SAMPLE_RATE));
        }
        xStreamBufferSend(s_spk_sb, buf, chunk * 2, pdMS_TO_TICKS(100));
    }
}

bool agent_speaker_busy(void)
{
    if (!s_spk_sb) {
        return false;  // agent_init() not called yet
    }
    return xStreamBufferBytesAvailable(s_spk_sb) > 0 || now_us() - s_last_play_us < 200 * 1000;
}

int64_t agent_last_activity_ms(void)
{
    int64_t last = s_last_activity_us > s_last_play_us ? s_last_activity_us : s_last_play_us;
    return last / 1000;
}
