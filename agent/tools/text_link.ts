import { requireEnv, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";

// TextBelt (https://textbelt.com): one POST, no sender number to rent or
// register. The recipient is always the owner's own phone (SMS_TO_PHONE), never
// a number the model supplies, so a misheard request cannot text a stranger.
export default tool({
  description:
    "Text a link to the owner's phone. Use when they ask you to text, send, or message " +
    "them a link or article mentioned earlier in the conversation. Pass the exact URL " +
    "you visited or found in search results; never invent one.",
  inputSchema: z.object({
    url: z.string().url().describe("The full http(s) URL to send"),
    title: z.string().optional().describe("A short title for the link, e.g. the article headline"),
  }),
  async execute({ url, title }, ctx) {
    if (!/^https?:\/\//i.test(url)) return toolFailure("Only http(s) links can be texted.");
    const res = await fetch("https://textbelt.com/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: requireEnv(ctx, "SMS_TO_PHONE"),
        message: title ? `${title}\n${url}` : url,
        key: requireEnv(ctx, "TEXTBELT_KEY"),
      }),
      signal: ctx.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!body.success)
      return toolFailure(`The text did not send: ${body.error ?? `HTTP ${res.status}`}`);
    return { sent: true };
  },
});
