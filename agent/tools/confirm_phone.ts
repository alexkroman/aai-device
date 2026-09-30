import { tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { confirmPhone, spokenPhone } from "../profile.ts";

// The second half of saving a phone number (update_profile texts the code): the number
// becomes the profile's `phone` only once they read back what was texted to it.
export default tool({
  description:
    "Confirm a new phone number with the six-digit code update_profile texted to it, " +
    "once they read it back to you.",
  inputSchema: z.object({
    code: z.string().max(20).describe("The code as they said it, e.g. '482913'"),
  }),
  async execute({ code }, ctx) {
    const result = await confirmPhone(ctx, code);
    switch (result.status) {
      case "confirmed":
        return { saved: "phone", number: spokenPhone(result.phone) };
      case "wrong":
        return toolFailure(
          result.attemptsLeft > 0
            ? `That code doesn't match. They can try ${result.attemptsLeft} more times.`
            : "That code doesn't match and no tries are left: offer to text a new one.",
        );
      default: // none_pending
        return toolFailure(
          "There is no code waiting, or it expired. Offer to text a new one with update_profile.",
        );
    }
  },
});
