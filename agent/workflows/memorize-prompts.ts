// The compaction prompts: how one session becomes a digest, and how old digests become
// the rolling summary. Adapted from the structure the published compactors converge on
// (Claude Code's compact prompt keeps "All user messages" and "Pending Tasks" sections
// because summaries lose commitments first; LangChain's makes every section a checklist
// that must say "None" rather than be skipped; the OpenAI cookbook's "do not invent new
// facts"), cut down for a shared speaker whose sessions are a few spoken turns.
//
// What these deliberately leave out: lasting facts about people and pets. mem0 keeps
// those (memory.ts), and a fact kept in two places drifts apart. Reminders too: the
// pending remind runs are the only record of those, read live at connect (context.ts).

/** One session's transcript into a digest. */
export const DIGEST_SYSTEM = [
  "You keep the running history of a voice assistant on a shared home speaker.",
  "You are given one conversation from it, with the time it started, and write its digest:",
  "what the next conversation would need to know happened.",
  "",
  "`digest` is at most 120 words of plain bullets, past tense:",
  "- What was asked, and what the assistant answered or did. From a tool result keep only",
  '  what the reply used ("forecast Sat: rain, 12C"), never raw data, URLs or lists.',
  '- Anything left unresolved: a question not answered, "ask me later", something the',
  "  assistant said it would do. Start each with OPEN:.",
  "- A correction they made to the assistant, quoted exactly.",
  '- Turn every relative time into an absolute one from the start time: "tomorrow" is',
  "  a date.",
  "- Use a person's name only if they named themselves or were called by it in THIS",
  '  conversation; otherwise "someone".',
  "- Leave out greetings, thanks, small talk, stop or cancel, and lasting facts about",
  "  the people or pets (those are remembered elsewhere).",
  "- Do not infer or invent. If a line looks misheard, say so briefly.",
  "`digest` is an empty string when nothing worth carrying forward happened.",
].join("\n");

/** Old digests (and the summary before them) into one rolling summary. */
export const FOLD_SYSTEM = [
  "You keep the long-term history of a voice assistant on a shared home speaker.",
  "You are given the history summary so far and the digests of the conversations since,",
  "oldest first, and write the new summary that replaces all of them.",
  "",
  "`summary` is at most 400 words of plain bullets, grouped by topic, each with its date:",
  "- Keep every OPEN: item unless a later digest closes it, with the date it was opened.",
  '- Merge repeats: "asked about the weather" five times is one line.',
  "- Keep corrections they made, quoted.",
  "- Drop what no later conversation could need: one-off answers that are stale now.",
  "- Keep dates as they are written. Do not invent or infer.",
].join("\n");
