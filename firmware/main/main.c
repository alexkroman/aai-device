// AAI voice device: say the wake word, talk to an AAI voice agent over Wi-Fi.
//
//   IDLE --wake--> CONNECTING --session.configured--> ACTIVE --quiet for FOLLOWUP_MS--> IDLE
//
// Saying the wake word while the agent is talking interrupts it, and "stop" (the agent's
// stop tool) hangs up without a reply.
// Reminders the agent pushes to the inbox (inbox.h) play here too, while idle; the wake
// word stops one. Firmware updates (ota.h) install in the background and reboot while idle.

#include "aai_events.h"
#include "agent.h"
#include "board.h"
#include "crash.h"
#include "discovery.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "inbox.h"
#include "leds.h"
#include "ota.h"
#include "sdkconfig.h"
#include "voice.h"
#include "wifi.h"

static const char *TAG = "main";

#define CONNECT_TIMEOUT_MS 8000
// While the agent is working on a reply the follow-up window doesn't apply (a tool turn can
// go well past it without a server event), but a reply that never comes still ends it.
#define THINKING_TIMEOUT_MS 60000
#define TICK_MS             100

typedef enum { STATE_IDLE, STATE_CONNECTING, STATE_ACTIVE } app_state_t;

// Only touched from the aai_events task, so no locking.
static app_state_t s_state = STATE_IDLE;
static int64_t s_state_since;
// The user's turn is committed and the agent hasn't finished its reply. Spans tool
// calls: hold lines ("one moment...") play mid-turn, then it's back to waiting.
static bool s_thinking;
// A notice from the inbox is playing; `queued` once all of its audio is in the speaker.
static bool s_notice, s_notice_queued;
// New firmware is installed: reboot into it at the first quiet moment.
static bool s_update_ready;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/** A wake word handled later than this after it was heard is logged: the chime lagged. */
#define WAKE_LAG_WARN_MS 150

// Notices wait (the inbox answers "busy") while someone is talking to the agent: one
// voice at a time.
static void enter(app_state_t state)
{
    s_state = state;
    s_state_since = now_ms();
    inbox_set_busy(s_state != STATE_IDLE);
    ota_set_busy(s_state != STATE_IDLE || s_notice);
}

static void end_session(void)
{
    s_thinking = false;
    voice_set_streaming(false);
    agent_stop();
    leds_set(s_state == STATE_ACTIVE ? LEDS_OFF : LEDS_ERROR);
    enter(STATE_IDLE);
}

// The ring while a session is active: speaking beats thinking beats listening.
static void show_active(void)
{
    leds_set(agent_speaker_busy() ? LEDS_SPEAKING : s_thinking ? LEDS_THINKING : LEDS_LISTENING);
}

static void notice_over(void)
{
    s_notice = false;
    ota_set_busy(s_state != STATE_IDLE);
    if (s_state == STATE_IDLE) {
        leds_set(LEDS_OFF);
    }
}

static void on_wake(void)
{
    if (s_notice) {
        // "Computer" during a reminder = "stop": the rest is dropped (and still acked, so
        // it isn't said again) and no session opens.
        ESP_LOGI(TAG, "notice stopped");
        inbox_stop_notice();
        agent_cancel();
        notice_over();
        return;
    }
    if (s_state != STATE_IDLE) {
        // Wake word mid-reply = "stop talking". Cancel before the chime: queued first, the
        // chime waited behind the buffered reply (blocking this loop) and was then flushed.
        agent_cancel();
        agent_play_chime();
        return;
    }
    agent_play_chime();
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
    if (s_notice && s_notice_queued && !agent_speaker_busy()) {
        notice_over();
    }
    if (s_update_ready && s_state == STATE_IDLE && !s_notice && !agent_speaker_busy()) {
        ESP_LOGI(TAG, "restarting into the new firmware");
        esp_restart();
    }
    if (s_state == STATE_CONNECTING && now_ms() - s_state_since > CONNECT_TIMEOUT_MS) {
        char url[DISCOVERY_URL_MAX];
        ESP_LOGE(TAG, "could not reach agent at %s", discovery_agent_url(url, sizeof(url)) ? url : "(none found)");
        discovery_refresh();  // it may have moved
        end_session();
    } else if (s_state == STATE_ACTIVE) {
        show_active();
        int64_t idle_limit = s_thinking ? THINKING_TIMEOUT_MS : CONFIG_AAI_FOLLOWUP_MS;
        if (!agent_speaker_busy() && now_ms() - agent_last_activity_ms() > idle_limit) {
            end_session();
        }
    }
}

// "Computer, stop" (the agent's stop tool). The model is still writing its follow-up to
// the tool call: cancelling aborts it and flushes anything already queued, and hanging
// up means nothing it says later has anywhere to play.
static void stop_everything(void)
{
    ESP_LOGI(TAG, "stop");
    if (s_state != STATE_IDLE) {
        agent_cancel();
        end_session();
    }
}

static void on_message(proto_type_t type)
{
    switch (type) {
    case PROTO_STOP:
        stop_everything();
        break;
    case PROTO_USER_TRANSCRIPT:
        s_thinking = true;
        if (s_state == STATE_ACTIVE) {
            show_active();  // don't wait for the next tick
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
    case AAI_EVENT_WAKE: {
        // A wake word that waited behind a slow handler is heard as the device being slow
        // to answer: say how long, so a slow chime points at the loop, not the AFE.
        int64_t lag_ms = data ? (esp_timer_get_time() - *(const int64_t *)data) / 1000 : 0;
        if (lag_ms > WAKE_LAG_WARN_MS) {
            ESP_LOGW(TAG, "wake word handled %d ms after it was heard", (int)lag_ms);
        }
        on_wake();
        break;
    }
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
        on_message(*(const proto_type_t *)data);
        break;
    case AAI_EVENT_NOTICE:
        s_notice = true;
        s_notice_queued = false;
        ota_set_busy(true);
        agent_play_chime();  // a cue first, so the reminder doesn't start mid-word to nobody
        leds_set(LEDS_SPEAKING);
        break;
    case AAI_EVENT_NOTICE_QUEUED:
        s_notice_queued = true;
        break;
    case AAI_EVENT_AGENT_FOUND: {
        char url[DISCOVERY_URL_MAX];
        if (discovery_agent_url(url, sizeof(url))) {
            inbox_start(url);  // first time: connects; after a move: reconnects there
        }
        break;
    }
    case AAI_EVENT_UPDATE_READY:
        s_update_ready = true;  // on_tick() reboots once nothing is playing
        break;
    }
}

void app_main(void)
{
    // First, so the ring spins through everything below (codec, Wi-Fi, wake word model)
    // until the device can actually hear the wake word.
    leds_init();
    leds_set(LEDS_BOOTING);
    crash_report();
    ESP_ERROR_CHECK(board_init());
    wifi_start();
    agent_init();
    voice_init(NULL);                                      // loads the wake word model while Wi-Fi joins
    ESP_ERROR_CHECK(aai_events_register(on_event, NULL));  // before discovery: it posts AGENT_FOUND
    while (!wifi_wait_connected(500)) {
        // Amber once the model is loaded, while it waits for a phone to send the network.
        leds_set(wifi_provisioning() ? LEDS_PROVISIONING : LEDS_BOOTING);
    }
    aai_events_start_tick(TICK_MS);
    discovery_start();  // its AAI_EVENT_AGENT_FOUND starts the inbox
    ota_start();
    ota_mark_healthy();  // Wi-Fi joined and the wake word is listening: this image works
    leds_set(LEDS_OFF);
    ESP_LOGI(TAG, "ready — say the wake word");
}
