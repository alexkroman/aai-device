import { agent } from "@alexkroman1/aai";

// The whole agent: this file and `system-prompt.md` beside it, which is found
// by WHERE IT SITS rather than imported.
//
// No providers declared: the agent runs the default all-AssemblyAI cascaded
// pipeline, billed to ASSEMBLYAI_API_KEY. Declare any of stt/llm/tts to swap a
// single stage.
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
  // Host-side tools, enabled by name. Setting this REPLACES the default
  // (`["think"]`), so `think` is listed to keep it. `open_meteo` is keyless.
  builtinTools: ["think", "open_meteo"],
});
