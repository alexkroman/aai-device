#include "wifi.h"

#include <stdio.h>
#include <string.h>
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "network_provisioning/manager.h"
#include "network_provisioning/scheme_softap.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char *TAG = "wifi";

#define CONNECTED BIT0
static EventGroupHandle_t s_events;
static volatile bool s_provisioning;

// SoftAP, not BLE: the Bluetooth stack would cost internal RAM the websocket clients need,
// and it would sit idle after the first boot. The phone joins the speaker's own network
// (AAI-xxxxxx) in Espressif's "ESP SoftAP Prov" app and hands it the home network.
static void start_provisioning(void)
{
    network_prov_mgr_config_t cfg = {
        .scheme = network_prov_scheme_softap,
        .scheme_event_handler = NETWORK_PROV_EVENT_HANDLER_NONE,
    };
    if (network_prov_mgr_init(cfg) != ESP_OK) {
        ESP_LOGE(TAG, "provisioning failed to start");
        return;
    }
    static bool ap_netif;
    if (!ap_netif) {
        esp_netif_create_default_wifi_ap();
        ap_netif = true;
    }
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char name[16];
    snprintf(name, sizeof(name), "AAI-%02X%02X%02X", mac[3], mac[4], mac[5]);
    // Security 1: the credentials are encrypted with a session key only a phone that knows
    // the proof of possession (CONFIG_AAI_PROV_POP) can derive. The AP itself is open.
    const char *pop = CONFIG_AAI_PROV_POP[0] ? CONFIG_AAI_PROV_POP : NULL;
    s_provisioning = true;
    esp_err_t err = network_prov_mgr_start_provisioning(NETWORK_PROV_SECURITY_1, pop, name, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "provisioning failed to start: %s", esp_err_to_name(err));
        s_provisioning = false;
        network_prov_mgr_deinit();
        return;
    }
    ESP_LOGW(TAG, "no Wi-Fi: join \"%s\" in the ESP SoftAP Prov app (proof of possession \"%s\")", name,
             pop ? pop : "");
}

static void handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) {
        xEventGroupClearBits(s_events, CONNECTED);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = data;
        ESP_LOGI(TAG, "connected, ip " IPSTR, IP2STR(&ev->ip_info.ip));
        xEventGroupSetBits(s_events, CONNECTED);
        if (s_provisioning) {
            // The saved network came back while the fallback AP was up: take it down.
            network_prov_mgr_stop_provisioning();
        }
    } else if (base == NETWORK_PROV_EVENT && id == NETWORK_PROV_WIFI_CRED_FAIL) {
        ESP_LOGW(TAG, "that network didn't take (wrong password or not in range); send it again");
        network_prov_mgr_reset_wifi_sm_state_on_failure();
    } else if (base == NETWORK_PROV_EVENT && id == NETWORK_PROV_WIFI_CRED_SUCCESS) {
        ESP_LOGI(TAG, "provisioned");
    } else if (base == NETWORK_PROV_EVENT && id == NETWORK_PROV_END) {
        s_provisioning = false;
        network_prov_mgr_deinit();
    }
}

// Saved credentials that never connect (the speaker moved house, the password changed):
// open provisioning beside the retries, so it can be told the new network.
static void fallback_task(void *arg)
{
    if (!wifi_wait_connected(CONFIG_AAI_PROV_FALLBACK_S * 1000)) {
        ESP_LOGW(TAG, "saved network unreachable for %d s", CONFIG_AAI_PROV_FALLBACK_S);
        start_provisioning();
    }
    vTaskDelete(NULL);
}

void wifi_start(void)
{
    if (s_events) {
        return;
    }
    s_events = xEventGroupCreate();
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, handler, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, handler, NULL);
    esp_event_handler_register(NETWORK_PROV_EVENT, ESP_EVENT_ANY_ID, handler, NULL);

    bool saved = false;
    if (CONFIG_AAI_WIFI_SSID[0]) {
        // Compiled in (sdkconfig.defaults.local): the developer path, and what tests use.
        wifi_config_t cfg;  // a union: `= {0}` only zeroes its first member (ap), not sta
        memset(&cfg, 0, sizeof(cfg));
        strlcpy((char *)cfg.sta.ssid, CONFIG_AAI_WIFI_SSID, sizeof(cfg.sta.ssid));
        strlcpy((char *)cfg.sta.password, CONFIG_AAI_WIFI_PASSWORD, sizeof(cfg.sta.password));
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
        ESP_LOGI(TAG, "connecting to \"%s\"", CONFIG_AAI_WIFI_SSID);
    } else {
        wifi_config_t cfg;
        saved = esp_wifi_get_config(WIFI_IF_STA, &cfg) == ESP_OK && cfg.sta.ssid[0];
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        if (saved) {
            ESP_LOGI(TAG, "connecting to \"%.32s\" (saved)", (const char *)cfg.sta.ssid);
        }
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);  // power save adds 100+ ms of latency to streamed audio

    if (!CONFIG_AAI_WIFI_SSID[0]) {
        if (!saved) {
            start_provisioning();
        } else if (CONFIG_AAI_PROV_FALLBACK_S > 0) {
            xTaskCreate(fallback_task, "wifi_fallback", 4096, NULL, 2, NULL);  // reads NVS: internal stack
        }
    }
}

bool wifi_wait_connected(int timeout_ms)
{
    TickType_t ticks = timeout_ms < 0 ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    return xEventGroupWaitBits(s_events, CONNECTED, false, true, ticks) & CONNECTED;
}

bool wifi_is_connected(void) { return s_events && (xEventGroupGetBits(s_events) & CONNECTED); }

bool wifi_provisioning(void) { return s_provisioning; }
