#include <math.h>
#include <string.h>
#include "resample.h"
#include "unity.h"

#define N 4800  // 200 ms @ 24 kHz

static int16_t in[N], work[N], out[N * 2];

void setUp(void) {}
void tearDown(void) {}

static void sine(int16_t *buf, size_t n, int freq, int rate, int amp)
{
    for (size_t i = 0; i < n; i++) {
        buf[i] = (int16_t)(amp * sin(2 * M_PI * freq * (double)i / rate));
    }
}

static int zero_crossings(const int16_t *buf, size_t n)
{
    int count = 0;
    for (size_t i = 1; i < n; i++) {
        count += (buf[i - 1] < 0) != (buf[i] < 0);
    }
    return count;
}

static void test_same_rate_is_passthrough(void)
{
    resampler_t r;
    resampler_init(&r, 16000, 16000);
    sine(in, N, 440, 16000, 10000);
    memcpy(work, in, sizeof(in));
    TEST_ASSERT_EQUAL(N, resampler_process(&r, work, N, out));
    TEST_ASSERT_EQUAL_INT16_ARRAY(in, out, N);
}

static void test_24k_to_16k_output_length(void)
{
    resampler_t r;
    resampler_init(&r, 24000, 16000);
    sine(work, N, 440, 24000, 10000);
    size_t n = resampler_process(&r, work, N, out);
    TEST_ASSERT_UINT_WITHIN(1, N * 2 / 3, n);
    TEST_ASSERT_LESS_OR_EQUAL(resampler_max_out(&r, N), n);
}

static void test_16k_to_24k_output_length(void)
{
    resampler_t r;
    resampler_init(&r, 16000, 24000);
    sine(work, 3200, 440, 16000, 10000);
    size_t n = resampler_process(&r, work, 3200, out);
    TEST_ASSERT_UINT_WITHIN(1, 4800, n);
    TEST_ASSERT_LESS_OR_EQUAL(resampler_max_out(&r, 3200), n);
}

static void test_preserves_pitch(void)
{
    // A 1 kHz tone must still be 1 kHz after resampling: same zero crossings per second.
    resampler_t r;
    resampler_init(&r, 24000, 16000);
    sine(work, N, 1000, 24000, 10000);
    size_t n = resampler_process(&r, work, N, out);
    int per_second = zero_crossings(out, n) * 16000 / (int)n;
    TEST_ASSERT_INT_WITHIN(20, 2000, per_second);
}

static void test_preserves_dc_level(void)
{
    resampler_t r;
    resampler_init(&r, 24000, 16000);
    for (int i = 0; i < N; i++) {
        work[i] = 5000;
    }
    size_t n = resampler_process(&r, work, N, out);
    for (size_t i = 4; i < n; i++) {  // skip filter warm-up
        TEST_ASSERT_INT_WITHIN(1, 5000, out[i]);
    }
}

static void test_chunking_is_seamless(void)
{
    // WebSocket frames arrive in arbitrary sizes; output must not depend on them.
    resampler_t whole, chunked;
    resampler_init(&whole, 24000, 16000);
    resampler_init(&chunked, 24000, 16000);
    sine(in, N, 700, 24000, 12000);

    static int16_t expect[N], got[N];
    memcpy(work, in, sizeof(in));
    size_t n_expect = resampler_process(&whole, work, N, expect);

    size_t n_got = 0;
    uint32_t lcg = 42;  // deterministic chunk sizes, identical on every platform
    for (size_t pos = 0; pos < N;) {
        lcg = lcg * 1664525u + 1013904223u;
        size_t len = 1 + (lcg >> 16) % 997;
        if (pos + len > N) {
            len = N - pos;
        }
        memcpy(work, in + pos, len * sizeof(int16_t));
        n_got += resampler_process(&chunked, work, len, got + n_got);
        pos += len;
    }
    TEST_ASSERT_EQUAL(n_expect, n_got);
    TEST_ASSERT_EQUAL_INT16_ARRAY(expect, got, n_expect);
}

static void test_max_in_output_fits_cap(void)
{
    // Every rate pair the protocol allows (8-48 kHz): output of max_in(cap) samples fits cap.
    static const int rates[] = {8000, 11025, 16000, 22050, 24000, 44100, 48000};
    for (size_t i = 0; i < sizeof(rates) / sizeof(rates[0]); i++) {
        for (size_t j = 0; j < sizeof(rates) / sizeof(rates[0]); j++) {
            for (size_t cap = 16; cap < 2000; cap += 97) {  // >= 16: room for 1 input at 6x
                resampler_t r;
                resampler_init(&r, rates[i], rates[j]);
                size_t n = resampler_max_in(&r, cap);
                TEST_ASSERT_GREATER_THAN(0, n);
                TEST_ASSERT_LESS_OR_EQUAL(cap, resampler_max_out(&r, n));
                n = n < N ? n : N;  // scratch buffer size; fewer inputs can only shrink output
                sine(work, n, 440, rates[i], 10000);
                TEST_ASSERT_LESS_OR_EQUAL(cap, resampler_process(&r, work, n, out));
            }
        }
    }
}

static void test_full_scale_step_at_every_phase(void)
{
    // Found by fuzz_audio: INT16_MIN -> INT16_MAX jumps overflowed the interpolation.
    static const int rates[] = {8000, 44100, 48000};
    for (size_t i = 0; i < 3; i++) {
        resampler_t r;
        resampler_init(&r, rates[i], 16000);
        for (int k = 0; k < N; k++) {
            work[k] = k % 2 ? INT16_MAX : INT16_MIN;
        }
        resampler_process(&r, work, N, out);  // UBSan (fatal) flags any overflow
    }
}

static void test_empty_input(void)
{
    resampler_t r;
    resampler_init(&r, 24000, 16000);
    TEST_ASSERT_EQUAL(0, resampler_process(&r, work, 0, out));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_same_rate_is_passthrough);
    RUN_TEST(test_24k_to_16k_output_length);
    RUN_TEST(test_16k_to_24k_output_length);
    RUN_TEST(test_preserves_pitch);
    RUN_TEST(test_preserves_dc_level);
    RUN_TEST(test_chunking_is_seamless);
    RUN_TEST(test_max_in_output_fits_cap);
    RUN_TEST(test_full_scale_step_at_every_phase);
    RUN_TEST(test_empty_input);
    return UNITY_END();
}
