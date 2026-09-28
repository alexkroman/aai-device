#pragma once

// Countdown timers the agent sets (agent/tools/set_timer.ts). They live on the device, not
// the agent: the session closes seconds after a reply, and a timer on the server would have
// no connection left to ring through. Pure (no ESP-IDF APIs), so it can be unit-tested on
// the host; main.c drives it from the event loop's tick.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TIMERS_MAX       4
#define TIMERS_LABEL_MAX 32

typedef struct {
    bool used;
    int64_t due_ms;
    char label[TIMERS_LABEL_MAX];  // may be empty
} timer_slot_t;

typedef struct {
    timer_slot_t slot[TIMERS_MAX];
} timers_t;

// Adds a timer due `seconds` after `now_ms`. Returns false when TIMERS_MAX are running.
bool timers_add(timers_t *t, int64_t now_ms, int seconds, const char *label);

// Cancels the timers whose label matches `label` (case-insensitive). NULL or "" cancels all;
// so does a label matching nothing while exactly one timer runs ("cancel the pasta timer"
// when it was set as "spaghetti"). Returns how many were cancelled.
int timers_cancel(timers_t *t, const char *label);

// Removes one timer due at `now_ms`, copying its label out. Returns false when none is due.
bool timers_pop_due(timers_t *t, int64_t now_ms, char *label, size_t label_len);
