// Texts go out through Textbelt, which refuses any text containing a link until the key
// is verified for links (https://textbelt.com/whitelist) — and a refused research report
// failed its whole run. Until then every text is sent with its links taken out: the
// words still arrive, and the speaker says the rest.

/** A URL or anything that reads as one: scheme, www., or a bare domain with a known TLD. */
// A link ends before trailing punctuation: "(see https://x.com)," keeps its ")" and ",".
const LINK_RE =
  /\b(?:https?:\/\/|www\.)\S+?(?=[)\]>.,;:!?"']*(?:\s|$))|\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co|us|uk|ca|au|de|fr|dev|ai|app|info|biz|me|tv|news|blog)\b(?:\/\S*?(?=[)\]>.,;:!?"']*(?:\s|$)))?/gi;

/** `text` with every link removed, and what removing them leaves behind tidied away. */
export function stripLinks(text: string): string {
  return (
    text
      .replace(LINK_RE, "")
      // "(" + link + ")" and "<" + link + ">" leave empty brackets.
      .replace(/\(\s*\)|<\s*>|\[\s*\]\(\s*\)/g, "")
      // A source list of "[n] url" lines leaves bare "[n]" markers.
      .split("\n")
      .filter((line) => !/^\s*\[\d+\]\s*[-:]?\s*$/.test(line))
      .join("\n")
      .replace(/\n\nSources:\s*$/, "")
      .replace(/[ \t]+([,.;:!?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
