// Hand-written board bring-up for the Waveshare ESP32-S3-AUDIO-Board.
// Not esp_board_manager (evaluated 2026-09, v0.7): it can't drive a PA behind an IO
// expander (ours is TCA9555 EXIO8), requires esp_codec_dev 2.0, and remodels the mic
// input as TDM, which would change the AEC channel layout. Revisit at 1.0.

#include "board.h"

#include <stdbool.h>
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_attr.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_io_expander_tca95xx_16bit.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "esp_system.h"

static const char *TAG = "board";

#define I2C_SCL  GPIO_NUM_10
#define I2C_SDA  GPIO_NUM_11
#define I2S_MCLK GPIO_NUM_12
#define I2S_BCLK GPIO_NUM_13
#define I2S_WS   GPIO_NUM_14
#define I2S_DIN  GPIO_NUM_15  // from ES7210
#define I2S_DOUT GPIO_NUM_16  // to ES8311

#define EXIO_SPEAKER_AMP IO_EXPANDER_PIN_NUM_8
#define MIC_GAIN_DB      30.0

static i2c_master_bus_handle_t s_i2c;
static esp_io_expander_handle_t s_expander;
static i2s_chan_handle_t s_tx, s_rx;
static esp_codec_dev_handle_t s_mic, s_speaker;

static esp_err_t i2s_init(void)
{
    // One full-duplex I2S port shared by both codecs: 16 kHz, stereo, 32-bit slots.
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;  // output silence on underrun instead of repeating stale audio
    ESP_RETURN_ON_ERROR(i2s_new_channel(&chan_cfg, &s_tx, &s_rx), TAG, "i2s channel");
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(BOARD_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {.mclk = I2S_MCLK, .bclk = I2S_BCLK, .ws = I2S_WS, .dout = I2S_DOUT, .din = I2S_DIN},
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_tx, &std_cfg), TAG, "i2s tx");
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_rx, &std_cfg), TAG, "i2s rx");
    ESP_RETURN_ON_ERROR(i2s_channel_enable(s_tx), TAG, "i2s tx enable");
    return i2s_channel_enable(s_rx);
}

static esp_err_t mic_init(void)
{
    audio_codec_i2s_cfg_t i2s_cfg = {.port = I2S_NUM_1, .rx_handle = s_rx};
    audio_codec_i2c_cfg_t i2c_cfg = {.addr = ES7210_CODEC_DEFAULT_ADDR, .bus_handle = s_i2c};
    es7210_codec_cfg_t es7210_cfg = {
        .ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg),
        .mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC2 | ES7210_SEL_MIC3 | ES7210_SEL_MIC4,
    };
    esp_codec_dev_cfg_t dev_cfg = {
        .codec_if = es7210_codec_new(&es7210_cfg),
        .data_if = audio_codec_new_i2s_data(&i2s_cfg),
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
    };
    s_mic = esp_codec_dev_new(&dev_cfg);
    ESP_RETURN_ON_FALSE(s_mic, ESP_FAIL, TAG, "es7210");
    // 2 x 32-bit slots carry 4 x 16-bit ES7210 channels.
    esp_codec_dev_sample_info_t fs = {.sample_rate = BOARD_SAMPLE_RATE, .channel = 2, .bits_per_sample = 32};
    ESP_RETURN_ON_FALSE(esp_codec_dev_open(s_mic, &fs) == ESP_CODEC_DEV_OK, ESP_FAIL, TAG, "mic open");
    for (int ch = 0; ch < BOARD_MIC_CHANNELS; ch++) {
        esp_codec_dev_set_in_channel_gain(s_mic, ESP_CODEC_DEV_MAKE_CHANNEL_MASK(ch), MIC_GAIN_DB);
    }
    return ESP_OK;
}

static esp_err_t speaker_init(void)
{
    audio_codec_i2s_cfg_t i2s_cfg = {.port = I2S_NUM_1, .tx_handle = s_tx};
    audio_codec_i2c_cfg_t i2c_cfg = {.addr = ES8311_CODEC_DEFAULT_ADDR, .bus_handle = s_i2c};
    es8311_codec_cfg_t es8311_cfg = {
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg),
        .gpio_if = audio_codec_new_gpio(),
        .pa_pin = -1,  // amp is behind the IO expander, driven by board_speaker_enable()
        .use_mclk = false,
    };
    esp_codec_dev_cfg_t dev_cfg = {
        .codec_if = es8311_codec_new(&es8311_cfg),
        .data_if = audio_codec_new_i2s_data(&i2s_cfg),
        .dev_type = ESP_CODEC_DEV_TYPE_OUT,
    };
    s_speaker = esp_codec_dev_new(&dev_cfg);
    ESP_RETURN_ON_FALSE(s_speaker, ESP_FAIL, TAG, "es8311");
    esp_codec_dev_sample_info_t fs = {.sample_rate = BOARD_SAMPLE_RATE, .channel = 2, .bits_per_sample = 32};
    ESP_RETURN_ON_FALSE(esp_codec_dev_open(s_speaker, &fs) == ESP_CODEC_DEV_OK, ESP_FAIL, TAG, "speaker open");
    esp_codec_dev_set_out_vol(s_speaker, CONFIG_AAI_VOLUME);
    return ESP_OK;
}

static void amp_off(void) { esp_io_expander_set_level(s_expander, EXIO_SPEAKER_AMP, 0); }

esp_err_t board_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = I2C_SDA,
        .scl_io_num = I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_cfg, &s_i2c), TAG, "i2c");
    ESP_RETURN_ON_ERROR(
        esp_io_expander_new_i2c_tca95xx_16bit(s_i2c, ESP_IO_EXPANDER_I2C_TCA9555_ADDRESS_000, &s_expander), TAG,
        "tca9555");
    // The expander keeps its state across ESP32 resets, so the amp may still be on
    // from before the reset; force it off before the I2S clocks start.
    // (The driver only accepts levels on outputs, so direction goes first.)
    ESP_RETURN_ON_ERROR(esp_io_expander_set_dir(s_expander, EXIO_SPEAKER_AMP, IO_EXPANDER_OUTPUT), TAG, "exio dir");
    ESP_RETURN_ON_ERROR(esp_io_expander_set_level(s_expander, EXIO_SPEAKER_AMP, 0), TAG, "amp off");
    ESP_RETURN_ON_ERROR(i2s_init(), TAG, "i2s");
    ESP_RETURN_ON_ERROR(mic_init(), TAG, "mic");
    ESP_RETURN_ON_ERROR(speaker_init(), TAG, "speaker");
    esp_register_shutdown_handler(amp_off);  // software resets (panic, esp_restart)
    ESP_LOGI(TAG, "audio board ready");
    return ESP_OK;
}

esp_err_t board_mic_read(int16_t *buf, size_t frames)
{
    int ret = esp_codec_dev_read(s_mic, buf, frames * BOARD_MIC_CHANNELS * sizeof(int16_t));
    return ret == ESP_CODEC_DEV_OK ? ESP_OK : ESP_FAIL;
}

esp_err_t board_speaker_write(const int16_t *pcm, size_t samples)
{
    // Expand mono PCM16 to the bus format: stereo, 32-bit left-justified.
    EXT_RAM_BSS_ATTR static int32_t out[256 * 2];  // CPU-copied into DMA by the I2S driver
    while (samples > 0) {
        size_t n = samples < 256 ? samples : 256;
        for (size_t i = 0; i < n; i++) {
            int32_t s = (int32_t)pcm[i] << 16;
            out[2 * i] = s;
            out[2 * i + 1] = s;
        }
        if (esp_codec_dev_write(s_speaker, out, n * 2 * sizeof(int32_t)) != ESP_CODEC_DEV_OK) {
            return ESP_FAIL;
        }
        pcm += n;
        samples -= n;
    }
    return ESP_OK;
}

void board_speaker_set_volume(int volume) { esp_codec_dev_set_out_vol(s_speaker, volume); }

void board_speaker_enable(bool on) { esp_io_expander_set_level(s_expander, EXIO_SPEAKER_AMP, on); }
