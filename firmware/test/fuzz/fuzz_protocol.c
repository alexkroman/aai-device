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
            __builtin_trap();  // the rate converter would reject it
        }
        char url[128];
        proto_session_url("ws://host:3000/websocket", msg.session_id, url, sizeof(url));
    }
    return 0;
}
