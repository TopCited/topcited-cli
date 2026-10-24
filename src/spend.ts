import type { Command } from "commander";
import type { ApiClient } from "./client";
import type { Context } from "./context";
import { CliError, Exit } from "./errors";

export interface SpendOptions {
  yes?: boolean;
  dryRun?: boolean;
}

/** Adds `--dry-run` and `--yes` to a command that spends T-coins. */
export function withSpendOptions(cmd: Command): Command {
  return cmd
    .option("--dry-run", "print the T-coin estimate and exit without spending")
    .option("-y, --yes", "don't ask for confirmation before spending");
}

export interface SpendPlan {
  /** What will happen, e.g. "run query set Core (12 queries × 2 platforms)". */
  action: string;
  /** Estimated T-coins, or null when the API exposes no estimate for this feature. */
  estimate: number | null;
  available: number | null;
  details?: Record<string, unknown>;
}

/** Current spendable balance, or null if it can't be read. */
export async function availableCoins(ctx: Context, client: ApiClient): Promise<number | null> {
  try {
    const b = await ctx.call(client.GET("/api/v1/users/me/coin-balance"));
    return b.total_available ?? b.bundle_balance;
  } catch {
    return null;
  }
}

/**
 * Gate before a spending call. Returns false on --dry-run (after printing the
 * estimate); the caller then exits 0. With a TTY it asks, unless --yes; without
 * a TTY it never prompts (D4) and proceeds.
 */
export async function confirmSpend(ctx: Context, opts: SpendOptions, plan: SpendPlan): Promise<boolean> {
  const exceeds = plan.estimate !== null && plan.available !== null ? plan.estimate > plan.available : null;
  const cost = plan.estimate === null ? "an amount of T-coins the API doesn't estimate" : `~${plan.estimate} T-coins`;
  const balance = plan.available === null ? "" : ` (you have ${plan.available})`;
  if (opts.dryRun) {
    ctx.print(
      { dry_run: true, action: plan.action, estimate_tcoins: plan.estimate, available_tcoins: plan.available, exceeds, ...plan.details },
      `Dry run: would ${plan.action}, spending ${cost}${balance}.${exceeds ? " That exceeds your balance." : ""}`,
    );
    return false;
  }
  if (opts.yes || !ctx.interactive) return true;
  const answer = await ctx.rt.prompt(`This will ${plan.action}, spending ${cost}${balance}. Continue? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError({ exit: Exit.ERROR, code: "cancelled", message: "Cancelled; nothing was spent." });
  }
  return true;
}
