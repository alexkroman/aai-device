import { useSyncExternalStore } from "react";

// The server's id for the current session, from mountClient's onSessionId. The history
// is keyed by it, and it arrives outside React, so it is a tiny external store.

let current: string | undefined;
const listeners = new Set<() => void>();

export function setSessionId(id: string): void {
  if (id === current) return;
  current = id;
  for (const l of listeners) l();
}

export function useSessionId(): string | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
