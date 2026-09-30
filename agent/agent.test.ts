/** The def a DEPLOYED agent runs: authored, plus `tools/` and `system-prompt.md`. */
import deployedDef from "virtual:aai/agent";
import { assemblyAIPipeline, DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { expectDeployable, expectPromptBuiltinsDeclared } from "@alexkroman1/aai/testing";
import { installFetchRoutes, installStubWorkflows } from "@alexkroman1/aai/testing/vitest";
import { assemblyAITts } from "@alexkroman1/aai/tts";
import { afterEach, describe, expect, test, vi } from "vitest";
import agentDef from "./agent.ts";
import { VERBATIM_WINDOW_MS } from "./history-window.ts";
import { appEvent, appJob, call, emailResult, memorize, remind, research } from "./shared.ts";

// The speaker agent's wiring: what it deploys with, what it may call, and what happens
// around a session. What each tool, workflow and route DOES is in its own spec.

const signal = new AbortController().signal;
const env = {
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_SECRET_KEY: "sb-test",
  MEM0_API_KEY: "m0-test",
};
const sessionContext = agentDef.sessionContext as NonNullable<typeof agentDef.sessionContext>;
const onSessionEnd = agentDef.onSessionEnd as NonNullable<typeof agentDef.onSessionEnd>;

/** Supabase and mem0 answering by URL; anything unrouted is a 404. */
function backends(routes: { profile?: unknown; memories?: unknown; down?: boolean }) {
  const down = { status: 503, body: "down" };
  return installFetchRoutes(
    {
      "http://supabase.test/rest/v1/profile": routes.down ? down : { body: routes.profile ?? [] },
      "http://supabase.test/rest/v1/": routes.down ? down : { body: [] },
      "api.mem0.ai": routes.down ? down : { body: { results: routes.memories ?? [] } },
    },
    { unmatched: "notFound" },
  );
}
afterEach(() => vi.restoreAllMocks());

describe("the speaker agent", () => {
  test("is deployable as a pipeline: AssemblyAI stt without Voice Focus, the default llm, jane", () => {
    const config = expectDeployable(deployedDef);
    expect(config.name).toBe("Home Speaker");
    expect(config.mode).toBe("pipeline");
    // Voice Focus is off because the board's AFE already beamforms, and near-field
    // suppression treats a talker across the room as background.
    expect(config.stt).toEqual(assemblyAIStt({ voiceFocus: "off" }));
    expect(config.llm).toEqual(assemblyAIPipeline().llm);
    expect(config.tts).toEqual(assemblyAITts({ voice: "jane" }));
    expect(config.s2s).toBeUndefined();
  });

  test("greets only browser clients; the device resumes and plays its own chime", () => {
    expect(agentDef.greeting).toBe("Hi, what can I do for you?");
    expect(agentDef.description).toMatch(/ESP32-S3/);
  });

  test("the builtins are pinned, with think kept and the SDK's text_me", () => {
    // Order-sensitive on purpose: a builtin added or dropped should be a diff here.
    expect(deployedDef.builtinTools).toEqual([
      "think",
      "open_meteo",
      "brave_search",
      "google_places",
      "calculate",
      "visit_webpage",
      "run_code",
      "text_me",
    ]);
  });

  test("notices are spoken at the board's own rate, so the firmware needs no resampler", () => {
    expect(agentDef.clientInbox?.sampleRate).toBe(16_000);
  });

  test("the custom tools are exactly tools/, and none shadows a declared builtin", () => {
    const tools = Object.keys(deployedDef.tools ?? {}).sort();
    expect(tools).toEqual([
      "air_quality",
      "app_task",
      "cancel_reminders",
      "confirm_phone",
      "deep_research",
      "email_me",
      "forget",
      "link_browser",
      "place_call",
      "pollen",
      "prepare_call",
      "recall",
      "remember",
      "remind_me",
      "stop",
      "update_profile",
    ]);
    const builtins = new Set<string>(deployedDef.builtinTools ?? []);
    expect(tools.filter((t) => builtins.has(t))).toEqual([]);
  });

  test("the prompt is system-prompt.md, and every tool it names is one the model can call", () => {
    // deployedDef, not agentDef: the raw export carries the framework default, which
    // could not notice the file going missing.
    const prompt = String(deployedDef.systemPrompt);
    expect(prompt).not.toBe(DEFAULT_SYSTEM_PROMPT);
    const tools = Object.keys(deployedDef.tools ?? {});
    // `remember` counts because tools/remember.ts, of a builtin's name, declares it.
    expect(expectPromptBuiltinsDeclared(deployedDef).sort()).toEqual([
      "brave_search",
      "calculate",
      "open_meteo",
      "remember",
      "run_code",
      "text_me",
      "visit_webpage",
    ]);
    const named = new Set(prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []);
    // Words the prompt quotes from tool inputs and results, not tool names.
    for (const word of ["in_seconds", "read_back", "say_if_not_said"]) named.delete(word);
    // The scan above only sees snake_case; these are named by a single word. The SDK
    // finds calculate and remember itself, but not "recall only when" in plain prose.
    for (const word of ["pollen", "stop", "recall", "forget"]) {
      expect(prompt).toMatch(new RegExp(`\\b${word}\\b`));
      named.add(word);
    }
    const callable = new Set([...tools, ...(deployedDef.builtinTools ?? [])]);
    expect([...named].filter((n) => !callable.has(n))).toEqual([]);
  });

  test("the prompt keeps the speaker's rules: spoken, short, no URLs, confirmed actions", () => {
    const prompt = String(deployedDef.systemPrompt);
    expect(prompt).toContain("never use lists, markdown, or");
    expect(prompt).toContain("Never read a URL aloud.");
    expect(prompt).toContain("Never text them unless they ask you to");
    // Calls and app writes are the two things that act in the world: both wait for a yes.
    expect(prompt).toContain("call place_call only after\na clear yes");
    expect(prompt).toContain("Never place a\ncall they did not just approve");
    expect(prompt).toMatch(/a\s+post, a booking, a purchase, a deletion or a change/);
    expect(prompt).toMatch(/wait for a yes,\s+and do not call\s+app_task yet/);
    // …and a read never waits, texted or not: asking first made "text me what you find" stall.
    expect(prompt).toMatch(/Reading, searching or summarizing their accounts never needs a yes/);
    expect(prompt).toMatch(/call the stop\s+tool and say nothing at all/);
  });

  test("its workflows are the shared.ts definitions the tools start", () => {
    // Identity, not shape: ctx.workflows.start(remind, …) in a tool is matched to the
    // registered run by this object.
    const shared = { remind, research, memorize, call, appEvent, appJob, emailResult };
    const workflows: Record<string, unknown> = agentDef.workflows ?? {};
    expect(Object.keys(workflows).sort()).toEqual(Object.keys(shared).sort());
    for (const [name, wf] of Object.entries(shared)) expect(workflows[name], name).toBe(wf);
  });

  test("the page's API is exactly these routes, since each is open to the LAN", () => {
    expect(Object.keys(agentDef.routes ?? {}).sort()).toEqual([
      "DELETE /apps/:app",
      "DELETE /context/digests/:sessionId",
      "DELETE /memories/:id",
      "DELETE /tasks/:runId",
      "DELETE /watches/:id",
      "GET /apps",
      "GET /context",
      "GET /link",
      "GET /memories",
      "GET /profile",
      "GET /sessions",
      "GET /tasks",
      "GET /watches",
      "POST /apps/:app/connect",
      "POST /composio/webhook",
      "POST /link",
      "POST /memories",
      "PUT /context/digests/:sessionId",
      "PUT /context/older",
      "PUT /memories/:id",
      "PUT /profile",
    ]);
  });

  test("a deploy refuses to start without Supabase or the tools' keys", () => {
    expect(agentDef.requiredEnv).toEqual([
      "SUPABASE_URL",
      "SUPABASE_SECRET_KEY",
      "BRAVE_API_KEY",
      "GOOGLE_PLACES_API_KEY",
      "TEXTBELT_KEY",
      "SMS_TO_PHONE",
      "MEM0_API_KEY",
      "COMPOSIO_API_KEY",
    ]);
    expect(expectDeployable(deployedDef).requiredEnv).toEqual(agentDef.requiredEnv);
  });
});

describe("a session's start", () => {
  test("the saved home address becomes the session's location, and history is windowed", async () => {
    const net = backends({
      profile: [{ key: "home_address", value: "742 Evergreen Terrace, Springfield" }],
      memories: [{ id: "m1", memory: "Biscuit the dog is allergic to chicken" }],
    });
    const before = Date.now();
    const ctx = await sessionContext({ sessionId: "s1", clientId: "spk-1", env, signal });
    expect(ctx?.location).toBe("742 Evergreen Terrace, Springfield");
    expect(ctx?.instructions).toContain("Biscuit the dog is allergic to chicken");
    // The SDK replays the last VERBATIM_WINDOW_MS word for word; context.ts summarizes
    // only what is older, so the two must agree on the boundary.
    expect(ctx?.historySince).toBeGreaterThanOrEqual(before - VERBATIM_WINDOW_MS);
    expect(ctx?.historySince).toBeLessThanOrEqual(Date.now() - VERBATIM_WINDOW_MS);
    expect(ctx?.refuse).toBeUndefined();
    // The speaker's own history is looked up by its client id.
    expect(
      net.to("http://supabase.test/rest/v1/conversation_digests?client_id=eq.spk-1"),
    ).not.toEqual([]);
    expect(net.to("http://supabase.test/rest/v1/older_history?client_id=eq.spk-1")).not.toEqual([]);
  });

  test("no speaker id, no speaker history; no saved address, the client's location stands", async () => {
    const net = backends({});
    const ctx = await sessionContext({ sessionId: "s1", env, signal });
    expect(ctx?.location).toBeUndefined();
    expect(net.to(/conversation_digests|older_history/)).toEqual([]);
  });

  test("a backend outage never refuses the session: it starts, saying memory is unreachable", async () => {
    backends({ down: true });
    // context.ts logs the lost write of what the session was told; expected here.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = await sessionContext({ sessionId: "s1", clientId: "spk-1", env, signal });
    expect(ctx?.refuse).toBeUndefined();
    expect(ctx?.instructions).toContain("could not be reached");
    expect(ctx?.location).toBeUndefined();
  });
});

describe("a session's end", () => {
  test("memorizes the conversation, keyed and deduped by session and watermark", async () => {
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    await onSessionEnd({ sessionId: "s1", clientId: "spk-1", env, workflows, lastEventIndex: 41 });
    expect(workflows.start).toHaveBeenCalledWith(
      memorize,
      { clientId: "spk-1", sessionId: "s1", throughEvent: 41 },
      { key: "s1:41", dedupeKey: "s1:41" },
    );
  });

  test("nothing to memorize without a speaker, or before the first event", async () => {
    const workflows = installStubWorkflows();
    await onSessionEnd({ sessionId: "s1", env, workflows, lastEventIndex: 41 });
    await onSessionEnd({ sessionId: "s1", clientId: "spk-1", env, workflows, lastEventIndex: -1 });
    expect(workflows.start).not.toHaveBeenCalled();
  });
});
