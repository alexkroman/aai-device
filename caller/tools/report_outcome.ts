import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { finishCall } from "../call.ts";

// What the household is told when the call is over (agent/workflows/call.ts reads it back
// and says it on the speaker). Called once the goal is settled, just before end_call.
export default tool({
  description:
    "Record how the call went, for the person you're calling for, before you end the call: " +
    "one or two sentences with every concrete detail (times, names, prices, confirmation " +
    "numbers), or what went wrong and what they'd need to do.",
  inputSchema: z.object({
    outcome: z
      .string()
      .min(3)
      .max(600)
      .describe("e.g. 'Booked a table for 4 at 7:15 tonight under Sam; they hold it 15 minutes.'"),
  }),
  async execute({ outcome }, ctx) {
    await finishCall(ctx, ctx.sessionId, { outcome });
    return { recorded: true };
  },
});
