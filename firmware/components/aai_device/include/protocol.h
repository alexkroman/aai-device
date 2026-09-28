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
    PROTO_STOP,  // event "stop": silence the speaker and hang up, without a reply
} proto_type_t;

typedef struct {
    proto_type_t type;
    int sample_rate;  // SESSION_CONFIGURED; validated, falls back to defaults
    int tts_sample_rate;
    char session_id[96];  // SESSION_CONFIGURED
    char text[512];       // transcripts, tool name, error message (truncated)
    char code[24];        // ERROR
    bool fatal;           // ERROR
} proto_msg_t;

// Returns false for malformed JSON or a message without a string "type".
bool proto_parse(const char *json, size_t len, proto_msg_t *out);

// Build the session URL. Resumes `session_id` when non-empty, otherwise opens a
// fresh session with the spoken greeting suppressed. A non-empty `client_id` is
// appended as `client=` (tools read it to reach this device later, see inbox.h), and
// a non-empty `location` URL-encoded as `location=`. Returns false on overflow.
bool proto_session_url(const char *base, const char *session_id, const char *client_id, const char *location, char *out,
                       size_t out_len);

// ---- inbox (WS /inbox): notices a run pushes after the session has closed ----

// What a client id may be (the SDK's CLIENT_ID_RE): 1-64 of [A-Za-z0-9_-].
bool proto_valid_client_id(const char *id);

// The inbox URL on the agent's own server: `agent_url`'s scheme and host, path
// /inbox?client=<client_id>. False for a URL without a host, a bad id, or overflow.
bool proto_inbox_url(const char *agent_url, const char *client_id, char *out, size_t out_len);

#define PROTO_NOTICE_ID_MAX    128
#define PROTO_NOTICE_MAX_BYTES ((size_t)60 * 16000 * 2)  // a minute of 16 kHz PCM16

typedef struct {
    char id[PROTO_NOTICE_ID_MAX + 1];
    char event[24];
    char text[128];  // data.text when present, for the log (truncated)
    size_t bytes;    // binary bytes that follow the header; validated, even
} proto_notice_t;

// Parse a notice header: {"type":"notice","id","event","data"?,"bytes":N}. False for
// anything else, including a notice this device can't take (bad id, odd or oversized
// byte count): the server then gets no answer and retries until the step gives up.
bool proto_parse_notice(const char *json, size_t len, proto_notice_t *out);

// The answer to a notice: {"type":"<type>","id":"<id>"}, `type` "ack" or "busy".
// Returns false on overflow.
bool proto_notice_reply(const char *type, const char *id, char *out, size_t out_len);

// Reassembles PCM16LE samples from binary frames that may split a sample.
typedef struct {
    uint8_t carry;
    bool has_carry;
} pcm_aligner_t;

// Writes up to (len + 1) / 2 samples into `out`. Returns samples written.
size_t pcm_align(pcm_aligner_t *a, const uint8_t *data, size_t len, int16_t *out);
