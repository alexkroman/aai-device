import { afterEach, vi } from "vitest";
import {
  COMPOSIO_URL,
  callApi,
  compact,
  disconnectApp,
  findActions,
  MAX_FOUND_ACTIONS,
  MAX_RESULT_STRING,
  runAction,
  runWorkbench,
} from "./apps.ts";

// Composio behind a fake fetch, with the composio_sessions table beside it: what these
// pin is that each speaker is its own Composio user, its session is made once and reused,
// a session Composio lost is made again, and a disconnect can only reach the speaker's
// own account.

const ctx = {
  env: {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_SECRET_KEY: "sb-test",
    COMPOSIO_API_KEY: "ak_test",
  },
};

type Call = { method: string; url: URL; body: unknown };

function fakeBackends(composio: (c: Call) => { status?: number; body: unknown }) {
  const table = new Map<string, string>();
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const c = {
      method: init.method ?? "GET",
      url: new URL(url),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    if (c.url.host === "supabase.test") {
      const q = c.url.searchParams;
      const key = `${q.get("client_id")?.replace(/^eq\./, "")}:${q.get("kind")?.replace(/^eq\./, "")}`;
      if (c.method === "POST") {
        const row = c.body as { client_id: string; kind: string; session_id: string };
        table.set(`${row.client_id}:${row.kind}`, row.session_id);
        return new Response("");
      }
      if (c.method === "DELETE") {
        table.delete(key);
        return new Response("");
      }
      const id = table.get(key);
      return Response.json(id ? [{ session_id: id }] : []);
    }
    const { status = 200, body } = composio(c);
    return Response.json(body, { status });
  });
  return { calls, table };
}

afterEach(() => vi.unstubAllGlobals());

let n = 0;
/** A speaker id no earlier test used: apps.ts caches sessions per speaker for the process. */
const speaker = () => `speaker-${++n}`;

const composioPath = (c: Call) => c.url.pathname.replace(new URL(COMPOSIO_URL).pathname, "");

test("a speaker's session is made once, as its own user, and reused", async () => {
  const user = speaker();
  const { calls, table } = fakeBackends((c) =>
    composioPath(c) === "/tool_router/session"
      ? { status: 201, body: { session_id: "trs_1" } }
      : { body: { data: { ok: 1 }, error: null, log_id: "log_1" } },
  );
  await runAction(ctx, user, "GMAIL_FETCH_EMAILS", {});
  await runAction(ctx, user, "GMAIL_FETCH_EMAILS", {});
  const created = calls.filter((c) => composioPath(c) === "/tool_router/session");
  expect(created).toHaveLength(1);
  expect(created[0]?.body).toMatchObject({
    user_id: user,
    manage_connections: { enable: false },
  });
  expect(table.get(`${user}:voice`)).toBe("trs_1");
  expect(
    calls.filter((c) => composioPath(c) === "/tool_router/session/trs_1/execute"),
  ).toHaveLength(2);
  expect(calls.find((c) => c.url.host !== "supabase.test")?.url.href).toContain("/api/v3.1/");
});

test("a session Composio no longer has is made again, once", async () => {
  const user = speaker();
  let made = 0;
  fakeBackends((c) => {
    const path = composioPath(c);
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

test("the background session is its own, with the workbench on", async () => {
  const user = speaker();
  const { calls } = fakeBackends((c) =>
    composioPath(c) === "/tool_router/session"
      ? {
          body: {
            session_id: `trs_${(c.body as { workbench: { enable: boolean } }).workbench.enable ? "bg" : "v"}`,
          },
        }
      : { body: { data: { results: "42" }, error: null, log_id: "log_w" } },
  );
  await runAction(ctx, user, "GMAIL_FETCH_EMAILS", {});
  await runWorkbench(ctx, user, "print(6*7)", "check");
  const created = calls.filter((c) => composioPath(c) === "/tool_router/session");
  expect(created.map((c) => (c.body as { workbench: unknown }).workbench)).toEqual([
    { enable: false },
    { enable: true },
  ]);
  const ran = calls.find((c) => composioPath(c) === "/tool_router/session/trs_bg/execute");
  expect(ran?.body).toMatchObject({ tool_slug: "COMPOSIO_REMOTE_WORKBENCH" });
});

test("an API call goes through the session's proxy, query as parameters", async () => {
  const { calls } = fakeBackends((c) =>
    composioPath(c) === "/tool_router/session"
      ? { body: { session_id: "trs_p" } }
      : { body: { status: 200, data: { login: "sam", bio: null } } },
  );
  expect(
    await callApi(ctx, speaker(), {
      app: "github",
      method: "GET",
      path: "/user",
      query: { a: "1" },
    }),
  ).toEqual({ status: 200, data: { login: "sam" } });
  expect(calls.at(-1)?.body).toEqual({
    toolkit_slug: "github",
    endpoint: "/user",
    method: "GET",
    parameters: [{ name: "a", value: "1", type: "query" }],
  });
});

test("an action's failure is its result, with the log id", async () => {
  fakeBackends((c) =>
    composioPath(c) === "/tool_router/session"
      ? { body: { session_id: "trs_f" } }
      : { body: { data: {}, error: "No connected account for gmail", log_id: "log_f" } },
  );
  expect(await runAction(ctx, speaker(), "GMAIL_SEND_EMAIL", {})).toEqual({
    ok: false,
    error: "No connected account for gmail",
    logId: "log_f",
  });
});

test("an action Composio doesn't have is a failure naming the fix, not a throw", async () => {
  fakeBackends((c) =>
    composioPath(c) === "/tool_router/session"
      ? { body: { session_id: "trs_u" } }
      : {
          status: 404,
          body: { error: { message: "Tool MSG91_SEND_SMS not found", request_id: "r1" } },
        },
  );
  expect(await runAction(ctx, speaker(), "MSG91_SEND_SMS", {})).toEqual({
    ok: false,
    error: "There is no action MSG91_SEND_SMS. Use one find_app_action returned.",
  });
});

test("a bad key still throws: that's the deploy's to fix, not the model's", async () => {
  fakeBackends((c) =>
    composioPath(c) === "/tool_router/session"
      ? { body: { session_id: "trs_k" } }
      : { status: 401, body: { error: { message: "Invalid API key" } } },
  );
  await expect(runAction(ctx, speaker(), "GMAIL_SEND_EMAIL", {})).rejects.toThrow(/401/);
});

test("search returns a few actions with their inputs and whether the app is connected, however Composio cases the app", async () => {
  fakeBackends((c) => {
    if (composioPath(c) === "/tool_router/session") return { body: { session_id: "trs_s" } };
    const slugs = ["CAL_LIST", "CAL_GET", "CAL_FIND", "CAL_A", "CAL_B"];
    return {
      body: {
        results: [{ primary_tool_slugs: slugs.slice(0, 2), related_tool_slugs: slugs }],
        toolkit_connection_statuses: [{ toolkit: "googlecalendar", has_active_connection: true }],
        tool_schemas: Object.fromEntries(
          slugs.map((s) => [
            s,
            {
              toolkit: "GOOGLECALENDAR",
              tool_slug: s,
              description: "List events",
              input_schema: {
                type: "object",
                properties: { timeMin: { type: "string", description: "RFC3339" } },
                required: ["timeMin"],
              },
            },
          ]),
        ),
      },
    };
  });
  const found = await findActions(ctx, speaker(), "what's on my calendar tomorrow");
  expect(found).toHaveLength(MAX_FOUND_ACTIONS);
  expect(found[0]).toEqual({
    action: "CAL_LIST",
    app: "googlecalendar",
    connected: true,
    description: "List events",
    params: [{ name: "timeMin", type: "string", required: true, description: "RFC3339" }],
  });
});

test("disconnect deletes only the account on this speaker's own session", async () => {
  const user = speaker();
  const { calls } = fakeBackends((c) => {
    const path = composioPath(c);
    if (path === "/tool_router/session") return { body: { session_id: "trs_d" } };
    if (path === "/tool_router/session/trs_d/toolkits")
      return {
        body: {
          items: [
            {
              slug: "gmail",
              name: "Gmail",
              is_no_auth: false,
              meta: { logo: "", description: "" },
              connected_account: { id: "ca_mine" },
            },
          ],
        },
      };
    return { body: {} };
  });
  expect(await disconnectApp(ctx, user, "gmail")).toBe(true);
  const deleted = calls.filter((c) => c.method === "DELETE" && c.url.host !== "supabase.test");
  expect(deleted.map(composioPath)).toEqual(["/connected_accounts/ca_mine"]);
  expect(await disconnectApp(ctx, user, "slack")).toBe(false);
});

test("compact drops empties and clips long strings", () => {
  const long = "x".repeat(MAX_RESULT_STRING * 2);
  expect(compact({ a: null, b: "", c: [], d: {}, e: { f: null }, g: 0, h: long })).toEqual({
    g: 0,
    h: `${"x".repeat(MAX_RESULT_STRING - 1)}…`,
  });
});
