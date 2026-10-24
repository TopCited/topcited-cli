import type { Command } from "commander";
import { activeBrand } from "../brand";
import type { Context } from "../context";
import { table } from "../format";
import type { Action } from "./types";

export function registerCompetitors(program: Command, action: Action): void {
  const competitors = program.command("competitors").description("The active brand's tracked competitors");

  competitors
    .command("list")
    .description("List competitors")
    .addHelpText("after", "\nExample:\n  $ topcited competitors list --json")
    .action(action(list));

  competitors
    .command("add")
    .description("Add a competitor")
    .argument("<name>", "competitor name")
    .option("-w, --website <url>", "competitor website")
    .option("-a, --alias <alias>", "another name AI answers use for it; repeatable", (v: string, p: string[]) => [...p, v], [])
    .option("-d, --description <text>", "short description")
    .addHelpText("after", '\nExample:\n  $ topcited competitors add Gusto -w gusto.com -a "Gusto Payroll"')
    .action(action(add));
}

async function list(ctx: Context): Promise<void> {
  const client = await ctx.api();
  const { brand } = await activeBrand(ctx, client);
  const rows = await ctx.call(client.GET("/api/v1/brands/{brand_id}/competitors", { params: { path: { brand_id: brand.id } } }));
  ctx.print(rows, () =>
    table(rows, [
      ["ID", (c) => c.id],
      ["NAME", (c) => c.name],
      ["WEBSITE", (c) => c.website],
      ["ALIASES", (c) => c.aliases],
    ]),
  );
}

async function add(ctx: Context, opts: { website?: string; alias: string[]; description?: string }, name: string): Promise<void> {
  const client = await ctx.api();
  const { brand } = await activeBrand(ctx, client);
  const created = await ctx.call(
    client.POST("/api/v1/brands/{brand_id}/competitors", {
      params: { path: { brand_id: brand.id } },
      body: { name, website: opts.website ?? null, description: opts.description ?? null, aliases: opts.alias },
    }),
  );
  ctx.print(created, `Added competitor ${created.name} (${created.id}) to ${brand.name}.`);
}
