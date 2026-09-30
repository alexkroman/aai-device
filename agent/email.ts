import type { EnvContext } from "@alexkroman1/aai/step";
import { CONNECT_HINT, runAction } from "./apps.ts";
import { readProfile } from "./profile.ts";

// Email to the household's own address (the page's Household panel, profile.ts `email`),
// sent FROM the speaker's connected Gmail through Composio (apps.ts): no mail provider
// of our own, and it arrives from an account they know. Unlike a text it can carry links,
// so it is where anything with a URL, or too long for a text, goes.

/** Composio's Gmail send action (its schema: recipient_email, subject, body, is_html). */
export const GMAIL_SEND = "GMAIL_SEND_EMAIL";
/** Longest body sent: an email, not an archive. */
export const MAX_EMAIL_CHARS = 20_000;

export type EmailResult = { sent: true; to: string } | { sent: false; why: string };

/** Email `subject` and `body` to the saved address, from the speaker's Gmail. */
export async function emailHousehold(
  ctx: EnvContext,
  user: string,
  mail: { subject: string; body: string },
): Promise<EmailResult> {
  const to = (await readProfile(ctx)).email;
  if (!to)
    return {
      sent: false,
      why: "No email address is saved: add one under Household on the speaker's page.",
    };
  const result = await runAction(ctx, user, GMAIL_SEND, {
    recipient_email: to,
    subject: mail.subject,
    body: mail.body.slice(0, MAX_EMAIL_CHARS),
    is_html: false,
  });
  if (result.ok) return { sent: true, to };
  const notConnected = /connect|auth|credential|token/i.test(result.error);
  return {
    sent: false,
    why: notConnected
      ? `Email goes out through Gmail, which isn't connected. ${CONNECT_HINT}`
      : `The email didn't send: ${result.error.slice(0, 200)}`,
  };
}
