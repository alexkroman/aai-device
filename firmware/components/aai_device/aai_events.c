#include "aai_events.h"

#include <stdatomic.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"

ESP_EVENT_DEFINE_BASE(AAI_EVENT);

static const char *TAG = "aai_events";
static esp_event_loop_handle_t s_loop;
// A tick is queued and not yet dispatched. Ticks only drive timeouts, so one in flight is
// enough: while a slow handler (agent_stop() closing a socket) holds the loop, they would
// otherwise fill the queue in 1.6 s and push out the events that matter (wake, closed).
static atomic_bool s_tick_pending;

static void tick_dispatched(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    atomic_store(&s_tick_pending, false);
}

static void loop_task(void *arg)
{
    for (;;) {
        esp_event_loop_run(s_loop, portMAX_DELAY);
    }
}

esp_event_loop_handle_t aai_events_loop(void)
{
    if (!s_loop) {
        // No built-in task: esp_event would put its stack in scarce internal RAM, which the
        // websocket client (internal-only stack) needs. Run the loop on a PSRAM-stack task
        // instead; handlers never write flash, so a PSRAM stack is safe.
        esp_event_loop_args_t args = {.queue_size = 16, .task_name = NULL};
        ESP_ERROR_CHECK(esp_event_loop_create(&args, &s_loop));
        // Registered first, so it runs before the app's handler sees the tick.
        ESP_ERROR_CHECK(esp_event_handler_register_with(s_loop, AAI_EVENT, AAI_EVENT_TICK, tick_dispatched, NULL));
        xTaskCreatePinnedToCoreWithCaps(loop_task, "aai_events", 6144, NULL, 5, NULL, tskNO_AFFINITY,
                                        MALLOC_CAP_SPIRAM);
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

static void tick(void *arg)
{
    if (atomic_exchange(&s_tick_pending, true)) {
        return;  // the last one hasn't been handled yet; it will do
    }
    if (esp_event_post_to(aai_events_loop(), AAI_EVENT, AAI_EVENT_TICK, NULL, 0, 0) != ESP_OK) {
        atomic_store(&s_tick_pending, false);  // queue full of real events; try next period
    }
}

void aai_events_start_tick(int period_ms)
{
    esp_timer_handle_t timer;
    esp_timer_create_args_t args = {.callback = tick, .name = "aai_tick"};
    ESP_ERROR_CHECK(esp_timer_create(&args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, (uint64_t)period_ms * 1000));
}
