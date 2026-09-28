idf_component_register(
    SRCS "board.c" "voice.c" "agent.c" "protocol.c" "resample.c" "leds.c" "wifi.c" "aai_events.c" "timers.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_i2s esp_driver_i2c esp_timer esp_event
    PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event lwip
    # Blurt cues as raw 16 kHz mono PCM16LE: the default start cue (rom1a-6-start.wav) and,
    # for timers, juno-78-start.wav.
    EMBED_FILES "sounds/wake_chime.pcm" "sounds/timer_alarm.pcm"
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Werror -Wall -Wextra -Wshadow -Wformat=2)
