/** The def a DEPLOYED agent runs: authored, plus `tools/` and `system-prompt.md`. */
import deployedDef from "virtual:aai/agent";
import { createToolContext, endSessionCalls, expectDeployable } from "@alexkroman1/aai/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import agentDef from "./agent.ts";
import { taskInstructions } from "./call.ts";
import endCall from "./tools/end_call.ts";

// The calling agent is on the public internet (make caller's tunnel), so the claims that
// matter are the refusals: no approved call, no conversation.

const env = { SUPABASE_URL: "http://supabase.test", SUPABASE_SECRET_KEY: "sb-test" };
const signal = new AbortController().signal;
const sessionContext = agentDef.sessionContext as NonNullable<typeof agentDef.sessionContext>;

function supabaseAnswers(rows: unknown[]) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe("the calling agent", () => {
  test("is deployable, answers Twilio, and has only its own two tools", () => {
    expectDeployable(agentDef);
    expect(agentDef.telephony).toEqual(["twilio"]);
    expect(deployedDef.builtinTools ?? []).toEqual([]);
    expect(Object.keys(deployedDef.tools ?? {}).sort()).toEqual(["end_call", "report_outcome"]);
    expect(deployedDef.systemPrompt).toContain("AI assistant");
    expect(deployedDef.systemPrompt).toContain("Never give payment details");
  });

  test("refuses a session that isn't a placed call, without touching the database", async () => {
    const fetch = supabaseAnswers([]);
    expect(await sessionContext({ sessionId: "s1", env, signal })).toEqual({ refuse: "not a placed call" });
    expect(
      await sessionContext({ sessionId: "s1", env, signal, call: { carrier: "twilio", parameters: {} } }),
    ).toEqual({ refuse: "not a placed call" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("refuses a call id nobody approved, and one it cannot check", async () => {
    supabaseAnswers([]);
    const call = { carrier: "twilio", callId: "CA1", parameters: { call: "call_nope" } };
    expect(await sessionContext({ sessionId: "s1", env, signal, call })).toEqual({
      refuse: "no approved call with that id",
    });
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    expect(await sessionContext({ sessionId: "s1", env, signal, call })).toEqual({
      refuse: "could not load the call",
    });
  });

  test("an approved call becomes the session's task, claimed for this session", async () => {
    const fetch = supabaseAnswers([
      {
        id: "call_1",
        callee: "Luigi's",
        goal: "book a table for 4 at 7 PM",
        may_agree: "any time 6:30-7:30",
        must_not: "",
        owner_name: "Sam",
        status: "in_progress",
      },
    ]);
    const call = { carrier: "twilio", callId: "CA1", parameters: { call: "call_1" } };
    const ctx = (await sessionContext({ sessionId: "s1", env, signal, call })) as { instructions: string };
    expect(ctx.instructions).toContain("calling Luigi's on behalf of Sam");
    expect((ctx as { greeting?: string }).greeting).toBe(
      "Hi, this is an AI assistant calling on behalf of Sam. Do you have a moment?",
    );
    expect(ctx.instructions).toContain("any time 6:30-7:30");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("status=in.(dialing,approved)");
    expect(url).toContain("call_session_id=is.null");
    expect(JSON.parse(String(init.body))).toEqual({ status: "in_progress", call_session_id: "s1" });
  });

  test("it speaks first, disclosing it is an AI, and the task then names the owner", () => {
    expect(agentDef.greeting).toMatch(/^Hi, this is an AI assistant calling on behalf of/);
    const task = { id: "c", callee: "X", goal: "g", may_agree: "", must_not: "", owner_name: "Sam", status: "in_progress" };
    expect(taskInstructions(task)).toContain("calling on behalf of Sam");
  });

  test("end_call ends the session after the goodbye is spoken", async () => {
    const ctx = createToolContext();
    await endCall.execute({}, ctx);
    expect(endSessionCalls(ctx)).toEqual([expect.objectContaining({})]);
  });
});
