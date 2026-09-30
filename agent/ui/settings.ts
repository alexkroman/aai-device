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

/**
 * The phone as the server takes it, E.164 (`+` and 8-15 digits), or undefined when it
 * can't be one. Forgiving of how people type a number: spaces, dashes, dots and brackets
 * go, and a bare 10-digit number (or 11 starting with 1) is taken as US. Anything else
 * must already carry its country code: guessing one would text a stranger.
 */
export function phoneE164(typed: string): string | undefined {
  const digits = typed.replace(/[\s\-.()]/g, "");
  const e164 = /^\d{10}$/.test(digits)
    ? `+1${digits}`
    : /^1\d{10}$/.test(digits)
      ? `+${digits}`
      : digits;
  return /^\+\d{8,15}$/.test(e164) ? e164 : undefined;
}
