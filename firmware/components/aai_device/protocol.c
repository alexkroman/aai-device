#include "protocol.h"

#include <stdio.h>
#include <string.h>
#include "cJSON.h"

static void copy_str(char *dst, size_t dst_len, const cJSON *item)
{
    const char *s = cJSON_GetStringValue(item);
    snprintf(dst, dst_len, "%s", s ? s : "");
}

static int valid_rate(const cJSON *item, int fallback)
{
    // 8-48 kHz, and a multiple of 4000 or 11025: what the rate converter supports.
    double v = cJSON_GetNumberValue(item);  // NaN when missing or not a number
    if (!(v >= 8000 && v <= 48000) || v != (double)(int)v) {
        return fallback;
    }
    int rate = (int)v;
    return rate % 4000 == 0 || rate % 11025 == 0 ? rate : fallback;
}

bool proto_parse(const char *json, size_t len, proto_msg_t *out)
{
    memset(out, 0, sizeof(*out));
    cJSON *msg = cJSON_ParseWithLength(json, len);
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "type"));
    if (!type) {
        cJSON_Delete(msg);
        return false;
    }

    if (strcmp(type, "session.configured") == 0) {
        out->type = PROTO_SESSION_CONFIGURED;
        out->sample_rate = valid_rate(cJSON_GetObjectItem(msg, "sampleRate"), PROTO_DEFAULT_SAMPLE_RATE);
        out->tts_sample_rate = valid_rate(cJSON_GetObjectItem(msg, "ttsSampleRate"), PROTO_DEFAULT_TTS_SAMPLE_RATE);
        copy_str(out->session_id, sizeof(out->session_id), cJSON_GetObjectItem(msg, "sessionId"));
    } else if (strcmp(type, "reply.cancelled") == 0) {
        out->type = PROTO_REPLY_CANCELLED;
    } else if (strcmp(type, "session.reset") == 0) {
        out->type = PROTO_SESSION_RESET;
    } else if (strcmp(type, "user-transcript.committed") == 0) {
        out->type = PROTO_USER_TRANSCRIPT;
        copy_str(out->text, sizeof(out->text), cJSON_GetObjectItem(msg, "text"));
    } else if (strcmp(type, "agent-transcript.committed") == 0) {
        out->type = PROTO_AGENT_TRANSCRIPT;
        copy_str(out->text, sizeof(out->text), cJSON_GetObjectItem(msg, "text"));
    } else if (strcmp(type, "tool.called") == 0) {
        out->type = PROTO_TOOL_CALLED;
        copy_str(out->text, sizeof(out->text), cJSON_GetObjectItem(msg, "toolName"));
    } else if (strcmp(type, "error.reported") == 0) {
        out->type = PROTO_ERROR;
        out->fatal = cJSON_IsTrue(cJSON_GetObjectItem(msg, "fatal"));
        copy_str(out->code, sizeof(out->code), cJSON_GetObjectItem(msg, "code"));
        copy_str(out->text, sizeof(out->text), cJSON_GetObjectItem(msg, "message"));
    } else if (strcmp(type, "session.timed-out") == 0) {
        out->type = PROTO_TIMED_OUT;
    } else {
        out->type = PROTO_OTHER;
    }
    cJSON_Delete(msg);
    return true;
}

bool proto_session_url(const char *base, const char *session_id, char *out, size_t out_len)
{
    const char *sep = strchr(base, '?') ? "&" : "?";
    int n = session_id && session_id[0] ? snprintf(out, out_len, "%s%ssessionId=%s", base, sep, session_id)
                                        : snprintf(out, out_len, "%s%sresume=1", base, sep);
    return n > 0 && (size_t)n < out_len;
}

size_t pcm_align(pcm_aligner_t *a, const uint8_t *data, size_t len, int16_t *out)
{
    size_t n = 0;
    if (a->has_carry && len > 0) {
        out[n++] = (int16_t)(a->carry | (data[0] << 8));
        data++;
        len--;
        a->has_carry = false;
    }
    size_t pairs = len / 2;
    memcpy(&out[n], data, pairs * 2);
    n += pairs;
    if (len & 1) {
        a->carry = data[len - 1];
        a->has_carry = true;
    }
    return n;
}
