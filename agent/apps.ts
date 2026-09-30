import { type McpServers, requireEnv } from "@alexkroman1/aai";
import type { EnvContext } from "@alexkroman1/aai/step";
import { HttpError, isRecord, jsonClient } from "@alexkroman1/aai/utils";
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
// The app work itself (workflows/app-job.ts) reaches the speaker's BACKGROUND session as
// an MCP server (`composioMcp`): Composio's own meta tools (search, schemas, execute, the
// Python workbench) handed to the worker as they are.

export const COMPOSIO_URL = "https://backend.composio.dev/api/v3.1";

/** What a tool says when an app isn't connected: the page is the one place to connect it. */
export const CONNECT_HINT = "Connect it under Apps on the speaker's page.";

/**
 * One Composio REST call; a refusal throws an HttpError whose message carries Composio's
 * reason, which field failed, and its request id.
 */
export const call = jsonClient({
  label: "Composio",
  baseUrl: COMPOSIO_URL,
  headers: (env) => ({ "x-api-key": requireEnv({ env }, "COMPOSIO_API_KEY") }),
  // Composio's error body is { error: { message, errors, request_id } }: `errors` is
  // WHICH field failed and why (the message alone is only "Validation error"), and the
  // request id is what its dashboard and support look a failure up by.
  errorMessage: (body) => {
    const err = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    if (typeof err?.message !== "string") return undefined;
    const errors = Array.isArray(err.errors) ? err.errors : [];
    const detail = errors.length ? `: ${errors.join("; ")}` : "";
    const request = typeof err.request_id === "string" ? ` (request ${err.request_id})` : "";
    return `${err.message}${detail}${request}`;
  },
});

// --- The speaker's sessions -------------------------------------------------------------

/**
 * Which of a speaker's two sessions: `voice` for what the page and the conversation's
 * runs call (Connect Link, email_me's send), with no sandbox, and `background` for
 * app_task's runs, with Composio's Python workbench to crunch what is too big to hand a
 * model.
 */
export type SessionKind = "voice" | "background";

/** Session ids by speaker and kind, in front of the composio_sessions table. */
const sessions = new Map<string, Promise<string>>();

async function createSession(ctx: EnvContext, user: string, kind: SessionKind): Promise<string> {
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

function sessionId(ctx: EnvContext, user: string, kind: SessionKind): Promise<string> {
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
 * A call on the speaker's session (`path` under /tool_router/session/{id}). A session
 * Composio no longer has (a 404 naming the session) is forgotten and made again, once:
 * the connections are the USER's, so a new session sees them all.
 */
async function inSession<T>(
  ctx: EnvContext,
  user: string,
  kind: SessionKind,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const id = await sessionId(ctx, user, kind);
  try {
    return await call<T>(ctx, method, `/tool_router/session/${enc(id)}${path}`, body);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404 && /session/i.test(err.message)))
      throw err;
    sessions.delete(`${kind}:${user}`);
    await rest(ctx, `/composio_sessions?client_id=eq.${enc(user)}&kind=eq.${kind}`, {
      method: "DELETE",
    });
    const fresh = await sessionId(ctx, user, kind);
    return await call<T>(ctx, method, `/tool_router/session/${enc(fresh)}${path}`, body);
  }
}

// --- The background session, as an MCP server ------------------------------------------

/**
 * Composio's meta tools the worker is given. Not COMPOSIO_MANAGE_CONNECTIONS (connecting
 * is the page's) nor the bash tool (the workbench covers it).
 */
export const COMPOSIO_MCP_TOOLS = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
] as const;

/**
 * The speaker's background session as `stepMcp` connects it: its hosted MCP endpoint
 * (the session's `mcp.url`), authenticated with the project key. Read off the session
 * each connection, so a session Composio lost is made again first.
 */
export const composioMcp: McpServers = {
  composio: {
    url: async ({ clientId, env, signal }) => {
      if (!clientId) throw new Error("Composio's tools act for one speaker: no client id given");
      const session = await inSession<{ mcp: { url: string } }>(
        { env, signal },
        clientId,
        "background",
        "GET",
        "",
      );
      return session.mcp.url;
    },
    headers: ({ env }) => ({ "x-api-key": requireEnv({ env }, "COMPOSIO_API_KEY") }),
    allowedTools: COMPOSIO_MCP_TOOLS,
  },
};

// --- One action, run by code rather than a model (email.ts) -----------------------------

export type ActionResult =
  | { ok: true; data: unknown; logId: string }
  | { ok: false; error: string; logId?: string };

/**
 * Run one action on the speaker's connected account. Composio refusing the REQUEST (bad
 * inputs, an app not connected) is a failed result, like an action's own failure; a bad
 * key, or being rate limited, still throws.
 */
export async function runAction(
  ctx: EnvContext,
  user: string,
  action: string,
  args: Record<string, unknown>,
  kind: SessionKind = "voice",
): Promise<ActionResult> {
  let out: { data?: unknown; error?: string | null; log_id: string };
  try {
    out = await inSession(ctx, user, kind, "POST", "/execute", {
      tool_slug: action,
      arguments: args,
    });
  } catch (err) {
    const refused =
      err instanceof HttpError &&
      err.status >= 400 &&
      err.status < 500 &&
      ![401, 403, 429].includes(err.status);
    if (!refused) throw err;
    return { ok: false, error: err.message };
  }
  if (out.error) return { ok: false, error: out.error, logId: out.log_id };
  return { ok: true, data: out.data, logId: out.log_id };
}

// --- What the page calls: list, connect, disconnect -------------------------------------

// Listed from Composio's catalog and connected accounts, not the session's own /toolkits:
// that one leaves out some apps a session can still connect and use (Hugging Face, even
// in a session made with only it enabled), so they could never be found on the page.

const MAX_DESCRIPTION = 240;

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
async function accounts(ctx: EnvContext, user: string): Promise<Map<string, string>> {
  const q = new URLSearchParams({ user_ids: user, statuses: "ACTIVE", limit: "100" });
  const { items } = await call<{ items: Account[] }>(ctx, "GET", `/connected_accounts?${q}`);
  // Checked again here: a filter Composio ignored must not show another user's account.
  const mine = items.filter((a) => a.user_id === user && a.status === "ACTIVE");
  return new Map(mine.map((a) => [a.toolkit.slug, a.id]));
}

/** Apps to show on the page: the connected ones, or the catalog matching `search`. */
export async function listApps(
  ctx: EnvContext,
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
    .map((t) => {
      const description = t.meta.description.replace(/\s+/g, " ").trim();
      return {
        slug: t.slug,
        name: t.name,
        logo: t.meta.logo,
        description:
          description.length > MAX_DESCRIPTION
            ? `${description.slice(0, MAX_DESCRIPTION - 1)}…`
            : description,
        connected: connected.has(t.slug),
      };
    });
}

/** Composio's hosted page for connecting one app, which comes back to `callbackUrl`. */
export async function connectLink(
  ctx: EnvContext,
  user: string,
  app: string,
  callbackUrl: string,
): Promise<string> {
  const link = await inSession<{ redirect_url: string }>(ctx, user, "voice", "POST", "/link", {
    toolkit: app,
    callback_url: callbackUrl,
  });
  return link.redirect_url;
}

/**
 * Remove the speaker's connection to one app. The account is looked up among THIS
 * speaker's own, never taken from the page, so one speaker's page can't remove another's.
 */
export async function disconnectApp(ctx: EnvContext, user: string, app: string): Promise<boolean> {
  const account = (await accounts(ctx, user)).get(app);
  if (!account) return false;
  await call(ctx, "DELETE", `/connected_accounts/${enc(account)}`);
  return true;
}

const enc = encodeURIComponent;
