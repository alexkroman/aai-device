import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS } from "@alexkroman1/aai/step";
import {
  createRunSnapshot,
  createToolContext,
  createWorkflowContext,
  runTool,
} from "@alexkroman1/aai/testing";
import {
  installStubClientInbox,
  installStubSpeech,
  installStubWorkflows,
} from "@alexkroman1/aai/testing/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_REMINDER_MS, remind, reminderDueAt, spokenDue } from "./shared.ts";
import cancelReminders from "./tools/cancel_reminders.ts";
import remindMe from "./tools/remind_me.ts";
import { remindFlow } from "./workflows/remind.ts";

// 2026-09-28 14:00 local: the agent's clock is the home's.
const NOW = new Date(2026, 8, 28, 14, 0, 0);

describe("reminderDueAt", () => {
  test("a duration counts from now", () => {
    expect(reminderDueAt(NOW, { inSeconds: 90 })).toBe(NOW.getTime() + 90_000);
  });

  test("a clock time is today when it is still ahead, tomorrow when it has passed", () => {
    expect(reminderDueAt(NOW, { at: "17:00" })).toBe(new Date(2026, 8, 28, 17, 0).getTime());
    expect(reminderDueAt(NOW, { at: "09:30" })).toBe(new Date(2026, 8, 29, 9, 30).getTime());
    expect(reminderDueAt(NOW, { at: "14:00" })).toBe(new Date(2026, 8, 29, 14, 0).getTime());
  });

  test("nothing usable is undefined", () => {
    // "9:30" too: isClockTime wants it zero-padded, as the tool's clockTime field says.
    for (const at of [undefined, "", "5pm", "9:30", "24:00", "12:60"]) {
      expect.soft(reminderDueAt(NOW, { at }), String(at)).toBeUndefined();
    }
  });
});

describe("spokenDue", () => {
  test("says today's time bare, and names tomorrow or the weekday", () => {
    expect(spokenDue(NOW, new Date(2026, 8, 28, 17, 0).getTime())).toBe("5 PM");
    expect(spokenDue(NOW, new Date(2026, 8, 28, 17, 30).getTime())).toBe("5:30 PM");
    expect(spokenDue(NOW, new Date(2026, 8, 29, 7, 0).getTime())).toBe("tomorrow at 7 AM");
    expect(spokenDue(NOW, new Date(2026, 8, 30, 7, 5).getTime())).toBe("Wednesday at 7:05 AM");
    expect(spokenDue(NOW, new Date(2026, 9, 4, 9, 0).getTime())).toBe("Sunday at 9 AM");
  });

  test("a week out is today's weekday again, so it says the date too", () => {
    // NOW is a Monday: next Monday morning is under 7 days away but still a Monday.
    expect(spokenDue(NOW, new Date(2026, 9, 5, 9, 0).getTime())).toBe("Monday, October 5 at 9 AM");
    expect(spokenDue(NOW, new Date(2026, 9, 5, 14, 0).getTime())).toBe("Monday, October 5 at 2 PM");
  });

  test("midnight and noon", () => {
    expect(spokenDue(NOW, new Date(2026, 8, 29, 0, 0).getTime())).toBe("tomorrow at 12 AM");
    expect(spokenDue(NOW, new Date(2026, 8, 29, 12, 0).getTime())).toBe("tomorrow at 12 PM");
  });
});

describe("remind_me", () => {
  afterEach(() => vi.useRealTimers());

  test("starts a run for this speaker, keyed by its client id so cancel can find it", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", workflows });
    const result = await runTool(remindMe, { text: "call the plumber", at: "17:00" }, ctx);
    expect(result).toEqual({ scheduled: true, text: "call the plumber", due: "5 PM" });
    expect(workflows.start).toHaveBeenCalledWith(
      remind,
      { clientId: "kitchen", text: "call the plumber", dueAt: new Date(2026, 8, 28, 17).getTime() },
      { key: "kitchen", label: expect.stringMatching(/ · due /) },
    );
  });

  test("a session with no client id (a browser tab) cannot take one", async () => {
    const workflows = installStubWorkflows();
    const ctx = createToolContext({ workflows });
    const result = await runTool(remindMe, { text: "x", in_seconds: 60 }, ctx);
    expect(result).toHaveProperty("error");
    expect(workflows.start).not.toHaveBeenCalled();
  });

  test("no usable time, or more than a week away, is refused", async () => {
    const workflows = installStubWorkflows();
    const ctx = createToolContext({ clientId: "k", workflows });
    expect(await runTool(remindMe, { text: "x", at: "five" }, ctx)).toHaveProperty("error");
    const tooFar = MAX_REMINDER_MS / 1000 + 1;
    expect(await runTool(remindMe, { text: "x", in_seconds: tooFar }, ctx)).toHaveProperty("error");
    expect(workflows.start).not.toHaveBeenCalled();
  });
});

describe("cancel_reminders", () => {
  test("cancels this speaker's reminders that have not fired, and counts them", async () => {
    const workflows = installStubWorkflows({
      runs: [
        createRunSnapshot({ runId: "a", workflow: "remind", status: "running" }),
        createRunSnapshot({ runId: "b", workflow: "remind", status: "pending" }),
        createRunSnapshot({ runId: "c", workflow: "remind", status: "completed", output: {} }),
      ],
    });
    const ctx = createToolContext({ clientId: "kitchen", workflows });
    expect(await runTool(cancelReminders, {}, ctx)).toEqual({ cancelled: 2 });
    expect(workflows.cancelAll).toHaveBeenCalledWith(remind, "kitchen");
  });
});

describe("the remind workflow", () => {
  test("sleeps until it is due, then delivers in one retried step", async () => {
    const dueAt = NOW.getTime() + 60_000;
    const ctx = createWorkflowContext({ runSteps: false });
    await remindFlow({ clientId: "kitchen", text: "flip the laundry", dueAt }, ctx);
    expect(ctx.slept).toEqual([{ label: "due", until: new Date(dueAt) }]);
    expect(ctx.steps).toEqual([{ name: "deliver", maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS }]);
  });

  test("deliver says the reminder on the speaker under the run id", async () => {
    const speech = installStubSpeech({ pcmBytes: 3200 });
    const inbox = installStubClientInbox();
    const ctx = createWorkflowContext({ runId: "wrun_7" });
    await remindFlow({ clientId: "kitchen", text: "flip the laundry", dueAt: 0 }, ctx);
    expect(speech.calls).toMatchObject([{ text: "Reminder: flip the laundry" }]);
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
  });

  test("a speaker that is busy fails the attempt as retryable, so the step redelivers", async () => {
    installStubSpeech();
    installStubClientInbox({ answer: "busy" });
    const ctx = createWorkflowContext({ runId: "wrun_8" });
    await expect(
      remindFlow({ clientId: "kitchen", text: "x", dueAt: 0 }, ctx),
    ).rejects.toMatchObject({ name: "ClientUnreachableError", reason: "busy" });
  });
});
