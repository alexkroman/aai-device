// Integration tests against a live agent at CONFIG_AAI_AGENT_URL (e.g. `aai dev`).
// Audio goes through the real AFE -> agent pipeline; only the mics are replaced.

#include <ctype.h>
#include <string.h>
#include "agent.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "test_support.h"
#include "unity.h"
#include "voice.h"

static bool is_ready(void) { return g_obs.ready; }
static bool is_woken(void) { return g_obs.wakes > 0; }
static bool has_agent_reply(void) { return g_obs.agent_text[0] && !agent_speaker_busy(); }
static bool speaker_started(void) { return agent_speaker_busy(); }
static bool is_cancelled(void) { return g_obs.cancelled; }
static bool speaker_idle(void) { return !agent_speaker_busy(); }

static bool contains_ci(const char *haystack, const char *needle)
{
    for (; *haystack; haystack++) {
        size_t i = 0;
        while (needle[i] && tolower((unsigned char)haystack[i]) == needle[i]) {
            i++;
        }
        if (!needle[i]) {
            return true;
        }
    }
    return false;
}

static void setup(void)
{
    TEST_ASSERT_TRUE_MESSAGE(test_wifi_init(), "wifi did not connect");
    test_agent_init();
    test_reset_observations();
}

static void teardown(void)
{
    voice_set_streaming(false);
    agent_stop();
}

TEST_CASE("connects and receives session.configured", "[agent]")
{
    setup();
    agent_start();
    bool ready = test_wait_for(is_ready, 10000);
    teardown();
    TEST_ASSERT_TRUE_MESSAGE(ready, "no session.configured; is the agent running at CONFIG_AAI_AGENT_URL?");
    TEST_ASSERT_FALSE(g_obs.closed);
    TEST_ASSERT_TRUE(g_obs.sample_rate == 16000 || g_obs.sample_rate == 24000);
    TEST_ASSERT_TRUE(g_obs.tts_sample_rate >= 8000);
}

TEST_CASE("wake word to spoken answer, with a tool call", "[agent]")
{
    // The whole device flow: "Computer" wakes it, the question is streamed through the
    // AFE, the agent calls get_weather, and its spoken reply reaches the speaker.
    setup();
    test_play_clip(clip_wake_weather());
    TEST_ASSERT_TRUE_MESSAGE(test_wait_for(is_woken, 5000), "wake word not detected");
    voice_set_streaming(true);
    agent_start();
    TEST_ASSERT_TRUE_MESSAGE(test_wait_for(is_ready, 10000), "no session.configured");
    bool replied = test_wait_for(has_agent_reply, 30000);
    teardown();

    printf("you: %s\nagent: %s\ntool: %s\n", g_obs.user_text, g_obs.agent_text, g_obs.tool);
    TEST_ASSERT_TRUE_MESSAGE(replied, "no agent reply");
    TEST_ASSERT_TRUE_MESSAGE(contains_ci(g_obs.user_text, "weather"), g_obs.user_text);
    TEST_ASSERT_TRUE_MESSAGE(contains_ci(g_obs.user_text, "denver"), g_obs.user_text);
    TEST_ASSERT_TRUE(g_obs.tool_called);
    TEST_ASSERT_EQUAL_STRING("get_weather", g_obs.tool);
    TEST_ASSERT_TRUE_MESSAGE(g_obs.speaker_heard, "reply audio never reached the speaker");
}

TEST_CASE("cancel mid-reply flushes playback and the agent confirms", "[agent]")
{
    setup();
    voice_set_streaming(true);
    agent_start();
    TEST_ASSERT_TRUE(test_wait_for(is_ready, 10000));
    test_play_clip(clip_weather());
    TEST_ASSERT_TRUE_MESSAGE(test_wait_for(speaker_started, 30000), "agent never started speaking");

    agent_cancel();
    bool idle = test_wait_for(speaker_idle, 500);
    bool confirmed = test_wait_for(is_cancelled, 3000);
    teardown();
    TEST_ASSERT_TRUE_MESSAGE(idle, "playback not flushed within 500 ms");
    TEST_ASSERT_TRUE_MESSAGE(confirmed, "no reply.cancelled from the agent");
}

TEST_CASE("ten back-to-back sessions keep enough internal RAM", "[agent]")
{
    // Regression: per-session websocket client create/destroy fragmented internal
    // RAM until the client's task stack (internal-only) failed to allocate.
    setup();
    for (int i = 0; i < 10; i++) {
        g_obs.ready = false;
        agent_start();
        TEST_ASSERT_TRUE_MESSAGE(test_wait_for(is_ready, 10000), "session failed to open");
        agent_stop();
    }
    size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    printf("largest internal block after 10 sessions: %u\n", (unsigned)largest);
    TEST_ASSERT_GREATER_OR_EQUAL(7168, largest);  // websocket task: 6 KB stack + TCB
}
