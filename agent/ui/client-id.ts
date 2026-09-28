// This browser's ?client= id, the counterpart of the firmware's CONFIG_AAI_CLIENT_ID (else
// its MAC): the id sessionClientId(ctx) answers, so remind_me and deep_research can hand a
// run the way back here, and the one the inbox socket is held under. Made once and kept,
// because a reminder set today is delivered to whoever holds this id tomorrow.

const KEY = "aai-device:client";

let current: string | undefined;

export function clientId(): string {
  if (current) return current;
  try {
    current = localStorage.getItem(KEY) ?? undefined;
  } catch {
    // Private mode: an id for this tab only.
  }
  // CLIENT_ID_RE in the SDK: 1-64 of A-Z a-z 0-9 _ -.
  if (!current || !/^[A-Za-z0-9_-]{1,64}$/.test(current)) {
    current = `browser-${crypto.randomUUID().slice(0, 8)}`;
    try {
      localStorage.setItem(KEY, current);
    } catch {
      // As above.
    }
  }
  return current;
}
