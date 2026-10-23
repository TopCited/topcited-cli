import type { ApiClient } from "./client";
import type { Context } from "./context";
import { usageError } from "./errors";
import { classify, type Job, type JobState } from "./wait";

/** Pollers for the backend's async job shapes. Each `ref` round-trips through `parseJobRef`. */

/** Monitoring: `POST …/run` returns a batch_id; its runs show up in `GET /monitoring/runs`. */
export function monitorBatchJob(ctx: Context, client: ApiClient, setId: string, batchId: string, expected?: number): Job {
  return {
    kind: "monitor",
    id: batchId,
    ref: `monitor:${setId}:${batchId}`,
    async poll(): Promise<JobState> {
      const runs: { status: string; provider: string; query_text: string; error_message?: string | null }[] = [];
      // Runs are newest first, so the batch is at the front; stop once past it.
      for (let skip = 0; skip < 5000; skip += 100) {
        const page = await ctx.call(
          client.GET("/api/v1/monitoring/runs", { params: { query: { query_set_id: setId, skip, limit: 100 } } }),
        );
        const mine = page.items.filter((r) => r.run_batch_id === batchId);
        runs.push(...mine);
        const reachedOlder = page.items.some((r) => r.run_batch_id !== batchId) && runs.length > 0;
        if (reachedOlder || page.items.length < 100 || (expected !== undefined && runs.length >= expected)) break;
      }
      const counts: Record<string, number> = {};
      for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const pending = runs.filter((r) => !classify(r.status).done).length;
      const succeeded = runs.filter((r) => classify(r.status).ok).length;
      const total = Math.max(expected ?? 0, runs.length);
      const done = runs.length > 0 && runs.length >= total && pending === 0;
      const summary = Object.entries(counts)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      return {
        done,
        // A batch with some failed runs (e.g. one platform down) still produced data.
        ok: succeeded > 0,
        status: done ? (succeeded === total ? "success" : succeeded > 0 ? "partial" : "failed") : "running",
        progress: `${total - pending}/${total} runs finished${summary ? ` (${summary})` : ""}`,
        result: { batch_id: batchId, query_set_id: setId, total, counts },
      };
    },
  };
}

/** Generic background tasks: `GET /tasks/{id}`. */
export function taskJob(ctx: Context, client: ApiClient, taskId: string): Job {
  return {
    kind: "task",
    id: taskId,
    ref: `task:${taskId}`,
    async poll() {
      const t = await ctx.call(client.GET("/api/v1/tasks/{task_id}", { params: { path: { task_id: taskId } } }));
      return { ...classify(t.status), status: t.status, result: t };
    },
  };
}

export function reportJob(ctx: Context, client: ApiClient, reportId: string): Job {
  return {
    kind: "report",
    id: reportId,
    ref: `report:${reportId}`,
    async poll() {
      const r = await ctx.call(client.GET("/api/v1/reports/{report_id}", { params: { path: { report_id: reportId } } }));
      return { ...classify(r.status), status: r.status, result: r };
    },
  };
}

export function auditJob(ctx: Context, client: ApiClient, siteId: string, runId: string): Job {
  return {
    kind: "audit",
    id: runId,
    ref: `audit:${siteId}:${runId}`,
    async poll() {
      const r = await ctx.call(
        client.GET("/api/v1/seo/sites/{site_id}/audit-runs/{run_id}", { params: { path: { site_id: siteId, run_id: runId } } }),
      );
      return { ...classify(r.status), status: r.status, result: r };
    },
  };
}

export type RecommendKind = "keywords" | "prompts" | "content";
export const RECOMMEND_KINDS: RecommendKind[] = ["keywords", "prompts", "content"];

/** Latest recommendation run of a kind; the job is the run we started, until a newer one replaces it. */
export async function latestRecommendationRun(ctx: Context, client: ApiClient, kind: RecommendKind, brandId: string) {
  const params = { params: { path: { brand_id: brandId } } };
  const run =
    kind === "keywords"
      ? await ctx.call(client.GET("/api/v1/brands/{brand_id}/keyword-recommendation-runs/latest", params))
      : kind === "prompts"
        ? await ctx.call(client.GET("/api/v1/brands/{brand_id}/prompt-recommendation-runs/latest", params))
        : await ctx.call(client.GET("/api/v1/brands/{brand_id}/content-sentence-runs/latest", params));
  return run as { id: string; status: string; stage?: string | null; error_message?: string | null } | null;
}

export function recommendJob(ctx: Context, client: ApiClient, kind: RecommendKind, brandId: string, runId: string): Job {
  return {
    kind: `recommend ${kind}`,
    id: runId,
    ref: `recommend:${kind}:${brandId}:${runId}`,
    async poll() {
      const run = await latestRecommendationRun(ctx, client, kind, brandId);
      if (!run || run.id !== runId) return { done: true, ok: false, status: "superseded", progress: "a newer run replaced it" };
      return { ...classify(run.status), status: run.status, progress: run.stage ?? undefined, result: run };
    },
  };
}

/** Rebuild a job from its `ref` (printed on exit 7 and in every async command's output). */
export function parseJobRef(ctx: Context, client: ApiClient, ref: string): Job {
  const [kind, ...parts] = ref.split(":");
  const need = (n: number) => {
    if (parts.length !== n || parts.some((p) => !p)) throw usageError(`Bad job reference "${ref}".`, HINT);
  };
  switch (kind) {
    case "monitor":
      need(2);
      return monitorBatchJob(ctx, client, parts[0]!, parts[1]!);
    case "task":
      need(1);
      return taskJob(ctx, client, parts[0]!);
    case "report":
      need(1);
      return reportJob(ctx, client, parts[0]!);
    case "audit":
      need(2);
      return auditJob(ctx, client, parts[0]!, parts[1]!);
    case "recommend":
      need(3);
      if (!RECOMMEND_KINDS.includes(parts[0] as RecommendKind)) throw usageError(`Bad job reference "${ref}".`, HINT);
      return recommendJob(ctx, client, parts[0] as RecommendKind, parts[1]!, parts[2]!);
    default:
      throw usageError(`Bad job reference "${ref}".`, HINT);
  }
}

const HINT =
  "Expected monitor:<set>:<batch>, task:<id>, report:<id>, audit:<site>:<run> or recommend:<kind>:<brand>:<run>.";
