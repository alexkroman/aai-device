import {
  type InboxNotice,
  useEvent,
  useInbox,
  useSession,
  useSessionId,
  useTapToTalk,
} from "@alexkroman1/aai-ui";
import { useCallback, useEffect } from "react";
import { linked } from "./client-id.ts";
import { useHistory } from "./history.ts";

// firmware main.c, on top of the SDK's browser session:
//
//   IDLE --press/type--> CONNECTING --connected--> ACTIVE --press, or quiet for FOLLOWUP_MS if not live--> IDLE
//
// No wake word: one press (the ring or the space bar) goes LIVE, a realtime conversation
// with the mic open, and the next press hangs up. That, the muted mic for a typed turn,
// the follow-up window and the connect timeout are aai-ui's useTapToTalk, run on the
// device's clocks. Hanging up is disconnect(), not end(), so the next turn RESUMES the
// session the way the device's ?sessionId= does.

/** firmware sdkconfig CONFIG_AAI_FOLLOWUP_MS */
const FOLLOWUP_MS = 3000;
const CONNECT_TIMEOUT_MS = 8000;
const THINKING_TIMEOUT_MS = 60_000;

/** firmware leds.h, minus BOOTING */
export type Led = "off" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export function useDevice() {
  const session = useSession();
  const sessionId = useSessionId();
  const tap = useTapToTalk({
    idleHangupMs: FOLLOWUP_MS,
    thinkingHangupMs: THINKING_TIMEOUT_MS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });
  const log = useHistory();
  const { addNote, addSpoken } = log;

  // inbox.c, from the SDK: held open from load, busy while the session runs as the
  // device is, so a reminder never talks over a reply. Every OTHER session of this
  // client (the linked speaker's) is mirrored into the log.
  const inbox = useInbox({
    onEvent: log.mirror,
    // What the speaker said out loud is its turn, word for word: shown as its bubble.
    onNotice: (n) => {
      const said = n.data?.said;
      if (typeof said === "string" && said.trim()) addSpoken(said);
      else addNote(noticeText(n));
    },
  });
  const stopCues = inbox.stopPlayback;

  // Going live cuts off a notice that is playing.
  useEffect(() => {
    if (tap.live) stopCues();
  }, [tap.live, stopCues]);

  /**
   * Make an earlier session the one the next turn goes to: the server resumes it by id,
   * with its own turns and the speaker's history before it.
   */
  const continueSession = useCallback(
    (id: string) => {
      stopCues();
      tap.hangUp();
      session.resume(id);
      addNote("Continuing an earlier conversation");
    },
    [session, tap, addNote, stopCues],
  );

  /**
   * What a speaker does once its resume window has passed: end the session for good. The
   * server compacts it (onSessionEnd → workflows/memorize.ts) and the next turn opens a
   * NEW session, which starts from that compacted history.
   */
  const newSession = useCallback(() => {
    stopCues();
    tap.hangUp();
    session.end();
    addNote("New session");
  }, [session, tap, addNote, stopCues]);

  // stop_everything(), the one event the firmware parses out of custom.emitted
  // (protocol.c): the model is still writing its follow-up to the stop call, so cancel it
  // and hang up, and nothing it says after has anywhere to play.
  useEvent("stop", () => {
    stopCues();
    session.cancel();
    tap.hangUp();
  });

  const led: Led =
    tap.phase === "connecting"
      ? "connecting"
      : tap.phase === "idle"
        ? tap.failed
          ? "error"
          : "off"
        : session.state === "speaking"
          ? "speaking"
          : session.state === "thinking"
            ? "thinking"
            : tap.live
              ? "listening"
              : "off";

  return {
    led,
    tap,
    history: log.entries,
    newSession,
    continueSession,
    endSession: session.end,
    sessionId,
    clientId: linked.id(),
    inboxUp: inbox.connected,
  };
}

/** The history line for a notice that carries no `said`: from a server older than this page. */
function noticeText(n: InboxNotice): string {
  const text = n.data?.text ?? n.data?.topic;
  const what = typeof text === "string" ? `: ${text}` : "";
  const label =
    n.event === "reminder" ? "Reminder" : n.event.charAt(0).toUpperCase() + n.event.slice(1);
  return `${label}${what}`;
}
