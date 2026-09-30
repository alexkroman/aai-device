import { requireEnv } from "@alexkroman1/aai";
import type { EnvContext } from "@alexkroman1/aai/step";
import { isRecord, jsonClient } from "@alexkroman1/aai/utils";

// The speaker's local Supabase (../supabase/): the calls table, where the speaker writes an
// approved call and this agent reads it and writes back the transcript and outcome. The
// same SDK jsonClient as ../agent/supabase.ts; a separate project, so its own copy.
//
// SUPABASE_URL and SUPABASE_SECRET_KEY come from `supabase status` (API_URL and
// SECRET_KEY). The secret key bypasses RLS, which is on for every table with no policies.

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
 * A table or RPC under /rest/v1, e.g. `rest(ctx, "/calls?id=eq.call_1")`. An empty
 * answer (`return=minimal`, a PATCH that matched nothing) resolves `{}`; a refusal
 * throws an HttpError reading "Supabase <status>: …".
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
