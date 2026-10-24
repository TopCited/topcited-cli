// Assemble npm packages from dist/ binaries into dist/npm/:
//   dist/npm/cli              @topcited/cli (launcher; optionalDependencies on each platform)
//   dist/npm/cli-<os>-<cpu>   @topcited/cli-<os>-<cpu> (one binary, os/cpu restricted)
//
//   bun run scripts/npm-pack.ts [--version 1.2.3]   (default: package.json version)
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import rootPkg from "../package.json" with { type: "json" };
import { TARGETS, npmPackageName } from "./targets";

const args = process.argv.slice(2);
const vIdx = args.indexOf("--version");
const version = (vIdx !== -1 ? args[vIdx + 1] : rootPkg.version)?.replace(/^v/, "");
if (!version) throw new Error("--version needs a value");

const OUT = "dist/npm";
await rm(OUT, { recursive: true, force: true });

const launcher = await Bun.file("npm/cli/package.json").json();
launcher.version = version;
launcher.optionalDependencies = {};

for (const t of TARGETS) {
  const name = npmPackageName(t);
  const dir = `${OUT}/cli-${t.os}-${t.cpu}`;
  const exe = t.os === "win32" ? "topcited.exe" : "topcited";
  const src = `dist/${t.asset}`;
  if (!(await Bun.file(src).exists())) throw new Error(`missing ${src}; run \`bun run build\` first`);
  await mkdir(`${dir}/bin`, { recursive: true });
  await cp(src, `${dir}/bin/${exe}`);
  await chmod(`${dir}/bin/${exe}`, 0o755);
  await Bun.write(
    `${dir}/package.json`,
    JSON.stringify(
      {
        name,
        version,
        description: `TopCited CLI binary for ${t.os}-${t.cpu}`,
        repository: launcher.repository,
        os: [t.os],
        cpu: [t.cpu],
        files: [`bin/${exe}`],
        preferUnplugged: true,
      },
      null,
      2,
    ) + "\n",
  );
  launcher.optionalDependencies[name] = version;
}

await mkdir(`${OUT}/cli/bin`, { recursive: true });
await cp("npm/cli/bin/topcited.js", `${OUT}/cli/bin/topcited.js`);
await cp("README.md", `${OUT}/cli/README.md`);
await Bun.write(`${OUT}/cli/package.json`, JSON.stringify(launcher, null, 2) + "\n");
console.error(`assembled ${TARGETS.length + 1} packages @ ${version} in ${OUT}`);
