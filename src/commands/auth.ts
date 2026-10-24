import { hostname } from "node:os";
import type { Command } from "commander";
import { keyPrefix, maskKey, type StoredCredential } from "../config";
import type { Context, ResolvedCredential } from "../context";
import { CliError, Exit, notLoggedIn, usageError } from "../errors";
import { day, fields } from "../format";
import type { components } from "../generated/schema";
import { VERSION } from "../version";
import type { Action } from "./types";

type ApiKeyRead = components["schemas"]["ApiKeyRead"];
type UserRead = components["schemas"]["UserRead"];

const DEVICE_CODE_PATH = "/api/v1/auth/device/code";
const DEVICE_TOKEN_PATH = "/api/v1/auth/device/token";
const DEFAULT_INTERVAL_S = 5;
const MAX_NETWORK_RETRIES = 3;

/** RFC 8628 §3.2 device authorization response. */
interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/** Saved so `auth login --continue` can resume after the process is killed. */
interface PendingLogin extends DeviceCode {
  base_url: string;
  expires_at: string;
}

/** D3: the token endpoint issues an ordinary named API key. */
interface DeviceToken {
  api_key?: string;
  access_token?: string;
  expires_at?: string | null;
  name?: string | null;
  key_name?: string | null;
  user?: { email?: string | null } | null;
}

export function registerAuth(program: Command, action: Action): void {
  const auth = program.command("auth").description("Sign in, sign out, and inspect the stored API key");

  auth
    .command("login")
    .description("Sign in with your browser (device code); stores a named API key")
    .option("--no-browser", "don't try to open a browser; just print the URL and code")
    .option("--no-wait", "print the URL and code and exit; finish with `auth login --continue`")
    .option("--continue", "resume waiting for approval of the last code from `--no-wait`")
    .option("--with-token", "read an existing API key from stdin instead of the device flow")
    .addHelpText(
      "after",
      `
Examples:
  $ topcited auth login
  $ topcited auth login --no-wait && topcited auth login --continue   # agents without a live terminal
  $ echo "$KEY" | topcited auth login --with-token                     # CI`,
    )
    .action(action(login));

  auth
    .command("logout")
    .description("Forget the stored API key for this host")
    .addHelpText("after", "\nExample:\n  $ topcited auth logout")
    .action(action(logout));

  auth
    .command("status")
    .description("Show who you are signed in as, and when the key expires")
    .addHelpText("after", "\nExample:\n  $ topcited auth status --json")
    .action(action(status));

  auth
    .command("token")
    .description("Show the API key in use (masked unless --show)")
    .option("--show", "print the full key")
    .addHelpText("after", '\nExample:\n  $ curl -H "Authorization: Bearer $(topcited auth token --show)" …')
    .action(action(token));
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

interface LoginOptions {
  browser: boolean;
  wait: boolean;
  continue?: boolean;
  withToken?: boolean;
}

async function login(ctx: Context, opts: LoginOptions): Promise<void> {
  if (ctx.rt.env.TOPCITED_API_KEY) {
    ctx.warn("env_key_precedence", "TOPCITED_API_KEY is set and takes precedence over the key stored by login.");
  }
  if (opts.withToken) return loginWithToken(ctx);

  let pending: PendingLogin;
  if (opts.continue) {
    const saved = await ctx.rt.store.readPending<PendingLogin>(ctx.baseUrl);
    if (!saved) {
      throw usageError("No login is waiting for approval.", "Run `topcited auth login` to start one.");
    }
    pending = saved;
  } else {
    pending = await requestDeviceCode(ctx);
    await ctx.rt.store.writePending(ctx.baseUrl, pending);
    announce(ctx, pending, opts);
    if (!opts.wait) {
      ctx.print(
        {
          user_code: pending.user_code,
          verification_uri: pending.verification_uri,
          verification_uri_complete: pending.verification_uri_complete ?? null,
          expires_at: pending.expires_at,
          next: "topcited auth login --continue",
        },
        "Then run: topcited auth login --continue",
      );
      return;
    }
  }

  const issued = await pollForKey(ctx, pending);
  await ctx.rt.store.clearPending(ctx.baseUrl);
  await saveAndReport(ctx, issued);
}

async function requestDeviceCode(ctx: Context): Promise<PendingLogin> {
  const res = await ctx.request("POST", DEVICE_CODE_PATH, {
    body: { client_name: "topcited-cli", client_version: VERSION, hostname: hostname() },
  });
  if (!res.ok) throw await ctx.httpError(res);
  const code = res.body as DeviceCode;
  if (!code?.device_code || !code.user_code || !code.verification_uri) {
    throw new CliError({ exit: Exit.ERROR, code: "bad_response", message: "Unexpected response from the device-code endpoint." });
  }
  const expiresAt = new Date(ctx.rt.now().getTime() + (code.expires_in ?? 600) * 1000).toISOString();
  return { ...code, base_url: ctx.baseUrl, expires_at: expiresAt };
}

/** Always print the URL and code (D3); open the browser only when someone is there to see it. */
function announce(ctx: Context, p: PendingLogin, opts: LoginOptions): void {
  const url = p.verification_uri_complete ?? p.verification_uri;
  if (ctx.json) {
    ctx.rt.stderr(
      JSON.stringify({
        device_authorization: {
          user_code: p.user_code,
          verification_uri: p.verification_uri,
          verification_uri_complete: p.verification_uri_complete ?? null,
          expires_at: p.expires_at,
        },
      }) + "\n",
    );
  } else {
    ctx.rt.stderr(`To sign in, open ${p.verification_uri}\nand confirm this code matches: ${p.user_code}\n`);
  }
  if (opts.wait && opts.browser && ctx.interactive && ctx.rt.openBrowser(url)) ctx.info("Opened your browser.");
  if (opts.wait) ctx.info("Waiting for approval… (Ctrl-C to stop; resume with `topcited auth login --continue`)");
}

async function pollForKey(ctx: Context, p: PendingLogin): Promise<DeviceToken & { api_key: string }> {
  let interval = (p.interval ?? DEFAULT_INTERVAL_S) * 1000;
  const deadline = Date.parse(p.expires_at);
  let networkFailures = 0;

  while (ctx.rt.now().getTime() < deadline) {
    await ctx.rt.sleep(interval);
    let res;
    try {
      res = await ctx.request("POST", DEVICE_TOKEN_PATH, { body: { device_code: p.device_code } });
      networkFailures = 0;
    } catch (e) {
      if (++networkFailures > MAX_NETWORK_RETRIES) throw e;
      continue;
    }
    if (res.ok) {
      const body = res.body as DeviceToken;
      const apiKey = body.api_key ?? body.access_token;
      if (!apiKey) {
        throw new CliError({ exit: Exit.ERROR, code: "bad_response", message: "Device token response had no API key." });
      }
      return { ...body, api_key: apiKey };
    }
    if (res.status === 409) {
      await ctx.rt.store.clearPending(ctx.baseUrl);
      throw new CliError({
        exit: Exit.CONFLICT,
        code: "api_key_limit",
        status: 409,
        message: "You already have the maximum number of active API keys.",
        hint: `Revoke one at ${ctx.uiUrl}/settings (API keys), then run \`topcited auth login\` again.`,
      });
    }
    switch (deviceError(res.body)) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5000; // RFC 8628 §3.5
        continue;
      case "access_denied":
        await ctx.rt.store.clearPending(ctx.baseUrl);
        throw new CliError({ exit: Exit.AUTH, code: "access_denied", status: res.status, message: "Sign-in was denied in the browser." });
      case "expired_token":
        await ctx.rt.store.clearPending(ctx.baseUrl);
        throw expired();
      default:
        throw await ctx.httpError(res);
    }
  }
  await ctx.rt.store.clearPending(ctx.baseUrl);
  throw expired();
}

function expired(): CliError {
  return new CliError({
    exit: Exit.AUTH,
    code: "expired_token",
    message: "The sign-in code expired before it was approved.",
    hint: "Run `topcited auth login` again.",
  });
}

/** The RFC error code, whether sent bare (`{error: "slow_down"}`) or in the app envelope. */
function deviceError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const raw =
    typeof b.error === "string"
      ? b.error
      : ((b.error as Record<string, unknown> | undefined)?.code ?? (b.detail as Record<string, unknown> | undefined)?.error);
  return typeof raw === "string" ? raw.toLowerCase() : undefined;
}

async function loginWithToken(ctx: Context): Promise<void> {
  if (ctx.rt.stdinIsTTY) throw usageError("--with-token reads the key from stdin.", 'echo "$KEY" | topcited auth login --with-token');
  const apiKey = (await ctx.rt.readStdin()).trim();
  if (!apiKey) throw usageError("No API key on stdin.");
  await saveAndReport(ctx, { api_key: apiKey });
}

/** Verify the key against the API, look up its expiry, store it, and report. */
async function saveAndReport(ctx: Context, issued: DeviceToken & { api_key: string }): Promise<void> {
  const client = ctx.client(issued.api_key);
  const user = await ctx.call(client.GET("/api/v1/users/me"));
  const key = await findKey(ctx, issued.api_key);
  const cred: StoredCredential = {
    api_key: issued.api_key,
    key_prefix: keyPrefix(issued.api_key),
    key_name: issued.name ?? issued.key_name ?? null,
    expires_at: issued.expires_at ?? key?.expires_at ?? null,
    user_email: user.email,
    created_at: ctx.rt.now().toISOString(),
  };
  await ctx.rt.store.setCredential(ctx.baseUrl, cred);
  ctx.print(
    { logged_in: true, base_url: ctx.baseUrl, user: { id: user.id, email: user.email }, key_prefix: cred.key_prefix, expires_at: cred.expires_at },
    `✓ Logged in to ${ctx.baseUrl} as ${user.email}` + (cred.expires_at ? ` (key expires ${day(cred.expires_at)})` : ""),
  );
}

/** The caller's key row, matched on its prefix. Undefined if listing fails. */
async function findKey(ctx: Context, apiKey: string): Promise<ApiKeyRead | undefined> {
  try {
    const keys = await ctx.call(ctx.client(apiKey).GET("/api/v1/users/me/api-keys"));
    return keys.find((k) => apiKey.startsWith(k.prefix));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// logout / status / token
// ---------------------------------------------------------------------------

async function logout(ctx: Context): Promise<void> {
  const removed = await ctx.rt.store.deleteCredential(ctx.baseUrl);
  await ctx.rt.store.clearPending(ctx.baseUrl);
  if (ctx.rt.env.TOPCITED_API_KEY) ctx.warn("env_key_set", "TOPCITED_API_KEY is still set in your environment.");
  ctx.print(
    { logged_out: removed, base_url: ctx.baseUrl, key_revoked: false },
    removed
      ? `Logged out of ${ctx.baseUrl}. The key still works until it expires; revoke it at ${ctx.uiUrl}/settings.`
      : `Not logged in to ${ctx.baseUrl}.`,
  );
}

async function status(ctx: Context): Promise<void> {
  const cred = await ctx.credential();
  if (!cred) throw notLoggedIn();
  const client = await ctx.api();
  const user: UserRead = await ctx.call(client.GET("/api/v1/users/me"));
  const key = await findKey(ctx, cred.apiKey);
  const expiresAt = key?.expires_at ?? cred.stored?.expires_at ?? null;
  const daysLeft = expiresAt ? Math.floor((Date.parse(expiresAt) - ctx.rt.now().getTime()) / 86_400_000) : null;
  const data = {
    logged_in: true,
    base_url: ctx.baseUrl,
    source: cred.source,
    user: { id: user.id, email: user.email, plan_id: user.plan_id, market: user.market, active_brand_id: user.active_brand_id ?? null },
    key: { prefix: keyPrefix(cred.apiKey), name: cred.stored?.key_name ?? null, expires_at: expiresAt, days_left: daysLeft },
  };
  ctx.print(data, () =>
    fields([
      ["Host", ctx.baseUrl],
      ["User", user.email],
      ["Plan", user.plan_id],
      ["Key", `${maskKey(cred.apiKey)} (${sourceLabel(cred)})`],
      ["Expires", expiresAt ? `${day(expiresAt)} (${daysLeft} days)` : "never"],
    ]),
  );
}

async function token(ctx: Context, opts: { show?: boolean }): Promise<void> {
  const cred = await ctx.credential();
  if (!cred) throw notLoggedIn();
  if (opts.show) {
    // Bare key on a TTY or pipe alike, so `$(topcited auth token --show)` works.
    ctx.rt.stdout(cred.apiKey + "\n");
    return;
  }
  ctx.print(
    { key_prefix: keyPrefix(cred.apiKey), source: cred.source },
    `${maskKey(cred.apiKey)} (${sourceLabel(cred)}). Use --show to print the full key.`,
  );
}

function sourceLabel(cred: ResolvedCredential): string {
  return cred.source === "env" ? "from TOPCITED_API_KEY" : "stored";
}
