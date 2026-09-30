#include "discovery.h"

#include <stdio.h>
#include <string.h>
#include "aai_events.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "inbox.h"
#include "mdns.h"
#include "sdkconfig.h"

static const char *TAG = "discovery";

#define SERVICE      "_aai"
#define PROTO        "_tcp"
#define QUERY_MS     3000
#define RETRY_MS     5000  // while nothing is found
#define DEFAULT_PATH "/websocket"

static SemaphoreHandle_t s_lock;
static char s_url[DISCOVERY_URL_MAX];
static TaskHandle_t s_task;

static const char *txt(const mdns_result_t *r, const char *key)
{
    for (size_t i = 0; i < r->txt_count; i++) {
        if (r->txt[i].key && strcmp(r->txt[i].key, key) == 0) {
            return r->txt[i].value;
        }
    }
    return NULL;
}

static void set_url(const char *url)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool changed = strcmp(s_url, url) != 0;
    if (changed) {
        strlcpy(s_url, url, sizeof(s_url));
    }
    xSemaphoreGive(s_lock);
    if (changed) {
        ESP_LOGI(TAG, "agent at %s", url);
        aai_events_post(AAI_EVENT_AGENT_FOUND, NULL, 0);
    }
}

// One query; true when an agent answered with an IPv4 address.
static bool query(void)
{
    mdns_result_t *results = NULL;
    if (mdns_query_ptr(SERVICE, PROTO, QUERY_MS, 4, &results) != ESP_OK) {
        return false;
    }
    bool found = false;
    for (const mdns_result_t *r = results; r && !found; r = r->next) {
        for (const mdns_ip_addr_t *a = r->addr; a && !found; a = a->next) {
            if (a->addr.type != ESP_IPADDR_TYPE_V4 || r->port == 0) {
                continue;
            }
            const char *path = txt(r, "path");
            const char *tls = txt(r, "tls");
            char url[DISCOVERY_URL_MAX];
            snprintf(url, sizeof(url), "%s://" IPSTR ":%u%s", tls && strcmp(tls, "1") == 0 ? "wss" : "ws",
                     IP2STR(&a->addr.u_addr.ip4), r->port, path && path[0] == '/' ? path : DEFAULT_PATH);
            set_url(url);
            found = true;
        }
    }
    mdns_query_results_free(results);
    return found;
}

static void discovery_task(void *arg)
{
    for (;;) {
        if (query()) {
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);  // until discovery_refresh()
        } else {
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(RETRY_MS));
        }
    }
}

void discovery_start(void)
{
    if (s_lock) {
        return;
    }
    s_lock = xSemaphoreCreateMutex();
    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(inbox_client_id());  // e.g. speaker-a1b2c3.local, for logs and OTA pushes
        mdns_instance_name_set("AAI speaker");
    } else {
        ESP_LOGW(TAG, "mDNS failed to start");
    }
    if (CONFIG_AAI_AGENT_URL[0]) {
        set_url(CONFIG_AAI_AGENT_URL);
        return;
    }
    ESP_LOGI(TAG, "looking for the agent on the LAN (" SERVICE "." PROTO ")");
    // PSRAM stack like the other network-only tasks: it never touches flash.
    xTaskCreatePinnedToCoreWithCaps(discovery_task, "discovery", 4096, NULL, 3, &s_task, tskNO_AFFINITY,
                                    MALLOC_CAP_SPIRAM);
}

bool discovery_agent_url(char *out, size_t out_len)
{
    if (!s_lock) {
        // discovery_start() not called (the test app): only a configured URL is known.
        snprintf(out, out_len, "%s", CONFIG_AAI_AGENT_URL);
        return out[0] != '\0';
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    snprintf(out, out_len, "%s", s_url);
    xSemaphoreGive(s_lock);
    return out[0] != '\0';
}

void discovery_refresh(void)
{
    if (s_task) {
        xTaskNotifyGive(s_task);
    }
}
