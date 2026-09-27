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
    AAI_EVENT_MESSAGE,         // event data: proto_msg_t (every server event except PROTO_OTHER)
    AAI_EVENT_TICK,            // periodic, for timeouts (see aai_events_start_tick)
} aai_event_id_t;

esp_event_loop_handle_t aai_events_loop(void);  // created on first use
void aai_events_post(aai_event_id_t id, const void *data, size_t size);
esp_err_t aai_events_register(esp_event_handler_t handler, void *arg);  // all AAI_EVENT ids
void aai_events_start_tick(int period_ms);
