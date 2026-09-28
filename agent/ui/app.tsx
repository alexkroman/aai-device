import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { clearHistory, type Entry, type Item } from "./history.ts";
import { readLocation, writeLocation } from "./location.ts";
import { Ring } from "./ring.tsx";
import type { Timer } from "./timers.ts";
import { type Led, useDevice } from "./use-device.ts";

// The speaker, on a page: its ring as a hold-to-talk button on one side, and on the other
// everything said to it, which the speaker itself cannot show, plus a box to type to it.

const STATUS: Record<Led, string> = {
  off: "Hold the ring or the space bar to talk, or type",
  connecting: "Connecting…",
  listening: "Listening: let go when you’re done",
  thinking: "Thinking",
  speaking: "Speaking",
  alarm: "Timer! Press the ring to stop it",
  error: "Couldn’t reach the agent",
};

export function App() {
  const device = useDevice();

  return (
    <main className="flex flex-col md:flex-row h-screen bg-aai-bg text-aai-text">
      <section className="flex flex-col items-center justify-center gap-6 p-6 md:w-96 shrink-0 border-b md:border-b-0 md:border-r border-aai-border">
        <TalkButton
          led={device.led}
          talking={device.talking}
          onStart={device.startTalking}
          onStop={device.stopTalking}
        />
        <p className="text-sm text-center text-balance min-h-10 leading-relaxed" aria-live="polite">
          {STATUS[device.led]}
        </p>
        <Timers timers={device.timers} />
        <LocationField />
      </section>

      <section className="flex flex-col flex-1 min-h-0">
        <header className="flex items-center justify-between px-4 py-3 border-b border-aai-border">
          <h1 className="text-sm font-bold">Home Speaker</h1>
          <button
            type="button"
            className="text-xs opacity-60 hover:opacity-100"
            onClick={() => {
              clearHistory();
              device.setHistory([]);
            }}
          >
            Clear history
          </button>
        </header>
        <History entries={device.history}>
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

function History({ entries, children }: { entries: readonly Entry[]; children: ReactNode }) {
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
            <p className="text-xs text-center opacity-40">{clock(entry.at)}</p>
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
    <p className="text-xs font-mono opacity-50 truncate">
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

function Timers({ timers }: { timers: readonly Timer[] }) {
  const [now, setNow] = useState(Date.now());
  const running = timers.length > 0;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);
  if (!running) return null;
  return (
    <ul className="w-full flex flex-col gap-1 text-sm">
      {timers.map((t) => (
        <li
          key={t.id}
          className="flex justify-between px-3 py-2 rounded-lg bg-aai-surface border border-aai-border"
        >
          <span>{t.label || "Timer"}</span>
          <span className="font-mono tabular-nums">{countdown(t.dueMs - now)}</span>
        </li>
      ))}
    </ul>
  );
}

// The device's CONFIG_AAI_DEVICE_ADDRESS, for "the weather" and "near me". Kept in this
// browser only, like the device keeps it in its gitignored sdkconfig; read on each connect.
function LocationField() {
  const [value, setValue] = useState(readLocation);
  return (
    <label className="w-full flex flex-col gap-1 text-xs opacity-70">
      Speaker’s address
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          writeLocation(e.target.value);
        }}
        placeholder="e.g. 123 Main St, Springfield"
        className="px-3 py-2 rounded-lg bg-aai-surface border border-aai-border text-sm outline-none focus:border-aai-primary"
      />
    </label>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
