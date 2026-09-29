import {
  type InboxEvent,
  type InboxNotice,
  useConversation,
  useEvent,
  useInbox,
  useSession,
  useSessionId,
} from "@alexkroman1/aai-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { clientId } from "./client-id.ts";
import {
  addNote,
  addSpoken,
  type Entry,
  type Item,
  loadHistory,
  recordSession,
  saveHistory,
  toItems,
} from "./history.ts";

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
const FOLLOWUP_MS = 3000;
const CONNECT_TIMEOUT_MS = 8000;
const THINKING_TIMEOUT_MS = 60_000;
const TICK_MS = 100;

export type Phase = "idle" | "connecting" | "active";
/** firmware leds.h, minus BOOTING */
export type Led = "off" | "connecting" | "listening" | "thinking" | "speaking" | "error";

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
  const [failed, setFailed] = useState(false);
  const [talking, setTalking] = useState(false);
  const pendingText = useRef<string | null>(null);
  const phaseSince = useRef(Date.now());
  const lastActivity = useRef(Date.now());

  const note = useCallback((text: string) => setHistory((h) => addNote(h, text, Date.now())), []);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  // The live conversation IS the newest history entry; see recordSession.
  useEffect(() => {
    if (sessionId)
      setHistory((h) => recordSession(h, sessionId, toItems(items), Date.now(), clientId()));
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

  // inbox.c, from the SDK (aai-ui useInbox): held open from load, idle or not, and busy
  // mid-conversation as the device is, so a reminder never talks over a reply.
  const busy = useRef(false);
  busy.current = phase !== "idle";
  // The live conversation of every OTHER session of this client: the speaker's, when
  // this page is linked to one. The page's own session already shows itself.
  const ownSession = useRef(sessionId);
  ownSession.current = sessionId;
  const mirrored = useRef(new Map<string, Item[]>());
  const onEvent = useCallback((e: InboxEvent) => {
    if (e.sessionId === ownSession.current) return;
    const items = mirrored.current.get(e.sessionId) ?? [];
    if (e.type === "session_ended") {
      mirrored.current.delete(e.sessionId);
      return;
    }
    const next = mirrorItem(e.event);
    if (!next) return;
    items.push(next);
    mirrored.current.set(e.sessionId, items);
    setHistory((h) => recordSession(h, e.sessionId, [...items], Date.now(), clientId()));
  }, []);
  const inbox = useInbox({
    busy: () => busy.current,
    events: true,
    onEvent,
    // What the speaker said out loud is its turn, word for word: shown as its bubble.
    onNotice: (n) => {
      const said = n.data?.said;
      if (typeof said === "string" && said.trim())
        setHistory((h) => addSpoken(h, said, Date.now()));
      else note(noticeText(n));
    },
  });
  const stopCues = inbox.stopPlayback;

  const hangUp = useCallback(() => {
    pendingText.current = null;
    session.disconnect();
  }, [session]);

  /**
   * What a speaker does once its resume window has passed: end the session for good
   * rather than park it. The server compacts it (onSessionEnd → workflows/memorize.ts)
   * and the next turn opens a NEW session, which starts from that compacted history.
   */
  /**
   * Make an earlier session the one the next turn goes to: the server resumes it by id,
   * with its own turns and the speaker's history before it. Idle, it connects on the
   * next turn as usual; the resume just names which conversation that is.
   */
  const continueSession = useCallback(
    (id: string) => {
      pendingText.current = null;
      stopCues();
      setTalking(false);
      session.resume(id);
      note("Continuing an earlier conversation");
    },
    [session, note, stopCues],
  );

  const newSession = useCallback(() => {
    pendingText.current = null;
    stopCues();
    setTalking(false);
    session.end();
    note("New session");
  }, [session, note, stopCues]);

  const connect = useCallback(() => {
    setFailed(false);
    if (session.started) session.toggle();
    else session.start();
  }, [session]);

  // Muted until a hold: set before connect(), so a typed turn never opens the mic.
  useEffect(() => {
    session.setMicMuted(!talking);
  }, [session, talking]);

  /** The button went down: cut off a notice, interrupt a reply, open the mic. */
  const startTalking = useCallback(() => {
    stopCues();
    if (phase === "idle") connect();
    else session.cancel();
    setTalking(true);
  }, [phase, session, connect, stopCues]);

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
      if (phase === "active") {
        session.sendText(line);
        return;
      }
      pendingText.current = line;
      if (phase === "idle") connect();
    },
    [phase, session, connect],
  );

  useEffect(() => {
    if (phase === "active" && pendingText.current) {
      session.sendText(pendingText.current);
      pendingText.current = null;
    }
  }, [phase, session]);

  // on_tick(): the two ways a session ends on its own.
  const tick = useRef<() => void>(() => {});
  tick.current = () => {
    const now = Date.now();
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

  // stop_everything(), the one event the firmware parses out of custom.emitted
  // (protocol.c): the model is still writing its follow-up to the stop call, so cancel it
  // and hang up, and nothing it says after has anywhere to play.
  useEvent("stop", () => {
    stopCues();
    setTalking(false);
    session.cancel();
    hangUp();
  });

  const led: Led =
    phase === "connecting"
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
    newSession,
    continueSession,
    endSession: session.end,
    sessionId,
    clientId: clientId(),
    inboxUp: inbox.connected,
  };
}

/** A history item for one mirrored event, or undefined for the ones not shown. */
function mirrorItem(event: { type: string } & Record<string, unknown>): Item | undefined {
  const text = typeof event.text === "string" ? event.text.trim() : "";
  switch (event.type) {
    case "user-transcript.committed":
      return text ? { kind: "message", role: "user", text } : undefined;
    case "agent-transcript.committed":
      // A recovery phrase ("sorry, say that again") is the agent's filler, not a reply.
      return text && !event.recovery ? { kind: "message", role: "assistant", text } : undefined;
    case "tool.called":
      return typeof event.toolName === "string"
        ? { kind: "tool", name: event.toolName, args: JSON.stringify(event.args ?? {}), done: true }
        : undefined;
    default:
      return undefined;
  }
}

/** The history line for a notice that carries no `said`: from a server older than this page. */
function noticeText(n: InboxNotice): string {
  const text = n.data?.text ?? n.data?.topic;
  const what = typeof text === "string" ? `: ${text}` : "";
  const label =
    n.event === "reminder" ? "Reminder" : n.event.charAt(0).toUpperCase() + n.event.slice(1);
  return `${label}${what}`;
}
