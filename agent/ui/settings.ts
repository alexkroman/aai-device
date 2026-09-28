// What this browser tells the agent about itself on every connect: a phone for text_me
// and deep research. Kept in this browser only, never in code; the speaker has its own.

export type Setting = "phone";

const KEY: Record<Setting, string> = {
  phone: "aai-device:phone",
};

export function readSetting(setting: Setting): string {
  try {
    return localStorage.getItem(KEY[setting]) ?? "";
  } catch {
    return "";
  }
}

export function writeSetting(setting: Setting, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(KEY[setting], value.trim());
    else localStorage.removeItem(KEY[setting]);
  } catch {
    // Private mode: the value just isn't remembered.
  }
}
