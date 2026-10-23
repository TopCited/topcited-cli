import { stat } from "node:fs/promises";
import type { Command } from "commander";
import { activeBrand } from "../brand";
import { keyPrefix } from "../config";
import type { Context } from "../context";
import { CliError, Exit } from "../errors";
import { OPERATIONS } from "../generated/operations";
import { compareVersions, latestRelease } from "../release";
import { VERSION } from "../version";
import type { Action } from "./types";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

export function registerDoctor(program: Command, action: Action): void {
  program
    .command("doctor")
    .description("Check config, sign-in, API reachability and version skew")
    .addHelpText("after", "\nExample:\n  $ topcited doctor --json")
    .action(action(doctor));
}

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

async function doctor(ctx: Context): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });

  // CLI version
  const latest = await latestRelease(ctx.rt);
  if (!latest) add("version", "warn", `topcited ${VERSION} (couldn't check for releases)`);
  else if (compareVersions(latest.version, VERSION) > 0) add("version", "warn", `topcited ${VERSION}; ${latest.version} is available: run \`topcited upgrade\``);
  else add("version", "ok", `topcited ${VERSION} (latest)`);

  // Config files
  const credPath = ctx.rt.store.credentialsPath;
  const mode = await stat(credPath).then((s) => s.mode & 0o777, () => undefined);
  if (mode !== undefined && mode & 0o077) add("config", "warn", `${credPath} is mode ${mode.toString(8)}; run chmod 600 on it`);
  else add("config", "ok", ctx.rt.store.dir);

  // API reachability + version skew against the server's public contract
  add("base_url", "ok", `${ctx.baseUrl} (from ${ctx.baseUrlSource})`);
  const spec = await ctx.request("GET", "/api/v1/openapi.public.json").catch((e: CliError) => e);
  if (spec instanceof CliError) add("api", "fail", spec.message);
  else if (!spec.ok) add("api", "warn", `reachable, but ${ctx.baseUrl}/api/v1/openapi.public.json returned ${spec.status}`);
  else add("api", ...skew(spec.body as { paths?: Record<string, Record<string, { operationId?: string }>> }));

  // Credential
  const cred = await ctx.credential();
  if (!cred) add("auth", "fail", "not logged in: run `topcited auth login` or set TOPCITED_API_KEY");
  else {
    try {
      const client = await ctx.api();
      const me = await ctx.call(client.GET("/api/v1/users/me"));
      const days = ctx.daysLeft(cred);
      const expiry = days === undefined ? "" : `, expires in ${Math.floor(days)} days`;
      // The prefix only: doctor output gets pasted into issues and agent transcripts.
      add("auth", days !== undefined && days < 14 ? "warn" : "ok", `${me.email} via ${keyPrefix(cred.apiKey)}… (${cred.source}${expiry})`);
      try {
        const { brand, source } = await activeBrand(ctx, client);
        add("brand", "ok", `${brand.name} (${source})`);
      } catch (e) {
        add("brand", "warn", e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      add("auth", "fail", e instanceof CliError ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : String(e));
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  ctx.print({ ok, checks }, () => checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(9)} ${c.detail}`).join("\n"));
  if (!ok) throw new CliError({ exit: Exit.ERROR, code: "doctor_failed", message: "Some checks failed.", extra: { checks: checks.filter((c) => c.status === "fail").map((c) => c.name) } });
}

/** Compare the operations this CLI was built against with what the server publishes. */
function skew(spec: { paths?: Record<string, Record<string, { operationId?: string }>> }): [Status, string] {
  const served = new Set<string>();
  for (const item of Object.values(spec.paths ?? {})) for (const op of Object.values(item)) if (op?.operationId) served.add(op.operationId);
  const known = new Set(OPERATIONS.map(([, , id]) => id));
  const missing = [...known].filter((id) => !served.has(id));
  const newer = [...served].filter((id) => !known.has(id));
  if (missing.length) return ["warn", `server lacks ${missing.length} operation(s) this CLI uses (${missing.slice(0, 3).join(", ")}…): it may be older than the CLI`];
  if (newer.length) return ["ok", `reachable; server has ${newer.length} operation(s) newer than this CLI (\`topcited upgrade\` when released)`];
  return ["ok", "reachable; contract matches this CLI"];
}
