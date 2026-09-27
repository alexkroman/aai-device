#include "aai_events.h"

#include "esp_log.h"
#include "esp_timer.h"

ESP_EVENT_DEFINE_BASE(AAI_EVENT);

static const char *TAG = "aai_events";
static esp_event_loop_handle_t s_loop;

esp_event_loop_handle_t aai_events_loop(void)
{
    if (!s_loop) {
        esp_event_loop_args_t args = {
            .queue_size = 16,
            .task_name = "aai_events",
            .task_priority = 5,
            .task_stack_size = 6144,
            .task_core_id = tskNO_AFFINITY,
        };
        ESP_ERROR_CHECK(esp_event_loop_create(&args, &s_loop));
    }
    return s_loop;
}

void aai_events_post(aai_event_id_t id, const void *data, size_t size)
{
    // Never block the poster (AFE and websocket tasks are real-time); drop if full.
    if (esp_event_post_to(aai_events_loop(), AAI_EVENT, id, data, size, 0) != ESP_OK) {
        ESP_LOGW(TAG, "event %d dropped: queue full", id);
    }
}

esp_err_t aai_events_register(esp_event_handler_t handler, void *arg)
{
    return esp_event_handler_register_with(aai_events_loop(), AAI_EVENT, ESP_EVENT_ANY_ID, handler, arg);
}

static void tick(void *arg) { aai_events_post(AAI_EVENT_TICK, NULL, 0); }

void aai_events_start_tick(int period_ms)
{
    esp_timer_handle_t timer;
    esp_timer_create_args_t args = {.callback = tick, .name = "aai_tick"};
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, (uint64_t)period_ms * 1000));
}
