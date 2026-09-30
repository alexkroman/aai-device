#include "agent.h"

#include <math.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "aai_events.h"
#include "audio_rate.h"
#include "board.h"
#include "cJSON.h"
#include "discovery.h"
#include "esp_attr.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "inbox.h"
#include "lwip/sockets.h"
#include "protocol.h"
#include "sdkconfig.h"

static const char *TAG = "agent";

#define MIC_BUF_BYTES  (2 * BOARD_SAMPLE_RATE * 2)  // 2 s pre-roll while connecting
#define SPK_BUF_BYTES  (8 * BOARD_SAMPLE_RATE * 2)  // server paces ~1.5 s ahead
#define CUE_BUF_BYTES  (BOARD_SAMPLE_RATE * 2)      // 1 s of local cues
#define SEND_CHUNK     512                          // samples, 32 ms @ 16 kHz
#define WS_BUFFER_SIZE 4096
// esp_websocket_client ABORTS the connection when a send times out, so this is not a
// "drop the frame" knob: 50 ms (the old mic value) turned a brief Wi-Fi stall into a
// dead session. Backpressure is absorbed upstream instead — agent_push_mic() never
// blocks, so a slow socket drops mic audio at the stream buffer.
#define WS_SEND_TIMEOUT_MS 1000
#define TEXT_MAX           8192
#define RESUME_WINDOW_US   (110LL * 1000 * 1000)  // server keeps sessions 120 s
#define PROGRESS_EVERY_US  (500 * 1000)
#define AMP_IDLE_OFF_US    (1000 * 1000)
// The amp is switched on over I2C the moment audio arrives, and takes a moment to come up:
// without a lead-in the 120 ms wake chime played into an amp that wasn't on yet and was
// never heard. Silence rather than a delay keeps the I2S stream continuous.
#define AMP_WARMUP_MS 150
// How long after the last sample the speaker still counts as busy (DMA drain + room echo).
#define SPEAKER_TAIL_US (200 * 1000)
// A notice waits this long for room in the speaker buffer before giving up on a chunk.
#define NOTICE_SEND_TIMEOUT_MS 3000

static esp_websocket_client_handle_t s_ws;
static StreamBufferHandle_t s_mic_sb;
// Two speaker queues, because the two kinds of audio are treated differently: the reply is
// flushed on barge-in and mutes the mic in half duplex; our own cues (the wake chime) are
// neither, and the player plays them first.
static StreamBufferHandle_t s_spk_sb, s_cue_sb;

static atomic_bool s_active;      // session open (mic audio accepted)
static atomic_bool s_configured;  // session.configured received
static atomic_bool s_flush;       // player should drop the buffered reply
// Cancels sent whose reply.cancelled hasn't arrived. Reply audio arriving meanwhile is the
// interrupted reply's tail, already on the wire, and is dropped. The server answers every
// cancel with reply.cancelled, in order on this socket, so the count always drains.
static atomic_int s_cancels_pending;
static atomic_int_fast64_t s_last_activity_us;
static atomic_int_fast64_t s_last_reply_us, s_last_cue_us;  // last sample of each written
// Keep the amp on: the user's turn is committed and a reply is coming. Warming it up then,
// during the agent's thinking time, keeps AMP_WARMUP_MS off the front of every reply.
static atomic_bool s_amp_hold;
static atomic_int_fast64_t s_amp_release_us;  // when the hold last ended; counts as playing
static int s_in_rate = BOARD_SAMPLE_RATE, s_tts_rate = 24000;
static TaskHandle_t s_player, s_sender, s_closer;
// Held from agent_start() until the closer has fully stopped the client: the one client
// can't be started again while its task is still exiting.
static SemaphoreHandle_t s_client_free;
/** Longest agent_start() waits for the previous session's close before giving up. */
#define CLIENT_FREE_WAIT_MS 8000
static agent_observer_t s_observer;  // tests only

static volatile int64_t s_convert_max_us;  // diagnostics: slowest TTS conversion call
static audio_rate_t s_tts_rs;              // agent TTS rate -> board rate; owned by the websocket task
static char s_session_id[96];
// Only resume sessions with a conversation: the server re-greets (on purpose) when
// a resumed session has no history, and that greeting would mute the question.
static bool s_session_has_turns;
static int64_t s_session_end_us;

static void cues_init(void);

static int64_t now_us(void) { return esp_timer_get_time(); }
static unsigned bytes_to_ms(size_t bytes) { return (unsigned)(bytes * 1000 / (BOARD_SAMPLE_RATE * 2)); }
static void touch(void) { s_last_activity_us = now_us(); }

// The player sleeps without a timeout when it has nothing to do, so everything it acts on
// (queued audio, a flush, an amp hold change) wakes it.
static void wake_player(void)
{
    if (s_player) {
        xTaskNotifyGive(s_player);
    }
}

static void request_flush(void)
{
    s_flush = true;
    wake_player();
}

static void amp_hold(bool on)
{
    if (!on) {
        s_amp_release_us = now_us();  // first: the player must not see the hold gone without it
    }
    s_amp_hold = on;
    wake_player();
}

// esp_websocket_client doesn't expose its socket and leaves Nagle on, so a small frame (a
// 1 KB mic chunk, a cancel) waits for the previous one's ACK, which a host that delays ACKs
// holds for up to ~200 ms. The device opens no other TCP sockets: set it on all of them.
static void disable_nagle(void)
{
    for (int fd = LWIP_SOCKET_OFFSET; fd < LWIP_SOCKET_OFFSET + CONFIG_LWIP_MAX_SOCKETS; fd++) {
        int type;
        socklen_t len = sizeof(type);
        if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) == 0 && type == SOCK_STREAM) {
            int one = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
        }
    }
}

// cJSON allocates once per JSON node, every one under CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL,
// so by default each server event churns the internal RAM the websocket task stack needs.
static void *psram_malloc(size_t size)
{
    return heap_caps_malloc_prefer(size, 2, MALLOC_CAP_SPIRAM, MALLOC_CAP_DEFAULT);
}

// How busy each core was over a playback burst, for its log line: underruns with a pegged
// core point at CPU, not the network. Approximate: an idle task's time is only counted
// when it is switched out.
typedef struct {
    int64_t at_us;
    configRUN_TIME_COUNTER_TYPE idle[2];
} cpu_mark_t;

static cpu_mark_t cpu_mark(void)
{
    return (cpu_mark_t){now_us(), {ulTaskGetIdleRunTimeCounterForCore(0), ulTaskGetIdleRunTimeCounterForCore(1)}};
}

static unsigned cpu_busy_pct(const cpu_mark_t *m, int core)
{
    uint64_t elapsed = (uint64_t)(now_us() - m->at_us);
    uint64_t idle = (configRUN_TIME_COUNTER_TYPE)(ulTaskGetIdleRunTimeCounterForCore(core) - m->idle[core]);
    return elapsed > 0 && idle < elapsed ? (unsigned)(100 - idle * 100 / elapsed) : 0;
}

static bool send_json(const char *json)
{
    if (!s_ws || !esp_websocket_client_is_connected(s_ws)) {
        return false;
    }
    if (esp_websocket_client_send_text(s_ws, json, strlen(json), pdMS_TO_TICKS(WS_SEND_TIMEOUT_MS)) < 0) {
        ESP_LOGW(TAG, "send failed: %s", json);
        return false;
    }
    return true;
}

// ---- server -> device -------------------------------------------------------

static void on_audio(const uint8_t *data, size_t len, bool frame_start)
{
    // Large buffers live in PSRAM (EXT_RAM_BSS_ATTR): internal RAM is reserved for Wi-Fi/lwIP
    // and the websocket task stack. All are CPU-copied, never DMA'd or used with cache off.
    EXT_RAM_BSS_ATTR static int16_t in[WS_BUFFER_SIZE / 2 + 1];
    EXT_RAM_BSS_ATTR static int16_t out[WS_BUFFER_SIZE];
    // Pairs bytes into samples across websocket chunks, which can split a sample. A frame
    // holds whole samples, so a carry from an earlier frame is stale (it would shift every
    // later sample by a byte: static) — including one left by a dropped or cut-off frame.
    static pcm_aligner_t aligner;

    if (frame_start) {
        aligner = (pcm_aligner_t){0};
    }
    if (s_cancels_pending > 0) {
        return;
    }
    size_t n = pcm_align(&aligner, data, len, in);
    // Slice so the output fits `out` at any negotiated rate (e.g. 8 kHz TTS upsamples 2x).
    size_t slice = sizeof(in) / sizeof(in[0]);
    while (slice > 1 && audio_rate_max_out(&s_tts_rs, slice) > sizeof(out) / sizeof(out[0])) {
        slice /= 2;
    }
    for (size_t pos = 0; pos < n; pos += slice) {
        size_t chunk = n - pos < slice ? n - pos : slice;
        int64_t t0 = now_us();
        size_t produced = audio_rate_process(&s_tts_rs, in + pos, chunk, out);
        int64_t took = now_us() - t0;
        s_convert_max_us = took > s_convert_max_us ? took : s_convert_max_us;
        if (xStreamBufferSend(s_spk_sb, out, produced * 2, 0) != produced * 2) {
            ESP_LOGW(TAG, "speaker buffer overflow");
        }
    }
    wake_player();
}

static void on_event(const char *json, size_t len)
{
    EXT_RAM_BSS_ATTR static proto_msg_t msg;  // ~650 bytes; keep it off the websocket task stack
    if (!proto_parse(json, len, &msg)) {
        return;
    }
    touch();
    if (s_observer) {
        s_observer(&msg);
    }
    if (msg.type != PROTO_OTHER) {
        // Only the type: the app reads nothing else, and esp_event copies the payload into
        // internal RAM per post (the whole message is ~650 bytes).
        aai_events_post(AAI_EVENT_MESSAGE, &msg.type, sizeof(msg.type));
    }

    switch (msg.type) {
    case PROTO_SESSION_CONFIGURED:
        s_in_rate = msg.sample_rate;
        s_tts_rate = msg.tts_sample_rate;
        if (msg.session_id[0]) {
            strlcpy(s_session_id, msg.session_id, sizeof(s_session_id));
        }
        ESP_LOGI(TAG, "session %s: mic %d Hz, tts %d Hz", s_session_id, s_in_rate, s_tts_rate);
        audio_rate_open(&s_tts_rs, s_tts_rate, BOARD_SAMPLE_RATE);
        send_json("{\"type\":\"audio_ready\"}");
        s_configured = true;
        xTaskNotifyGive(s_sender);
        aai_events_post(AAI_EVENT_SESSION_READY, NULL, 0);
        break;
    case PROTO_REPLY_CANCELLED:
    case PROTO_SESSION_RESET:
        // Barge-in. Note: speech.started is NOT an interruption signal; only this is.
        ESP_LOGI(TAG, "%s: flushing playback", msg.type == PROTO_REPLY_CANCELLED ? "reply.cancelled" : "session.reset");
        amp_hold(false);
        request_flush();
        for (int n = s_cancels_pending; n > 0 && !atomic_compare_exchange_weak(&s_cancels_pending, &n, n - 1);) {
        }
        break;
    case PROTO_USER_TRANSCRIPT:
        s_session_has_turns = true;
        amp_hold(true);
        ESP_LOGI(TAG, "you: %s", msg.text);
        break;
    case PROTO_AGENT_TRANSCRIPT:
        // Released, not dropped: its audio may still be a moment behind the text, and the
        // amp stays up AMP_IDLE_OFF_US after the release to cover that.
        amp_hold(false);
        ESP_LOGI(TAG, "agent: %s", msg.text);
        break;
    case PROTO_TOOL_CALLED:
        ESP_LOGI(TAG, "tool: %s", msg.text);
        break;
    case PROTO_ERROR:
        ESP_LOGE(TAG, "error (%s%s): %s", msg.code, msg.fatal ? ", fatal" : "", msg.text);
        amp_hold(false);
        if (msg.fatal) {
            s_session_id[0] = '\0';
            aai_events_post(AAI_EVENT_SESSION_CLOSED, NULL, 0);
        }
        break;
    case PROTO_STOP:  // acted on in main.c, via AAI_EVENT_MESSAGE
        ESP_LOGI(TAG, "stop requested");
        break;
    case PROTO_TIMED_OUT:
        amp_hold(false);
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
        disable_nagle();
        break;
    case WEBSOCKET_EVENT_DATA: {
        uint8_t op = ev->op_code & 0x0F;
        if (op == 0x1 || op == 0x2) {
            frame_op = op;
        } else if (op != 0x0) {
            break;  // ping/pong/close are handled by the client library
        }
        if (frame_op == 0x2) {
            on_audio((const uint8_t *)ev->data_ptr, ev->data_len, ev->payload_offset == 0);
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
    // A 48 kHz agent upsamples 3x.
    EXT_RAM_BSS_ATTR static int16_t out[SEND_CHUNK * 3 + 64];
    static audio_rate_t rs;  // board rate -> agent input rate; owned by this task
    bool was_configured = false;
    int64_t last_progress = 0;

    for (;;) {
        if (!s_active || !s_configured) {
            if (!s_active) {
                xStreamBufferReset(s_mic_sb);  // drop leftovers so the next session starts clean
            }
            was_configured = false;
            // Sleeps through idle and connecting (the pre-roll accumulates meanwhile); woken
            // by session.configured.
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }
        if (!was_configured) {
            audio_rate_open(&rs, BOARD_SAMPLE_RATE, s_in_rate);
            was_configured = true;
        }
        // Read only as much as fits `out` after resampling (48 kHz agents upsample 3x).
        size_t want = SEND_CHUNK;
        while (want > 1 && audio_rate_max_out(&rs, want) > sizeof(out) / sizeof(out[0])) {
            want /= 2;
        }
        size_t got = xStreamBufferReceive(s_mic_sb, in, want * 2, pdMS_TO_TICKS(50)) / 2;
        // Checked per frame: after an abort this loop runs until agent_stop() clears s_active,
        // and every send in between would log another failed write on the dead socket.
        if (got > 0 && esp_websocket_client_is_connected(s_ws)) {
            size_t n = audio_rate_process(&rs, in, got, out);
            esp_websocket_client_send_bin(s_ws, (const char *)out, n * 2, pdMS_TO_TICKS(WS_SEND_TIMEOUT_MS));
        }
        size_t buffered = xStreamBufferBytesAvailable(s_spk_sb);
        if (buffered > 0 && now_us() - last_progress > PROGRESS_EVERY_US) {
            char msg[64];
            snprintf(msg, sizeof(msg), "{\"type\":\"playback_progress\",\"bufferedMs\":%u}", bytes_to_ms(buffered));
            send_json(msg);
            last_progress = now_us();
        }
    }
}

static void amp_up(void)
{
    static const int16_t k_silence[256];
    board_speaker_enable(true);
    for (int left = BOARD_SAMPLE_RATE * AMP_WARMUP_MS / 1000; left > 0; left -= 256) {
        board_speaker_write(k_silence, left < 256 ? left : 256);
    }
}

static void player_task(void *arg)
{
    EXT_RAM_BSS_ATTR static int16_t buf[256];
    int64_t burst_start = 0;  // 0 = idle
    size_t burst_samples = 0;
    cpu_mark_t burst_cpu = {0};
    bool amp_on = false;
    unsigned underruns = 0;  // buffer ran dry mid-burst (audible gap)
    int64_t max_gap_us = 0;
    for (;;) {
        if (s_flush) {
            size_t dropped = xStreamBufferBytesAvailable(s_spk_sb);
            if (xStreamBufferReset(s_spk_sb) == pdPASS) {
                ESP_LOGI(TAG, "flushed %u ms of playback", bytes_to_ms(dropped));
                s_flush = false;
            } else {
                ESP_LOGW(TAG, "flush deferred: buffer busy");  // retried next loop
            }
        }
        if (s_amp_hold && !amp_on) {
            amp_up();
            amp_on = true;
        }
        size_t got = xStreamBufferReceive(s_cue_sb, buf, sizeof(buf), 0) / 2;
        bool cue = got > 0;
        if (!cue) {
            got = xStreamBufferReceive(s_spk_sb, buf, sizeof(buf), 0) / 2;
        }
        int64_t last_play_us = s_last_reply_us > s_last_cue_us ? s_last_reply_us : s_last_cue_us;
        if (got > 0) {
            if (!burst_start) {
                burst_start = now_us();
                burst_cpu = cpu_mark();
                burst_samples = 0;
                underruns = 0;
                max_gap_us = 0;
                ESP_LOGI(TAG, "playback started");
            } else if (now_us() - last_play_us > 30 * 1000) {
                // Audio resumed after the DMA would have drained: the listener heard a gap.
                underruns++;
                int64_t gap = now_us() - last_play_us;
                max_gap_us = gap > max_gap_us ? gap : max_gap_us;
            }
            burst_samples += got;
            if (!amp_on) {  // amp only on while there is audio to play (or a reply on its way)
                amp_up();
                amp_on = true;
            }
            board_speaker_write(buf, got);
            if (cue) {
                s_last_cue_us = now_us();
            } else {
                s_last_reply_us = now_us();
            }
        } else {
            if (burst_start && now_us() - last_play_us > SPEAKER_TAIL_US) {
                ESP_LOGI(TAG,
                         "playback ended (%u ms of audio, %u underruns, longest gap %u ms, convert max %u us, "
                         "cpu %u%%/%u%%)",
                         (unsigned)(burst_samples * 1000 / BOARD_SAMPLE_RATE), underruns, (unsigned)(max_gap_us / 1000),
                         (unsigned)s_convert_max_us, cpu_busy_pct(&burst_cpu, 0), cpu_busy_pct(&burst_cpu, 1));
                s_convert_max_us = 0;
                burst_start = 0;
            }
            int64_t amp_idle_since = last_play_us > s_amp_release_us ? last_play_us : s_amp_release_us;
            if (amp_on && !s_amp_hold && now_us() - amp_idle_since > AMP_IDLE_OFF_US) {
                board_speaker_enable(false);
                amp_on = false;
            }
            // Poll only while something above is pending (a deadline, a deferred flush);
            // otherwise sleep until wake_player().
            bool pending = s_flush || burst_start || (amp_on && !s_amp_hold);
            ulTaskNotifyTake(pdTRUE, pending ? pdMS_TO_TICKS(20) : portMAX_DELAY);
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

// Closing a session's socket (a polite close frame, then waiting for the client task to
// exit) takes up to a second, and up to the 5 s network timeout on a dead link. Done on
// the events loop, it held back every event queued behind it, and a wake word said just
// as a session ended waited it out before its chime: here it happens on its own task.
static void closer_task(void *arg)
{
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        int64_t t0 = now_us();
        if (esp_websocket_client_is_connected(s_ws)) {
            esp_websocket_client_close(s_ws, pdMS_TO_TICKS(1000));  // polite close frame
        }
        // close() returns early without waiting if the server hung up first (and after its
        // timeout); stop() is the only call that waits for the client task to exit, so the
        // next agent_start() can't find it still running. No-op when already stopped.
        esp_websocket_client_stop(s_ws);
        ESP_LOGI(TAG, "session ended (socket closed in %d ms)", (int)((now_us() - t0) / 1000));
        xSemaphoreGive(s_client_free);
    }
}

void agent_init(void)
{
    s_client_free = xSemaphoreCreateBinary();
    xSemaphoreGive(s_client_free);
    s_mic_sb = psram_stream_buffer(MIC_BUF_BYTES);
    s_spk_sb = psram_stream_buffer(SPK_BUF_BYTES);
    s_cue_sb = psram_stream_buffer(CUE_BUF_BYTES);
    cues_init();
    cJSON_InitHooks(&(cJSON_Hooks){.malloc_fn = psram_malloc, .free_fn = free});
    // Stacks in PSRAM: internal RAM is scarce, and the websocket client can only
    // put its own task stack there (none of these tasks touch flash).
    xTaskCreatePinnedToCoreWithCaps(player_task, "player", 4096, NULL, 7, &s_player, 0, MALLOC_CAP_SPIRAM);
    xTaskCreatePinnedToCoreWithCaps(sender_task, "sender", 4096, NULL, 6, &s_sender, 0, MALLOC_CAP_SPIRAM);
    xTaskCreatePinnedToCoreWithCaps(closer_task, "ws_closer", 4096, NULL, 4, &s_closer, tskNO_AFFINITY,
                                    MALLOC_CAP_SPIRAM);

    // One client for the device's lifetime. Creating/destroying it per session
    // fragments internal RAM until its task stack can no longer be allocated.
    esp_websocket_client_config_t cfg = {
        // A placeholder: agent_start() sets the real one (configured or found on the LAN).
        .uri = "ws://localhost/websocket",
        .buffer_size = WS_BUFFER_SIZE,
        .task_stack = 6144,
        .task_prio = 8,
        .disable_auto_reconnect = true,
        .network_timeout_ms = 5000,
        // Verify wss:// servers against IDF's bundled root CAs; ignored for ws://.
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    s_ws = esp_websocket_client_init(&cfg);
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_handler, NULL);
    // Its per-session INFO lines are noise, and stop() on an already-stopped client
    // warns "Client was not started" by design (see agent_stop). Errors still show.
    esp_log_level_set("websocket_client", ESP_LOG_ERROR);
}

void agent_start(void)
{
    char uri[512];
    char base[DISCOVERY_URL_MAX];
    if (!discovery_agent_url(base, sizeof(base))) {
        ESP_LOGE(TAG, "no agent to connect to: none found on the LAN (is `make agent` running?)");
        discovery_refresh();
        aai_events_post(AAI_EVENT_SESSION_CLOSED, NULL, 0);
        return;
    }
    bool resume = s_session_id[0] && s_session_has_turns && now_us() - s_session_end_us < RESUME_WINDOW_US;
    if (!resume) {
        s_session_has_turns = false;
    }
    const char *sid = resume ? s_session_id : NULL;
    // An address too long for the buffer costs only "near me", never the connection.
    // ?client= is how a tool finds this device again later (inbox.h).
    const char *client = inbox_client_id();
    if (!proto_session_url(base, sid, client, CONFIG_AAI_DEVICE_ADDRESS, uri, sizeof(uri))) {
        ESP_LOGW(TAG, "device address too long for the session URL; connecting without it");
        proto_session_url(base, sid, client, NULL, uri, sizeof(uri));
    }
    // Not `uri`: it carries the device's street address.
    ESP_LOGI(TAG, "connecting to %s%s (internal heap free %u, largest block %u)", base, resume ? " (resume)" : "",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    // Waits only when the previous session is still closing (the closer gives it back);
    // the chime and ring were already shown, so the wait is heard as a slower connect,
    // not a missed wake word.
    int64_t t0 = now_us();
    if (xSemaphoreTake(s_client_free, pdMS_TO_TICKS(CLIENT_FREE_WAIT_MS)) != pdTRUE) {
        ESP_LOGE(TAG, "previous session still closing after %d ms", CLIENT_FREE_WAIT_MS);
        aai_events_post(AAI_EVENT_SESSION_CLOSED, NULL, 0);
        return;
    }
    int waited_ms = (int)((now_us() - t0) / 1000);
    if (waited_ms > 50) {
        ESP_LOGW(TAG, "waited %d ms for the previous session to close", waited_ms);
    }

    s_configured = false;
    s_cancels_pending = 0;
    // The sender drops leftovers once as it goes idle, but a mic push racing agent_stop()
    // can land after that. Best effort: fails only if the sender is still mid-receive.
    xStreamBufferReset(s_mic_sb);
    s_active = true;
    touch();
    esp_websocket_client_set_uri(s_ws, uri);
    if (esp_websocket_client_start(s_ws) != ESP_OK) {
        ESP_LOGE(TAG, "websocket start failed");
        s_active = false;
        xSemaphoreGive(s_client_free);  // nothing to close: the next start may go ahead
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
    amp_hold(false);
    s_session_end_us = now_us();
    // Returns at once: the closer task closes the socket and frees the client.
    xTaskNotifyGive(s_closer);
}

void agent_push_mic(const int16_t *pcm, size_t samples)
{
    if (s_active && s_mic_sb) {
        xStreamBufferSend(s_mic_sb, pcm, samples * 2, 0);
    }
}

void agent_cancel(void)
{
    amp_hold(false);
    request_flush();
    ESP_LOGI(TAG, "cancel requested");
    // Counted before sending, so frames arriving right after the send are already dropped;
    // undone if the cancel never went out (socket still connecting, or the send failed):
    // no reply.cancelled would come to drain it, and every later reply would be dropped.
    s_cancels_pending++;
    if (!send_json("{\"type\":\"cancel\"}")) {
        s_cancels_pending--;
    }
}

// Local cues, embedded by CMakeLists.txt (EMBED_FILES) as raw PCM already at
// BOARD_SAMPLE_RATE, and scaled once at init:
// - Wake chime: Blurt's rom1a-6 start cue. It peaks near full scale; scaled to about the
//   level of the old 880 Hz beep (peak 6000) so the wake cue isn't a jump in loudness.
extern const uint8_t _binary_wake_chime_pcm_start[], _binary_wake_chime_pcm_end[];
#define CHIME_GAIN_Q15 11000  // ~0.34

typedef struct {
    int16_t *pcm;
    size_t bytes;
} cue_t;

static cue_t s_chime;

// A gain-scaled copy of one embedded blob.
static cue_t cue_load(const uint8_t *start, const uint8_t *end, int gain_q15)
{
    const int16_t *src = (const int16_t *)start;
    // Linker symbols bounding one blob; as addresses, since they are two C objects.
    size_t n = ((uintptr_t)end - (uintptr_t)start) / sizeof(int16_t);
    int16_t *pcm = heap_caps_calloc(n, sizeof(int16_t), MALLOC_CAP_SPIRAM);
    for (size_t i = 0; i < n; i++) {
        pcm[i] = (int16_t)((src[i] * gain_q15) >> 15);
    }
    return (cue_t){pcm, n * sizeof(int16_t)};
}

static void cues_init(void)
{
    s_chime = cue_load(_binary_wake_chime_pcm_start, _binary_wake_chime_pcm_end, CHIME_GAIN_Q15);
}

static void play_cue(const cue_t *cue)
{
    xStreamBufferSend(s_cue_sb, cue->pcm, cue->bytes, pdMS_TO_TICKS(100));
    wake_player();
}

void agent_play_chime(void) { play_cue(&s_chime); }

void agent_play_tone(int freq_hz, int ms)
{
    int n = BOARD_SAMPLE_RATE * ms / 1000;
    float step = 2.0f * (float)M_PI * freq_hz / BOARD_SAMPLE_RATE;
    int16_t buf[160];
    for (int i = 0; i < n; i += 160) {
        int chunk = n - i < 160 ? n - i : 160;
        for (int j = 0; j < chunk; j++) {
            int k = i + j;
            float env = fminf(1.0f, fminf(k, n - k) / 160.0f);  // 10 ms fade in/out, no clicks
            buf[j] = (int16_t)(6000 * env * sinf(step * k));
        }
        xStreamBufferSend(s_spk_sb, buf, chunk * 2, pdMS_TO_TICKS(100));
        wake_player();
    }
}

bool agent_play_notice(const uint8_t *data, size_t len, bool start)
{
    // Pairs bytes across frames like on_audio(). One caller at a time: the inbox's player task,
    // or its socket task for a notice too big to load first (never both: inbox.c).
    EXT_RAM_BSS_ATTR static int16_t pcm[2048 / 2 + 1];
    static pcm_aligner_t aligner;
    if (start) {
        aligner = (pcm_aligner_t){0};
    }
    for (size_t pos = 0; pos < len;) {
        size_t chunk = len - pos < 2048 ? len - pos : 2048;
        size_t n = pcm_align(&aligner, data + pos, chunk, pcm);
        pos += chunk;
        // Blocks while the player catches up: the notice is pushed faster than it plays,
        // and holding the inbox task here is what slows the socket down (TCP backpressure).
        size_t sent = xStreamBufferSend(s_spk_sb, pcm, n * 2, pdMS_TO_TICKS(NOTICE_SEND_TIMEOUT_MS));
        wake_player();
        if (sent != n * 2) {
            return false;  // the player stalled or was flushed mid-send; drop the rest
        }
    }
    return true;
}

bool agent_talking(void)
{
    if (!s_spk_sb) {
        return false;  // agent_init() not called yet
    }
    return xStreamBufferBytesAvailable(s_spk_sb) > 0 || now_us() - s_last_reply_us < SPEAKER_TAIL_US;
}

bool agent_speaker_busy(void)
{
    return agent_talking() || (s_cue_sb && xStreamBufferBytesAvailable(s_cue_sb) > 0) ||
           now_us() - s_last_cue_us < SPEAKER_TAIL_US;
}

int64_t agent_last_activity_ms(void)
{
    int64_t last = s_last_activity_us;
    last = s_last_reply_us > last ? s_last_reply_us : last;
    last = s_last_cue_us > last ? s_last_cue_us : last;
    return last / 1000;
}

void agent_set_observer(agent_observer_t observer) { s_observer = observer; }
