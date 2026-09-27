// libFuzzer harness for the playback path: arbitrary WebSocket frame splits and any
// negotiated sample-rate pair must never write past fixed-size output buffers.

#include <string.h>
#include "protocol.h"
#include "resample.h"

#define OUT_CAP 1028  // smallest real output buffer (agent.c sender)

static int rate_from(uint8_t b)
{
    static const int rates[] = {8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000};
    return rates[b % (sizeof(rates) / sizeof(rates[0]))];
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size < 3) {
        return 0;
    }
    resampler_t rs;
    resampler_init(&rs, rate_from(data[0]), rate_from(data[1]));
    uint8_t split = data[2];
    data += 3;
    size -= 3;

    pcm_aligner_t aligner = {0};
    int16_t samples[512 + 1];
    int16_t out[OUT_CAP];
    size_t slice = resampler_max_in(&rs, OUT_CAP);
    while (size > 0) {
        size_t frame = 1 + (split++ % 7) * 150;  // odd sizes exercise sample stitching
        frame = frame < size ? frame : size;
        frame = frame < 1024 ? frame : 1024;
        size_t n = pcm_align(&aligner, data, frame, samples);
        for (size_t pos = 0; pos < n; pos += slice) {
            size_t chunk = n - pos < slice ? n - pos : slice;
            size_t produced = resampler_process(&rs, samples + pos, chunk, out);
            if (produced > OUT_CAP || produced > resampler_max_out(&rs, chunk)) {
                __builtin_trap();
            }
        }
        data += frame;
        size -= frame;
    }
    return 0;
}
