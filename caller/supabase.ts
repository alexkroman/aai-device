import { requireEnv } from "@alexkroman1/aai";

// The speaker's local Supabase (../supabase/): the calls table, where the speaker writes an
// approved call and this agent reads it and writes back the transcript and outcome. The
// same plain-fetch client as ../agent/supabase.ts; a separate project, so its own copy.

type Env = { env: Readonly<Partial<Record<string, string>>>; signal?: AbortSignal };

export async function rest<T>(
  ctx: Env,
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const base = requireEnv(ctx, "SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv(ctx, "SUPABASE_SECRET_KEY");
  const res = await fetch(`${base}/rest/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.prefer ? { prefer: init.prefer } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
