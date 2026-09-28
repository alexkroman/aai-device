import { workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { memorizeFlow } from "./workflows/memorize.ts";
import { remindFlow } from "./workflows/remind.ts";
import { researchFlow } from "./workflows/research.ts";

// The workflows' declarations, in a module both agent.ts and the tools import:
// ctx.workflows.start(remind, …) takes the definition, and a tool cannot import agent.ts
// (the bundle is agent.ts plus every tools/ file, so that import closes a cycle).

export const remind = workflow({
  description: "Say a reminder on the speaker when it is due",
  input: z.object({
    clientId: z.string().describe("The speaker to say it on (its ?client= id)"),
    text: z.string().describe("What to remind them of"),
    dueAt: z.number().describe("When, as epoch milliseconds"),
  }),
  run: remindFlow,
});

export const research = workflow({
  description: "Research a topic in depth, text the report, and announce it on the speaker",
  input: z.object({
    topic: z.string().describe("What to research, as they asked it"),
    clientId: z.string().optional().describe("The speaker to announce it on, if any"),
    phone: z.string().optional().describe("The number the client reported; else SMS_TO_PHONE"),
  }),
  run: researchFlow,
});

export const memorize = workflow({
  description: "After a conversation: keep its lasting facts in mem0 and digest it",
  input: z.object({
    clientId: z.string().describe("The speaker the conversation was on (its ?client= id)"),
    sessionId: z.string().describe("The session that ended"),
    throughEvent: z.number().describe("Its last event index: the digest's watermark"),
  }),
  run: memorizeFlow,
});

/** Longest a reminder may wait: the run parks that long, and past a week it is a calendar. */
export const MAX_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When a reminder is due: `inSeconds` from now, or the next `at` ("17:30", 24-hour) in
 * this machine's time zone — the agent runs on a computer in the home, so its clock is
 * the speaker's. The model does not know the time, so it passes what they SAID and this
 * does the arithmetic. Undefined when neither (or an unreadable `at`) was given.
 */
export function reminderDueAt(
  now: Date,
  when: { inSeconds?: number | undefined; at?: string | undefined },
): number | undefined {
  if (when.inSeconds !== undefined) return now.getTime() + when.inSeconds * 1000;
  const m = when.at?.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return undefined;
  const due = new Date(now);
  due.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  return due.getTime();
}

/** "5:30 PM", or "tomorrow at 7:00 AM" — what the agent says back. */
export function spokenDue(now: Date, dueAt: number): string {
  const due = new Date(dueAt);
  const time = due.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (due.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (due.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${due.toLocaleDateString("en-US", { weekday: "long" })} at ${time}`;
}
