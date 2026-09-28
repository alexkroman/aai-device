import { sessionClientId, tool } from "@alexkroman1/aai";
import { remind } from "../shared.ts";

// Every reminder set from this speaker is a run keyed by its client id, so "cancel my
// reminders" is find-by-key and cancel whatever has not fired yet.

export default tool({
  description:
    "Cancel every reminder that has not gone off yet on this speaker, e.g. 'cancel my " +
    "reminders' or 'never mind the plumber reminder'.",
  async execute(_args, ctx) {
    const clientId = sessionClientId(ctx);
    if (!clientId) return { cancelled: 0 };
    const runs = await ctx.workflows.find(remind, clientId);
    let cancelled = 0;
    for (const run of runs) {
      if (run.status === "pending" || run.status === "running") {
        if (await ctx.workflows.cancel(run.runId)) cancelled++;
      }
    }
    return { cancelled };
  },
});
