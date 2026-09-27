cmake_minimum_required(VERSION 3.16)

# Wi-Fi credentials and agent URL live in sdkconfig.defaults.local (gitignored).
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults.local")
    set(SDKCONFIG_DEFAULTS "sdkconfig.defaults;sdkconfig.defaults.local")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(aai_device)
