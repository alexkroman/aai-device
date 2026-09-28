#include "protocol.h"

#include <ctype.h>
#include <limits.h>
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

static proto_type_t parse_custom(const cJSON *msg)
{
    const char *event = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "event"));
    if (!event) {
        return PROTO_OTHER;
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
        out->type = parse_custom(msg);
    } else {
        out->type = PROTO_OTHER;
    }
    cJSON_Delete(msg);
    return true;
}

// Appends `&key=value` with `value` percent-encoded (RFC 3986 unreserved kept).
static bool append_param(char *out, size_t out_len, size_t *len, const char *key, const char *value)
{
    int n = snprintf(out + *len, out_len - *len, "&%s=", key);
    if (n <= 0 || (size_t)n >= out_len - *len) {
        return false;
    }
    *len += (size_t)n;
    static const char hex[] = "0123456789ABCDEF";
    for (const unsigned char *c = (const unsigned char *)value; *c; c++) {
        bool plain = isalnum(*c) || *c == '-' || *c == '.' || *c == '_' || *c == '~';
        size_t need = plain ? 1 : 3;
        if (*len + need >= out_len) {
            return false;
        }
        if (plain) {
            out[(*len)++] = (char)*c;
        } else {
            out[(*len)++] = '%';
            out[(*len)++] = hex[*c >> 4];
            out[(*len)++] = hex[*c & 0xF];
        }
    }
    out[*len] = '\0';
    return true;
}

bool proto_session_url(const char *base, const char *session_id, const char *client_id, const char *location, char *out,
                       size_t out_len)
{
    const char *sep = strchr(base, '?') ? "&" : "?";
    int n = session_id && session_id[0] ? snprintf(out, out_len, "%s%ssessionId=%s", base, sep, session_id)
                                        : snprintf(out, out_len, "%s%sresume=1", base, sep);
    if (n <= 0 || (size_t)n >= out_len) {
        return false;
    }
    size_t len = (size_t)n;
    if (client_id && client_id[0] && !append_param(out, out_len, &len, "client", client_id)) {
        return false;
    }
    return !(location && location[0]) || append_param(out, out_len, &len, "location", location);
}

bool proto_valid_client_id(const char *id)
{
    size_t n = 0;
    for (; id[n]; n++) {
        if (!(isalnum((unsigned char)id[n]) || id[n] == '-' || id[n] == '_') || n >= 64) {
            return false;
        }
    }
    return n > 0;
}

bool proto_inbox_url(const char *agent_url, const char *client_id, char *out, size_t out_len)
{
    const char *scheme_end = strstr(agent_url, "://");
    if (!scheme_end || !proto_valid_client_id(client_id)) {
        return false;
    }
    const char *host = scheme_end + 3;
    size_t host_len = strcspn(host, "/?#");
    if (host_len == 0) {
        return false;
    }
    int n = snprintf(out, out_len, "%.*s/inbox?client=%s", (int)(host + host_len - agent_url), agent_url, client_id);
    return n > 0 && (size_t)n < out_len;
}

bool proto_parse_notice(const char *json, size_t len, proto_notice_t *out)
{
    memset(out, 0, sizeof(*out));
    cJSON *msg = cJSON_ParseWithLength(json, len);
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "type"));
    const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "id"));
    const char *event = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "event"));
    double bytes = cJSON_GetNumberValue(cJSON_GetObjectItem(msg, "bytes"));  // NaN when missing
    bool ok = type && strcmp(type, "notice") == 0 && id && id[0] && strlen(id) <= PROTO_NOTICE_ID_MAX && event &&
              bytes >= 0 && bytes <= PROTO_NOTICE_MAX_BYTES && bytes == (double)(size_t)bytes && (size_t)bytes % 2 == 0;
    if (ok) {
        snprintf(out->id, sizeof(out->id), "%s", id);
        snprintf(out->event, sizeof(out->event), "%s", event);
        copy_str(out->text, sizeof(out->text), cJSON_GetObjectItem(cJSON_GetObjectItem(msg, "data"), "text"));
        out->bytes = (size_t)bytes;
    }
    cJSON_Delete(msg);
    return ok;
}

bool proto_notice_reply(const char *type, const char *id, char *out, size_t out_len)
{
    // Built with cJSON, not snprintf: the id is the server's and gets escaped.
    cJSON *reply = cJSON_CreateObject();
    bool ok = reply && cJSON_AddStringToObject(reply, "type", type) && cJSON_AddStringToObject(reply, "id", id) &&
              out_len <= INT_MAX && cJSON_PrintPreallocated(reply, out, (int)out_len, false);
    cJSON_Delete(reply);
    return ok;
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
