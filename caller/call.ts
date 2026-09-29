import { rest } from "./supabase.ts";

// The call this session is: the speaker's approved row (agent/calls.ts), found by the id
// Twilio carries as the stream's <Parameter name="call">. A session with no such call is
// refused before a word is said — this server is on the public internet through the
// tunnel, and only a call the household approved may use it.

type Ctx = { env: Readonly<Partial<Record<string, string>>>; signal?: AbortSignal };

export type CallTask = {
  id: string;
  callee: string;
  goal: string;
  may_agree: string;
  must_not: string;
  owner_name: string;
  status: string;
};

const enc = encodeURIComponent;

/** Claim the approved call for this session, or undefined when there is none to claim. */
export async function claimCall(ctx: Ctx, callId: string, sessionId: string): Promise<CallTask | undefined> {
  const rows = await rest<CallTask[]>(
    ctx,
    `/calls?id=eq.${enc(callId)}&status=in.(dialing,approved)&call_session_id=is.null` +
      "&select=id,callee,goal,may_agree,must_not,owner_name,status",
    { method: "PATCH", body: { status: "in_progress", call_session_id: sessionId }, prefer: "return=representation" },
  );
  return rows[0];
}

/** The task, as the model is told it for this call. */
export function taskInstructions(task: CallTask): string {
  const owner = task.owner_name || "the household you work for";
  return [
    "## This call",
    `You are calling ${task.callee} on behalf of ${owner}.`,
    `The goal: ${task.goal}`,
    task.may_agree ? `You may agree to, without checking back: ${task.may_agree}` : "",
    task.must_not ? `Do not: ${task.must_not}` : "",
    `Your first sentence, as soon as they answer, is: "Hi, this is an AI assistant calling on behalf of ${owner}." Then say why you're calling.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function appendTurn(ctx: Ctx, sessionId: string, role: string, text: string) {
  await rest(ctx, "/rpc/append_call_turn", {
    method: "POST",
    body: { p_session_id: sessionId, p_role: role, p_text: text },
  });
}

export async function finishCall(ctx: Ctx, sessionId: string, fields: Record<string, unknown>) {
  await rest(ctx, `/calls?call_session_id=eq.${enc(sessionId)}`, { method: "PATCH", body: fields });
}
