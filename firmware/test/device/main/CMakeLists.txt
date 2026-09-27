idf_component_register(
    SRCS "test_main.c" "test_support.c" "test_board.c" "test_voice.c" "test_agent.c" "test_playback.c"
    INCLUDE_DIRS "."
    REQUIRES unity aai_device esp_timer
    EMBED_FILES "clips/wake_weather.wav" "clips/hello.wav" "clips/weather.wav"
    WHOLE_ARCHIVE
)
