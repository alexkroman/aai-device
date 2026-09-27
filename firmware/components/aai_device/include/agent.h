#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "protocol.h"

// Client for the AAI agent `/websocket` protocol: binary frames are PCM16LE
// mono audio, text frames are JSON events/commands.

// Session lifecycle and server messages are posted as AAI_EVENTs (aai_events.h).
void agent_init(void);

// Open a session. Resumes the previous conversation if it ended <120 s ago.
void agent_start(void);
void agent_stop(void);

// Queue 16 kHz mono mic audio (AEC-processed). Non-blocking; drops when full.
void agent_push_mic(const int16_t *pcm, size_t samples);

// Local barge-in: flush playback and tell the agent to abort its reply.
void agent_cancel(void);

// Queue a short local beep (used as the wake chime).
void agent_play_tone(int freq_hz, int ms);

bool agent_speaker_busy(void);

int64_t agent_last_activity_ms(void);
