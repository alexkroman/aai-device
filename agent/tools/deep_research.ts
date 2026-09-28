import { sessionClientId, sessionClientPhone, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { research } from "../shared.ts";
import { labelTask } from "../tasks.ts";

// "Do some deep research on heat pumps for an old house." Minutes of work, so it can't
// happen in this conversation: this starts a durable run (workflows/research.ts) and
// answers now. The run texts the report to the session's phone (the one the browser
// reported, else SMS_TO_PHONE) and, on a speaker, says a summary when it is done.
export default tool({
  description:
    "Start a deep research job that takes a few minutes: several searches and pages " +
    "read, then a written report. Use it when they ask you to research, look into, " +
    "dig into, or compare something in depth, not for a quick fact you can search " +
    "now. The report is texted to them and the speaker says a summary when it's done.",
  inputSchema: z.object({
    topic: z
      .string()
      .min(3)
      .max(300)
      .describe(
        "What to research, with every detail they gave, e.g. 'heat pumps for a 1920s house in Portland'",
      ),
  }),
  async execute({ topic }, ctx) {
    const clientId = sessionClientId(ctx);
    const phone = sessionClientPhone(ctx);
    // Keyed by the speaker, so its Running panel can find the run (GET /api/tasks).
    const runId = await ctx.workflows.start(
      research,
      { topic, clientId, phone },
      clientId ? { key: clientId } : {},
    );
    if (clientId) await labelTask(ctx, { runId, clientId, workflow: "research", title: topic });
    return {
      started: true,
      // What the model can promise: the speaker only announces to a speaker.
      delivery: clientId ? "texted, and announced on the speaker" : "texted",
    };
  },
});
