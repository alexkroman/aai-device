#pragma once

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "protocol.h"

// Embedded 16 kHz mono PCM16 WAV clips (see clips/).
typedef struct {
    const int16_t *pcm;
    size_t samples;
} clip_t;

clip_t clip_wake_weather(void);  // "Computer. ... What's the weather in Denver?"
clip_t clip_hello(void);         // unrelated speech, no wake word
clip_t clip_weather(void);       // "What's the weather in Denver right now?"

// Shared one-time init (drivers can only be installed once per boot).
void test_board_init(void);
void test_voice_init(void);  // AFE fed from test_play_clip() instead of the mics
bool test_wifi_init(void);   // false if Wi-Fi didn't connect within 15 s
void test_agent_init(void);
void test_warm_up_network(void);  // one throwaway session (fine if the agent is down)

// Feed a clip into the AFE in real time, followed by silence. Non-blocking.
void test_play_clip(clip_t clip);
bool test_clip_done(void);

// Counters/observations, reset by test_reset_observations().
typedef struct {
    atomic_int wakes;
    atomic_bool ready, closed;
    atomic_bool cancelled;
    atomic_bool tool_called;
    atomic_bool speaker_heard;  // agent_speaker_busy() was seen true
    int sample_rate, tts_sample_rate;
    char tool[64];
    char user_text[256];
    char agent_text[256];
} observations_t;

extern observations_t g_obs;
void test_reset_observations(void);

// Poll `cond` every 50 ms, sampling agent_speaker_busy() into g_obs. Returns cond().
bool test_wait_for(bool (*cond)(void), int timeout_ms);
