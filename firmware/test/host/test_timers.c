#include <string.h>
#include "timers.h"
#include "unity.h"

static timers_t t;
static char label[TIMERS_LABEL_MAX];

void setUp(void) { memset(&t, 0, sizeof(t)); }
void tearDown(void) {}

static void test_fires_when_due_not_before(void)
{
    TEST_ASSERT_TRUE(timers_add(&t, 1000, 60, "pasta"));
    TEST_ASSERT_FALSE(timers_pop_due(&t, 60999, label, sizeof(label)));
    TEST_ASSERT_TRUE(timers_pop_due(&t, 61000, label, sizeof(label)));
    TEST_ASSERT_EQUAL_STRING("pasta", label);
    TEST_ASSERT_FALSE(timers_pop_due(&t, 999999, label, sizeof(label)));  // fires once
}

static void test_several_timers_fire_in_turn(void)
{
    TEST_ASSERT_TRUE(timers_add(&t, 0, 30, "eggs"));
    TEST_ASSERT_TRUE(timers_add(&t, 0, 10, "tea"));
    TEST_ASSERT_TRUE(timers_pop_due(&t, 10000, label, sizeof(label)));
    TEST_ASSERT_EQUAL_STRING("tea", label);
    TEST_ASSERT_FALSE(timers_pop_due(&t, 10000, label, sizeof(label)));
    TEST_ASSERT_TRUE(timers_pop_due(&t, 30000, label, sizeof(label)));
    TEST_ASSERT_EQUAL_STRING("eggs", label);
}

static void test_full_rejects_until_a_slot_frees(void)
{
    for (int i = 0; i < TIMERS_MAX; i++) {
        TEST_ASSERT_TRUE(timers_add(&t, 0, 10 + i, NULL));
    }
    TEST_ASSERT_FALSE(timers_add(&t, 0, 5, "one too many"));
    TEST_ASSERT_TRUE(timers_pop_due(&t, 10000, label, sizeof(label)));
    TEST_ASSERT_EQUAL_STRING("", label);  // a NULL label reads back empty
    TEST_ASSERT_TRUE(timers_add(&t, 0, 5, "fits now"));
}

static void test_long_label_truncated(void)
{
    char long_label[100];
    memset(long_label, 'x', sizeof(long_label) - 1);
    long_label[sizeof(long_label) - 1] = '\0';
    TEST_ASSERT_TRUE(timers_add(&t, 0, 1, long_label));
    TEST_ASSERT_TRUE(timers_pop_due(&t, 1000, label, sizeof(label)));
    TEST_ASSERT_EQUAL(TIMERS_LABEL_MAX - 1, strlen(label));
}

static void test_cancel_by_label_ignores_case(void)
{
    timers_add(&t, 0, 10, "Pasta");
    timers_add(&t, 0, 20, "eggs");
    TEST_ASSERT_EQUAL(1, timers_cancel(&t, "pasta"));
    TEST_ASSERT_FALSE(timers_pop_due(&t, 10000, label, sizeof(label)));
    TEST_ASSERT_TRUE(timers_pop_due(&t, 20000, label, sizeof(label)));
    TEST_ASSERT_EQUAL_STRING("eggs", label);
}

static void test_cancel_without_label_cancels_all(void)
{
    timers_add(&t, 0, 10, "a");
    timers_add(&t, 0, 20, "b");
    TEST_ASSERT_EQUAL(2, timers_cancel(&t, ""));
    timers_add(&t, 0, 10, "c");
    TEST_ASSERT_EQUAL(1, timers_cancel(&t, NULL));
    TEST_ASSERT_FALSE(timers_pop_due(&t, 99999, label, sizeof(label)));
}

static void test_cancel_unmatched_label(void)
{
    // One timer running: a label the model paraphrased still means that timer.
    timers_add(&t, 0, 10, "spaghetti");
    TEST_ASSERT_EQUAL(1, timers_cancel(&t, "pasta"));
    TEST_ASSERT_FALSE(timers_pop_due(&t, 99999, label, sizeof(label)));
    // Several running: an unmatched label is ambiguous, so nothing is cancelled.
    timers_add(&t, 0, 10, "a");
    timers_add(&t, 0, 20, "b");
    TEST_ASSERT_EQUAL(0, timers_cancel(&t, "c"));
    // None running: nothing to do.
    memset(&t, 0, sizeof(t));
    TEST_ASSERT_EQUAL(0, timers_cancel(&t, "a"));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_fires_when_due_not_before);
    RUN_TEST(test_several_timers_fire_in_turn);
    RUN_TEST(test_full_rejects_until_a_slot_frees);
    RUN_TEST(test_long_label_truncated);
    RUN_TEST(test_cancel_by_label_ignores_case);
    RUN_TEST(test_cancel_without_label_cancels_all);
    RUN_TEST(test_cancel_unmatched_label);
    return UNITY_END();
}
