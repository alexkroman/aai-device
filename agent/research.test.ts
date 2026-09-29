import {
  createStubWorkflows,
  createToolContext,
  runTool,
  stubClientInbox,
  stubSpeech,
} from "@alexkroman1/aai/testing";
import { installStubStepDelegate, installStubStepFetch } from "@alexkroman1/aai/testing/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { research } from "./shared.ts";
import deepResearch from "./tools/deep_research.ts";
import { NOTICE_SAMPLE_RATE } from "./workflows/remind.ts";
import { announce, investigate, textReport, withSources } from "./workflows/research.ts";
import { allSources, citedSources, findingsText, type Note } from "./workflows/research-notes.ts";

const a = { title: "Heat pumps, explained", url: "https://example.com/a" };
const b = { title: "Cold-climate models", url: "https://example.com/b" };
const c = { title: "Rebates", url: "https://example.com/c" };
const notes: Note[] = [
  { angle: "how they work", findings: "They move heat.", sources: [a, b] },
  { angle: "cost", findings: "Rebates help.", sources: [b, c] },
];

describe("source numbering", () => {
  test("every source is numbered once across the notes, first seen first", () => {
    expect(allSources(notes)).toEqual([a, b, c]);
    const text = findingsText(notes, allSources(notes));
    expect(text).toContain("## how they work\nThey move heat.\nSources used here: [1] [2]");
    expect(text).toContain("## cost\nRebates help.\nSources used here: [2] [3]");
    expect(text).toContain("[3] Rebates (https://example.com/c)");
  });

  test("a report's citations map back to OUR urls, only the ones it used", () => {
    expect(citedSources("Cheap to run [3], and quiet [1][3].", [a, b, c])).toEqual([
      "[1] https://example.com/a",
      "[3] https://example.com/c",
    ]);
    // A number with no source behind it is dropped, not invented.
    expect(citedSources("Something [9].", [a])).toEqual([]);
  });
});

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
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({
      clientId: "kitchen",
      clientPhone: "+15555550123",
      workflows: createStubWorkflows({ start }),
    });
    const result = await runTool(deepResearch, { topic: "heat pumps for an old house" }, ctx);
    expect(result).toEqual({ started: true, delivery: "said on the speaker" });
    expect(start).toHaveBeenCalledWith(
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
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({
      clientId: "kitchen",
      workflows: createStubWorkflows({ start }),
    });
    expect(await runTool(deepResearch, { topic: "heat pumps", text: true }, ctx)).toEqual({
      started: true,
      delivery: "said on the speaker, and texted",
    });
    expect(start).toHaveBeenCalledWith(
      research,
      expect.objectContaining({ text: true }),
      expect.anything(),
    );
  });

  test("from a browser tab it texts only when asked, and otherwise starts nothing", async () => {
    const start = vi.fn(async () => "w");
    const ctx = createToolContext({ workflows: createStubWorkflows({ start }) });
    expect(await runTool(deepResearch, { topic: "heat pumps", text: true }, ctx)).toEqual({
      started: true,
      delivery: "texted",
    });
    start.mockClear();
    const refused = await runTool(deepResearch, { topic: "heat pumps" }, ctx);
    expect(JSON.stringify(refused)).toContain("Ask whether to text them");
    expect(start).not.toHaveBeenCalled();
  });
});

const brief = { brief: "Heat pumps for an old house.", criteria: ["cost"] };

describe("investigate", () => {
  test("hands the angle to a researcher on brave_search, with the brief as context", async () => {
    const desk = installStubStepDelegate({ routes: { researcher: "They work [1]." } });
    const note = await investigate(brief, "cold climates");
    expect(note.findings).toBe("They work [1].");
    expect(desk.calls[0]?.task).toBe("cold climates");
    expect(desk.calls[0]?.options.context).toContain("Heat pumps for an old house.");
    expect(desk.calls[0]?.subagent.builtinTools).toEqual(["brave_search", "visit_webpage"]);
  });

  test("a researcher that never cited falls back to the pages it opened", async () => {
    installStubStepDelegate({
      routes: {
        researcher: {
          text: "found",
          toolCalls: [{ name: "visit_webpage", input: { url: "https://example.com/a" } }],
        },
      },
    });
    const note = await investigate(brief, "cost");
    expect(note.sources).toEqual([
      { title: "https://example.com/a", url: "https://example.com/a" },
    ]);
  });
});

describe("textReport", () => {
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
    expect(await textReport({ topic: "t", phone: "+15555550111" }, "The report.")).toEqual({
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
    await textReport({ topic: "t", phone: "+15555550999" }, "The report.");
    expect(sent().phone).toBe("+15555550100");
  });

  test("with no number at all it texts no one", async () => {
    vi.stubEnv("TEXTBELT_KEY", "k");
    vi.stubEnv("SMS_TO_PHONE", "");
    const fetched = installStubStepFetch(() => ({ body: { success: true } }));
    expect(await textReport({ topic: "t" }, "r")).toEqual({ sent: false });
    expect(fetched.calls).toEqual([]);
  });

  test("links are taken out before Textbelt sees the report", async () => {
    const sent = textbelt();
    await textReport(
      { topic: "t", phone: "+15555550111" },
      "It works [1].\n\nSources:\n[1] https://example.com/heat-pumps",
    );
    expect(sent().message).toBe("It works [1].");
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
    const texted = await textReport({ topic: "t" }, "The report.");
    expect(texted).toMatchObject({
      sent: false,
      why: expect.stringContaining("verified accounts"),
    });
    expect(JSON.stringify(texted)).not.toContain("test-key-123456");
  });
});

describe("announce", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("says the summary on the speaker at the board's rate, under the run id", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    const speech = stubSpeech({ pcmBytes: 3200 });
    const inbox = stubClientInbox();
    try {
      await announce("wrun_9", { topic: "heat pumps", clientId: "kitchen" }, "They work.", {
        sent: true,
      });
      expect(speech.calls).toMatchObject([
        {
          text: "Your research on heat pumps is ready. They work. I've texted you the full report.",
          sampleRate: NOTICE_SAMPLE_RATE,
        },
      ]);
      expect(inbox.calls[0]).toMatchObject({
        clientId: "kitchen",
        notice: { id: "wrun_9", event: "research", data: { topic: "heat pumps" } },
      });
    } finally {
      speech.restore();
      inbox.restore();
    }
  });
});
