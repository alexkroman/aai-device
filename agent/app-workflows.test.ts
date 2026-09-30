import { mcpToolName, tool } from "@alexkroman1/aai";
import { stubStepMcp } from "@alexkroman1/aai/experimental";
import { createToolContext, createWorkflowContext, runTool } from "@alexkroman1/aai/testing";
import {
  installStubClientInbox,
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubWorkflows,
} from "@alexkroman1/aai/testing/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { COMPOSIO_MCP_TOOLS } from "./apps.ts";
import { appJob } from "./shared.ts";
import appTask, { HANDOFF_LINE, TEXT_HANDOFF_LINE } from "./tools/app_task.ts";
import { appEventFlow, tell } from "./workflows/app-event.ts";
import { announce, work, worker } from "./workflows/app-job.ts";

// The background halves of the household's apps: app_task's run and the watch events the
// webhook starts. Composio and the model are not reached here (apps.test.ts and
// watches.test.ts cover the calls); these pin who a run is for and what reaches the speaker.

describe("app_task", () => {
  test("starts a job for this speaker, keyed by its client id for the Running panel", async () => {
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", workflows });
    const result = await runTool(appTask, { task: "summarize my last 50 emails" }, ctx);
    // The handoff line the agent says if it didn't already: the answer comes later, spoken.
    expect(result).toMatchObject({ started: true, say_if_not_said: HANDOFF_LINE });
    expect(JSON.stringify(result)).toContain("nothing is texted");
    expect(workflows.start).toHaveBeenCalledWith(
      appJob,
      { task: "summarize my last 50 emails", clientId: "kitchen", text: false },
      { key: "kitchen", label: "summarize my last 50 emails" },
    );
  });

  test("texts the answer only when they asked, and says so as it hands off", async () => {
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", workflows });
    const result = await runTool(appTask, { task: "summarize #general", text: true }, ctx);
    expect(result).toMatchObject({ started: true, say_if_not_said: TEXT_HANDOFF_LINE });
    expect(workflows.start).toHaveBeenCalledWith(
      appJob,
      expect.objectContaining({ task: "summarize #general", text: true }),
      expect.anything(),
    );
  });

  test("a session with no speaker has no apps to work on", async () => {
    const workflows = installStubWorkflows();
    const ctx = createToolContext({ workflows });
    expect(await runTool(appTask, { task: "summarize my email" }, ctx)).toHaveProperty("error");
    expect(workflows.start).not.toHaveBeenCalled();
  });
});

/** Composio's meta tools as stepMcp would hand them over, by the names the worker calls. */
const mcpTools = Object.fromEntries(
  COMPOSIO_MCP_TOOLS.map((name) => [
    mcpToolName("composio", name),
    tool({ description: name, inputSchema: z.object({}), execute: () => ({}) }),
  ]),
);

describe("the appJob worker", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("has Composio's MCP tools, the watch tools and run_code", () => {
    const w = worker("kitchen", mcpTools);
    expect(Object.keys(w.tools ?? {}).sort()).toEqual(
      [...Object.keys(mcpTools), "find_app_trigger", "stop_watching", "watch_app"].sort(),
    );
    expect(Object.keys(mcpTools)).toContain("mcp_composio_composio_search_tools");
    expect(w.builtinTools).toEqual(["run_code"]);
  });

  test("work connects Composio for this speaker and hands its tools to the worker", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "ak_test");
    const mcp = stubStepMcp(mcpTools);
    try {
      installStubReporter();
      const delegate = installStubStepDelegate({ reply: "You have three new emails." });
      const answer = await work({ task: "check my email", clientId: "kitchen" });
      expect(answer).toBe("You have three new emails.");
      expect(mcp.calls).toEqual([{ keys: ["composio"], options: { clientId: "kitchen" } }]);
      const [call] = delegate.calls;
      expect(call?.task).toBe("check my email");
      expect(Object.keys(call?.subagent.tools ?? {})).toEqual(
        expect.arrayContaining(Object.keys(mcpTools)),
      );
    } finally {
      mcp.restore();
    }
  });
});

describe("the appEvent workflow", () => {
  const input = {
    clientId: "kitchen",
    instruction: "an email from Sam",
    app: "gmail",
    trigger: "GMAIL_NEW_GMAIL_MESSAGE",
    event: '{"from":"Sam"}',
  };

  test("an event judged unwanted says nothing", async () => {
    const ctx = createWorkflowContext({
      runSteps: false,
      results: { judge: { tell: false, say: "" } },
    });
    expect(await appEventFlow(input, ctx)).toEqual({ told: false });
    expect(ctx.steps.map((s) => s.name)).toEqual(["judge"]);
  });

  test("tell says it on the speaker under the run id", async () => {
    installStubSpeech({ pcmBytes: 3200 });
    const inbox = installStubClientInbox();
    await tell("wrun_9", input, "Sam just emailed about dinner.");
    const [{ clientId, notice }] = inbox.calls as [(typeof inbox.calls)[number]];
    expect(clientId).toBe("kitchen");
    expect(notice).toMatchObject({
      id: "wrun_9",
      event: "app",
      data: { app: "gmail", said: "Sam just emailed about dinner." },
    });
  });
});

describe("the appJob announcement", () => {
  async function said(
    input: Parameters<typeof announce>[1],
    texted?: Parameters<typeof announce>[3],
  ) {
    installStubSpeech();
    const inbox = installStubClientInbox();
    await announce("wrun_2", input, "Three new messages.", texted);
    return (inbox.calls.at(-1)?.notice.data as { said?: string } | undefined)?.said;
  }

  test("an unasked run is only said, with no word of a text", async () => {
    expect(await said({ task: "t", clientId: "kitchen" })).toBe("Three new messages.");
  });

  test("an asked run says whether the text went", async () => {
    const input = { task: "t", clientId: "kitchen", text: true };
    expect(await said(input, { sent: true })).toBe(
      "Three new messages. I've texted it to you too.",
    );
    expect(await said(input, { sent: false })).toMatch(/couldn't text it to you/);
  });
});
