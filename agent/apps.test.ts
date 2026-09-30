import { requireEnv } from "@alexkroman1/aai";
import type { FetchRouteHandler, FetchRouteRequest } from "@alexkroman1/aai/testing";
import { installFetchRoutes } from "@alexkroman1/aai/testing/vitest";
import {
  COMPOSIO_MCP_TOOLS,
  COMPOSIO_URL,
  composioMcp,
  disconnectApp,
  listApps,
  runAction,
} from "./apps.ts";

// Composio behind fake routes, with the composio_sessions table beside it: what these
// pin is that each speaker is its own Composio user, its session is made once and reused,
// a session Composio lost is made again, the worker's MCP server is the speaker's
// background session, the page's apps come from the catalog and the speaker's own
// accounts, and a disconnect can only reach the speaker's own account.

const env = {
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_SECRET_KEY: "sb-test",
  COMPOSIO_API_KEY: "ak_test",
};
const ctx = { env };

const COMPOSIO_HOST = new URL(COMPOSIO_URL).host;
const composioPath = (req: FetchRouteRequest) =>
  req.pathname.replace(new URL(COMPOSIO_URL).pathname, "");

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
/** A speaker id no earlier test used: apps.ts caches sessions per speaker for the process. */
const speaker = () => `speaker-${++n}`;

test("a speaker's session is made once, as its own user, and reused", async () => {
  const user = speaker();
  const { composioHits, table } = backends((req) =>
    composioPath(req) === "/tool_router/session"
      ? { status: 201, body: { session_id: "trs_1" } }
      : { body: { data: { ok: 1 }, error: null, log_id: "log_1" } },
  );
  await runAction(ctx, user, "GMAIL_FETCH_EMAILS", {});
  await runAction(ctx, user, "GMAIL_FETCH_EMAILS", {});
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

test("a session Composio no longer has is made again, once", async () => {
  const user = speaker();
  let made = 0;
  backends((req) => {
    const path = composioPath(req);
    if (path === "/tool_router/session") return { body: { session_id: `trs_${++made}` } };
    if (path === "/tool_router/session/trs_1/execute")
      return { status: 404, body: { error: { message: "Tool router session not found" } } };
    return { body: { data: { ok: 1 }, error: null, log_id: "log_2" } };
  });
  expect(await runAction(ctx, user, "X_Y", {})).toEqual({
    ok: true,
    data: { ok: 1 },
    logId: "log_2",
  });
  expect(made).toBe(2);
});

test("an action's failure is its result, with the log id", async () => {
  backends((req) =>
    composioPath(req) === "/tool_router/session"
      ? { body: { session_id: "trs_f" } }
      : { body: { data: {}, error: "No connected account for gmail", log_id: "log_f" } },
  );
  expect(await runAction(ctx, speaker(), "GMAIL_SEND_EMAIL", {})).toEqual({
    ok: false,
    error: "No connected account for gmail",
    logId: "log_f",
  });
});

test("Composio refusing the request is a failed result with its reason, not a throw", async () => {
  backends((req) =>
    composioPath(req) === "/tool_router/session"
      ? { body: { session_id: "trs_u" } }
      : {
          status: 404,
          body: { error: { message: "Tool MSG91_SEND_SMS not found", request_id: "r1" } },
        },
  );
  expect(await runAction(ctx, speaker(), "MSG91_SEND_SMS", {})).toEqual({
    ok: false,
    error: expect.stringMatching(/Tool MSG91_SEND_SMS not found.*request r1/),
  });
});

test("a bad key still throws: that's the deploy's to fix, not the model's", async () => {
  backends((req) =>
    composioPath(req) === "/tool_router/session"
      ? { body: { session_id: "trs_k" } }
      : { status: 401, body: { error: { message: "Invalid API key" } } },
  );
  await expect(runAction(ctx, speaker(), "GMAIL_SEND_EMAIL", {})).rejects.toThrow(/401/);
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
      return undefined;
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
      return undefined;
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

/** Composio's catalog and connected accounts, with `user` holding one Gmail account. */
function catalog(user: string) {
  const toolkit = (slug: string, name: string, no_auth = false) => ({
    slug,
    name,
    no_auth,
    meta: { logo: `https://logos.test/${slug}`, description: `${name} app` },
  });
  const apps = [
    toolkit("gmail", "Gmail"),
    toolkit("hugging_face", "Hugging Face"),
    toolkit("hackernews", "Hacker News", true),
  ];
  return backends((req) => {
    const path = composioPath(req);
    if (req.method === "DELETE") return { body: {} };
    if (path === "/connected_accounts")
      return {
        body: {
          items: [
            { id: "ca_mine", user_id: user, status: "ACTIVE", toolkit: { slug: "gmail" } },
            // Filters Composio might not apply: another user's, and a link never finished.
            {
              id: "ca_theirs",
              user_id: "someone-else",
              status: "ACTIVE",
              toolkit: { slug: "hugging_face" },
            },
            {
              id: "ca_pending",
              user_id: user,
              status: "INITIATED",
              toolkit: { slug: "hugging_face" },
            },
          ],
        },
      };
    if (path === "/toolkits") return { body: { items: apps } };
    const one = apps.find((a) => path === `/toolkits/${a.slug}`);
    return one ? { body: one } : { status: 404, body: { error: { message: "not found" } } };
  });
}

test("search lists the catalog, not the session's toolkits, which leave some apps out", async () => {
  const user = speaker();
  const { composioHits } = catalog(user);
  const apps = await listApps(ctx, user, { search: "hug" });
  expect(apps.map((a) => [a.slug, a.connected])).toEqual([
    ["gmail", true],
    ["hugging_face", false],
  ]);
  expect(apps[1]).toMatchObject({ name: "Hugging Face", logo: "https://logos.test/hugging_face" });
  const hits = composioHits();
  const q = hits.find((h) => composioPath(h) === "/toolkits")?.searchParams;
  expect(q?.get("search")).toBe("hug");
  expect(
    hits.find((h) => composioPath(h) === "/connected_accounts")?.searchParams.get("user_ids"),
  ).toBe(user);
  expect(hits.some((h) => composioPath(h).startsWith("/tool_router"))).toBe(false);
});

test("the connected list is this speaker's working accounts, each named from the catalog", async () => {
  const user = speaker();
  catalog(user);
  expect(await listApps(ctx, user, { connectedOnly: true })).toEqual([
    {
      slug: "gmail",
      name: "Gmail",
      logo: "https://logos.test/gmail",
      description: "Gmail app",
      connected: true,
    },
  ]);
});

test("disconnect deletes only this speaker's own working account", async () => {
  const user = speaker();
  const { net } = catalog(user);
  expect(await disconnectApp(ctx, user, "gmail")).toBe(true);
  const deleted = net.to(`DELETE ${COMPOSIO_HOST}`);
  expect(deleted.map(composioPath)).toEqual(["/connected_accounts/ca_mine"]);
  // Someone else's, and one never finished: neither is this speaker's to remove.
  expect(await disconnectApp(ctx, user, "hugging_face")).toBe(false);
  expect(await disconnectApp(ctx, user, "slack")).toBe(false);
});
