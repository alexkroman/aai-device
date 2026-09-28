import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { browserId, clientId } from "./client-id.ts";
import type { Entry, Item } from "./history.ts";
import { Ring } from "./ring.tsx";
import { readSetting, type Setting, writeSetting } from "./settings.ts";
import { Sidebar } from "./sidebar.tsx";
import { type Led, useDevice } from "./use-device.ts";

// The speaker, on a page: its ring as a hold-to-talk button on one side, and on the other
// everything said to it, which the speaker itself cannot show, plus a box to type to it.

const STATUS: Record<Led, string> = {
  off: "Hold the ring or the space bar to talk, or type",
  connecting: "Connecting…",
  listening: "Listening: let go when you’re done",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Couldn’t reach the agent",
};

export function App() {
  const device = useDevice();

  return (
    <main className="flex flex-col md:flex-row h-screen bg-aai-bg text-aai-text">
      <section className="flex flex-col items-center gap-6 p-6 md:w-96 shrink-0 overflow-y-auto border-b md:border-b-0 md:border-r border-aai-border">
        <TalkButton
          led={device.led}
          talking={device.talking}
          onStart={device.startTalking}
          onStop={device.stopTalking}
        />
        <p className="text-sm text-center text-balance min-h-10 leading-relaxed" aria-live="polite">
          {STATUS[device.led]}
        </p>
        <SettingField
          setting="phone"
          label="Text me at (with the country code, e.g. +1)"
          placeholder="e.g. +1 555 555 0123"
          type="tel"
        />
        <p className="text-xs opacity-60" title="Reminders and research summaries come here">
          Speaker {device.clientId}: inbox {device.inboxUp ? "connected" : "offline"}
        </p>
        <Sidebar
          current={device.sessionId}
          onContinue={device.continueSession}
          endSession={device.endSession}
        />
      </section>

      <section className="flex flex-col flex-1 min-h-0">
        <header className="flex items-center justify-between px-4 py-3 border-b border-aai-border">
          <h1 className="text-sm font-bold">Home Speaker</h1>
          <button
            type="button"
            className="text-xs opacity-60 hover:opacity-100"
            title="Hang up for good: the conversation is compacted, as a speaker's is, and the next turn starts fresh"
            onClick={device.newSession}
          >
            New session
          </button>
        </header>
        <History
          entries={device.history}
          current={device.sessionId}
          onContinue={device.continueSession}
        >
          {device.transcript.text && <Bubble from="user" text={device.transcript.text} live />}
          {device.streaming && <Bubble from="assistant" text={device.streaming} live />}
        </History>
        {device.error && (
          <p role="alert" className="px-4 py-2 text-sm text-red-400 border-t border-aai-border">
            {device.error.message}
          </p>
        )}
        <Composer onSend={device.send} />
      </section>
    </main>
  );
}

/**
 * Held, the mic is open. Released any way at all (off the button, the window losing
 * focus mid-hold, the page going away) it closes: a mic left open by a missed release
 * would feed the agent the room.
 */
function TalkButton({
  led,
  talking,
  onStart,
  onStop,
}: {
  led: Led;
  talking: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  // The latest handlers, read at call time. They change on every session snapshot, and
  // re-subscribing the listeners below each time would run their cleanup, whose
  // release ends the hold the moment the session starts connecting.
  const handlers = useRef({ onStart, onStop });
  handlers.current = { onStart, onStop };
  const held = useRef(false);
  const down = useCallback(() => {
    if (held.current) return;
    held.current = true;
    handlers.current.onStart();
  }, []);
  const up = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    handlers.current.onStop();
  }, []);

  // The space bar anywhere but a text field; its auto-repeat is not a new press.
  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      e.target instanceof Element && e.target.closest("input, textarea") != null;
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e)) return;
      e.preventDefault();
      if (!e.repeat) down();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e)) up();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", up);
      up();
    };
  }, [down, up]);

  return (
    <button
      type="button"
      aria-pressed={talking}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        down();
      }}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      // Space is handled page-wide above; the button's own click would double it.
      onKeyDown={(e) => e.code === "Space" && e.preventDefault()}
      className={`relative grid place-items-center rounded-full bg-aai-surface border border-aai-border cursor-pointer select-none touch-none transition-transform focus-visible:outline-2 focus-visible:outline-aai-primary ${
        talking ? "scale-95" : ""
      }`}
    >
      <Ring led={led} />
      <span className="absolute text-sm font-semibold tracking-wide opacity-70">
        {talking ? "Listening" : "Hold to talk"}
      </span>
    </button>
  );
}

function History({
  entries,
  current,
  onContinue,
  children,
}: {
  entries: readonly Entry[];
  /** The session a turn goes to now. */
  current: string | undefined;
  /** Make an earlier session the one a turn goes to. */
  onContinue: (sessionId: string) => void;
  children: ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  const last = entries.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on any new content
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries.length, last, children]);

  return (
    <div className="aai-scroll flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
      {entries.length === 0 && (
        <p className="text-sm text-center opacity-40 py-12">
          Nothing said yet. Hold to talk, or type below.
        </p>
      )}
      {entries.map((entry) =>
        entry.kind === "note" ? (
          <p key={`n${entry.at}${entry.text}`} className="text-xs text-center opacity-50">
            {clock(entry.at)} · {entry.text}
          </p>
        ) : (
          <div key={`s${entry.sessionId}${entry.at}`} className="flex flex-col gap-2">
            <p className="text-xs text-center opacity-40">
              {clock(entry.at)}
              {entry.sessionId === current ? (
                <span className="ml-2 text-aai-primary">· current</span>
              ) : (entry.clientId ?? browserId()) !== clientId() ? null : (
                <button
                  type="button"
                  className="ml-2 underline hover:opacity-100"
                  title="Type or talk to this conversation again"
                  onClick={() => onContinue(entry.sessionId)}
                >
                  continue
                </button>
              )}
            </p>
            {entry.items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items are append-only within a session
              <Row key={i} item={item} />
            ))}
          </div>
        ),
      )}
      {children}
      <div ref={end} />
    </div>
  );
}

function Row({ item }: { item: Item }) {
  if (item.kind === "message") return <Bubble from={item.role} text={item.text} />;
  return (
    <p className="text-xs font-mono opacity-50 whitespace-pre-wrap [overflow-wrap:anywhere]">
      {item.done ? "✓" : "…"} {item.name} {item.args === "{}" ? "" : item.args}
    </p>
  );
}

function Bubble({
  from,
  text,
  live,
}: {
  from: "user" | "assistant";
  text: string;
  live?: boolean;
}) {
  const mine = from === "user";
  return (
    <p
      className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
        mine
          ? "self-end bg-aai-primary text-aai-bg"
          : "self-start bg-aai-surface border border-aai-border"
      } ${live ? "opacity-60" : ""}`}
    >
      {text}
    </p>
  );
}

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSend(text);
    setText("");
  };
  return (
    <form onSubmit={submit} className="flex gap-2 p-3 border-t border-aai-border">
      <label htmlFor="say" className="sr-only">
        Type to the speaker
      </label>
      <input
        id="say"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type instead of talking…"
        autoComplete="off"
        className="flex-1 px-3 py-2 rounded-lg bg-aai-surface border border-aai-border text-sm outline-none focus:border-aai-primary"
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="px-4 py-2 rounded-lg bg-aai-primary text-aai-bg text-sm font-semibold disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}

/** One of the values this browser reports on connect (settings.ts); saved as typed. */
function SettingField({
  setting,
  label,
  placeholder,
  type = "text",
}: {
  setting: Setting;
  label: string;
  placeholder: string;
  type?: "text" | "tel";
}) {
  const [value, setValue] = useState(() => readSetting(setting));
  return (
    <label className="w-full flex flex-col gap-1 text-xs opacity-70">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          writeSetting(setting, e.target.value);
        }}
        placeholder={placeholder}
        className="px-3 py-2 rounded-lg bg-aai-surface border border-aai-border text-sm outline-none focus:border-aai-primary"
      />
    </label>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
