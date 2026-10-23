import type { Command } from "commander";
import type { Context } from "./context";
import { CliError, Exit, usageError } from "./errors";

/**
 * One wait loop for every backend job shape (D4): monitoring batches, generic
 * tasks, reports, site audits and recommendation runs each provide a `poll`,
 * and `waitFor` owns backoff, progress, timeout (exit 7) and failure (exit 1).
 */

export interface JobState {
  done: boolean;
  ok: boolean;
  status: string;
  /** One line for humans, e.g. "12/20 runs finished". */
  progress?: string;
  result?: unknown;
}

export interface Job {
  kind: string;
  id: string;
  /** Stable handle for `topcited wait <ref>`, e.g. `report:<id>`. */
  ref: string;
  poll: () => Promise<JobState>;
}

const PENDING = new Set(["pending", "queued", "running", "generating", "in_progress", "started", "processing"]);
const SUCCESS = new Set(["success", "succeeded", "completed", "complete", "done", "ready", "final", "draft"]);

/** Classify a backend status string. Unknown non-pending statuses count as failures. */
export function classify(status: string | null | undefined): Pick<JobState, "done" | "ok"> {
  const s = (status ?? "pending").toLowerCase();
  if (PENDING.has(s)) return { done: false, ok: false };
  return { done: true, ok: SUCCESS.has(s) };
}

export const DEFAULT_TIMEOUT_S = 1200;
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 15000;

export interface WaitOptions {
  wait?: boolean;
  timeout?: string;
}

/** Adds `--wait` and `--timeout` to a command. */
export function withWaitOptions(cmd: Command): Command {
  return cmd
    .option("--wait", "wait for the job to finish (exit 7 if --timeout passes first)")
    .option("--timeout <seconds>", `give up waiting after this long (default ${DEFAULT_TIMEOUT_S})`);
}

export function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_S;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw usageError(`--timeout must be a positive number of seconds, got "${raw}".`);
  return n;
}

/** Errors worth retrying while a job runs server-side: 5xx, 429, network. */
function transient(e: unknown): e is CliError {
  return e instanceof CliError && (e.code === "network_error" || e.status === 429 || (e.status ?? 0) >= 500);
}

/** Any error out of the loop names the job, so an agent can resume it. */
function withJob(e: unknown, job: Job): unknown {
  if (!(e instanceof CliError) || e.extra?.job) return e;
  return new CliError({ exit: e.exit, code: e.code, message: e.message, hint: e.hint, status: e.status, extra: { ...e.extra, job: job.ref, job_id: job.id } });
}

export async function waitFor(ctx: Context, job: Job, timeoutS: number): Promise<JobState> {
  try {
    return await loop(ctx, job, timeoutS);
  } catch (e) {
    throw withJob(e, job);
  }
}

async function loop(ctx: Context, job: Job, timeoutS: number): Promise<JobState> {
  const deadline = ctx.rt.now().getTime() + timeoutS * 1000;
  let delay = FIRST_DELAY_MS;
  let lastLine = "";
  for (;;) {
    let state: JobState;
    try {
      state = await job.poll();
    } catch (e) {
      // A deploy restart or a network blip mid-wait: the job is still running.
      if (!transient(e) || ctx.rt.now().getTime() >= deadline) throw e;
      ctx.warn(`poll_retry_${e.code}`, `Polling ${job.kind} ${job.id} failed (${e.message}); retrying.`);
      await ctx.rt.sleep(Math.min(delay, Math.max(0, deadline - ctx.rt.now().getTime())));
      delay = Math.min(Math.round(delay * 1.5), MAX_DELAY_MS);
      continue;
    }
    const line = state.progress ? `${state.status}: ${state.progress}` : state.status;
    if (line !== lastLine) ctx.info(`[${job.kind} ${job.id.slice(0, 8)}] ${line}`);
    lastLine = line;
    if (state.done) {
      if (!state.ok) {
        throw new CliError({
          exit: Exit.ERROR,
          code: "job_failed",
          message: `${job.kind} ${job.id} finished with status "${state.status}"${state.progress ? ` (${state.progress})` : ""}.`,
          extra: { job: job.ref, job_id: job.id, job_status: state.status, result: state.result ?? null },
        });
      }
      return state;
    }
    const remaining = deadline - ctx.rt.now().getTime();
    if (remaining <= 0) {
      throw new CliError({
        exit: Exit.WAIT_TIMEOUT,
        code: "wait_timeout",
        message: `${job.kind} ${job.id} is still ${state.status} after ${timeoutS}s.`,
        hint: `It keeps running server-side. Resume with \`topcited wait ${job.ref}\`.`,
        extra: { job: job.ref, job_id: job.id, job_status: state.status },
      });
    }
    await ctx.rt.sleep(Math.min(delay, remaining));
    delay = Math.min(Math.round(delay * 1.5), MAX_DELAY_MS);
  }
}
