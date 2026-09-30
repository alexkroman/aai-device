import type { WorkflowContext } from "@alexkroman1/aai";
import { stepEnvContext } from "@alexkroman1/aai/step";
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
    // Not a failed run (it completes with sent: false), so not sayFailureOnClient, but the
    // id and data.failed that one uses: a screen tells it from a success notice.
    await ctx.sayOnClient("announceFailure", input.clientId, {
      id: `${ctx.runId}:failed`,
      event: "email",
      text: `I couldn't email you "${input.subject}". ${result.why}`,
      data: { failed: true },
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
