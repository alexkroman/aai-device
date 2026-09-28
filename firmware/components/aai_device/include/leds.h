#pragma once

typedef enum {
    LEDS_OFF,
    LEDS_BOOTING,     // white comet spinning until the device is ready for the wake word
    LEDS_CONNECTING,  // dim white
    LEDS_LISTENING,   // blue
    LEDS_THINKING,    // purple comet spinning around the ring (waiting on the agent)
    LEDS_SPEAKING,    // cyan
    LEDS_ERROR,       // red
    LEDS_ALARM,       // orange comet spinning while a timer rings
} leds_state_t;

void leds_init(void);
void leds_set(leds_state_t state);  // thread-safe; no-op if already in `state`
