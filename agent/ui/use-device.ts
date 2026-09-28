import { useConversation, useEvent, useSession } from "@alexkroman1/aai-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { playAlarm, stopCues, unlockAudio } from "./cues.ts";
import {
  addNote,
  type Entry,
  loadHistory,
  recordSession,
  saveHistory,
  toItems,
} from "./history.ts";
import { useSessionId } from "./session-id.ts";
import { addTimer, cancelTimers, popDue, type Timer } from "./timers.ts";

// firmware main.c, on top of the SDK's browser session:
//
//   IDLE --talk/type--> CONNECTING --connected--> ACTIVE --quiet for FOLLOWUP_MS--> IDLE
//
// No wake word: the mic is held open by a button (or the space bar) and muted otherwise.
// Muted still streams silence, so the agent's own endpointing ends the turn on release;
// the agent keeps automatic turn detection because the device, with no button, needs it.
// Typing is a turn too, and opens the session first if it is idle. Hanging up is
// disconnect(), not end(), so the next turn RESUMES the session the way the device's
// ?sessionId= does and the agent still knows what was said a minute ago.

/** firmware sdkconfig CONFIG_AAI_FOLLOWUP_MS */
const FOLLOWUP_MS = 8000;
const CONNECT_TIMEOUT_MS = 8000;
const THINKING_TIMEOUT_MS = 60_000;
const TICK_MS = 100;
const RING_PERIOD_MS = 1500;
const RING_MAX_MS = 60_000;

export type Phase = "idle" | "connecting" | "active";
/** firmware leds.h, minus BOOTING */
export type Led = "off" | "connecting" | "listening" | "thinking" | "speaking" | "alarm" | "error";

export function useDevice() {
  const session = useSession();
  const { items, streaming, transcript } = useConversation();
  const sessionId = useSessionId();

  const phase: Phase = !session.running
    ? "idle"
    : session.state === "connecting"
      ? "connecting"
      : "active";

  const [history, setHistory] = useState<Entry[]>(loadHistory);
  const [timers, setTimers] = useState<Timer[]>([]);
  const [ringUntil, setRingUntil] = useState(0); // 0 = not ringing
  const [failed, setFailed] = useState(false);
  const [talking, setTalking] = useState(false);
  const pendingText = useRef<string | null>(null);
  const phaseSince = useRef(Date.now());
  const lastActivity = useRef(Date.now());
  const nextRing = useRef(0);
  // Events and the tick read the timers through this, so two events in one render
  // each see the other's change.
  const timersNow = useRef(timers);
  timersNow.current = timers;
  const updateTimers = (next: Timer[]) => {
    timersNow.current = next;
    setTimers(next);
  };

  const note = useCallback((text: string) => setHistory((h) => addNote(h, text, Date.now())), []);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  // The live conversation IS the newest history entry; see recordSession.
  useEffect(() => {
    if (sessionId) setHistory((h) => recordSession(h, sessionId, toItems(items), Date.now()));
  }, [sessionId, items]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each phase change
  useEffect(() => {
    phaseSince.current = Date.now();
    lastActivity.current = Date.now();
  }, [phase]);

  // agent_last_activity_ms(): anything the session does keeps the window open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the activity
  useEffect(() => {
    lastActivity.current = Date.now();
  }, [session.state, transcript.text, streaming, items]);

  useEffect(() => {
    if (session.error) setFailed(true);
  }, [session.error]);

  const hangUp = useCallback(() => {
    pendingText.current = null;
    session.disconnect();
  }, [session]);

  const connect = useCallback(() => {
    setFailed(false);
    if (session.started) session.toggle();
    else session.start();
  }, [session]);

  const ringing = ringUntil !== 0;

  // Muted until a hold: set before connect(), so a typed turn never opens the mic.
  useEffect(() => {
    session.setMicMuted(!talking);
  }, [session, talking]);

  /** stop_ringing(), noted in the history when someone stopped it. */
  const stopRinging = useCallback(
    (why?: string) => {
      setRingUntil(0);
      stopCues();
      if (why) note(why);
    },
    [note],
  );

  /** The button went down: stop an alarm, interrupt a reply, open the mic. */
  const startTalking = useCallback(() => {
    unlockAudio();
    if (ringing) {
      // As on the device, a press while it rings only stops the alarm.
      stopRinging("Alarm stopped");
      return;
    }
    if (phase === "idle") connect();
    else session.cancel();
    setTalking(true);
  }, [ringing, phase, session, connect, stopRinging]);

  /** The button came up: silence from here lets the agent end the turn. */
  const stopTalking = useCallback(() => {
    setTalking(false);
    lastActivity.current = Date.now();
  }, []);

  /** Typing is a turn. Idle, it opens the session first and goes once it is up. */
  const send = useCallback(
    (text: string) => {
      const line = text.trim();
      if (!line) return;
      unlockAudio();
      if (ringing) stopRinging("Alarm stopped");
      if (phase === "active") {
        session.sendText(line);
        return;
      }
      pendingText.current = line;
      if (phase === "idle") connect();
    },
    [ringing, phase, session, connect, stopRinging],
  );

  useEffect(() => {
    if (phase === "active" && pendingText.current) {
      session.sendText(pendingText.current);
      pendingText.current = null;
    }
  }, [phase, session]);

  // on_tick(): timers, the ring, and the two ways a session ends on its own.
  const tick = useRef<() => void>(() => {});
  tick.current = () => {
    const now = Date.now();
    const { due, left } = popDue(timersNow.current, now);
    if (due.length > 0) {
      updateTimers(left);
      for (const t of due) note(`Timer done${t.label ? `: ${t.label}` : ""}`);
      setRingUntil(now + RING_MAX_MS);
      nextRing.current = now;
    }
    if (ringing) {
      if (now >= ringUntil) {
        stopRinging("Alarm unanswered");
      } else if (now >= nextRing.current) {
        void playAlarm();
        nextRing.current = now + RING_PERIOD_MS;
      }
    }
    if (phase === "connecting" && now - phaseSince.current > CONNECT_TIMEOUT_MS) {
      setFailed(true);
      hangUp();
    } else if (phase === "active" && !talking && session.state !== "speaking") {
      const limit = session.state === "thinking" ? THINKING_TIMEOUT_MS : FOLLOWUP_MS;
      if (now - lastActivity.current > limit) hangUp();
    }
  };
  useEffect(() => {
    const id = setInterval(() => tick.current(), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // The three events the firmware parses out of custom.emitted (protocol.c).
  useEvent<{ seconds: number; label?: string }>("timer.set", ({ seconds, label }) => {
    const next = addTimer(timersNow.current, Date.now(), seconds, label);
    if (next) updateTimers(next);
    else note(`Timer dropped: ${timersNow.current.length} already running`);
  });
  useEvent<{ label?: string }>("timer.cancel", ({ label }) => {
    updateTimers(cancelTimers(timersNow.current, label));
  });
  // stop_everything(): the model is still writing its follow-up to the stop call, so
  // cancel it and hang up, and nothing it says after has anywhere to play.
  useEvent("stop", () => {
    updateTimers([]);
    if (ringing) stopRinging("Alarm stopped");
    setTalking(false);
    session.cancel();
    hangUp();
  });

  const led: Led = ringing
    ? "alarm"
    : phase === "connecting"
      ? "connecting"
      : phase === "idle"
        ? failed
          ? "error"
          : "off"
        : session.state === "speaking"
          ? "speaking"
          : session.state === "thinking"
            ? "thinking"
            : talking
              ? "listening"
              : "off";

  return {
    phase,
    led,
    ringing,
    timers,
    history,
    setHistory,
    streaming,
    transcript,
    error: session.error,
    talking,
    startTalking,
    stopTalking,
    send,
    hangUp,
  };
}
