// Local playback control, no network needed.

#include "agent.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "test_support.h"
#include "unity.h"

static bool speaker_idle(void) { return !agent_speaker_busy(); }

TEST_CASE("cancel flushes queued playback immediately", "[playback]")
{
    test_agent_init();
    agent_play_tone(440, 2000);  // queue 2 s of audio
    vTaskDelay(pdMS_TO_TICKS(100));
    TEST_ASSERT_TRUE(agent_speaker_busy());
    agent_cancel();  // no session open: must still flush locally
    TEST_ASSERT_TRUE_MESSAGE(test_wait_for(speaker_idle, 300), "playback kept going after cancel");
}
