import { rest } from "./supabase.ts";

// Phone calls placed for the household. Two steps, both needed, in the speaker's own
// session: prepare_call writes a DRAFT (who, why, what may be agreed) that the speaker
// reads back, and place_call dials only that draft, only from the session that made it,
// only while it is fresh. The dialled call is answered by the calling agent (caller/),
// which loads the approved row by its id and writes the transcript and outcome back.
//
// Calling a person with an AI voice is regulated (the FCC counts one as "artificial" for
// the TCPA): the calling agent says it is an AI assistant first, never gives payment or
// ID details, and Twilio hangs up after CALL_TIME_LIMIT_S whatever happens.

type Ctx = { env: Readonly<Partial<Record<string, string>>>; signal?: AbortSignal };

/** A draft must be approved within this long, in the session that made it. */
export const DRAFT_TTL_MS = 10 * 60 * 1000;
/** Calls placed per speaker per day: each is minutes on Twilio and a stranger's time. */
export const MAX_CALLS_PER_DAY = 10;
/** Twilio's hard limit on the call: a stuck agent cannot run up minutes. */
export const CALL_TIME_LIMIT_S = 300;
/** How long Twilio lets it ring before giving up as no-answer. */
export const RING_TIMEOUT_S = 30;

export type CallRow = {
  id: string;
  client_id: string;
  session_id: string;
  to_number: string;
  callee: string;
  goal: string;
  may_agree: string;
  must_not: string;
  owner_name: string;
  status: string;
  twilio_sid: string | null;
  outcome: string | null;
  error: string | null;
  transcript: { role: string; text: string }[];
  created_at: string;
};

const enc = encodeURIComponent;

export async function draftCall(
  ctx: Ctx,
  draft: Omit<
    CallRow,
    "id" | "status" | "twilio_sid" | "outcome" | "error" | "transcript" | "created_at"
  >,
): Promise<string> {
  const id = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await rest(ctx, "/calls", { method: "POST", prefer: "return=minimal", body: { id, ...draft } });
  return id;
}

export async function readCall(ctx: Ctx, id: string): Promise<CallRow | undefined> {
  const rows = await rest<CallRow[]>(ctx, `/calls?id=eq.${enc(id)}&select=*`);
  return rows[0];
}

export async function updateCall(
  ctx: Ctx,
  id: string,
  fields: Partial<CallRow> & Record<string, unknown>,
) {
  await rest(ctx, `/calls?id=eq.${enc(id)}`, { method: "PATCH", body: fields });
}

export type ApproveResult =
  | { status: "approved"; call: CallRow }
  | { status: "refused"; why: string };

/**
 * The server's half of "only after they said yes": the draft exists, is still a draft,
 * was made in THIS session and recently, and the speaker is under its daily cap.
 */
export async function approveCall(
  ctx: Ctx,
  id: string,
  session: { sessionId: string; clientId: string },
  now = Date.now(),
): Promise<ApproveResult> {
  const call = await readCall(ctx, id);
  if (call?.status !== "draft")
    return { status: "refused", why: "There is no call waiting for approval." };
  if (call.session_id !== session.sessionId || call.client_id !== session.clientId) {
    return { status: "refused", why: "That call was drafted in another conversation." };
  }
  if (now - Date.parse(call.created_at) > DRAFT_TTL_MS) {
    await updateCall(ctx, id, { status: "expired" });
    return { status: "refused", why: "That draft expired: prepare the call again." };
  }
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const today = await rest<{ id: string }[]>(
    ctx,
    `/calls?client_id=eq.${enc(session.clientId)}&approved_at=gt.${since}&select=id`,
  );
  if (today.length >= MAX_CALLS_PER_DAY) {
    return { status: "refused", why: `This speaker has placed ${MAX_CALLS_PER_DAY} calls today.` };
  }
  await updateCall(ctx, id, { status: "approved", approved_at: new Date(now).toISOString() });
  return { status: "approved", call: { ...call, status: "approved" } };
}

/** The calling agent's public URL, published by `make caller` (it changes every run). */
export async function callerUrl(ctx: Ctx): Promise<string | undefined> {
  const rows = await rest<{ value: string }[]>(ctx, "/settings?key=eq.caller_url&select=value");
  return rows[0]?.value;
}
