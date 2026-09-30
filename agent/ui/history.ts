import {
  type ConversationItem,
  type ConversationLogEntry,
  useConversationLog,
} from "@alexkroman1/aai-ui";
import { useState } from "react";

// Everything this page has said and heard, across sessions: aai-ui's useConversationLog,
// under a key of this page's own. The log this page kept itself before
// (`aai-device:history`) is carried over into it once, so no one's history is lost.

export const LOG_KEY = "aai-device:log";
const LEGACY_KEY = "aai-device:history";
const MAX_ENTRIES = 300;

/** The log, with the page's old one carried over first. Call once per page. */
export function useHistory() {
  // Before useConversationLog's own initializer, which reads LOG_KEY once on mount.
  useState(() => migrateHistory(globalThis.localStorage));
  return useConversationLog({ storageKey: LOG_KEY, max: MAX_ENTRIES });
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** An item as the page stored it: args as a JSON string, a `done` flag. */
type LegacyItem =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; args: string; done: boolean };

/**
 * Move the old `aai-device:history` into LOG_KEY in aai-ui's format, ahead of anything
 * already there, and drop the old key. Entries it can't read are skipped, never thrown on.
 * A storage that refuses (private mode) leaves both keys as they were.
 */
export function migrateHistory(store: Store | undefined): void {
  try {
    const raw = store?.getItem(LEGACY_KEY);
    if (!store || raw == null) return;
    const old = parseArray(raw).flatMap((e) => {
      const entry = convertEntry(e);
      return entry ? [entry] : [];
    });
    const current = parseArray(store.getItem(LOG_KEY));
    const merged = [...old, ...current].slice(-MAX_ENTRIES);
    store.setItem(LOG_KEY, JSON.stringify(merged));
    store.removeItem(LEGACY_KEY);
  } catch {
    // Quota or private mode: tried again on the next load.
  }
}

function parseArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function convertEntry(raw: unknown): ConversationLogEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.at !== "number") return undefined;
  if ((e.kind === "note" || e.kind === "spoken") && typeof e.text === "string")
    return { kind: e.kind, at: e.at, text: e.text };
  if (e.kind !== "session" || typeof e.sessionId !== "string" || !Array.isArray(e.items))
    return undefined;
  return {
    kind: "session",
    sessionId: e.sessionId,
    run: typeof e.run === "number" ? e.run : 0,
    at: e.at,
    items: (e.items as LegacyItem[]).flatMap((it, i) => {
      const item = convertItem(it, i);
      return item ? [item] : [];
    }),
    ...(typeof e.clientId === "string" ? { clientId: e.clientId } : {}),
  };
}

function convertItem(it: LegacyItem, i: number): ConversationItem | undefined {
  if (it?.kind === "message" && typeof it.text === "string")
    return { kind: "message", message: { id: i, role: it.role, content: it.text } };
  if (it?.kind === "tool" && typeof it.name === "string")
    return {
      kind: "tool",
      toolCall: {
        callId: `legacy-${i}`,
        name: it.name,
        args: parseArgs(it.args),
        status: it.done ? "done" : "pending",
        seq: i,
        afterMessageId: -1,
      },
    };
  return undefined;
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
