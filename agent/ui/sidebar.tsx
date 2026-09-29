import { type ReactNode, useCallback, useEffect, useState } from "react";
import { VERBATIM_WINDOW_MS } from "../history-window.ts";
import { api } from "./api.ts";
import { browserId, linkedSpeaker, setLinkedSpeaker } from "./client-id.ts";

// Everything about the speaker that isn't the conversation: the household profile, the
// runs going on for it, what it remembers, and the context each session started with,
// all read and edited through the agent's /api routes (routes.ts). Plus the link that
// makes this page a speaker's twin.

const input =
  "w-full px-3 py-2 rounded-lg bg-aai-surface border border-aai-border text-sm outline-none focus:border-aai-primary";
const small = "text-xs opacity-60 hover:opacity-100 disabled:opacity-30";

export function Sidebar(props: {
  current: string | undefined;
  onContinue: (sessionId: string) => void;
  /** End the current session for good: a page changing whose conversation it is. */
  endSession: () => void;
}) {
  return (
    <div className="w-full flex flex-col gap-3">
      <Panel title="Household" open>
        <Profile />
      </Panel>
      <Panel title="Link to a speaker">
        <Link endSession={props.endSession} />
      </Panel>
      <Panel title="Running" open>
        <Tasks />
      </Panel>
      <Panel title="Sessions">
        <Sessions current={props.current} onContinue={props.onContinue} />
      </Panel>
      <Panel title="Memories">
        <Memories />
      </Panel>
      <Panel title="Context">
        <Context />
      </Panel>
    </div>
  );
}

function Panel({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="w-full rounded-lg border border-aai-border">
      <summary className="px-3 py-2 text-xs font-bold cursor-pointer select-none">{title}</summary>
      <div className="px-3 pb-3 flex flex-col gap-2">{children}</div>
    </details>
  );
}

/** Load `path`, and again whenever `reload` is called or every `pollMs`. */
function useApi<T>(path: string, pollMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    api<T>("GET", path)
      .then((d) => {
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [path]);
  useEffect(() => {
    reload();
    if (!pollMs) return;
    const id = setInterval(reload, pollMs);
    return () => clearInterval(id);
  }, [reload, pollMs]);
  return { data, error, reload };
}

function Failure({ error }: { error: string | undefined }) {
  return error ? <p className="text-xs text-red-400">{error}</p> : null;
}

// --- Household profile ------------------------------------------------------------------

type ProfileData = { name: string; home_address: string; phone_last4: string };

function Profile() {
  const { data, error, reload } = useApi<ProfileData>("/profile");
  const [saving, setSaving] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const save = (field: "name" | "home_address", value: string) => {
    if (!data || value.trim() === data[field]) return;
    setSaving(field);
    api("PUT", "/profile", { [field]: value })
      .then(() => setFailed(undefined))
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setSaving(undefined);
        reload();
      });
  };
  if (!data) return <Failure error={error ?? (data ? undefined : "")} />;
  return (
    <>
      <Field
        label="Name"
        value={data.name}
        placeholder="What to call you"
        busy={saving === "name"}
        onSave={(v) => save("name", v)}
      />
      <Field
        label="Home address (what “near me” and “the weather” mean)"
        value={data.home_address}
        placeholder="e.g. 123 Main St, Springfield"
        busy={saving === "home_address"}
        onSave={(v) => save("home_address", v)}
      />
      <p className="text-xs opacity-60">
        {data.phone_last4
          ? `Texts go to the number ending in ${data.phone_last4}. Say a new one to change it.`
          : "No phone saved: tell the speaker your number and read back the code it texts."}
      </p>
      <Failure error={failed} />
    </>
  );
}

/** A text field saved on blur or Enter, showing the saved value when it comes back. */
function Field(props: {
  label: string;
  value: string;
  placeholder: string;
  busy?: boolean;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(props.value);
  useEffect(() => setValue(props.value), [props.value]);
  return (
    <label className="flex flex-col gap-1 text-xs opacity-80">
      {props.label}
      <input
        className={input}
        value={value}
        placeholder={props.placeholder}
        disabled={props.busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => props.onSave(value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

// --- Link to a speaker ------------------------------------------------------------------

/**
 * Switch whose conversation this page is. The session in progress is ENDED first: resumed
 * under the new id it would be moved into that conversation.
 */
function switchTo(speaker: string | undefined, endSession: () => void) {
  endSession();
  setLinkedSpeaker(speaker);
  location.reload();
}

function Link({ endSession }: { endSession: () => void }) {
  const linked = linkedSpeaker();
  const [code, setCode] = useState<{ code: string; expiresAt: number }>();
  const [error, setError] = useState<string>();

  // While a code is out, ask whether a speaker has claimed it.
  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => {
      if (Date.now() > code.expiresAt) {
        setCode(undefined);
        return;
      }
      api<{ speakerClient: string | null }>("GET", "/link", undefined, { as: "browser" })
        .then(({ speakerClient }) => {
          if (!speakerClient) return;
          switchTo(speakerClient, endSession);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [code, endSession]);

  if (linked) {
    return (
      <>
        <p className="text-xs opacity-80">
          This page is speaker <span className="font-mono">{linked}</span>: what's said to it shows
          up here, and typing here continues its conversation.
        </p>
        <button type="button" className={small} onClick={() => switchTo(undefined, endSession)}>
          Unlink (back to this browser's own conversation)
        </button>
      </>
    );
  }
  if (code) {
    const spoken = `${code.code.slice(0, 3)} ${code.code.slice(3)}`;
    return (
      <>
        <p className="text-3xl font-mono tracking-widest text-center">{spoken}</p>
        <p className="text-xs opacity-80 text-center">
          Say to the speaker: “Computer, link code {spoken}”. Waiting…
        </p>
      </>
    );
  }
  return (
    <>
      <p className="text-xs opacity-60">
        Make this page a speaker's twin: you'll get a code to say to it.
      </p>
      <button
        type="button"
        className={small}
        onClick={() =>
          api<{ code: string; expiresAt: number }>("POST", "/link", undefined, { as: "browser" })
            .then(setCode)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        }
      >
        Get a code (this browser: {browserId()})
      </button>
      <Failure error={error} />
    </>
  );
}

// --- Running tasks ----------------------------------------------------------------------

type Task = {
  runId: string;
  workflow: string;
  status: string;
  title: string;
  detail?: string;
  due?: number | null;
  updatedAt: number;
};

function Tasks() {
  const { data, error, reload } = useApi<{ tasks: Task[] }>("/tasks", 5000);
  if (!data) return <Failure error={error} />;
  if (data.tasks.length === 0) return <p className="text-xs opacity-60">Nothing running.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {data.tasks.map((t) => (
        <li key={t.runId} className="text-sm flex flex-col gap-0.5">
          <div className="flex justify-between gap-2">
            <span className="[overflow-wrap:anywhere]">{t.title}</span>
            <span
              className={`text-xs shrink-0 ${t.status === "failed" ? "text-red-400" : "opacity-60"}`}
            >
              {t.status}
            </span>
          </div>
          {(t.detail || t.due) && (
            <span
              className={`text-xs [overflow-wrap:anywhere] ${t.status === "failed" ? "text-red-400" : "opacity-60"}`}
            >
              {t.due ? `due ${new Date(t.due).toLocaleString()}` : ""}
              {t.due && t.detail ? " · " : ""}
              {t.detail}
            </span>
          )}
          {t.workflow === "remind" && t.status === "running" && (
            <button
              type="button"
              className={`${small} self-start`}
              onClick={() => api("DELETE", `/tasks/${t.runId}`).finally(reload)}
            >
              Cancel
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// --- Sessions ---------------------------------------------------------------------------

type SessionRow = { sessionId: string; startedAt: number; preview: string; turns: number };

/** Every conversation this speaker has had (the server's, not this browser's), to continue. */
function Sessions(props: { current: string | undefined; onContinue: (sessionId: string) => void }) {
  const { data, error } = useApi<{ sessions: SessionRow[] }>("/sessions", 15_000);
  if (!data) return <Failure error={error} />;
  if (data.sessions.length === 0)
    return <p className="text-xs opacity-60">No conversations yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {data.sessions.map((s) => (
        <li key={s.sessionId} className="flex gap-2 items-start justify-between">
          <div className="flex flex-col min-w-0">
            <span className="text-sm [overflow-wrap:anywhere]">{s.preview || "(no words)"}</span>
            <span className="text-xs opacity-60">
              {new Date(s.startedAt).toLocaleString()} · {s.turns}{" "}
              {s.turns === 1 ? "turn" : "turns"}
            </span>
          </div>
          {s.sessionId === props.current ? (
            <span className="text-xs text-aai-primary shrink-0">current</span>
          ) : (
            <button
              type="button"
              className={`${small} shrink-0`}
              onClick={() => props.onContinue(s.sessionId)}
            >
              Continue
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// --- Memories ---------------------------------------------------------------------------

type MemoryRow = { id: string; memory: string; updated_at: string | null };

function Memories() {
  // Polled: memorize adds memories after every conversation, while this page is open.
  const { data, error, reload } = useApi<{ memories: MemoryRow[] }>("/memories", 15_000);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState<string>();
  const run = (p: Promise<unknown>) =>
    p
      .then(() => setFailed(undefined))
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(reload);
  if (!data) return <Failure error={error} />;
  return (
    <>
      {data.memories.length === 0 && (
        <p className="text-xs opacity-60">
          Nothing yet: it remembers what's said, after each conversation.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {data.memories.map((m) => (
          <li key={m.id} className="flex gap-2 items-start">
            <EditableText
              value={m.memory}
              onSave={(text) => run(api("PUT", `/memories/${m.id}`, { text }))}
            />
            <button
              type="button"
              className={small}
              title="Forget this"
              onClick={() => run(api("DELETE", `/memories/${m.id}`))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          run(api("POST", "/memories", { text: draft }).then(() => setDraft("")));
        }}
      >
        <input
          className={input}
          value={draft}
          placeholder="Add a memory, e.g. Biscuit is a beagle"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className={small} disabled={!draft.trim()}>
          Add
        </button>
      </form>
      <Failure error={failed} />
    </>
  );
}

/** Text that becomes an editor on click, saved on blur when it changed. */
function EditableText(props: { value: string; onSave: (value: string) => void; rows?: number }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.value);
  useEffect(() => setValue(props.value), [props.value]);
  if (!editing) {
    return (
      <button
        type="button"
        className="flex-1 text-left text-sm whitespace-pre-wrap [overflow-wrap:anywhere] hover:opacity-80"
        title="Click to edit"
        onClick={() => setEditing(true)}
      >
        {props.value || <span className="opacity-40">(empty)</span>}
      </button>
    );
  }
  return (
    <textarea
      // biome-ignore lint/a11y/noAutofocus: opened by the click that asked to edit it
      autoFocus
      className={`${input} flex-1 font-sans`}
      rows={props.rows ?? 2}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (value.trim() !== props.value) props.onSave(value.trim());
      }}
    />
  );
}

// --- Context ----------------------------------------------------------------------------

type ContextData = {
  current: { session_id: string; instructions: string; created_at: string } | null;
  older: { summary: string; through: string } | null;
  digests: { session_id: string; started_at: string; digest: string }[];
};

function Context() {
  const { data, error, reload } = useApi<ContextData>("/context", 15_000);
  const [failed, setFailed] = useState<string>();
  const run = (p: Promise<unknown>) =>
    p
      .then(() => setFailed(undefined))
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(reload);
  if (!data) return <Failure error={error} />;
  return (
    <>
      <p className="text-xs opacity-60">
        What the next session starts with is built from these. Edit them to change it.
      </p>
      {data.older && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-bold">Older history</h3>
          <EditableText
            rows={6}
            value={data.older.summary}
            onSave={(summary) => run(api("PUT", "/context/older", { summary }))}
          />
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-bold">Conversations ({data.digests.length})</h3>
        {data.digests.map((d) => (
          <div key={d.session_id} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs opacity-60">
              <span>
                {new Date(d.started_at).toLocaleString()}
                {Date.now() - Date.parse(d.started_at) < VERBATIM_WINDOW_MS &&
                  ` · replayed word for word until ${new Date(Date.parse(d.started_at) + VERBATIM_WINDOW_MS).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, then this`}
              </span>
              <button
                type="button"
                className={small}
                onClick={() => run(api("DELETE", `/context/digests/${d.session_id}`))}
              >
                Delete
              </button>
            </div>
            <EditableText
              rows={4}
              value={d.digest}
              onSave={(digest) => run(api("PUT", `/context/digests/${d.session_id}`, { digest }))}
            />
          </div>
        ))}
      </section>
      {data.current && (
        <details>
          <summary className="text-xs font-bold cursor-pointer">
            This session started with ({new Date(data.current.created_at).toLocaleString()})
          </summary>
          <pre className="mt-1 text-xs whitespace-pre-wrap [overflow-wrap:anywhere] opacity-80">
            {data.current.instructions}
          </pre>
        </details>
      )}
      <Failure error={failed} />
    </>
  );
}
