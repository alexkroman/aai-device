# On-device Unity tests. Run with pytest (see README.md) or `idf.py flash monitor`.
cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components")
set(SDKCONFIG_DEFAULTS "../../sdkconfig.defaults;sdkconfig.defaults")
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.defaults.local")
    list(APPEND SDKCONFIG_DEFAULTS "../../sdkconfig.defaults.local")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(aai_device_test)
