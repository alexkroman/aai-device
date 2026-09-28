#include "protocol.h"

#include <ctype.h>
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
    double v = cJSON_GetNumberValue(item);  // NaN when missing or not a number
    return v >= 8000 && v <= 48000 && v == (double)(int)v ? (int)v : fallback;
}

static proto_type_t parse_custom(const cJSON *msg, proto_msg_t *out)
{
    const char *event = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "event"));
    const cJSON *data = cJSON_GetObjectItem(msg, "data");
    if (!event) {
        return PROTO_OTHER;
    }
    if (strcmp(event, "timer.set") == 0) {
        double s = cJSON_GetNumberValue(cJSON_GetObjectItem(data, "seconds"));  // NaN when missing
        if (!(s >= 1 && s <= PROTO_TIMER_MAX_SECONDS)) {
            return PROTO_OTHER;  // a timer we can't honor; the agent already said it's set
        }
        out->seconds = (int)s;
        copy_str(out->text, sizeof(out->text), cJSON_GetObjectItem(data, "label"));
        return PROTO_TIMER_SET;
    }
    if (strcmp(event, "timer.cancel") == 0) {
        copy_str(out->text, sizeof(out->text), cJSON_GetObjectItem(data, "label"));
        return PROTO_TIMER_CANCEL;
    }
    if (strcmp(event, "stop") == 0) {
        return PROTO_STOP;
    }
    return PROTO_OTHER;
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
    } else if (strcmp(type, "custom.emitted") == 0) {
        out->type = parse_custom(msg, out);
    } else {
        out->type = PROTO_OTHER;
    }
    cJSON_Delete(msg);
    return true;
}

bool proto_session_url(const char *base, const char *session_id, const char *location, char *out, size_t out_len)
{
    const char *sep = strchr(base, '?') ? "&" : "?";
    int n = session_id && session_id[0] ? snprintf(out, out_len, "%s%ssessionId=%s", base, sep, session_id)
                                        : snprintf(out, out_len, "%s%sresume=1", base, sep);
    if (n <= 0 || (size_t)n >= out_len) {
        return false;
    }
    if (!location || !location[0]) {
        return true;
    }
    size_t len = (size_t)n;
    static const char key[] = "&location=";
    if (len + sizeof(key) > out_len) {
        return false;
    }
    memcpy(out + len, key, sizeof(key));  // includes the NUL
    len += sizeof(key) - 1;
    static const char hex[] = "0123456789ABCDEF";
    for (const unsigned char *c = (const unsigned char *)location; *c; c++) {
        bool plain = isalnum(*c) || *c == '-' || *c == '.' || *c == '_' || *c == '~';
        size_t need = plain ? 1 : 3;
        if (len + need >= out_len) {
            return false;
        }
        if (plain) {
            out[len++] = (char)*c;
        } else {
            out[len++] = '%';
            out[len++] = hex[*c >> 4];
            out[len++] = hex[*c & 0xF];
        }
    }
    out[len] = '\0';
    return true;
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
