#include "crash.h"

#include <stdio.h>
#include "esp_attr.h"
#include "esp_core_dump.h"
#include "esp_log.h"

static const char *TAG = "crash";

void crash_report(void)
{
    if (esp_core_dump_image_check() != ESP_OK) {
        return;  // none saved (or it didn't survive: a partial write fails the checksum)
    }
    EXT_RAM_BSS_ATTR static esp_core_dump_summary_t summary;  // ~150 bytes; off app_main's stack
    if (esp_core_dump_get_summary(&summary) != ESP_OK) {
        ESP_LOGW(TAG, "a core dump is saved but unreadable; `make coredump`");
        return;
    }
    char bt[16 * 11 + 1] = "";
    size_t len = 0;
    for (uint32_t i = 0; i < summary.exc_bt_info.depth && i < 16 && len < sizeof(bt); i++) {
        len += (size_t)snprintf(bt + len, sizeof(bt) - len, " 0x%08lx", (unsigned long)summary.exc_bt_info.bt[i]);
    }
    ESP_LOGW(TAG, "saved crash: task %s, pc 0x%08lx, backtrace%s%s", summary.exc_task, (unsigned long)summary.exc_pc,
             bt, summary.exc_bt_info.corrupted ? " (corrupted)" : "");
    ESP_LOGW(TAG, "`make coredump` decodes and clears it");
}
