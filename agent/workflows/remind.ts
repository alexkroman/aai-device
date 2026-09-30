import type { WorkflowContext } from "@alexkroman1/aai";

// A reminder: sleep until it is due, then say it on the speaker. The session that set it
// closed long ago, so it goes to the device's idle inbox socket (firmware inbox.c). The
// step's retries are the redelivery: a speaker that is unplugged, rebooting or
// mid-conversation gets it when it can take it.
//
// ctx.sayOnClient is that one step, named "deliver" as the hand-written one was (so a run
// parked across the change replays), with the run id as the notice id (a redelivery after
// a lost ack is a repeat the device drops, not a second reminder) and
// DEFAULT_CLIENT_DELIVERY_ATTEMPTS as its budget.

export type RemindInput = { clientId: string; text: string; dueAt: number };

export async function remindFlow(input: RemindInput, ctx: WorkflowContext) {
  await ctx.sleep("due", new Date(input.dueAt));
  await ctx.sayOnClient("deliver", input.clientId, {
    event: "reminder",
    text: `Reminder: ${input.text}`,
    data: { text: input.text },
  });
  return { delivered: true };
}
