#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

// Waveshare ESP32-S3-AUDIO-Board: ES7210 (4-ch mic ADC) + ES8311 (DAC) on a shared I2S1 bus.
#define BOARD_SAMPLE_RATE  16000
#define BOARD_MIC_CHANNELS 4       // raw frame layout, see BOARD_MIC_FORMAT
#define BOARD_MIC_FORMAT   "RMNM"  // Reference(loopback), Mic, uNused, Mic
#define BOARD_LED_GPIO     38
#define BOARD_LED_COUNT    7

esp_err_t board_init(void);

// Read `frames` interleaved 4-channel int16 frames (BOARD_MIC_FORMAT order). Blocks.
esp_err_t board_mic_read(int16_t *buf, size_t frames);

// Play mono 16 kHz PCM16. Blocks until queued into the I2S DMA.
esp_err_t board_speaker_write(const int16_t *pcm, size_t samples);

void board_speaker_set_volume(int volume);  // 0-100
void board_speaker_enable(bool on);         // speaker amplifier (TCA9555 EXIO8); off after init
