import type { ApiClient } from "./client";
import type { Context } from "./context";
import { CliError, Exit, usageError } from "./errors";
import type { components } from "./generated/schema";

export type Brand = components["schemas"]["BrandResponse"];

/** Match a brand by exact id, id prefix (6+ chars), or case-insensitive name. */
export function matchBrand(brands: Brand[], ref: string): Brand | undefined {
  const r = ref.trim().toLowerCase();
  return (
    brands.find((b) => b.id === r) ??
    brands.find((b) => b.name.toLowerCase() === r) ??
    (r.length >= 6 ? onlyOne(brands.filter((b) => b.id.startsWith(r))) : undefined)
  );
}

function onlyOne<T>(xs: T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined;
}

export interface ActiveBrand {
  brand: Brand;
  /** Where the choice came from, for `brand list` / `doctor`. */
  source: "flag" | "config" | "server" | "only";
  /** The server's own active brand (it scopes query-set creation and reports). */
  serverBrandId: string | null;
}

/**
 * The brand a command acts on: --brand / TOPCITED_BRAND, then `brand use`
 * (config.json, per host), then the account's active brand on the server,
 * then the only brand if there is exactly one.
 */
export async function activeBrand(ctx: Context, client: ApiClient, explicit?: string): Promise<ActiveBrand> {
  const [brands, me] = await Promise.all([
    ctx.call(client.GET("/api/v1/brands")),
    ctx.call(client.GET("/api/v1/users/me")),
  ]);
  const serverBrandId = me.active_brand_id ?? null;
  if (!brands.length) {
    throw new CliError({
      exit: Exit.NOT_FOUND,
      code: "no_brands",
      message: "This account has no brands yet.",
      hint: `Create one at ${ctx.uiUrl}.`,
    });
  }
  const flagRef = explicit ?? ctx.brandRef;
  const configRef = (await ctx.rt.store.getHost(ctx.baseUrl)).brand_id;
  const pick = (ref: string, source: ActiveBrand["source"]): ActiveBrand => {
    const brand = matchBrand(brands, ref);
    if (!brand) {
      throw new CliError({
        exit: Exit.NOT_FOUND,
        code: "brand_not_found",
        message: `No brand matches "${ref}".`,
        hint: `Your brands: ${brands.map((b) => b.name).join(", ")}. See \`topcited brand list\`.`,
      });
    }
    return { brand, source, serverBrandId };
  };
  if (flagRef) return pick(flagRef, "flag");
  if (configRef && matchBrand(brands, configRef)) return pick(configRef, "config");
  if (serverBrandId && matchBrand(brands, serverBrandId)) return pick(serverBrandId, "server");
  if (brands.length === 1) return { brand: brands[0]!, source: "only", serverBrandId };
  throw usageError("You have several brands and none is selected.", "Pass --brand <id|name>, or run `topcited brand use <id|name>`.");
}
