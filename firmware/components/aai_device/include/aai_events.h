#pragma once

// Every cross-module signal goes through one esp_event loop, on its own task so
// slow handlers (agent_stop() closing a socket) never stall the system loop.

#include "esp_event.h"
#include "protocol.h"

ESP_EVENT_DECLARE_BASE(AAI_EVENT);

typedef enum {
    AAI_EVENT_WAKE,            // wake word detected (from the AFE task); data: int64_t esp_timer µs of the detection
    AAI_EVENT_SESSION_READY,   // session.configured received; mic audio is flowing
    AAI_EVENT_SESSION_CLOSED,  // socket closed, fatal error, or session timed out
    AAI_EVENT_MESSAGE,         // event data: proto_type_t (every server event except PROTO_OTHER)
    AAI_EVENT_TICK,            // periodic, for timeouts (see aai_events_start_tick)
    AAI_EVENT_NOTICE,          // a notice from the inbox started playing (inbox.h)
    AAI_EVENT_NOTICE_QUEUED,   // ... and all of its audio is in the speaker buffer
} aai_event_id_t;

void aai_events_post(aai_event_id_t id, const void *data, size_t size);
esp_err_t aai_events_register(esp_event_handler_t handler, void *arg);  // all AAI_EVENT ids
void aai_events_start_tick(int period_ms);
