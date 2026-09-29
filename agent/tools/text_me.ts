import { sessionClientPhone, tool, toolFailure } from "@alexkroman1/aai";
import {
  allowedSmsRecipient,
  sendToChannel,
  TEXTBELT_MAX_MESSAGE_CHARS,
  textbeltChannel,
} from "@alexkroman1/aai/channels";
import { z } from "zod";
import { stripLinks } from "../sms.ts";

// The SDK's text_me builtin, with its links taken out (sms.ts): Textbelt refuses a text
// containing one until the key is verified for links, and the builtin would send the
// model's `url` and any link it wrote into the message. Same recipient rule as the
// builtin: the page's claimed number only when allowlisted, else SMS_TO_PHONE. Back to
// the builtin (agent.ts builtinTools) once the key can send links.
export default tool({
  description:
    "Send a text message to the owner's own phone (the number is configured, never chosen " +
    "here). Use it for what is too long or too exact to say: directions, a list, a recipe, " +
    'several search results, an address or phone number. Offer first ("Want me to text you ' +
    "that?\") and send when they agree, or when they ask to be texted. Links can't be sent " +
    "yet: describe where to find something instead. Returns whether it was sent.",
  inputSchema: z.object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(TEXTBELT_MAX_MESSAGE_CHARS)
      .describe("The text to send: the full version, written to be read, not spoken"),
  }),
  async execute({ message }, ctx) {
    const key = ctx.env.TEXTBELT_KEY?.trim();
    const to = allowedSmsRecipient(sessionClientPhone(ctx), ctx.env);
    if (!key || !to) return toolFailure("Texting isn't set up on this speaker.");
    const text = stripLinks(message);
    if (!text) return toolFailure("That text was only links, which can't be sent yet.");
    try {
      await sendToChannel(textbeltChannel({ key, to }), { text });
      return { sent: true, ...(text !== message ? { note: "links were left out" } : {}) };
    } catch (err) {
      return toolFailure(
        `The text did not send: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});
