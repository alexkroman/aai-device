import type { ConversationItem } from "@alexkroman1/aai-ui";

// Everything this page has said and heard, across sessions. The device's sessions are
// short (a wake word, a few turns, FOLLOWUP_MS of quiet, hang up), so the live
// conversation the SDK holds is only ever the current one; this keeps the rest.
//
// A resume replays the session's history (history.restored), so the live conversation is
// never appended as it stands: that would log every earlier turn again. Each server
// session is instead a CHAIN of entries whose items, end to end, are its conversation:
// the chain is rewritten from the live list, and only what is new goes on the end, in
// a new entry when something else (a note, a reminder arriving) was logged since. So the
// log stays in the order things happened.

export type Item =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; args: string; done: boolean };

export type Entry =
  /** `run` tells apart two conversations the server held under one id; see recordSession. */
  | {
      kind: "session";
      sessionId: string;
      run?: number;
      at: number;
      items: Item[];
      /**
       * Whose conversation it was: this browser's own, or the speaker it was linked to.
       * Only a session of the page's CURRENT client can be continued from here; resuming
       * one under another id would move it into that conversation.
       */
      clientId?: string;
    }
  | { kind: "note"; at: number; text: string };

/** Oldest dropped first; localStorage holds a few MB per origin. */
export const MAX_ENTRIES = 300;
const STORAGE_KEY = "aai-device:history";

export function toItems(items: readonly ConversationItem[]): Item[] {
  return items.map((it) =>
    it.kind === "message"
      ? { kind: "message", role: it.message.role, text: it.message.content }
      : {
          kind: "tool",
          name: it.toolCall.name,
          args: JSON.stringify(it.toolCall.args),
          done: it.toolCall.status === "done",
        },
  );
}

const same = (a: Item | undefined, b: Item | undefined) => JSON.stringify(a) === JSON.stringify(b);
/** Whether two items are the same turn, ignoring a tool call going from pending to done. */
const sameTurn = (a: Item | undefined, b: Item | undefined) =>
  same(
    a?.kind === "tool" ? { ...a, done: true } : a,
    b?.kind === "tool" ? { ...b, done: true } : b,
  );

type SessionEntry = Extract<Entry, { kind: "session" }>;

/**
 * The live conversation of `sessionId`, written into the history. It continues the
 * newest chain for that session when every turn they share matches, and starts a new
 * run otherwise: a session the server had already retired comes back under the same
 * id but empty, and must not overwrite what the old one said.
 */
export function recordSession(
  history: readonly Entry[],
  sessionId: string,
  items: Item[],
  now: number,
  clientId?: string,
): Entry[] {
  if (items.length === 0) return [...history];
  const mine = (e: Entry): e is SessionEntry => e.kind === "session" && e.sessionId === sessionId;
  const run = history.findLast(mine)?.run ?? 0;
  const chain = history.flatMap((e, i) => (mine(e) && (e.run ?? 0) === run ? [i] : []));
  const stored = chain.flatMap((i) => (history[i] as SessionEntry).items);
  // It continues the chain only if EVERY turn the two share matches. The first turn alone
  // is not enough: a session the server lost comes back greeting, and the greeting is
  // the first turn of the old one too.
  const shared = Math.min(stored.length, items.length);
  const continues =
    chain.length > 0 && stored.slice(0, shared).every((it, k) => sameTurn(it, items[k]));
  if (!continues) {
    const entry: SessionEntry = {
      kind: "session",
      sessionId,
      run: chain.length > 0 ? run + 1 : 0,
      at: now,
      items,
      ...(clientId ? { clientId } : {}),
    };
    return trim([...history, entry]);
  }
  // Mid-reconnect, before the whole replay lands: nothing to learn, and nothing to shrink to.
  if (items.length < stored.length) return [...history];

  const next = [...history];
  let offset = 0;
  for (const i of chain) {
    const e = next[i] as SessionEntry;
    next[i] = { ...e, items: items.slice(offset, offset + e.items.length) };
    offset += e.items.length;
  }
  const rest = items.slice(offset);
  if (rest.length === 0) return next;
  const tail = chain.at(-1) as number;
  if (tail === next.length - 1) {
    const e = next[tail] as SessionEntry;
    next[tail] = { ...e, items: [...e.items, ...rest] };
    return next;
  }
  return trim([
    ...next,
    { kind: "session", sessionId, run, at: now, items: rest, ...(clientId ? { clientId } : {}) },
  ]);
}

export function addNote(history: readonly Entry[], text: string, now: number): Entry[] {
  return trim([...history, { kind: "note", at: now, text }]);
}

function trim(history: Entry[]): Entry[] {
  return history.length > MAX_ENTRIES ? history.slice(-MAX_ENTRIES) : history;
}

export function loadHistory(): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Entry[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: readonly Entry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Quota or private mode: the page still works, it just won't remember.
  }
}
