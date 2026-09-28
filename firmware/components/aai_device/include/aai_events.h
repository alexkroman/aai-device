#pragma once

// Every cross-module signal goes through one esp_event loop, on its own task so
// slow handlers (agent_stop() closing a socket) never stall the system loop.

#include "esp_event.h"
#include "protocol.h"

ESP_EVENT_DECLARE_BASE(AAI_EVENT);

typedef enum {
    AAI_EVENT_WAKE,            // wake word detected (from the AFE task)
    AAI_EVENT_SESSION_READY,   // session.configured received; mic audio is flowing
    AAI_EVENT_SESSION_CLOSED,  // socket closed, fatal error, or session timed out
    AAI_EVENT_MESSAGE,         // event data: proto_type_t (every server event except PROTO_OTHER)
    AAI_EVENT_TICK,            // periodic, for timeouts (see aai_events_start_tick)
    AAI_EVENT_TIMER_SET,       // event data: aai_timer_cmd_t
    AAI_EVENT_TIMER_CANCEL,    // event data: aai_timer_cmd_t (seconds unused; empty label = all)
} aai_event_id_t;

// Its own small payload: AAI_EVENT_MESSAGE carries only the type, since esp_event copies
// every payload into internal RAM and the full proto_msg_t is ~650 bytes.
typedef struct {
    int seconds;
    char label[32];
} aai_timer_cmd_t;

void aai_events_post(aai_event_id_t id, const void *data, size_t size);
esp_err_t aai_events_register(esp_event_handler_t handler, void *arg);  // all AAI_EVENT ids
void aai_events_start_tick(int period_ms);
