/** The def a DEPLOYED agent runs: authored, plus `tools/` and `system-prompt.md`. */
import deployedDef from "virtual:aai/agent";
import { assemblyAIPipeline, DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { commandedBuiltins, createStubWorkflows, expectDeployable } from "@alexkroman1/aai/testing";
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
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (routes.down) return new Response("down", { status: 503 });
    if (url.includes("/rest/v1/profile")) return Response.json(routes.profile ?? []);
    if (url.includes("api.mem0.ai")) return Response.json({ results: routes.memories ?? [] });
    if (url.includes("/rest/v1/")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  test("the builtins are pinned, with think kept and the SDK's text_me left out", () => {
    // Order-sensitive on purpose: a builtin added or dropped should be a diff here.
    expect(deployedDef.builtinTools).toEqual([
      "think",
      "open_meteo",
      "brave_search",
      "google_places",
      "calculate",
      "visit_webpage",
      "run_code",
    ]);
    // tools/text_me.ts replaces the builtin; declaring both would be two text_me tools.
    expect(deployedDef.builtinTools).not.toContain("text_me");
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
      "text_me",
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
    // Not expectPromptBuiltinsDeclared: it reads "text_me" as the undeclared builtin,
    // unaware tools/text_me.ts replaces it.
    const builtins = commandedBuiltins({ systemPrompt: prompt }).filter((b) => !tools.includes(b));
    expect(builtins.sort()).toEqual(["brave_search", "open_meteo", "run_code", "visit_webpage"]);
    const named = new Set(prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []);
    // Words the prompt quotes from tool inputs and results, not tool names.
    for (const word of ["in_seconds", "read_back", "say_if_not_said"]) named.delete(word);
    // The scan above only sees snake_case; these are named by a single word.
    for (const word of ["calculate", "pollen", "stop", "remember", "recall", "forget"]) {
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
    const fetch = backends({
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
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("/conversation_digests?client_id=eq.spk-1"))).toBe(true);
    expect(urls.some((u) => u.includes("/older_history?client_id=eq.spk-1"))).toBe(true);
  });

  test("no speaker id, no speaker history; no saved address, the client's location stands", async () => {
    const fetch = backends({});
    const ctx = await sessionContext({ sessionId: "s1", env, signal });
    expect(ctx?.location).toBeUndefined();
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(
      urls.some((u) => u.includes("conversation_digests") || u.includes("older_history")),
    ).toBe(false);
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
  function recorder() {
    const start = vi.fn(async () => "wrun_1");
    return { start, workflows: createStubWorkflows({ start }) };
  }

  test("memorizes the conversation, keyed by session and watermark", async () => {
    const { start, workflows } = recorder();
    await onSessionEnd({ sessionId: "s1", clientId: "spk-1", env, workflows, lastEventIndex: 41 });
    expect(start).toHaveBeenCalledWith(
      memorize,
      { clientId: "spk-1", sessionId: "s1", throughEvent: 41 },
      { key: "s1:41" },
    );
  });

  test("nothing to memorize without a speaker, or before the first event", async () => {
    const { start, workflows } = recorder();
    await onSessionEnd({ sessionId: "s1", env, workflows, lastEventIndex: 41 });
    await onSessionEnd({ sessionId: "s1", clientId: "spk-1", env, workflows, lastEventIndex: -1 });
    expect(start).not.toHaveBeenCalled();
  });
});
