import { createHash } from "node:crypto";
import { chmod, rename, rm } from "node:fs/promises";
import type { Command } from "commander";
import type { Context } from "../context";
import { CliError, Exit } from "../errors";
import { assetName, compareVersions, githubHeaders, latestRelease, REPO } from "../release";
import { VERSION } from "../version";
import type { Action } from "./types";

export function registerUpgrade(program: Command, action: Action): void {
  program
    .command("upgrade")
    .description("Upgrade topcited to the latest release")
    .option("--check", "only report whether a newer release exists")
    .addHelpText("after", "\nExamples:\n  $ topcited upgrade\n  $ topcited upgrade --check --json")
    .action(action(upgrade));
}

async function upgrade(ctx: Context, opts: { check?: boolean }): Promise<void> {
  const latest = await latestRelease(ctx.rt);
  if (!latest) {
    throw new CliError({
      exit: Exit.ERROR,
      code: "release_lookup_failed",
      message: `Couldn't look up the latest release of ${REPO}.`,
      hint: "Check your connection. While the repo is private, set GH_TOKEN to a token that can read it.",
    });
  }
  const available = compareVersions(latest.version, VERSION) > 0;
  const result = { current: VERSION, latest: latest.version, update_available: available, upgraded: false };

  if (!available || opts.check) {
    ctx.print(result, available ? `Update available: ${VERSION} → ${latest.version}. Run \`topcited upgrade\`.` : `topcited ${VERSION} is up to date.`);
    return;
  }
  if (ctx.rt.install === "npm") {
    ctx.print({ ...result, command: "npm i -g @topcited/cli@latest" }, `Installed with npm. Run: npm i -g @topcited/cli@latest`);
    return;
  }
  if (ctx.rt.install === "source") {
    ctx.print({ ...result, command: "git pull && bun install" }, "Running from source; update with git pull.");
    return;
  }

  const name = assetName();
  const asset = latest.assets.find((a) => a.name === name);
  const sums = latest.assets.find((a) => a.name === "SHA256SUMS");
  if (!name || !asset || !sums) {
    throw new CliError({ exit: Exit.ERROR, code: "no_asset", message: `Release ${latest.tag} has no ${name ?? "binary"} for this platform.` });
  }
  ctx.info(`Downloading ${latest.tag} (${name})…`);
  const [binary, sumsText] = await Promise.all([download(ctx, asset.url), download(ctx, sums.url).then((b) => new TextDecoder().decode(b))]);
  const expected = sumsText
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => f === name)?.[0];
  const actual = createHash("sha256").update(binary).digest("hex");
  if (!expected || expected !== actual) {
    throw new CliError({ exit: Exit.ERROR, code: "checksum_mismatch", message: `Checksum mismatch for ${name}; not installing.` });
  }
  await replaceExecutable(ctx.rt.execPath, binary);
  ctx.print({ ...result, upgraded: true, path: ctx.rt.execPath }, `Upgraded topcited ${VERSION} → ${latest.version}.`);
}

/** Release assets via the API URL, so it also works with a token on a private repo. */
async function download(ctx: Context, url: string): Promise<Uint8Array> {
  const res = await ctx.rt.fetch(url, { headers: githubHeaders(ctx.rt.env, "application/octet-stream") });
  if (!res.ok) throw new CliError({ exit: Exit.ERROR, code: "download_failed", status: res.status, message: `Download failed: ${url}` });
  return new Uint8Array(await res.arrayBuffer());
}

/** Write next to the old binary, then rename over it (atomic on POSIX; Windows moves the running exe aside). */
async function replaceExecutable(path: string, binary: Uint8Array): Promise<void> {
  const next = `${path}.new`;
  try {
    await Bun.write(next, binary);
    await chmod(next, 0o755);
    if (process.platform === "win32") {
      await rm(`${path}.old`, { force: true });
      await rename(path, `${path}.old`);
    }
    await rename(next, path);
  } catch (e) {
    await rm(next, { force: true });
    throw new CliError({
      exit: Exit.ERROR,
      code: "install_failed",
      message: `Couldn't replace ${path}: ${e instanceof Error ? e.message : e}`,
      hint: "Re-run the installer: curl -fsSL https://topcited.ai/install.sh | sh",
    });
  }
}
