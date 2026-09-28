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

// Queue a tone as if it were reply audio (flushed by agent_cancel()). For tests.
void agent_play_tone(int freq_hz, int ms);
// Queue the wake cue. Local audio: not flushed by a cancel, and doesn't mute the mic.
void agent_play_chime(void);

bool agent_speaker_busy(void);
// The speaker is playing the agent's reply, not just our own wake cue. Half-duplex mutes
// the mic on this, so the user's first words after the wake word still reach the agent.
bool agent_talking(void);

int64_t agent_last_activity_ms(void);
