import type { StepOptions } from "@alexkroman1/aai";
import {
  allowedSmsRecipient,
  ChannelDeliveryError,
  sendToChannel,
  textbeltChannel,
} from "@alexkroman1/aai/channels";
import { requireStepEnv, stepEnv } from "@alexkroman1/aai/step";
import { throwStepError } from "@alexkroman1/aai/step-errors";
import { spokenErrorReason } from "@alexkroman1/aai/utils";

// A run's result by text, for the runs that text it only when asked (research.ts,
// app-job.ts). The speaker still says the answer either way.

/** A retried text is a second text: few attempts, unlike the announcement's. */
export const TEXT_STEP = { maxAttempts: 3 } satisfies StepOptions;

/**
 * How the result went by text. Not sent is not a failed run: the answer is written and
 * the speaker still says it, with the reason the text didn't go.
 */
export type Texted = { sent: true } | { sent: false; why?: string };

/**
 * Not sent when there is no number to text; the speaker still says the answer.
 *
 * The client's number is only a CLAIM: the server listens on the LAN for the speaker,
 * so anyone who can open a session could name any number. It is used only when it is
 * the owner's (SMS_TO_PHONE) or listed in SMS_ALLOWED_PHONES; anything else falls back
 * to the owner. The same rule the text_me builtin applies.
 */
export async function textReport(
  input: { phone?: string | undefined },
  report: string,
): Promise<Texted> {
  const to = allowedSmsRecipient(input.phone, {
    SMS_TO_PHONE: stepEnv("SMS_TO_PHONE"),
    SMS_ALLOWED_PHONES: stepEnv("SMS_ALLOWED_PHONES"),
  });
  if (!to) return { sent: false };
  // Links out: Textbelt refuses a text with one until the key is verified for links.
  const channel = textbeltChannel({ key: requireStepEnv("TEXTBELT_KEY"), to, links: "strip" });
  return await sendToChannel(channel, { text: report }).then(
    (): Texted => ({ sent: true }),
    (err: unknown): Texted => {
      // A refusal that will refuse again (a bad number, an unverified key) is an answer;
      // a transient failure is thrown for the step to retry.
      if (err instanceof ChannelDeliveryError && !err.retryable) {
        return { sent: false, why: spokenErrorReason(err) };
      }
      return throwStepError(err);
    },
  );
}
