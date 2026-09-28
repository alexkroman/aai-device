import { tool } from "@alexkroman1/aai";

// "Computer, stop." The device does the work (firmware main.c): it silences a notice that
// is playing, aborts whatever reply is coming and hangs up — so nothing the
// model writes after this call is ever heard. A reply here would just be the speaker
// talking back after being told to stop.

declare module "@alexkroman1/aai" {
  interface ClientEventMap {
    stop: Record<string, never>;
  }
}

export default tool({
  description:
    "Stop everything on the speaker: silences what it is saying and ends the " +
    "conversation. Use when they just say 'stop', 'cancel', 'never mind', " +
    "'be quiet' or 'that's all'. Say nothing after calling it.",
  execute(_args, ctx) {
    ctx.send("stop", {});
    return { stopped: true };
  },
});
