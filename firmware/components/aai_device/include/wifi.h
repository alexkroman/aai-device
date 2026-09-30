#pragma once

#include <stdbool.h>

// Station mode, reconnecting forever. The network is CONFIG_AAI_WIFI_SSID when one is
// compiled in; otherwise the one saved in NVS, and with none saved, the speaker opens a
// provisioning access point (AAI-xxxxxx) for the ESP SoftAP Prov phone app. Saved
// credentials that don't connect within CONFIG_AAI_PROV_FALLBACK_S open it too.
// Also initializes NVS, netif and the default event loop.
void wifi_start(void);
bool wifi_wait_connected(int timeout_ms);  // timeout_ms < 0 waits forever
bool wifi_is_connected(void);
bool wifi_provisioning(void);  // the provisioning access point is up
