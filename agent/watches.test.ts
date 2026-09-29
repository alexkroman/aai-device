import { afterEach, vi } from "vitest";
import {
  eventText,
  firstDelivery,
  MAX_EVENT_CHARS,
  unwatch,
  verifyWebhook,
  WEBHOOK_TOLERANCE_S,
  watchFor,
} from "./watches.ts";

// The webhook is the one route a stranger can reach, so these pin what it trusts: only a
// delivery signed with the secret over its exact bytes, only recently, only for a trigger
// a speaker asked for and owned by the user it names, and only once.

const ctx = {
  env: {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_SECRET_KEY: "sb-test",
    COMPOSIO_API_KEY: "ak_test",
  },
};

afterEach(() => vi.unstubAllGlobals());

async function sign(secret: string, id: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)),
  );
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

describe("verifyWebhook", () => {
  const secret = "whsec_test";
  const now = 1_800_000_000;
  const ts = String(now);
  // Spacing and key order JSON.stringify(JSON.parse(body)) would not reproduce.
  const body = '{ "type":"composio.trigger.message",  "id":"msg_1" }';

  test("accepts Composio's signature over the raw body", async () => {
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": await sign(secret, "msg_1", ts, body),
    };
    expect(await verifyWebhook(secret, headers, body, now)).toBe(true);
  });

  test("refuses a re-serialized body, a wrong secret, and a stale delivery", async () => {
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": await sign(secret, "msg_1", ts, body),
    };
    expect(await verifyWebhook(secret, headers, JSON.stringify(JSON.parse(body)), now)).toBe(false);
    expect(await verifyWebhook("other", headers, body, now)).toBe(false);
    expect(await verifyWebhook(secret, headers, body, now + WEBHOOK_TOLERANCE_S + 1)).toBe(false);
    expect(await verifyWebhook(secret, {}, body, now)).toBe(false);
  });

  test("accepts any of several signatures, as during a secret rotation", async () => {
    const good = await sign(secret, "msg_1", ts, body);
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": `v1,bm9wZQ== ${good}`,
    };
    expect(await verifyWebhook(secret, headers, body, now)).toBe(true);
  });
});

const watchRow = {
  trigger_id: "ti_1",
  client_id: "kitchen",
  app: "gmail",
  trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
  instruction: "an email from Sam",
  created_at: "2026-09-29T00:00:00Z",
};

function fake(handler: (url: URL, init: RequestInit) => unknown) {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    return Response.json(handler(u, init) ?? []);
  });
  return calls;
}

test("an event counts only for a watch owned by the user it names", async () => {
  fake((u) => (u.searchParams.get("trigger_id") === "eq.ti_1" ? [watchRow] : []));
  const event = (user: string, trigger = "ti_1") => ({
    id: "msg_1",
    type: "composio.trigger.message",
    metadata: { trigger_id: trigger, user_id: user },
  });
  expect(await watchFor(ctx, event("kitchen"))).toEqual(watchRow);
  expect(await watchFor(ctx, event("bedroom"))).toBeUndefined();
  expect(await watchFor(ctx, event("kitchen", "ti_other"))).toBeUndefined();
});

test("a redelivered event is seen once", async () => {
  const seen = new Set<string>();
  fake((_u, init) => {
    const { event_id } = JSON.parse(String(init.body));
    if (seen.has(event_id)) return [];
    seen.add(event_id);
    return [{ event_id }];
  });
  expect(await firstDelivery(ctx, "msg_1", "ti_1")).toBe(true);
  expect(await firstDelivery(ctx, "msg_1", "ti_1")).toBe(false);
});

test("a speaker can only stop its own watches", async () => {
  // Supabase answers rows (only kitchen has one); Composio answers an object.
  const calls = fake((u) =>
    u.host !== "supabase.test"
      ? {}
      : u.searchParams.get("client_id") === "eq.kitchen"
        ? [watchRow]
        : [],
  );
  expect(await unwatch(ctx, "bedroom", "ti_1")).toBe(false);
  expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  expect(await unwatch(ctx, "kitchen", "ti_1")).toBe(true);
  expect(calls.filter((c) => c.init.method === "DELETE").map((c) => c.url.pathname)).toEqual([
    "/api/v3.1/trigger_instances/manage/ti_1",
    "/rest/v1/app_watches",
  ]);
});

test("an event is handed to the judge compacted and capped", () => {
  const text = eventText({ from: "Sam", html: "<p>".repeat(10_000), empty: null });
  expect(text.length).toBeLessThanOrEqual(MAX_EVENT_CHARS);
  expect(text).toContain('"from":"Sam"');
  expect(text).not.toContain("empty");
});
