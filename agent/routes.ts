import {
  type ClientRunsRoutesOptions,
  clientRunsRoutes,
  type RouteContext,
  type RouteHandler,
  type RouteRequest,
  route,
  routeError,
  webhookRoute,
} from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { MIN_APP_SEARCH } from "./app-search.ts";
import { connectLink, disconnectApp, listApps } from "./apps.ts";
import { geocode } from "./google.ts";
import { createLinkCode, linkStatus } from "./link.ts";
import { addMemories, allMemories, forgetMemory, updateMemory } from "./memory.ts";
import { normalizeEmail, readProfile, writeProfile } from "./profile.ts";
import { appEvent } from "./shared.ts";
import { rest } from "./supabase.ts";
import { eventText, type TriggerEvent, unwatch, watches, watchFor } from "./watches.ts";

// What the page's sidebar reads and edits, as the agent's own JSON endpoints under /api
// (agent.ts `routes`): the household profile, the memories mem0 holds, the context each
// session started with and the compacted history behind it, the runs going on for a
// speaker, and the code that links a browser to one. The page cannot hold the mem0 or
// Supabase keys, so everything goes through here.
//
// As open as the server: `aai dev` listens on the LAN, so anyone who can reach it can
// read these. Nothing here returns a key, and the phone number only as its last digits.
//
// A request the page got wrong (a bad body, no ?client=) is answered 400 with the reason:
// by `route()` at the door, or by a `routeError` thrown inside.

/** Sessions listed for the page to pick from, newest first. */
export const MAX_LISTED_SESSIONS = 50;

/** Finished runs stay in the Running panel this long, so a reminder that just rang shows it. */
export const RECENTLY_FINISHED_MS = 10 * 60 * 1000;

/** An app's slug from the path, e.g. `gmail`: Composio's toolkit names. */
function app(req: Pick<RouteRequest, "params">): string {
  const slug = req.params.app ?? "";
  if (!/^[a-z0-9_-]{1,64}$/.test(slug)) throw routeError(400, "not an app name");
  return slug;
}

const enc = encodeURIComponent;

/** Optional text up to `max` characters, trimmed; absent or null is left alone. */
const text = (max: number) => z.string().max(max).trim().nullish();
/** Text that must be there. */
const required = (max: number) => z.string().trim().min(1, "text is required").max(max);

/**
 * The Running panel's choices over the SDK's clientRunsRoutes (the list, the recent
 * window, the spoken failure reason and the cancel that only reaches this speaker's own
 * runs are the SDK's).
 */
export const RUNNING: ClientRunsRoutesOptions = {
  recentMs: RECENTLY_FINISHED_MS,
  // An app event that wasn't one they wanted was judged and dropped: not a task.
  include: (r) =>
    !(
      r.workflow === "appEvent" &&
      r.status === "completed" &&
      (r.output as { told?: unknown } | undefined)?.told !== true
    ),
  // Research and app jobs narrate their progress; nothing else does.
  progressFor: (r) => r.workflow === "research" || r.workflow === "appJob",
  // A call's run completes whether or not the call happened: what the speaker said about
  // it ("Luigi's didn't answer") is its result.
  detail: (r) => {
    const said =
      r.status === "completed" && r.workflow === "call"
        ? (r.output as { said?: unknown } | undefined)?.said
        : undefined;
    return typeof said === "string" ? said : undefined;
  },
};

async function profileView(ctx: RouteContext) {
  const p = await readProfile(ctx);
  return {
    name: p.name ?? "",
    home_address: p.home_address ?? "",
    phone_last4: p.phone ? p.phone.slice(-4) : "",
    email: p.email ?? "",
  };
}

export const routes: Record<string, RouteHandler> = {
  // --- The household profile: the one address everything uses --------------------------
  "GET /profile": (_req, ctx) => profileView(ctx),
  "PUT /profile": route({
    body: z.object({ name: text(80), home_address: text(300), email: text(254) }),
    handler: async ({ body }, ctx) => {
      const { name, home_address: address, email } = body;
      if (name != null) await writeProfile(ctx, { name: name || null });
      if (email != null) {
        // The page is the one place it is set (profile.ts `email`).
        const valid = email ? normalizeEmail(email) : null;
        if (valid === undefined) throw routeError(400, "That isn't an email address.");
        await writeProfile(ctx, { email: valid });
      }
      if (address === "") await writeProfile(ctx, { home_address: null, home_coords: null });
      else if (address != null) {
        // As update_profile saves it: Google's formatting, so a wrong match is visible.
        const found = await geocode(address, ctx);
        if (isToolFailure(found))
          throw routeError(400, `Couldn't find that address: ${found.error}`);
        await writeProfile(ctx, {
          home_address: found.formattedAddress,
          home_coords: `${found.latitude},${found.longitude}`,
        });
      }
      return await profileView(ctx);
    },
  }),

  // --- Memories (mem0) -------------------------------------------------------------------
  "GET /memories": async (_req, ctx) => ({
    memories: (await allMemories(ctx)).map((m) => ({
      id: m.id,
      memory: m.memory,
      updated_at: m.updated_at ?? null,
    })),
  }),
  "POST /memories": route({
    body: z.object({ text: required(300) }),
    handler: async ({ body }, ctx) => {
      // As typed: the page is the one place a memory is written word for word.
      await addMemories(ctx, [{ role: "user", content: body.text }], {
        infer: false,
        metadata: { source: "page" },
      });
      return { added: true };
    },
  }),
  "PUT /memories/:id": route({
    body: z.object({ text: required(300) }),
    handler: async (req, ctx) => {
      await updateMemory(ctx, req.params.id ?? "", req.body.text);
      return { updated: true };
    },
  }),
  "DELETE /memories/:id": async (req, ctx) => {
    await forgetMemory(ctx, req.params.id ?? "");
    return { deleted: true };
  },

  // --- Context: what the session started with, and the history it was built from --------
  "GET /context": route({
    requireClient: true,
    handler: async (req, ctx) => {
      const id = enc(req.clientId);
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
  }),
  "PUT /context/older": route({
    body: z.object({ summary: text(6000) }),
    requireClient: true,
    handler: async (req, ctx) => {
      await rest(ctx, `/older_history?client_id=eq.${enc(req.clientId)}`, {
        method: "PATCH",
        body: { summary: req.body.summary ?? "", updated_at: new Date().toISOString() },
      });
      return { updated: true };
    },
  }),
  "PUT /context/digests/:sessionId": route({
    body: z.object({ digest: text(2000) }),
    requireClient: true,
    handler: async (req, ctx) => {
      await rest(
        ctx,
        `/conversation_digests?client_id=eq.${enc(req.clientId)}&session_id=eq.${enc(req.params.sessionId ?? "")}`,
        { method: "PATCH", body: { digest: req.body.digest ?? "" } },
      );
      return { updated: true };
    },
  }),
  "DELETE /context/digests/:sessionId": route({
    requireClient: true,
    handler: async (req, ctx) => {
      await rest(
        ctx,
        `/conversation_digests?client_id=eq.${enc(req.clientId)}&session_id=eq.${enc(req.params.sessionId ?? "")}`,
        { method: "DELETE" },
      );
      return { deleted: true };
    },
  }),

  // --- Sessions: every conversation this speaker has had, to continue any of them --------
  "GET /sessions": route({
    requireClient: true,
    handler: async (req, ctx) => {
      const { sessions } = await ctx.clientTranscript(req.clientId);
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
  }),

  // --- Running: this speaker's reminders, research, calls and app jobs -------------------
  // GET /tasks answers { runs } oldest first; DELETE /tasks/:runId cancels one, 404 unless
  // it is keyed by this ?client= (every run a tool starts for a speaker is).
  ...clientRunsRoutes(RUNNING),

  // --- Apps: the accounts this speaker acts on (apps.ts, Composio) -----------------------
  // Connected ones, or the catalog matching ?search=.
  "GET /apps": route({
    requireClient: true,
    handler: async (req, ctx) => {
      const search = req.query.search?.trim().slice(0, 100);
      // Composio refuses a search under MIN_APP_SEARCH characters: nothing matches yet.
      if (search && search.length < MIN_APP_SEARCH) return { apps: [] };
      return {
        apps: await listApps(ctx, req.clientId, search ? { search } : { connectedOnly: true }),
      };
    },
  }),
  // Composio's hosted Connect Link for one app. The page opens it and comes back to
  // `returnTo`, its own address.
  "POST /apps/:app/connect": route({
    body: z.object({
      returnTo: z
        .string()
        .trim()
        .max(2000)
        .regex(/^https?:\/\//, "returnTo: the page's http(s) address"),
    }),
    requireClient: true,
    handler: async (req, ctx) => ({
      url: await connectLink(ctx, req.clientId, app(req), req.body.returnTo),
    }),
  }),
  "DELETE /apps/:app": route({
    requireClient: true,
    handler: async (req, ctx) => ({
      disconnected: await disconnectApp(ctx, req.clientId, app(req)),
    }),
  }),
  // What the speaker was asked to tell them about (watches.ts), and stopping one.
  "GET /watches": route({
    requireClient: true,
    handler: async (req, ctx) => ({
      watches: (await watches(ctx, req.clientId)).map((w) => ({
        id: w.trigger_id,
        app: w.app,
        instruction: w.instruction,
        createdAt: w.created_at,
      })),
    }),
  }),
  "DELETE /watches/:id": route({
    requireClient: true,
    handler: async (req, ctx) => ({
      stopped: await unwatch(ctx, req.clientId, req.params.id ?? ""),
    }),
  }),

  // --- Composio's webhook: events from watched apps --------------------------------------
  // Not the page's: Composio POSTs every trigger event here (watches.ts), signed with the
  // project's webhook secret. The one route a stranger can reach on a hosted server, so
  // nothing happens before the signature checks out (webhookRoute), and an event only
  // counts when its trigger is a watch of the user it claims to be for. A redelivery is
  // the same run: the event id is its dedupe key.
  "POST /composio/webhook": webhookRoute(
    { secretEnv: "COMPOSIO_WEBHOOK_SECRET" },
    async (req, ctx) => {
      const event = req.body as TriggerEvent;
      // Other project events (a connection expiring) arrive here too: acknowledged, unused.
      if (event.type !== "composio.trigger.message") return { ignored: event.type };
      const w = await watchFor(ctx, event);
      if (!w) return { ignored: "no such watch" };
      await ctx.workflows.start(
        appEvent,
        {
          clientId: w.client_id,
          instruction: w.instruction,
          app: w.app,
          trigger: w.trigger_slug,
          event: eventText(event.data),
        },
        { key: w.client_id, dedupeKey: event.id, label: w.instruction },
      );
      return { started: true };
    },
  ),

  // --- Linking a browser to a speaker (link.ts) ------------------------------------------
  "POST /link": route({
    requireClient: true,
    handler: async (req, ctx) => createLinkCode(ctx, req.clientId),
  }),
  "GET /link": route({
    requireClient: true,
    handler: async (req, ctx) => ({
      speakerClient: (await linkStatus(ctx, req.clientId)) ?? null,
    }),
  }),
};
