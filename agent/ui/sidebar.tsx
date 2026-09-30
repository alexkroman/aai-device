import { phoneE164, useRoute, useStoredValue } from "@alexkroman1/aai-ui";
import { type ReactNode, useEffect, useState } from "react";
import { MIN_APP_SEARCH } from "../app-search.ts";
import { VERBATIM_WINDOW_MS } from "../history-window.ts";
import { api } from "./api.ts";
import { linked } from "./client-id.ts";
import { PHONE_COUNTRY, phone } from "./settings.ts";

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
        {/* Outside Profile: it is this browser's, so it shows even when /profile can't load. */}
        <TextMeAt />
      </Panel>
      <Panel title="Link to a speaker">
        <Link endSession={props.endSession} />
      </Panel>
      <Panel title="Apps">
        <Apps />
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

function Failure({ error }: { error: string | undefined }) {
  return error ? <p className="text-xs text-red-400">{error}</p> : null;
}

// --- Household profile ------------------------------------------------------------------

type ProfileData = { name: string; home_address: string; phone_last4: string; email: string };

function Profile() {
  const { data, error, reload } = useRoute<ProfileData>("/profile");
  const [saving, setSaving] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const save = (field: "name" | "home_address" | "email", value: string) => {
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
      <Field
        label="Email (where the speaker emails results, from your connected Gmail)"
        value={data.email}
        placeholder="you@example.com"
        busy={saving === "email"}
        onSave={(v) => save("email", v)}
      />
      <Failure error={failed} />
    </>
  );
}

/**
 * Where this browser's texts go (text_me, research, app jobs): kept in this browser and
 * reported on every connect (settings.ts, client.tsx), not in the household profile.
 */
function TextMeAt() {
  const [value, setValue] = useStoredValue(phone);
  const invalid = value.trim() !== "" && phoneE164(value, PHONE_COUNTRY) === undefined;
  return (
    <label className="flex flex-col gap-1 text-xs opacity-80">
      Text me at (with the country code, e.g. +1)
      <input
        className={input}
        type="tel"
        value={value}
        placeholder="e.g. +1 555 555 0123"
        aria-invalid={invalid}
        onChange={(e) => setValue(e.target.value)}
      />
      {invalid && (
        <span className="text-red-400">
          Not a number texts can go to: add the country code, e.g. +1
        </span>
      )}
    </label>
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
  linked.set(speaker);
  location.reload();
}

function Link({ endSession }: { endSession: () => void }) {
  const speaker = linked.linked();
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

  if (speaker) {
    return (
      <>
        <p className="text-xs opacity-80">
          This page is speaker <span className="font-mono">{speaker}</span>: what's said to it shows
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
        Get a code (this browser: {linked.own()})
      </button>
      <Failure error={error} />
    </>
  );
}

// --- Apps -------------------------------------------------------------------------------

type AppRow = { slug: string; name: string; logo: string; description: string; connected: boolean };

/**
 * The accounts this speaker acts on (apps.ts). Connecting opens Composio's own page in a
 * new tab, which signs in to the app and comes back here; the list is polled so the
 * connection shows up without a reload.
 */
function Apps() {
  const connected = useRoute<{ apps: AppRow[] }>("/apps", { pollMs: 5000 });
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<AppRow[]>();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const fail = (e: unknown) => setFailed(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    const q = search.trim();
    // Composio searches from MIN_APP_SEARCH letters; fewer shows the hint below.
    if (q.length < MIN_APP_SEARCH) {
      setFound(undefined);
      return;
    }
    const id = setTimeout(() => {
      api<{ apps: AppRow[] }>("GET", `/apps?search=${encodeURIComponent(q)}`)
        .then(({ apps }) => setFound(apps))
        .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const connect = (slug: string) => {
    // Opened now, in the click, so a popup blocker lets it through; pointed at the link
    // once the server has made it.
    const tab = window.open("", "_blank");
    setBusy(slug);
    api<{ url: string }>("POST", `/apps/${slug}/connect`, { returnTo: location.href })
      .then(({ url }) => {
        if (tab) tab.location.href = url;
        else location.href = url;
        setFailed(undefined);
      })
      .catch((e: unknown) => {
        tab?.close();
        fail(e);
      })
      .finally(() => setBusy(undefined));
  };
  const disconnect = (slug: string) => {
    setBusy(slug);
    api("DELETE", `/apps/${slug}`)
      .then(() => setFailed(undefined))
      .catch(fail)
      .finally(() => {
        setBusy(undefined);
        connected.reload();
      });
  };

  const isConnected = new Set(connected.data?.apps.map((a) => a.slug));
  const row = (a: AppRow) => (
    <li key={a.slug} className="flex gap-2 items-center">
      <img src={a.logo} alt="" className="w-5 h-5 rounded shrink-0" />
      <span className="text-sm flex-1 min-w-0 truncate" title={a.description}>
        {a.name}
      </span>
      {isConnected.has(a.slug) ? (
        <button
          type="button"
          className={small}
          disabled={busy === a.slug}
          onClick={() => disconnect(a.slug)}
        >
          Disconnect
        </button>
      ) : (
        <button
          type="button"
          className={small}
          disabled={busy === a.slug}
          onClick={() => connect(a.slug)}
        >
          Connect
        </button>
      )}
    </li>
  );

  return (
    <>
      <p className="text-xs opacity-60">
        Accounts this speaker can use, e.g. “what's on my calendar” or “email Sam I'm late”.
      </p>
      {connected.data &&
        (connected.data.apps.length ? (
          <ul className="flex flex-col gap-2">{connected.data.apps.map(row)}</ul>
        ) : (
          <p className="text-xs opacity-60">Nothing connected yet.</p>
        ))}
      <input
        className={input}
        value={search}
        placeholder="Find an app to connect, e.g. Gmail"
        onChange={(e) => setSearch(e.target.value)}
      />
      {search.trim() && search.trim().length < MIN_APP_SEARCH && (
        <p className="text-xs opacity-60">Keep typing: at least {MIN_APP_SEARCH} letters.</p>
      )}
      {found && (
        <ul className="flex flex-col gap-2">
          {found.length ? (
            found.filter((a) => !isConnected.has(a.slug)).map(row)
          ) : (
            <li className="text-xs opacity-60">No app by that name.</li>
          )}
        </ul>
      )}
      <Watches />
      <Failure error={failed ?? connected.error} />
    </>
  );
}

type WatchRow = { id: string; app: string; instruction: string; createdAt: string };

/** What the speaker was asked to tell them about ("tell me when Sam emails"), to stop. */
function Watches() {
  const { data, reload } = useRoute<{ watches: WatchRow[] }>("/watches", { pollMs: 15_000 });
  if (!data?.watches.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-bold">Telling you when</h3>
      <ul className="flex flex-col gap-2">
        {data.watches.map((w) => (
          <li key={w.id} className="flex gap-2 items-start justify-between">
            <span className="text-sm [overflow-wrap:anywhere]">
              {w.instruction} <span className="text-xs opacity-60">({w.app})</span>
            </span>
            <button
              type="button"
              className={`${small} shrink-0`}
              onClick={() => api("DELETE", `/watches/${w.id}`).finally(reload)}
            >
              Stop
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- Running tasks ----------------------------------------------------------------------

type Task = {
  runId: string;
  workflow: string;
  status: string;
  title: string;
  detail?: string;
  updatedAt: number;
};

function Tasks() {
  const { data, error, reload } = useRoute<{ tasks: Task[] }>("/tasks", { pollMs: 5000 });
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
          {t.detail && (
            <span
              className={`text-xs [overflow-wrap:anywhere] ${t.status === "failed" ? "text-red-400" : "opacity-60"}`}
            >
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
  const { data, error } = useRoute<{ sessions: SessionRow[] }>("/sessions", { pollMs: 15_000 });
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
  const { data, error, reload } = useRoute<{ memories: MemoryRow[] }>("/memories", {
    pollMs: 15_000,
  });
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
  const { data, error, reload } = useRoute<ContextData>("/context", { pollMs: 15_000 });
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
