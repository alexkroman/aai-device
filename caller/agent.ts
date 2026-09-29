import { agent } from "@alexkroman1/aai";
import { appendTurn, callGreeting, claimCall, finishCall, taskInstructions } from "./call.ts";

// The agent that makes the household's phone calls. The speaker (../agent) drafts a call,
// the household approves it out loud, and the speaker's `call` workflow asks Twilio to dial
// and stream the answered call here, to `WS /phone`. Its own project, apart from the
// speaker, because this server is reachable from the internet through a tunnel (make
// caller): nothing of the household's (profile, memories, the /api the page edits) lives
// here, and any session that isn't an approved call is refused before a word is said.
export default agent({
  name: "Home Speaker Caller",
  description: "Places phone calls the household approved, on its behalf",
  // Spoken the moment the call connects: silence on an outbound call reads as a dead
  // line (the first live call sat waiting for the callee to speak). The disclosure comes
  // first, then a pause for them to say they have a moment; the purpose follows in the
  // first reply. sessionContext replaces it per call with the owner's name (callGreeting);
  // this is what a call whose task can't name one says.
  greeting: callGreeting(""),
  voice: "jane",
  telephony: ["twilio"],
  // Only its own two tools: no search, no texting, no memory. A call does one thing.
  builtinTools: [],
  requiredEnv: ["SUPABASE_URL", "SUPABASE_SECRET_KEY"],
  async sessionContext({ sessionId, call, env, signal }) {
    const callId = call?.parameters.call;
    if (!call || !callId) return { refuse: "not a placed call" };
    try {
      const task = await claimCall({ env, signal }, callId, sessionId);
      if (!task) return { refuse: "no approved call with that id" };
      return { instructions: taskInstructions(task), greeting: callGreeting(task.owner_name) };
    } catch {
      // In doubt, refuse: a session that can't be tied to an approved call must not talk.
      return { refuse: "could not load the call" };
    }
  },
  // The transcript, turn by turn as it is said, so a dropped call still has one.
  events: {
    "user-transcript.committed": (e, ctx) => {
      appendTurn(ctx, ctx.sessionId, "them", e.text).catch(() => {});
    },
    "agent-transcript.committed": (e, ctx) => {
      if (!e.recovery) appendTurn(ctx, ctx.sessionId, "assistant", e.text).catch(() => {});
    },
  },
  onSessionEnd: async ({ sessionId, env }) => {
    await finishCall({ env }, sessionId, { status: "ended", ended_at: new Date().toISOString() });
  },
});
