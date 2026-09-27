#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Fills `frames` interleaved BOARD_MIC_FORMAT frames, pacing itself in real time.
typedef void (*voice_source_t)(int16_t *buf, size_t frames);

// ESP-SR audio front end: echo cancellation + beamforming + WakeNet.
// Posts AAI_EVENT_WAKE each time the wake word is detected.
// `source` is NULL for the board mics; tests pass one that plays recorded clips.
void voice_init(voice_source_t source);

// While streaming, AFE output (16 kHz mono, echo-cancelled) goes to agent_push_mic().
void voice_set_streaming(bool on);
