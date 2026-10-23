import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const osName = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const asset = `topcited-${osName}-${arch}`;
const fakeBinary = "#!/bin/sh\necho 9.9.9\n";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let sums = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tc-install-"));
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

// Async spawn: a sync spawn would block the event loop serving the download.
async function install(installDir: string) {
  const proc = Bun.spawn(["sh", "install.sh"], {
    env: {
      PATH: process.env.PATH!,
      HOME: dir,
      TOPCITED_DOWNLOAD_BASE: `http://localhost:${server.port}`,
      TOPCITED_INSTALL_DIR: installDir,
    },
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

describe("install.sh", () => {
  test("installs the binary when the checksum matches", async () => {
    const digest = createHash("sha256").update(fakeBinary).digest("hex");
    sums = `${"0".repeat(64)}  topcited-other\n${digest}  ${asset}\n`;
    const target = join(dir, "ok-bin");
    const res = await install(target);
    expect(res.exitCode).toBe(0);
    const out = Bun.spawnSync([join(target, "topcited")]).stdout.toString();
    expect(out.trim()).toBe("9.9.9");
    expect(res.stderr).toContain("is not on your PATH");
  });

  test("refuses to install on checksum mismatch", async () => {
    sums = `${"a".repeat(64)}  ${asset}\n`;
    const target = join(dir, "bad-bin");
    const res = await install(target);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("checksum mismatch");
    expect(await Bun.file(join(target, "topcited")).exists()).toBe(false);
  });

  test("fails when the asset has no checksum line", async () => {
    sums = `${"a".repeat(64)}  topcited-other\n`;
    const res = await install(join(dir, "missing-bin"));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("no checksum");
  });
});
