import { requireEnv } from "@alexkroman1/aai";
import { COMPOSIO_BASE_URL, COMPOSIO_MCP_TOOLS } from "@alexkroman1/aai/experimental";
import type { FetchRouteHandler, FetchRouteRequest } from "@alexkroman1/aai/testing";
import { installFetchRoutes } from "@alexkroman1/aai/testing/vitest";
import { apps, composioMcp } from "./apps.ts";

// Composio behind fake routes, with the composio_sessions table beside it. The client is
// the SDK's composio() (its sessions, refusals, catalog and disconnect are tested there);
// what these pin is this speaker's use of it: each speaker is its own Composio user, its
// voice session has no workbench and its background one does, the ids live in the
// composio_sessions table (so a restart reuses them) and a lost one's row is replaced, and
// the worker's MCP server is the speaker's background session with only the meta tools.

const env = {
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_SECRET_KEY: "sb-test",
  COMPOSIO_API_KEY: "ak_test",
};
const ctx = { env };

const COMPOSIO_HOST = new URL(COMPOSIO_BASE_URL).host;
const composioPath = (req: FetchRouteRequest) =>
  req.pathname.replace(new URL(COMPOSIO_BASE_URL).pathname, "");

/** Composio answering `composio`, and the composio_sessions table as a map. */
function backends(composio: FetchRouteHandler) {
  const table = new Map<string, string>();
  const net = installFetchRoutes({
    "supabase.test": (req) => {
      const q = req.searchParams;
      const key = `${q.get("client_id")?.replace(/^eq\./, "")}:${q.get("kind")?.replace(/^eq\./, "")}`;
      if (req.method === "POST") {
        const row = req.json as { client_id: string; kind: string; session_id: string };
        table.set(`${row.client_id}:${row.kind}`, row.session_id);
        return { status: 201 };
      }
      if (req.method === "DELETE") {
        table.delete(key);
        return { status: 204 };
      }
      const id = table.get(key);
      return { body: id ? [{ session_id: id }] : [] };
    },
    [COMPOSIO_HOST]: composio,
  });
  const composioHits = () => net.to(COMPOSIO_HOST);
  return { net, table, composioHits };
}

let n = 0;
/** A speaker id no earlier test used: `apps` caches sessions per speaker for the process. */
const speaker = () => `speaker-${++n}`;

test("a speaker's session is made once, as its own user, and reused", async () => {
  const user = speaker();
  const { composioHits, table } = backends((req) =>
    composioPath(req) === "/tool_router/session"
      ? { status: 201, body: { session_id: "trs_1" } }
      : { body: { data: { ok: 1 }, error: null, log_id: "log_1" } },
  );
  await apps.execute(ctx, user, "GMAIL_FETCH_EMAILS", {});
  await apps.execute(ctx, user, "GMAIL_FETCH_EMAILS", {});
  const created = composioHits().filter((h) => composioPath(h) === "/tool_router/session");
  expect(created).toHaveLength(1);
  expect(created[0]?.json).toMatchObject({
    user_id: user,
    manage_connections: { enable: false },
    workbench: { enable: false },
  });
  expect(created[0]?.headers["x-api-key"]).toBe("ak_test");
  expect(table.get(`${user}:voice`)).toBe("trs_1");
  expect(
    composioHits().filter((h) => composioPath(h) === "/tool_router/session/trs_1/execute"),
  ).toHaveLength(2);
  expect(composioHits()[0]?.url).toContain("/api/v3.1/");
});

test("a session made by an earlier process is read from the table, not made again", async () => {
  const user = speaker();
  const { composioHits, table } = backends(() => ({
    body: { data: {}, error: null, log_id: "log_t" },
  }));
  table.set(`${user}:voice`, "trs_old");
  await apps.execute(ctx, user, "GMAIL_FETCH_EMAILS", {});
  expect(composioHits().map(composioPath)).toEqual(["/tool_router/session/trs_old/execute"]);
});

test("a session Composio no longer has is made again, once, and its row replaced", async () => {
  const user = speaker();
  let made = 0;
  const { table } = backends((req) => {
    const path = composioPath(req);
    if (path === "/tool_router/session") return { body: { session_id: `trs_${++made}` } };
    if (path === "/tool_router/session/trs_1/execute")
      return { status: 404, body: { error: { message: "Tool router session not found" } } };
    return { body: { data: { ok: 1 }, error: null, log_id: "log_2" } };
  });
  expect(await apps.execute(ctx, user, "X_Y", {})).toEqual({
    ok: true,
    data: { ok: 1 },
    logId: "log_2",
  });
  expect(made).toBe(2);
  expect(table.get(`${user}:voice`)).toBe("trs_2");
});

describe("composioMcp", () => {
  const server = composioMcp.composio;
  if (!server) throw new Error("composioMcp declares no composio server");
  const resolve = (clientId: string | undefined) => {
    const { url } = server;
    if (typeof url !== "function") throw new Error("composioMcp's url is not a resolver");
    return url({ clientId, env, signal: new AbortController().signal });
  };

  test("is the speaker's own background session, with the workbench on", async () => {
    const user = speaker();
    const { composioHits, table } = backends((req) => {
      const path = composioPath(req);
      if (path === "/tool_router/session") return { body: { session_id: "trs_bg" } };
      if (path === "/tool_router/session/trs_bg")
        return { body: { mcp: { url: "https://mcp.composio.test/trs_bg" } } };
    });
    expect(await resolve(user)).toBe("https://mcp.composio.test/trs_bg");
    const [created] = composioHits();
    expect(created?.json).toMatchObject({
      user_id: user,
      manage_connections: { enable: false },
      workbench: { enable: true },
    });
    expect(table.get(`${user}:background`)).toBe("trs_bg");
  });

  test("a background session Composio lost is made again before connecting", async () => {
    const user = speaker();
    let made = 0;
    backends((req) => {
      const path = composioPath(req);
      if (path === "/tool_router/session") return { body: { session_id: `trs_m${++made}` } };
      if (path === "/tool_router/session/trs_m1")
        return { status: 404, body: { error: { message: "Tool router session not found" } } };
      if (path === "/tool_router/session/trs_m2")
        return { body: { mcp: { url: "https://mcp.composio.test/trs_m2" } } };
    });
    expect(await resolve(user)).toBe("https://mcp.composio.test/trs_m2");
    expect(made).toBe(2);
  });

  test("acts for one speaker only: no client id is refused before any call", async () => {
    const { net } = backends(() => undefined);
    await expect(resolve(undefined)).rejects.toThrow(/client id/);
    expect(net.hits).toEqual([]);
  });

  test("authenticates with the project key and offers only Composio's meta tools", async () => {
    const { headers } = server;
    if (typeof headers !== "function") throw new Error("composioMcp's headers is not a resolver");
    const signal = new AbortController().signal;
    expect(await headers({ clientId: "kitchen", env, signal })).toEqual({
      "x-api-key": requireEnv({ env }, "COMPOSIO_API_KEY"),
    });
    expect(server.allowedTools).toEqual(COMPOSIO_MCP_TOOLS);
    expect(server.allowedTools).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
  });
});
