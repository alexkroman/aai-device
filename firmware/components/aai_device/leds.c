#include "leds.h"

#include "board.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "led_strip.h"

#define SPIN_PERIOD_MS 70  // one LED step; ~0.5 s per revolution of the 7-LED ring

static led_strip_handle_t s_strip;
static SemaphoreHandle_t s_lock;  // leds_set() (event loop) vs the spin timer
static esp_timer_handle_t s_spin_timer;
static leds_state_t s_state = -1;
static unsigned s_spin_pos;

static const uint8_t k_colors[][3] = {
    [LEDS_OFF] = {0, 0, 0},        [LEDS_BOOTING] = {24, 24, 24}, [LEDS_CONNECTING] = {8, 8, 8},
    [LEDS_LISTENING] = {0, 0, 40}, [LEDS_THINKING] = {28, 0, 40}, [LEDS_SPEAKING] = {0, 30, 30},
    [LEDS_ERROR] = {40, 0, 0},     [LEDS_ALARM] = {48, 16, 0},
};

static void fill(const uint8_t rgb[3])
{
    for (int i = 0; i < BOARD_LED_COUNT; i++) {
        led_strip_set_pixel(s_strip, i, rgb[0], rgb[1], rgb[2]);
    }
    led_strip_refresh(s_strip);
}

// States shown as a comet chasing around the ring, in the state's color.
static bool spins(leds_state_t state) { return state == LEDS_BOOTING || state == LEDS_THINKING || state == LEDS_ALARM; }

static void spin_step(void *arg)
{
    // A bright head with a two-LED fading tail, chasing around the ring.
    static const uint8_t k_tail[] = {100, 35, 10};  // percent brightness: head, tail...
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (spins(s_state)) {
        const uint8_t *c = k_colors[s_state];
        for (int i = 0; i < BOARD_LED_COUNT; i++) {
            unsigned behind = (s_spin_pos + BOARD_LED_COUNT - i) % BOARD_LED_COUNT;
            unsigned pct = behind < sizeof(k_tail) ? k_tail[behind] : 0;
            led_strip_set_pixel(s_strip, i, c[0] * pct / 100, c[1] * pct / 100, c[2] * pct / 100);
        }
        led_strip_refresh(s_strip);
        s_spin_pos = (s_spin_pos + 1) % BOARD_LED_COUNT;
    }
    xSemaphoreGive(s_lock);
}

void leds_init(void)
{
    led_strip_config_t strip_cfg = {
        .strip_gpio_num = BOARD_LED_GPIO,
        .max_leds = BOARD_LED_COUNT,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    led_strip_rmt_config_t rmt_cfg = {.resolution_hz = 10 * 1000 * 1000};
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip));
    s_lock = xSemaphoreCreateMutex();
    esp_timer_create_args_t timer_args = {.callback = spin_step, .name = "leds_spin"};
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &s_spin_timer));
    leds_set(LEDS_OFF);
}

void leds_set(leds_state_t state)
{
    bool started = false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (state != s_state) {
        bool was_spinning = spins(s_state);
        s_state = state;
        if (spins(state)) {
            s_spin_pos = 0;
            if (!was_spinning) {
                esp_timer_start_periodic(s_spin_timer, SPIN_PERIOD_MS * 1000);
            }
            started = true;
        } else {
            if (was_spinning) {
                esp_timer_stop(s_spin_timer);
            }
            fill(k_colors[state]);
        }
    }
    xSemaphoreGive(s_lock);
    // First frame now, not one period later — and only on a change: on_tick() re-sets the
    // state every 100 ms, and an extra frame per call made the comet lurch ahead.
    if (started) {
        spin_step(NULL);
    }
}
