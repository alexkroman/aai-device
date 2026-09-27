idf_component_register(
    SRCS "main.c"
    REQUIRES aai_device esp_timer esp_event
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Werror -Wall -Wextra -Wshadow -Wformat=2)
