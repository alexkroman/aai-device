#include <string.h>
#include "protocol.h"
#include "unity.h"

static proto_msg_t msg;

void setUp(void) {}
void tearDown(void) {}

static bool parse(const char *json) { return proto_parse(json, strlen(json), &msg); }

// ---- proto_parse ------------------------------------------------------------

static void test_session_configured(void)
{
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.configured\",\"meta\":{\"id\":\"evt_1\",\"at\":1},"
                           "\"audioFormat\":\"pcm16\",\"sampleRate\":16000,\"ttsSampleRate\":24000,"
                           "\"sessionId\":\"sess_abc\"}"));
    TEST_ASSERT_EQUAL(PROTO_SESSION_CONFIGURED, msg.type);
    TEST_ASSERT_EQUAL(16000, msg.sample_rate);
    TEST_ASSERT_EQUAL(24000, msg.tts_sample_rate);
    TEST_ASSERT_EQUAL_STRING("sess_abc", msg.session_id);
}

static void test_session_configured_s2s_rates(void)
{
    // Speech-to-speech agents pin both directions to 24 kHz.
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.configured\",\"sampleRate\":24000,\"ttsSampleRate\":24000}"));
    TEST_ASSERT_EQUAL(24000, msg.sample_rate);
    TEST_ASSERT_EQUAL(24000, msg.tts_sample_rate);
    TEST_ASSERT_EQUAL_STRING("", msg.session_id);
}

static void test_session_configured_bad_rates_fall_back(void)
{
    // A zero/missing rate would divide by zero in resampler_init.
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.configured\",\"sampleRate\":0,\"ttsSampleRate\":\"fast\"}"));
    TEST_ASSERT_EQUAL(PROTO_DEFAULT_SAMPLE_RATE, msg.sample_rate);
    TEST_ASSERT_EQUAL(PROTO_DEFAULT_TTS_SAMPLE_RATE, msg.tts_sample_rate);
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.configured\",\"sampleRate\":1e9}"));
    TEST_ASSERT_EQUAL(PROTO_DEFAULT_SAMPLE_RATE, msg.sample_rate);
    TEST_ASSERT_EQUAL(PROTO_DEFAULT_TTS_SAMPLE_RATE, msg.tts_sample_rate);
}

static void test_session_configured_odd_rates(void)
{
    // The resampler handles any integer rate in range; fractional rates are nonsense.
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.configured\",\"sampleRate\":22050,\"ttsSampleRate\":17000}"));
    TEST_ASSERT_EQUAL(22050, msg.sample_rate);
    TEST_ASSERT_EQUAL(17000, msg.tts_sample_rate);
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.configured\",\"ttsSampleRate\":24000.5}"));
    TEST_ASSERT_EQUAL(PROTO_DEFAULT_TTS_SAMPLE_RATE, msg.tts_sample_rate);
}

static void test_barge_in_events(void)
{
    TEST_ASSERT_TRUE(parse("{\"type\":\"reply.cancelled\"}"));
    TEST_ASSERT_EQUAL(PROTO_REPLY_CANCELLED, msg.type);
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.reset\"}"));
    TEST_ASSERT_EQUAL(PROTO_SESSION_RESET, msg.type);
}

static void test_speech_started_is_not_barge_in(void)
{
    // speech.started fires on false barge-ins too; it must never flush playback.
    TEST_ASSERT_TRUE(parse("{\"type\":\"speech.started\"}"));
    TEST_ASSERT_EQUAL(PROTO_OTHER, msg.type);
}

static void test_transcripts(void)
{
    TEST_ASSERT_TRUE(parse("{\"type\":\"user-transcript.committed\",\"text\":\"what's the weather\"}"));
    TEST_ASSERT_EQUAL(PROTO_USER_TRANSCRIPT, msg.type);
    TEST_ASSERT_EQUAL_STRING("what's the weather", msg.text);
    TEST_ASSERT_TRUE(parse("{\"type\":\"agent-transcript.committed\",\"text\":\"Sunny, 72.\"}"));
    TEST_ASSERT_EQUAL(PROTO_AGENT_TRANSCRIPT, msg.type);
    TEST_ASSERT_EQUAL_STRING("Sunny, 72.", msg.text);
    // Partial updates are for live captions only.
    TEST_ASSERT_TRUE(parse("{\"type\":\"user-transcript.updated\",\"text\":\"what's\"}"));
    TEST_ASSERT_EQUAL(PROTO_OTHER, msg.type);
}

static void test_long_transcript_is_truncated(void)
{
    static char json[4096];
    char text[2000];
    memset(text, 'a', sizeof(text) - 1);
    text[sizeof(text) - 1] = '\0';
    snprintf(json, sizeof(json), "{\"type\":\"agent-transcript.committed\",\"text\":\"%s\"}", text);
    TEST_ASSERT_TRUE(parse(json));
    TEST_ASSERT_EQUAL(sizeof(msg.text) - 1, strlen(msg.text));
}

static void test_tool_called(void)
{
    TEST_ASSERT_TRUE(parse("{\"type\":\"tool.called\",\"toolCallId\":\"t1\",\"toolName\":\"get_weather\","
                           "\"args\":{\"city\":\"Denver\"}}"));
    TEST_ASSERT_EQUAL(PROTO_TOOL_CALLED, msg.type);
    TEST_ASSERT_EQUAL_STRING("get_weather", msg.text);
}

static void test_errors(void)
{
    TEST_ASSERT_TRUE(parse("{\"type\":\"error.reported\",\"code\":\"stt\",\"message\":\"boom\",\"fatal\":true}"));
    TEST_ASSERT_EQUAL(PROTO_ERROR, msg.type);
    TEST_ASSERT_TRUE(msg.fatal);
    TEST_ASSERT_EQUAL_STRING("stt", msg.code);
    TEST_ASSERT_EQUAL_STRING("boom", msg.text);
    TEST_ASSERT_TRUE(parse("{\"type\":\"error.reported\",\"code\":\"tool\",\"message\":\"x\",\"fatal\":false}"));
    TEST_ASSERT_FALSE(msg.fatal);
    TEST_ASSERT_TRUE(parse("{\"type\":\"error.reported\"}"));
    TEST_ASSERT_FALSE(msg.fatal);
}

static void test_timed_out(void)
{
    TEST_ASSERT_TRUE(parse("{\"type\":\"session.timed-out\"}"));
    TEST_ASSERT_EQUAL(PROTO_TIMED_OUT, msg.type);
}

static void test_unknown_and_malformed(void)
{
    TEST_ASSERT_TRUE(parse("{\"type\":\"usage.updated\",\"future\":[1,2,3]}"));
    TEST_ASSERT_EQUAL(PROTO_OTHER, msg.type);
    TEST_ASSERT_FALSE(parse("not json"));
    TEST_ASSERT_FALSE(parse("{\"type\":42}"));
    TEST_ASSERT_FALSE(parse("{}"));
    TEST_ASSERT_FALSE(parse("[]"));
    TEST_ASSERT_FALSE(parse(""));
    TEST_ASSERT_FALSE(parse("{\"type\":\"reply.cancelled\""));  // truncated frame
}

static void test_parse_respects_length(void)
{
    // Frames are not NUL-terminated; bytes past `len` must be ignored.
    const char *buf = "{\"type\":\"reply.cancelled\"}GARBAGE";
    TEST_ASSERT_TRUE(proto_parse(buf, strlen("{\"type\":\"reply.cancelled\"}"), &msg));
    TEST_ASSERT_EQUAL(PROTO_REPLY_CANCELLED, msg.type);
}

// ---- proto_session_url ------------------------------------------------------

static void test_url_fresh_session(void)
{
    char url[128];
    TEST_ASSERT_TRUE(proto_session_url("ws://10.0.0.2:3000/websocket", NULL, NULL, url, sizeof(url)));
    TEST_ASSERT_EQUAL_STRING("ws://10.0.0.2:3000/websocket?resume=1", url);
    TEST_ASSERT_TRUE(proto_session_url("ws://10.0.0.2:3000/websocket", "", NULL, url, sizeof(url)));
    TEST_ASSERT_EQUAL_STRING("ws://10.0.0.2:3000/websocket?resume=1", url);
}

static void test_url_resume(void)
{
    char url[128];
    TEST_ASSERT_TRUE(proto_session_url("ws://h/websocket", "sess_1", NULL, url, sizeof(url)));
    TEST_ASSERT_EQUAL_STRING("ws://h/websocket?sessionId=sess_1", url);
}

static void test_url_existing_query(void)
{
    char url[128];
    TEST_ASSERT_TRUE(proto_session_url("wss://h/websocket?token=abc", NULL, NULL, url, sizeof(url)));
    TEST_ASSERT_EQUAL_STRING("wss://h/websocket?token=abc&resume=1", url);
}

static void test_url_overflow(void)
{
    char url[16];
    TEST_ASSERT_FALSE(proto_session_url("ws://a-long-host-name/websocket", NULL, NULL, url, sizeof(url)));
}

static void test_url_location_encoded(void)
{
    char url[160];
    TEST_ASSERT_TRUE(
        proto_session_url("ws://h/websocket", NULL, "123 Example St, Portland, OR 97201", url, sizeof(url)));
    TEST_ASSERT_EQUAL_STRING("ws://h/websocket?resume=1&location=123%20Example%20St%2C%20Portland%2C%20OR%2097201",
                             url);
    TEST_ASSERT_TRUE(proto_session_url("ws://h/websocket", "sess_1", "a&b=c", url, sizeof(url)));
    TEST_ASSERT_EQUAL_STRING("ws://h/websocket?sessionId=sess_1&location=a%26b%3Dc", url);
    TEST_ASSERT_TRUE(proto_session_url("ws://h/websocket", NULL, "", url, sizeof(url)));
    TEST_ASSERT_EQUAL_STRING("ws://h/websocket?resume=1", url);
}

static void test_url_location_overflow(void)
{
    // Room for the base and the key but not an encoded character: refuse, never truncate.
    char url[37];
    TEST_ASSERT_FALSE(proto_session_url("ws://h/websocket", NULL, "a b", url, sizeof(url)));
}

// ---- pcm_align --------------------------------------------------------------

static void test_align_even_frames(void)
{
    const uint8_t data[] = {0x01, 0x00, 0xFF, 0x7F, 0x00, 0x80};
    int16_t out[4];
    pcm_aligner_t a = {0};
    TEST_ASSERT_EQUAL(3, pcm_align(&a, data, sizeof(data), out));
    TEST_ASSERT_EQUAL_INT16(1, out[0]);
    TEST_ASSERT_EQUAL_INT16(INT16_MAX, out[1]);
    TEST_ASSERT_EQUAL_INT16(INT16_MIN, out[2]);
}

static void test_align_sample_split_across_frames(void)
{
    // 0x1234, 0x5678 split as [34] [12 78] [56]
    const uint8_t f1[] = {0x34}, f2[] = {0x12, 0x78}, f3[] = {0x56};
    int16_t out[4];
    pcm_aligner_t a = {0};
    TEST_ASSERT_EQUAL(0, pcm_align(&a, f1, 1, out));
    TEST_ASSERT_EQUAL(1, pcm_align(&a, f2, 2, out));
    TEST_ASSERT_EQUAL_HEX16(0x1234, out[0]);
    TEST_ASSERT_EQUAL(1, pcm_align(&a, f3, 1, out));
    TEST_ASSERT_EQUAL_HEX16(0x5678, out[0]);
}

static void test_align_empty_frame_keeps_carry(void)
{
    const uint8_t f1[] = {0xCD}, f2[] = {0xAB};
    int16_t out[2];
    pcm_aligner_t a = {0};
    pcm_align(&a, f1, 1, out);
    TEST_ASSERT_EQUAL(0, pcm_align(&a, NULL, 0, out));
    TEST_ASSERT_EQUAL(1, pcm_align(&a, f2, 1, out));
    TEST_ASSERT_EQUAL_HEX16((int16_t)0xABCD, out[0]);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_session_configured);
    RUN_TEST(test_session_configured_s2s_rates);
    RUN_TEST(test_session_configured_bad_rates_fall_back);
    RUN_TEST(test_session_configured_odd_rates);
    RUN_TEST(test_barge_in_events);
    RUN_TEST(test_speech_started_is_not_barge_in);
    RUN_TEST(test_transcripts);
    RUN_TEST(test_long_transcript_is_truncated);
    RUN_TEST(test_tool_called);
    RUN_TEST(test_errors);
    RUN_TEST(test_timed_out);
    RUN_TEST(test_unknown_and_malformed);
    RUN_TEST(test_parse_respects_length);
    RUN_TEST(test_url_fresh_session);
    RUN_TEST(test_url_resume);
    RUN_TEST(test_url_existing_query);
    RUN_TEST(test_url_overflow);
    RUN_TEST(test_url_location_encoded);
    RUN_TEST(test_url_location_overflow);
    RUN_TEST(test_align_even_frames);
    RUN_TEST(test_align_sample_split_across_frames);
    RUN_TEST(test_align_empty_frame_keeps_carry);
    return UNITY_END();
}
