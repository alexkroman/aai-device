#include "test_support.h"

#include <string.h>
#include "aai_events.h"
#include "agent.h"
#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"
#include "unity_test_utils_memory.h"
#include "voice.h"
#include "wifi.h"

observations_t g_obs;

// ---- clips ------------------------------------------------------------------

static clip_t wav(const uint8_t *start, const uint8_t *end)
{
    // Walk RIFF chunks to "data"; `say` emits extra chunks before it.
    const uint8_t *p = start + 12;
    while (p + 8 <= end) {
        uint32_t size = p[4] | p[5] << 8 | p[6] << 16 | (uint32_t)p[7] << 24;
        if (memcmp(p, "data", 4) == 0) {
            return (clip_t){(const int16_t *)(p + 8), size / 2};
        }
        p += 8 + size + (size & 1);
    }
    TEST_FAIL_MESSAGE("no data chunk in WAV");
    return (clip_t){0};
}

#define CLIP(fn, sym)                                                                                                  \
    clip_t fn(void)                                                                                                    \
    {                                                                                                                  \
        extern const uint8_t sym##_start[] asm("_binary_" #sym "_start");                                              \
        extern const uint8_t sym##_end[] asm("_binary_" #sym "_end");                                                  \
        return wav(sym##_start, sym##_end);                                                                            \
    }

CLIP(clip_wake_weather, wake_weather_wav)
CLIP(clip_hello, hello_wav)
CLIP(clip_weather, weather_wav)

// ---- clip-driven AFE source ------------------------------------------------

static clip_t s_clip;
static atomic_size_t s_pos;
static atomic_bool s_playing;

static void clip_source(int16_t *buf, size_t frames)
{
    // Mimic board_mic_read(): BOARD_MIC_FORMAT ("RMNM") frames at real-time pace.
    // The clip goes on both mic channels; reference and unused channels are silent.
    for (size_t i = 0; i < frames; i++) {
        int16_t s = 0;
        if (s_playing) {
            size_t pos = s_pos++;
            if (pos < s_clip.samples) {
                s = s_clip.pcm[pos];
            } else {
                s_playing = false;
            }
        }
        buf[4 * i + 0] = 0;
        buf[4 * i + 1] = s;
        buf[4 * i + 2] = 0;
        buf[4 * i + 3] = s;
    }
    vTaskDelay(pdMS_TO_TICKS(frames * 1000 / BOARD_SAMPLE_RATE));
}

void test_play_clip(clip_t clip)
{
    s_playing = false;
    s_clip = clip;
    s_pos = 0;
    s_playing = true;
}

bool test_clip_done(void) { return !s_playing; }

// ---- one-time init ---------------------------------------------------------

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data);

void test_board_init(void)
{
    static bool done;
    if (!done) {
        TEST_ASSERT_EQUAL(ESP_OK, board_init());
        done = true;
    }
}

static void observe(const proto_msg_t *msg);

void test_voice_init(void)
{
    static bool done;
    test_board_init();
    if (!done) {
        TEST_ASSERT_EQUAL(ESP_OK, aai_events_register(on_event, NULL));
        agent_set_observer(observe);
        voice_init(clip_source);
        done = true;
        vTaskDelay(pdMS_TO_TICKS(500));  // let the AFE settle on silence
    }
}

bool test_wifi_init(void)
{
    wifi_start();
    return wifi_wait_connected(15000);
}

static void observe(const proto_msg_t *msg)
{
    switch (msg->type) {
    case PROTO_SESSION_CONFIGURED:
        g_obs.sample_rate = msg->sample_rate;
        g_obs.tts_sample_rate = msg->tts_sample_rate;
        break;
    case PROTO_REPLY_CANCELLED:
        g_obs.cancelled = true;
        break;
    case PROTO_TOOL_CALLED:
        strlcpy(g_obs.tool, msg->text, sizeof(g_obs.tool));
        g_obs.tool_called = true;
        break;
    case PROTO_USER_TRANSCRIPT:
        strlcpy(g_obs.user_text, msg->text, sizeof(g_obs.user_text));
        break;
    case PROTO_AGENT_TRANSCRIPT:
        // Only replies to what we asked: a resumed session replays earlier agent
        // turns (e.g. the greeting) before the user has said anything.
        if (g_obs.user_text[0]) {
            strlcpy(g_obs.agent_text, msg->text, sizeof(g_obs.agent_text));
        }
        break;
    default:
        break;
    }
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    switch ((aai_event_id_t)id) {
    case AAI_EVENT_WAKE:
        g_obs.wakes++;
        break;
    case AAI_EVENT_SESSION_READY:
        g_obs.ready = true;
        break;
    case AAI_EVENT_SESSION_CLOSED:
        g_obs.closed = true;
        break;
    case AAI_EVENT_MESSAGE:  // only the type; observe() gets the whole message
    case AAI_EVENT_TICK:
    case AAI_EVENT_TIMER_SET:
    case AAI_EVENT_TIMER_CANCEL:
        break;
    }
}

void test_agent_init(void)
{
    static bool done;
    test_voice_init();
    if (!done) {
        agent_init();
        done = true;
    }
}

static bool session_settled(void) { return g_obs.ready || g_obs.closed; }

void test_warm_up_network(void)
{
    test_reset_observations();
    agent_start();
    test_wait_for(session_settled, 10000);
    agent_stop();
    vTaskDelay(pdMS_TO_TICKS(300));
    test_reset_observations();
}

void test_reset_observations(void) { memset(&g_obs, 0, sizeof(g_obs)); }

bool test_wait_for(bool (*cond)(void), int timeout_ms)
{
    for (int t = 0; t < timeout_ms; t += 50) {
        if (agent_speaker_busy()) {
            g_obs.speaker_heard = true;
        }
        if (cond()) {
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    return cond();
}

// ---- per-test checks (ESP-IDF Unity utilities) ------------------------------

#define LEAK_THRESHOLD_BYTES 1024  // transient lwIP/cJSON buffers settle below this

void setUp(void) { unity_utils_record_free_mem(); }

void tearDown(void)
{
    vTaskDelay(pdMS_TO_TICKS(200));  // let async frees (socket close, task exit) land
    unity_utils_evaluate_leaks_direct(LEAK_THRESHOLD_BYTES);
    // With heap poisoning on, this walks every block and catches overruns/use-after-free.
    TEST_ASSERT_TRUE_MESSAGE(heap_caps_check_integrity_all(true), "heap corruption detected");
}
