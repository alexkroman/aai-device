#pragma once

// Where the agent is. CONFIG_AAI_AGENT_URL when set; when it's empty, found on the LAN over
// mDNS: `make agent` advertises an _aai._tcp service (agent/run.sh) with its port and a
// `path` TXT record, so a speaker needs no URL compiled in and follows the laptop's
// address when it changes. Also announces this device as <client id>.local.
//
// Posts AAI_EVENT_AGENT_FOUND whenever the URL is first known or changes.

#include <stdbool.h>
#include <stddef.h>

#define DISCOVERY_URL_MAX 256

// After Wi-Fi is up.
void discovery_start(void);

// Copies the agent's base URL (ws[s]://host:port/path) into `out`; false if none is known.
bool discovery_agent_url(char *out, size_t out_len);

// Look again (the agent didn't answer at the address we have). No-op with a configured URL.
void discovery_refresh(void);
