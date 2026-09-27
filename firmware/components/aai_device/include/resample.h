#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Streaming mono PCM16 resampler (linear interpolation, with a [1 2 1]/4
// anti-alias pre-filter when downsampling). State carries across calls so
// arbitrary chunk sizes produce seamless output.
typedef struct {
    uint32_t step;  // input samples per output sample, Q16
    uint32_t pos;   // read position relative to `prev`, Q16
    int16_t prev;
    int16_t lp[2];  // low-pass history
    bool lowpass;
} resampler_t;

void resampler_init(resampler_t *r, int in_rate, int out_rate);

// Upper bound on output samples for `n_in` input samples.
size_t resampler_max_out(const resampler_t *r, size_t n_in);

// Largest input count whose output is guaranteed to fit in `out_cap` samples.
// Callers with fixed buffers must slice their input by this.
size_t resampler_max_in(const resampler_t *r, size_t out_cap);

// `in` may be filtered in place. Returns number of samples written to `out`.
size_t resampler_process(resampler_t *r, int16_t *in, size_t n_in, int16_t *out);
