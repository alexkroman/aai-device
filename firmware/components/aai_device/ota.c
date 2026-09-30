#include "ota.h"

#include <stdatomic.h>
#include <string.h>
#include "aai_events.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "ota";

#define FIRST_CHECK_MIN 1   // after boot: let Wi-Fi and the agent settle first
#define RETRY_MIN       10  // after a failed check or download
#define BUSY_POLL_MS    1000

static atomic_bool s_busy;

void ota_set_busy(bool busy) { s_busy = busy; }

void ota_mark_healthy(void)
{
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "new firmware %s is up; keeping it", esp_app_get_description()->version);
        esp_ota_mark_app_valid_cancel_rollback();
    }
}

// In minutes: pdMS_TO_TICKS() multiplies in 32 bits, so hours of ms in one call overflow.
static void sleep_min(int64_t minutes)
{
    for (; minutes > 0; minutes--) {
        vTaskDelay(pdMS_TO_TICKS(60 * 1000));
    }
}

static void wait_idle(void)
{
    while (s_busy) {
        vTaskDelay(pdMS_TO_TICKS(BUSY_POLL_MS));
    }
}

// The version the bootloader last rolled back from, so it isn't installed again.
static bool rolled_back(const char *version)
{
    const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
    esp_app_desc_t desc;
    return bad && esp_ota_get_partition_description(bad, &desc) == ESP_OK &&
           strncmp(desc.version, version, sizeof(desc.version)) == 0;
}

// true: an update is installed and the next boot runs it.
static bool check(bool *failed)
{
    *failed = false;
    esp_http_client_config_t http = {
        .url = CONFIG_AAI_OTA_URL,
        .crt_bundle_attach = esp_crt_bundle_attach,  // https:// against IDF's root CAs
        .timeout_ms = 10000,
        .keep_alive_enable = true,
    };
    esp_https_ota_config_t cfg = {.http_config = &http};
    esp_https_ota_handle_t ota = NULL;
    if (esp_https_ota_begin(&cfg, &ota) != ESP_OK) {
        ESP_LOGW(TAG, "no update server at %s", CONFIG_AAI_OTA_URL);
        *failed = true;
        return false;
    }
    esp_app_desc_t next;
    const esp_app_desc_t *running = esp_app_get_description();
    if (esp_https_ota_get_img_desc(ota, &next) != ESP_OK) {
        ESP_LOGW(TAG, "%s is not a firmware image", CONFIG_AAI_OTA_URL);
        esp_https_ota_abort(ota);
        *failed = true;
        return false;
    }
    if (strncmp(next.version, running->version, sizeof(next.version)) == 0) {
        ESP_LOGI(TAG, "up to date (%s)", running->version);
        esp_https_ota_abort(ota);
        return false;
    }
    if (rolled_back(next.version)) {
        ESP_LOGW(TAG, "not installing %s again: it was rolled back", next.version);
        esp_https_ota_abort(ota);
        return false;
    }
    ESP_LOGI(TAG, "downloading %s (running %s)", next.version, running->version);
    esp_err_t err;
    do {
        wait_idle();  // a pause long enough for the server to hang up fails this attempt; retried
        err = esp_https_ota_perform(ota);
    } while (err == ESP_ERR_HTTPS_OTA_IN_PROGRESS);
    if (err != ESP_OK || !esp_https_ota_is_complete_data_received(ota)) {
        ESP_LOGW(TAG, "download failed: %s", esp_err_to_name(err));
        esp_https_ota_abort(ota);
        *failed = true;
        return false;
    }
    err = esp_https_ota_finish(ota);  // validates the image, then boots it next
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "update rejected: %s", esp_err_to_name(err));
        *failed = true;
        return false;
    }
    ESP_LOGI(TAG, "%s installed; restarting when idle", next.version);
    return true;
}

static void ota_task(void *arg)
{
    sleep_min(FIRST_CHECK_MIN);
    for (;;) {
        wait_idle();
        bool failed;
        if (check(&failed)) {
            aai_events_post(AAI_EVENT_UPDATE_READY, NULL, 0);
            vTaskSuspend(NULL);  // main reboots; nothing left to do
        }
        sleep_min(failed ? RETRY_MIN : CONFIG_AAI_OTA_CHECK_HOURS * 60LL);
    }
}

void ota_start(void)
{
    if (!CONFIG_AAI_OTA_URL[0]) {
        return;
    }
    // Internal-RAM stack, unlike the other tasks: it writes flash, which runs with the cache
    // (and so PSRAM) off.
    xTaskCreate(ota_task, "ota", 8192, NULL, 2, NULL);
}
