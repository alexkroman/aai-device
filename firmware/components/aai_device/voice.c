#include "voice.h"

#include <assert.h>
#include <stdatomic.h>
#include "aai_events.h"
#include "agent.h"
#include "board.h"
#include "esp_afe_sr_models.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "model_path.h"
#include "sdkconfig.h"

static const char *TAG = "voice";

static const esp_afe_sr_iface_t *s_afe;
static esp_afe_sr_data_t *s_afe_data;
static voice_source_t s_source;
static atomic_bool s_streaming;

#ifdef CONFIG_AAI_FULL_DUPLEX
static const bool k_full_duplex = true;
#else
static const bool k_full_duplex = false;
#endif

static void feed_task(void *arg)
{
    int chunk = s_afe->get_feed_chunksize(s_afe_data);
    int nch = s_afe->get_feed_channel_num(s_afe_data);
    assert(nch == BOARD_MIC_CHANNELS);
    int16_t *buf = heap_caps_malloc(chunk * nch * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    for (;;) {
        if (s_source) {
            s_source(buf, chunk);
        } else {
            board_mic_read(buf, chunk);
        }
        s_afe->feed(s_afe_data, buf);
    }
}

static void fetch_task(void *arg)
{
    for (;;) {
        afe_fetch_result_t *res = s_afe->fetch(s_afe_data);
        if (!res || res->ret_value == ESP_FAIL) {
            continue;
        }
        if (res->wakeup_state == WAKENET_DETECTED) {
            // When it was heard, so the handler can tell a slow detection from a slow loop.
            int64_t detected_us = esp_timer_get_time();
            ESP_LOGI(TAG, "wake word detected");
            aai_events_post(AAI_EVENT_WAKE, &detected_us, sizeof(detected_us));
        }
        if (s_streaming) {
            size_t samples = res->data_size / sizeof(int16_t);
            if (!k_full_duplex && agent_talking()) {
                // Half duplex: send silence while the agent talks so residual echo
                // can't be transcribed as the user. Keeps the audio clock steady.
                static const int16_t silence[1024];
                agent_push_mic(silence, samples < 1024 ? samples : 1024);
            } else {
                agent_push_mic(res->data, samples);
            }
        }
    }
}

void voice_init(voice_source_t source)
{
    s_source = source;
    srmodel_list_t *models = esp_srmodel_init("model");
    afe_config_t *cfg = afe_config_init(BOARD_MIC_FORMAT, models, AFE_TYPE_SR, AFE_MODE_HIGH_PERF);
    cfg->aec_init = true;   // cancel the agent's own voice using the speaker loopback channel
    cfg->se_init = true;    // 2-mic beamforming
    cfg->vad_init = false;  // turn detection happens server-side
    cfg->wakenet_init = true;
    cfg->memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;
    s_afe = esp_afe_handle_from_config(cfg);
    s_afe_data = s_afe->create_from_config(cfg);
    // DET_MODE_90 (0) is the more sensitive; DET_MODE_95 (1) needs a clearer "Computer".
    ESP_LOGI(TAG, "wake word model: %s, detection mode %d", cfg->wakenet_model_name, (int)cfg->wakenet_mode);
    afe_config_free(cfg);

    xTaskCreatePinnedToCoreWithCaps(feed_task, "afe_feed", 4096, NULL, 10, NULL, 0, MALLOC_CAP_SPIRAM);
    xTaskCreatePinnedToCoreWithCaps(fetch_task, "afe_fetch", 4096, NULL, 10, NULL, 1, MALLOC_CAP_SPIRAM);
}

void voice_set_streaming(bool on) { s_streaming = on; }
