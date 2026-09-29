import {
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  runTool,
  stubClientInbox,
  stubSpeech,
} from "@alexkroman1/aai/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_REMINDER_MS, remind, reminderDueAt, spokenDue } from "./shared.ts";
import cancelReminders from "./tools/cancel_reminders.ts";
import remindMe from "./tools/remind_me.ts";
import { DELIVER_ATTEMPTS, deliver, NOTICE_SAMPLE_RATE, remindFlow } from "./workflows/remind.ts";

// 2026-09-28 14:00 local: the agent's clock is the home's.
const NOW = new Date(2026, 8, 28, 14, 0, 0);

describe("reminderDueAt", () => {
  test("a duration counts from now", () => {
    expect(reminderDueAt(NOW, { inSeconds: 90 })).toBe(NOW.getTime() + 90_000);
  });

  test("a clock time is today when it is still ahead, tomorrow when it has passed", () => {
    expect(reminderDueAt(NOW, { at: "17:00" })).toBe(new Date(2026, 8, 28, 17, 0).getTime());
    expect(reminderDueAt(NOW, { at: "9:30" })).toBe(new Date(2026, 8, 29, 9, 30).getTime());
    expect(reminderDueAt(NOW, { at: "14:00" })).toBe(new Date(2026, 8, 29, 14, 0).getTime());
  });

  test("nothing usable is undefined", () => {
    for (const at of [undefined, "", "5pm", "24:00", "12:60"]) {
      expect.soft(reminderDueAt(NOW, { at }), String(at)).toBeUndefined();
    }
  });
});

describe("spokenDue", () => {
  test("says today's time bare, and names tomorrow or the weekday", () => {
    expect(spokenDue(NOW, new Date(2026, 8, 28, 17, 0).getTime())).toBe("5:00 PM");
    expect(spokenDue(NOW, new Date(2026, 8, 29, 7, 0).getTime())).toBe("tomorrow at 7:00 AM");
    expect(spokenDue(NOW, new Date(2026, 8, 30, 7, 0).getTime())).toBe("Wednesday at 7:00 AM");
  });
});

describe("remind_me", () => {
  afterEach(() => vi.useRealTimers());

  test("starts a run for this speaker, keyed by its client id so cancel can find it", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({
      clientId: "kitchen",
      workflows: createStubWorkflows({ start }),
    });
    const result = await runTool(remindMe, { text: "call the plumber", at: "17:00" }, ctx);
    expect(result).toEqual({ scheduled: true, text: "call the plumber", due: "5:00 PM" });
    expect(start).toHaveBeenCalledWith(
      remind,
      { clientId: "kitchen", text: "call the plumber", dueAt: new Date(2026, 8, 28, 17).getTime() },
      { key: "kitchen", label: expect.stringMatching(/ · due /) },
    );
  });

  test("a session with no client id (a browser tab) cannot take one", async () => {
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({ workflows: createStubWorkflows({ start }) });
    const result = await runTool(remindMe, { text: "x", in_seconds: 60 }, ctx);
    expect(result).toHaveProperty("error");
    expect(start).not.toHaveBeenCalled();
  });

  test("no usable time, or more than a week away, is refused", async () => {
    const start = vi.fn(async () => "wrun_1");
    const ctx = createToolContext({ clientId: "k", workflows: createStubWorkflows({ start }) });
    expect(await runTool(remindMe, { text: "x", at: "five" }, ctx)).toHaveProperty("error");
    const tooFar = MAX_REMINDER_MS / 1000 + 1;
    expect(await runTool(remindMe, { text: "x", in_seconds: tooFar }, ctx)).toHaveProperty("error");
    expect(start).not.toHaveBeenCalled();
  });
});

describe("cancel_reminders", () => {
  test("cancels this speaker's reminders that have not fired, and counts them", async () => {
    const find = vi.fn(async () => [
      { runId: "a", workflow: "remind", createdAt: 1, status: "running" as const },
      { runId: "b", workflow: "remind", createdAt: 2, status: "pending" as const },
      { runId: "c", workflow: "remind", createdAt: 3, status: "completed" as const, output: {} },
    ]);
    const cancel = vi.fn(async () => true);
    const ctx = createToolContext({
      clientId: "kitchen",
      workflows: createStubWorkflows({ find, cancel }),
    });
    expect(await runTool(cancelReminders, {}, ctx)).toEqual({ cancelled: 2 });
    expect(find).toHaveBeenCalledWith(remind, "kitchen");
    expect(cancel.mock.calls).toEqual([["a"], ["b"]]);
  });
});

describe("the remind workflow", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("sleeps until it is due, then delivers in one retried step", async () => {
    const dueAt = NOW.getTime() + 60_000;
    const ctx = createWorkflowContext({ runSteps: false });
    await remindFlow({ clientId: "kitchen", text: "flip the laundry", dueAt }, ctx);
    expect(ctx.slept).toEqual([{ label: "due", until: new Date(dueAt) }]);
    expect(ctx.steps).toEqual([{ name: "deliver", maxAttempts: DELIVER_ATTEMPTS }]);
  });

  test("deliver speaks the reminder at the board's rate and pushes it under the run id", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    const speech = stubSpeech({ pcmBytes: 3200 });
    const inbox = stubClientInbox();
    try {
      await deliver("wrun_7", { clientId: "kitchen", text: "flip the laundry", dueAt: 0 });
      expect(speech.calls).toMatchObject([
        { text: "Reminder: flip the laundry", sampleRate: NOTICE_SAMPLE_RATE },
      ]);
      expect(inbox.calls).toHaveLength(1);
      const [{ clientId, notice }] = inbox.calls as [(typeof inbox.calls)[number]];
      expect(clientId).toBe("kitchen");
      expect(notice).toMatchObject({
        id: "wrun_7",
        event: "reminder",
        // `said` is what the page shows as the speaker's turn: the words it spoke.
        data: { text: "flip the laundry", said: "Reminder: flip the laundry" },
      });
      expect(notice.audio?.length).toBe(3200);
    } finally {
      speech.restore();
      inbox.restore();
    }
  });

  test("a speaker that is busy fails the attempt as retryable, so the step redelivers", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    const speech = stubSpeech();
    const inbox = stubClientInbox({ answer: "busy" });
    try {
      await expect(
        deliver("wrun_8", { clientId: "kitchen", text: "x", dueAt: 0 }),
      ).rejects.toMatchObject({ name: "ClientUnreachableError", reason: "busy" });
    } finally {
      speech.restore();
      inbox.restore();
    }
  });
});
