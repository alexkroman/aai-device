import {
  type ConversationLogEntry,
  ConversationView,
  SessionErrorBanner,
  ToolCallRow,
} from "@alexkroman1/aai-ui";
import { type FormEvent, useState } from "react";
import { linked } from "./client-id.ts";
import { Ring } from "./ring.tsx";
import { Sidebar } from "./sidebar.tsx";
import { type Led, useDevice } from "./use-device.ts";

// The speaker, on a page: its ring as a button that starts and ends a live conversation on one side, and on the other
// everything said to it, which the speaker itself cannot show, plus a box to type to it.

const STATUS: Record<Led, string> = {
  off: "Tap the ring or press space to talk, or type",
  connecting: "Connecting…",
  listening: "Listening: tap again to hang up",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Couldn’t reach the agent",
};

export function App() {
  const device = useDevice();
  const { live, buttonProps } = device.tap;

  return (
    <main className="flex flex-col md:flex-row h-screen bg-aai-bg text-aai-text">
      <section className="flex flex-col items-center gap-6 p-6 md:w-96 shrink-0 overflow-y-auto border-b md:border-b-0 md:border-r border-aai-border">
        {/* One press goes live, mic open for a realtime conversation; the next hangs up. */}
        <button
          type="button"
          {...buttonProps}
          className={`relative grid place-items-center rounded-full bg-aai-surface border border-aai-border cursor-pointer select-none transition-transform focus-visible:outline-2 focus-visible:outline-aai-primary ${
            live ? "scale-95" : ""
          }`}
        >
          <Ring led={device.led} />
          <span className="absolute text-sm font-semibold tracking-wide opacity-70">
            {live ? "Tap to hang up" : "Tap to talk"}
          </span>
        </button>
        <p className="text-sm text-center text-balance min-h-10 leading-relaxed" aria-live="polite">
          {STATUS[device.led]}
        </p>
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
        <ConversationView
          log={device.history}
          className="flex-1 min-h-0"
          scrollClassName="aai-scroll overflow-y-auto"
          contentClassName="px-4 py-4 flex flex-col gap-3"
          empty={
            <p className="text-sm text-center opacity-40 py-12">
              Nothing said yet. Tap to talk, or type below.
            </p>
          }
          renderMessage={(m) => <Bubble from={m.role} text={m.content} />}
          renderStreaming={(text) => <Bubble from="assistant" text={text} live />}
          renderTranscript={({ text }) => text && <Bubble from="user" text={text} live />}
          renderTool={(t) => (
            <ToolCallRow
              title={t.name}
              detail={Object.keys(t.args).length > 0 ? JSON.stringify(t.args) : undefined}
              pending={t.status === "pending"}
              variant="compact"
              className="self-start max-w-full"
            />
          )}
          renderNote={(n) => (
            <p className="text-xs text-center opacity-50">
              {clock(n.at)} · {n.text}
            </p>
          )}
          renderSessionHeader={(entry) => (
            <SessionHeader
              entry={entry}
              current={device.sessionId}
              onContinue={device.continueSession}
            />
          )}
          thinkingLabel="The speaker is thinking"
          thinkingClassName="self-start text-sm opacity-50 px-3"
        />
        <SessionErrorBanner className="mx-3 mb-2" />
        <Composer onSend={device.tap.send} />
      </section>
    </main>
  );
}

/** A session's time, and a way to make it the one a turn goes to. */
function SessionHeader({
  entry,
  current,
  onContinue,
}: {
  entry: Extract<ConversationLogEntry, { kind: "session" }>;
  /** The session a turn goes to now. */
  current: string | undefined;
  /** Make an earlier session the one a turn goes to. */
  onContinue: (sessionId: string) => void;
}) {
  // Only a session of the page's CURRENT client can be continued from here: resumed under
  // another id, it would move into that conversation.
  const mine = (entry.clientId ?? linked.own()) === linked.id();
  return (
    <p className="text-xs text-center opacity-40">
      {clock(entry.at)}
      {entry.sessionId === current ? (
        <span className="ml-2 text-aai-primary">· current</span>
      ) : mine ? (
        <button
          type="button"
          className="ml-2 underline hover:opacity-100"
          title="Type or talk to this conversation again"
          onClick={() => onContinue(entry.sessionId)}
        >
          continue
        </button>
      ) : null}
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

function clock(at: number): string {
  return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
