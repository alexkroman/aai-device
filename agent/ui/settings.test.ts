import { phoneE164 } from "@alexkroman1/aai-ui";
import { describe, expect, test } from "vitest";
import { PHONE_COUNTRY } from "./settings.ts";

// How the page reads the "Text me at" field. Fictional numbers only (555-01xx is reserved
// for fiction).
describe("phoneE164 with the page's country", () => {
  const read = (typed: string) => phoneE164(typed, PHONE_COUNTRY);

  test("takes a number however it is typed", () => {
    expect(read("+1 555 555 0123")).toBe("+15555550123");
    expect(read("(555) 555-0123")).toBe("+15555550123");
    expect(read("555.555.0123")).toBe("+15555550123");
    expect(read("1 555 555 0123")).toBe("+15555550123");
    expect(read("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("refuses what can't be a number, rather than guess a country", () => {
    expect(read("")).toBeUndefined();
    expect(read("5550123")).toBeUndefined();
    expect(read("020 7946 0958")).toBeUndefined();
    expect(read("call me")).toBeUndefined();
    expect(read("+1234567890123456")).toBeUndefined();
  });
});
