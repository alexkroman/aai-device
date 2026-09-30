import { LOG_KEY, migrateHistory } from "./history.ts";

/** An in-memory stand-in for localStorage. */
function memory(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const LEGACY = [
  {
    kind: "session",
    sessionId: "s1",
    run: 0,
    at: 1,
    clientId: "speaker-1",
    items: [
      { kind: "message", role: "user", text: "remind me at five" },
      { kind: "tool", name: "remind_me", args: '{"at":"17:00"}', done: true },
      { kind: "message", role: "assistant", text: "Okay, at 5 PM." },
    ],
  },
  { kind: "note", at: 2, text: "New session" },
  { kind: "spoken", at: 3, text: "Time to call the plumber." },
  // Written before `run` existed, with a tool call that never finished.
  {
    kind: "session",
    sessionId: "s2",
    at: 4,
    items: [{ kind: "tool", name: "web_search", args: "{}", done: false }],
  },
  { kind: "bogus" },
];

test("the old history moves into the new log's format, and the old key goes", () => {
  const store = memory({ "aai-device:history": JSON.stringify(LEGACY) });
  migrateHistory(store);
  expect(store.data.has("aai-device:history")).toBe(false);
  expect(JSON.parse(store.data.get(LOG_KEY) as string)).toEqual([
    {
      kind: "session",
      sessionId: "s1",
      run: 0,
      at: 1,
      clientId: "speaker-1",
      items: [
        { kind: "message", message: { id: 0, role: "user", content: "remind me at five" } },
        {
          kind: "tool",
          toolCall: {
            callId: "legacy-1",
            name: "remind_me",
            args: { at: "17:00" },
            status: "done",
            seq: 1,
            afterMessageId: -1,
          },
        },
        { kind: "message", message: { id: 2, role: "assistant", content: "Okay, at 5 PM." } },
      ],
    },
    { kind: "note", at: 2, text: "New session" },
    { kind: "spoken", at: 3, text: "Time to call the plumber." },
    {
      kind: "session",
      sessionId: "s2",
      run: 0,
      at: 4,
      items: [
        {
          kind: "tool",
          toolCall: {
            callId: "legacy-0",
            name: "web_search",
            args: {},
            status: "pending",
            seq: 0,
            afterMessageId: -1,
          },
        },
      ],
    },
  ]);
});

test("the old history goes ahead of anything the new log already holds", () => {
  const newer = { kind: "note", at: 10, text: "Continuing an earlier conversation" };
  const store = memory({
    "aai-device:history": JSON.stringify([{ kind: "note", at: 1, text: "New session" }]),
    [LOG_KEY]: JSON.stringify([newer]),
  });
  migrateHistory(store);
  expect(JSON.parse(store.data.get(LOG_KEY) as string)).toEqual([
    { kind: "note", at: 1, text: "New session" },
    newer,
  ]);
});

test("nothing to carry over leaves storage alone", () => {
  const store = memory({ [LOG_KEY]: "[]" });
  migrateHistory(store);
  expect([...store.data]).toEqual([[LOG_KEY, "[]"]]);
  expect(() => migrateHistory(undefined)).not.toThrow();
});

test("an unreadable old history is dropped, not thrown on", () => {
  const store = memory({ "aai-device:history": "{not json" });
  migrateHistory(store);
  expect(store.data.has("aai-device:history")).toBe(false);
  expect(store.data.get(LOG_KEY)).toBe("[]");
});
