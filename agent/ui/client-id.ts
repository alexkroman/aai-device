// This browser's ?client= id, the counterpart of the firmware's CONFIG_AAI_CLIENT_ID (else
// its MAC): the id sessionClientId(ctx) answers, so remind_me and deep_research can hand a
// run the way back here, and the one the inbox socket is held under. Made once and kept,
// because a reminder set today is delivered to whoever holds this id tomorrow.

const KEY = "aai-device:client";
/** The speaker this browser joined by a spoken code (link.ts), if any. */
const LINKED_KEY = "aai-device:linked";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let current: string | undefined;

/**
 * The conversation this page is: the linked speaker's, once a code was said to it,
 * else this browser's own. Sessions, history and reminders all follow it.
 */
export function clientId(): string {
  return linkedSpeaker() ?? browserId();
}

/** The speaker this page joined, or undefined. */
export function linkedSpeaker(): string | undefined {
  try {
    const id = localStorage.getItem(LINKED_KEY) ?? undefined;
    return id && ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Join a speaker's conversation (or leave it with undefined). The page reloads to take it up. */
export function setLinkedSpeaker(id: string | undefined): void {
  try {
    if (id && ID_RE.test(id)) localStorage.setItem(LINKED_KEY, id);
    else localStorage.removeItem(LINKED_KEY);
  } catch {
    // Private mode: the link lasts until the tab closes.
  }
}

/**
 * This browser itself, linked or not: what it asks for a link code as, and the inbox
 * holder id that lets it share a speaker's inbox without displacing the speaker.
 */
export function browserId(): string {
  if (current) return current;
  try {
    current = localStorage.getItem(KEY) ?? undefined;
  } catch {
    // Private mode: an id for this tab only.
  }
  // CLIENT_ID_RE in the SDK: 1-64 of A-Z a-z 0-9 _ -.
  if (!current || !ID_RE.test(current)) {
    current = `browser-${crypto.randomUUID().slice(0, 8)}`;
    try {
      localStorage.setItem(KEY, current);
    } catch {
      // As above.
    }
  }
  return current;
}
