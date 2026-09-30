import { installFetchRoutes } from "@alexkroman1/aai/testing/vitest";
import { afterEach } from "vitest";
import {
  claimLinkCode,
  createLinkCode,
  LINK_CODE_TTL_MS,
  linkStatus,
  MAX_LINK_ATTEMPTS,
} from "./link.ts";
import { sha256 } from "./profile.ts";

// The spoken code is the only thing between a stranger on the LAN and a speaker's
// conversation, so these pin that it is single-use, short-lived and not guessable by
// trying: a small in-memory link_codes table behind the PostgREST calls link.ts makes.

type Row = {
  id: number;
  code_sha256: string;
  browser_client: string;
  speaker_client: string | null;
  attempts: number;
  expires_at: string;
  created_at: string;
};

const ctx = { env: { SUPABASE_URL: "http://supabase.test", SUPABASE_SECRET_KEY: "sb-test" } };
let rows: Row[] = [];
let nextId = 1;

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, cond] of params) {
    if (["select", "order", "limit"].includes(key)) continue;
    const value = row[key as keyof Row];
    const [op, ...rest] = cond.split(".");
    const arg = rest.join(".");
    if (op === "eq" && String(value) !== arg) return false;
    if (op === "is" && arg === "null" && value !== null) return false;
    if (op === "not" && arg === "is.null" && value === null) return false;
    if (op === "gt" && !(String(value) > arg)) return false;
    if (op === "lt" && !(Number(value) < Number(arg))) return false;
    if (op === "in" && !arg.slice(1, -1).split(",").includes(String(value))) return false;
  }
  return true;
}

function fakeSupabase() {
  installFetchRoutes({
    "supabase.test": ({ method, searchParams: where, json: body }) => {
      if (method === "POST") {
        rows.push({
          id: nextId++,
          speaker_client: null,
          attempts: 0,
          created_at: new Date().toISOString(),
          ...(body as Partial<Row>),
        } as Row);
        return { status: 201 };
      }
      if (method === "DELETE") {
        rows = rows.filter((r) => !matches(r, where));
        return { body: [] };
      }
      if (method === "PATCH") {
        for (const r of rows) if (matches(r, where)) Object.assign(r, body);
        return { body: [] };
      }
      return { body: rows.filter((r) => matches(r, where)).sort((a, b) => b.id - a.id) };
    },
  });
}

afterEach(() => {
  rows = [];
});

test("a code said to the speaker links that browser to that speaker, once", async () => {
  fakeSupabase();
  const { code } = await createLinkCode(ctx, "browser-a");
  expect(code).toMatch(/^\d{6}$/);
  expect(rows[0]?.code_sha256).not.toContain(code); // stored hashed

  expect(await claimLinkCode(ctx, code.split("").join(" "), "kitchen")).toEqual({
    status: "linked",
    browserClient: "browser-a",
  });
  expect(await linkStatus(ctx, "browser-a")).toBe("kitchen");
  // Used up: saying it again links nothing.
  expect(await claimLinkCode(ctx, code, "garage")).toEqual({ status: "none_pending" });
});

test("wrong guesses burn every pending code's attempts, then the codes die", async () => {
  fakeSupabase();
  const { code } = await createLinkCode(ctx, "browser-a");
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 1; i < MAX_LINK_ATTEMPTS; i++) {
    expect(await claimLinkCode(ctx, wrong, "kitchen")).toEqual({
      status: "wrong",
      attemptsLeft: MAX_LINK_ATTEMPTS - i,
    });
  }
  await claimLinkCode(ctx, wrong, "kitchen");
  expect(await claimLinkCode(ctx, code, "kitchen")).toEqual({ status: "none_pending" });
  expect(await linkStatus(ctx, "browser-a")).toBeUndefined();
});

test("an expired code links nothing", async () => {
  fakeSupabase();
  const past = Date.now() - LINK_CODE_TTL_MS - 1000;
  const { code } = await createLinkCode(ctx, "browser-a", past);
  expect(await claimLinkCode(ctx, code, "kitchen")).toEqual({ status: "none_pending" });
});

test("a new code replaces the browser's pending one", async () => {
  fakeSupabase();
  await createLinkCode(ctx, "browser-a");
  const second = await createLinkCode(ctx, "browser-a");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.code_sha256).toBe(await sha256(second.code));
});

test("after an unlink, asking for a new code does not re-link the old speaker", async () => {
  fakeSupabase();
  const { code } = await createLinkCode(ctx, "browser-a");
  await claimLinkCode(ctx, code, "kitchen");
  expect(await linkStatus(ctx, "browser-a")).toBe("kitchen");
  await createLinkCode(ctx, "browser-a");
  expect(await linkStatus(ctx, "browser-a")).toBeUndefined();
});
