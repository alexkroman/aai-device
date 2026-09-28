import { createAssembler, parseHeader } from "./inbox.ts";

// The cases firmware inbox.c handles: the page must answer the agent as the device would.

const header = (id: string, bytes: number, extra: object = {}) =>
  JSON.stringify({ type: "notice", id, event: "reminder", bytes, ...extra });

test("refuses what proto_parse_notice refuses", () => {
  expect(parseHeader("not json")).toBeUndefined();
  expect(
    parseHeader(JSON.stringify({ type: "other", id: "a", event: "e", bytes: 0 })),
  ).toBeUndefined();
  expect(parseHeader(header("", 0))).toBeUndefined();
  expect(parseHeader(header("a", 3))).toBeUndefined(); // odd: not PCM16
  expect(parseHeader(header("a", 60 * 16_000 * 2 + 2))).toBeUndefined();
  expect(parseHeader(header("a", 4, { data: { text: "x" } }))).toMatchObject({
    data: { text: "x" },
  });
});

test("assembles audio across frames and acks at the end", () => {
  const a = createAssembler(() => false);
  expect(a.text(header("r1", 4, { data: { text: "call the plumber" } }))).toBeUndefined();
  expect(a.bytes(new Uint8Array([1, 2]))).toBeUndefined();
  const out = a.bytes(new Uint8Array([3, 4, 9, 9])); // past `bytes` is dropped
  expect(out?.reply).toEqual({ type: "ack", id: "r1" });
  expect([...(out?.notice?.pcm ?? [])]).toEqual([1, 2, 3, 4]);
  expect(out?.notice?.data).toEqual({ text: "call the plumber" });
});

test("mid-conversation it answers busy and drops the audio", () => {
  const a = createAssembler(() => true);
  expect(a.text(header("r1", 2))).toEqual({ reply: { type: "busy", id: "r1" } });
  expect(a.bytes(new Uint8Array([1, 2]))).toBeUndefined();
});

test("a redelivery after a lost ack is acked, not played again", () => {
  const a = createAssembler(() => false);
  a.text(header("r1", 2));
  expect(a.bytes(new Uint8Array([1, 2]))?.notice).toBeDefined();
  a.text(header("r1", 2));
  const again = a.bytes(new Uint8Array([1, 2]));
  expect(again).toEqual({ reply: { type: "ack", id: "r1" } });
});

test("a repeat is acked even while busy, so it stops being resent", () => {
  let busy = false;
  const a = createAssembler(() => busy);
  a.text(header("r1", 0));
  busy = true;
  expect(a.text(header("r1", 0))).toEqual({ reply: { type: "ack", id: "r1" } });
});

test("a header mid-notice cuts the last one short, unacked", () => {
  const a = createAssembler(() => false);
  a.text(header("r1", 4));
  a.bytes(new Uint8Array([1, 2]));
  a.text(header("r2", 2));
  expect(a.bytes(new Uint8Array([5, 6]))?.reply).toEqual({ type: "ack", id: "r2" });
});
