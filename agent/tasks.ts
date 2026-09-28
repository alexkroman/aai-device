import { rest } from "./supabase.ts";

// The Running panel's labels (see the task_labels migration): written by the tool that
// starts a run, read back by GET /api/tasks beside the run's live status.

type Ctx = { env: Readonly<Partial<Record<string, string>>>; signal?: AbortSignal };

export type TaskLabel = {
  run_id: string;
  client_id: string;
  workflow: string;
  title: string;
  due_at: string | null;
};

/**
 * Record what a run is. Best effort: the run is already started and is the real thing,
 * so a failed write costs only its line in the page.
 */
export async function labelTask(
  ctx: Ctx,
  label: { runId: string; clientId: string; workflow: string; title: string; dueAt?: number },
): Promise<void> {
  await rest(ctx, "/task_labels?on_conflict=run_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      run_id: label.runId,
      client_id: label.clientId,
      workflow: label.workflow,
      title: label.title.slice(0, 300),
      due_at: label.dueAt === undefined ? null : new Date(label.dueAt).toISOString(),
    },
  }).catch((err: unknown) => console.warn(`task label not saved: ${String(err)}`));
}

/** The labels for these runs of one client, by run id. */
export async function taskLabels(
  ctx: Ctx,
  clientId: string,
  runIds: readonly string[],
): Promise<Map<string, TaskLabel>> {
  if (runIds.length === 0) return new Map();
  const rows = await rest<TaskLabel[]>(
    ctx,
    `/task_labels?client_id=eq.${encodeURIComponent(clientId)}` +
      `&run_id=in.(${runIds.map((id) => `"${id.replace(/"/g, "")}"`).join(",")})`,
  );
  return new Map(rows.map((r) => [r.run_id, r]));
}
