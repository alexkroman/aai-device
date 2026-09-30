import { installFetchRoutes } from "@alexkroman1/aai/testing/vitest";
import {
  findTriggers,
  MAX_FOUND_TRIGGERS,
  MAX_WATCHES,
  unwatch,
  WatchLimit,
  watch,
  watchFor,
} from "./watches.ts";

// The webhook's signature check and its redelivery dedupe are the SDK's
// (composioWebhookRoute, the run's dedupe key), as are the Composio calls (composio()); these pin what is the device's: an event counts only for a watch
// a speaker asked for and owns, a speaker can only stop its own watches, and what the
// judge and the worker are handed.

const ctx = {
  env: {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_SECRET_KEY: "sb-test",
    COMPOSIO_API_KEY: "ak_test",
  },
};

const watchRow = {
  trigger_id: "ti_1",
  client_id: "kitchen",
  app: "gmail",
  trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
  instruction: "an email from Sam",
  created_at: "2026-09-29T00:00:00Z",
};

test("an event counts only for a watch owned by the user it names", async () => {
  installFetchRoutes({
    "GET supabase.test": (req) => ({
      body: req.searchParams.get("trigger_id") === "eq.ti_1" ? [watchRow] : [],
    }),
  });
  const event = (user: string, trigger = "ti_1") => ({
    id: "msg_1",
    type: "composio.trigger.message",
    metadata: { trigger_id: trigger, user_id: user },
  });
  expect(await watchFor(ctx, event("kitchen"))).toEqual(watchRow);
  expect(await watchFor(ctx, event("bedroom"))).toBeUndefined();
  expect(await watchFor(ctx, event("kitchen", "ti_other"))).toBeUndefined();
});

test("a speaker can only stop its own watches", async () => {
  // Only kitchen has a watch.
  const net = installFetchRoutes({
    "GET supabase.test": (req) => ({
      body: req.searchParams.get("client_id") === "eq.kitchen" ? [watchRow] : [],
    }),
    "DELETE supabase.test": { status: 204 },
    "DELETE backend.composio.dev": { body: {} },
  });
  expect(await unwatch(ctx, "bedroom", "ti_1")).toBe(false);
  expect(net.hits.some((h) => h.method === "DELETE")).toBe(false);
  expect(await unwatch(ctx, "kitchen", "ti_1")).toBe(true);
  expect(net.hits.filter((h) => h.method === "DELETE").map((h) => h.pathname)).toEqual([
    "/api/v3.1/trigger_instances/manage/ti_1",
    "/rest/v1/app_watches",
  ]);
});

test("a trigger Composio already lost still loses its row", async () => {
  const net = installFetchRoutes({
    "GET supabase.test": { body: [watchRow] },
    "DELETE supabase.test": { status: 204 },
    "DELETE backend.composio.dev": { status: 404, body: { error: { message: "not found" } } },
  });
  expect(await unwatch(ctx, "kitchen", "ti_1")).toBe(true);
  expect(net.to("DELETE supabase.test")).toHaveLength(1);
});

test("a speaker at its limit starts no new trigger", async () => {
  const net = installFetchRoutes({
    "GET supabase.test": { body: Array.from({ length: MAX_WATCHES }, () => watchRow) },
  });
  await expect(
    watch(ctx, "kitchen", {
      app: "gmail",
      trigger: "GMAIL_NEW_GMAIL_MESSAGE",
      config: {},
      instruction: "an email from Sam",
    }),
  ).rejects.toBeInstanceOf(WatchLimit);
  expect(net.to("backend.composio.dev")).toEqual([]);
});

test("the triggers offered are the ones that can be set up by voice", async () => {
  const net = installFetchRoutes({
    "GET backend.composio.dev": {
      body: {
        items: [
          {
            slug: "GMAIL_NEW_GMAIL_MESSAGE",
            name: "New email",
            description: "A new   email arrived",
            type: "poll",
            config: {
              properties: { labelIds: { type: "string", description: "Label" }, interval: {} },
              required: ["labelIds"],
            },
          },
          {
            slug: "SLACK_RECEIVE_MESSAGE",
            name: "Message",
            description: "Needs a hand-registered webhook",
            type: "webhook",
            config: {},
            requires_webhook_endpoint_setup: true,
          },
        ],
      },
    },
  });
  expect(await findTriggers(ctx, "gmail")).toEqual([
    {
      trigger: "GMAIL_NEW_GMAIL_MESSAGE",
      name: "New email",
      description: "A new email arrived",
      polled: true,
      config: [
        { name: "labelIds", type: "string", required: true, description: "Label" },
        { name: "interval", type: "any", required: false },
      ],
    },
  ]);
  expect(net.hits[0]?.searchParams.get("toolkit_slugs")).toBe("gmail");
});

test("at most MAX_FOUND_TRIGGERS are offered", async () => {
  const item = (n: number) => ({ slug: `APP_EVENT_${n}`, name: `Event ${n}`, config: {} });
  installFetchRoutes({
    "GET backend.composio.dev": { body: { items: Array.from({ length: 20 }, (_, n) => item(n)) } },
  });
  expect(await findTriggers(ctx, "app")).toHaveLength(MAX_FOUND_TRIGGERS);
});
