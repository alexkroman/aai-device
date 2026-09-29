import { sessionClientId, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { MAX_EMAIL_CHARS } from "../email.ts";
import { emailResult } from "../shared.ts";

// "Email me that." To the address saved on the page, from their own Gmail (email.ts).
// Where text_me can't go: links, and anything too long for a text. Sent by a run
// (workflows/email.ts), because Gmail through Composio is too slow to hold the turn for;
// the speaker says so only if it didn't go.
export default tool({
  description:
    "Email something to their own saved address (it is set on the speaker's page, never " +
    "chosen here): search results with links, a recipe, directions, a list, anything too " +
    "long to say or with links a text can't carry. Offer first (\"Want me to email you " +
    "that?\") and send when they agree or ask to be emailed; then just say it's on its " +
    "way. The speaker tells them if it couldn't be sent.",
  inputSchema: z.object({
    subject: z.string().trim().min(1).max(150).describe("A short subject line"),
    body: z
      .string()
      .trim()
      .min(1)
      .max(MAX_EMAIL_CHARS)
      .describe("The full version, written to be read: plain text, links as full URLs"),
  }),
  async execute({ subject, body }, ctx) {
    const clientId = sessionClientId(ctx);
    if (!clientId) return toolFailure("Email works on a speaker or its linked page only.");
    // Keyed by the speaker, so its Running panel shows it (GET /api/tasks).
    await ctx.workflows.start(
      emailResult,
      { clientId, subject, body },
      { key: clientId, label: `Email: ${subject}` },
    );
    return { sending: true };
  },
});
