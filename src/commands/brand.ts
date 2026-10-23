import type { Command } from "commander";
import { activeBrand, matchBrand } from "../brand";
import type { Context } from "../context";
import { CliError, Exit } from "../errors";
import { day, fields, table } from "../format";
import type { Action } from "./types";

export function registerBrand(program: Command, action: Action): void {
  const brand = program.command("brand").description("List brands and pick the one commands act on");

  brand
    .command("list")
    .description("List your brands (* marks the active one)")
    .addHelpText("after", "\nExample:\n  $ topcited brand list --json")
    .action(action(list));

  brand
    .command("use")
    .description("Set the active brand for this host (stored in config.json)")
    .argument("<brand>", "brand id, id prefix, or name")
    .addHelpText("after", '\nExample:\n  $ topcited brand use "Marlow Payroll"')
    .action(action(use));

  brand
    .command("show")
    .description("Show a brand with its competitors and query sets")
    .argument("[brand]", "brand id, id prefix, or name (default: active brand)")
    .addHelpText("after", "\nExample:\n  $ topcited brand show")
    .action(action(show));
}

async function list(ctx: Context): Promise<void> {
  const client = await ctx.api();
  const brands = await ctx.call(client.GET("/api/v1/brands"));
  let activeId: string | undefined;
  try {
    activeId = (await activeBrand(ctx, client)).brand.id;
  } catch {
    // no unambiguous active brand: show none starred
  }
  const rows = brands.map((b) => ({ ...b, active: b.id === activeId }));
  ctx.print(rows, () =>
    table(rows, [
      ["", (b) => (b.active ? "*" : " ")],
      ["ID", (b) => b.id],
      ["NAME", (b) => b.name],
      ["DOMAIN", (b) => b.website_domain],
      ["CREATED", (b) => day(b.created_at)],
    ]),
  );
}

async function use(ctx: Context, _opts: unknown, ref: string): Promise<void> {
  const client = await ctx.api();
  const brands = await ctx.call(client.GET("/api/v1/brands"));
  const brand = matchBrand(brands, ref);
  if (!brand) {
    throw new CliError({
      exit: Exit.NOT_FOUND,
      code: "brand_not_found",
      message: `No brand matches "${ref}".`,
      hint: `Your brands: ${brands.map((b) => b.name).join(", ") || "(none)"}.`,
    });
  }
  await ctx.rt.store.setHost(ctx.baseUrl, { brand_id: brand.id, brand_name: brand.name });
  ctx.print({ active_brand: brand, base_url: ctx.baseUrl }, `Active brand: ${brand.name} (${brand.id})`);
}

async function show(ctx: Context, _opts: unknown, ref?: string): Promise<void> {
  const client = await ctx.api();
  const { brand, source, serverBrandId } = await activeBrand(ctx, client, ref);
  const [competitors, sets] = await Promise.all([
    ctx.call(client.GET("/api/v1/brands/{brand_id}/competitors", { params: { path: { brand_id: brand.id } } })),
    ctx.call(client.GET("/api/v1/monitoring/query-sets", { params: { query: { limit: 100 } } })),
  ]);
  const brandSets = sets.filter((s) => s.brand_id === brand.id);
  const data = {
    ...brand,
    source,
    is_server_active: brand.id === serverBrandId,
    competitors: competitors.map((c) => ({ id: c.id, name: c.name, website: c.website })),
    query_sets: brandSets.map((s) => ({ id: s.id, name: s.name, queries: s.active_query_count ?? null, platforms: s.platforms })),
  };
  ctx.print(data, () =>
    [
      fields([
        ["Brand", `${brand.name} (${brand.id})`],
        ["Website", brand.website_url],
        ["Competitors", competitors.map((c) => c.name).join(", ") || "-"],
      ]),
      "",
      "Query sets:",
      table(data.query_sets, [
        ["ID", (s) => s.id],
        ["NAME", (s) => s.name],
        ["QUERIES", (s) => s.queries],
        ["PLATFORMS", (s) => s.platforms],
      ]),
    ].join("\n"),
  );
}
