import type { Command } from "commander";
import type { ApiClient } from "../client";
import type { Context } from "../context";
import { CliError, Exit, usageError } from "../errors";
import { fields, table, when } from "../format";
import type { components } from "../generated/schema";
import { auditJob } from "../jobs";
import { pageAll } from "../paginate";
import { availableCoins, confirmSpend, withSpendOptions, type SpendOptions } from "../spend";
import { parseTimeout, waitFor, withWaitOptions, type WaitOptions } from "../wait";
import type { Action } from "./types";

type Site = components["schemas"]["SiteResponse"];
type AuditRun = components["schemas"]["SeoAuditRunResponse"];

export function registerAudit(program: Command, action: Action): void {
  const audit = program.command("audit").description("Technical SEO / AI-crawler site audits");

  withWaitOptions(
    withSpendOptions(
      audit
        .command("run")
        .description("Audit a site (registers it on first use; spends T-coins)")
        .argument("<url>", "site URL or domain, e.g. https://example.com"),
    ),
  )
    .addHelpText("after", "\nExamples:\n  $ topcited audit run example.com --dry-run\n  $ topcited audit run https://example.com --wait --yes")
    .action(action(run));

  audit
    .command("show")
    .description("Show an audit run's summary and issues")
    .argument("<run-id>", "audit run id")
    .option("--site <site>", "site id or domain (faster: skips searching your sites)")
    .addHelpText("after", "\nExample:\n  $ topcited audit show 7c1e… --json")
    .action(action(show));

  audit
    .command("list")
    .description("List audit runs")
    .option("--site <site>", "only this site (id or domain)")
    .addHelpText("after", "\nExample:\n  $ topcited audit list --site example.com")
    .action(action(list));
}

export function domainOf(input: string): string {
  const raw = input.trim();
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    if (!host.includes(".")) throw new Error();
    return host.replace(/^www\./, "");
  } catch {
    throw usageError(`"${input}" is not a URL or domain.`);
  }
}

function sites(ctx: Context, client: ApiClient): Promise<Site[]> {
  return pageAll((skip, limit) => ctx.call(client.GET("/api/v1/seo/sites", { params: { query: { skip, limit } } })));
}

function auditRuns(ctx: Context, client: ApiClient, siteId: string): Promise<AuditRun[]> {
  return pageAll((skip, limit) =>
    ctx.call(client.GET("/api/v1/seo/sites/{site_id}/audit-runs", { params: { path: { site_id: siteId }, query: { skip, limit } } })),
  );
}

function findSite(all: Site[], ref: string): Site | undefined {
  const r = ref.trim().toLowerCase();
  const byId = all.find((s) => s.id === r);
  if (byId) return byId;
  let domain: string;
  try {
    domain = domainOf(ref);
  } catch {
    return undefined;
  }
  return all.find((s) => s.domain.toLowerCase().replace(/^www\./, "") === domain);
}

async function run(ctx: Context, opts: SpendOptions & WaitOptions, url: string): Promise<void> {
  const timeout = parseTimeout(opts.timeout);
  const domain = domainOf(url);
  const client = await ctx.api();
  const existing = findSite(await sites(ctx, client), domain);
  const proceed = await confirmSpend(ctx, opts, {
    action: `audit ${domain}${existing ? "" : " (and register it as a site)"}`,
    estimate: null,
    available: await availableCoins(ctx, client),
    details: { domain, site_id: existing?.id ?? null },
  });
  if (!proceed) return;

  const site = existing ?? (await ctx.call(client.POST("/api/v1/seo/sites", { body: { domain } })));
  const started = await ctx.call(
    client.POST("/api/v1/seo/sites/{site_id}/audit-runs", { params: { path: { site_id: site.id } } }),
  );
  const job = auditJob(ctx, client, site.id, started.id);
  if (!opts.wait) {
    ctx.print({ site_id: site.id, domain: site.domain, run: started, job: job.ref }, `Started audit ${started.id} for ${site.domain}.\nWait with: topcited wait ${job.ref}`);
    return;
  }
  await waitFor(ctx, job, timeout);
  await printRun(ctx, client, site, started.id);
}

async function show(ctx: Context, opts: { site?: string }, runId: string): Promise<void> {
  const client = await ctx.api();
  const all = await sites(ctx, client);
  if (opts.site) {
    const site = findSite(all, opts.site);
    if (!site) throw new CliError({ exit: Exit.NOT_FOUND, code: "site_not_found", message: `No site matches "${opts.site}".` });
    return printRun(ctx, client, site, runId);
  }
  for (const site of all) {
    if ((await auditRuns(ctx, client, site.id)).some((r) => r.id === runId)) return printRun(ctx, client, site, runId);
  }
  throw new CliError({ exit: Exit.NOT_FOUND, code: "audit_not_found", message: `No audit run ${runId} on your sites.` });
}

async function printRun(ctx: Context, client: ApiClient, site: Site, runId: string): Promise<void> {
  const path = { site_id: site.id, run_id: runId };
  const [runRow, issues] = await Promise.all([
    ctx.call(client.GET("/api/v1/seo/sites/{site_id}/audit-runs/{run_id}", { params: { path } })),
    pageAll(
      (skip, limit) => ctx.call(client.GET("/api/v1/seo/sites/{site_id}/audit-runs/{run_id}/issues", { params: { path, query: { skip, limit } } })),
      500,
    ),
  ]);
  ctx.print({ site_id: site.id, domain: site.domain, run: runRow, issues }, () =>
    [
      fields([
        ["Site", site.domain],
        ["Run", `${runRow.id} (${runRow.status})`],
        ["Finished", when(runRow.completed_at)],
        ["Summary", runRow.summary_json ? summarize(runRow) : "-"],
      ]),
      "",
      table(issues, [
        ["SEVERITY", (i) => i.severity],
        ["ISSUE", (i) => i.issue_type],
        ["RECOMMENDATION", (i) => truncate(String(i.recommendation ?? ""), 90)],
      ]),
    ].join("\n"),
  );
}

function summarize(run: AuditRun): string {
  const s = run.summary_json as Record<string, unknown>;
  return Object.entries(s)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function list(ctx: Context, opts: { site?: string }): Promise<void> {
  const client = await ctx.api();
  let all = await sites(ctx, client);
  if (opts.site) {
    const site = findSite(all, opts.site);
    if (!site) throw new CliError({ exit: Exit.NOT_FOUND, code: "site_not_found", message: `No site matches "${opts.site}".` });
    all = [site];
  }
  const rows = (
    await Promise.all(
      all.map(async (site) =>
        (await auditRuns(ctx, client, site.id)).map((r) => ({
          ...r,
          domain: site.domain,
        })),
      ),
    )
  ).flat();
  ctx.print(rows, () =>
    table(rows, [
      ["RUN", (r) => r.id],
      ["SITE", (r) => r.domain],
      ["STATUS", (r) => r.status],
      ["CREATED", (r) => when(r.created_at)],
    ]),
  );
}
