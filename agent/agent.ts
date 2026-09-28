import { agent } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";

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
  // and `visit_webpage` are keyless; the other two read their keys from `.env`.
  // The device's `?location=` (CONFIG_AAI_DEVICE_ADDRESS) is what "near me"
  // and "the weather" default to.
  builtinTools: [
    "think",
    "open_meteo",
    "brave_search",
    "google_places",
    "calculate",
    "visit_webpage",
  ],
  // Declared so a deploy refuses to start without them rather than the tools
  // apologizing on every call.
  requiredEnv: ["BRAVE_API_KEY", "GOOGLE_PLACES_API_KEY"],
});
