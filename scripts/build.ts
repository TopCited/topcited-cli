// Compile single-file binaries into dist/ and write dist/SHA256SUMS for them.
// (release.yml recomputes SHA256SUMS over every target after the matrix joins.)
//
//   bun run build                       # every target
//   bun run build --target linux-x64    # one or more (repeatable), matched on asset name
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { TARGETS } from "./targets";

const args = process.argv.slice(2);
const wanted = args.flatMap((a, i) => (args[i - 1] === "--target" ? [a] : []));
const targets = wanted.length
  ? TARGETS.filter((t) => wanted.some((w) => t.asset.includes(w)))
  : TARGETS;
if (!targets.length) throw new Error(`no target matches ${wanted.join(", ")}`);

await mkdir("dist", { recursive: true });
const sums: string[] = [];
for (const t of targets) {
  const out = `dist/${t.asset}`;
  const proc = Bun.spawnSync(
    ["bun", "build", "src/index.ts", "--compile", "--minify", `--target=${t.bun}`, `--outfile=${out}`],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) throw new Error(`build failed for ${t.bun}`);
  const digest = createHash("sha256").update(await Bun.file(out).bytes()).digest("hex");
  sums.push(`${digest}  ${t.asset}`);
}

await Bun.write("dist/SHA256SUMS", sums.join("\n") + "\n");
console.error(sums.join("\n"));
