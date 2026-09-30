import type { WorkflowContext } from "@alexkroman1/aai";
import {
  DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  PlaceCallError,
  stepCallStatus,
  stepEnv,
  stepEnvContext,
  stepPlaceCall,
  stepSayOnClient,
} from "@alexkroman1/aai/step";
import { throwStepError } from "@alexkroman1/aai/step-errors";
import { CALL_TIME_LIMIT_S, callerUrl, RING_TIMEOUT_S, readCall, updateCall } from "../calls.ts";

// A call the household approved (tools/place_call.ts): dial it through Twilio, wait for
// it to end, and say how it went on the speaker that asked. The call itself is run by the
// calling agent (caller/), which writes its transcript and outcome to the calls row.
//
//   dial      1 step    the SDK's stepPlaceCall: Twilio dials, the answered call streamed
//                       to caller/'s /phone with the call id as a <Parameter>
//   check     N steps   ctx.poll every POLL_MS: the row, and Twilio's own status of the call
//   announce  1 step    the outcome (or why it didn't happen), spoken on the speaker

export type CallInput = { callId: string; clientId: string };

const POLL_MS = 10_000;
/** Ringing plus the call's hard limit plus slack: past this the call is given up on. */
const MAX_WAIT_MS = (RING_TIMEOUT_S + CALL_TIME_LIMIT_S) * 1000 + 60_000;
/** Twilio call statuses that mean it is over. */
const OVER = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

type Dialled = { sid: string } | { failed: string };
type Checked = { over: boolean; twilio?: string; outcome?: string | null; status?: string };

export async function callFlow(input: CallInput, ctx: WorkflowContext) {
  const dialled = await ctx.step("dial", () => placeCall(input.callId), { maxAttempts: 3 });
  const last: Checked =
    "sid" in dialled
      ? (
          await ctx.poll("check", () => checkCall(input.callId, dialled.sid), {
            everyMs: POLL_MS,
            maxMs: MAX_WAIT_MS,
            done: (checked) => checked.over,
          })
        ).value
      : { over: false };
  const { runId } = ctx;
  const said = await ctx.step("announce", () => announce(runId, input, dialled, last), {
    maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  });
  return { said, twilio: last.twilio ?? null };
}

/** The number to call from, or undefined when agent/.env lacks any Twilio setting. */
function twilioFrom(): string | undefined {
  const ok = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"].every((k) => stepEnv(k)?.trim());
  return ok ? stepEnv("TWILIO_FROM_NUMBER")?.trim() || undefined : undefined;
}

/** Dial. A refusal that will refuse again is an answer (announced); a blip is retried. */
async function placeCall(callId: string): Promise<Dialled> {
  const db = stepEnvContext();
  const call = await readCall(db, callId);
  if (call?.status !== "approved") return { failed: "the call was no longer approved" };
  // Missing setup is an answer to say, not a failure to retry three times in silence.
  const from = twilioFrom();
  if (!from) {
    await updateCall(db, callId, { status: "failed", error: "Twilio is not set up" });
    return { failed: "calling isn't set up yet (TWILIO_ settings in agent/.env)" };
  }
  const base = await callerUrl(db);
  if (!base) {
    await updateCall(db, callId, { status: "failed", error: "calling agent not running" });
    return { failed: "the calling agent isn't running (make caller)" };
  }
  try {
    const { callId: sid } = await stepPlaceCall({
      carrier: "twilio",
      to: call.to_number,
      from,
      agentUrl: base,
      parameters: { call: callId },
      timeLimitS: CALL_TIME_LIMIT_S,
      ringTimeoutS: RING_TIMEOUT_S,
    });
    await updateCall(db, callId, { status: "dialing", twilio_sid: sid });
    return { sid };
  } catch (err) {
    if (err instanceof PlaceCallError && !err.retryable) {
      await updateCall(db, callId, { status: "failed", error: err.message });
      return { failed: err.message };
    }
    return throwStepError(err);
  }
}

async function checkCall(callId: string, sid: string): Promise<Checked> {
  const db = stepEnvContext();
  const [call, status] = await Promise.all([
    readCall(db, callId),
    stepCallStatus({ carrier: "twilio", callId: sid }).catch((): string => "unknown"),
  ]);
  const over = OVER.has(status) || call?.status === "ended" || call?.status === "failed";
  if (over && call && call.status !== "ended" && call.status !== "failed") {
    // Over on Twilio's side without the calling agent closing the row: it never
    // answered, or crashed. The row says so either way.
    await updateCall(db, callId, {
      status: status === "completed" ? "ended" : "failed",
      ended_at: new Date().toISOString(),
      ...(status === "completed" ? {} : { error: `the call was ${status}` }),
    });
  }
  return {
    over,
    twilio: status,
    outcome: call?.outcome ?? null,
    ...(call ? { status: call.status } : {}),
  };
}

/** What the speaker says: the outcome the calling agent reported, or why there is none. */
export function callReport(callee: string, dialled: Dialled, last: Checked): string {
  if ("failed" in dialled) return `I couldn't call ${callee}: ${dialled.failed}.`;
  if (last.twilio === "busy") return `${callee} was busy. Want me to try again later?`;
  if (last.twilio === "no-answer") return `${callee} didn't answer.`;
  if (last.twilio === "failed" || last.twilio === "canceled")
    return `The call to ${callee} didn't go through.`;
  if (!last.over)
    return `The call to ${callee} is taking too long to finish; check the page for the transcript.`;
  return last.outcome
    ? `I called ${callee}. ${last.outcome}`
    : `I called ${callee}, but the call ended before I could get an answer.`;
}

async function announce(
  id: string,
  input: CallInput,
  dialled: Dialled,
  last: Checked,
): Promise<string> {
  const call = await readCall(stepEnvContext(), input.callId);
  const said = callReport(call?.callee ?? "them", dialled, last);
  return await stepSayOnClient(input.clientId, { id, event: "call", text: said });
}
