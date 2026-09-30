import type { WorkflowContext } from "@alexkroman1/aai";
import {
  isCallOver,
  PlaceCallError,
  stepCallStatus,
  stepEnv,
  stepEnvContext,
  stepPlaceCall,
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
//   callee    1 step    who was called, read from the row for the sentence below
//   announce  1 step    ctx.sayOnClient: the outcome (or why it didn't happen), on the speaker
//
// `callee` is new beside the older steps: a step journals by name and occurrence, so a run
// in flight across its arrival just takes it fresh and replays `announce` as before.

export type CallInput = { callId: string; clientId: string };

const POLL_MS = 10_000;
/** Ringing plus the call's hard limit plus slack: past this the call is given up on. */
const MAX_WAIT_MS = (RING_TIMEOUT_S + CALL_TIME_LIMIT_S) * 1000 + 60_000;

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
  const callee = await ctx.step("callee", () => readCallee(input.callId));
  const said = await ctx.sayOnClient("announce", input.clientId, {
    event: "call",
    text: callReport(callee, dialled, last),
  });
  return { said, twilio: last.twilio ?? null };
}

/**
 * The number to call from, or undefined when agent/.env has none. Only the number: a
 * missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is stepPlaceCall's to catch, and it
 * throws a non-retryable PlaceCallError for it, which placeCall's catch already announces.
 */
function twilioFrom(): string | undefined {
  return stepEnv("TWILIO_FROM_NUMBER")?.trim() || undefined;
}

/** Dial. A refusal that will refuse again is an answer (announced); a blip is retried. */
async function placeCall(callId: string): Promise<Dialled> {
  const db = stepEnvContext();
  const call = await readCall(db, callId);
  if (call?.status !== "approved") return { failed: "the call was no longer approved" };
  // Missing setup is an answer to say, not a failure to retry three times in silence.
  const from = twilioFrom();
  if (!from) {
    await updateCall(db, callId, { status: "failed", error: "TWILIO_FROM_NUMBER is not set" });
    return { failed: "calling isn't set up yet (TWILIO_FROM_NUMBER in agent/.env)" };
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
  const over = isCallOver(status) || call?.status === "ended" || call?.status === "failed";
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

/** Who the call was to, as the row names them. */
async function readCallee(callId: string): Promise<string> {
  return (await readCall(stepEnvContext(), callId))?.callee ?? "them";
}
