#pragma once

// Pure (no ESP-IDF APIs) pieces of the agent wire protocol, so they can be
// unit-tested on the host. See agent.c for the transport.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PROTO_DEFAULT_SAMPLE_RATE     16000
#define PROTO_DEFAULT_TTS_SAMPLE_RATE 24000

typedef enum {
    PROTO_OTHER,  // valid event we don't act on (ignore unknown types by design)
    PROTO_SESSION_CONFIGURED,
    PROTO_REPLY_CANCELLED,
    PROTO_SESSION_RESET,
    PROTO_USER_TRANSCRIPT,   // user-transcript.committed
    PROTO_AGENT_TRANSCRIPT,  // agent-transcript.committed
    PROTO_TOOL_CALLED,
    PROTO_ERROR,
    PROTO_TIMED_OUT,
    // Our own agent's tools (agent/tools/) reach the device through ctx.send(), which
    // arrives as custom.emitted {event, data}. Unknown custom events are PROTO_OTHER.
    PROTO_TIMER_SET,     // event "timer.set", data {seconds, label?}
    PROTO_TIMER_CANCEL,  // event "timer.cancel", data {label?}; no label = every timer
} proto_type_t;

#define PROTO_TIMER_MAX_SECONDS (24 * 60 * 60)

typedef struct {
    proto_type_t type;
    int sample_rate;  // SESSION_CONFIGURED; validated, falls back to defaults
    int tts_sample_rate;
    int seconds;          // TIMER_SET; validated, 1..PROTO_TIMER_MAX_SECONDS
    char session_id[96];  // SESSION_CONFIGURED
    char text[512];       // transcripts, tool name, error message, timer label (truncated)
    char code[24];        // ERROR
    bool fatal;           // ERROR
} proto_msg_t;

// Returns false for malformed JSON or a message without a string "type".
bool proto_parse(const char *json, size_t len, proto_msg_t *out);

// Build the session URL. Resumes `session_id` when non-empty, otherwise opens a
// fresh session with the spoken greeting suppressed. A non-empty `location` is
// appended URL-encoded as `location=`. Returns false on overflow.
bool proto_session_url(const char *base, const char *session_id, const char *location, char *out, size_t out_len);

// Reassembles PCM16LE samples from binary frames that may split a sample.
typedef struct {
    uint8_t carry;
    bool has_carry;
} pcm_aligner_t;

// Writes up to (len + 1) / 2 samples into `out`. Returns samples written.
size_t pcm_align(pcm_aligner_t *a, const uint8_t *data, size_t len, int16_t *out);
