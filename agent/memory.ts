import { requireEnv } from "@alexkroman1/aai";
import type { EnvContext } from "@alexkroman1/aai/step";
import { jsonClient } from "@alexkroman1/aai/utils";

// Long-term memory, held by the mem0 platform (https://docs.mem0.ai/api-reference). mem0
// does the part that is hard to get right: given what was said, it decides which lasting
// facts are new, which restate or contradict one it holds, and updates accordingly (its
// ADD / UPDATE / DELETE / NOOP pass). This file is the four calls the speaker makes.
//
// Everything in the home is ONE mem0 user, MEM0_USER_ID: there is no voice ID, so a fact
// said to the kitchen speaker is the household's, and the browser twin reads the same
// memories. Beside agent.ts because tools/ is flat and every file there must be a tool.

export const MEM0_URL = "https://api.mem0.ai";
/** Every speaker and browser in the home shares this mem0 user unless .env names another. */
export const DEFAULT_MEM0_USER = "household";

export type Memory = { id: string; memory: string; updated_at?: string | null };
export type Message = { role: "user" | "assistant"; content: string };

/**
 * What mem0's extraction is told to keep and to leave alone, on every add. A household
 * speaker hears guests, children and half-finished thoughts, and a phone verification
 * code is read aloud to it; none of that is a fact about the home worth keeping.
 */
export const MEMORY_INCLUDES =
  "Lasting facts and preferences about the people and pets in this home: names, " +
  "relationships, allergies and diets, routines, likes and dislikes, and things they " +
  "said they want remembered.";
export const MEMORY_EXCLUDES =
  "Anything the assistant said, suggested or recommended (only what the people in the " +
  "home said about themselves counts); their name, home address and phone number (the " +
  "household profile holds those exactly); health conditions of people, religion, " +
  "politics, finances, passwords, codes and numbers read aloud (verification codes, " +
  "PINs), statements by or about guests, one-off requests and plans (the weather, a " +
  "search, a reminder, going for a walk), passing moods, jokes and hypotheticals, and " +
  "anything they asked not to be remembered.";

function user(ctx: EnvContext): string {
  return ctx.env.MEM0_USER_ID?.trim() || DEFAULT_MEM0_USER;
}

const call = jsonClient({
  label: "mem0",
  baseUrl: MEM0_URL,
  headers: (env) => ({ Authorization: `Token ${requireEnv({ env }, "MEM0_API_KEY")}` }),
});

/**
 * Hand mem0 a conversation (or one sentence to keep) to extract memories from. It
 * answers at once with an event id and does the extraction in the background; poll
 * {@link addStatus} to know it finished.
 */
export function addMemories(
  ctx: EnvContext,
  messages: readonly Message[],
  opts: {
    metadata?: Record<string, string>;
    observedAt?: Date;
    timezone?: string;
    /** false stores the text as written, with no extraction: a memory typed in the page. */
    infer?: boolean;
  } = {},
): Promise<{ event_id?: string; status?: string }> {
  return call(ctx, "POST", "/v3/memories/add/", {
    messages,
    user_id: user(ctx),
    ...(opts.infer === false ? { infer: false } : {}),
    includes: MEMORY_INCLUDES,
    excludes: MEMORY_EXCLUDES,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    ...(opts.observedAt ? { observation_datetime: opts.observedAt.toISOString() } : {}),
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
  });
}

/** Where a background add got to: PENDING, then SUCCEEDED or FAILED. */
export async function addStatus(ctx: EnvContext, eventId: string): Promise<string> {
  const event = await call<{ status?: string }>(ctx, "GET", `/v1/event/${eventId}/`);
  return event.status ?? "PENDING";
}

/** Every memory held for the home, oldest first: the profile the agent starts each session with. */
export async function allMemories(ctx: EnvContext, pageSize = 200): Promise<Memory[]> {
  const page = await call<{ results?: Memory[] }>(
    ctx,
    "POST",
    `/v3/memories/?page=1&page_size=${pageSize}`,
    { filters: { user_id: user(ctx) } },
  );
  return page.results ?? [];
}

/** The memories closest to `query`, best first. */
export async function searchMemories(ctx: EnvContext, query: string, topK = 5): Promise<Memory[]> {
  const found = await call<{ results?: Memory[] }>(ctx, "POST", "/v3/memories/search/", {
    query,
    filters: { user_id: user(ctx) },
    top_k: topK,
  });
  return found.results ?? [];
}

/** Rewrite one memory's text: an edit made in the page. */
export async function updateMemory(ctx: EnvContext, id: string, text: string): Promise<void> {
  await call(ctx, "PUT", `/v1/memories/${encodeURIComponent(id)}/`, { text });
}

/** Delete one memory by the id search or the profile gave it. */
export async function forgetMemory(ctx: EnvContext, id: string): Promise<void> {
  await call(ctx, "DELETE", `/v1/memories/${encodeURIComponent(id)}/`);
}
