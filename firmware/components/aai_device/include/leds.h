#pragma once

typedef enum {
    LEDS_OFF,
    LEDS_CONNECTING,  // dim white
    LEDS_LISTENING,   // blue
    LEDS_SPEAKING,    // cyan
    LEDS_ERROR,       // red
} leds_state_t;

void leds_init(void);
void leds_set(leds_state_t state);
