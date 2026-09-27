// AAI voice device: say the wake word, talk to an AAI voice agent over Wi-Fi.
//
//   IDLE --wake--> CONNECTING --session.configured--> ACTIVE --quiet for FOLLOWUP_MS--> IDLE
//
// Saying the wake word while the agent is talking interrupts it.

#include "aai_events.h"
#include "agent.h"
#include "board.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "leds.h"
#include "sdkconfig.h"
#include "voice.h"
#include "wifi.h"

static const char *TAG = "main";

#define CONNECT_TIMEOUT_MS 8000
#define TICK_MS            100

typedef enum { STATE_IDLE, STATE_CONNECTING, STATE_ACTIVE } app_state_t;

// Only touched from the aai_events task, so no locking.
static app_state_t s_state = STATE_IDLE;
static int64_t s_state_since;
// The user's turn is committed and the agent hasn't finished its reply. Spans tool
// calls: hold lines ("one moment...") play mid-turn, then it's back to waiting.
static bool s_thinking;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

static void enter(app_state_t state)
{
    s_state = state;
    s_state_since = now_ms();
}

static void end_session(void)
{
    s_thinking = false;
    voice_set_streaming(false);
    agent_stop();
    leds_set(s_state == STATE_ACTIVE ? LEDS_OFF : LEDS_ERROR);
    enter(STATE_IDLE);
}

static void on_wake(void)
{
    agent_play_tone(880, 120);
    if (s_state != STATE_IDLE) {
        agent_cancel();  // wake word mid-reply = "stop talking"
        return;
    }
    if (!wifi_is_connected()) {
        ESP_LOGW(TAG, "no wifi");
        leds_set(LEDS_ERROR);
        return;
    }
    leds_set(LEDS_CONNECTING);
    voice_set_streaming(true);  // buffer speech while the socket connects
    agent_start();
    enter(STATE_CONNECTING);
}

static void on_tick(void)
{
    if (s_state == STATE_CONNECTING && now_ms() - s_state_since > CONNECT_TIMEOUT_MS) {
        ESP_LOGE(TAG, "could not reach agent at %s", CONFIG_AAI_AGENT_URL);
        end_session();
    } else if (s_state == STATE_ACTIVE) {
        bool speaking = agent_speaker_busy();
        leds_set(speaking ? LEDS_SPEAKING : s_thinking ? LEDS_THINKING : LEDS_LISTENING);
        if (!speaking && now_ms() - agent_last_activity_ms() > CONFIG_AAI_FOLLOWUP_MS) {
            end_session();
        }
    }
}

static void on_message(const proto_msg_t *msg)
{
    switch (msg->type) {
    case PROTO_USER_TRANSCRIPT:
        s_thinking = true;
        if (s_state == STATE_ACTIVE && !agent_speaker_busy()) {
            leds_set(LEDS_THINKING);  // don't wait for the next tick
        }
        break;
    case PROTO_AGENT_TRANSCRIPT:  // final reply text is in; its audio shows as speaking
    case PROTO_REPLY_CANCELLED:
    case PROTO_SESSION_RESET:
    case PROTO_ERROR:
        s_thinking = false;
        break;
    default:
        break;
    }
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    switch ((aai_event_id_t)id) {
    case AAI_EVENT_WAKE:
        on_wake();
        break;
    case AAI_EVENT_SESSION_READY:
        if (s_state == STATE_CONNECTING) {
            enter(STATE_ACTIVE);
        }
        break;
    case AAI_EVENT_SESSION_CLOSED:
        if (s_state != STATE_IDLE) {
            end_session();
        }
        break;
    case AAI_EVENT_TICK:
        on_tick();
        break;
    case AAI_EVENT_MESSAGE:
        on_message(data);
        break;
    }
}

void app_main(void)
{
    // First, so the ring spins through everything below (codec, Wi-Fi, wake word model)
    // until the device can actually hear the wake word.
    leds_init();
    leds_set(LEDS_BOOTING);
    ESP_ERROR_CHECK(board_init());
    board_speaker_set_volume(CONFIG_AAI_VOLUME);
    wifi_start();
    wifi_wait_connected(-1);
    agent_init();
    voice_init(NULL);
    ESP_ERROR_CHECK(aai_events_register(on_event, NULL));
    aai_events_start_tick(TICK_MS);
    leds_set(LEDS_OFF);
    ESP_LOGI(TAG, "ready — say the wake word");
}
