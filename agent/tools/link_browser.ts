import { requireSessionClient, tool, toolFailure } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { claimLinkCode } from "../link.ts";

// "Computer, link code 4 8 2 9 1 3." The page showed that code (link.ts); saying it to this
// speaker joins the page to this speaker's conversation.
export default tool({
  description:
    "Link a browser to this speaker when they read you the code the browser page shows " +
    "(six digits), e.g. 'link code 4 8 2 9 1 3'. Afterwards the page shows this speaker's " +
    "conversation.",
  inputSchema: z.object({
    code: z.string().max(20).describe("The code as they said it, e.g. '482913'"),
  }),
  async execute({ code }, ctx) {
    const speaker = requireSessionClient(ctx, "Only a speaker can link a browser.");
    if (isToolFailure(speaker)) return speaker;
    const result = await claimLinkCode(ctx, code, speaker);
    switch (result.status) {
      case "linked":
        return { linked: true };
      case "wrong":
        return toolFailure(
          result.attemptsLeft > 0
            ? `That code doesn't match. They can try ${result.attemptsLeft} more times.`
            : "That code doesn't match and no tries are left: ask them to get a new code on the page.",
        );
      case "none_pending":
        return toolFailure("No browser is waiting to link, or its code expired.");
    }
  },
});
