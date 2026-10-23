import { afterEach, describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { buildProgram } from "../src/cli";
import { domainOf } from "../src/commands/audit";
import { classify } from "../src/wait";
import { cli, json, KEY, ME, mockApi, testRuntime, type Recorded } from "./helpers";

let api: ReturnType<typeof mockApi> | undefined;
afterEach(() => api?.stop());

const BRAND = { id: "b0000000-0000-0000-0000-000000000001", name: "Marlow", website_url: null, website_domain: null, created_at: "2026-09-01T00:00:00Z" };
const OTHER = { ...BRAND, id: "b0000000-0000-0000-0000-000000000002", name: "Lumi" };
const SET_ID = "5e700000-0000-0000-0000-000000000001";
const BATCH = "ba700000-0000-0000-0000-000000000001";

const SET = {
  id: SET_ID,
  name: "Core",
  brand_id: BRAND.id,
  platforms: ["chatgpt", "gemini", "google"],
  active_query_count: 3,
  paused: false,
  run_mode: "auto",
  last_run_at: null,
};
const DETAIL = {
  ...SET,
  schedule_cron: "0 6 * * *",
  methods_per_platform: {},
  runnability: { runnable: true, unserved_platforms: [] },
  queries: [
    { id: "q1", text: "best payroll app", query_type: "llm_prompt", is_active: true },
    { id: "q2", text: "payroll for startups", query_type: "llm_prompt", is_active: true },
    { id: "q3", text: "payroll software", query_type: "search_keyword", is_active: true },
    { id: "q4", text: "old", query_type: "llm_prompt", is_active: false },
  ],
};

function run(status: string, batch = BATCH) {
  return { id: crypto.randomUUID(), run_batch_id: batch, status, provider: "chatgpt", query_text: "x", query_set_id: SET_ID };
}

/** Monitoring API whose batch advances one step per poll of /monitoring/runs. */
function monitoringApi(steps: string[][], extra: Record<string, unknown> = {}) {
  let poll = 0;
  return mockApi({
    "GET /api/v1/users/me": ME,
    "GET /api/v1/brands": [BRAND, OTHER],
    "GET /api/v1/monitoring/query-sets": [SET, { ...SET, id: "5e700000-0000-0000-0000-000000000002", name: "Theirs", brand_id: OTHER.id }],
    [`GET /api/v1/monitoring/query-sets/${SET_ID}`]: DETAIL,
    "GET /api/v1/monitoring/credit-forecast": { forecast_runs: 100, available_credits: 42, exceeds: false },
    "GET /api/v1/users/me/coin-balance": { bundle_balance: 0, total_available: 42 },
    [`POST /api/v1/monitoring/query-sets/${SET_ID}/run`]: () => json({ batch_id: BATCH, runs_created: steps[0]!.length }, 202),
    "GET /api/v1/monitoring/runs": () => {
      const statuses = steps[Math.min(poll++, steps.length - 1)]!;
      return json({ items: [...statuses.map((s) => run(s)), run("success", "older-batch")], total: statuses.length + 1, skip: 0, limit: 100 });
    },
    ...extra,
  } as Parameters<typeof mockApi>[0]);
}

function authed(opts: { tty?: boolean; answers?: string[] } = {}) {
  return testRuntime({ env: { TOPCITED_API_KEY: KEY }, ...opts });
}

describe("monitor run", () => {
  test("--dry-run estimates query × routed platform runs and spends nothing", async () => {
    api = monitoringApi([["pending"]]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", "Core", "--dry-run")).toBe(0);
    // 2 active llm prompts × (chatgpt, gemini) + 1 search keyword × google = 5; inactive q4 excluded.
    expect(rt.outJson()).toMatchObject({ dry_run: true, estimate_tcoins: 5, available_tcoins: 42, exceeds: false, query_set_id: SET_ID });
    expect(api.calls("POST", `/api/v1/monitoring/query-sets/${SET_ID}/run`)).toHaveLength(0);
  });

  test("--wait follows the batch to completion through one wait loop", async () => {
    api = monitoringApi([
      ["pending", "pending", "pending"],
      ["running", "success", "pending"],
      ["success", "success", "failed"],
    ]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", SET_ID, "--wait")).toBe(0);
    expect(rt.outJson()).toMatchObject({ batch_id: BATCH, status: "partial", total: 3, counts: { success: 2, failed: 1 }, job: `monitor:${SET_ID}:${BATCH}` });
    expect(rt.sleeps).toEqual([2000, 3000]); // backoff ×1.5
  });

  test("without --wait prints the job reference to resume with", async () => {
    api = monitoringApi([["pending"]]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", "core")).toBe(0);
    expect(rt.outJson()).toEqual({ query_set_id: SET_ID, batch_id: BATCH, runs_created: 1, job: `monitor:${SET_ID}:${BATCH}` });
  });

  test("--timeout passing first → exit 7 with the job id; `wait <job>` resumes", async () => {
    api = monitoringApi([["running"], ["running"], ["running"], ["success"]]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", "Core", "--wait", "--timeout", "3")).toBe(7);
    const env = rt.errJson().at(-1);
    expect(env).toMatchObject({ code: "wait_timeout", job: `monitor:${SET_ID}:${BATCH}`, job_id: BATCH });
    expect(env.hint).toContain(`topcited wait monitor:${SET_ID}:${BATCH}`);

    const rt2 = authed();
    expect(await cli(rt2, "--base-url", api.url, "wait", env.job)).toBe(0);
    expect(rt2.outJson()).toMatchObject({ status: "success" });
  });

  test("a batch where every run failed → exit 1", async () => {
    api = monitoringApi([["failed", "timeout"]]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", "Core", "--wait")).toBe(1);
    expect(rt.errJson().at(-1)).toMatchObject({ code: "job_failed", job_status: "failed" });
  });

  test("asks before spending on a TTY; 'n' cancels without spending", async () => {
    api = monitoringApi([["success"]]);
    const rt = authed({ tty: true, answers: ["n"] });
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", "Core")).toBe(1);
    expect(api.calls("POST", `/api/v1/monitoring/query-sets/${SET_ID}/run`)).toHaveLength(0);

    const yes = authed({ tty: true, answers: ["y"] });
    expect(await cli(yes, "--base-url", api.url, "monitor", "run", "Core")).toBe(0);
    expect(api.calls("POST", `/api/v1/monitoring/query-sets/${SET_ID}/run`)).toHaveLength(1);
  });

  test("--yes skips the prompt; no TTY never prompts", async () => {
    api = monitoringApi([["success"]]);
    const tty = authed({ tty: true, answers: [] }); // an empty answer would cancel
    expect(await cli(tty, "--base-url", api.url, "monitor", "run", "Core", "--yes")).toBe(0);
    const pipe = authed();
    expect(await cli(pipe, "--base-url", api.url, "monitor", "run", "Core")).toBe(0);
    expect(api.calls("POST", `/api/v1/monitoring/query-sets/${SET_ID}/run`)).toHaveLength(2);
  });

  test("402 → exit 4", async () => {
    api = monitoringApi([["success"]], {
      [`POST /api/v1/monitoring/query-sets/${SET_ID}/run`]: () => json({ error: { code: "QUOTA_EXCEEDED", message: "Out of T-coins" } }, 402),
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", "Core")).toBe(4);
    expect(rt.errJson().at(-1)).toMatchObject({ code: "quota_exceeded", status: 402 });
  });

  test("an unknown set → exit 5", async () => {
    api = monitoringApi([["success"]]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "run", "Nope")).toBe(5);
  });
});

describe("monitor sets / queries / results", () => {
  test("sets list shows only the active brand's sets unless --all", async () => {
    api = monitoringApi([["success"]]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "sets", "list")).toBe(0);
    expect(rt.outJson().map((s: { name: string }) => s.name)).toEqual(["Core"]);
    const all = authed();
    expect(await cli(all, "--base-url", api.url, "monitor", "sets", "list", "--all")).toBe(0);
    expect(all.outJson()).toHaveLength(2);
  });

  test("sets create posts the set then its queries", async () => {
    api = monitoringApi([["success"]], {
      "POST /api/v1/monitoring/query-sets": (r: Recorded) => json({ ...SET, id: "new", ...(r.body as object) }, 201),
      "POST /api/v1/monitoring/query-sets/new/queries": (r: Recorded) => json((r.body as object[]).map((q, i) => ({ id: `q${i}`, ...q })), 201),
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "sets", "create", "Payroll", "-p", "chatgpt", "-p", "gemini", "-q", "best payroll app", "--manual")).toBe(0);
    expect(api.calls("POST", "/api/v1/monitoring/query-sets")[0]!.body).toEqual({ name: "Payroll", platforms: ["chatgpt", "gemini"], run_mode: "manual" });
    expect(api.calls("POST", "/api/v1/monitoring/query-sets/new/queries")[0]!.body).toEqual([{ text: "best payroll app", query_type: "llm_prompt" }]);
  });

  test("sets create refuses when the CLI's brand isn't the account's active brand", async () => {
    api = monitoringApi([["success"]]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "--brand", "Lumi", "monitor", "sets", "create", "X", "-p", "chatgpt")).toBe(1);
    expect(rt.errJson().at(-1).code).toBe("brand_mismatch");
    expect(api.calls("POST", "/api/v1/monitoring/query-sets")).toHaveLength(0);
  });

  test("an unknown platform is a usage error", async () => {
    const rt = authed();
    expect(await cli(rt, "monitor", "sets", "create", "X", "-p", "myspace")).toBe(2);
  });

  test("queries add / rm", async () => {
    api = monitoringApi([["success"]], {
      [`POST /api/v1/monitoring/query-sets/${SET_ID}/queries`]: (r: Recorded) => json(r.body, 201),
      "DELETE /api/v1/monitoring/queries/q1": () => new Response(null, { status: 204 }),
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "queries", "add", "Core", "a", "b", "--type", "universal")).toBe(0);
    expect(rt.outJson()).toEqual([{ text: "a", query_type: "universal" }, { text: "b", query_type: "universal" }]);
    const rm = authed();
    expect(await cli(rm, "--base-url", api.url, "monitor", "queries", "rm", "q1")).toBe(0);
    expect(rm.outJson()).toEqual({ deleted: ["q1"] });
  });

  test("results pools the brand's sets and adds gaps + share of voice per set", async () => {
    api = monitoringApi([["success"]], {
      "GET /api/v1/monitoring/metrics/summary": { window: { since: "2026-10-01", until: "2026-10-23" }, rows: [{ brand_name: "Marlow", is_customer_brand: true, mention_rate: 0.25 }] },
      "GET /api/v1/monitoring/gaps": [{ query_id: "q1", query_text: "best payroll app", competitors_mentioned: ["Gusto"] }],
      "GET /api/v1/monitoring/share-of-voice": { query_set_id: SET_ID, entries: [{ brand_name: "Gusto", mention_rate: 0.6 }] },
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "monitor", "results", "--since", "2026-10-01")).toBe(0);
    const summaryReq = api.calls("GET", "/api/v1/monitoring/metrics/summary")[0]!;
    expect(summaryReq.search.get("query_set_ids")).toBe(SET_ID);
    expect(summaryReq.search.get("from")).toBe("2026-10-01");
    expect(rt.outJson().sets[0]).toMatchObject({ name: "Core", gaps: [{ query_text: "best payroll app" }], share_of_voice: [{ brand_name: "Gusto" }] });

    const human = testRuntime({ tty: true, env: { TOPCITED_API_KEY: KEY } });
    expect(await cli(human, "--base-url", api.url, "monitor", "results")).toBe(0);
    expect(human.out()).toContain("25.0%");
    expect(human.out()).toContain("best payroll app  [Gusto]");
  });

  test("results rejects malformed dates", async () => {
    const rt = authed();
    expect(await cli(rt, "monitor", "results", "--since", "last week")).toBe(2);
  });
});

describe("audit", () => {
  const SITE = { id: "51700000-0000-0000-0000-000000000001", domain: "marlow.example" };
  function auditApi(sites: object[], statuses: string[]) {
    let i = 0;
    const runRow = (status: string) => ({ id: "a1", site_id: SITE.id, status, summary_json: status === "completed" ? { pages: 12, issues: 3 } : null, created_at: "2026-10-23T12:00:00Z" });
    return mockApi({
      "GET /api/v1/users/me/coin-balance": { bundle_balance: 9 },
      "GET /api/v1/seo/sites": sites,
      "POST /api/v1/seo/sites": (r: Recorded) => json({ ...SITE, ...(r.body as object) }, 201),
      [`POST /api/v1/seo/sites/${SITE.id}/audit-runs`]: () => json(runRow("pending"), 202),
      [`GET /api/v1/seo/sites/${SITE.id}/audit-runs/a1`]: () => json(runRow(statuses[Math.min(i++, statuses.length - 1)]!)),
      [`GET /api/v1/seo/sites/${SITE.id}/audit-runs/a1/issues`]: [{ severity: "high", issue_type: "missing_llms_txt", recommendation: "Add /llms.txt" }],
      [`GET /api/v1/seo/sites/${SITE.id}/audit-runs`]: [runRow("completed")],
    });
  }

  test("run registers a new site, then waits for the audit", async () => {
    api = auditApi([], ["running", "completed"]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "audit", "run", "https://www.marlow.example/pricing", "--wait")).toBe(0);
    expect(api.calls("POST", "/api/v1/seo/sites")[0]!.body).toEqual({ domain: "marlow.example" });
    expect(rt.outJson()).toMatchObject({ run: { status: "completed" }, issues: [{ issue_type: "missing_llms_txt" }] });
  });

  test("run reuses an existing site", async () => {
    api = auditApi([SITE], ["completed"]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "audit", "run", "marlow.example")).toBe(0);
    expect(api.calls("POST", "/api/v1/seo/sites")).toHaveLength(0);
    expect(rt.outJson().job).toBe(`audit:${SITE.id}:a1`);
  });

  test("--dry-run spends nothing and registers nothing", async () => {
    api = auditApi([], ["completed"]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "audit", "run", "marlow.example", "--dry-run")).toBe(0);
    expect(rt.outJson()).toMatchObject({ dry_run: true, estimate_tcoins: null, available_tcoins: 9, domain: "marlow.example" });
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("show finds the run across sites", async () => {
    api = auditApi([SITE], ["completed"]);
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "audit", "show", "a1")).toBe(0);
    expect(rt.outJson().domain).toBe("marlow.example");
  });

  test.each([
    ["https://www.Example.com/x?y=1", "example.com"],
    ["example.co.uk", "example.co.uk"],
  ])("domainOf(%s) = %s", (input, want) => expect(domainOf(input)).toBe(want));
});

describe("recommend / report / competitors / tasks", () => {
  function brandRoutes() {
    return { "GET /api/v1/users/me": ME, "GET /api/v1/brands": [BRAND], "GET /api/v1/users/me/coin-balance": { bundle_balance: 5 } };
  }

  test("recommend prompts --wait polls the latest run, then lists recommendations", async () => {
    let polls = 0;
    api = mockApi({
      ...brandRoutes(),
      [`POST /api/v1/brands/${BRAND.id}/prompts:recommend`]: (r: Recorded) => json({ id: "r1", status: "pending", body: r.body }, 202),
      [`GET /api/v1/brands/${BRAND.id}/prompt-recommendation-runs/latest`]: () => json({ id: "r1", status: polls++ ? "completed" : "running", stage: "drafting" }),
      [`GET /api/v1/brands/${BRAND.id}/prompts`]: { customer_prompts: [], recommendations: [{ text: "best payroll for agencies", score: 0.9 }], latest_run: null },
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "recommend", "prompts", "--wait")).toBe(0);
    expect(api.calls("POST", `/api/v1/brands/${BRAND.id}/prompts:recommend`)[0]!.body).toEqual({ mode: "competitor" });
    expect(rt.outJson()).toEqual({ brand_id: BRAND.id, kind: "prompts", recommendations: [{ text: "best payroll for agencies", score: 0.9 }] });
  });

  test("recommend --topic switches to topic mode; --list spends nothing", async () => {
    api = mockApi({
      ...brandRoutes(),
      [`POST /api/v1/brands/${BRAND.id}/content-sentences:recommend`]: () => json({ id: "r2", status: "pending" }, 202),
      [`GET /api/v1/brands/${BRAND.id}/keywords`]: { customer_keywords: [], recommendations: [{ text: "payroll" }], latest_run: null },
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "recommend", "content", "--topic", "compliance")).toBe(0);
    expect(api.calls("POST", `/api/v1/brands/${BRAND.id}/content-sentences:recommend`)[0]!.body).toEqual({ mode: "topic", topic: "compliance" });
    expect(rt.outJson().job).toBe(`recommend:content:${BRAND.id}:r2`);

    const list = authed();
    expect(await cli(list, "--base-url", api.url, "recommend", "keywords", "--list")).toBe(0);
    expect(list.outJson().recommendations).toEqual([{ text: "payroll" }]);
  });

  test("a recommendation run replaced by a newer one fails the wait", async () => {
    api = mockApi({
      ...brandRoutes(),
      [`POST /api/v1/brands/${BRAND.id}/keywords:recommend`]: () => json({ id: "r1", status: "pending" }, 202),
      [`GET /api/v1/brands/${BRAND.id}/keyword-recommendation-runs/latest`]: { id: "r9", status: "running" },
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "recommend", "keywords", "--wait")).toBe(1);
    expect(rt.errJson().at(-1).job_status).toBe("superseded");
  });

  test("report generate --wait polls until ready", async () => {
    let polls = 0;
    const statuses = ["pending", "generating", "ready"];
    api = mockApi({
      ...brandRoutes(),
      "POST /api/v1/reports/generate": (r: Recorded) => json({ id: "rep1", status: "pending", ...(r.body as object) }, 201),
      "GET /api/v1/reports/rep1": () => json({ id: "rep1", status: statuses[Math.min(polls++, 2)], report_type: "geo_audit" }),
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "report", "generate", "--wait", "-P", "period=30d")).toBe(0);
    expect(api.calls("POST", "/api/v1/reports/generate")[0]!.body).toEqual({ report_type: "geo_audit", params: { period: "30d" } });
    expect(rt.outJson()).toMatchObject({ report: { status: "ready" }, job: "report:rep1" });
  });

  test("report download writes the file", async () => {
    api = mockApi({ ...brandRoutes(), "GET /api/v1/reports/rep1/download/html": () => new Response("<html>hi</html>") });
    const rt = authed();
    const out = `${rt.dir}/r.html`;
    expect(await cli(rt, "--base-url", api.url, "report", "download", "rep1", "--format", "html", "-o", out)).toBe(0);
    expect(await Bun.file(out).text()).toBe("<html>hi</html>");
  });

  test("competitors add posts to the active brand", async () => {
    api = mockApi({
      ...brandRoutes(),
      [`POST /api/v1/brands/${BRAND.id}/competitors`]: (r: Recorded) => json({ id: "c1", ...(r.body as object) }, 201),
    });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "competitors", "add", "Gusto", "-w", "gusto.com", "-a", "Gusto Payroll")).toBe(0);
    expect(api.calls("POST", `/api/v1/brands/${BRAND.id}/competitors`)[0]!.body).toEqual({
      name: "Gusto",
      website: "gusto.com",
      description: null,
      aliases: ["Gusto Payroll"],
    });
  });

  test("tasks show --wait uses the same loop", async () => {
    let polls = 0;
    api = mockApi({ "GET /api/v1/tasks/t1": () => json({ id: "t1", task_type: "optimization", status: polls++ ? "success" : "running" }) });
    const rt = authed();
    expect(await cli(rt, "--base-url", api.url, "tasks", "show", "t1", "--wait")).toBe(0);
    expect(rt.outJson()).toMatchObject({ id: "t1", status: "success" });
  });

  test("wait rejects a malformed job reference", async () => {
    const rt = authed();
    expect(await cli(rt, "wait", "monitor:only-one-part")).toBe(2);
  });
});

describe("contract", () => {
  test.each([
    ["pending", false, false],
    ["generating", false, false],
    ["success", true, true],
    ["ready", true, true],
    ["failed", true, false],
    ["budget_exceeded", true, false],
  ])("classify(%s)", (s, done, ok) => expect(classify(s)).toEqual({ done, ok }));

  test("every command's --help includes a runnable example", async () => {
    const leaves: string[][] = [];
    const walk = (cmd: Command, path: string[]) => {
      const subs = cmd.commands.filter((c) => c.name() !== "help");
      if (!subs.length) leaves.push(path);
      for (const c of subs) walk(c, [...path, c.name()]);
    };
    walk(buildProgram(testRuntime(), false), []);
    expect(leaves.length).toBeGreaterThan(25);
    for (const path of leaves) {
      const rt = testRuntime();
      expect(await cli(rt, ...path, "--help")).toBe(0);
      expect({ path: path.join(" "), hasExample: rt.out().includes("$ topcited") }).toEqual({ path: path.join(" "), hasExample: true });
    }
  });
});
