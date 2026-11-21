import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.ps1 against a local server, in every PowerShell on the machine: pwsh
// (CI's ubuntu-latest and windows jobs) and, on Windows, Windows PowerShell 5.1.
// 5.1 gets PowerShell 7's PSModulePath, as it does when an agent launched from a
// PowerShell 7 terminal runs the installer in Windows PowerShell.
// On Windows, install.ps1 adds the install folder to the real user PATH, so it
// only runs there in CI.
const windows = process.platform === "win32";
const shells =
  windows && !process.env.CI
    ? []
    : ["pwsh", "powershell"].flatMap((name) => {
        const path = Bun.which(name);
        return path ? [{ name, path }] : [];
      });

test.if(windows && !!process.env.CI)("finds both PowerShells on Windows", () => {
  expect(shells.map((s) => s.name)).toEqual(["pwsh", "powershell"]);
});

// The environment 5.1 runs in: PSModulePath as PowerShell 7 sets it.
function shellEnv(name: string): Record<string, string | undefined> {
  const pwsh = Bun.which("pwsh");
  if (name !== "powershell" || !pwsh) return process.env;
  const modulePath = Bun.spawnSync([pwsh, "-NoProfile", "-NonInteractive", "-Command", "$env:PSModulePath"])
    .stdout.toString()
    .trim();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
  return { ...env, PSModulePath: modulePath };
}

// Guards the 5.1 cases below: if this environment stops hiding Get-FileHash,
// they would pass with the old installer too.
test.if(windows && !!process.env.CI)("5.1 with PowerShell 7's module path can't see Get-FileHash", () => {
  const proc = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-Command Get-FileHash"], {
    env: shellEnv("powershell"),
  });
  expect(proc.exitCode).not.toBe(0);
});
const asset = "topcited-windows-x64.exe";
const fakeBinary = "MZ fake windows binary\n";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let sums = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tc-install-ps1-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === `/${asset}`) return new Response(fakeBinary);
      if (path === "/SHA256SUMS") return new Response(sums);
      return new Response("nope", { status: 404 });
    },
  });
});
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function install(name: string, shell: string, installDir: string) {
  // Async spawn: a sync spawn would block the event loop serving the download.
  const proc = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-Command", "Get-Content -Raw ./install.ps1 | Invoke-Expression"], {
    env: {
      ...shellEnv(name),
      TOPCITED_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`,
      TOPCITED_INSTALL_DIR: installDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, output: out + err };
}

describe.skipIf(shells.length === 0).each(shells)("install.ps1 in $name", ({ name, path: shell }) => {
  test("installs topcited.exe when the checksum matches", async () => {
    const digest = createHash("sha256").update(fakeBinary).digest("hex").toUpperCase(); // case-insensitive
    sums = `${"0".repeat(64)}  topcited-linux-x64\n${digest}  ${asset}\n`;
    const target = join(dir, name, "ok");
    const res = await install(name, shell, target);
    expect(res.output).toContain("Installed topcited");
    expect(res.exitCode).toBe(0);
    expect(await Bun.file(join(target, "topcited.exe")).text()).toBe(fakeBinary);
  }, 60_000);

  test("refuses to install on checksum mismatch", async () => {
    sums = `${"a".repeat(64)}  ${asset}\n`;
    const target = join(dir, name, "bad");
    const res = await install(name, shell, target);
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("checksum mismatch");
    expect(await Bun.file(join(target, "topcited.exe")).exists()).toBe(false);
  }, 60_000);

  test("fails when the asset has no checksum line", async () => {
    sums = `${"a".repeat(64)}  topcited-linux-x64\n`;
    const res = await install(name, shell, join(dir, name, "missing"));
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("no checksum");
  }, 60_000);

  test("replaces an existing install", async () => {
    const digest = createHash("sha256").update(fakeBinary).digest("hex");
    sums = `${digest}  ${asset}\n`;
    const target = join(dir, name, "again");
    await Bun.write(join(target, "topcited.exe"), "old");
    const res = await install(name, shell, target);
    expect(res.exitCode).toBe(0);
    expect(await Bun.file(join(target, "topcited.exe")).text()).toBe(fakeBinary);
  }, 60_000);
});
