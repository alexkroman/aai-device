import { requireEnv } from "@alexkroman1/aai";

// The local Supabase stack (`make supabase`, ../supabase/): the household profile and
// the compacted conversation history. Plain fetch against its REST API and edge functions, because tool code runs
// in a worker that has fetch and nothing else. Beside agent.ts, not in tools/, because
// every file there must be a tool.
//
// SUPABASE_URL and SUPABASE_SECRET_KEY come from `supabase status` (API_URL and
// SECRET_KEY). The secret key bypasses RLS, and every table has RLS on with no
// policies, so this key is the only thing that can read them.

type Env = { env: Readonly<Partial<Record<string, string>>>; signal?: AbortSignal };

function endpoint(ctx: Env, path: string): { url: string; headers: Record<string, string> } {
  const base = requireEnv(ctx, "SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv(ctx, "SUPABASE_SECRET_KEY");
  return {
    url: `${base}${path}`,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
  };
}

/** A table or RPC under /rest/v1, e.g. `rest(ctx, "/profile?select=key,value")`. */
export async function rest<T>(
  ctx: Env,
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const { url, headers } = endpoint(ctx, `/rest/v1${path}`);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.prefer ? { ...headers, prefer: init.prefer } : headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
