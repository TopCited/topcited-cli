import type { Command } from "commander";
import { activeBrand, type ActiveBrand } from "../brand";
import type { ApiClient } from "../client";
import type { Context } from "../context";
import { CliError, Exit, usageError } from "../errors";
import { day, fields, table, when } from "../format";
import type { components } from "../generated/schema";
import { monitorBatchJob } from "../jobs";
import { pageAll } from "../paginate";
import { availableCoins, confirmSpend, withSpendOptions, type SpendOptions } from "../spend";
import { parseTimeout, waitFor, withWaitOptions, type WaitOptions } from "../wait";
import type { Action } from "./types";

type QuerySet = components["schemas"]["QuerySetResponse"];
type QuerySetDetail = components["schemas"]["QuerySetDetailResponse"];
type Platform = components["schemas"]["PlatformProvider"];
type QueryType = components["schemas"]["QueryType"];

const PLATFORMS: Platform[] = ["chatgpt", "gemini", "grok", "google", "bing", "brave", "deepseek", "baidu_search"];
// Mirrors backend monitoring/runnability.py: which query types run where.
const SEARCH_PLATFORMS = new Set<string>(["google", "bing", "brave", "baidu_search"]);
const QUERY_TYPES: QueryType[] = ["llm_prompt", "search_keyword", "universal"];

export function registerMonitor(program: Command, action: Action): void {
  const monitor = program.command("monitor").description("AI-visibility monitoring: query sets, runs and results");

  const sets = monitor.command("sets").description("Query sets (topics) of tracked prompts");
  sets
    .command("list")
    .description("List the active brand's query sets")
    .option("--all", "include every brand's sets")
    .addHelpText("after", "\nExample:\n  $ topcited monitor sets list --json")
    .action(action(listSets));
  sets
    .command("create")
    .description("Create a query set for the account's active brand")
    .argument("<name>", "set name")
    // No [] default: commander only enforces a required option that is undefined.
    .requiredOption("-p, --platform <platform>", `platform to monitor; repeatable (${PLATFORMS.join(", ")})`, collect)
    .option("-q, --query <text>", "prompt to track; repeatable", collect, [])
    .option("--type <type>", `query type for --query (${QUERY_TYPES.join(", ")})`, "llm_prompt")
    .option("--manual", "don't schedule runs; only run with `monitor run`")
    .addHelpText("after", '\nExample:\n  $ topcited monitor sets create "Payroll software" -p chatgpt -p gemini -q "best payroll software for startups"')
    .action(action(createSet));
  sets
    .command("show")
    .description("Show a query set and its queries")
    .argument("<set>", "set id, id prefix, or name")
    .addHelpText("after", '\nExample:\n  $ topcited monitor sets show "Payroll software"')
    .action(action(showSet));

  const queries = monitor.command("queries").description("Add or remove tracked prompts");
  queries
    .command("add")
    .description("Add prompts to a query set")
    .argument("<set>", "set id, id prefix, or name")
    .argument("<text...>", "one or more prompts")
    .option("--type <type>", `query type (${QUERY_TYPES.join(", ")})`, "llm_prompt")
    .addHelpText("after", '\nExample:\n  $ topcited monitor queries add Core "best payroll app" "payroll for contractors"')
    .action(action(addQueries));
  queries
    .command("rm")
    .description("Delete queries by id")
    .argument("<query-id...>", "query ids (see `monitor sets show`)")
    .addHelpText("after", "\nExample:\n  $ topcited monitor queries rm 3f2a…")
    .action(action(removeQueries));

  withWaitOptions(
    withSpendOptions(
      monitor
        .command("run")
        .description("Run a query set now (1 T-coin per query × platform)")
        .argument("<set>", "set id, id prefix, or name"),
    ),
  )
    .addHelpText("after", "\nExamples:\n  $ topcited monitor run Core --dry-run\n  $ topcited monitor run Core --wait --yes")
    .action(action(runSet));

  monitor
    .command("results")
    .description("Visibility summary, gaps and share of voice")
    .option("-s, --set <set>", "one query set (default: all of the active brand's sets)")
    .option("--since <date>", "window start, YYYY-MM-DD (default: server's default window)")
    .option("--until <date>", "window end, YYYY-MM-DD")
    .addHelpText("after", "\nExamples:\n  $ topcited monitor results\n  $ topcited monitor results --set Core --since 2026-10-01 --json")
    .action(action(results));
}

function collect(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

function allSets(ctx: Context, client: ApiClient): Promise<QuerySet[]> {
  return pageAll((skip, limit) => ctx.call(client.GET("/api/v1/monitoring/query-sets", { params: { query: { skip, limit } } })));
}

/** Resolve a set by id, id prefix (6+) or name; the active brand's sets win name ties. */
export async function resolveSet(ctx: Context, client: ApiClient, ref: string): Promise<QuerySet> {
  const sets = await allSets(ctx, client);
  const r = ref.trim().toLowerCase();
  const byId = sets.find((s) => s.id === r);
  if (byId) return byId;
  let candidates = sets.filter((s) => s.name.toLowerCase() === r);
  if (!candidates.length && r.length >= 6) candidates = sets.filter((s) => s.id.startsWith(r));
  if (candidates.length > 1) {
    const brand = await activeBrand(ctx, client).catch(() => undefined);
    const mine = candidates.filter((s) => s.brand_id === brand?.brand.id);
    if (mine.length === 1) return mine[0]!;
    throw usageError(`"${ref}" matches ${candidates.length} query sets.`, `Use an id: ${candidates.map((s) => s.id).join(", ")}`);
  }
  if (!candidates.length) {
    throw new CliError({
      exit: Exit.NOT_FOUND,
      code: "query_set_not_found",
      message: `No query set matches "${ref}".`,
      hint: "See `topcited monitor sets list --all`.",
    });
  }
  return candidates[0]!;
}

async function listSets(ctx: Context, opts: { all?: boolean }): Promise<void> {
  const client = await ctx.api();
  let sets = await allSets(ctx, client);
  if (!opts.all) {
    const { brand } = await activeBrand(ctx, client);
    sets = sets.filter((s) => s.brand_id === brand.id);
  }
  ctx.print(sets, () =>
    table(sets, [
      ["ID", (s) => s.id],
      ["NAME", (s) => s.name],
      ["QUERIES", (s) => s.active_query_count],
      ["PLATFORMS", (s) => s.platforms],
      ["MODE", (s) => (s.paused ? "paused" : s.run_mode)],
      ["LAST RUN", (s) => (s.last_run_at ? `${when(s.last_run_at)} ${s.last_run_status ?? ""}` : "-")],
    ]),
  );
}

/**
 * Creation and reports use the account's server-side active brand, which the
 * public API can't change. Refuse rather than silently create under a brand
 * other than the one the CLI is pointed at.
 */
export function requireServerBrand(active: ActiveBrand, what: string): void {
  if (active.serverBrandId && active.brand.id !== active.serverBrandId) {
    throw new CliError({
      exit: Exit.ERROR,
      code: "brand_mismatch",
      message: `${what} uses your account's active brand, which is not ${active.brand.name}.`,
      hint: `Switch brands in the web app, or run this with --brand ${active.serverBrandId}.`,
    });
  }
}

function parseType(t: string): QueryType {
  if (!QUERY_TYPES.includes(t as QueryType)) throw usageError(`Unknown query type "${t}".`, `Use one of: ${QUERY_TYPES.join(", ")}`);
  return t as QueryType;
}

async function createSet(
  ctx: Context,
  opts: { platform: string[]; query: string[]; type: string; manual?: boolean },
  name: string,
): Promise<void> {
  const bad = opts.platform.filter((p) => !PLATFORMS.includes(p as Platform));
  if (bad.length) throw usageError(`Unknown platform(s): ${bad.join(", ")}.`, `Use: ${PLATFORMS.join(", ")}`);
  const type = parseType(opts.type);
  // Check before creating: the API has no delete for sets, so a failed query add would leave a dead one.
  if (opts.query.length && !opts.platform.some((p) => runsOn(type, p))) {
    throw usageError(
      `${type} queries don't run on ${opts.platform.join(", ")}.`,
      `llm_prompt runs on AI platforms, search_keyword on ${[...SEARCH_PLATFORMS].join("/")}; universal on both.`,
    );
  }
  const client = await ctx.api();
  requireServerBrand(await activeBrand(ctx, client), "Creating a query set");
  const set = await ctx.call(
    client.POST("/api/v1/monitoring/query-sets", {
      body: { name, platforms: opts.platform as Platform[], ...(opts.manual ? { run_mode: "manual" as const } : {}) },
    }),
  );
  let added: Awaited<ReturnType<typeof addTo>> = [];
  const addTo = () =>
    ctx.call(
      client.POST("/api/v1/monitoring/query-sets/{query_set_id}/queries", {
        params: { path: { query_set_id: set.id } },
        body: opts.query.map((text) => ({ text, query_type: type })),
      }),
    );
  if (opts.query.length) {
    try {
      added = await addTo();
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      throw new CliError({
        exit: e.exit,
        code: e.code,
        status: e.status,
        message: `Created query set ${set.name} (${set.id}), but adding its queries failed: ${e.message}`,
        hint: `Retry with \`topcited monitor queries add ${set.id} …\`.`,
        extra: { query_set_id: set.id },
      });
    }
  }
  ctx.print({ ...set, queries: added }, `Created query set ${set.name} (${set.id}) with ${added.length} quer${added.length === 1 ? "y" : "ies"}.`);
}

async function getDetail(ctx: Context, client: ApiClient, id: string): Promise<QuerySetDetail> {
  return ctx.call(client.GET("/api/v1/monitoring/query-sets/{query_set_id}", { params: { path: { query_set_id: id } } }));
}

async function showSet(ctx: Context, _opts: unknown, ref: string): Promise<void> {
  const client = await ctx.api();
  const detail = await getDetail(ctx, client, (await resolveSet(ctx, client, ref)).id);
  ctx.print(detail, () =>
    [
      fields([
        ["Set", `${detail.name} (${detail.id})`],
        ["Platforms", detail.platforms],
        ["Mode", detail.paused ? `paused (${detail.pause_reason ?? ""})` : `${detail.run_mode}, ${detail.schedule_cron}`],
        ["Last run", detail.last_run_at ? `${when(detail.last_run_at)} ${detail.last_run_status ?? ""}` : "never"],
        ["Next run", when(detail.next_run_at)],
      ]),
      "",
      table(detail.queries ?? [], [
        ["ID", (q) => q.id],
        ["TYPE", (q) => q.query_type],
        ["ACTIVE", (q) => (q.is_active ? "yes" : "no")],
        ["TEXT", (q) => q.text],
      ]),
    ].join("\n"),
  );
}

async function addQueries(ctx: Context, opts: { type: string }, ref: string, texts: string[]): Promise<void> {
  const type = parseType(opts.type);
  const client = await ctx.api();
  const set = await resolveSet(ctx, client, ref);
  const added = await ctx.call(
    client.POST("/api/v1/monitoring/query-sets/{query_set_id}/queries", {
      params: { path: { query_set_id: set.id } },
      body: texts.map((text) => ({ text, query_type: type })),
    }),
  );
  ctx.print(added, `Added ${added.length} quer${added.length === 1 ? "y" : "ies"} to ${set.name}.`);
}

async function removeQueries(ctx: Context, _opts: unknown, ids: string[]): Promise<void> {
  const client = await ctx.api();
  const deleted: string[] = [];
  for (const id of ids) {
    try {
      await ctx.call(client.DELETE("/api/v1/monitoring/queries/{query_id}", { params: { path: { query_id: id } } }));
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      throw new CliError({
        exit: e.exit,
        code: e.code,
        status: e.status,
        message: `Deleting ${id} failed: ${e.message}${deleted.length ? ` (already deleted: ${deleted.join(", ")})` : ""}`,
        hint: e.hint,
        extra: { deleted, failed: id, not_attempted: ids.slice(deleted.length + 1) },
      });
    }
    deleted.push(id);
  }
  ctx.print({ deleted }, `Deleted ${deleted.length} quer${deleted.length === 1 ? "y" : "ies"}.`);
}

/** Does a query of this type produce a run on this platform? (backend `query_runs_on`) */
function runsOn(type: string | undefined, platform: string): boolean {
  if (type === "search_keyword") return SEARCH_PLATFORMS.has(platform);
  if (type === "llm_prompt") return !SEARCH_PLATFORMS.has(platform);
  return true;
}

/** Runs a trigger creates: active queries × platforms they route to (1 T-coin each). */
export function estimateRuns(detail: QuerySetDetail): number {
  const unserved = new Set(detail.runnability?.unserved_platforms ?? []);
  const platforms = detail.platforms.filter((p) => !unserved.has(p));
  let runs = 0;
  for (const q of detail.queries ?? []) {
    if (q.is_active) runs += platforms.filter((p) => runsOn(q.query_type, p)).length;
  }
  return runs;
}

async function runSet(ctx: Context, opts: SpendOptions & WaitOptions, ref: string): Promise<void> {
  const timeout = parseTimeout(opts.timeout);
  const client = await ctx.api();
  const set = await resolveSet(ctx, client, ref);
  const detail = await getDetail(ctx, client, set.id);
  const estimate = estimateRuns(detail);
  const forecast = await ctx.call(client.GET("/api/v1/monitoring/credit-forecast")).catch(() => undefined);
  const proceed = await confirmSpend(ctx, opts, {
    action: `run query set ${set.name} (${estimate} runs)`,
    estimate,
    available: forecast?.available_credits ?? (await availableCoins(ctx, client)),
    details: { query_set_id: set.id, runs: estimate, period_forecast_runs: forecast?.forecast_runs ?? null },
  });
  if (!proceed) return;

  const started = (await ctx.call(
    client.POST("/api/v1/monitoring/query-sets/{query_set_id}/run", { params: { path: { query_set_id: set.id } } }),
  )) as { batch_id: string; runs_created?: number };
  const job = monitorBatchJob(ctx, client, set.id, String(started.batch_id), started.runs_created);
  const base = { query_set_id: set.id, batch_id: started.batch_id, runs_created: started.runs_created ?? null, job: job.ref };
  if (!opts.wait) {
    ctx.print(base, `Started ${started.runs_created ?? "?"} runs for ${set.name} (batch ${started.batch_id}).\nWait with: topcited wait ${job.ref}`);
    return;
  }
  const state = await waitFor(ctx, job, timeout);
  ctx.print({ ...base, status: state.status, ...(state.result as object) }, `${set.name}: ${state.progress}.\nSee results: topcited monitor results --set ${set.id}`);
}

async function results(ctx: Context, opts: { set?: string; since?: string; until?: string }): Promise<void> {
  for (const d of [opts.since, opts.until]) {
    if (d !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw usageError(`Dates must be YYYY-MM-DD, got "${d}".`);
  }
  const client = await ctx.api();
  let sets: QuerySet[];
  if (opts.set) sets = [await resolveSet(ctx, client, opts.set)];
  else {
    const { brand } = await activeBrand(ctx, client);
    sets = (await allSets(ctx, client)).filter((s) => s.brand_id === brand.id);
    if (!sets.length) {
      throw new CliError({ exit: Exit.NOT_FOUND, code: "no_query_sets", message: `${brand.name} has no query sets.`, hint: "Create one with `topcited monitor sets create`." });
    }
  }
  const window = { ...(opts.since ? { from: opts.since } : {}), ...(opts.until ? { to: opts.until } : {}) };
  const summary = await ctx.call(
    client.GET("/api/v1/monitoring/metrics/summary", { params: { query: { query_set_ids: sets.map((s) => s.id).join(","), ...window } } }),
  );
  const perSet = await Promise.all(
    sets.map(async (s) => {
      const q = { params: { query: { query_set_id: s.id } } };
      const [gaps, sov] = await Promise.all([
        ctx.call(client.GET("/api/v1/monitoring/gaps", q)),
        ctx.call(client.GET("/api/v1/monitoring/share-of-voice", q)),
      ]);
      return { id: s.id, name: s.name, gaps, share_of_voice: sov.entries };
    }),
  );
  const data = { window: summary.window, summary: summary.rows, sets: perSet };
  ctx.print(data, () => {
    const w = summary.window as { since?: string; until?: string } | undefined;
    const out = [
      `Visibility ${w ? `${day(w.since)} → ${day(w.until)}` : ""}`,
      table(summary.rows, [
        ["BRAND", (r) => `${r.brand_name}${r.is_customer_brand ? " (you)" : ""}`],
        ["MENTION RATE", (r) => pct(r.mention_rate)],
        ["SHARE OF VOICE", (r) => pct(r.avg_share_of_voice)],
        ["AVG RANK", (r) => (r.avg_rank === null || r.avg_rank === undefined ? "-" : Number(r.avg_rank).toFixed(1))],
        ["CHECKS", (r) => r.total_checks],
      ]),
    ];
    for (const s of perSet) {
      out.push("", `Gaps in ${s.name} (competitors mentioned, you not): ${s.gaps.length}`);
      for (const g of s.gaps.slice(0, 10)) out.push(`  - ${g.query_text}  [${(g.competitors_mentioned ?? []).join(", ")}]`);
      if (s.gaps.length > 10) out.push(`  … ${s.gaps.length - 10} more (--json for all)`);
    }
    return out.join("\n");
  });
}

/** The API reports rates as 0–1 ratios. */
function pct(v: unknown): string {
  return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "-";
}
