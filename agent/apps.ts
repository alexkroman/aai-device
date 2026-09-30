import { requireEnv } from "@alexkroman1/aai";
import { stepEnv } from "@alexkroman1/aai/step";
import { rest } from "./supabase.ts";

// The household's own apps (Gmail, Calendar, Slack, Notion…), through Composio sessions
// (https://docs.composio.dev/reference/api-reference/tool-router, REST v3.1). Composio
// holds the OAuth tokens and runs the actions; this file is the calls the speaker makes.
//
// Each speaker is its own Composio user, its ?client= id: a browser linked to a speaker
// talks as that speaker (ui/client-id.ts), so what is connected on the page is what the
// speaker can use. Accounts are connected ONLY on the page, through Composio's hosted
// Connect Link: a speaker can't show a link, and one read aloud is no use. So the session
// is made with Composio's in-chat connection manager off, and a tool that meets an app
// that isn't connected says where to connect it.
//
// Plain fetch, because tool code runs in a worker that has fetch and nothing else. Beside
// agent.ts because tools/ is flat and every file there must be a tool.

type Ctx = { env: Readonly<Partial<Record<string, string>>>; signal?: AbortSignal };

export const COMPOSIO_URL = "https://backend.composio.dev/api/v3.1";

/** What a tool says when an app isn't connected: the page is the one place to connect it. */
export const CONNECT_HINT = "Connect it under Apps on the speaker's page.";

export class ComposioError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One Composio REST call; a refusal throws a ComposioError with its request id. */
export async function call<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${COMPOSIO_URL}${path}`, {
    method,
    headers: {
      "x-api-key": requireEnv(ctx, "COMPOSIO_API_KEY"),
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // Composio's error body is { error: { message, request_id } }: the request id is what
    // its dashboard and support look a failure up by.
    let message = text.slice(0, 200);
    try {
      const err = (
        JSON.parse(text) as {
          error?: { message?: string; request_id?: string; errors?: string[] };
        }
      ).error;
      if (err?.message) {
        // `errors` is WHICH field failed and why; the message alone is only "Validation error".
        const detail = err.errors?.length ? `: ${err.errors.join("; ")}` : "";
        message = `${err.message}${detail}${err.request_id ? ` (request ${err.request_id})` : ""}`;
      }
    } catch {}
    throw new ComposioError(res.status, `Composio ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * What a workflow STEP reaches the speaker's apps with: a step has no tool context, so the
 * env the calls here read comes from the step's own (stepEnv).
 */
export function stepAppsCtx(): Ctx {
  return {
    env: {
      COMPOSIO_API_KEY: stepEnv("COMPOSIO_API_KEY"),
      SUPABASE_URL: stepEnv("SUPABASE_URL"),
      SUPABASE_SECRET_KEY: stepEnv("SUPABASE_SECRET_KEY"),
    },
  };
}

// --- The speaker's sessions -------------------------------------------------------------

/**
 * Which of a speaker's two sessions: `voice` for the conversation's tools, with no
 * sandbox (a turn can't wait on one), and `background` for app_task's runs, with
 * Composio's Python workbench to crunch what is too big to hand a model.
 */
export type SessionKind = "voice" | "background";

/** Session ids by speaker and kind, in front of the composio_sessions table. */
const sessions = new Map<string, Promise<string>>();

async function createSession(ctx: Ctx, user: string, kind: SessionKind): Promise<string> {
  const where = `client_id=eq.${enc(user)}&kind=eq.${kind}`;
  const rows = await rest<{ session_id: string }[]>(
    ctx,
    `/composio_sessions?${where}&select=session_id`,
  );
  if (rows[0]) return rows[0].session_id;
  const created = await call<{ session_id: string }>(ctx, "POST", "/tool_router/session", {
    user_id: user,
    // Connecting is the page's job (see the top of this file).
    manage_connections: { enable: false },
    workbench: { enable: kind === "background" },
  });
  await rest(ctx, "/composio_sessions?on_conflict=client_id,kind", {
    method: "POST",
    body: { client_id: user, kind, session_id: created.session_id },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return created.session_id;
}

function sessionId(ctx: Ctx, user: string, kind: SessionKind): Promise<string> {
  const key = `${kind}:${user}`;
  let id = sessions.get(key);
  if (!id) {
    // Without the caller's signal: a barge-in must not kill the session other calls share.
    id = createSession({ env: ctx.env }, user, kind);
    // A failure is not remembered: the next call tries again.
    id.catch(() => sessions.delete(key));
    sessions.set(key, id);
  }
  return id;
}

/**
 * A call on the speaker's session. A session Composio no longer has (a 404 naming the
 * session) is forgotten and made again, once: the connections are the USER's, so a new
 * session sees them all.
 */
async function inSession<T>(
  ctx: Ctx,
  user: string,
  method: string,
  path: string,
  body?: unknown,
  kind: SessionKind = "voice",
): Promise<T> {
  const id = await sessionId(ctx, user, kind);
  try {
    return await call<T>(ctx, method, `/tool_router/session/${enc(id)}${path}`, body);
  } catch (err) {
    if (!(err instanceof ComposioError && err.status === 404 && /session/i.test(err.message)))
      throw err;
    sessions.delete(`${kind}:${user}`);
    await rest(ctx, `/composio_sessions?client_id=eq.${enc(user)}&kind=eq.${kind}`, {
      method: "DELETE",
    });
    const fresh = await sessionId(ctx, user, kind);
    return await call<T>(ctx, method, `/tool_router/session/${enc(fresh)}${path}`, body);
  }
}

// --- What the model calls: find an action, run it ---------------------------------------

type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
};

type SearchResponse = {
  error?: string | null;
  results: { primary_tool_slugs: string[]; related_tool_slugs: string[]; error?: string | null }[];
  toolkit_connection_statuses: { toolkit: string; has_active_connection: boolean }[];
  tool_schemas: Record<
    string,
    { toolkit: string; tool_slug: string; description?: string; input_schema?: JsonSchema }
  >;
};

/** A tool's inputs, shrunk to what the model needs to fill them in. */
export type ActionParam = {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  options?: unknown[];
};

export type FoundAction = {
  action: string;
  app: string;
  connected: boolean;
  description: string;
  params: ActionParam[];
};

/** Most actions a search hands the model: each carries its inputs, and results are capped. */
export const MAX_FOUND_ACTIONS = 4;
const MAX_DESCRIPTION = 240;
const MAX_PARAM_DESCRIPTION = 120;

function clip(text: string | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function params(schema: JsonSchema | undefined): ActionParam[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([name, p]) => ({
    name,
    type: Array.isArray(p.type) ? p.type.join("|") : (p.type ?? "any"),
    required: required.has(name),
    ...(p.description ? { description: clip(p.description, MAX_PARAM_DESCRIPTION) } : {}),
    ...(p.enum ? { options: p.enum.slice(0, 10) } : {}),
  }));
}

/** The actions across the household's apps that fit what they asked, connected or not. */
export async function findActions(
  ctx: Ctx,
  user: string,
  useCase: string,
  kind: SessionKind = "voice",
): Promise<FoundAction[]> {
  const found = await inSession<SearchResponse>(
    ctx,
    user,
    "POST",
    "/search",
    { queries: [{ use_case: useCase }] },
    kind,
  );
  const result = found.results[0];
  if (!result) throw new Error(found.error ?? "Composio search returned nothing");
  if (result.error) throw new Error(result.error);
  // Composio spells a toolkit `googlecalendar` in the statuses and `GOOGLECALENDAR` in the
  // schemas: compared as given, every app read as not connected.
  const connected = new Map(
    found.toolkit_connection_statuses.map((s) => [
      s.toolkit.toLowerCase(),
      s.has_active_connection,
    ]),
  );
  return [...result.primary_tool_slugs, ...result.related_tool_slugs]
    .filter((slug, i, all) => all.indexOf(slug) === i)
    .slice(0, MAX_FOUND_ACTIONS)
    .map((slug) => {
      const s = found.tool_schemas[slug];
      const app = (s?.toolkit ?? "").toLowerCase();
      return {
        action: slug,
        // Lowercase, the slug the page, call_app_api and watch_app all take.
        app,
        connected: connected.get(app) ?? false,
        description: clip(s?.description, MAX_DESCRIPTION),
        params: params(s?.input_schema),
      };
    });
}

/** Longest string kept in an action's result; the rest of the tool's 4000 chars is structure. */
export const MAX_RESULT_STRING = 800;

/**
 * An action's result without what costs context and says nothing: nulls, empty values,
 * and the tail of long strings (an email's HTML body, a page's raw text).
 */
export function compact(value: unknown): unknown {
  if (typeof value === "string") return clip(value, MAX_RESULT_STRING);
  if (Array.isArray(value)) return value.map(compact).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (c === undefined || c === "" || (Array.isArray(c) && c.length === 0)) continue;
      if (typeof c === "object" && c !== null && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return value === null ? undefined : value;
}

/**
 * Most of an action's result handed to the model, well under the SDK's tool-result cap
 * (16000): the model re-reads a result on every later step of the run, and 50 emails
 * compacted were still 26000 characters.
 */
export const MAX_ACTION_RESULT_CHARS = 12_000;

/** Where in a result its longest list is, and how long that list is in JSON. */
function longestList(value: unknown): { list: unknown[]; chars: number } | undefined {
  let best: { list: unknown[]; chars: number } | undefined;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      const chars = JSON.stringify(v).length;
      if (v.length > 1 && (!best || chars > best.chars)) best = { list: v, chars };
      v.forEach(visit);
    } else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return best;
}

/**
 * A compacted result cut to MAX_ACTION_RESULT_CHARS: its longest list loses items from the
 * end until it fits, and says how many it kept, so the model knows the rest exists (and
 * that the workbench is where all of it can be gone through). A result with no list to
 * shorten is cut as text.
 */
export function fit(value: unknown, max = MAX_ACTION_RESULT_CHARS): unknown {
  if (JSON.stringify(value ?? null).length <= max) return value;
  const copy = structuredClone(value);
  const dropped = new Map<unknown[], number>();
  for (let guard = 0; guard < 64 && JSON.stringify(copy).length > max; guard++) {
    const found = longestList(copy);
    if (!found) break;
    const cut = Math.max(1, Math.floor(found.list.length / 4));
    found.list.splice(found.list.length - cut, cut);
    dropped.set(found.list, (dropped.get(found.list) ?? 0) + cut);
  }
  const note =
    dropped.size > 0
      ? `Cut to fit: ${[...dropped].map(([l, n]) => `kept ${l.length}, dropped ${n}`).join("; ")}. ` +
        "Ask for fewer or narrower results, or use workbench to go through all of them."
      : undefined;
  const text = JSON.stringify(copy);
  if (text.length <= max) return note ? { result: copy, note } : copy;
  return {
    result_start: text.slice(0, max - 200),
    note: "Cut to fit: too long to hand over whole. Use workbench to read all of it.",
  };
}

export type ActionResult =
  | { ok: true; data: unknown; logId: string }
  | { ok: false; error: string; logId?: string };

/** Composio refusing the REQUEST (no such action, bad inputs): the model can fix those. */
function refusedRequest(err: unknown): err is ComposioError {
  return (
    err instanceof ComposioError &&
    err.status >= 400 &&
    err.status < 500 &&
    ![401, 403, 429].includes(err.status)
  );
}

/**
 * Run one action on the speaker's connected account. A refused request is a failed
 * result, like an action's own failure: a model that guessed a slug (MSG91_SEND_SMS)
 * gets told to find a real one rather than a stack trace. A bad key, or being rate
 * limited, still throws.
 */
export async function runAction(
  ctx: Ctx,
  user: string,
  action: string,
  args: Record<string, unknown>,
  kind: SessionKind = "voice",
): Promise<ActionResult> {
  let out: { data?: unknown; error?: string | null; log_id: string };
  try {
    out = await inSession(
      ctx,
      user,
      "POST",
      "/execute",
      { tool_slug: action, arguments: args },
      kind,
    );
  } catch (err) {
    if (!refusedRequest(err)) throw err;
    const error =
      err.status === 404 && /tool/i.test(err.message)
        ? `There is no action ${action}. Use one find_app_action returned.`
        : err.message;
    return { ok: false, error };
  }
  if (out.error) return { ok: false, error: out.error, logId: out.log_id };
  return { ok: true, data: fit(compact(out.data)), logId: out.log_id };
}

// --- Past the ready-made actions: the app's own API -------------------------------------

export const PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type ApiRequest = {
  app: string;
  method: (typeof PROXY_METHODS)[number];
  /** A path on the app's API base URL, e.g. `/users/me/calendarList` for Google Calendar. */
  path: string;
  query?: Record<string, string> | undefined;
  body?: Record<string, unknown> | undefined;
};

/**
 * Call the app's own API with the speaker's connected account, Composio signing the
 * request (`proxy_execute`): for what no ready-made action covers. Composio refuses a
 * host that isn't the app's, so a connection can only reach its own API.
 */
export async function callApi(
  ctx: Ctx,
  user: string,
  req: ApiRequest,
  kind: SessionKind = "voice",
): Promise<{ status: number; data: unknown }> {
  const out = await inSession<{ status: number; data?: unknown; binary_data?: unknown }>(
    ctx,
    user,
    "POST",
    "/proxy_execute",
    {
      toolkit_slug: req.app,
      endpoint: req.path,
      method: req.method,
      ...(req.body ? { body: req.body } : {}),
      ...(req.query
        ? {
            parameters: Object.entries(req.query).map(([name, value]) => ({
              name,
              value,
              type: "query",
            })),
          }
        : {}),
    },
    kind,
  );
  // A file is a download link, which is no use to a model that can't fetch it.
  return {
    status: out.status,
    data: out.binary_data ? { note: "the API answered with a file" } : fit(compact(out.data)),
  };
}

// --- The background session's Python sandbox -------------------------------------------

/**
 * Longest a workbench cell may run. Composio allows 180 s; a tool call here is cut off
 * well before that, so the model is told to work in short cells. Its state (variables,
 * files) lasts from one cell to the next.
 */
export const WORKBENCH_CELL_SECONDS = 25;

/**
 * Run Python in the speaker's background session: Composio's `COMPOSIO_REMOTE_WORKBENCH`.
 * Not compacted like an action's result: what a cell prints IS the answer the worker
 * asked for (a summary of 50 emails is longer than a field), so only its size is capped.
 */
export async function runWorkbench(
  ctx: Ctx,
  user: string,
  code: string,
  thought: string,
): Promise<ActionResult> {
  const out = await inSession<{ data?: unknown; error?: string | null; log_id: string }>(
    ctx,
    user,
    "POST",
    "/execute",
    { tool_slug: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: code, thought } },
    "background",
  );
  if (out.error) return { ok: false, error: out.error, logId: out.log_id };
  return { ok: true, data: fit(out.data), logId: out.log_id };
}

// --- What the page calls: list, connect, disconnect -------------------------------------

// Listed from Composio's catalog and connected accounts, not the session's own /toolkits:
// that one leaves out some apps a session can still connect and use (Hugging Face, even
// in a session made with only it enabled), so they could never be found on the page.

type Toolkit = {
  name: string;
  slug: string;
  no_auth: boolean | null;
  meta: { logo: string; description: string };
};

type Account = { id: string; user_id: string; status: string; toolkit: { slug: string } };

export type App = {
  slug: string;
  name: string;
  logo: string;
  description: string;
  connected: boolean;
};

/** The speaker's working connections, by app slug. */
async function accounts(ctx: Ctx, user: string): Promise<Map<string, string>> {
  const q = new URLSearchParams({ user_ids: user, statuses: "ACTIVE", limit: "100" });
  const { items } = await call<{ items: Account[] }>(ctx, "GET", `/connected_accounts?${q}`);
  // Checked again here: a filter Composio ignored must not show another user's account.
  const mine = items.filter((a) => a.user_id === user && a.status === "ACTIVE");
  return new Map(mine.map((a) => [a.toolkit.slug, a.id]));
}

/** Apps to show on the page: the connected ones, or the catalog matching `search`. */
export async function listApps(
  ctx: Ctx,
  user: string,
  opts: { search?: string; connectedOnly?: boolean } = {},
): Promise<App[]> {
  const connected = await accounts(ctx, user);
  let toolkits: Toolkit[];
  if (opts.connectedOnly) {
    toolkits = await Promise.all(
      [...connected.keys()].map((slug) => call<Toolkit>(ctx, "GET", `/toolkits/${enc(slug)}`)),
    );
  } else {
    const q = new URLSearchParams({ limit: "20" });
    if (opts.search) q.set("search", opts.search);
    toolkits = (await call<{ items: Toolkit[] }>(ctx, "GET", `/toolkits?${q}`)).items;
  }
  return toolkits
    .filter((t) => !t.no_auth)
    .map((t) => ({
      slug: t.slug,
      name: t.name,
      logo: t.meta.logo,
      description: clip(t.meta.description, MAX_DESCRIPTION),
      connected: connected.has(t.slug),
    }));
}

/** Composio's hosted page for connecting one app, which comes back to `callbackUrl`. */
export async function connectLink(
  ctx: Ctx,
  user: string,
  app: string,
  callbackUrl: string,
): Promise<string> {
  const link = await inSession<{ redirect_url: string }>(ctx, user, "POST", "/link", {
    toolkit: app,
    callback_url: callbackUrl,
  });
  return link.redirect_url;
}

/**
 * Remove the speaker's connection to one app. The account is looked up among THIS
 * speaker's own, never taken from the page, so one speaker's page can't remove another's.
 */
export async function disconnectApp(ctx: Ctx, user: string, app: string): Promise<boolean> {
  const account = (await accounts(ctx, user)).get(app);
  if (!account) return false;
  await call(ctx, "DELETE", `/connected_accounts/${enc(account)}`);
  return true;
}

const enc = encodeURIComponent;
