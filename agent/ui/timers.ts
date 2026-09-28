// The browser twin of firmware timers.c, rule for rule, so a timer behaves the same
// whether the agent set it on the speaker or on this page. Pure: the caller owns the clock.

/** firmware timers.h TIMERS_MAX */
export const TIMERS_MAX = 4;
/** firmware timers.h TIMERS_LABEL_MAX, less the NUL */
const LABEL_MAX = 31;

export type Timer = { id: number; dueMs: number; seconds: number; label: string };

let nextId = 1;

/** Null when TIMERS_MAX are already running (the device drops it too). */
export function addTimer(
  timers: readonly Timer[],
  nowMs: number,
  seconds: number,
  label = "",
): Timer[] | null {
  if (timers.length >= TIMERS_MAX) return null;
  return [
    ...timers,
    { id: nextId++, dueMs: nowMs + seconds * 1000, seconds, label: label.slice(0, LABEL_MAX) },
  ];
}

/**
 * No label cancels all; otherwise the ones whose label matches, ignoring case. When
 * nothing matches and exactly one is running, that one goes: "cancel the timer" with
 * a misheard label still means the only timer there is.
 */
export function cancelTimers(timers: readonly Timer[], label?: string): Timer[] {
  if (!label) return [];
  const kept = timers.filter((t) => t.label.toLowerCase() !== label.toLowerCase());
  if (kept.length === timers.length && timers.length === 1) return [];
  return kept;
}

/** Splits off the timers due at `nowMs`. */
export function popDue(timers: readonly Timer[], nowMs: number): { due: Timer[]; left: Timer[] } {
  return {
    due: timers.filter((t) => nowMs >= t.dueMs),
    left: timers.filter((t) => nowMs < t.dueMs),
  };
}
