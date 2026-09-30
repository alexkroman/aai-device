import { requireEnv } from "@alexkroman1/aai";
import type { EnvContext } from "@alexkroman1/aai/step";
import { isRecord, jsonClient } from "@alexkroman1/aai/utils";

// The local Supabase stack (`make supabase`, ../supabase/): the household profile and
// the compacted conversation history, through its REST API (PostgREST). Beside agent.ts,
// not in tools/, because every file there must be a tool.
//
// SUPABASE_URL and SUPABASE_SECRET_KEY come from `supabase status` (API_URL and
// SECRET_KEY). The secret key bypasses RLS, and every table has RLS on with no
// policies, so this key is the only thing that can read them.

const postgrest = jsonClient({
  label: "Supabase",
  baseUrl: (env) => `${requireEnv({ env }, "SUPABASE_URL").replace(/\/+$/, "")}/rest/v1`,
  headers: (env) => {
    const key = requireEnv({ env }, "SUPABASE_SECRET_KEY");
    return { apikey: key, authorization: `Bearer ${key}` };
  },
  // PostgREST's refusal is { message, details, hint, code }.
  errorMessage: (body) =>
    isRecord(body) && typeof body.message === "string" ? body.message : undefined,
});

/**
 * A table or RPC under /rest/v1, e.g. `rest(ctx, "/profile?select=key,value")`. An
 * empty answer (`return=minimal`, a DELETE) resolves `{}`.
 */
export async function rest<T>(
  ctx: EnvContext,
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  return await postgrest<T>(
    ctx,
    init.method ?? "GET",
    path,
    init.body,
    init.prefer ? { headers: { prefer: init.prefer } } : undefined,
  );
}
