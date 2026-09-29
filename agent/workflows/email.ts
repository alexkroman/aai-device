import type { WorkflowContext } from "@alexkroman1/aai";
import { stepNotifyClient, stepSpeak } from "@alexkroman1/aai/step";
import { stepAppsCtx } from "../apps.ts";
import { type EmailResult, emailHousehold } from "../email.ts";
import { DELIVER_ATTEMPTS, NOTICE_SAMPLE_RATE } from "./remind.ts";

// email_me's send: through Composio's Gmail (email.ts), which is round trips too slow to
// hold a turn for, so a run. The agent already said it's on its way; the speaker only
// speaks again when it did NOT go, so a failure is never silent.

export type EmailInput = { clientId: string; subject: string; body: string };

/** Few attempts: a retried send after a lost answer is a second email. */
const SEND_ATTEMPTS = 2;

export async function emailFlow(input: EmailInput, ctx: WorkflowContext) {
  const result = await ctx.step("send", () => send(input), { maxAttempts: SEND_ATTEMPTS });
  if (!result.sent) {
    const { runId } = ctx;
    await ctx.step("announceFailure", () => announceFailure(runId, input, result.why), {
      maxAttempts: DELIVER_ATTEMPTS,
    });
  }
  return result;
}

export async function send(input: EmailInput): Promise<EmailResult> {
  return await emailHousehold(stepAppsCtx(), input.clientId, {
    subject: input.subject,
    body: input.body,
  });
}

export async function announceFailure(id: string, input: EmailInput, why: string): Promise<void> {
  const said = `I couldn't email you "${input.subject}". ${why}`;
  const spoken = await stepSpeak(said, { sampleRate: NOTICE_SAMPLE_RATE });
  await stepNotifyClient(input.clientId, {
    id: `${id}:failed`,
    event: "email",
    data: { text: said, said, failed: true },
    audio: spoken.pcm,
  });
}
