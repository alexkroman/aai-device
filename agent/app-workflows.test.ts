import {
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  runTool,
  stubClientInbox,
  stubSpeech,
} from "@alexkroman1/aai/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { appJob } from "./shared.ts";
import appTask, { HANDOFF_LINE, TEXT_HANDOFF_LINE } from "./tools/app_task.ts";
import { appEventFlow, tell } from "./workflows/app-event.ts";
import { announce, worker } from "./workflows/app-job.ts";
import { NOTICE_SAMPLE_RATE } from "./workflows/remind.ts";

// The background halves of the household's apps: app_task's run and the watch events the
// webhook starts. Composio and the model are not reached here (apps.test.ts and
// watches.test.ts cover the calls); these pin who a run is for and what reaches the speaker.

describe("app_task", () => {
  test("starts a job for this speaker, keyed by its client id for the Running panel", async () => {
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({
      clientId: "kitchen",
      workflows: createStubWorkflows({ start }),
    });
    const result = await runTool(appTask, { task: "summarize my last 50 emails" }, ctx);
    // The handoff line the agent says if it didn't already: the answer comes later, spoken.
    expect(result).toMatchObject({ started: true, say_if_not_said: HANDOFF_LINE });
    expect(JSON.stringify(result)).toContain("nothing is texted");
    expect(start).toHaveBeenCalledWith(
      appJob,
      { task: "summarize my last 50 emails", clientId: "kitchen", text: false },
      { key: "kitchen", label: "summarize my last 50 emails" },
    );
  });

  test("texts the answer only when they asked, and says so as it hands off", async () => {
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({
      clientId: "kitchen",
      workflows: createStubWorkflows({ start }),
    });
    const result = await runTool(appTask, { task: "summarize #general", text: true }, ctx);
    expect(result).toMatchObject({ started: true, say_if_not_said: TEXT_HANDOFF_LINE });
    expect(start).toHaveBeenCalledWith(
      appJob,
      expect.objectContaining({ task: "summarize #general", text: true }),
      expect.anything(),
    );
  });

  test("a session with no speaker has no apps to work on", async () => {
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({ workflows: createStubWorkflows({ start }) });
    expect(await runTool(appTask, { task: "summarize my email" }, ctx)).toHaveProperty("error");
    expect(start).not.toHaveBeenCalled();
  });
});

test("the worker has the app and watch tools, the workbench and run_code", () => {
  const w = worker("kitchen");
  expect(Object.keys(w.tools ?? {}).sort()).toEqual([
    "call_app_api",
    "find_app_action",
    "find_app_trigger",
    "run_app_action",
    "stop_watching",
    "watch_app",
    "workbench",
  ]);
  expect(w.builtinTools).toEqual(["run_code"]);
});

describe("the appEvent workflow", () => {
  afterEach(() => vi.unstubAllEnvs());

  const input = {
    clientId: "kitchen",
    instruction: "an email from Sam",
    app: "gmail",
    trigger: "GMAIL_NEW_GMAIL_MESSAGE",
    event: '{"from":"Sam"}',
  };

  test("an event judged unwanted says nothing", async () => {
    const ctx = createWorkflowContext({ runSteps: false });
    vi.spyOn(ctx, "step").mockResolvedValueOnce({ tell: false, say: "" });
    expect(await appEventFlow(input, ctx)).toEqual({ told: false });
    expect(ctx.step).toHaveBeenCalledTimes(1);
  });

  test("tell speaks at the board's rate and pushes it under the run id", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    const speech = stubSpeech({ pcmBytes: 3200 });
    const inbox = stubClientInbox();
    try {
      await tell("wrun_9", input, "Sam just emailed about dinner.");
      expect(speech.calls).toMatchObject([
        { text: "Sam just emailed about dinner.", sampleRate: NOTICE_SAMPLE_RATE },
      ]);
      const [{ clientId, notice }] = inbox.calls as [(typeof inbox.calls)[number]];
      expect(clientId).toBe("kitchen");
      expect(notice).toMatchObject({
        id: "wrun_9",
        event: "app",
        data: { app: "gmail", said: "Sam just emailed about dinner." },
      });
    } finally {
      speech.restore();
      inbox.restore();
    }
  });
});

describe("the appJob announcement", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function said(
    input: Parameters<typeof announce>[1],
    texted?: Parameters<typeof announce>[3],
  ) {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    const speech = stubSpeech({ pcmBytes: 3200 });
    const inbox = stubClientInbox();
    try {
      await announce("wrun_2", input, "Three new messages.", texted);
      return speech.calls[0]?.text;
    } finally {
      speech.restore();
      inbox.restore();
    }
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
