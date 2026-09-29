import {
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  runTool,
} from "@alexkroman1/aai/testing";
import { afterEach, vi } from "vitest";
import { emailHousehold, GMAIL_SEND } from "./email.ts";
import { normalizeEmail } from "./profile.ts";
import { emailResult } from "./shared.ts";
import emailMe from "./tools/email_me.ts";
import { emailFlow } from "./workflows/email.ts";

// email_me hands the send to a run (workflows/email.ts), which sends to the address saved
// on the page, never one the model names, from the speaker's connected Gmail through
// Composio. Supabase and Composio are a fake fetch.

const env = {
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_SECRET_KEY: "sb-test",
  COMPOSIO_API_KEY: "ak_test",
};

afterEach(() => vi.unstubAllGlobals());

function fake(opts: { email?: string; gmail?: { error: string | null } }) {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (u.pathname === "/rest/v1/profile")
      return Response.json(opts.email ? [{ key: "email", value: opts.email }] : []);
    if (u.host === "supabase.test") return Response.json([]);
    if (u.pathname.endsWith("/tool_router/session")) return Response.json({ session_id: "trs_e" });
    if (u.pathname.endsWith("/execute")) {
      sent.push(body);
      return Response.json({ data: {}, error: opts.gmail?.error ?? null, log_id: "log_e" });
    }
    return Response.json({});
  });
  return sent;
}

test("email_me starts a send for this speaker and answers at once", async () => {
  const start = vi.fn(async () => "wrun_e");
  const ctx = createToolContext({ clientId: "kitchen", workflows: createStubWorkflows({ start }) });
  expect(await runTool(emailMe, { subject: "Recipe", body: "https://example.com/r" }, ctx)).toEqual(
    { sending: true },
  );
  expect(start).toHaveBeenCalledWith(
    emailResult,
    { clientId: "kitchen", subject: "Recipe", body: "https://example.com/r" },
    { key: "kitchen", label: "Email: Recipe" },
  );
  const noSpeaker = createToolContext({ workflows: createStubWorkflows({ start }) });
  expect(await runTool(emailMe, { subject: "s", body: "b" }, noSpeaker)).toHaveProperty("error");
});

test("sends to the saved address from Gmail, plain text", async () => {
  const sent = fake({ email: "sam@example.com" });
  expect(
    await emailHousehold({ env }, "kitchen", { subject: "Recipe", body: "https://example.com/r" }),
  ).toEqual({ sent: true, to: "sam@example.com" });
  expect(sent).toEqual([
    {
      tool_slug: GMAIL_SEND,
      arguments: {
        recipient_email: "sam@example.com",
        subject: "Recipe",
        body: "https://example.com/r",
        is_html: false,
      },
    },
  ]);
});

test("no saved address, or no Gmail: nothing is sent, and it says why", async () => {
  expect(fake({})).toEqual([]);
  expect(await emailHousehold({ env }, "kitchen", { subject: "s", body: "b" })).toMatchObject({
    sent: false,
    why: expect.stringContaining("Household"),
  });
  fake({ email: "sam@example.com", gmail: { error: "No connected account found for gmail" } });
  expect(await emailHousehold({ env }, "kitchen", { subject: "s", body: "b" })).toMatchObject({
    sent: false,
    why: expect.stringContaining("Apps"),
  });
});

test("the run speaks only when the email did not go", async () => {
  const sentCtx = createWorkflowContext({ runSteps: false });
  vi.spyOn(sentCtx, "step").mockResolvedValueOnce({ sent: true, to: "sam@example.com" });
  await emailFlow({ clientId: "kitchen", subject: "s", body: "b" }, sentCtx);
  expect(sentCtx.step).toHaveBeenCalledTimes(1);

  const failedCtx = createWorkflowContext({ runSteps: false });
  const step = vi.spyOn(failedCtx, "step");
  step.mockResolvedValueOnce({ sent: false, why: "Gmail isn't connected." });
  step.mockResolvedValueOnce(undefined);
  await emailFlow({ clientId: "kitchen", subject: "s", body: "b" }, failedCtx);
  expect(step.mock.calls.map((c) => c[0])).toEqual(["send", "announceFailure"]);
});

test("the page saves an address lowercased, and refuses what isn't one", () => {
  expect(normalizeEmail("  Sam@Example.COM ")).toBe("sam@example.com");
  for (const bad of ["sam", "sam@", "sam@example", "a b@example.com", "@example.com"])
    expect.soft(normalizeEmail(bad), bad).toBeUndefined();
});
