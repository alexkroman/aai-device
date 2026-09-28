#include "inbox.h"

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "aai_events.h"
#include "agent.h"
#include "esp_attr.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_websocket_client.h"
#include "protocol.h"
#include "sdkconfig.h"

static const char *TAG = "inbox";

#define INBOX_BUFFER_SIZE 2048                            // the agent's frames are 4 KiB; they arrive in pieces
#define HEADER_MAX        1024                            // a notice header; anything longer is not one we take
#define REPLY_MAX         (PROTO_NOTICE_ID_MAX * 6 + 32)  // every id byte escaped
#define RECENT_IDS        8                               // acked ids remembered, so a redelivery isn't replayed

typedef enum {
    RX_IDLE,  // between notices
    RX_PLAY,  // this notice's bytes go to the speaker
    RX_SKIP,  // this notice's bytes are dropped (busy, a repeat, or stopped)
} rx_state_t;

static esp_websocket_client_handle_t s_ws;
static atomic_bool s_busy, s_stop;
// Everything below is touched only on the websocket client's task.
static rx_state_t s_rx = RX_IDLE;
static proto_notice_t s_notice;
static size_t s_remaining;
static bool s_ack_when_done;  // ack at the end (played or a repeat); busy was answered up front
static bool s_first_bytes;
static char s_recent[RECENT_IDS][PROTO_NOTICE_ID_MAX + 1];
static int s_recent_next;

const char *inbox_client_id(void)
{
    static char id[65];
    if (!id[0]) {
        if (proto_valid_client_id(CONFIG_AAI_CLIENT_ID)) {
            snprintf(id, sizeof(id), "%s", CONFIG_AAI_CLIENT_ID);
        } else {
            if (CONFIG_AAI_CLIENT_ID[0]) {
                ESP_LOGW(TAG, "CONFIG_AAI_CLIENT_ID must be 1-64 of A-Z a-z 0-9 _ -; using the MAC");
            }
            uint8_t mac[6] = {0};
            esp_read_mac(mac, ESP_MAC_WIFI_STA);
            snprintf(id, sizeof(id), "speaker-%02x%02x%02x", mac[3], mac[4], mac[5]);
        }
    }
    return id;
}

void inbox_set_busy(bool busy) { s_busy = busy; }

void inbox_stop_notice(void) { s_stop = true; }

static void reply(const char *type, const char *id)
{
    char json[REPLY_MAX];
    if (!proto_notice_reply(type, id, json, sizeof(json)) ||
        esp_websocket_client_send_text(s_ws, json, strlen(json), pdMS_TO_TICKS(1000)) < 0) {
        ESP_LOGW(TAG, "could not send %s for %s", type, id);  // the agent will send it again
    }
}

static bool seen(const char *id)
{
    for (int i = 0; i < RECENT_IDS; i++) {
        if (strcmp(s_recent[i], id) == 0) {
            return true;
        }
    }
    return false;
}

static void finish(void)
{
    if (s_rx == RX_PLAY) {
        aai_events_post(AAI_EVENT_NOTICE_QUEUED, NULL, 0);
    }
    if (s_ack_when_done) {
        reply("ack", s_notice.id);
        if (!seen(s_notice.id)) {
            snprintf(s_recent[s_recent_next], sizeof(s_recent[0]), "%s", s_notice.id);
            s_recent_next = (s_recent_next + 1) % RECENT_IDS;
        }
    }
    s_rx = RX_IDLE;
}

static void on_header(const char *json, size_t len)
{
    if (s_rx != RX_IDLE) {
        ESP_LOGW(TAG, "notice %s cut short by the next one", s_notice.id);
        s_rx = RX_IDLE;  // its bytes never all came; the agent retries it, unacked
    }
    if (!proto_parse_notice(json, len, &s_notice)) {
        return;  // not a notice we can take; unanswered, so it is retried and then given up on
    }
    s_remaining = s_notice.bytes;
    if (seen(s_notice.id)) {
        ESP_LOGI(TAG, "repeat of %s: acking without playing", s_notice.id);
        s_rx = RX_SKIP;
        s_ack_when_done = true;
    } else if (s_busy) {
        ESP_LOGI(TAG, "%s %s: busy, it comes back later", s_notice.event, s_notice.id);
        reply("busy", s_notice.id);
        s_rx = RX_SKIP;
        s_ack_when_done = false;
    } else {
        ESP_LOGI(TAG, "%s: %s (%u ms)", s_notice.event, s_notice.text, (unsigned)(s_notice.bytes * 1000 / (16000 * 2)));
        s_stop = false;
        s_first_bytes = true;
        s_rx = RX_PLAY;
        s_ack_when_done = true;
        aai_events_post(AAI_EVENT_NOTICE, NULL, 0);
    }
    if (s_remaining == 0) {
        finish();
    }
}

static void on_bytes(const uint8_t *data, size_t len)
{
    if (s_rx == RX_IDLE) {
        return;
    }
    len = len < s_remaining ? len : s_remaining;
    if (s_rx == RX_PLAY && (s_stop || !agent_play_notice(data, len, s_first_bytes))) {
        s_rx = RX_SKIP;  // stopped or stalled: the rest is dropped, and still acked
    }
    s_first_bytes = false;
    s_remaining -= len;
    if (s_remaining == 0) {
        finish();
    }
}

static void ws_handler(void *arg, esp_event_base_t base, int32_t id, void *event_data)
{
    esp_websocket_event_data_t *ev = event_data;
    EXT_RAM_BSS_ATTR static char header[HEADER_MAX];
    static uint8_t frame_op;

    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "connected as %s", inbox_client_id());
        break;
    case WEBSOCKET_EVENT_DATA: {
        uint8_t op = ev->op_code & 0x0F;
        if (op == 0x1 || op == 0x2) {
            frame_op = op;
        } else if (op != 0x0) {
            break;  // ping/pong/close are handled by the client library
        }
        if (frame_op == 0x2) {
            on_bytes((const uint8_t *)ev->data_ptr, ev->data_len);
        } else if (ev->payload_len < HEADER_MAX) {
            memcpy(header + ev->payload_offset, ev->data_ptr, ev->data_len);
            if (ev->payload_offset + ev->data_len >= ev->payload_len) {
                on_header(header, ev->payload_len);
            }
        }
        break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        // A notice cut off here was never acked, so the agent sends it again.
        s_rx = RX_IDLE;
        break;
    default:
        break;
    }
}

void inbox_init(void)
{
    static char uri[256];
    if (!proto_inbox_url(CONFIG_AAI_AGENT_URL, inbox_client_id(), uri, sizeof(uri))) {
        ESP_LOGE(TAG, "no inbox: cannot build its URL from %s", CONFIG_AAI_AGENT_URL);
        return;
    }
    esp_websocket_client_config_t cfg = {
        .uri = uri,
        .buffer_size = INBOX_BUFFER_SIZE,
        .task_stack = 4096,
        .task_prio = 5,  // below the voice session's socket (8)
        .reconnect_timeout_ms = 10000,
        .network_timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach,  // wss:// agents, like agent.c; unused for ws://
    };
    s_ws = esp_websocket_client_init(&cfg);
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_handler, NULL);
    if (esp_websocket_client_start(s_ws) != ESP_OK) {
        ESP_LOGE(TAG, "inbox start failed");
    }
}
