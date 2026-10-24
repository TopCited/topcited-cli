import { createApiClient, DEFAULT_BASE_URL, type ApiClient } from "./client";
import { normalizeBaseUrl, uiUrlFor, type StoredCredential } from "./config";
import { CliError, Exit, fromHttp, networkError, notLoggedIn, usageError } from "./errors";
import type { Runtime } from "./runtime";
import { userAgent } from "./version";

export const EXPIRY_WARNING_DAYS = 14;
const REQUEST_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;

export interface GlobalOptions {
  json?: boolean;
  baseUrl?: string;
  brand?: string;
}

export interface ResolvedCredential {
  apiKey: string;
  source: "env" | "file";
  stored?: StoredCredential;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: unknown;
}

/** openapi-fetch's result shape, minus the generics we don't need here. */
interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Per-invocation state: resolved base URL, output mode, credential, API client. */
export class Context {
  readonly json: boolean;
  private warned = new Set<string>();

  private constructor(
    readonly rt: Runtime,
    readonly baseUrl: string,
    readonly baseUrlSource: "flag" | "env" | "config" | "default",
    json: boolean,
    /** `--brand`, else TOPCITED_BRAND; see brand.ts for the rest of the chain. */
    readonly brandRef: string | undefined,
  ) {
    // JSON when asked, or when a program (not a person) reads stdout.
    this.json = json || !rt.stdoutIsTTY;
  }

  static async create(rt: Runtime, opts: GlobalOptions): Promise<Context> {
    let baseUrl: string;
    let source: Context["baseUrlSource"];
    if (opts.baseUrl) [baseUrl, source] = [opts.baseUrl, "flag"];
    else if (rt.env.TOPCITED_BASE_URL) [baseUrl, source] = [rt.env.TOPCITED_BASE_URL, "env"];
    else {
      const cfg = await rt.store.readConfig();
      [baseUrl, source] = cfg.base_url ? [cfg.base_url, "config"] : [DEFAULT_BASE_URL, "default"];
    }
    try {
      new URL(baseUrl);
    } catch {
      throw usageError(`Invalid base URL: ${baseUrl}`, "Use a full URL, e.g. https://api.topcited.ai");
    }
    return new Context(rt, normalizeBaseUrl(baseUrl), source, Boolean(opts.json), opts.brand ?? rt.env.TOPCITED_BRAND);
  }

  get uiUrl(): string {
    return this.rt.env.TOPCITED_UI_URL ? normalizeBaseUrl(this.rt.env.TOPCITED_UI_URL) : uiUrlFor(this.baseUrl);
  }

  /** Can we ask the user something? Never without a TTY (D4). */
  get interactive(): boolean {
    return this.rt.stdinIsTTY && this.rt.stderrIsTTY;
  }

  /** TOPCITED_API_KEY wins over the stored credential (D4). */
  async credential(): Promise<ResolvedCredential | undefined> {
    const envKey = this.rt.env.TOPCITED_API_KEY?.trim();
    if (envKey) return { apiKey: envKey, source: "env" };
    const stored = await this.rt.store.getCredential(this.baseUrl);
    return stored ? { apiKey: stored.api_key, source: "file", stored } : undefined;
  }

  /** Days until the stored key expires (fractional), or undefined if unknown. */
  daysLeft(cred: ResolvedCredential | undefined): number | undefined {
    const exp = cred?.stored?.expires_at;
    return exp ? (Date.parse(exp) - this.rt.now().getTime()) / DAY_MS : undefined;
  }

  /** Authenticated client; fails with exit 3 when there is no usable key. */
  async api(): Promise<ApiClient> {
    const cred = await this.credential();
    if (!cred) throw notLoggedIn();
    const days = this.daysLeft(cred);
    if (days !== undefined && days <= 0) {
      throw new CliError({
        exit: Exit.AUTH,
        code: "key_expired",
        message: `Your API key expired on ${cred.stored!.expires_at!.slice(0, 10)}.`,
        hint: "Run `topcited auth login`.",
      });
    }
    if (days !== undefined && days < EXPIRY_WARNING_DAYS) {
      this.warn(
        "key_expiring",
        `Your API key expires in ${Math.ceil(days)} day(s). Run \`topcited auth login\` to replace it.`,
      );
    }
    return this.client(cred.apiKey);
  }

  client(apiKey?: string): ApiClient {
    return createApiClient({ baseUrl: this.baseUrl, apiKey, fetch: this.fetch });
  }

  /** rt.fetch with a per-request timeout, so a stalled connection can't hang a command (or overrun --timeout). */
  readonly fetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
    this.rt.fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(this.requestTimeoutMs) })) as typeof fetch;

  get requestTimeoutMs(): number {
    const v = Number(this.rt.env.TOPCITED_HTTP_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : REQUEST_TIMEOUT_MS;
  }

  /** Unwrap an openapi-fetch call: data on 2xx, a mapped CliError otherwise. */
  async call<T>(request: Promise<FetchResult<T>>): Promise<T> {
    let res: FetchResult<T>;
    try {
      res = await request;
    } catch (e) {
      throw networkError(this.baseUrl, e);
    }
    if (!res.response.ok) {
      throw await this.httpError({ status: res.response.status, ok: false, headers: res.response.headers, body: res.error });
    }
    return res.data as T;
  }

  /**
   * Untyped request for endpoints outside the generated client (device auth,
   * `topcited api`). Never throws on HTTP status; network failures map to exit 1.
   */
  async request(
    method: string,
    path: string,
    opts: { body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { "User-Agent": userAgent(), Accept: "application/json", ...opts.headers };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] ??= "application/json";
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    let res: Response;
    try {
      res = await this.fetch(url, { method, headers, body });
    } catch (e) {
      throw networkError(this.baseUrl, e);
    }
    const text = await res.text();
    let parsed: unknown = text;
    if (text && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep the raw text
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body: parsed };
  }

  /** Turn a non-2xx raw response into the mapped CliError. */
  async httpError(res: RawResponse): Promise<CliError> {
    const cred = await this.credential();
    return fromHttp(res.status, res.body, { uiUrl: this.uiUrl, keyFromEnv: cred?.source === "env" });
  }

  /** Print a result: JSON on stdout for programs, the human rendering otherwise. */
  print(data: unknown, human?: string | (() => string)): void {
    if (this.json || human === undefined) {
      this.rt.stdout(JSON.stringify(data, null, 2) + "\n");
      return;
    }
    const text = typeof human === "function" ? human() : human;
    if (text) this.rt.stdout(text.endsWith("\n") ? text : text + "\n");
  }

  /** Progress and notes for humans; stays off stderr in JSON mode. */
  info(message: string): void {
    if (!this.json) this.rt.stderr(message + "\n");
  }

  /** Warnings: a JSON line on stderr in JSON mode, `warning: …` otherwise. Once per code. */
  warn(code: string, message: string): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    this.rt.stderr(this.json ? JSON.stringify({ warning: code, message }) + "\n" : `warning: ${message}\n`);
  }
}
