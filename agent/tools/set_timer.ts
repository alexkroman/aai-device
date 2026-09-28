import { tool } from "@alexkroman1/aai";
import { z } from "zod";

// The timer runs ON THE DEVICE, not here: the session closes seconds after the
// reply, and a timer kept on this side would have no connection left to ring
// through. This only tells the device to start one (custom.emitted, parsed in
// firmware protocol.c; tools/check_protocol_contract.py keeps the two in step).
// The device rings until someone says the wake word, or for a minute.

declare module "@alexkroman1/aai" {
  interface ClientEventMap {
    "timer.set": { seconds: number; label?: string | undefined };
    "timer.cancel": { label?: string | undefined };
  }
}

export default tool({
  description:
    "Start a countdown timer on the speaker, e.g. 'set a timer for ten minutes' or " +
    "'pasta timer, eight minutes'. Up to four can run at once. The speaker rings when it " +
    "is done; you cannot check how much time is left.",
  inputSchema: z.object({
    seconds: z
      .number()
      .int()
      .min(1)
      .max(24 * 60 * 60)
      .describe("Duration in seconds, e.g. 600 for ten minutes"),
    label: z.string().max(30).optional().describe("What it is for, if they said, e.g. 'pasta'"),
  }),
  execute({ seconds, label }, ctx) {
    ctx.send("timer.set", { seconds, label });
    return { started: true, seconds, label };
  },
});
