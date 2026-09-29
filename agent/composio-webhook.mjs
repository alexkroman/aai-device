#!/usr/bin/env node
// Point the Composio project's webhook at this agent, once per public URL:
//
//   make composio-webhook URL=https://speaker.example.com
//
// Composio allows one webhook subscription per project and POSTs every trigger event to
// it (watches.ts). This creates it, or moves it to URL, with V3 payloads, and writes its
// signing secret into agent/.env as COMPOSIO_WEBHOOK_SECRET, which the webhook route
// verifies each delivery with. The secret is never printed.
//
// For a local `make agent` there is no public URL: run
//   composio dev listen --forward http://localhost:3000/api/composio/webhook
// instead, which signs with COMPOSIO_WEBHOOK_SECRET when it is set.
//
// Not a tool (a .mjs, not in tools/), so the agent bundle never sees it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://backend.composio.dev/api/v3.1";
const envPath = fileURLToPath(new URL("./.env", import.meta.url));

const base = process.argv[2]?.replace(/\/+$/, "");
if (!base || !/^https:\/\//.test(base)) {
  console.error("usage: composio-webhook.mjs https://<public host of this agent>");
  process.exit(2);
}
const webhookUrl = `${base}/api/composio/webhook`;

let env = readFileSync(envPath, "utf8");
const key =
  process.env.COMPOSIO_API_KEY?.trim() || env.match(/^COMPOSIO_API_KEY=(.*)$/m)?.[1]?.trim();
if (!key) {
  console.error("COMPOSIO_API_KEY is not set in agent/.env");
  process.exit(1);
}

async function composio(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-api-key": key, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Composio ${res.status}: ${json.error?.message ?? res.statusText}`);
  return json;
}

const want = {
  webhook_url: webhookUrl,
  enabled_events: ["composio.trigger.message"],
  version: "V3",
};
const { items = [] } = await composio("GET", "/webhook_subscriptions");
const sub = items[0]
  ? await composio("PATCH", `/webhook_subscriptions/${encodeURIComponent(items[0].id)}`, want)
  : await composio("POST", "/webhook_subscriptions", want);

const line = `COMPOSIO_WEBHOOK_SECRET=${sub.secret}`;
env = /^COMPOSIO_WEBHOOK_SECRET=.*$/m.test(env)
  ? env.replace(/^COMPOSIO_WEBHOOK_SECRET=.*$/m, line)
  : `${env.trimEnd()}\n${line}\n`;
writeFileSync(envPath, env);
console.log(`Composio delivers trigger events to ${webhookUrl}; its secret is in agent/.env.`);
console.log("Restart `make agent` so the webhook route reads it.");
