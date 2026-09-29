import {
  addNote,
  addSpoken,
  type Entry,
  type Item,
  MAX_ENTRIES,
  recordSession,
} from "./history.ts";

const user = (text: string): Item => ({ kind: "message", role: "user", text });
const agent = (text: string): Item => ({ kind: "message", role: "assistant", text });

test("a session's conversation replaces its entry as it grows", () => {
  let h: Entry[] = [];
  h = recordSession(h, "s1", [user("hi")], 1);
  h = recordSession(h, "s1", [user("hi"), agent("hello")], 2);
  expect(h).toEqual([
    { kind: "session", sessionId: "s1", run: 0, at: 1, items: [user("hi"), agent("hello")] },
  ]);
});

const texts = (h: Entry[]) =>
  h.map((e) =>
    e.kind === "session"
      ? e.items.map((it) => (it.kind === "message" ? it.text : it.name))
      : e.text,
  );

test("a resume replaying the history does not log it twice, and keeps the order", () => {
  let h = recordSession([], "s1", [user("hi"), agent("hello")], 1);
  h = addNote(h, "Reminder: call the plumber", 2);
  // Reconnected with ?sessionId=s1: history.restored, then a new turn and its reply.
  h = recordSession(h, "s1", [user("hi"), agent("hello")], 3);
  h = recordSession(h, "s1", [user("hi"), agent("hello"), user("and now?")], 4);
  h = recordSession(h, "s1", [user("hi"), agent("hello"), user("and now?"), agent("now this")], 5);
  expect(texts(h)).toEqual([
    ["hi", "hello"],
    "Reminder: call the plumber",
    ["and now?", "now this"],
  ]);
});

test("what the speaker says on its own is its own entry, in order, between turns", () => {
  let h = recordSession([], "s1", [user("summarize slack"), agent("On it.")], 1);
  h = addSpoken(h, "Three things happened in boardroom today.", 2);
  h = recordSession(h, "s1", [user("summarize slack"), agent("On it."), user("thanks")], 3);
  expect(h[1]).toEqual({
    kind: "spoken",
    at: 2,
    text: "Three things happened in boardroom today.",
  });
  expect(texts(h)).toEqual([
    ["summarize slack", "On it."],
    "Three things happened in boardroom today.",
    ["thanks"],
  ]);
});

test("a tool call finishing early in a chain updates it where it is", () => {
  const pending: Item = { kind: "tool", name: "remind_me", args: "{}", done: false };
  let h = recordSession([], "s1", [pending], 1);
  h = addNote(h, "note", 2);
  h = recordSession(h, "s1", [{ ...pending, done: true }, agent("Set.")], 3);
  expect(h[0]).toMatchObject({ items: [{ ...pending, done: true }] });
  expect(texts(h)).toEqual([["remind_me"], "note", ["Set."]]);
});

test("a session the server lost comes back greeting: a new run, not a swallowed replay", () => {
  const hi = agent("Hi, what can I do for you?");
  let h = recordSession(
    [],
    "s1",
    [hi, user("remind me at five"), agent("Done."), user("thanks")],
    1,
  );
  // Same id, fresh server: the greeting again, then a different conversation.
  h = recordSession(h, "s1", [hi, user("pancakes?")], 2);
  expect(texts(h)).toEqual([
    ["Hi, what can I do for you?", "remind me at five", "Done.", "thanks"],
    ["Hi, what can I do for you?", "pancakes?"],
  ]);
});

test("a partial replay mid-reconnect changes nothing", () => {
  const h = recordSession([], "s1", [user("hi"), agent("hello")], 1);
  expect(recordSession(h, "s1", [user("hi")], 2)).toEqual(h);
});

test("a retired session back under the same id starts a new entry instead of wiping the old", () => {
  let h = recordSession([], "s1", [user("hi"), agent("hello")], 1);
  h = recordSession(h, "s1", [user("what time is it")], 2);
  h = recordSession(h, "s1", [user("what time is it"), agent("noon")], 3);
  expect(texts(h)).toEqual([
    ["hi", "hello"],
    ["what time is it", "noon"],
  ]);
});

test("a tool call finishing is the same session", () => {
  const pending: Item = { kind: "tool", name: "remind_me", args: '{"in_seconds":60}', done: false };
  let h = recordSession([], "s1", [pending], 1);
  h = recordSession(h, "s1", [{ ...pending, done: true }, agent("Okay, at 5 PM.")], 2);
  expect(h).toHaveLength(1);
});

test("an empty conversation records nothing", () => {
  expect(recordSession([], "s1", [], 1)).toEqual([]);
});

test("the oldest entries go first past MAX_ENTRIES", () => {
  let h: Entry[] = [];
  for (let i = 0; i <= MAX_ENTRIES; i++) h = addNote(h, `n${i}`, i);
  expect(h).toHaveLength(MAX_ENTRIES);
  expect(h[0]).toMatchObject({ text: "n1" });
});
