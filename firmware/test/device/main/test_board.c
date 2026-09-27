// Hardware tests: prove the codecs, I2S wiring and TDM channel layout are right.

#include <math.h>
#include <stdlib.h>
#include "board.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "test_support.h"
#include "unity.h"

#define CH_REF  0  // BOARD_MIC_FORMAT "RMNM"
#define CH_MIC1 1
#define CH_MIC2 3
#define FRAMES  (BOARD_SAMPLE_RATE / 2)  // 500 ms

typedef struct {
    double rms[BOARD_MIC_CHANNELS];
    int crossings[BOARD_MIC_CHANNELS];
} capture_stats_t;

static capture_stats_t capture(void)
{
    int16_t *buf = heap_caps_malloc(FRAMES * BOARD_MIC_CHANNELS * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(buf);
    TEST_ASSERT_EQUAL(ESP_OK, board_mic_read(buf, FRAMES));
    capture_stats_t st = {0};
    for (int ch = 0; ch < BOARD_MIC_CHANNELS; ch++) {
        double sum = 0;
        for (int i = 0; i < FRAMES; i++) {
            int16_t s = buf[i * BOARD_MIC_CHANNELS + ch];
            sum += (double)s * s;
            if (i > 0) {
                st.crossings[ch] += (buf[(i - 1) * BOARD_MIC_CHANNELS + ch] < 0) != (s < 0);
            }
        }
        st.rms[ch] = sqrt(sum / FRAMES);
    }
    free(buf);
    return st;
}

static volatile bool s_tone_on;

static void tone_task(void *arg)
{
    int16_t buf[160];
    uint32_t n = 0;
    while (s_tone_on) {
        for (int i = 0; i < 160; i++, n++) {
            buf[i] = (int16_t)(8000 * sinf(2 * M_PI * 1000 * n / BOARD_SAMPLE_RATE));
        }
        board_speaker_write(buf, 160);
    }
    vTaskDelete(NULL);
}

TEST_CASE("mics produce live, unsaturated signal", "[board]")
{
    test_board_init();
    capture();  // discard codec start-up transient
    capture_stats_t st = capture();
    printf("rms: ref=%.1f mic1=%.1f unused=%.1f mic2=%.1f\n", st.rms[0], st.rms[1], st.rms[2], st.rms[3]);
    // Room noise is never digital silence; a dead or unclocked codec reads 0.
    TEST_ASSERT_GREATER_THAN_DOUBLE(1.0, st.rms[CH_MIC1]);
    TEST_ASSERT_GREATER_THAN_DOUBLE(1.0, st.rms[CH_MIC2]);
    TEST_ASSERT_LESS_THAN_DOUBLE(20000.0, st.rms[CH_MIC1]);
    TEST_ASSERT_LESS_THAN_DOUBLE(20000.0, st.rms[CH_MIC2]);
}

TEST_CASE("speaker output loops back on the AEC reference channel", "[board]")
{
    // Echo cancellation only works if what we play shows up on channel "R".
    test_board_init();
    capture();
    capture_stats_t quiet = capture();

    board_speaker_enable(true);
    s_tone_on = true;
    xTaskCreate(tone_task, "tone", 3072, NULL, 5, NULL);
    vTaskDelay(pdMS_TO_TICKS(200));
    capture_stats_t loud = capture();
    s_tone_on = false;
    vTaskDelay(pdMS_TO_TICKS(100));
    board_speaker_enable(false);

    printf("ref rms quiet=%.1f tone=%.1f, crossings=%d\n", quiet.rms[CH_REF], loud.rms[CH_REF], loud.crossings[CH_REF]);
    TEST_ASSERT_GREATER_THAN_DOUBLE(10 * (quiet.rms[CH_REF] + 1), loud.rms[CH_REF]);
    // 1 kHz for 500 ms = ~1000 zero crossings: the reference is our tone, not noise.
    TEST_ASSERT_INT_WITHIN(100, 1000, loud.crossings[CH_REF]);
}
