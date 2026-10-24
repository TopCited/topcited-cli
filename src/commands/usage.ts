import type { Command } from "commander";
import type { Context } from "../context";
import { fields, table, when } from "../format";
import type { Action } from "./types";

export function registerUsage(program: Command, action: Action): void {
  program
    .command("usage")
    .description("Plan, T-coin balance, plan quotas, and this period's monitoring forecast")
    .addHelpText("after", "\nExample:\n  $ topcited usage --json")
    .action(action(usage));
}

async function usage(ctx: Context): Promise<void> {
  const client = await ctx.api();
  const [me, coins, quotas, forecast] = await Promise.all([
    ctx.call(client.GET("/api/v1/users/me")),
    ctx.call(client.GET("/api/v1/users/me/coin-balance")),
    ctx.call(client.GET("/api/v1/users/me/usage")),
    ctx.call(client.GET("/api/v1/monitoring/credit-forecast")),
  ]);
  const data = { plan_id: me.plan_id, coins, quotas, monitoring_forecast: forecast };
  ctx.print(data, () =>
    [
      fields([
        ["Plan", me.plan_id],
        ["T-coins", `${coins.total_available ?? coins.bundle_balance} available`],
        ["  plan", coins.plan_allowance !== undefined ? `${coins.plan_used ?? 0} of ${coins.plan_allowance} used` : "-"],
        ["  bundle/bonus", `${coins.bundle_balance} / ${coins.bonus_balance ?? 0}`],
        [
          "Forecast",
          `${forecast.forecast_runs} monitoring runs this period vs ${forecast.available_credits} available` +
            (forecast.exceeds ? "  ← exceeds balance" : ""),
        ],
      ]),
      "",
      table(quotas, [
        ["FEATURE", (q) => q.feature],
        ["USED", (q) => q.used],
        ["LIMIT", (q) => (q.limit < 0 ? "unlimited" : q.limit)],
        ["RESETS", (q) => (q.reset_at ? when(q.reset_at) : q.reset_period)],
      ]),
    ].join("\n"),
  );
}
