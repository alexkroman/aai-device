import { sessionClientId, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { MAX_REMINDER_MS, remind, reminderDueAt, spokenDue } from "../shared.ts";

// "Remind me to call the plumber at five." Held by the AGENT, not the speaker, so it outlives
// the session and a reboot: a durable run sleeps until it is due, speaks the reminder, and pushes the audio to
// the speaker's inbox socket (workflows/remind.ts). The speaker is found by the ?client= id
// it opened this session with, which is also the id its inbox socket is held under.

export default tool({
  description:
    "Set a reminder the speaker will say out loud later, e.g. 'remind me to call the " +
    "plumber at five' or 'in twenty minutes, remind me to flip the laundry'. Give exactly " +
    "one of in_seconds or at. Also for a plain countdown ('set a timer for ten minutes'): " +
    "then the text is what it was for, or 'your timer'.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(120)
      .describe("What to remind them of, as a short phrase, e.g. 'call the plumber'"),
    in_seconds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("How long from now, in seconds, when they said a duration"),
    at: z
      .string()
      .optional()
      .describe("A clock time in 24-hour HH:MM, when they said a time, e.g. '17:00' for five pm"),
  }),
  async execute({ text, in_seconds, at }, ctx) {
    const clientId = sessionClientId(ctx);
    if (!clientId) return { error: "This device can't receive reminders." };
    const now = new Date();
    const dueAt = reminderDueAt(now, { inSeconds: in_seconds, at });
    if (dueAt === undefined) return { error: "Say when: a time of day or how long from now." };
    if (dueAt - now.getTime() > MAX_REMINDER_MS) {
      return { error: "Reminders can be at most a week away." };
    }
    // The label is what the page's Running panel shows for the run.
    await ctx.workflows.start(
      remind,
      { clientId, text, dueAt },
      { key: clientId, label: `${text} · due ${spokenDue(now, dueAt)}` },
    );
    return { scheduled: true, text, due: spokenDue(now, dueAt) };
  },
});
