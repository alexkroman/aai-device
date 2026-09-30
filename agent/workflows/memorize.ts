import type { WorkflowContext } from "@alexkroman1/aai";
import { stepClientTranscript, stepEnvContext, stepPollUntil } from "@alexkroman1/aai/step";
import { stepGenerateJsonOrFail } from "@alexkroman1/aai/step-errors";
import { z } from "zod";
import { addMemories, addStatus, type Message } from "../memory.ts";
import { rest } from "../supabase.ts";
import { DIGEST_SYSTEM, FOLD_SYSTEM } from "./memorize-prompts.ts";

// What happens after every conversation (agent.ts onSessionEnd): the session's new turns
// go to mem0, which keeps the lasting facts in them, and are compacted into a digest, so
// the next connect loads months of history as a page of text (context.ts). Nobody has to
// say "remember": this is the path a passing "Biscuit can't do chicken" takes.
//
//   transcript  1 step   the turns since this session's watermark
//   digest      1 step   one model call, one row in conversation_digests
//   fold        1 step   past MAX_DIGESTS, the oldest into the rolling summary
//   mem0        1 step   hand them to mem0, wait for its extraction to land
//
// The history is written before mem0 is called, so a mem0 outage (or no key yet) costs
// the facts of this session and never the speaker's own record of what was said.
//
// Idempotent per (session, watermark): the start is deduped on both, a replay of `mem0` is a
// restatement mem0 merges, and a digest is an upsert.

export type MemorizeInput = { clientId: string; sessionId: string; throughEvent: number };

/** Digests loaded one by one at connect; past this the oldest are folded. */
export const MAX_DIGESTS = 12;
/** How many stay after a fold: the recent ones read best in their own words. */
export const KEEP_DIGESTS = 6;
/** A mem0 extraction usually lands in seconds; past this the step stops watching. */
const MEM0_WAIT_MS = 60_000;
const MEM0_POLL_MS = 3_000;

const DigestReply = z.object({ digest: z.string() });
const FoldReply = z.object({ summary: z.string() });

export async function memorizeFlow(input: MemorizeInput, ctx: WorkflowContext) {
  const turns = await ctx.step("transcript", () => newTurns(input));
  if (turns.messages.length === 0) return { skipped: "nothing new" };
  await ctx.step("digest", () => writeDigest(input, turns), { maxAttempts: 3 });
  const folded = await ctx.step("fold", () => foldOldDigests(input.clientId), { maxAttempts: 3 });
  await ctx.step("mem0", () => sendToMem0(input, turns), { maxAttempts: 5 });
  return { turns: turns.messages.length, folded };
}

/**
 * A session's turns past its watermark. `digestSoFar` is what an earlier run digested of
 * it: a resumed session is memorized once per hang-up, and each run sees only the new
 * turns, so the digest is EXTENDED from it rather than replaced (a replaced one kept only
 * the last few turns of a session that covered five things).
 */
type Turns = { startedAt: string; messages: Message[]; digestSoFar?: string };

/** The session's spoken turns past what an earlier run already digested. */
async function newTurns({ clientId, sessionId }: MemorizeInput): Promise<Turns> {
  const held = await rest<{ through_event: number; digest: string }[]>(
    stepEnvContext(),
    `/conversation_digests?client_id=eq.${enc(clientId)}&session_id=eq.${enc(sessionId)}` +
      "&select=through_event,digest",
  );
  const after = held[0]?.through_event;
  const { sessions } = await stepClientTranscript(clientId, {
    ...(after === undefined ? {} : { afterEventIndex: { sessionId, index: after } }),
  });
  const session = sessions.find((s) => s.sessionId === sessionId);
  const messages = (session?.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim())
    .map((m) => ({ role: m.role as Message["role"], content: m.text }));
  return {
    startedAt: new Date(session?.startedAt ?? Date.now()).toISOString(),
    messages,
    ...(held[0]?.digest ? { digestSoFar: held[0].digest } : {}),
  };
}

/** Hand the turns to mem0 and wait for its extraction, so a FAILED one is retried here. */
async function sendToMem0({ clientId, sessionId }: MemorizeInput, turns: Turns): Promise<string> {
  const { event_id } = await addMemories(stepEnvContext(), turns.messages, {
    metadata: { source: "conversation", session_id: sessionId, client_id: clientId },
    observedAt: new Date(turns.startedAt),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (!event_id) return "SUCCEEDED";
  const { value: status, done } = await stepPollUntil(() => addStatus(stepEnvContext(), event_id), {
    everyMs: MEM0_POLL_MS,
    maxMs: MEM0_WAIT_MS,
    done: (reading) => reading === "SUCCEEDED" || reading === "FAILED",
  });
  if (status === "FAILED") throw new Error(`mem0 could not extract from ${sessionId}`);
  // Still PENDING: mem0 holds the job and will finish it; a retry would only queue it twice.
  return done ? status : "PENDING";
}

async function writeDigest(input: MemorizeInput, turns: Turns): Promise<void> {
  const transcript = turns.messages
    .map((m) => `${m.role === "user" ? "Them" : "Assistant"}: ${m.content}`)
    .join("\n");
  const soFar = turns.digestSoFar ? `Digest so far:\n${turns.digestSoFar}\n\nThen:\n` : "";
  // Local time, zone named: the agent runs in the home, and times said in the
  // conversation ("at 4:15") are local. Given UTC, the model called a reminder due at
  // 4:14 PM "inconsistent with the conversation start time".
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Date(turns.startedAt).toLocaleString("en-US", {
    timeZone: zone,
    dateStyle: "full",
    timeStyle: "short",
  });
  const { digest } = await stepGenerateJsonOrFail(
    `Started: ${local} (${zone})\n\n${soFar}${transcript}`,
    {
      system: DIGEST_SYSTEM,
      schema: DigestReply,
    },
  );
  await rest(stepEnvContext(), "/conversation_digests?on_conflict=client_id,session_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: {
      client_id: input.clientId,
      session_id: input.sessionId,
      started_at: turns.startedAt,
      through_event: input.throughEvent,
      digest: digest.trim().slice(0, 2000),
    },
  });
}

/** Past MAX_DIGESTS, fold all but the newest KEEP_DIGESTS into the rolling summary. */
async function foldOldDigests(clientId: string): Promise<number> {
  const digests = await rest<{ started_at: string; digest: string }[]>(
    stepEnvContext(),
    `/conversation_digests?client_id=eq.${enc(clientId)}&digest=neq.&select=started_at,digest&order=started_at.asc`,
  );
  if (digests.length <= MAX_DIGESTS) return 0;
  const old = digests.slice(0, digests.length - KEEP_DIGESTS);
  const prior = await rest<{ summary: string }[]>(
    stepEnvContext(),
    `/older_history?client_id=eq.${enc(clientId)}&select=summary`,
  );
  const { summary } = await stepGenerateJsonOrFail(
    [
      `History so far:\n${prior[0]?.summary ?? "(none)"}`,
      `Conversations since:\n${old.map((d) => `[${d.started_at}]\n${d.digest}`).join("\n\n")}`,
    ].join("\n\n"),
    { system: FOLD_SYSTEM, schema: FoldReply },
  );
  await rest(stepEnvContext(), "/rpc/fold_older_history", {
    method: "POST",
    body: {
      p_client_id: clientId,
      p_summary: summary.trim().slice(0, 6000),
      p_through: old[old.length - 1]?.started_at,
    },
  });
  return old.length;
}

const enc = encodeURIComponent;
