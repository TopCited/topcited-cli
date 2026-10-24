#!/usr/bin/env node
// Launcher for @topcited/cli: runs the prebuilt binary from the platform
// package npm installed as an optional dependency.
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const pkg = `@topcited/cli-${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? "topcited.exe" : "topcited";

let bin;
try {
  bin = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", exe);
} catch {
  process.stderr.write(
    `topcited: no prebuilt binary for ${process.platform}-${process.arch} (${pkg} is not installed).\n` +
      "Reinstall without --no-optional / --omit=optional, or use the install script:\n" +
      "  curl -fsSL https://topcited.ai/install.sh | sh\n",
  );
  process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`topcited: failed to run ${bin}: ${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
