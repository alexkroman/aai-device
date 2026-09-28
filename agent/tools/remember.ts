import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { addMemories } from "../memory.ts";

// "Remember that I'm allergic to peanuts." Most memories need no tool: every conversation
// is handed to mem0 when it ends (workflows/memorize.ts), which keeps what lasts. This is
// for when they ASK, so it is kept even if the conversation says little else. mem0 still
// decides whether it restates or corrects something already held. Name, address and phone
// are not memories: those are exact fields tools act on, and update_profile saves them.
export default tool({
  description:
    "Remember something for future conversations when they explicitly ask you to, e.g. " +
    "'remember that the dog is allergic to chicken'. You don't need this for things they " +
    "mention in passing: those are remembered after the conversation. Not for their name, " +
    "address or phone number: use update_profile for those.",
  inputSchema: z.object({
    fact: z
      .string()
      .min(3)
      .max(300)
      .describe("One short standalone sentence, e.g. 'Biscuit the dog is allergic to chicken'"),
  }),
  async execute({ fact }, ctx) {
    await addMemories(ctx, [{ role: "user", content: `Remember this: ${fact}` }], {
      metadata: { source: "remember" },
    });
    return { remembered: fact };
  },
});
