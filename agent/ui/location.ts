const KEY = "aai-device:location";

export function readLocation(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeLocation(value: string): void {
  try {
    if (value.trim()) localStorage.setItem(KEY, value.trim());
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the address just isn't remembered.
  }
}
