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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { ensureComposioWebhook } from "@alexkroman1/aai/experimental";

const agentDir = fileURLToPath(new URL(".", import.meta.url));
const envPath = `${agentDir}.env`;
// The linked SDK's CLI, as `pnpm exec aai` would resolve it.
const aaiBin = fileURLToPath(
  new URL("./node_modules/@alexkroman1/aai-cli/bin.mjs", import.meta.url),
);

const base = process.argv[2]?.replace(/\/+$/, "");
if (!(base && /^https:\/\//.test(base))) {
  console.error("usage: composio-webhook.mjs https://<public host of this agent>");
  process.exit(2);
}
const webhookUrl = `${base}/api/composio/webhook`;

const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
const key = process.env.COMPOSIO_API_KEY?.trim() || env.COMPOSIO_API_KEY?.trim();
if (!key) {
  console.error("COMPOSIO_API_KEY is not set in agent/.env");
  process.exit(1);
}

// The SDK's ensureComposioWebhook: the project's one subscription created, or moved to
// this URL, with V3 payloads and trigger events on; it answers the signing secret.
const sub = await ensureComposioWebhook({ env: { COMPOSIO_API_KEY: key } }, webhookUrl);

// On stdin, never argv, so the secret stays out of the process list.
execFileSync(process.execPath, [aaiBin, "secret", "put", "--local", "COMPOSIO_WEBHOOK_SECRET"], {
  cwd: agentDir,
  input: sub.secret,
  stdio: ["pipe", "ignore", "inherit"],
});
console.log(`Composio delivers trigger events to ${webhookUrl}; its secret is in agent/.env.`);
