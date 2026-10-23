import type { Command } from "commander";
import type { Context, RawResponse } from "../context";
import { CliError, notLoggedIn, usageError } from "../errors";
import type { Action } from "./types";

const MAX_PAGES = 100;

export function registerApi(program: Command, action: Action): void {
  program
    .command("api")
    .description("Make an authenticated request to the TopCited API (like `gh api`)")
    .argument("<path>", "API path, e.g. /monitoring/query-sets (the /api/v1 prefix is optional)")
    .option("-X, --method <method>", "HTTP method (default: GET, or POST with --data)")
    .option("-d, --data <json>", "request body: JSON text, @file, or @- for stdin")
    .option("-f, --field <key=value>", "string field (query param for GET, JSON body otherwise); repeatable", collect, [])
    .option("-F, --typed-field <key=value>", "like -f, but true/false/null/numbers are typed; repeatable", collect, [])
    .option("-H, --header <name:value>", "extra request header; repeatable", collect, [])
    .option("-i, --include", "print the status line and response headers to stderr")
    .option("--paginate", "follow skip/limit pages and print all items as one array")
    .addHelpText(
      "after",
      `
Examples:
  $ topcited api /users/me
  $ topcited api /monitoring/runs -f limit=100 --paginate
  $ topcited api -X PATCH /monitoring/query-sets/<id> -d '{"paused": true}'
  $ topcited api -X POST /brands/<id>/competitors -f name=Acme -f website=acme.com

Spec: <base-url>/api/v1/openapi.public.json`,
    )
    .action(action(apiCommand));
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

interface ApiOptions {
  method?: string;
  data?: string;
  field: string[];
  typedField: string[];
  header: string[];
  include?: boolean;
  paginate?: boolean;
}

export function apiPath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.startsWith("/api/") ? p : `/api/v1${p}`;
}

function parseField(raw: string, typed: boolean): [string, unknown] {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw usageError(`Bad field "${raw}"; expected key=value.`);
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (!typed) return [key, value];
  if (value === "true" || value === "false") return [key, value === "true"];
  if (value === "null") return [key, null];
  if (value !== "" && !Number.isNaN(Number(value))) return [key, Number(value)];
  return [key, value];
}

async function readBody(ctx: Context, data: string): Promise<string> {
  if (data === "@-") return ctx.rt.readStdin();
  if (data.startsWith("@")) {
    const file = Bun.file(data.slice(1));
    if (!(await file.exists())) throw usageError(`No such file: ${data.slice(1)}`);
    return file.text();
  }
  return data;
}

async function apiCommand(ctx: Context, opts: ApiOptions, path: string): Promise<void> {
  const cred = await ctx.credential();
  if (!cred) throw notLoggedIn();
  await ctx.api(); // expiry checks

  const fields = [...opts.field.map((f) => parseField(f, false)), ...opts.typedField.map((f) => parseField(f, true))];
  let body: unknown;
  if (opts.data !== undefined) {
    const text = await readBody(ctx, opts.data);
    try {
      body = JSON.parse(text);
    } catch {
      throw usageError("--data is not valid JSON.");
    }
  }
  // Unlike `gh api`, fields alone don't switch to POST: most public reads take query params.
  const method = (opts.method ?? (body !== undefined ? "POST" : "GET")).toUpperCase();
  const url = new URL(apiPath(path), ctx.baseUrl + "/");
  if (method === "GET" || method === "DELETE") {
    for (const [k, v] of fields) url.searchParams.append(k, String(v));
  } else if (fields.length) {
    body = { ...(body as object), ...Object.fromEntries(fields) };
  }
  const headers = Object.fromEntries(
    opts.header.map((h) => {
      const i = h.indexOf(":");
      if (i <= 0) throw usageError(`Bad header "${h}"; expected name:value.`);
      return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
    }),
  );
  const send = (u: URL) => ctx.request(method, u.toString(), { body, apiKey: cred.apiKey, headers });

  if (opts.paginate) {
    if (method !== "GET") throw usageError("--paginate only works with GET.");
    return paginate(ctx, url, send, opts);
  }
  const res = await send(url);
  if (opts.include) printHead(ctx, res);
  await emit(ctx, res);
}

function printHead(ctx: Context, res: RawResponse): void {
  ctx.rt.stderr(`HTTP ${res.status}\n`);
  res.headers.forEach((v, k) => ctx.rt.stderr(`${k}: ${v}\n`));
  ctx.rt.stderr("\n");
}

/** Body to stdout as-is (pretty JSON when JSON); a non-2xx also fails with its mapped exit code. */
async function emit(ctx: Context, res: RawResponse): Promise<void> {
  if (res.body !== "" && res.body !== undefined) {
    ctx.rt.stdout(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2) + "\n");
  }
  if (!res.ok) throw await ctx.httpError(res);
}

/** skip/limit pagination; pages are arrays or `{items, total}`. */
async function paginate(ctx: Context, url: URL, send: (u: URL) => Promise<RawResponse>, opts: ApiOptions): Promise<void> {
  const limit = Number(url.searchParams.get("limit") ?? 100);
  url.searchParams.set("limit", String(limit));
  let skip = Number(url.searchParams.get("skip") ?? 0);
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    url.searchParams.set("skip", String(skip));
    const res = await send(url);
    if (opts.include) printHead(ctx, res);
    if (!res.ok) return emit(ctx, res);
    const b = res.body as { items?: unknown[]; total?: number } | unknown[];
    const items = Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : undefined;
    if (!items) {
      throw new CliError({ exit: 1, code: "not_paginated", message: "Response is not a list; drop --paginate." });
    }
    all.push(...items);
    const total = Array.isArray(b) ? undefined : b.total;
    if (items.length < limit || (total !== undefined && all.length >= total)) break;
    skip += items.length;
  }
  ctx.rt.stdout(JSON.stringify(all, null, 2) + "\n");
}
