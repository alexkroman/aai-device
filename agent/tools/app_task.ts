import { sessionClientId, sessionClientPhone, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { appJob } from "../shared.ts";

// EVERYTHING on the household's apps goes through here: "what's on my calendar", "email Sam
// I'm running late", "summarize my last 50 emails", "tell me when Sam emails". A Composio
// action is round trips too slow to hold the turn for, so this starts a durable run
// (workflows/app-job.ts) and answers now; the run SAYS the answer on the speaker when it
// is done, the way a reminder rings. It is texted too only when they asked for a text.

/** What the agent says as it hands the job off, when it didn't already say something like it. */
export const HANDOFF_LINE = "On it. I'll let you know when it's done.";
/** The handoff when they asked for the answer by text. */
export const TEXT_HANDOFF_LINE = "On it. I'll text it to you when it's done.";

export default tool({
  description:
    "Do anything in their own apps (email, calendar, Slack, documents, tasks, notes and " +
    "more): look something up, summarize, send, create, update, or tell them later when " +
    "something happens (e.g. 'tell me when Sam emails'). It runs in the background and " +
    "the speaker says the answer when it's done, usually within a minute. Call it, then " +
    "say only the say_if_not_said line it returns, nothing more. Reading, searching or " +
    "summarizing needs no yes, even when the answer is to be texted to them: call it " +
    "straight away. Before an email or message to someone else, a post, booking, " +
    "purchase, deletion or change, say exactly what you'll do and call this only after " +
    "they say yes, with 'they confirmed' in the task. Set text to true when they asked to be texted the " +
    "answer (writing 'text me' in the task sends nothing); otherwise never offer or " +
    "mention a text.",
  inputSchema: z.object({
    task: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe(
        "The whole task with every detail they gave, e.g. 'list my calendar events for " +
          "today' or 'email sam@example.com that I'm 10 minutes late; they confirmed'",
      ),
    text: z
      .boolean()
      .optional()
      .describe(
        "REQUIRED true whenever they said 'text me' or asked for the answer by text: the " +
          "task wording alone does not send a text. Else leave it out; the answer is said.",
      ),
  }),
  async execute({ task, text = false }, ctx) {
    const clientId = sessionClientId(ctx);
    if (!clientId) return toolFailure("Apps work on a speaker or its linked page only.");
    // Keyed by the speaker, so its Running panel can find the run (GET /api/tasks).
    const phone = sessionClientPhone(ctx);
    await ctx.workflows.start(
      appJob,
      { task, clientId, phone, text },
      { key: clientId, label: task },
    );
    return {
      started: true,
      // Said as the reply unless the agent already said it's on it before calling.
      say_if_not_said: text ? TEXT_HANDOFF_LINE : HANDOFF_LINE,
      delivery: text
        ? "the speaker says the answer out loud when it's done, and texts it"
        : "the speaker says the answer out loud when it's done; nothing is texted",
    };
  },
});
