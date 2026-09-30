import { createToolContext, createWorkflowContext, runTool } from "@alexkroman1/aai/testing";
import { installFetchRoutes, installStubWorkflows } from "@alexkroman1/aai/testing/vitest";
import { emailHousehold, GMAIL_SEND } from "./email.ts";
import { normalizeEmail } from "./profile.ts";
import { emailResult } from "./shared.ts";
import emailMe from "./tools/email_me.ts";
import { emailFlow } from "./workflows/email.ts";

// email_me hands the send to a run (workflows/email.ts), which sends to the address saved
// on the page, never one the model names, from the speaker's connected Gmail through
// Composio. Supabase and Composio are fake routes.

const env = {
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_SECRET_KEY: "sb-test",
  COMPOSIO_API_KEY: "ak_test",
};

/** The profile's saved address and the speaker's Gmail; returns what Gmail was asked to send. */
function fake(opts: { email?: string; gmail?: { error: string | null } }) {
  const net = installFetchRoutes({
    "http://supabase.test/rest/v1/profile": {
      body: opts.email ? [{ key: "email", value: opts.email }] : [],
    },
    "supabase.test": { body: [] },
    "POST backend.composio.dev": (req) =>
      req.pathname.endsWith("/tool_router/session")
        ? { body: { session_id: "trs_e" } }
        : req.pathname.endsWith("/execute")
          ? { body: { data: {}, error: opts.gmail?.error ?? null, log_id: "log_e" } }
          : undefined,
  });
  return {
    get sent() {
      return net.hits.filter((h) => h.pathname.endsWith("/execute")).map((h) => h.json);
    },
  };
}

test("email_me starts a send for this speaker and answers at once", async () => {
  const workflows = installStubWorkflows({ runId: "wrun_e" });
  const ctx = createToolContext({ clientId: "kitchen", workflows });
  expect(await runTool(emailMe, { subject: "Recipe", body: "https://example.com/r" }, ctx)).toEqual(
    { sending: true },
  );
  expect(workflows.start).toHaveBeenCalledWith(
    emailResult,
    { clientId: "kitchen", subject: "Recipe", body: "https://example.com/r" },
    { key: "kitchen", label: "Email: Recipe" },
  );
  const noSpeaker = createToolContext({ workflows });
  expect(await runTool(emailMe, { subject: "s", body: "b" }, noSpeaker)).toHaveProperty("error");
});

test("sends to the saved address from Gmail, plain text", async () => {
  const gmail = fake({ email: "sam@example.com" });
  expect(
    await emailHousehold({ env }, "kitchen", { subject: "Recipe", body: "https://example.com/r" }),
  ).toEqual({ sent: true, to: "sam@example.com" });
  expect(gmail.sent).toEqual([
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
  const unsaved = fake({});
  expect(await emailHousehold({ env }, "kitchen", { subject: "s", body: "b" })).toMatchObject({
    sent: false,
    why: expect.stringContaining("Household"),
  });
  expect(unsaved.sent).toEqual([]);
  fake({ email: "sam@example.com", gmail: { error: "No connected account found for gmail" } });
  expect(await emailHousehold({ env }, "kitchen", { subject: "s", body: "b" })).toMatchObject({
    sent: false,
    why: expect.stringContaining("Apps"),
  });
});

test("the run speaks only when the email did not go", async () => {
  const sentCtx = createWorkflowContext({
    runSteps: false,
    results: { send: { sent: true, to: "sam@example.com" } },
  });
  await emailFlow({ clientId: "kitchen", subject: "s", body: "b" }, sentCtx);
  expect(sentCtx.steps.map((s) => s.name)).toEqual(["send"]);

  const failedCtx = createWorkflowContext({
    runSteps: false,
    results: { send: { sent: false, why: "Gmail isn't connected." } },
  });
  await emailFlow({ clientId: "kitchen", subject: "s", body: "b" }, failedCtx);
  expect(failedCtx.steps.map((s) => s.name)).toEqual(["send", "announceFailure"]);
});

test("the page saves an address lowercased, and refuses what isn't one", () => {
  expect(normalizeEmail("  Sam@Example.COM ")).toBe("sam@example.com");
  for (const bad of ["sam", "sam@", "sam@example", "a b@example.com", "@example.com"])
    expect.soft(normalizeEmail(bad), bad).toBeUndefined();
});
