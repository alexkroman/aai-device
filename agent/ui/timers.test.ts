import { addTimer, cancelTimers, popDue, TIMERS_MAX, type Timer } from "./timers.ts";

// The same cases as firmware test/host/test_timers.c: the page must ring when the device would.

function running(...labels: string[]): Timer[] {
  let ts: Timer[] = [];
  for (const label of labels) ts = addTimer(ts, 0, 60, label) ?? ts;
  return ts;
}

test("drops a timer past TIMERS_MAX", () => {
  const full = running(...Array.from({ length: TIMERS_MAX }, (_, i) => `t${i}`));
  expect(full).toHaveLength(TIMERS_MAX);
  expect(addTimer(full, 0, 60, "one more")).toBeNull();
});

test("no label cancels every timer", () => {
  expect(cancelTimers(running("pasta", "eggs"))).toEqual([]);
});

test("a label cancels its timers, ignoring case", () => {
  expect(cancelTimers(running("Pasta", "eggs"), "pasta").map((t) => t.label)).toEqual(["eggs"]);
});

test("an unmatched label cancels the only timer running, and nothing when there are more", () => {
  expect(cancelTimers(running("pasta"), "spaghetti")).toEqual([]);
  expect(cancelTimers(running("pasta", "eggs"), "spaghetti")).toHaveLength(2);
});

test("a timer is due at its time, not before", () => {
  const ts = addTimer([], 1000, 5, "tea") ?? [];
  expect(popDue(ts, 5999).due).toEqual([]);
  const { due, left } = popDue(ts, 6000);
  expect(due.map((t) => t.label)).toEqual(["tea"]);
  expect(left).toEqual([]);
});
