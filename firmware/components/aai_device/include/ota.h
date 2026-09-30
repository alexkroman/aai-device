#pragma once

// Firmware updates over the air. With CONFIG_AAI_OTA_URL set (an http[s]:// URL of
// aai_device.bin, e.g. `make ota-serve` on the laptop), the device reads the image's header
// there a minute after boot and every CONFIG_AAI_OTA_CHECK_HOURS. When its version differs
// from the running one, it downloads it into the other app slot, only while idle, and posts
// AAI_EVENT_UPDATE_READY: main reboots into it once nothing is playing.
//
// The bootloader rolls back to the previous image if the new one resets before
// ota_mark_healthy(), and a version that was rolled back is not downloaded again.

#include <stdbool.h>

void ota_start(void);

// In a conversation or playing a notice: hold off downloading (flash writes stall audio).
void ota_set_busy(bool busy);

// The running image works (Wi-Fi up, wake word listening): cancel the pending rollback.
void ota_mark_healthy(void);
