import type { StubFetchRoutes } from "@alexkroman1/aai/testing";
import { installFetchRoutes } from "@alexkroman1/aai/testing/vitest";
import { beforeEach } from "vitest";
import { approveCall, DRAFT_TTL_MS, MAX_CALLS_PER_DAY } from "./calls.ts";
import { callReport } from "./workflows/call.ts";

// The rules between "call Luigi's" and a phone ringing: a call is dialled only from the
// draft this session read back, while it is fresh, under the day's cap. (The dial itself
// is the SDK's stepPlaceCall, tested there.)

const ctx = { env: { SUPABASE_URL: "http://supabase.test", SUPABASE_SECRET_KEY: "sb-test" } };
const session = { sessionId: "s1", clientId: "kitchen" };
const now = Date.parse("2026-09-29T18:00:00Z");

function draft(over: Record<string, unknown> = {}) {
  return {
    id: "call_1",
    client_id: "kitchen",
    session_id: "s1",
    status: "draft",
    callee: "Luigi's",
    goal: "g",
    created_at: new Date(now - 60_000).toISOString(),
    ...over,
  };
}

let answers: unknown[] = [];
let net: StubFetchRoutes;
beforeEach(() => {
  answers = [];
  net = installFetchRoutes({
    "supabase.test": () => {
      const body = answers.shift();
      return body === undefined ? { status: 200 } : { body };
    },
  });
});

/** Answer PostgREST calls in order: the draft read, the day's count, then the PATCH. */
function supabase(...next: unknown[]) {
  answers = next;
}

test("approves this session's fresh draft, and marks it approved", async () => {
  supabase([draft()], [], undefined);
  expect(await approveCall(ctx, "call_1", session, now)).toMatchObject({ status: "approved" });
  expect(net.hits.at(-1)?.method).toBe("PATCH");
  expect(net.hits.at(-1)?.json).toMatchObject({ status: "approved" });
});

test("refuses a draft from another conversation or another speaker", async () => {
  supabase([draft({ session_id: "other" })]);
  expect(await approveCall(ctx, "call_1", session, now)).toMatchObject({ status: "refused" });
  supabase([draft({ client_id: "garage" })]);
  expect(await approveCall(ctx, "call_1", session, now)).toMatchObject({ status: "refused" });
});

test("refuses an expired draft, one already used, and one past the day's cap", async () => {
  supabase([draft({ created_at: new Date(now - DRAFT_TTL_MS - 1).toISOString() })], undefined);
  expect(await approveCall(ctx, "call_1", session, now)).toMatchObject({
    why: expect.stringContaining("expired"),
  });
  supabase([draft({ status: "approved" })]);
  expect(await approveCall(ctx, "call_1", session, now)).toMatchObject({ status: "refused" });
  supabase(
    [draft()],
    Array.from({ length: MAX_CALLS_PER_DAY }, (_, i) => ({ id: `c${i}` })),
  );
  expect(await approveCall(ctx, "call_1", session, now)).toMatchObject({
    why: expect.stringContaining(`${MAX_CALLS_PER_DAY} calls`),
  });
});

test("what the speaker says afterwards", () => {
  expect(
    callReport(
      "Luigi's",
      { sid: "CA1" },
      { over: true, twilio: "completed", outcome: "Booked for 7:15." },
    ),
  ).toBe("I called Luigi's. Booked for 7:15.");
  expect(callReport("Luigi's", { sid: "CA1" }, { over: true, twilio: "no-answer" })).toBe(
    "Luigi's didn't answer.",
  );
  expect(
    callReport(
      "Luigi's",
      { failed: "the calling agent isn't running (make caller)" },
      { over: false },
    ),
  ).toBe("I couldn't call Luigi's: the calling agent isn't running (make caller).");
});
