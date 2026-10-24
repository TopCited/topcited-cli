import type { Command } from "commander";
import { activeBrand } from "../brand";
import type { ApiClient } from "../client";
import type { Context } from "../context";
import { usageError } from "../errors";
import { table } from "../format";
import { RECOMMEND_KINDS, recommendJob, type RecommendKind } from "../jobs";
import { availableCoins, confirmSpend, withSpendOptions, type SpendOptions } from "../spend";
import { parseTimeout, waitFor, withWaitOptions, type WaitOptions } from "../wait";
import type { Action } from "./types";

const ABOUT: Record<RecommendKind, string> = {
  keywords: "keywords worth targeting",
  prompts: "prompts to track in monitoring",
  content: "content sentences that get brands cited",
};

export function registerRecommend(program: Command, action: Action): void {
  withWaitOptions(
    withSpendOptions(
      program
        .command("recommend")
        .description("Generate recommendations for the active brand (spends T-coins), or --list the latest")
        .argument("[kind]", `${RECOMMEND_KINDS.join(" | ")}`, "prompts")
        .option("--topic <topic>", "focus prompts/content on a topic (default: competitor-driven)")
        .option("--list", "show the latest recommendations without generating new ones"),
    ),
  )
    .addHelpText(
      "after",
      `
Kinds: ${RECOMMEND_KINDS.map((k) => `${k} (${ABOUT[k]})`).join(", ")}.

Examples:
  $ topcited recommend prompts --wait --yes
  $ topcited recommend content --topic "payroll compliance" --wait
  $ topcited recommend keywords --list --json`,
    )
    .action(action(recommend));
}

interface RecommendOptions extends SpendOptions, WaitOptions {
  topic?: string;
  list?: boolean;
}

async function recommend(ctx: Context, opts: RecommendOptions, kindArg: string): Promise<void> {
  if (!RECOMMEND_KINDS.includes(kindArg as RecommendKind)) {
    throw usageError(`Unknown kind "${kindArg}".`, `Use one of: ${RECOMMEND_KINDS.join(", ")}`);
  }
  const kind = kindArg as RecommendKind;
  if (opts.topic && kind === "keywords") throw usageError("--topic applies to prompts and content, not keywords.");
  const timeout = parseTimeout(opts.timeout);
  const client = await ctx.api();
  const { brand } = await activeBrand(ctx, client);
  if (opts.list) return printRecommendations(ctx, client, kind, brand.id);

  const proceed = await confirmSpend(ctx, opts, {
    action: `generate ${kind} recommendations for ${brand.name}`,
    estimate: null,
    available: await availableCoins(ctx, client),
    details: { brand_id: brand.id, kind },
  });
  if (!proceed) return;

  const path = { params: { path: { brand_id: brand.id } } };
  const body = opts.topic ? { mode: "topic", topic: opts.topic } : { mode: "competitor" };
  const run =
    kind === "keywords"
      ? await ctx.call(client.POST("/api/v1/brands/{brand_id}/keywords:recommend", path))
      : kind === "prompts"
        ? await ctx.call(client.POST("/api/v1/brands/{brand_id}/prompts:recommend", { ...path, body }))
        : await ctx.call(client.POST("/api/v1/brands/{brand_id}/content-sentences:recommend", { ...path, body }));
  const job = recommendJob(ctx, client, kind, brand.id, run.id);
  if (!opts.wait) {
    ctx.print({ brand_id: brand.id, kind, run, job: job.ref }, `Started ${kind} recommendations (${run.id}).\nWait with: topcited wait ${job.ref}`);
    return;
  }
  await waitFor(ctx, job, timeout);
  await printRecommendations(ctx, client, kind, brand.id);
}

export async function printRecommendations(ctx: Context, client: ApiClient, kind: RecommendKind, brandId: string): Promise<void> {
  const path = { params: { path: { brand_id: brandId } } };
  const rows: { text: string; score?: number | null; rationale?: string | null }[] =
    kind === "keywords"
      ? (await ctx.call(client.GET("/api/v1/brands/{brand_id}/keywords", path))).recommendations
      : kind === "prompts"
        ? (await ctx.call(client.GET("/api/v1/brands/{brand_id}/prompts", path))).recommendations
        : (await ctx.call(client.GET("/api/v1/brands/{brand_id}/content-sentences", path))).recommendations;
  ctx.print({ brand_id: brandId, kind, recommendations: rows }, () =>
    table(rows, [
      ["SCORE", (r) => (typeof r.score === "number" ? r.score.toFixed(2) : "-")],
      ["TEXT", (r) => r.text],
    ]),
  );
}
