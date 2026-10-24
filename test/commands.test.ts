import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OPERATIONS } from "../src/generated/operations";
import { assetName, compareVersions } from "../src/release";
import { VERSION } from "../src/version";
import { cli, json, KEY, ME, mockApi, testRuntime } from "./helpers";

let api: ReturnType<typeof mockApi> | undefined;
afterEach(() => api?.stop());

const BRANDS = [
  { id: "b0000000-0000-0000-0000-000000000001", name: "Marlow Payroll", website_url: "https://marlow.example", website_domain: "marlow.example", created_at: "2026-09-01T00:00:00Z" },
  { id: "b0000000-0000-0000-0000-000000000002", name: "Lumi", website_url: null, website_domain: null, created_at: "2026-09-02T00:00:00Z" },
];

function authed(env: Record<string, string> = {}) {
  return testRuntime({ env: { TOPCITED_API_KEY: KEY, ...env } });
}

describe("topcited api", () => {
  test("GET with -f fields as query params; path gets the /api/v1 prefix", async () => {
    api = mockApi({ "GET /api/v1/monitoring/runs": { items: [], total: 0, skip: 0, limit: 5 } });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "api", "monitoring/runs", "-f", "limit=5")).toBe(0);
    const req = api.calls("GET", "/api/v1/monitoring/runs")[0]!;
    expect(req.search.get("limit")).toBe("5");
    expect(req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(rt.outJson()).toEqual({ items: [], total: 0, skip: 0, limit: 5 });
  });

  test("-d makes it a POST; -F fields are typed and merged into the body", async () => {
    api = mockApi({ "POST /api/v1/monitoring/query-sets": (r) => json(r.body, 201) });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "api", "/monitoring/query-sets", "-d", '{"name":"x"}', "-F", "paused=true", "-F", "n=3")).toBe(0);
    expect(rt.outJson()).toEqual({ name: "x", paused: true, n: 3 });
  });

  test("non-2xx prints the body and exits with the mapped code", async () => {
    api = mockApi({ "GET /api/v1/monitoring/query-sets/abc": () => json({ error: { code: "NOT_FOUND", message: "Query set not found" } }, 404) });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "api", "/api/v1/monitoring/query-sets/abc")).toBe(5);
    expect(rt.outJson().error.code).toBe("NOT_FOUND");
    expect(rt.errJson().at(-1)).toMatchObject({ code: "not_found", status: 404 });
  });

  test("--paginate walks skip/limit over {items,total} pages", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ i }));
    api = mockApi({
      "GET /api/v1/monitoring/runs": (r) => {
        const skip = Number(r.search.get("skip"));
        const limit = Number(r.search.get("limit"));
        return json({ items: all.slice(skip, skip + limit), total: all.length, skip, limit });
      },
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "api", "/monitoring/runs", "-f", "limit=2", "--paginate")).toBe(0);
    expect(rt.outJson()).toEqual(all);
    expect(api.calls("GET", "/api/v1/monitoring/runs").map((r) => r.search.get("skip"))).toEqual(["0", "2", "4"]);
  });

  test("--paginate on plain array pages stops on a short page", async () => {
    api = mockApi({ "GET /api/v1/tasks": (r) => json(Number(r.search.get("skip")) === 0 ? [1, 2] : [3]) });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "api", "/tasks", "-f", "limit=2", "--paginate")).toBe(0);
    expect(rt.outJson()).toEqual([1, 2, 3]);
  });

  test("--paginate fails loudly at the page cap instead of truncating", async () => {
    api = mockApi({ "GET /api/v1/tasks": [1, 2] });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "api", "/tasks", "-f", "limit=2", "--paginate", "--max-pages", "3")).toBe(1);
    expect(rt.errJson().at(-1)).toMatchObject({ code: "too_many_pages" });
    expect(api.calls("GET", "/api/v1/tasks")).toHaveLength(3);
    expect(await cli(authed(), "--base-url", api.url, "api", "/tasks", "-f", "limit=x", "--paginate")).toBe(2);
  });

  test("keeps a path prefix in the base URL", async () => {
    api = mockApi({ "GET /proxy/api/v1/users/me": ME });
    const rt = authed();
    expect(await cli(rt, "--base-url", `${api.url}/proxy`, "api", "/users/me")).toBe(0);
    expect(rt.outJson().email).toBe(ME.email);
  });

  test("a non-JSON error body goes to stderr, keeping stdout clean", async () => {
    api = mockApi({ "GET /api/v1/users/me": () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }) });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "api", "/users/me")).toBe(1);
    expect(rt.out()).toBe("");
    expect(rt.err()).toContain("502 Bad Gateway");
    expect(rt.errJson().at(-1).status).toBe(502);
  });

  test("needs a key", async () => {
    const rt = testRuntime();
    expect(await cli(rt, "api", "/users/me")).toBe(3);
  });
});

function brandApi(activeBrandId: string | null = BRANDS[0]!.id) {
  return mockApi({
    "GET /api/v1/brands": BRANDS,
    "GET /api/v1/users/me": { ...ME, active_brand_id: activeBrandId },
    [`GET /api/v1/brands/${BRANDS[1]!.id}/competitors`]: [{ id: "c1", name: "Rival", website: "rival.example" }],
    "GET /api/v1/monitoring/query-sets": [
      { id: "q1", name: "Core", brand_id: BRANDS[1]!.id, active_query_count: 4, platforms: ["chatgpt"] },
      { id: "q2", name: "Other", brand_id: BRANDS[0]!.id, active_query_count: 1, platforms: ["gemini"] },
    ],
  });
}

describe("brand", () => {
  test("list stars the server's active brand by default", async () => {
    api = brandApi();
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "brand", "list")).toBe(0);
    expect(rt.outJson().map((b: { name: string; active: boolean }) => [b.name, b.active])).toEqual([
      ["Marlow Payroll", true],
      ["Lumi", false],
    ]);
  });

  test("use stores the choice per host; list and show follow it", async () => {
    api = brandApi();
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "brand", "use", "lumi")).toBe(0);
    expect(await rt.store.getHost(api.url)).toEqual({ brand_id: BRANDS[1]!.id, brand_name: "Lumi" });

    const rt2 = authed();
    rt2.store = rt.store;
    expect(await cli(rt2, "--base-url", api.url, "brand", "show")).toBe(0);
    const shown = rt2.outJson();
    expect(shown).toMatchObject({ name: "Lumi", source: "config", is_server_active: false });
    expect(shown.competitors).toEqual([{ id: "c1", name: "Rival", website: "rival.example" }]);
    expect(shown.query_sets.map((s: { id: string }) => s.id)).toEqual(["q1"]);
  });

  test("--brand overrides config; id prefixes match", async () => {
    api = brandApi();
    const rt = authed();
    await rt.store.setHost(api.url, { brand_id: BRANDS[0]!.id });
    expect(await cli(rt, "--base-url", api.url, "--brand", "b0000000-0000-0000-0000-000000000002", "brand", "show")).toBe(0);
    expect(rt.outJson()).toMatchObject({ name: "Lumi", source: "flag" });
  });

  test("an unknown brand → exit 5 listing the real ones", async () => {
    api = brandApi();
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "brand", "use", "nope")).toBe(5);
    expect(rt.errJson().at(-1).hint).toContain("Marlow Payroll");
  });

  test("several brands and nothing selected → exit 2", async () => {
    api = brandApi(null);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "brand", "show")).toBe(2);
  });
});

describe("usage", () => {
  test("combines plan, coins, quotas and the monitoring forecast", async () => {
    api = mockApi({
      "GET /api/v1/users/me": ME,
      "GET /api/v1/users/me/coin-balance": { bundle_balance: 0, total_available: 420, plan_allowance: 500, plan_used: 80 },
      "GET /api/v1/users/me/usage": [{ feature: "reports", used: 1, limit: 5, reset_period: "monthly", reset_at: null }],
      "GET /api/v1/monitoring/credit-forecast": { forecast_runs: 300, available_credits: 420, exceeds: false },
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "usage")).toBe(0);
    expect(rt.outJson()).toMatchObject({ plan_id: "growth", coins: { total_available: 420 }, monitoring_forecast: { forecast_runs: 300 } });

    const human = testRuntime({ tty: true, env: { TOPCITED_API_KEY: KEY } });
    expect(await cli(human, "--base-url", api.url, "usage")).toBe(0);
    expect(human.out()).toContain("420 available");
    expect(human.out()).toContain("reports");
  });
});

function specPaths() {
  const paths: Record<string, Record<string, { operationId: string }>> = {};
  for (const [m, p, id] of OPERATIONS) (paths[p] ??= {})[m.toLowerCase()] = { operationId: id };
  return paths;
}

function releaseApi(version: string, binary: Uint8Array, sumsOverride?: string) {
  const name = assetName()!;
  const digest = createHash("sha256").update(binary).digest("hex");
  return mockApi({
    "GET /releases/latest": (r) =>
      json({
        tag_name: `v${version}`,
        assets: [
          { name, url: `http://${r.headers.get("host")}/assets/bin` },
          { name: "SHA256SUMS", url: `http://${r.headers.get("host")}/assets/sums` },
        ],
      }),
    "GET /assets/bin": () => new Response(binary),
    "GET /assets/sums": () => new Response(sumsOverride ?? `${digest}  ${name}\n`),
    "GET /api/v1/openapi.public.json": { paths: specPaths() },
    "GET /api/v1/users/me": ME,
    "GET /api/v1/brands": BRANDS.slice(0, 1),
  });
}

describe("upgrade", () => {
  test("--check reports an available update without downloading", async () => {
    api = releaseApi("99.0.0", new Uint8Array([1]));
    const rt = testRuntime({ env: { TOPCITED_RELEASES_API: `${api.url}/releases/latest` } });
    expect(await cli(rt, "upgrade", "--check")).toBe(0);
    expect(rt.outJson()).toEqual({ current: VERSION, latest: "99.0.0", update_available: true, upgraded: false });
    expect(api.calls("GET", "/assets/bin")).toHaveLength(0);
  });

  test("replaces the binary after verifying its checksum", async () => {
    const binary = new TextEncoder().encode("#!/bin/sh\necho new\n");
    api = releaseApi("99.0.0", binary);
    const rt = testRuntime({ env: { TOPCITED_RELEASES_API: `${api.url}/releases/latest` } });
    await mkdir(join(rt.dir, "bin"), { recursive: true });
    await Bun.write(rt.execPath, "old");
    expect(await cli(rt, "upgrade")).toBe(0);
    expect(rt.outJson()).toMatchObject({ upgraded: true, latest: "99.0.0" });
    expect(await Bun.file(rt.execPath).text()).toBe("#!/bin/sh\necho new\n");
    expect(api.calls("GET", "/assets/bin")[0]!.headers.get("accept")).toBe("application/octet-stream");
  });

  test("refuses a binary whose checksum doesn't match", async () => {
    api = releaseApi("99.0.0", new Uint8Array([1, 2, 3]), `${"0".repeat(64)}  ${assetName()}\n`);
    const rt = testRuntime({ env: { TOPCITED_RELEASES_API: `${api.url}/releases/latest` } });
    await mkdir(join(rt.dir, "bin"), { recursive: true });
    await Bun.write(rt.execPath, "old");
    expect(await cli(rt, "upgrade")).toBe(1);
    expect(rt.errJson().at(-1).code).toBe("checksum_mismatch");
    expect(await Bun.file(rt.execPath).text()).toBe("old");
  });

  test("npm installs get the npm command instead", async () => {
    api = releaseApi("99.0.0", new Uint8Array([1]));
    const rt = testRuntime({ env: { TOPCITED_RELEASES_API: `${api.url}/releases/latest` } });
    rt.install = "npm";
    expect(await cli(rt, "upgrade")).toBe(0);
    expect(rt.outJson()).toMatchObject({ upgraded: false, command: "npm i -g @topcited/cli@latest" });
  });
});

describe("update notice", () => {
  test("shows at most once a day, only on a TTY", async () => {
    api = releaseApi("99.0.0", new Uint8Array([1]));
    const env = { TOPCITED_RELEASES_API: `${api.url}/releases/latest`, TOPCITED_NO_UPDATE_NOTIFIER: "" };
    const rt = testRuntime({ tty: true, env });
    expect(await cli(rt, "auth", "token")).toBe(3);
    // failed command: no notice
    expect(rt.err()).not.toContain("new release");

    const ok = testRuntime({ tty: true, env });
    ok.store = rt.store;
    expect(await cli(ok, "auth", "logout")).toBe(0);
    expect(ok.err()).toContain(`${VERSION} → 99.0.0`);

    const again = testRuntime({ tty: true, env });
    again.store = rt.store;
    expect(await cli(again, "auth", "logout")).toBe(0);
    expect(again.err()).toBe("");
    expect(api.calls("GET", "/releases/latest")).toHaveLength(1);
  });

  test("never with --json", async () => {
    api = releaseApi("99.0.0", new Uint8Array([1]));
    const rt = testRuntime({ tty: true, env: { TOPCITED_RELEASES_API: `${api.url}/releases/latest`, TOPCITED_NO_UPDATE_NOTIFIER: "" } });
    expect(await cli(rt, "--json", "auth", "logout")).toBe(0);
    expect(api.requests).toHaveLength(0);
  });

  test("never without a TTY", async () => {
    api = releaseApi("99.0.0", new Uint8Array([1]));
    const rt = testRuntime({ env: { TOPCITED_RELEASES_API: `${api.url}/releases/latest`, TOPCITED_NO_UPDATE_NOTIFIER: "" } });
    expect(await cli(rt, "auth", "logout")).toBe(0);
    expect(api.requests).toHaveLength(0);
  });
});

describe("doctor", () => {
  test("all green when logged in and the contract matches", async () => {
    api = releaseApi(VERSION, new Uint8Array([1]));
    const rt = authed({ TOPCITED_RELEASES_API: `${api.url}/releases/latest` });
    expect(await cli(rt, "--base-url", api.url, "doctor")).toBe(0);
    const out = rt.outJson();
    expect(out.ok).toBe(true);
    expect(Object.fromEntries(out.checks.map((c: { name: string; status: string }) => [c.name, c.status]))).toEqual({
      version: "ok",
      config: "ok",
      base_url: "ok",
      api: "ok",
      auth: "ok",
      brand: "ok",
    });
    // Never the full key.
    expect(rt.out()).not.toContain(KEY);
    expect(rt.out()).toContain(KEY.slice(0, 12));
  });

  test("not logged in → exit 1 naming the failed check", async () => {
    api = releaseApi(VERSION, new Uint8Array([1]));
    const rt = testRuntime({ env: { TOPCITED_RELEASES_API: `${api.url}/releases/latest` } });
    expect(await cli(rt, "--base-url", api.url, "doctor")).toBe(1);
    expect(rt.errJson().at(-1)).toMatchObject({ code: "doctor_failed", checks: ["auth"] });
  });

  test("flags a server that lacks operations this CLI uses", async () => {
    api = mockApi({ "GET /api/v1/openapi.public.json": { paths: {} }, "GET /api/v1/users/me": ME, "GET /api/v1/brands": BRANDS.slice(0, 1) });
    const rt = authed({ TOPCITED_RELEASES_API: `${api.url}/nope` });
    expect(await cli(rt, "--base-url", api.url, "doctor")).toBe(0);
    const apiCheck = rt.outJson().checks.find((c: { name: string }) => c.name === "api");
    expect(apiCheck).toMatchObject({ status: "warn", detail: expect.stringContaining("server lacks") });
  });

  test("an unreachable API fails the api check", async () => {
    const rt = authed({ TOPCITED_RELEASES_API: "http://127.0.0.1:9/x" });
    expect(await cli(rt, "--base-url", "http://127.0.0.1:9", "doctor")).toBe(1);
  });
});

describe("compareVersions", () => {
  test.each([
    ["0.2.0", "0.1.9", 1],
    ["1.0.0", "1.0.0", 0],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["v0.10.0", "0.9.0", 1],
  ])("%s vs %s", (a, b, want) => expect(compareVersions(a, b)).toBe(want));
});

