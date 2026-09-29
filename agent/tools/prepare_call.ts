import { sessionClientId, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { draftCall } from "../calls.ts";
import { normalizePhone, readProfile, spokenPhone } from "../profile.ts";

// "Call Luigi's and book a table for four at seven." Step one of two: write down exactly
// what the calling agent will do, for them to hear and approve. Nothing is dialled here;
// place_call does that, and only for a draft they said yes to.
export default tool({
  description:
    "Prepare a phone call the assistant will make for them to a business or person, when " +
    "they ask you to call someone (book, order, ask, reschedule). Gather the number and " +
    "what they want first. This does NOT dial: read back what it returns and ask them to " +
    "confirm; only after a clear yes, call place_call with the call_id.",
  inputSchema: z.object({
    callee: z.string().min(1).max(120).describe('Who is being called, e.g. "Luigi\'s Pizza"'),
    phone: z
      .string()
      .max(40)
      .describe("Their number as said or found, with area code; +country code outside the US"),
    goal: z
      .string()
      .min(3)
      .max(1000)
      .describe(
        "What the call is for, with every detail they gave, e.g. a table for 4 at 7 PM tonight",
      ),
    may_agree: z
      .string()
      .max(500)
      .optional()
      .describe("What the assistant may accept without checking back, e.g. any time 6:30-7:30"),
    must_not: z
      .string()
      .max(500)
      .optional()
      .describe("Anything they said not to do or share, beyond the usual rules"),
  }),
  async execute({ callee, phone, goal, may_agree, must_not }, ctx) {
    const clientId = sessionClientId(ctx);
    if (!clientId) return toolFailure("Calls can only be placed from a speaker or the page.");
    const to = normalizePhone(phone);
    if (!to)
      return toolFailure("That isn't a phone number I can call. Ask for it with the area code.");
    const owner = (await readProfile(ctx).catch(() => ({ name: undefined }))).name ?? "";
    const id = await draftCall(ctx, {
      client_id: clientId,
      session_id: ctx.sessionId,
      to_number: to,
      callee,
      goal,
      may_agree: may_agree ?? "",
      must_not: must_not ?? "",
      owner_name: owner,
    });
    return {
      call_id: id,
      read_back:
        `I'll call ${callee} at ${spokenPhone(to)}, say I'm an AI assistant calling for ` +
        `${owner || "you"}, and ${goal}.` +
        (may_agree ? ` I may agree to: ${may_agree}.` : "") +
        " I won't give any payment or ID details, and I'll hang up within five minutes.",
      next: "Say read_back to them and ask if you should place the call. Call place_call only after a clear yes.",
    };
  },
});
