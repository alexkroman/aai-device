// AFE + WakeNet tests with recorded clips injected in place of the mics.

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "test_support.h"
#include "unity.h"

static bool clip_done(void) { return test_clip_done(); }

static void play_and_settle(clip_t clip)
{
    test_play_clip(clip);
    TEST_ASSERT_TRUE(test_wait_for(clip_done, 10000));
    vTaskDelay(pdMS_TO_TICKS(800));  // WakeNet fires slightly after the word ends
}

TEST_CASE("wake word is detected in a recorded 'Computer'", "[voice]")
{
    test_voice_init();
    test_reset_observations();
    play_and_settle(clip_wake_weather());
    TEST_ASSERT_EQUAL(1, g_obs.wakes);
}

TEST_CASE("unrelated speech does not trigger the wake word", "[voice]")
{
    test_voice_init();
    test_reset_observations();
    play_and_settle(clip_hello());
    play_and_settle(clip_weather());
    TEST_ASSERT_EQUAL(0, g_obs.wakes);
}
