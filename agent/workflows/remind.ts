import type { WorkflowContext } from "@alexkroman1/aai";
import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS, stepSayOnClient } from "@alexkroman1/aai/step";

// A reminder: sleep until it is due, then say it on the speaker. The session that set it
// closed long ago, so it goes to the device's idle inbox socket (firmware inbox.c). The
// step's retries are the redelivery: a speaker that is unplugged, rebooting or
// mid-conversation gets it when it can take it.

export type RemindInput = { clientId: string; text: string; dueAt: number };

export async function remindFlow(input: RemindInput, ctx: WorkflowContext) {
  await ctx.sleep("due", new Date(input.dueAt));
  const { runId } = ctx;
  await ctx.step("deliver", () => deliver(runId, input), {
    maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  });
  return { delivered: true };
}

/**
 * The run id is the notice id: a redelivery after a lost ack is a repeat the device
 * drops, not a second reminder.
 */
export async function deliver(id: string, { clientId, text }: RemindInput): Promise<void> {
  await stepSayOnClient(clientId, {
    id,
    event: "reminder",
    text: `Reminder: ${text}`,
    data: { text },
  });
}
