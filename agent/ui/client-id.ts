import { browserClientId, createLinkedClient } from "@alexkroman1/aai-ui";

// Which conversation this page is: the speaker it was linked to by a spoken code
// (link.ts), else this browser's own. `linked.id()` is the ?client= of every connect and
// /api call; `linked.own()` is this browser, what it asks for a link code as.

/** Where this page kept its id before the SDK did: carried over, so its history stays its own. */
const LEGACY_KEY = "aai-device:client";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * This browser itself, linked or not. An id this page minted before the SDK kept one is
 * carried over: its conversation, reminders and link code are all keyed by it.
 */
function browserId(): string {
  try {
    const id = localStorage.getItem(LEGACY_KEY);
    if (id && ID_RE.test(id)) return id;
  } catch {
    // Private mode: the SDK's id, held for the tab.
  }
  return browserClientId();
}

export const linked = createLinkedClient({ key: "aai-device:linked", fallback: browserId });
