import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { forgetMemory } from "../memory.ts";

// "Forget that I have a dog." By id from recall, never by description: the model reads
// the matches and picks, so a near-miss is never the one deleted.
export default tool({
  description:
    "Forget one thing you remembered, when they ask you to. Call recall first to find " +
    "it, then pass the id of the memory that matches.",
  inputSchema: z.object({
    id: z.string().min(1).max(64).describe("The memory's id from recall"),
  }),
  async execute({ id }, ctx) {
    await forgetMemory(ctx, id);
    return { forgotten: true };
  },
});
