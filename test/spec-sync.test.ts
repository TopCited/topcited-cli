import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, diffSpecs, isEmpty, renderSummary } from "../scripts/spec-diff";

const op = (operationId: string, extra: object = {}) => ({ operationId, responses: { "200": {} }, ...extra });
// biome-ignore lint: loose fixture typing
const base: any = {
  info: { version: "1.0.0" },
  paths: {
    "/api/v1/brands": { get: op("listBrands"), post: op("createBrand") },
    "/api/v1/tasks": { get: op("listTasks") },
  },
  components: { schemas: { Brand: { type: "object" }, Task: { type: "object" } } },
};

describe("spec-diff", () => {
  test("classifies added, removed and changed operations and schemas, sorted", () => {
    const next = structuredClone(base);
    delete next.paths["/api/v1/brands"].post;
    next.paths["/api/v1/tasks"]!.get = op("listTasks", { description: "now paginated" });
    next.paths["/api/v1/usage"] = { get: op("getUsage") };
    next.components.schemas.Usage = { type: "object" };
    delete next.components.schemas.Task;
    const d = diffSpecs(base, next);
    expect(d.added).toEqual([{ method: "GET", path: "/api/v1/usage", operationId: "getUsage" }]);
    expect(d.removed).toEqual([{ method: "POST", path: "/api/v1/brands", operationId: "createBrand" }]);
    expect(d.changed).toEqual([{ method: "GET", path: "/api/v1/tasks", operationId: "listTasks" }]);
    expect([d.schemasAdded, d.schemasRemoved]).toEqual([["Usage"], ["Task"]]);

    const md = renderSummary(d, { imageTag: "main-abc1234", previousTag: "main-0000000" });
    expect(md).toContain("Prod image: `main-abc1234` (previous `main-0000000`)");
    expect(md).toContain("### Added operations (1)\n- `GET /api/v1/usage` (getUsage)");
    expect(md).toContain("### Removed operations ⚠");
    expect(renderSummary(d, { imageTag: "main-abc1234", previousTag: "main-0000000" })).toBe(md); // deterministic
  });

  test("key order alone is not a change", () => {
    const reordered = JSON.parse(canonical(base));
    reordered.paths = Object.fromEntries(Object.entries(base.paths).reverse());
    expect(isEmpty(diffSpecs(base, reordered))).toBe(true);
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  test("ignores non-method path keys (parameters, summary)", () => {
    const next = structuredClone(base);
    next.paths["/api/v1/tasks"].parameters = [{ name: "x" }];
    expect(diffSpecs(base, next).added).toEqual([]);
  });
});

// The script end to end in DRY_RUN mode, in a throwaway copy of the repo.
describe("spec-sync.sh (dry run)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-sync-"));
    for (const f of ["package.json", "bun.lock", "tsconfig.json", "openapi.public.json", "scripts", "src"]) {
      await cp(f, join(dir, f), { recursive: true });
    }
    await symlink(join(process.cwd(), "node_modules"), join(dir, "node_modules"));
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function sync(specFile: string) {
    const proc = Bun.spawn(["sh", "scripts/spec-sync.sh"], {
      cwd: dir,
      env: { ...process.env, SPEC_URL: specFile, DRY_RUN: "1", SPEC_SYNC_SKIP_TESTS: "1", IMAGE_TAG: "main-abc1234" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exit: await proc.exited, out, err };
  }

  test("an unchanged spec is a no-op", async () => {
    const res = await sync(join(dir, "openapi.public.json"));
    expect(res.exit).toBe(0);
    expect(res.out).toContain("Spec unchanged");
  }, 30_000);

  test("a reformatted but identical spec is a no-op and leaves no diff", async () => {
    const next = join(dir, "..", `${dir.split("/").pop()}-compact.json`);
    await Bun.write(next, JSON.stringify(await Bun.file(join(dir, "openapi.public.json")).json()));
    try {
      const res = await sync(next);
      expect(res.out).toContain("Spec unchanged");
      expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir }).stdout.toString()).toBe("");
    } finally {
      await rm(next, { force: true });
    }
  }, 30_000);

  test("a changed spec regenerates the client and prints the PR body", async () => {
    const spec = await Bun.file(join(dir, "openapi.public.json")).json();
    spec.paths["/api/v1/widgets"] = { get: { operationId: "listWidgets", responses: { "200": { description: "ok" } } } };
    const next = join(dir, "..", `${dir.split("/").pop()}-next.json`);
    await Bun.write(next, JSON.stringify(spec));
    try {
      const res = await sync(next);
      expect(res.exit).toBe(0);
      expect(res.out).toContain("DRY RUN");
      expect(res.out).toContain("Prod image: `main-abc1234`");
      expect(res.out).toContain("### Added operations (1)\n- `GET /api/v1/widgets` (listWidgets)");
      expect(await Bun.file(join(dir, "src/generated/operations.ts")).text()).toContain('"listWidgets"');
    } finally {
      await rm(next, { force: true });
    }
  }, 30_000);
});
