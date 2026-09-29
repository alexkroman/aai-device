import { browserClientId } from "@alexkroman1/aai-ui";

// Which conversation this page is: the speaker it was linked to by a spoken code
// (link.ts), else this browser's own. The SDK keeps the browser's id and gives each tab
// its own inbox holder (aai-ui `client: "auto"`); this only adds the link on top.

/** Where this page kept its id before the SDK did: carried over, so its history stays its own. */
const LEGACY_KEY = "aai-device:client";
/** The speaker this browser joined by a spoken code (link.ts), if any. */
const LINKED_KEY = "aai-device:linked";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function stored(key: string): string | undefined {
  try {
    const id = localStorage.getItem(key) ?? undefined;
    return id && ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This browser itself, linked or not: what it asks for a link code as. An id this page
 * minted before the SDK kept one is carried over: its conversation, reminders and link
 * code are all keyed by it.
 */
export function browserId(): string {
  return stored(LEGACY_KEY) ?? browserClientId();
}

/** The conversation this page is: the linked speaker's, once a code was said to it. */
export function clientId(): string {
  return linkedSpeaker() ?? browserId();
}

/** The speaker this page joined, or undefined. */
export function linkedSpeaker(): string | undefined {
  return stored(LINKED_KEY);
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
