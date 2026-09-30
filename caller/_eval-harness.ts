// The calling eval's fixtures and its hang-up assertion. They live outside
// agent.eval.test.ts because Biome's noMisplacedAssertion matches lexical position: an
// `expect` in a helper is an error in a *.test.ts, and `_*-harness.ts` is where the SDK's
// config (and this repo's) allows one.
import type { SessionCall } from "@alexkroman1/aai";
import {
  type EvalNetwork,
  type EvalSession,
  errorsIn,
  evalNetwork,
  toolArgsIn,
  toolNames,
} from "@alexkroman1/aai-runtime/eval";
import { expect } from "vitest";
import type { CallTask } from "./call.ts";

// ---------------------------------------------------------------------------------------
// The placed call.

export const SUPABASE_URL = "http://supabase.eval.invalid";
export const env = { SUPABASE_URL, SUPABASE_SECRET_KEY: "sb-eval-fake-key" };

/** The speaker-approved call every case places (fictional restaurant, fictional owner). */
export const DINNER: CallTask = {
  id: "call_eval_dinner",
  callee: "Bellissimo Trattoria",
  goal: "Book a table for 4 tonight at 7 PM under the name Sam.",
  may_agree: "any time between 6:30 and 7:30 PM tonight, indoor or outdoor seating",
  must_not: "",
  owner_name: "Sam",
  status: "approved",
};

/** What Twilio's start frame carries for it: `<Parameter name="call">`. */
export const PLACED: SessionCall = {
  carrier: "twilio",
  callId: "CA_eval_0001",
  parameters: { call: DINNER.id },
};

// ---------------------------------------------------------------------------------------
// Fake Supabase: the calls table and append_call_turn.

export type CallRow = CallTask & { call_session_id?: string; outcome?: string; ended_at?: string };

/** The calls table lives in `state`, which describeEval rebuilds per case and per repeat. */
export const supabase = () =>
  evalNetwork({
    state: () => ({ calls: new Map<string, CallRow>([[DINNER.id, { ...DINNER }]]) }),
    routes: {
      [`${SUPABASE_URL}/rest/v1/`]: (_req, { method, url, body }, { calls }) => {
        const path = decodeURIComponent(url.href.slice(`${SUPABASE_URL}/rest/v1`.length));
        const fields = body as Partial<CallRow>;
        // claimCall: one conditional PATCH, so only an approved, unclaimed row answers.
        const claim =
          /^\/calls\?id=eq\.([^&]+)&status=in\.\(dialing,approved\)&call_session_id=is\.null/.exec(
            path,
          );
        if (method === "PATCH" && claim) {
          const row = calls.get(claim[1] ?? "");
          if (!(row && ["approved", "dialing"].includes(row.status)) || row.call_session_id)
            return [];
          Object.assign(row, fields);
          return [row];
        }
        // finishCall: report_outcome's outcome, then onSessionEnd's status.
        const finish = /^\/calls\?call_session_id=eq\.(.+)$/.exec(path);
        if (method === "PATCH" && finish) {
          for (const row of calls.values())
            if (row.call_session_id === finish[1]) Object.assign(row, fields);
          return;
        }
        if (method === "POST" && path === "/rpc/append_call_turn") return;
        return new Response(`eval fake: no route for ${method} ${path}`, { status: 404 });
      },
    },
  });

export type Supabase = ReturnType<typeof supabase>;

/** The request log's view of one Supabase path. */
export const sent = (network: EvalNetwork, path: string) =>
  network.requests(`${SUPABASE_URL}/rest/v1${path}`);

// ---------------------------------------------------------------------------------------
// Reading the call.

/**
 * The hang-up invariant: the agent ended the call, only after report_outcome, and the
 * outcome and then onSessionEnd's `ended` really reached the calls row.
 */
export async function expectReportedThenHungUp(
  session: EvalSession,
  network: Supabase,
): Promise<string> {
  expect(session.ended, "it hung up").toBe(true);
  const names = toolNames(session.toolCalls());
  expect(names.slice(names.indexOf("end_call")), "nothing after end_call").toEqual(["end_call"]);
  const reported = names.lastIndexOf("report_outcome");
  expect(reported, "it called report_outcome").toBeGreaterThanOrEqual(0);
  expect(reported, "report_outcome came before end_call").toBeLessThan(names.indexOf("end_call"));
  await expect(session.say("Hello? Are you still there?"), "nobody is on the line").rejects.toThrow(
    /ENDED/,
  );

  const outcome = String(toolArgsIn(session.toolCalls(), "report_outcome").at(-1)?.outcome ?? "");
  const row = network.state.calls.get(DINNER.id);
  expect(row?.call_session_id).toBe(session.id);
  expect(row?.outcome, "the outcome reached the calls row").toBe(outcome);
  expect(row?.status, "the hang-up ended the call").toBe("ended");
  expect(errorsIn(session.events())).toEqual([]);
  network.expectNothingRefused();
  return outcome;
}
