import type { WorkflowContext } from "@alexkroman1/aai";
import { stepNotifyClient, stepSpeak } from "@alexkroman1/aai/step";

// A reminder: sleep until it is due, then say it on the speaker. The session that set it
// closed long ago, so it goes to the device's idle inbox socket (firmware inbox.c) with
// stepNotifyClient. The step's retries are the redelivery: a speaker that is unplugged,
// rebooting or mid-conversation gets it when it can take it.

export type RemindInput = { clientId: string; text: string; dueAt: number };

/** The rate the firmware plays notices at: the board's own, so it needs no resampler. */
export const NOTICE_SAMPLE_RATE = 16_000;
/** stepNotifyClient retries every 30 s, so this rides out an hour's outage. */
export const DELIVER_ATTEMPTS = 120;

export async function remindFlow(input: RemindInput, ctx: WorkflowContext) {
  await ctx.sleep("due", new Date(input.dueAt));
  const { runId } = ctx;
  await ctx.step("deliver", () => deliver(runId, input), { maxAttempts: DELIVER_ATTEMPTS });
  return { delivered: true };
}

/**
 * Speak and push in ONE step, so a retry speaks again rather than the audio crossing the
 * journal. The run id is the notice id: a redelivery after a lost ack is a repeat the
 * device drops, not a second reminder.
 */
export async function deliver(id: string, { clientId, text }: RemindInput): Promise<void> {
  const spoken = await stepSpeak(`Reminder: ${text}`, { sampleRate: NOTICE_SAMPLE_RATE });
  await stepNotifyClient(clientId, { id, event: "reminder", data: { text }, audio: spoken.pcm });
}
