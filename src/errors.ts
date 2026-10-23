/** Exit codes (design D4). Agents branch on these, so they never change meaning. */
export const Exit = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  PAYMENT: 4,
  NOT_FOUND: 5,
  CONFLICT: 6,
  WAIT_TIMEOUT: 7,
} as const;
export type ExitCode = (typeof Exit)[keyof typeof Exit];

export interface CliErrorInit {
  exit: ExitCode;
  code: string;
  message: string;
  hint?: string;
  status?: number;
  /** Extra machine-readable fields for the JSON envelope (e.g. `job` on a wait timeout). */
  extra?: Record<string, unknown>;
}

/** Every failure the CLI reports goes through this, so exit code and envelope stay consistent. */
export class CliError extends Error {
  readonly exit: ExitCode;
  readonly code: string;
  readonly hint?: string;
  readonly status?: number;
  readonly extra?: Record<string, unknown>;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.exit = init.exit;
    this.code = init.code;
    this.hint = init.hint;
    this.status = init.status;
    this.extra = init.extra;
  }

  /** The stderr JSON envelope: `{code, message, hint, status, ...extra}`. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint ?? null,
      status: this.status ?? null,
      ...this.extra,
    };
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError({ exit: Exit.USAGE, code: "usage", message, hint });
}

export function notLoggedIn(): CliError {
  return new CliError({
    exit: Exit.AUTH,
    code: "not_logged_in",
    message: "Not logged in.",
    hint: "Run `topcited auth login`, or set TOPCITED_API_KEY.",
  });
}

/** Pull a human message and a server error code out of the backend's error bodies. */
function describeBody(body: unknown): { message?: string; code?: string } {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? { message: body } : {};
  const b = body as Record<string, unknown>;
  // AppException: {"error": {"code", "message", "details"}}
  if (b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    return { message: str(e.message), code: str(e.code) };
  }
  // RFC 8628 / OAuth: {"error": "authorization_pending", "error_description"?}
  if (typeof b.error === "string") return { code: b.error, message: str(b.error_description) ?? b.error };
  // FastAPI HTTPException: {"detail": "..."}; validation: {"detail": [{loc, msg}]}
  if (typeof b.detail === "string") return { message: b.detail };
  if (Array.isArray(b.detail)) {
    const parts = b.detail.map((d: Record<string, unknown>) => {
      const loc = Array.isArray(d.loc) ? d.loc.filter((x) => x !== "body").join(".") : "";
      return loc ? `${loc}: ${d.msg}` : String(d.msg);
    });
    return { message: parts.join("; "), code: "validation_error" };
  }
  if (b.detail && typeof b.detail === "object") return describeBody({ error: b.detail });
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export interface HttpErrorContext {
  /** Where to send people for keys and billing, e.g. https://topcited.ai */
  uiUrl: string;
  /** True when the key came from TOPCITED_API_KEY (changes the auth hint). */
  keyFromEnv?: boolean;
}

/** Map an HTTP error response to a CliError with the D4 exit code. */
export function fromHttp(status: number, body: unknown, ctx: HttpErrorContext): CliError {
  const { message, code } = describeBody(body);
  const msg = message ?? `HTTP ${status}`;
  switch (status) {
    case 401:
      return new CliError({
        exit: Exit.AUTH,
        code: code?.toLowerCase() ?? "unauthorized",
        status,
        message: `Authentication failed: ${msg}`,
        hint: ctx.keyFromEnv
          ? "TOPCITED_API_KEY is missing, expired or revoked. Mint a new key, or unset it and run `topcited auth login`."
          : "Your API key is missing, expired or revoked. Run `topcited auth login`.",
      });
    case 402:
      return new CliError({
        exit: Exit.PAYMENT,
        code: code?.toLowerCase() ?? "payment_required",
        status,
        message: msg,
        hint: `Not enough T-coins or plan quota. Check \`topcited usage\`; top up at ${ctx.uiUrl}/settings/billing.`,
      });
    case 404:
    case 405:
      // FastAPI's bare {"detail": "Not Found"} means no such route: version skew,
      // not a missing resource.
      if (status === 405 || msg === "Not Found") {
        return new CliError({
          exit: Exit.ERROR,
          code: "unsupported_operation",
          status,
          message: "The server does not support this operation.",
          hint: "This command needs a newer CLI (`topcited upgrade`), or TOPCITED_BASE_URL points at an older server.",
        });
      }
      return new CliError({ exit: Exit.NOT_FOUND, code: code?.toLowerCase() ?? "not_found", status, message: msg });
    case 409:
      return new CliError({ exit: Exit.CONFLICT, code: code?.toLowerCase() ?? "conflict", status, message: msg });
    case 429:
      return new CliError({
        exit: Exit.ERROR,
        code: "rate_limited",
        status,
        message: msg,
        hint: "Too many requests; retry in a minute.",
      });
    default:
      return new CliError({
        exit: Exit.ERROR,
        code: code?.toLowerCase() ?? (status >= 500 ? "server_error" : "request_failed"),
        status,
        message: msg,
        hint: status >= 500 ? "Server error; retry, and run `topcited doctor` if it persists." : undefined,
      });
  }
}

export function networkError(baseUrl: string, cause: unknown): CliError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new CliError({
    exit: Exit.ERROR,
    code: "network_error",
    message: `Could not reach ${baseUrl}: ${reason}`,
    hint: "Check your connection and TOPCITED_BASE_URL, then run `topcited doctor`.",
  });
}
