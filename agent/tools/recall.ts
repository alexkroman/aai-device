import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { searchMemories } from "../memory.ts";

// Everything held about the home is already in the prompt at the start of a session (the
// household profile), so this is rarely needed to ANSWER: it is for "what do you know
// about me", for a memory saved since the session began, and for the ids forget needs.
export default tool({
  description:
    "Search what you remember about them, when the household profile you were given " +
    "doesn't answer it, when they ask what you know about something, or before forget " +
    "to find the memory's id. Results are the closest matches: use only the ones that fit.",
  inputSchema: z.object({
    query: z.string().min(2).max(200).describe("What to look for, e.g. 'the dog's allergies'"),
  }),
  async execute({ query }, ctx) {
    const found = await searchMemories(ctx, query);
    return {
      memories: found.map((m) => ({ id: m.id, memory: m.memory })),
      ...(found.length ? {} : { note: "Nothing saved about that." }),
    };
  },
});
