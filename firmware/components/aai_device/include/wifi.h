#pragma once

#include <stdbool.h>

// Station mode using CONFIG_AAI_WIFI_SSID / CONFIG_AAI_WIFI_PASSWORD, reconnecting
// forever. Also initializes NVS, netif and the default event loop.
void wifi_start(void);
bool wifi_wait_connected(int timeout_ms);  // timeout_ms < 0 waits forever
bool wifi_is_connected(void);
