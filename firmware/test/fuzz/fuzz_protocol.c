// libFuzzer harness: server events arrive from the network, so the parser must
// survive any byte sequence. Built with ASan/UBSan, any overread or UB fails.

#include <string.h>
#include "protocol.h"

// libFuzzer links against this by name, so it must stay external.
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    proto_msg_t msg;
    if (proto_parse((const char *)data, size, &msg)) {
        // Parsed strings must be terminated within their buffers.
        if (memchr(msg.text, '\0', sizeof(msg.text)) == NULL || memchr(msg.code, '\0', sizeof(msg.code)) == NULL ||
            memchr(msg.session_id, '\0', sizeof(msg.session_id)) == NULL) {
            __builtin_trap();
        }
        if (msg.type == PROTO_SESSION_CONFIGURED && (msg.sample_rate < 8000 || msg.sample_rate > 48000 ||
                                                     msg.tts_sample_rate < 8000 || msg.tts_sample_rate > 48000)) {
            __builtin_trap();  // resampler_init would divide by zero / misbehave
        }
        char url[128];
        proto_session_url("ws://host:3000/websocket", msg.session_id, NULL, NULL, url, sizeof(url));
        // Server-chosen bytes as the location too: exercises the encoder's bounds.
        if (proto_session_url("ws://host:3000/websocket", NULL, NULL, msg.session_id, url, sizeof(url)) &&
            strlen(url) >= sizeof(url)) {
            __builtin_trap();
        }
    }
    // The inbox's header parser takes the same untrusted bytes.
    proto_notice_t notice;
    if (proto_parse_notice((const char *)data, size, &notice)) {
        if (memchr(notice.id, '\0', sizeof(notice.id)) == NULL ||
            memchr(notice.event, '\0', sizeof(notice.event)) == NULL ||
            memchr(notice.text, '\0', sizeof(notice.text)) == NULL || notice.id[0] == '\0' ||
            notice.bytes > PROTO_NOTICE_MAX_BYTES || notice.bytes % 2 != 0) {
            __builtin_trap();
        }
        char reply[PROTO_NOTICE_ID_MAX * 6 + 32];  // worst case: every id byte escaped
        if (!proto_notice_reply("ack", notice.id, reply, sizeof(reply))) {
            __builtin_trap();  // a notice we parsed must be answerable
        }
    }
    return 0;
}
