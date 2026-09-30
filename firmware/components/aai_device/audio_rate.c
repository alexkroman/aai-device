#include "audio_rate.h"

#include <string.h>
#include "esp_ae_rate_cvt.h"
#include "esp_log.h"

static const char *TAG = "audio_rate";

// Highest quality: 24 kHz -> 16 kHz costs ~0.7% of a core at 3 (esp_audio_effects' figures).
#define COMPLEXITY 3

static bool ae_rate(int rate) { return rate > 0 && (rate % 4000 == 0 || rate % 11025 == 0); }

void audio_rate_close(audio_rate_t *r)
{
    if (r->ae) {
        esp_ae_rate_cvt_close(r->ae);
        r->ae = NULL;
    }
}

void audio_rate_open(audio_rate_t *r, int in_rate, int out_rate)
{
    audio_rate_close(r);
    resampler_init(&r->fallback, in_rate, out_rate);
    r->passthrough = in_rate == out_rate;
    if (r->passthrough) {
        return;
    }
    if (ae_rate(in_rate) && ae_rate(out_rate)) {
        esp_ae_rate_cvt_cfg_t cfg = {
            .src_rate = (uint32_t)in_rate,
            .dest_rate = (uint32_t)out_rate,
            .channel = 1,
            .bits_per_sample = 16,
            .complexity = COMPLEXITY,
            .perf_type = ESP_AE_RATE_CVT_PERF_TYPE_MEMORY,  // internal RAM is the scarce resource here
        };
        esp_ae_err_t err = esp_ae_rate_cvt_open(&cfg, &r->ae);
        if (err == ESP_AE_ERR_OK) {
            return;
        }
        r->ae = NULL;
        ESP_LOGW(TAG, "rate converter %d -> %d Hz failed (%d); using linear interpolation", in_rate, out_rate,
                 (int)err);
    } else {
        ESP_LOGW(TAG, "%d -> %d Hz: not a rate the filtered converter takes; using linear interpolation", in_rate,
                 out_rate);
    }
}

size_t audio_rate_max_out(const audio_rate_t *r, size_t n_in)
{
    if (r->passthrough) {
        return n_in;
    }
    uint32_t n = 0;
    if (r->ae && esp_ae_rate_cvt_get_max_out_sample_num(r->ae, (uint32_t)n_in, &n) == ESP_AE_ERR_OK) {
        return n;
    }
    return resampler_max_out(&r->fallback, n_in);
}

size_t audio_rate_process(audio_rate_t *r, int16_t *in, size_t n_in, int16_t *out)
{
    if (n_in == 0) {
        return 0;
    }
    if (r->passthrough) {
        memcpy(out, in, n_in * sizeof(int16_t));
        return n_in;
    }
    if (!r->ae) {
        return resampler_process(&r->fallback, in, n_in, out);
    }
    uint32_t n_out = (uint32_t)audio_rate_max_out(r, n_in);
    if (esp_ae_rate_cvt_process(r->ae, in, (uint32_t)n_in, out, &n_out) != ESP_AE_ERR_OK) {
        return 0;  // a dropped chunk is a click; not worth tearing the stream down over
    }
    return n_out;
}
