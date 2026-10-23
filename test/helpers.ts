import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { Store } from "../src/config";
import type { Runtime } from "../src/runtime";

export interface Recorded {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export type Route = (req: Recorded) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A local HTTP server standing in for the TopCited API; routes are tried in order. */
export function mockApi(routes: Record<string, Route | unknown>) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {}
      const rec: Recorded = { method: req.method, path: url.pathname, search: url.searchParams, headers: req.headers, body };
      requests.push(rec);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler === undefined) return json({ detail: "Not Found" }, 404);
      if (typeof handler === "function") return (await (handler as Route)(rec)) ?? json({ detail: "Not Found" }, 404);
      return json(handler);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    calls: (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path),
    stop: () => server.stop(true),
  };
}

export interface TestRuntime extends Runtime {
  out: () => string;
  err: () => string;
  outJson: () => any;
  /** stderr lines parsed as JSON (non-JSON lines dropped). */
  errJson: () => any[];
  sleeps: number[];
  opened: string[];
  dir: string;
}

/** A Runtime with a temp config dir, captured output, and an instant fake clock. */
export function testRuntime(opts: { env?: Record<string, string>; tty?: boolean; stdin?: string; answers?: string[] } = {}): TestRuntime {
  const dir = mkdtempSync(join(tmpdir(), "tc-cli-"));
  let out = "";
  let err = "";
  let clock = Date.parse("2026-10-23T12:00:00Z");
  const sleeps: number[] = [];
  const opened: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const rt: TestRuntime = {
    env: { ...opts.env },
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    stdoutIsTTY: Boolean(opts.tty),
    stderrIsTTY: Boolean(opts.tty),
    stdinIsTTY: Boolean(opts.tty),
    fetch: globalThis.fetch,
    store: new Store(dir),
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    openBrowser: (url) => {
      opened.push(url);
      return true;
    },
    readStdin: async () => opts.stdin ?? "",
    prompt: async () => answers.shift() ?? "",
    out: () => out,
    err: () => err,
    outJson: () => JSON.parse(out),
    errJson: () =>
      err
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        }),
    sleeps,
    opened,
    dir,
  };
  return rt;
}

export async function cli(rt: Runtime, ...argv: string[]) {
  return run(argv, rt);
}

export const ME = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "maya@example.com",
  created_at: "2026-01-01T00:00:00Z",
  plan_id: "growth",
  market: "global",
  available_platforms: ["chatgpt"],
  active_brand_id: "b0000000-0000-0000-0000-000000000001",
};

export const KEY = "tc_live1234567890abcdefghijklmnop";

export function keyRow(expiresAt: string) {
  return { id: "k1", prefix: KEY.slice(0, 12), is_admin: false, created_at: "2026-10-01T00:00:00Z", expires_at: expiresAt, last_used_at: null };
}
