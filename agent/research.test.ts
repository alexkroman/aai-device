import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS } from "@alexkroman1/aai/step";
import { createToolContext, createWorkflowContext, runTool } from "@alexkroman1/aai/testing";
import {
  installStubClientInbox,
  installStubGateway,
  installStubSpeech,
  installStubStepFetch,
  installStubWorkflows,
} from "@alexkroman1/aai/testing/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { research } from "./shared.ts";
import deepResearch from "./tools/deep_research.ts";
import { readyText, researchWorkflow, withSources } from "./workflows/research.ts";
import { BRIEF_SYSTEM } from "./workflows/research-prompts.ts";
import { TEXT_STEP, textOwner } from "./workflows/text.ts";

// The research stages themselves (brief, angles, researchers, gaps, report) are the SDK's
// deepResearchWorkflow and tested there; this pins the speaker's side of it: its prompts,
// how it delivers, and what it says when it fails.

const a = { title: "Heat pumps, explained", url: "https://example.com/a" };
const b = { title: "Cold-climate models", url: "https://example.com/b" };

describe("withSources", () => {
  test("titles the text and appends the cited urls", () => {
    expect(withSources("heat pumps", " They work [2]. ", [a, b])).toBe(
      "Research: heat pumps\n\nThey work [2].\n\nSources:\n[2] https://example.com/b",
    );
  });

  test("sources that don't fit one text are dropped whole, last first", () => {
    const body = "They work [1][2].";
    const both = withSources("t", body, [a, b]);
    const oneLess = withSources("t", body, [a, b], both.length - 1);
    expect(oneLess).toBe(`Research: t\n\n${body}\n\nSources:\n[1] https://example.com/a`);
    expect(withSources("t", body, [a, b], 10)).toBe(`Research: t\n\n${body}`);
  });

  test("a report that cites nothing gets no sources list", () => {
    expect(withSources("x", "Inconclusive.", [a])).toBe("Research: x\n\nInconclusive.");
  });
});

describe("deep_research", () => {
  test("starts a run that only says the results on this session's speaker", async () => {
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", clientPhone: "+15555550123", workflows });
    const result = await runTool(deepResearch, { topic: "heat pumps for an old house" }, ctx);
    expect(result).toEqual({ started: true, delivery: "said on the speaker" });
    expect(workflows.start).toHaveBeenCalledWith(
      research,
      {
        topic: "heat pumps for an old house",
        clientId: "kitchen",
        phone: "+15555550123",
        text: false,
      },
      { key: "kitchen", label: "heat pumps for an old house" },
    );
  });

  test("texts the report too when they asked for a text", async () => {
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", workflows });
    expect(await runTool(deepResearch, { topic: "heat pumps", text: true }, ctx)).toEqual({
      started: true,
      delivery: "said on the speaker, and texted",
    });
    expect(workflows.start).toHaveBeenCalledWith(
      research,
      expect.objectContaining({ text: true }),
      expect.anything(),
    );
  });

  test("from a browser tab it texts only when asked, and otherwise starts nothing", async () => {
    const workflows = installStubWorkflows();
    const ctx = createToolContext({ workflows });
    expect(await runTool(deepResearch, { topic: "heat pumps", text: true }, ctx)).toEqual({
      started: true,
      delivery: "texted",
    });
    vi.mocked(workflows.start).mockClear();
    const refused = await runTool(deepResearch, { topic: "heat pumps" }, ctx);
    expect(JSON.stringify(refused)).toContain("Ask whether to text them");
    expect(workflows.start).not.toHaveBeenCalled();
  });
});

const brief = { brief: "Heat pumps for an old house.", criteria: ["cost"] };
/** The SDK's stages, answered by name so the body reaches the speaker's own steps. */
const stages = {
  writeBrief: brief,
  planAngles: ["cost"],
  investigate: { angle: "cost", findings: "Rebates help [1].", sources: [a] },
  findGaps: [],
  writeReport: { report: "Rebates help [1].", summary: "Rebates make them affordable." },
};

describe("the research workflow", () => {
  afterEach(() => vi.unstubAllEnvs());
  const input = { topic: "heat pumps", clientId: "kitchen" };

  test("says the summary on the speaker, and texts only when asked", async () => {
    const ctx = createWorkflowContext({ runSteps: false, results: stages });
    expect(await researchWorkflow.run(input, ctx)).toEqual({
      topic: "heat pumps",
      summary: "Rebates make them affordable.",
      sources: 1,
      texted: { sent: false },
      announced: true,
    });
    expect(ctx.steps.slice(-1)).toEqual([
      { name: "announce", maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
    ]);
    expect(ctx.steps.map((s) => s.name)).not.toContain("text");
  });

  test("a text they asked for is its own few-attempt step, before the announcement", async () => {
    const ctx = createWorkflowContext({
      runSteps: false,
      results: { ...stages, text: { sent: true } },
    });
    const out = await researchWorkflow.run({ ...input, text: true }, ctx);
    expect(out).toMatchObject({ texted: { sent: true } });
    expect(ctx.steps.slice(-2)).toEqual([
      { name: "text", maxAttempts: TEXT_STEP.maxAttempts },
      { name: "announce", maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
    ]);
  });

  /** The engine's failure hook: sayFailureOnClient's `{ run, maxAttempts }`. */
  function failureHook() {
    const hook = researchWorkflow.onFailure;
    if (typeof hook !== "object") throw new Error("onFailure is not the engine's handler");
    return hook;
  }

  test("a failure fails the run, and the ENGINE's hook says it on the speaker", async () => {
    // No angles planned: the fan-out has nothing to map, and the pass throws.
    const ctx = createWorkflowContext({ runSteps: false, results: { writeBrief: brief } });
    await expect(researchWorkflow.run(input, ctx)).rejects.toThrow();
    expect(ctx.steps.map((s) => s.name)).not.toContain("announce");

    installStubSpeech();
    const inbox = installStubClientInbox();
    const hook = failureHook();
    expect(hook.maxAttempts).toBe(DEFAULT_CLIENT_DELIVERY_ATTEMPTS);
    await hook.run(new Error("The search service is down."), {
      runId: "wrun_4",
      workflow: "research",
      input,
    });
    expect(inbox.calls).toMatchObject([
      {
        clientId: "kitchen",
        notice: {
          id: "wrun_4:failed",
          event: "research",
          data: {
            topic: "heat pumps",
            failed: true,
            said: "Sorry, the research on heat pumps didn't finish. The search service is down.",
          },
        },
      },
    ]);
  });

  test("with no speaker to say it on, a failure says nothing", async () => {
    const inbox = installStubClientInbox();
    await failureHook().run(new Error("down"), {
      runId: "wrun_5",
      workflow: "research",
      input: { topic: "heat pumps" },
    });
    expect(inbox.calls).toEqual([]);
  });

  test("the brief is written with the speaker's prompt", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    const gateway = installStubGateway(JSON.stringify(brief));
    const { writeBrief: _, ...rest } = stages;
    const ctx = createWorkflowContext({ results: { ...rest, announce: undefined } });
    await researchWorkflow.run(input, ctx);
    expect(gateway[0]?.system).toContain(BRIEF_SYSTEM);
  });

  test("the declared workflow is this one", () => {
    expect(research).toBe(researchWorkflow);
  });
});

describe("textOwner", () => {
  afterEach(() => vi.unstubAllEnvs());

  function textbelt() {
    vi.stubEnv("TEXTBELT_KEY", "test-key");
    vi.stubEnv("SMS_TO_PHONE", "+15555550100");
    vi.stubEnv("SMS_ALLOWED_PHONES", "+15555550111");
    const fetched = installStubStepFetch(() => ({ body: { success: true, textId: 1 } }));
    return () => JSON.parse(String(fetched.calls[0]?.body)) as { phone: string; message: string };
  }

  test("texts an allowlisted number the client reported", async () => {
    const sent = textbelt();
    expect(await textOwner("+15555550111", "The report.")).toEqual({
      sent: true,
    });
    expect(sent()).toMatchObject({
      phone: "+15555550111",
      message: "The report.",
      key: "test-key",
    });
  });

  test("a number the client made up is ignored: the owner gets it", async () => {
    const sent = textbelt();
    await textOwner("+15555550999", "The report.");
    expect(sent().phone).toBe("+15555550100");
  });

  test("with no number at all it texts no one", async () => {
    vi.stubEnv("TEXTBELT_KEY", "k");
    vi.stubEnv("SMS_TO_PHONE", "");
    const fetched = installStubStepFetch(() => ({ body: { success: true } }));
    expect(await textOwner(undefined, "r")).toEqual({ sent: false });
    expect(fetched.calls).toEqual([]);
  });

  test("links are taken out before Textbelt sees the report", async () => {
    const sent = textbelt();
    await textOwner(
      "+15555550111",
      "It works [1].\n\nSources:\n[1] https://example.com/heat-pumps",
    );
    expect(sent().message).toBe("It works [1].");
  });

  test("a recipient with no TEXTBELT_KEY fails the step for good, naming the key", async () => {
    vi.stubEnv("TEXTBELT_KEY", "");
    vi.stubEnv("SMS_TO_PHONE", "+15555550100");
    await expect(textOwner(undefined, "The report.")).rejects.toMatchObject({
      name: "FatalError",
      message: expect.stringContaining("TEXTBELT_KEY"),
    });
  });

  test("a refusal is an answer, not a failed run, and never quotes the key", async () => {
    vi.stubEnv("TEXTBELT_KEY", "test-key-123456");
    vi.stubEnv("SMS_TO_PHONE", "+15555550100");
    installStubStepFetch(() => ({
      body: {
        success: false,
        error:
          "Sorry, ability to send URLs via text is limited to verified accounts. Please go to https://textbelt.com/whitelist?key=test-key-123456 or email support.",
      },
    }));
    const texted = await textOwner(undefined, "The report.");
    expect(texted).toMatchObject({
      sent: false,
      why: expect.stringContaining("verified accounts"),
    });
    expect(JSON.stringify(texted)).not.toContain("test-key-123456");
  });
});

describe("the announcement", () => {
  test("says the summary on the speaker under the run id", async () => {
    installStubSpeech({ pcmBytes: 3200 });
    const inbox = installStubClientInbox();
    const ctx = createWorkflowContext({ runId: "wrun_9", results: stages });
    await researchWorkflow.run({ topic: "heat pumps", clientId: "kitchen" }, ctx);
    expect(inbox.calls).toMatchObject([
      {
        clientId: "kitchen",
        notice: {
          id: "wrun_9",
          event: "research",
          data: {
            topic: "heat pumps",
            said: "Your research on heat pumps is ready. Rebates make them affordable.",
          },
        },
      },
    ]);
  });

  test("and whether the report was texted", () => {
    expect(readyText("heat pumps", "They work.", { sent: true })).toBe(
      "Your research on heat pumps is ready. They work. I've texted you the full report.",
    );
    expect(readyText("heat pumps", "They work.", { sent: false, why: "no credit" })).toBe(
      "Your research on heat pumps is ready. They work. I couldn't text you the full report: no credit",
    );
  });
});
