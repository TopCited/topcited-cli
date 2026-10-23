import type { Command } from "commander";
import { activeBrand } from "../brand";
import type { Context } from "../context";
import { usageError } from "../errors";
import { fields, table, when } from "../format";
import type { components } from "../generated/schema";
import { reportJob } from "../jobs";
import { availableCoins, confirmSpend, withSpendOptions, type SpendOptions } from "../spend";
import { parseTimeout, waitFor, withWaitOptions, type WaitOptions } from "../wait";
import { userAgent } from "../version";
import { requireServerBrand } from "./monitor";
import type { Action } from "./types";

type ReportType = components["schemas"]["ReportType"];
const TYPES: ReportType[] = ["geo_audit", "client_report"];

export function registerReport(program: Command, action: Action): void {
  const report = program.command("report").description("Generate and fetch reports");

  withWaitOptions(
    withSpendOptions(
      report
        .command("generate")
        .description("Generate a report for the account's active brand (spends T-coins)")
        .option("-t, --type <type>", `report type (${TYPES.join(", ")})`, "geo_audit")
        .option("-P, --param <key=value>", "report parameter; repeatable", (v: string, p: string[]) => [...p, v], []),
    ),
  )
    .addHelpText("after", "\nExamples:\n  $ topcited report generate --dry-run\n  $ topcited report generate --wait --yes --json")
    .action(action(generate));

  report
    .command("list")
    .description("List reports")
    .addHelpText("after", "\nExample:\n  $ topcited report list")
    .action(action(list));

  report
    .command("show")
    .description("Show a report")
    .argument("<id>", "report id")
    .addHelpText("after", "\nExample:\n  $ topcited report show 5d0c… --json")
    .action(action(show));

  report
    .command("download")
    .description("Download a report as HTML or PDF")
    .argument("<id>", "report id")
    .option("--format <format>", "html or pdf", "pdf")
    .option("-o, --output <file>", "where to write it (default: report-<id>.<format>)")
    .addHelpText("after", "\nExample:\n  $ topcited report download 5d0c… --format html -o report.html")
    .action(action(download));
}

async function generate(ctx: Context, opts: SpendOptions & WaitOptions & { type: string; param: string[] }): Promise<void> {
  if (!TYPES.includes(opts.type as ReportType)) throw usageError(`Unknown report type "${opts.type}".`, `Use one of: ${TYPES.join(", ")}`);
  const params = Object.fromEntries(
    opts.param.map((p) => {
      const i = p.indexOf("=");
      if (i <= 0) throw usageError(`Bad --param "${p}"; expected key=value.`);
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const timeout = parseTimeout(opts.timeout);
  const client = await ctx.api();
  const active = await activeBrand(ctx, client);
  requireServerBrand(active, "Report generation");
  const proceed = await confirmSpend(ctx, opts, {
    action: `generate a ${opts.type} report for ${active.brand.name}`,
    estimate: null,
    available: await availableCoins(ctx, client),
    details: { report_type: opts.type, brand_id: active.brand.id },
  });
  if (!proceed) return;

  const created = await ctx.call(
    client.POST("/api/v1/reports/generate", { body: { report_type: opts.type as ReportType, ...(opts.param.length ? { params } : {}) } }),
  );
  const job = reportJob(ctx, client, created.id);
  if (!opts.wait) {
    ctx.print({ report: created, job: job.ref }, `Report ${created.id} is ${created.status}.\nWait with: topcited wait ${job.ref}`);
    return;
  }
  const state = await waitFor(ctx, job, timeout);
  ctx.print({ report: state.result, job: job.ref }, `Report ${created.id} is ${state.status}.\nDownload: topcited report download ${created.id}`);
}

async function list(ctx: Context): Promise<void> {
  const client = await ctx.api();
  const rows = await ctx.call(client.GET("/api/v1/reports/", { params: { query: { limit: 100 } } }));
  ctx.print(rows, () =>
    table(rows, [
      ["ID", (r) => r.id],
      ["TYPE", (r) => r.report_type],
      ["STATUS", (r) => r.status],
      ["CREATED", (r) => when(r.created_at)],
    ]),
  );
}

async function show(ctx: Context, _opts: unknown, id: string): Promise<void> {
  const client = await ctx.api();
  const r = await ctx.call(client.GET("/api/v1/reports/{report_id}", { params: { path: { report_id: id } } }));
  ctx.print(r, () =>
    fields([
      ["Report", r.id],
      ["Type", r.report_type],
      ["Status", r.status],
      ["Generated", when(r.generated_at)],
      ["Brand", r.brand_id],
    ]),
  );
}

async function download(ctx: Context, opts: { format: string; output?: string }, id: string): Promise<void> {
  if (opts.format !== "html" && opts.format !== "pdf") throw usageError(`--format must be html or pdf.`);
  const cred = await ctx.credential();
  await ctx.api();
  // Binary body: go around the JSON client.
  const res = await ctx.rt.fetch(`${ctx.baseUrl}/api/v1/reports/${encodeURIComponent(id)}/download/${opts.format}`, {
    headers: { Authorization: `Bearer ${cred!.apiKey}`, "User-Agent": userAgent() },
  });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    throw await ctx.httpError({ status: res.status, ok: false, headers: res.headers, body });
  }
  const out = opts.output ?? `report-${id}.${opts.format}`;
  const bytes = await Bun.write(out, await res.arrayBuffer());
  ctx.print({ report_id: id, format: opts.format, path: out, bytes }, `Wrote ${out} (${bytes} bytes).`);
}

