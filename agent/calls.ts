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

// --- Twilio -----------------------------------------------------------------------------

/** `stepFetch` from a step; a plain fetch in a test. */
type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export type TwilioEnv = { accountSid: string; authToken: string; from: string };

function twilioAuth(t: TwilioEnv): string {
  return `Basic ${btoa(`${t.accountSid}:${t.authToken}`)}`;
}

/** XML-escape a value going into TwiML. */
function xml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The TwiML that connects the answered call's audio to the calling agent. */
export function callTwiml(streamUrl: string, callId: string): string {
  return (
    `<Response><Connect><Stream url="${xml(streamUrl)}">` +
    `<Parameter name="call" value="${xml(callId)}"/></Stream></Connect></Response>`
  );
}

/** Ask Twilio to dial `to` and stream the answered call to `wssBase`/phone. Returns the call SID. */
export async function dial(
  fetchFn: Fetch,
  t: TwilioEnv,
  call: { id: string; to: string },
  wssBase: string,
): Promise<string> {
  const streamUrl = `${wssBase.replace(/^http/, "ws").replace(/\/+$/, "")}/phone?carrier=twilio`;
  const body = new URLSearchParams({
    To: call.to,
    From: t.from,
    Twiml: callTwiml(streamUrl, call.id),
    TimeLimit: String(CALL_TIME_LIMIT_S),
    Timeout: String(RING_TIMEOUT_S),
  });
  const res = await fetchFn(
    `https://api.twilio.com/2010-04-01/Accounts/${enc(t.accountSid)}/Calls.json`,
    {
      method: "POST",
      headers: {
        authorization: twilioAuth(t),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    sid?: string;
    message?: string;
    code?: number;
  };
  if (!res.ok || !json.sid) throw new TwilioError(res.status, json.code, json.message);
  return json.sid;
}

/** Where the call is, as Twilio says: queued, ringing, in-progress, completed, busy, no-answer, failed, canceled. */
export async function callStatus(fetchFn: Fetch, t: TwilioEnv, sid: string): Promise<string> {
  const res = await fetchFn(
    `https://api.twilio.com/2010-04-01/Accounts/${enc(t.accountSid)}/Calls/${enc(sid)}.json`,
    { method: "GET", headers: { authorization: twilioAuth(t) } },
  );
  const json = (await res.json().catch(() => ({}))) as {
    status?: string;
    message?: string;
    code?: number;
  };
  if (!res.ok) throw new TwilioError(res.status, json.code, json.message);
  return json.status ?? "unknown";
}

/** A Twilio refusal, as a sentence a person can act on; never quotes the auth token. */
export class TwilioError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string | undefined,
  ) {
    super(twilioAdvice(code, message ?? `HTTP ${status}`));
    this.name = "TwilioError";
    this.retryable = status === 429 || status >= 500;
  }
}

function twilioAdvice(code: number | undefined, message: string): string {
  switch (code) {
    case 20003:
      return "Twilio rejected the account SID or auth token.";
    case 21211:
    case 21217:
      return "That isn't a phone number Twilio can call.";
    case 21210:
    case 21212:
      return "The Twilio number to call from isn't on the account (TWILIO_FROM_NUMBER).";
    case 21219:
      return "A Twilio trial account can only call numbers verified on the account.";
    case 21215:
      return "Twilio's geographic permissions don't allow calling that country.";
    default:
      return `Twilio couldn't place the call: ${message}`;
  }
}
