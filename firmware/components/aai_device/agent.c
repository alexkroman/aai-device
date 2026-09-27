#include "agent.h"

#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "aai_events.h"
#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "protocol.h"
#include "esp_ae_rate_cvt.h"
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

// ---- sample-rate conversion (esp_audio_effects) -----------------------------

typedef struct {
    esp_ae_rate_cvt_handle_t handle;  // NULL when src == dst (passthrough)
    uint32_t src, dst;
} rate_cvt_t;

static bool rate_open(rate_cvt_t *r, uint32_t src, uint32_t dst)
{
    *r = (rate_cvt_t){.src = src, .dst = dst};
    if (src == dst) {
        return true;
    }
    esp_ae_rate_cvt_cfg_t cfg = {
        .src_rate = src,
        .dest_rate = dst,
        .channel = 1,
        .bits_per_sample = 16,
        .complexity = 2,
        .perf_type = ESP_AE_RATE_CVT_PERF_TYPE_MEMORY,  // internal RAM is the scarce resource
    };
    if (esp_ae_rate_cvt_open(&cfg, &r->handle) != ESP_AE_ERR_OK) {
        ESP_LOGE(TAG, "rate converter %lu -> %lu Hz failed", (unsigned long)src, (unsigned long)dst);
        return false;
    }
    return true;
}

static void rate_close(rate_cvt_t *r)
{
    if (r->handle) {
        esp_ae_rate_cvt_close(r->handle);
        r->handle = NULL;
    }
}

// Largest input whose converted output fits `cap` samples (the library only offers
// the forward bound, so shrink an estimate until it fits).
static size_t rate_max_in(const rate_cvt_t *r, size_t cap)
{
    if (!r->handle) {
        return cap;
    }
    size_t n = (size_t)((uint64_t)cap * r->src / r->dst);
    for (uint32_t out_max; n > 0; n -= n / 16 + 1) {
        if (esp_ae_rate_cvt_get_max_out_sample_num(r->handle, n, &out_max) == ESP_AE_ERR_OK && out_max <= cap) {
            break;
        }
    }
    return n;
}

static size_t rate_process(const rate_cvt_t *r, int16_t *in, size_t n, int16_t *out, size_t cap)
{
    if (!r->handle) {
        memcpy(out, in, n * sizeof(int16_t));
        return n;
    }
    uint32_t produced = cap;
    if (esp_ae_rate_cvt_process(r->handle, in, n, out, &produced) != ESP_AE_ERR_OK) {
        return 0;
    }
    return produced;
}

static rate_cvt_t s_tts_rate_cvt;  // agent TTS rate -> board rate; owned by the websocket task
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
    static int16_t in[WS_BUFFER_SIZE / 2 + 1];
    static int16_t out[WS_BUFFER_SIZE];
    static pcm_aligner_t aligner;

    size_t n = pcm_align(&aligner, data, len, in);
    // Slice so the output fits `out` at any negotiated rate (e.g. 8 kHz TTS upsamples 2x).
    const size_t cap = sizeof(out) / sizeof(out[0]);
    size_t slice = rate_max_in(&s_tts_rate_cvt, cap);
    for (size_t pos = 0; slice > 0 && pos < n; pos += slice) {
        size_t chunk = n - pos < slice ? n - pos : slice;
        size_t produced = rate_process(&s_tts_rate_cvt, in + pos, chunk, out, cap);
        if (xStreamBufferSend(s_spk_sb, out, produced * 2, 0) != produced * 2) {
            ESP_LOGW(TAG, "speaker buffer overflow");
        }
    }
}

static void on_event(const char *json, size_t len)
{
    static proto_msg_t msg;  // ~650 bytes; keep it off the websocket task stack
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
        rate_close(&s_tts_rate_cvt);
        rate_open(&s_tts_rate_cvt, s_tts_rate, BOARD_SAMPLE_RATE);
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
    static char text[TEXT_MAX];
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
    static int16_t in[SEND_CHUNK];
    static int16_t out[SEND_CHUNK * 2 + 4];
    rate_cvt_t rate = {0};  // board rate -> agent input rate; owned by this task
    bool was_configured = false;
    int64_t last_progress = 0;

    for (;;) {
        if (!s_active || !s_configured) {
            if (!s_active) {
                xStreamBufferReset(s_mic_sb);  // drop leftovers so the next session starts clean
            }
            was_configured = false;
            rate_close(&rate);
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (!was_configured) {
            rate_open(&rate, BOARD_SAMPLE_RATE, s_in_rate);
            was_configured = true;
        }
        // Read only as much as fits `out` after resampling (48 kHz agents upsample 3x).
        const size_t cap = sizeof(out) / sizeof(out[0]);
        size_t want = rate_max_in(&rate, cap);
        want = want < SEND_CHUNK ? want : SEND_CHUNK;
        size_t got = xStreamBufferReceive(s_mic_sb, in, want * 2, pdMS_TO_TICKS(50)) / 2;
        if (got > 0) {
            size_t n = rate_process(&rate, in, got, out, cap);
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
    static int16_t buf[256];
    int64_t burst_start = 0;  // 0 = idle
    size_t burst_samples = 0;
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
                ESP_LOGI(TAG, "playback started");
            }
            burst_samples += got;
            board_speaker_enable(true);  // amp only on while there is audio to play
            board_speaker_write(buf, got);
            s_last_play_us = now_us();
        } else {
            if (burst_start && now_us() - s_last_play_us > 200 * 1000) {
                ESP_LOGI(TAG, "playback ended (%u ms of audio)", (unsigned)(burst_samples * 1000 / BOARD_SAMPLE_RATE));
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
        esp_websocket_client_close(s_ws, pdMS_TO_TICKS(1000));
    } else {
        esp_websocket_client_stop(s_ws);  // server already hung up; just end the task
    }
    rate_close(&s_tts_rate_cvt);  // websocket task has stopped, so nothing is converting
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
