#include <string.h>
#include "resample.h"

void resampler_init(resampler_t *r, int in_rate, int out_rate)
{
    memset(r, 0, sizeof(*r));
    r->step = (uint32_t)(((uint64_t)in_rate << 16) / out_rate);
    r->lowpass = in_rate > out_rate;
}

size_t resampler_max_out(const resampler_t *r, size_t n_in)
{
    return (size_t)(((uint64_t)(n_in + 1) << 16) / r->step) + 2;
}

size_t resampler_max_in(const resampler_t *r, size_t out_cap)
{
    if (out_cap <= 3) {
        return 0;
    }
    // Invert resampler_max_out(): ((n + 1) << 16) / step + 2 <= out_cap
    size_t n = (size_t)(((uint64_t)(out_cap - 2) * r->step) >> 16);
    return n > 1 ? n - 1 : 0;
}

size_t resampler_process(resampler_t *r, int16_t *in, size_t n_in, int16_t *out)
{
    if (n_in == 0) {
        return 0;
    }
    if (r->step == (1u << 16)) {
        memcpy(out, in, n_in * sizeof(int16_t));
        return n_in;
    }
    if (r->lowpass) {
        for (size_t i = 0; i < n_in; i++) {
            int16_t x = in[i];
            in[i] = (int16_t)(((int32_t)r->lp[0] + 2 * r->lp[1] + x) >> 2);
            r->lp[0] = r->lp[1];
            r->lp[1] = x;
        }
    }
    // Virtual input: x[0] = prev, x[k] = in[k-1]. Interpolate between x[idx] and x[idx+1].
    size_t n_out = 0;
    for (;;) {
        size_t idx = r->pos >> 16;
        if (idx >= n_in) {
            break;
        }
        int32_t a = idx == 0 ? r->prev : in[idx - 1];
        int32_t b = in[idx];
        int32_t frac = (int32_t)(r->pos & 0xFFFF);
        // 64-bit: (b - a) spans +/-65535 and frac up to 65535; the product overflows int32.
        out[n_out++] = (int16_t)(a + (int32_t)(((int64_t)(b - a) * frac) >> 16));
        r->pos += r->step;
    }
    r->pos -= (uint32_t)n_in << 16;
    r->prev = in[n_in - 1];
    return n_out;
}
