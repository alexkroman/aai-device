idf_component_register(
    SRCS "board.c" "voice.c" "agent.c" "protocol.c" "leds.c" "wifi.c" "aai_events.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_i2s esp_driver_i2c esp_timer esp_event
    PRIV_REQUIRES esp_wifi nvs_flash esp_netif esp_event
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Werror -Wall -Wextra -Wshadow -Wformat=2)
