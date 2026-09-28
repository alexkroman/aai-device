import { describe, expect, test } from "vitest";
import { describeProfile, missingField, normalizePhone, spokenPhone } from "./profile.ts";

// The database half (verification codes, attempts, the daily limit) runs against the
// local Supabase stack, not here; these are the parts that decide what gets texted and
// what the model is told.

describe("normalizePhone", () => {
  test("reads a number however it was said", () => {
    for (const said of ["(555) 555-0123", "555.555.0123", "555 555 0123", "15555550123"]) {
      expect.soft(normalizePhone(said), said).toBe("+15555550123");
    }
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("refuses what can't be a number, rather than guessing a country", () => {
    for (const said of ["", "555-0123", "call me", "+12", "44 20 7946 0958"]) {
      expect.soft(normalizePhone(said), said).toBeUndefined();
    }
  });
});

describe("what the model hears", () => {
  test("a number is only ever its last four digits", () => {
    expect(spokenPhone("+15555550123")).toBe("the number ending in 0 1 2 3");
    expect(describeProfile({ phone: "+15555550123" })).not.toContain("555555");
  });

  test("an empty profile adds nothing to the prompt", () => {
    expect(describeProfile({})).toBe("");
  });

  test("the prompt never shows the saved coordinates", () => {
    const text = describeProfile({ name: "Sam", home_address: "1 Example St", home_coords: "1,2" });
    expect(text).toContain("Sam");
    expect(text).toContain("1 Example St");
    expect(text).not.toContain("1,2");
  });

  test("a missing field tells the model to ask and which tool saves the answer", () => {
    expect(missingField("home_address", "for the weather")).toMatch(/Ask.*update_profile/);
    expect(missingField("phone", "to text them")).toMatch(/code to read back/);
  });
});
