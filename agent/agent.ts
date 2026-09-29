import { agent } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { sessionContext } from "./context.ts";
import { routes } from "./routes.ts";
import { appEvent, appJob, call, emailResult, memorize, remind, research } from "./shared.ts";

// The whole agent: this file and `system-prompt.md` beside it, which is found
// by WHERE IT SITS rather than imported.
//
// The default all-AssemblyAI cascaded pipeline, billed to ASSEMBLYAI_API_KEY,
// with only the stt stage declared (to turn Voice Focus off).
export default agent({
  name: "Home Speaker",
  // One line for whoever is reading a LIST of agents — `aai list`, a registry
  // page, the studio's picker. Never the model: what the model is told is
  // `system-prompt.md`, beside this file.
  description: "Alexa-style assistant for the ESP32-S3 audio board",
  // The first thing a caller hears. Without one the agent waits for them to
  // speak, which on a phone call reads as a dead line.
  // The device connects with ?resume=1 and plays its own chime, so this is
  // only heard by browser clients of `aai dev`.
  greeting: "Hi, what can I do for you?",
  // Any name from `ASSEMBLYAI_TTS_VOICES`. It is sugar for a `tts` descriptor,
  // so declaring `tts: assemblyAITts({ voice })` yourself is the same thing
  // spelled out — and either one replaces only the speaking stage.
  voice: "jane",
  // Voice Focus (the SDK default is `near-field` / 0.9, tuned for a handset at
  // the mouth) is off. The mic audio is already the board AFE's output (AEC +
  // 2-mic beamforming, see firmware voice.c), and a talker across the room is
  // exactly what near-field suppression treats as background.
  stt: assemblyAIStt({ voiceFocus: "off" }),
  // Host-side tools, enabled by name. Setting this REPLACES the default
  // (`["think"]`), so `think` is listed to keep it. `open_meteo`, `calculate`
  // and `visit_webpage` are keyless; the rest read their keys from `.env`.
  // `text_me` texts the browser's reported phone, else SMS_TO_PHONE, via Textbelt.
  // The device's `?location=` (CONFIG_AAI_DEVICE_ADDRESS) is what "near me"
  // and "the weather" default to.
  builtinTools: [
    "think",
    "open_meteo",
    "brave_search",
    "google_places",
    "calculate",
    "visit_webpage",
    // Model-written JavaScript, run in a zero-permission Deno sandbox (no network, files,
    // env or subprocesses; 5 s): `make agent` sets AAI_RUN_CODE=deno. Without it the
    // SDK refuses every call rather than run the code in this process.
    "run_code",
    // Not "text_me": tools/text_me.ts replaces it, with links taken out until the
    // Textbelt key is verified to send them.
  ],
  // Reminders (tools/remind_me.ts): a durable run per reminder that sleeps until it is due
  // and pushes the spoken reminder to the speaker's inbox socket. Under `aai dev` without a
  // DATABASE_URL a pending reminder lives only as long as the dev server.
  // Deep research (tools/deep_research.ts): minutes of searching and reading, so a run
  // that says a summary on the speaker when it is done, and texts the report if asked.
  // After-the-conversation memory (workflows/memorize.ts): the session's turns go to mem0,
  // which keeps what lasts, and are digested into the speaker's compacted history.
  // The household's apps (apps.ts, watches.ts), all as runs because a Composio action is
  // round trips too slow for a turn: appJob does every app task and says the answer,
  // appEvent judges and says an event from a watched app, emailResult sends email_me.
  workflows: { remind, research, memorize, call, appEvent, appJob, emailResult },
  // Every connect of a speaker (its ?client= id) is ONE long conversation: the SDK
  // replays the last few hours verbatim, and this adds everything older, compacted, plus
  // all that mem0 holds about the household (context.ts). Fixed for the session.
  sessionContext: ({ sessionId, clientId, env, signal }) =>
    sessionContext({ sessionId, clientId, env, signal }),
  // The page's sidebar: profile, memories, context, sessions, running tasks, linking
  // (routes.ts), served under /api.
  routes,
  // Keyed by session AND watermark: a session resumed and hung up again is memorized from
  // where the last run stopped, and a repeated end is the same run.
  onSessionEnd: async ({ sessionId, clientId, workflows, lastEventIndex }) => {
    if (!clientId || lastEventIndex < 0) return;
    await workflows.start(
      memorize,
      { clientId, sessionId, throughEvent: lastEventIndex },
      { key: `${sessionId}:${lastEventIndex}` },
    );
  },
  // Declared so a deploy refuses to start without them rather than the tools
  // apologizing on every call.
  requiredEnv: [
    "BRAVE_API_KEY",
    "GOOGLE_PLACES_API_KEY",
    "TEXTBELT_KEY",
    "SMS_TO_PHONE",
    "MEM0_API_KEY",
    // The household's apps (apps.ts): find_app_action, run_app_action and the page's Apps.
    "COMPOSIO_API_KEY",
  ],
});
