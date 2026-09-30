import type { McpServers } from "@alexkroman1/aai";
import { type ComposioSessionStore, composio } from "@alexkroman1/aai/experimental";
import { rest } from "./supabase.ts";

// The household's own apps (Gmail, Calendar, Slack, Notion…), through Composio sessions,
// by the SDK's composio() client: Composio holds the OAuth tokens and runs the actions;
// this file is which sessions a speaker has and where their ids live.
//
// Each speaker is its own Composio user, its ?client= id: a browser linked to a speaker
// talks as that speaker (ui/client-id.ts), so what is connected on the page is what the
// speaker can use. Accounts are connected ONLY on the page, through Composio's hosted
// Connect Link (`apps.connectLink`): a speaker can't show a link, and one read aloud is no
// use. So every session is made with Composio's in-chat connection manager off (the SDK's
// default), and a tool that meets an app that isn't connected says where to connect it.
//
// Two sessions per speaker:
//
//   voice       what the page and the conversation's runs call (Connect Link, email_me's
//               send: `apps.execute`), with no sandbox. The first kind, so the default.
//   background  app_task's runs, with Composio's Python workbench to crunch what is too
//               big to hand a model, reached as an MCP server (`composioMcp`): Composio's
//               own meta tools (search, schemas, execute, the workbench) handed to the
//               worker as they are.
//
// The rest is the SDK's and tested there: a session made once per speaker and kind and
// reused, one Composio lost (a 404 naming it) made again once, an action Composio refuses
// as a REQUEST (a 4xx but 401/403/429) answered { ok: false } rather than thrown, the
// catalog and the speaker's own ACTIVE accounts for the page, a disconnect that only
// reaches this speaker's account, and Composio's error detail with the key scrubbed.

/** What a tool says when an app isn't connected: the page is the one place to connect it. */
export const CONNECT_HINT = "Connect it under Apps on the speaker's page.";

/** Which of a speaker's two sessions (above). */
export type SessionKind = "voice" | "background";

const enc = encodeURIComponent;
const row = (user: string, kind: string) => `client_id=eq.${enc(user)}&kind=eq.${enc(kind)}`;

/**
 * Session ids in the composio_sessions table (../supabase/migrations), so a restart
 * reuses a speaker's sessions instead of making new ones. A stale id is fine: its first
 * 404 deletes the row and a new session replaces it.
 */
export const composioSessions: ComposioSessionStore = {
  get: async (user, kind, ctx) =>
    (
      await rest<{ session_id: string }[]>(
        ctx,
        `/composio_sessions?${row(user, kind)}&select=session_id`,
      )
    )[0]?.session_id,
  set: async (user, kind, id, ctx) => {
    await rest(ctx, "/composio_sessions?on_conflict=client_id,kind", {
      method: "POST",
      body: { client_id: user, kind, session_id: id },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  },
  delete: async (user, kind, ctx) => {
    await rest(ctx, `/composio_sessions?${row(user, kind)}`, { method: "DELETE" });
  },
};

/** Composio for every speaker, on the project key COMPOSIO_API_KEY. */
export const apps = composio<SessionKind>({
  sessions: { voice: {}, background: { workbench: true } },
  sessionStore: composioSessions,
});

/**
 * The speaker's background session as `stepMcp` connects it (workflows/app-job.ts): its
 * hosted MCP endpoint, read off the session per connection, with the project key, offering
 * only the SDK's COMPOSIO_MCP_TOOLS (not COMPOSIO_MANAGE_CONNECTIONS: connecting is the
 * page's; nor the bash tool: the workbench covers it).
 */
export const composioMcp: McpServers = { composio: apps.mcpServer({ kind: "background" }) };
