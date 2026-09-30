import { describe, expect, test } from "vitest";
import { phoneE164 } from "./settings.ts";

// Fictional numbers only (555-01xx is reserved for fiction).
describe("phoneE164", () => {
  test("takes a number however it is typed", () => {
    expect(phoneE164("+1 555 555 0123")).toBe("+15555550123");
    expect(phoneE164("(555) 555-0123")).toBe("+15555550123");
    expect(phoneE164("555.555.0123")).toBe("+15555550123");
    expect(phoneE164("1 555 555 0123")).toBe("+15555550123");
    expect(phoneE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("refuses what can't be a number, rather than guess a country", () => {
    expect(phoneE164("")).toBeUndefined();
    expect(phoneE164("5550123")).toBeUndefined();
    expect(phoneE164("020 7946 0958")).toBeUndefined();
    expect(phoneE164("call me")).toBeUndefined();
    expect(phoneE164("+1234567890123456")).toBeUndefined();
  });
});
