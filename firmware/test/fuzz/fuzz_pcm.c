// libFuzzer harness for pcm_align(): binary WebSocket frames can split a sample at
// any byte, and every split must reassemble into in-bounds, exact samples.

#include <string.h>
#include "protocol.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size < 1) {
        return 0;
    }
    uint8_t split = data[0];
    data++;
    size--;
    pcm_aligner_t aligner = {0};
    int16_t samples[512 + 1];
    size_t total = 0;
    const uint8_t *start = data;
    while (size > 0) {
        size_t frame = 1 + (split++ % 7) * 150;  // odd sizes exercise sample stitching
        frame = frame < size ? frame : size;
        frame = frame < 1024 ? frame : 1024;
        size_t n = pcm_align(&aligner, data, frame, samples);
        if (n > frame / 2 + 1) {
            __builtin_trap();  // wrote past what the caller sized for
        }
        for (size_t i = 0; i < n; i++, total++) {
            int16_t expect;
            memcpy(&expect, start + total * 2, 2);  // reassembled == original little-endian stream
            if (samples[i] != expect) {
                __builtin_trap();
            }
        }
        data += frame;
        size -= frame;
    }
    return 0;
}
