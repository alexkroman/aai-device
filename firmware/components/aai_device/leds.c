#include "leds.h"

#include "board.h"
#include "led_strip.h"

static led_strip_handle_t s_strip;
static leds_state_t s_state = -1;

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
    leds_set(LEDS_OFF);
}

void leds_set(leds_state_t state)
{
    static const uint8_t colors[][3] = {
        [LEDS_OFF] = {0, 0, 0},        [LEDS_CONNECTING] = {8, 8, 8}, [LEDS_LISTENING] = {0, 0, 40},
        [LEDS_SPEAKING] = {0, 30, 30}, [LEDS_ERROR] = {40, 0, 0},
    };
    if (state == s_state) {
        return;
    }
    s_state = state;
    for (int i = 0; i < BOARD_LED_COUNT; i++) {
        led_strip_set_pixel(s_strip, i, colors[state][0], colors[state][1], colors[state][2]);
    }
    led_strip_refresh(s_strip);
}
