import { browserId, clientId } from "./client-id.ts";

// The agent's own endpoints (routes.ts), mounted under /api. `client` is which
// conversation a call is about: the linked speaker's, or this browser's (client-id.ts).

export async function api<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: { as?: "browser" } = {},
): Promise<T> {
  const url = new URL(`/api${path}`, location.href);
  url.searchParams.set("client", opts.as === "browser" ? browserId() : clientId());
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${method} ${path}: ${res.status}`);
  return json;
}
