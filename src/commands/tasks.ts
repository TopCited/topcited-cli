import type { Command } from "commander";
import type { Context } from "../context";
import { usageError } from "../errors";
import { fields, table, when } from "../format";
import { parseJobRef, taskJob } from "../jobs";
import { parseTimeout, waitFor, withWaitOptions, type WaitOptions } from "../wait";
import type { Action } from "./types";

export function registerTasks(program: Command, action: Action): void {
  const tasks = program.command("tasks").description("Background tasks");
  tasks
    .command("list")
    .description("List background tasks")
    .option("--status <status>", "filter by status")
    .option("--type <type>", "filter by task type")
    .option("--limit <n>", "newest N tasks (max 100)", "50")
    .addHelpText("after", "\nExample:\n  $ topcited tasks list --status running")
    .action(action(list));
  withWaitOptions(tasks.command("show").description("Show a task").argument("<id>", "task id"))
    .addHelpText("after", "\nExample:\n  $ topcited tasks show 9b1f… --wait")
    .action(action(show));

  withWaitOptions(
    program
      .command("wait")
      .description("Wait for a job started earlier (the `job` field of any async command)")
      .argument("<job>", "job reference, e.g. monitor:<set>:<batch>, report:<id>, task:<id>"),
  )
    .addHelpText("after", "\nExample:\n  $ topcited wait monitor:3f2a…:9c41… --timeout 1800")
    .action(action(waitCommand));
}

async function list(ctx: Context, opts: { status?: string; type?: string; limit: string }): Promise<void> {
  const limit = Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw usageError("--limit must be 1–100.");
  const client = await ctx.api();
  const rows = await ctx.call(client.GET("/api/v1/tasks", { params: { query: { status: opts.status, task_type: opts.type, limit } } }));
  ctx.print(rows, () =>
    table(rows, [
      ["ID", (t) => t.id],
      ["TYPE", (t) => t.task_type],
      ["STATUS", (t) => t.status],
      ["CREATED", (t) => when(t.created_at)],
    ]),
  );
}

async function show(ctx: Context, opts: WaitOptions, id: string): Promise<void> {
  const client = await ctx.api();
  const t = opts.wait
    ? ((await waitFor(ctx, taskJob(ctx, client, id), parseTimeout(opts.timeout))).result as Awaited<ReturnType<typeof fetchTask>>)
    : await fetchTask(ctx, client, id);
  ctx.print(t, () =>
    fields([
      ["Task", t.id],
      ["Type", t.task_type],
      ["Status", t.status],
      ["Started", when(t.started_at)],
      ["Completed", when(t.completed_at)],
      ["Error", t.error_message],
    ]),
  );
}

function fetchTask(ctx: Context, client: Awaited<ReturnType<Context["api"]>>, id: string) {
  return ctx.call(client.GET("/api/v1/tasks/{task_id}", { params: { path: { task_id: id } } }));
}

async function waitCommand(ctx: Context, opts: WaitOptions, ref: string): Promise<void> {
  const client = await ctx.api();
  const job = parseJobRef(ctx, client, ref);
  const state = await waitFor(ctx, job, parseTimeout(opts.timeout));
  ctx.print({ job: job.ref, status: state.status, progress: state.progress ?? null, result: state.result ?? null }, `${job.kind} ${job.id}: ${state.status}${state.progress ? ` (${state.progress})` : ""}`);
}
