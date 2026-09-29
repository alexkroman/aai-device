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
    "the speaker says the answer when it's done, usually within a minute. First say one " +
    `short sentence that you're on it and will let them know, e.g. "${HANDOFF_LINE}", ` +
    "then call this. Before anything that sends, posts, books, buys, deletes or changes " +
    "something, say exactly what you'll do and call this only after they say yes, with " +
    "'they confirmed' in the task. Set text only when they asked to be texted the " +
    "answer; otherwise never offer or mention a text.",
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
      .describe("True only if they asked to be texted the answer; else it is only said"),
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
