import { isClockTime, spokenDate, spokenTime, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { appEventFlow } from "./workflows/app-event.ts";
import { appJobFailure, appJobFlow } from "./workflows/app-job.ts";
import { callFlow } from "./workflows/call.ts";
import { emailFlow } from "./workflows/email.ts";
import { memorizeFlow } from "./workflows/memorize.ts";
import { remindFlow } from "./workflows/remind.ts";
import { researchWorkflow } from "./workflows/research.ts";

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

/** deepResearchWorkflow's definition, declared with its input and failure handling. */
export const research = researchWorkflow;

export const call = workflow({
  description: "Dial a call the household approved, wait for it to end, and say how it went",
  input: z.object({
    callId: z.string().describe("The approved calls row (tools/place_call.ts)"),
    clientId: z.string().describe("The speaker that asked, told the outcome"),
  }),
  run: callFlow,
});

export const appEvent = workflow({
  description: "Judge an event from a watched app and say it on the speaker if it was wanted",
  input: z.object({
    clientId: z.string().describe("The speaker that asked to be told (its ?client= id)"),
    instruction: z.string().describe("What they asked to be told about, in their words"),
    app: z.string().describe("The app it came from, e.g. gmail"),
    trigger: z.string().describe("The Composio trigger that fired"),
    event: z.string().describe("The event, compacted (watches.ts eventText)"),
  }),
  run: appEventFlow,
});

export const appJob = workflow({
  description: "Do a task on the household's apps, say the answer, and text it if asked",
  input: z.object({
    task: z.string().describe("The task, with every detail they gave"),
    clientId: z.string().describe("The speaker it runs for: its apps, and where it's said"),
    phone: z.string().optional().describe("The number the client reported; else SMS_TO_PHONE"),
    text: z.boolean().optional().describe("Whether they asked for the answer by text"),
  }),
  run: appJobFlow,
  // Said on the speaker when the run fails for good, or a failed job is silence.
  onFailure: appJobFailure,
});

export const emailResult = workflow({
  description: "Email something to the household's saved address, from the speaker's Gmail",
  input: z.object({
    clientId: z.string().describe("The speaker whose connected Gmail sends it"),
    subject: z.string().describe("The subject line"),
    body: z.string().describe("The email, written to be read"),
  }),
  run: emailFlow,
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
 * When a reminder is due: `inSeconds` from now, or the next `at` ("17:30", 24-hour,
 * zero-padded: the tool's `clockTime` field) in this machine's time zone — the agent runs
 * on a computer in the home, so its clock is the speaker's. The model does not know the
 * time, so it passes what they SAID and this does the arithmetic. Undefined when neither
 * (or an `at` isClockTime refuses, like "9:30" or "24:00") was given.
 */
export function reminderDueAt(
  now: Date,
  when: { inSeconds?: number | undefined; at?: string | undefined },
): number | undefined {
  if (when.inSeconds !== undefined) return now.getTime() + when.inSeconds * 1000;
  if (when.at === undefined || !isClockTime(when.at)) return undefined;
  const [h, m] = when.at.split(":").map(Number);
  const due = new Date(now);
  due.setHours(h ?? 0, m ?? 0, 0, 0);
  if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  return due.getTime();
}

const pad = (n: number) => String(n).padStart(2, "0");
/** A Date's LOCAL wall clock as the SDK's spoken formatters take it: "HH:MM", "YYYY-MM-DD". */
const localClock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * "5:30 PM", "tomorrow at 7 AM", "Wednesday at 7 AM" — what the agent says back. The SDK's
 * spokenTime drops ":00" on the hour, which a TTS engine would read as "zero zero". The
 * weekday alone names a day this week; a week out (the MAX_REMINDER_MS edge) is today's
 * weekday again, so that one gets spokenDate's month and day too: "Monday, October 5 at 2 PM".
 */
export function spokenDue(now: Date, dueAt: number): string {
  const due = new Date(dueAt);
  const time = spokenTime(localClock(due));
  const day = localDay(due);
  if (day === localDay(now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (day === localDay(tomorrow)) return `tomorrow at ${time}`;
  // spokenDate is "Monday, June 8": its weekday is everything before the comma.
  const date = spokenDate(day);
  const aWeekOut = new Date(now);
  aWeekOut.setDate(now.getDate() + 7);
  // YYYY-MM-DD compares as a string, and by DAY: next Monday at 9 is under seven days from
  // Monday at 2 but is still a Monday.
  return `${day < localDay(aWeekOut) ? date.split(",")[0] : date} at ${time}`;
}
