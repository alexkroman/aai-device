// What this browser tells the agent about itself on every connect: the device's
// CONFIG_AAI_DEVICE_ADDRESS (for "the weather" and "near me") and a phone for text_me and
// deep research. Kept in this browser only, never in code; the speaker has its own.

export type Setting = "location" | "phone";

const KEY: Record<Setting, string> = {
  location: "aai-device:location",
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
