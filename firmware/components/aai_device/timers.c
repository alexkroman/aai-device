#include "timers.h"

#include <stdio.h>
#include <string.h>
#include <strings.h>

bool timers_add(timers_t *t, int64_t now_ms, int seconds, const char *label)
{
    for (int i = 0; i < TIMERS_MAX; i++) {
        timer_slot_t *s = &t->slot[i];
        if (!s->used) {
            s->used = true;
            s->due_ms = now_ms + (int64_t)seconds * 1000;
            snprintf(s->label, sizeof(s->label), "%s", label ? label : "");
            return true;
        }
    }
    return false;
}

int timers_cancel(timers_t *t, const char *label)
{
    bool all = !label || !label[0];
    int cancelled = 0, running = 0;
    timer_slot_t *only = NULL;
    for (int i = 0; i < TIMERS_MAX; i++) {
        timer_slot_t *s = &t->slot[i];
        if (!s->used) {
            continue;
        }
        running++;
        only = s;
        if (all || strcasecmp(s->label, label) == 0) {
            s->used = false;
            cancelled++;
        }
    }
    if (cancelled == 0 && running == 1) {
        only->used = false;
        cancelled = 1;
    }
    return cancelled;
}

bool timers_pop_due(timers_t *t, int64_t now_ms, char *label, size_t label_len)
{
    for (int i = 0; i < TIMERS_MAX; i++) {
        timer_slot_t *s = &t->slot[i];
        if (s->used && now_ms >= s->due_ms) {
            s->used = false;
            snprintf(label, label_len, "%s", s->label);
            return true;
        }
    }
    return false;
}
