import type { WorkflowContext } from "@alexkroman1/aai";
import {
  DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  stepEnvContext,
  stepSayOnClient,
} from "@alexkroman1/aai/step";
import { type EmailResult, emailHousehold } from "../email.ts";

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
      maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
    });
  }
  return result;
}

export async function send(input: EmailInput): Promise<EmailResult> {
  return await emailHousehold(stepEnvContext(), input.clientId, {
    subject: input.subject,
    body: input.body,
  });
}

export async function announceFailure(id: string, input: EmailInput, why: string): Promise<void> {
  await stepSayOnClient(input.clientId, {
    id: `${id}:failed`,
    event: "email",
    text: `I couldn't email you "${input.subject}". ${why}`,
    data: { failed: true },
  });
}
