import { type RouteHandler, type RouteRequest, routeResponse } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { MIN_APP_SEARCH } from "./app-search.ts";
import { connectLink, disconnectApp, listApps } from "./apps.ts";
import { geocode } from "./google.ts";
import { createLinkCode, linkStatus } from "./link.ts";
import { addMemories, allMemories, forgetMemory, updateMemory } from "./memory.ts";
import { normalizeEmail, readProfile, writeProfile } from "./profile.ts";
import { appEvent, appJob, call, emailResult, remind, research } from "./shared.ts";
import { rest } from "./supabase.ts";
import {
  eventText,
  firstDelivery,
  type TriggerEvent,
  unwatch,
  verifyWebhook,
  watches,
  watchFor,
} from "./watches.ts";
import { failureReason } from "./workflows/research.ts";

// What the page's sidebar reads and edits, as the agent's own JSON endpoints under /api
// (agent.ts `routes`): the household profile, the memories mem0 holds, the context each
// session started with and the compacted history behind it, the runs going on for a
// speaker, and the code that links a browser to one. The page cannot hold the mem0 or
// Supabase keys, so everything goes through here.
//
// As open as the server: `aai dev` listens on the LAN, so anyone who can reach it can
// read these. Nothing here returns a key, and the phone number only as its last digits.

type Handler = RouteHandler;

/** Sessions listed for the page to pick from, newest first. */
export const MAX_LISTED_SESSIONS = 50;

/** A request the page got wrong, answered as 400 with the reason. */
export class BadRequest extends Error {}

function field(body: unknown, name: string, max: number): string | undefined {
  const value = (body as Record<string, unknown> | null)?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new BadRequest(`${name}: text up to ${max}`);
  return value.trim();
}

function client(req: RouteRequest): string {
  if (!req.clientId) throw new BadRequest("?client= is required");
  return req.clientId;
}

/** An app's slug from the path, e.g. `gmail`: Composio's toolkit names. */
function app(req: RouteRequest): string {
  const slug = req.params.app ?? "";
  if (!/^[a-z0-9_-]{1,64}$/.test(slug)) throw new BadRequest("not an app name");
  return slug;
}

const enc = encodeURIComponent;

/** A handler whose BadRequest is answered 400 with its reason, rather than a 500. */
function guard(handler: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof BadRequest) return routeResponse(400, { error: err.message });
      throw err;
    }
  };
}

/** Whether an appEvent run said something (its output is `{ told }`). */
function told(output: unknown): boolean {
  return (output as { told?: unknown } | undefined)?.told === true;
}

/** Finished runs stay in the Running panel this long, so a reminder that just rang shows it. */
export const RECENTLY_FINISHED_MS = 10 * 60 * 1000;

const handlers: Record<string, Handler> = {
  // --- The household profile: the one address everything uses --------------------------
  "GET /profile": async (_req, ctx) => {
    const p = await readProfile(ctx);
    return {
      name: p.name ?? "",
      home_address: p.home_address ?? "",
      phone_last4: p.phone ? p.phone.slice(-4) : "",
      email: p.email ?? "",
    };
  },
  "PUT /profile": async (req, ctx) => {
    const name = field(req.body, "name", 80);
    const address = field(req.body, "home_address", 300);
    const email = field(req.body, "email", 254);
    if (name !== undefined) await writeProfile(ctx, { name: name || null });
    if (email !== undefined) {
      // The page is the one place it is set (profile.ts `email`).
      const valid = email ? normalizeEmail(email) : null;
      if (valid === undefined) throw new BadRequest("That isn't an email address.");
      await writeProfile(ctx, { email: valid });
    }
    if (address === "") await writeProfile(ctx, { home_address: null, home_coords: null });
    else if (address !== undefined) {
      // As update_profile saves it: Google's formatting, so a wrong match is visible.
      const found = await geocode(address, ctx);
      if (isToolFailure(found)) throw new BadRequest(`Couldn't find that address: ${found.error}`);
      await writeProfile(ctx, {
        home_address: found.formattedAddress,
        home_coords: `${found.latitude},${found.longitude}`,
      });
    }
    return handlers["GET /profile"]?.(req, ctx);
  },

  // --- Memories (mem0) -------------------------------------------------------------------
  "GET /memories": async (_req, ctx) => ({
    memories: (await allMemories(ctx)).map((m) => ({
      id: m.id,
      memory: m.memory,
      updated_at: m.updated_at ?? null,
    })),
  }),
  "POST /memories": async (req, ctx) => {
    const text = field(req.body, "text", 300);
    if (!text) throw new BadRequest("text is required");
    // As typed: the page is the one place a memory is written word for word.
    await addMemories(ctx, [{ role: "user", content: text }], {
      infer: false,
      metadata: { source: "page" },
    });
    return { added: true };
  },
  "PUT /memories/:id": async (req, ctx) => {
    const text = field(req.body, "text", 300);
    if (!text) throw new BadRequest("text is required");
    await updateMemory(ctx, req.params.id ?? "", text);
    return { updated: true };
  },
  "DELETE /memories/:id": async (req, ctx) => {
    await forgetMemory(ctx, req.params.id ?? "");
    return { deleted: true };
  },

  // --- Context: what the session started with, and the history it was built from --------
  "GET /context": async (req, ctx) => {
    const id = enc(client(req));
    const [current, older, digests] = await Promise.all([
      rest<{ session_id: string; instructions: string; created_at: string }[]>(
        ctx,
        `/session_contexts?client_id=eq.${id}&select=session_id,instructions,created_at` +
          "&order=created_at.desc&limit=1",
      ),
      rest<{ summary: string; through: string }[]>(
        ctx,
        `/older_history?client_id=eq.${id}&select=summary,through`,
      ),
      rest<{ session_id: string; started_at: string; digest: string }[]>(
        ctx,
        `/conversation_digests?client_id=eq.${id}&digest=neq.` +
          "&select=session_id,started_at,digest&order=started_at.asc",
      ),
    ]);
    return { current: current[0] ?? null, older: older[0] ?? null, digests };
  },
  "PUT /context/older": async (req, ctx) => {
    const summary = field(req.body, "summary", 6000) ?? "";
    await rest(ctx, `/older_history?client_id=eq.${enc(client(req))}`, {
      method: "PATCH",
      body: { summary, updated_at: new Date().toISOString() },
    });
    return { updated: true };
  },
  "PUT /context/digests/:sessionId": async (req, ctx) => {
    const digest = field(req.body, "digest", 2000) ?? "";
    await rest(
      ctx,
      `/conversation_digests?client_id=eq.${enc(client(req))}&session_id=eq.${enc(req.params.sessionId ?? "")}`,
      { method: "PATCH", body: { digest } },
    );
    return { updated: true };
  },
  "DELETE /context/digests/:sessionId": async (req, ctx) => {
    await rest(
      ctx,
      `/conversation_digests?client_id=eq.${enc(client(req))}&session_id=eq.${enc(req.params.sessionId ?? "")}`,
      { method: "DELETE" },
    );
    return { deleted: true };
  },

  // --- Sessions: every conversation this speaker has had, to continue any of them --------
  "GET /sessions": async (req, ctx) => {
    const { sessions } = await ctx.clientTranscript(client(req));
    return {
      sessions: sessions
        .map((s) => {
          const said = s.messages.filter((m) => m.role === "user" && m.text.trim());
          return {
            sessionId: s.sessionId,
            startedAt: new Date(s.startedAt).getTime(),
            preview: (said[0]?.text ?? "").slice(0, 120),
            turns: said.length,
          };
        })
        .filter((s) => s.turns > 0)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_LISTED_SESSIONS),
    };
  },

  // --- Running: this speaker's reminders and research jobs -------------------------------
  "GET /tasks": async (req, ctx) => {
    const id = client(req);
    // All keyed by the speaker's client id (remind_me, deep_research, place_call).
    const runs = (
      await Promise.all([
        ctx.workflows.find(remind, id),
        ctx.workflows.find(research, id),
        ctx.workflows.find(call, id),
        ctx.workflows.find(appJob, id),
        ctx.workflows.find(appEvent, id),
        ctx.workflows.find(emailResult, id),
      ])
    )
      .flat()
      // An app event that wasn't one they wanted was judged and dropped: not a task.
      .filter((r) => !(r.workflow === "appEvent" && r.status === "completed" && !told(r.output)))
      .filter(
        (r) =>
          r.status === "pending" ||
          r.status === "running" ||
          Date.now() - r.createdAt < RECENTLY_FINISHED_MS,
      );

    const tasks = await Promise.all(
      runs.map(async (r) => {
        // Research narrates its progress; a line lost to a restart just isn't shown.
        const line =
          (r.workflow === "research" || r.workflow === "appJob") && r.status === "running"
            ? await ctx.workflows.lastLine(r.runId).catch(() => undefined)
            : undefined;
        return {
          runId: r.runId,
          workflow: r.workflow,
          status: r.status === "pending" ? "waiting" : r.status,
          title: r.label ?? r.workflow,
          // Why it failed, as the speaker says it: short, and with no credential a
          // provider's refusal quoted.
          ...(r.status === "failed"
            ? { detail: failureReason(new Error(r.error)) }
            : r.status === "completed" &&
                r.workflow === "call" &&
                typeof (r.output as { said?: unknown })?.said === "string"
              ? // A call's run completes whether or not the call happened: what the
                // speaker said about it ("Luigi's didn't answer") is its result.
                { detail: (r.output as { said: string }).said }
              : typeof line === "string"
                ? { detail: line }
                : {}),
          updatedAt: r.createdAt,
        };
      }),
    );
    return { tasks: tasks.sort((a, b) => a.updatedAt - b.updatedAt) };
  },
  "DELETE /tasks/:runId": async (req, ctx) => {
    const id = client(req);
    const runId = req.params.runId ?? "";
    // Only a run of THIS speaker: its key is the speaker's client id.
    if ((await ctx.workflows.get(runId))?.key !== id) {
      return routeResponse(404, { error: "no such task on this speaker" });
    }
    return { cancelled: await ctx.workflows.cancel(runId) };
  },

  // --- Apps: the accounts this speaker acts on (apps.ts, Composio) -----------------------
  // Connected ones, or the catalog matching ?search=.
  "GET /apps": async (req, ctx) => {
    const search = req.query.search?.trim().slice(0, 100);
    // Composio refuses a search under MIN_APP_SEARCH characters: nothing matches yet.
    if (search && search.length < MIN_APP_SEARCH) return { apps: [] };
    return {
      apps: await listApps(ctx, client(req), search ? { search } : { connectedOnly: true }),
    };
  },
  // Composio's hosted Connect Link for one app. The page opens it and comes back to
  // `returnTo`, its own address.
  "POST /apps/:app/connect": async (req, ctx) => {
    const returnTo = field(req.body, "returnTo", 2000);
    if (!returnTo || !/^https?:\/\//.test(returnTo))
      throw new BadRequest("returnTo: the page's http(s) address");
    return { url: await connectLink(ctx, client(req), app(req), returnTo) };
  },
  "DELETE /apps/:app": async (req, ctx) => ({
    disconnected: await disconnectApp(ctx, client(req), app(req)),
  }),
  // What the speaker was asked to tell them about (watches.ts), and stopping one.
  "GET /watches": async (req, ctx) => ({
    watches: (await watches(ctx, client(req))).map((w) => ({
      id: w.trigger_id,
      app: w.app,
      instruction: w.instruction,
      createdAt: w.created_at,
    })),
  }),
  "DELETE /watches/:id": async (req, ctx) => ({
    stopped: await unwatch(ctx, client(req), req.params.id ?? ""),
  }),

  // --- Composio's webhook: events from watched apps --------------------------------------
  // Not the page's: Composio POSTs every trigger event here (watches.ts), signed with the
  // project's webhook secret. The one route a stranger can reach on a hosted server, so
  // nothing happens before the signature checks out, and an event only counts when its
  // trigger is a watch of the user it claims to be for.
  "POST /composio/webhook": async (req, ctx) => {
    const secret = ctx.env.COMPOSIO_WEBHOOK_SECRET?.trim();
    if (!secret) return routeResponse(503, { error: "COMPOSIO_WEBHOOK_SECRET is not set" });
    if (req.rawBody === undefined || !(await verifyWebhook(secret, req.headers, req.rawBody)))
      return routeResponse(401, { error: "bad signature" });
    const event = req.body as TriggerEvent;
    // Other project events (a connection expiring) arrive here too: acknowledged, unused.
    if (event.type !== "composio.trigger.message") return { ignored: event.type };
    const w = await watchFor(ctx, event);
    if (!w) return { ignored: "no such watch" };
    if (!(await firstDelivery(ctx, event.id, w.trigger_id))) return { duplicate: true };
    await ctx.workflows.start(
      appEvent,
      {
        clientId: w.client_id,
        instruction: w.instruction,
        app: w.app,
        trigger: w.trigger_slug,
        event: eventText(event.data),
      },
      { key: w.client_id, label: w.instruction },
    );
    return { started: true };
  },

  // --- Linking a browser to a speaker (link.ts) ------------------------------------------
  "POST /link": async (req, ctx) => createLinkCode(ctx, client(req)),
  "GET /link": async (req, ctx) => ({
    speakerClient: (await linkStatus(ctx, client(req))) ?? null,
  }),
};

export const routes: Record<string, Handler> = Object.fromEntries(
  Object.entries(handlers).map(([key, handler]) => [key, guard(handler)]),
);
