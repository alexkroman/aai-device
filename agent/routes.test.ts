import { createRunSnapshot } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { RECENTLY_FINISHED_MS, RUNNING } from "./routes.ts";

// The Running panel is the SDK's clientRunsRoutes (its list, window and scoped cancel are
// tested there); these pin the three choices this speaker makes over it.

const include = RUNNING.include ?? (() => true);
const progressFor = RUNNING.progressFor ?? (() => true);
const detail = RUNNING.detail ?? (() => undefined);

describe("the Running panel", () => {
  test("keeps a finished run for RECENTLY_FINISHED_MS", () => {
    expect(RUNNING.recentMs).toBe(RECENTLY_FINISHED_MS);
  });

  test("an app event judged not worth telling is not a task; one that told is", () => {
    const event = (output: unknown) =>
      createRunSnapshot({ workflow: "appEvent", status: "completed", output });
    expect(include(event({ told: false }))).toBe(false);
    expect(include(event({ told: true, said: "Sam emailed." }))).toBe(true);
    expect(include(createRunSnapshot({ workflow: "appEvent", status: "running" }))).toBe(true);
    expect(
      include(createRunSnapshot({ workflow: "remind", status: "completed", output: {} })),
    ).toBe(true);
  });

  test("only research and app jobs have a progress line read", () => {
    for (const workflow of ["research", "appJob"])
      expect(progressFor(createRunSnapshot({ workflow, status: "running" }))).toBe(true);
    for (const workflow of ["remind", "call", "appEvent"])
      expect(progressFor(createRunSnapshot({ workflow, status: "running" }))).toBe(false);
  });

  test("a completed call's detail is what the speaker said about it", () => {
    const said = "Luigi's didn't answer.";
    expect(
      detail(createRunSnapshot({ workflow: "call", status: "completed", output: { said } })),
    ).toBe(said);
    expect(detail(createRunSnapshot({ workflow: "call", status: "running" }))).toBeUndefined();
    expect(
      detail(createRunSnapshot({ workflow: "remind", status: "completed", output: { said } })),
    ).toBeUndefined();
  });
});
