import { createStoredValue, type PhoneE164Options } from "@alexkroman1/aai-ui";

// What this browser tells the agent about itself on every connect: a phone for text_me
// and deep research. Kept in this browser only, never in code; the speaker has its own.

export const phone = createStoredValue("aai-device:phone");

/**
 * How the page reads a typed number (aai-ui `phoneE164`): a bare 10-digit number, or 11
 * starting with 1, is taken as US; anything else must carry its country code.
 */
export const PHONE_COUNTRY: PhoneE164Options = { countryCode: "1" };
