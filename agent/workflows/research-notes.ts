// What a research pass passes between its stages, and the pure functions that read it.
// From the SDK's research-handoff-agent template (workflows/notes.ts), less its filing.

/** One source a researcher actually used. */
export type Source = { title: string; url: string };

/** What one researcher concluded about one angle. */
export type Note = {
  angle: string;
  /** Kept long on purpose: a later step does the summarizing. */
  findings: string;
  sources: Source[];
};

/** The request as a researcher is held to it. */
export type Brief = {
  brief: string;
  /** What a complete answer has to contain; what findGaps measures against. */
  criteria: string[];
};

/** The brief as the models are shown it. */
export function briefText(brief: Brief): string {
  const criteria = brief.criteria.map((one) => `- ${one}`).join("\n");
  return criteria
    ? `Brief: ${brief.brief}\n\nA complete answer covers:\n${criteria}`
    : `Brief: ${brief.brief}`;
}

/** One note, as findGaps reads it. */
export function noteText(note: Note): string {
  const cited = note.sources.map((one) => `- ${one.title} (${one.url})`).join("\n");
  return `## ${note.angle}\n${note.findings}\n${cited}`;
}

/**
 * Every note, with ONE numbering of every source across them, for the report. Each
 * note's own list would restart at [1], and the report could not be mapped back to URLs.
 */
export function findingsText(notes: readonly Note[], sources: readonly Source[]): string {
  const number = new Map(sources.map((one, at) => [one.url, at + 1]));
  const body = notes.map((note) => {
    const cited = note.sources.map((one) => `[${number.get(one.url)}]`).join(" ");
    return `## ${note.angle}\n${note.findings}\nSources used here: ${cited || "none"}`;
  });
  const list = sources.map((one, at) => `[${at + 1}] ${one.title} (${one.url})`).join("\n");
  return `${body.join("\n\n")}\n\nSources:\n${list}`;
}

/** The sources a report actually cites, as "[n] url" lines under its own numbers. */
export function citedSources(report: string, sources: readonly Source[]): string[] {
  const used = new Set([...report.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return sources.flatMap((one, at) => (used.has(at + 1) ? [`[${at + 1}] ${one.url}`] : []));
}

/** Distinct sources by URL, first occurrence winning. */
export function dedupe(sources: readonly Source[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const one of sources) if (!byUrl.has(one.url)) byUrl.set(one.url, one);
  return [...byUrl.values()];
}

/** Every distinct source the pass rests on, in the order they were found. */
export function allSources(notes: readonly Note[]): Source[] {
  return dedupe(notes.flatMap((note) => note.sources));
}
