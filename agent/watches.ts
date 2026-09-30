import type { EnvContext } from "@alexkroman1/aai/step";
import { fitToolResult, HttpError } from "@alexkroman1/aai/utils";
import { call } from "./apps.ts";
import { rest } from "./supabase.ts";

// "Tell me when Sam emails", "let me know when a PR is assigned to me": Composio triggers
// (https://docs.composio.dev/docs/triggers). A watch is one trigger instance on the
// speaker's connected account plus the words to judge its events by, since a trigger is
// coarser than what was asked ("a new email", not "a new email from Sam"). Composio POSTs
// each event to the agent's webhook (routes.ts `POST /composio/webhook`), signed; that
// route verifies it (the SDK's webhookRoute), matches it to its watch, and starts an
// appEvent run, which decides whether the event is one they wanted and says it on the
// speaker. A redelivered event is the same run (started with its id as the dedupe key).
//
// Gmail and Calendar triggers POLL: Composio checks every few minutes (up to ~15 on its
// managed auth), so "when Sam emails" is minutes, not seconds.

// --- Finding a trigger, and watching it -------------------------------------------------

type TriggerTypes = {
  items: {
    slug: string;
    name: string;
    description: string;
    type: "webhook" | "poll";
    config: {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    requires_webhook_endpoint_setup?: boolean;
  }[];
};

export type FoundTrigger = {
  trigger: string;
  name: string;
  description: string;
  /** Composio polls for it (minutes) rather than being pushed it (seconds). */
  polled: boolean;
  config: { name: string; type: string; required: boolean; description?: string }[];
};

/** Most trigger types handed the model for one app. */
export const MAX_FOUND_TRIGGERS = 8;

/** The events an app can tell the speaker about. */
export async function findTriggers(ctx: EnvContext, app: string): Promise<FoundTrigger[]> {
  const q = new URLSearchParams({ toolkit_slugs: app, limit: "50" });
  const { items } = await call<TriggerTypes>(ctx, "GET", `/triggers_types?${q}`);
  return (
    items
      // One that needs a webhook registered with the provider by hand (a custom OAuth
      // app's Slack events, say) can't be set up by voice.
      .filter((t) => !t.requires_webhook_endpoint_setup)
      .slice(0, MAX_FOUND_TRIGGERS)
      .map((t) => {
        const required = new Set(t.config.required ?? []);
        return {
          trigger: t.slug,
          name: t.name,
          description: t.description.replace(/\s+/g, " ").slice(0, 200),
          polled: t.type === "poll",
          config: Object.entries(t.config.properties ?? {}).map(([name, p]) => ({
            name,
            type: p.type ?? "any",
            required: required.has(name),
            ...(p.description ? { description: p.description.slice(0, 120) } : {}),
          })),
        };
      })
  );
}

export type Watch = {
  trigger_id: string;
  client_id: string;
  app: string;
  trigger_slug: string;
  instruction: string;
  created_at: string;
};

/** Most watches one speaker may hold: each is a trigger polling someone's account. */
export const MAX_WATCHES = 10;

/**
 * Start watching: the trigger on the speaker's connected account (Composio resolves the
 * account from the user), and the watch that says what to listen for.
 */
export async function watch(
  ctx: EnvContext,
  user: string,
  w: { app: string; trigger: string; config: Record<string, unknown>; instruction: string },
): Promise<Watch> {
  if ((await watches(ctx, user)).length >= MAX_WATCHES)
    throw new WatchLimit(`A speaker can watch ${MAX_WATCHES} things at once.`);
  const { trigger_id } = await call<{ trigger_id: string }>(
    ctx,
    "POST",
    `/trigger_instances/${encodeURIComponent(w.trigger)}/upsert`,
    { user_id: user, trigger_config: w.config },
  );
  const row = {
    trigger_id,
    client_id: user,
    app: w.app,
    trigger_slug: w.trigger,
    instruction: w.instruction,
  };
  // Upserted: the same trigger with the same config is the same Composio instance, and
  // asking again replaces what it listens for.
  const [saved] = await rest<Watch[]>(ctx, "/app_watches?on_conflict=trigger_id", {
    method: "POST",
    body: row,
    prefer: "resolution=merge-duplicates,return=representation",
  });
  return saved ?? { ...row, created_at: new Date().toISOString() };
}

export class WatchLimit extends Error {}

/** A speaker's watches, oldest first. */
export async function watches(ctx: EnvContext, user: string): Promise<Watch[]> {
  return await rest<Watch[]>(
    ctx,
    `/app_watches?client_id=eq.${encodeURIComponent(user)}&order=created_at.asc`,
  );
}

/**
 * Stop one: the trigger at Composio, then the row. Only a watch of THIS speaker, so a
 * page can't stop another's. A trigger Composio already lost (404) still loses its row.
 */
export async function unwatch(ctx: EnvContext, user: string, triggerId: string): Promise<boolean> {
  const mine = (await watches(ctx, user)).some((w) => w.trigger_id === triggerId);
  if (!mine) return false;
  try {
    await call(ctx, "DELETE", `/trigger_instances/manage/${encodeURIComponent(triggerId)}`);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
  }
  await rest(ctx, `/app_watches?trigger_id=eq.${encodeURIComponent(triggerId)}`, {
    method: "DELETE",
  });
  return true;
}

// --- The webhook ------------------------------------------------------------------------

/** A trigger event as Composio's V3 payload carries it. */
export type TriggerEvent = {
  id: string;
  type: string;
  metadata?: { trigger_id?: string; trigger_slug?: string; user_id?: string };
  data?: unknown;
};

/** Most of an event handed to the model that judges it: the rest is HTML and headers. */
export const MAX_EVENT_CHARS = 3000;

/** The event, as the text the judging model reads. */
export function eventText(data: unknown): string {
  const fitted = fitToolResult(data ?? {}, { maxChars: MAX_EVENT_CHARS, maxString: 800 });
  return JSON.stringify(fitted ?? {}).slice(0, MAX_EVENT_CHARS);
}

/**
 * The watch an event is for, or undefined when it is none of ours: its trigger must be
 * one a speaker asked for, owned by the user Composio says the event is for.
 */
export async function watchFor(ctx: EnvContext, event: TriggerEvent): Promise<Watch | undefined> {
  const triggerId = event.metadata?.trigger_id;
  if (!triggerId) return undefined;
  const [w] = await rest<Watch[]>(
    ctx,
    `/app_watches?trigger_id=eq.${encodeURIComponent(triggerId)}`,
  );
  return w && w.client_id === event.metadata?.user_id ? w : undefined;
}
