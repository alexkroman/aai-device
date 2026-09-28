import { tool } from "@alexkroman1/aai";
import { z } from "zod";

// Cancels timers on the device (see set_timer.ts). A ringing timer is stopped by
// saying the wake word, not by this.
export default tool({
  description:
    "Cancel a timer running on the speaker. Pass its label to cancel just that one; " +
    "leave it out to cancel every timer.",
  inputSchema: z.object({
    label: z.string().max(30).optional().describe("The label the timer was set with, e.g. 'pasta'"),
  }),
  execute({ label }, ctx) {
    ctx.send("timer.cancel", { label });
    return { cancelled: true };
  },
});
