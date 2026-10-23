import { describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, generateOperations } from "../scripts/gen-client";
import { TARGETS, npmPackageName } from "../scripts/targets";
import { VERSION, userAgent } from "../src/version";

describe("release targets", () => {
  test("cover the five D4 platforms with unique asset names", () => {
    expect(TARGETS.map((t) => `${t.os}-${t.cpu}`).sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"],
    );
    expect(new Set(TARGETS.map((t) => t.asset)).size).toBe(TARGETS.length);
    expect(npmPackageName(TARGETS[0]!)).toBe("@topcited/cli-linux-x64");
  });
});

describe("generated client", () => {
  test("is in sync with openapi.public.json (run `bun run gen:client`)", async () => {
    const committed = await Bun.file("src/generated/schema.d.ts").text();
    expect(committed).toBe(await generate());
    expect(await Bun.file("src/generated/operations.ts").text()).toBe(await generateOperations());
  });
});

describe("version", () => {
  test("--version prints the package version", () => {
    const res = Bun.spawnSync(["bun", "run", "src/index.ts", "--version"]);
    expect(res.stdout.toString().trim()).toBe(VERSION);
  });

  test("user agent identifies the CLI and OS", () => {
    expect(userAgent()).toBe(`topcited-cli/${VERSION} (${process.platform}; ${process.arch})`);
  });
});

describe("npm launcher", () => {
  const nodeAvailable = Bun.which("node") !== null;

  test.skipIf(!nodeAvailable || process.platform === "win32")(
    "execs the platform package binary and forwards args and exit code",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "tc-npm-"));
      try {
        const platDir = join(root, "node_modules", "@topcited", `cli-${process.platform}-${process.arch}`);
        await mkdir(join(platDir, "bin"), { recursive: true });
        await Bun.write(join(platDir, "package.json"), "{}");
        await Bun.write(join(platDir, "bin", "topcited"), '#!/bin/sh\necho "args:$*"\nexit 3\n');
        await chmod(join(platDir, "bin", "topcited"), 0o755);
        await mkdir(join(root, "node_modules", "@topcited", "cli", "bin"), { recursive: true });
        const launcher = join(root, "node_modules", "@topcited", "cli", "bin", "topcited.js");
        await cp("npm/cli/bin/topcited.js", launcher);

        const res = Bun.spawnSync(["node", launcher, "brand", "list"]);
        expect(res.stdout.toString().trim()).toBe("args:brand list");
        expect(res.exitCode).toBe(3);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!nodeAvailable)("explains a missing platform package", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc-npm-"));
    try {
      const launcher = join(root, "topcited.js");
      await cp("npm/cli/bin/topcited.js", launcher);
      const res = Bun.spawnSync(["node", launcher]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.toString()).toContain("no prebuilt binary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
