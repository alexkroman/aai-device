import { type RouteMethod, routeFetch } from "@alexkroman1/aai-ui";
import { linked } from "./client-id.ts";

// The agent's own endpoints (routes.ts), mounted under /api. `client` is which
// conversation a call is about: the linked speaker's, or (`as: "browser"`) this
// browser's own (client-id.ts).

export function api<T>(
  method: RouteMethod,
  path: string,
  body?: unknown,
  opts: { as?: "browser" } = {},
): Promise<T> {
  return routeFetch<T>(method, path, body, {
    client: opts.as === "browser" ? linked.own() : linked.id(),
  });
}
