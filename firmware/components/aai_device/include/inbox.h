#pragma once

// The inbox: an idle WebSocket held open to the agent's WS /inbox, so a run can reach the
// device after the voice session that started it has closed (a reminder due in an hour).
// The agent pushes a notice (a JSON header, then PCM16 audio at BOARD_SAMPLE_RATE); this
// plays it through the speaker and acks it. A notice that arrives mid-conversation is
// answered "busy" and the agent sends it again later.
//
// Posts AAI_EVENT_NOTICE when a notice starts playing and AAI_EVENT_NOTICE_QUEUED when all
// of its audio is in the speaker buffer.

#include <stdbool.h>

// Connect, and keep reconnecting for the device's lifetime. After Wi-Fi is up.
void inbox_init(void);

// This device's client id: CONFIG_AAI_CLIENT_ID, or "speaker-" and the last three bytes of
// the MAC. Sent as ?client= on voice sessions too, which is how a tool finds this device.
const char *inbox_client_id(void);

// In a conversation: answer new notices "busy".
void inbox_set_busy(bool busy);

// Drop the rest of the notice being played (the wake word stopped it). It is still acked:
// it was heard, and a redelivery would repeat it.
void inbox_stop_notice(void);
