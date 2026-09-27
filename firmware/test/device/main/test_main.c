#include "test_support.h"
#include "unity.h"
#include "unity_test_runner.h"

void app_main(void)
{
    // Do every one-time allocation before the first test, so the per-test leak
    // check in tearDown() only sees what a test itself leaves behind.
    test_agent_init();  // board + AFE + agent tasks + websocket client
    test_wifi_init();
    test_warm_up_network();  // first TCP/websocket session allocates lwIP state for good
    unity_run_menu();
}
