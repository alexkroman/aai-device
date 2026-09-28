import { type RouteHandler, type RouteRequest, routeResponse } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { geocode } from "./google.ts";
import { createLinkCode, linkStatus } from "./link.ts";
import { addMemories, allMemories, forgetMemory, updateMemory } from "./memory.ts";
import { readProfile, writeProfile } from "./profile.ts";
import { remind, research } from "./shared.ts";
import { rest } from "./supabase.ts";
import { taskLabels } from "./tasks.ts";

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
    };
  },
  "PUT /profile": async (req, ctx) => {
    const name = field(req.body, "name", 80);
    const address = field(req.body, "home_address", 300);
    if (name !== undefined) await writeProfile(ctx, { name: name || null });
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
    // Both are keyed by the speaker's client id (remind_me, deep_research).
    const runs = (
      await Promise.all([ctx.workflows.find(remind, id), ctx.workflows.find(research, id)])
    )
      .flat()
      .filter(
        (r) =>
          r.status === "pending" ||
          r.status === "running" ||
          Date.now() - r.createdAt < RECENTLY_FINISHED_MS,
      );
    const labels = await taskLabels(
      ctx,
      id,
      runs.map((r) => r.runId),
    );
    const tasks = await Promise.all(
      runs.map(async (r) => {
        const label = labels.get(r.runId);
        // Research narrates its progress; a line lost to a restart just isn't shown.
        const line =
          r.workflow === "research" && r.status === "running"
            ? await ctx.workflows.lastLine(r.runId).catch(() => undefined)
            : undefined;
        return {
          runId: r.runId,
          workflow: r.workflow,
          status: r.status === "pending" ? "waiting" : r.status,
          title: label?.title ?? r.workflow,
          ...(typeof line === "string" ? { detail: line } : {}),
          due: label?.due_at ? Date.parse(label.due_at) : null,
          updatedAt: r.createdAt,
        };
      }),
    );
    return { tasks: tasks.sort((a, b) => (a.due ?? a.updatedAt) - (b.due ?? b.updatedAt)) };
  },
  "DELETE /tasks/:runId": async (req, ctx) => {
    const id = client(req);
    const runId = req.params.runId ?? "";
    // Only a run of THIS speaker: its label says whose it is.
    if (!(await taskLabels(ctx, id, [runId])).has(runId)) {
      return routeResponse(404, { error: "no such task on this speaker" });
    }
    return { cancelled: await ctx.workflows.cancel(runId) };
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
