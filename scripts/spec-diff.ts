// Deterministic summary of what changed between two public OpenAPI snapshots.
// Used as the body of the spec-sync PR (.github/workflows/spec-sync.yml).
//
//   bun run scripts/spec-diff.ts <old.json> <new.json> [--image-tag T] [--previous-tag P] [--source URL]
//   bun run scripts/spec-diff.ts <old.json> <new.json> --exit-code   # like `git diff --exit-code`: 1 if changed
//
// Prints Markdown on stdout and exits 0 ("no changes" is a valid summary),
// unless --exit-code.

type Operation = Record<string, unknown> & { operationId?: string };
interface Spec {
  info?: { version?: string };
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
}

const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

export interface OpRef {
  method: string;
  path: string;
  operationId: string;
}

export interface SpecDiff {
  added: OpRef[];
  removed: OpRef[];
  changed: OpRef[];
  schemasAdded: string[];
  schemasRemoved: string[];
  schemasChanged: string[];
  versionFrom?: string;
  versionTo?: string;
}

/** JSON with sorted object keys, so key order never reads as a change. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function operations(spec: Spec): Map<string, { ref: OpRef; body: string }> {
  const out = new Map<string, { ref: OpRef; body: string }>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      const ref = { method: method.toUpperCase(), path, operationId: op.operationId ?? "" };
      out.set(`${ref.method} ${path}`, { ref, body: canonical(op) });
    }
  }
  return out;
}

const byKey = (a: OpRef, b: OpRef) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method);

export function diffSpecs(oldSpec: Spec, newSpec: Spec): SpecDiff {
  const before = operations(oldSpec);
  const after = operations(newSpec);
  const added: OpRef[] = [];
  const removed: OpRef[] = [];
  const changed: OpRef[] = [];
  for (const [k, v] of after) {
    const prev = before.get(k);
    if (!prev) added.push(v.ref);
    else if (prev.body !== v.body) changed.push(v.ref);
  }
  for (const [k, v] of before) if (!after.has(k)) removed.push(v.ref);

  const oldSchemas = oldSpec.components?.schemas ?? {};
  const newSchemas = newSpec.components?.schemas ?? {};
  const names = (o: object) => Object.keys(o).sort();
  return {
    added: added.sort(byKey),
    removed: removed.sort(byKey),
    changed: changed.sort(byKey),
    schemasAdded: names(newSchemas).filter((n) => !(n in oldSchemas)),
    schemasRemoved: names(oldSchemas).filter((n) => !(n in newSchemas)),
    schemasChanged: names(newSchemas).filter((n) => n in oldSchemas && canonical(oldSchemas[n]) !== canonical(newSchemas[n])),
    versionFrom: oldSpec.info?.version,
    versionTo: newSpec.info?.version,
  };
}

export function isEmpty(d: SpecDiff): boolean {
  return ![d.added, d.removed, d.changed, d.schemasAdded, d.schemasRemoved, d.schemasChanged].some((l) => l.length);
}

export interface SummaryContext {
  imageTag?: string;
  previousTag?: string;
  source?: string;
}

export function renderSummary(d: SpecDiff, ctx: SummaryContext = {}): string {
  const lines: string[] = ["## Public API spec sync", ""];
  if (ctx.imageTag) lines.push(`Prod image: \`${ctx.imageTag}\`${ctx.previousTag ? ` (previous \`${ctx.previousTag}\`)` : ""}`);
  if (ctx.source) lines.push(`Source: ${ctx.source}`);
  if (d.versionFrom !== d.versionTo) lines.push(`Spec version: \`${d.versionFrom ?? "?"}\` → \`${d.versionTo ?? "?"}\``);
  lines.push("");
  if (isEmpty(d)) {
    lines.push("No operation or schema changes (formatting only).");
    return lines.join("\n") + "\n";
  }
  const op = (o: OpRef) => `- \`${o.method} ${o.path}\`${o.operationId ? ` (${o.operationId})` : ""}`;
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push(`### ${title} (${items.length})`, ...items, "");
  };
  section("Added operations", d.added.map(op));
  section("Removed operations ⚠ breaking for this CLI if it uses them", d.removed.map(op));
  section("Changed operations", d.changed.map(op));
  section("Added schemas", d.schemasAdded.map((n) => `- \`${n}\``));
  section("Removed schemas", d.schemasRemoved.map((n) => `- \`${n}\``));
  section("Changed schemas", d.schemasChanged.map((n) => `- \`${n}\``));
  lines.push(
    "Regenerated `openapi.public.json`, `src/generated/schema.d.ts` and `src/generated/operations.ts` with `bun run gen:client`.",
    "New operations don't get CLI commands automatically; they're reachable now with `topcited api`.",
  );
  return lines.join("\n") + "\n";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] || undefined : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valued = new Set(["--image-tag", "--previous-tag", "--source"]);
  const [oldPath, newPath] = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  if (!oldPath || !newPath) {
    console.error("usage: spec-diff.ts <old.json> <new.json> [--image-tag T] [--previous-tag P] [--source URL]");
    process.exit(2);
  }
  const d = diffSpecs(await Bun.file(oldPath).json(), await Bun.file(newPath).json());
  if (args.includes("--exit-code")) process.exit(isEmpty(d) ? 0 : 1);
  process.stdout.write(
    renderSummary(d, { imageTag: flag(args, "--image-tag"), previousTag: flag(args, "--previous-tag"), source: flag(args, "--source") }),
  );
}
