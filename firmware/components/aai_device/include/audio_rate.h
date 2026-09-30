#pragma once

// Streaming mono PCM16 rate conversion for the device's two audio streams (agent TTS to the
// speaker, mic to the agent). Uses esp_audio_effects' filtered converter, which keeps the
// highs from folding back as distortion on the 24 kHz -> 16 kHz TTS path. Rates it can't
// take (it wants multiples of 4000 or 11025) fall back to resample.c's linear interpolator.
// Not thread-safe: one owner task per converter.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "resample.h"

typedef struct {
    void *ae;  // esp_ae_rate_cvt handle, or NULL: `fallback` (or a straight copy)
    resampler_t fallback;
    bool passthrough;  // same rate in and out
} audio_rate_t;

// Starts a fresh stream; closes whatever `r` held before (zero-initialize it once first).
void audio_rate_open(audio_rate_t *r, int in_rate, int out_rate);
void audio_rate_close(audio_rate_t *r);

// Upper bound on output samples for `n_in` input samples.
size_t audio_rate_max_out(const audio_rate_t *r, size_t n_in);

// `in` may be modified. Returns samples written to `out`, which must hold
// audio_rate_max_out(n_in).
size_t audio_rate_process(audio_rate_t *r, int16_t *in, size_t n_in, int16_t *out);
