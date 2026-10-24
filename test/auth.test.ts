import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { cli, json, KEY, keyRow, ME, mockApi, testRuntime } from "./helpers";

let api: ReturnType<typeof mockApi> | undefined;
afterEach(() => api?.stop());

const DEVICE = {
  device_code: "dev-123",
  user_code: "BCDF-GHJK",
  verification_uri: "https://topcited.ai/device",
  verification_uri_complete: "https://topcited.ai/device?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};

function deviceApi(tokenResponses: Array<() => Response>) {
  let i = 0;
  return mockApi({
    "POST /api/v1/auth/device/code": DEVICE,
    "POST /api/v1/auth/device/token": () => tokenResponses[Math.min(i++, tokenResponses.length - 1)]!(),
    "GET /api/v1/users/me": ME,
    "GET /api/v1/users/me/api-keys": [keyRow("2027-01-21T00:00:00Z")],
  });
}

const pending = () => json({ error: "authorization_pending" }, 400);
const issued = () => json({ api_key: KEY, expires_at: "2027-01-21T00:00:00Z", name: "topcited-cli on box", user: { email: ME.email } });

describe("auth login resumes an interrupted sign-in (agents)", () => {
  test("re-running `auth login` reuses the saved code instead of minting a new one", async () => {
    api = deviceApi([issued]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--no-wait")).toBe(0);
    // The agent's shell killed the first command; it simply runs it again.
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(0);
    expect(api.calls("POST", "/api/v1/auth/device/code")).toHaveLength(1);
    // Agents (no TTY) see the resumed code in the device_authorization line on stderr.
    expect(rt.err().split("BCDF-GHJK").length - 1).toBeGreaterThanOrEqual(2);
    expect(await rt.store.getCredential(api.url)).toMatchObject({ api_key: KEY });
  });

  test("--restart discards the waiting sign-in and requests a new code", async () => {
    api = deviceApi([issued]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--no-wait")).toBe(0);
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--restart")).toBe(0);
    expect(api.calls("POST", "/api/v1/auth/device/code")).toHaveLength(2);
  });

  test("auth status points at the waiting sign-in", async () => {
    api = deviceApi([pending]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--no-wait")).toBe(0);
    expect(await cli(rt, "--base-url", api.url, "auth", "status")).toBe(3);
    const err = rt.errJson().at(-1);
    expect(err.code).toBe("login_pending");
    expect(err.hint).toContain("https://topcited.ai/device?code=BCDF-GHJK");
    expect(err.hint).toContain("topcited auth login");
  });
});

describe("auth login (device flow)", () => {
  test("polls through pending/slow_down, stores the key 0600, prints JSON", async () => {
    api = deviceApi([pending, () => json({ error: "slow_down" }, 400), pending, issued]);
    const rt = testRuntime({ env: { TOPCITED_BASE_URL: "" } });
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(0);

    const codeReq = api.calls("POST", "/api/v1/auth/device/code")[0]!;
    expect(codeReq.body).toMatchObject({ client_name: "topcited-cli", hostname: expect.any(String) });
    expect(codeReq.headers.get("user-agent")).toMatch(/^topcited-cli\/\S+ \(/);
    expect(api.calls("POST", "/api/v1/auth/device/token").map((r) => r.body)).toEqual(
      Array(4).fill({ device_code: "dev-123" }),
    );
    // slow_down adds 5 s to the interval for every later poll (RFC 8628 §3.5).
    expect(rt.sleeps).toEqual([5000, 5000, 10000, 10000]);

    // URL and code are always shown, as a JSON line on stderr in JSON mode.
    expect(rt.errJson()[0].device_authorization).toMatchObject({ user_code: "BCDF-GHJK", verification_uri: DEVICE.verification_uri });
    expect(rt.outJson()).toMatchObject({ logged_in: true, user: { email: ME.email }, expires_at: "2027-01-21T00:00:00Z" });

    const creds = await rt.store.readCredentials();
    expect(creds[api.url]).toMatchObject({ api_key: KEY, key_name: "topcited-cli on box", user_email: ME.email });
    expect(statSync(rt.store.credentialsPath).mode & 0o777).toBe(0o600);
    expect(await rt.store.readPending(api.url)).toBeUndefined();
    expect(rt.opened).toEqual([]); // no TTY → no browser
  });

  test("opens the browser and prints the code for a person at a terminal", async () => {
    api = deviceApi([issued]);
    const rt = testRuntime({ tty: true });
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(0);
    expect(rt.opened).toEqual([DEVICE.verification_uri_complete]);
    expect(rt.err()).toContain("BCDF-GHJK");
    expect(rt.out()).toContain(`Logged in to ${api.url} as ${ME.email}`);
  });

  test("--no-browser keeps the browser closed", async () => {
    api = deviceApi([issued]);
    const rt = testRuntime({ tty: true });
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--no-browser")).toBe(0);
    expect(rt.opened).toEqual([]);
  });

  test.each([
    ["access_denied", 3],
    ["expired_token", 3],
  ])("%s → exit %d", async (code, exit) => {
    api = deviceApi([() => json({ error: code }, 400)]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(exit as 3);
    expect(rt.errJson().at(-1).code).toBe(code);
    expect(await rt.store.getCredential(api.url)).toBeUndefined();
  });

  test("also understands RFC codes inside the app error envelope", async () => {
    api = deviceApi([() => json({ error: { code: "AUTHORIZATION_PENDING", message: "pending" } }, 400), issued]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(0);
  });

  test("the code expiring while pending → exit 3", async () => {
    api = deviceApi([pending]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(3);
    expect(rt.errJson().at(-1).code).toBe("expired_token");
    // 120 polls inside the 600 s window, plus one final poll past the deadline.
    expect(rt.sleeps.length).toBe(600 / 5 + 1);
  });

  test("an approval landing after the local deadline is still picked up", async () => {
    api = deviceApi([...Array(120).fill(pending), issued]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(0);
  });

  test("invalid_grant (already redeemed / long expired) → exit 3 like an expired code", async () => {
    api = deviceApi([() => json({ error: "invalid_grant" }, 400)]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(3);
    expect(rt.errJson().at(-1).code).toBe("expired_token");
    expect(await rt.store.getCredential(api.url)).toBeUndefined();
  });

  test("409 at the key cap → exit 6 with a revoke hint", async () => {
    api = deviceApi([() => json({ error: { code: "ALREADY_EXISTS", message: "cap" } }, 409)]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login")).toBe(6);
    expect(rt.errJson().at(-1)).toMatchObject({ code: "api_key_limit", status: 409, hint: expect.stringContaining("Revoke") });
  });

  test("--no-wait prints the code and exits; --continue finishes", async () => {
    api = deviceApi([issued]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--no-wait")).toBe(0);
    expect(rt.outJson()).toMatchObject({ user_code: "BCDF-GHJK", next: "topcited auth login --continue" });
    expect(api.calls("POST", "/api/v1/auth/device/token")).toHaveLength(0);

    const rt2 = testRuntime();
    rt2.store = rt.store;
    expect(await cli(rt2, "--base-url", api.url, "auth", "login", "--continue")).toBe(0);
    expect(rt2.outJson().logged_in).toBe(true);
    expect(api.calls("POST", "/api/v1/auth/device/code")).toHaveLength(1);
  });

  test("pending logins are kept per host", async () => {
    api = deviceApi([issued]);
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--no-wait")).toBe(0);
    const other = testRuntime();
    other.store = rt.store;
    // A login started against another host must not clobber this one.
    await other.store.writePending("https://api.staging.example", { device_code: "x" });
    expect(await cli(other, "--base-url", api.url, "auth", "login", "--continue")).toBe(0);
    expect(await rt.store.readPending("https://api.staging.example")).toEqual({ device_code: "x" });
  });

  test("--continue with nothing pending is a usage error", async () => {
    const rt = testRuntime();
    expect(await cli(rt, "--base-url", "http://127.0.0.1:1", "auth", "login", "--continue")).toBe(2);
  });

  test("--with-token validates and stores a key from stdin", async () => {
    api = deviceApi([]);
    const rt = testRuntime({ stdin: `${KEY}\n` });
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--with-token")).toBe(0);
    expect(await rt.store.getCredential(api.url)).toMatchObject({ api_key: KEY, expires_at: "2027-01-21T00:00:00Z" });
    expect(api.calls("GET", "/api/v1/users/me")[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  test("--with-token rejects a bad key with exit 3", async () => {
    api = mockApi({ "GET /api/v1/users/me": () => json({ error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401) });
    const rt = testRuntime({ stdin: "tc_bad" });
    expect(await cli(rt, "--base-url", api.url, "auth", "login", "--with-token")).toBe(3);
    expect(await rt.store.getCredential(api.url)).toBeUndefined();
  });
});

async function loggedIn(expiresAt: string, url: string) {
  const rt = testRuntime();
  await rt.store.setCredential(url, { api_key: KEY, key_prefix: KEY.slice(0, 12), expires_at: expiresAt, created_at: "2026-10-01T00:00:00Z" });
  return rt;
}

describe("auth status / token / logout", () => {
  test("status reports the user and days left", async () => {
    api = mockApi({ "GET /api/v1/users/me": ME, "GET /api/v1/users/me/api-keys": [keyRow("2027-01-21T12:00:00Z")] });
    const rt = await loggedIn("2027-01-21T12:00:00Z", api.url);
    expect(await cli(rt, "--base-url", api.url, "auth", "status")).toBe(0);
    expect(rt.outJson()).toMatchObject({ source: "file", user: { email: ME.email }, key: { days_left: 90 } });
  });

  test("warns when the key expires within 14 days", async () => {
    api = mockApi({ "GET /api/v1/users/me": ME, "GET /api/v1/users/me/api-keys": [keyRow("2026-10-30T12:00:00Z")] });
    const rt = await loggedIn("2026-10-30T12:00:00Z", api.url);
    expect(await cli(rt, "--base-url", api.url, "auth", "status")).toBe(0);
    expect(rt.errJson()).toContainEqual({ warning: "key_expiring", message: expect.stringContaining("7 day") });
  });

  test("a locally expired key fails with exit 3 before any request", async () => {
    api = mockApi({});
    const rt = await loggedIn("2026-10-01T00:00:00Z", api.url);
    expect(await cli(rt, "--base-url", api.url, "auth", "status")).toBe(3);
    expect(rt.errJson().at(-1).code).toBe("key_expired");
    expect(api.requests).toHaveLength(0);
  });

  test("a revoked key (401) → exit 3 with the login hint", async () => {
    api = mockApi({ "GET /api/v1/users/me": () => json({ error: { code: "UNAUTHORIZED", message: "revoked" } }, 401) });
    const rt = await loggedIn("2027-01-21T00:00:00Z", api.url);
    expect(await cli(rt, "--base-url", api.url, "auth", "status")).toBe(3);
    expect(rt.errJson().at(-1).hint).toContain("topcited auth login");
  });

  test("not logged in → exit 3", async () => {
    const rt = testRuntime();
    expect(await cli(rt, "auth", "status")).toBe(3);
    expect(rt.errJson().at(-1).code).toBe("not_logged_in");
  });

  test("TOPCITED_API_KEY beats the stored key", async () => {
    const rt = await loggedIn("2027-01-21T00:00:00Z", "https://api.topcited.ai");
    rt.env.TOPCITED_API_KEY = "tc_fromenv_000000000000";
    expect(await cli(rt, "auth", "token", "--show")).toBe(0);
    expect(rt.out()).toBe("tc_fromenv_000000000000\n");
  });

  test("token is masked unless --show", async () => {
    const rt = await loggedIn("2027-01-21T00:00:00Z", "https://api.topcited.ai");
    expect(await cli(rt, "auth", "token")).toBe(0);
    expect(rt.out()).not.toContain(KEY);
    expect(rt.outJson()).toEqual({ key_prefix: KEY.slice(0, 12), source: "file" });
  });

  test("logout forgets only this host's key", async () => {
    const rt = await loggedIn("2027-01-21T00:00:00Z", "https://api.topcited.ai");
    await rt.store.setCredential("https://api.staging.example", { api_key: "tc_x", key_prefix: "tc_x", created_at: "" });
    expect(await cli(rt, "auth", "logout")).toBe(0);
    expect(rt.outJson()).toMatchObject({ logged_out: true, key_revoked: false });
    expect(Object.keys(await rt.store.readCredentials())).toEqual(["https://api.staging.example"]);
  });
});

describe("credential files", () => {
  test("tightens an existing config dir to 0700 when writing a secret", async () => {
    const rt = testRuntime();
    const { chmod } = await import("node:fs/promises");
    await chmod(rt.dir, 0o755);
    await rt.store.setCredential("https://api.topcited.ai", { api_key: KEY, key_prefix: "x", created_at: "" });
    expect(statSync(rt.dir).mode & 0o777).toBe(0o700);
    expect(statSync(rt.store.credentialsPath).mode & 0o777).toBe(0o600);
  });
});

describe("base URL precedence", () => {
  test("--base-url > TOPCITED_BASE_URL > config.json > default", async () => {
    const seen: string[] = [];
    const rt = testRuntime({ env: { TOPCITED_BASE_URL: "http://env.example", TOPCITED_API_KEY: KEY } });
    rt.fetch = (async (input: Request | string) => {
      seen.push(new URL(typeof input === "string" ? input : input.url).origin);
      return json(ME);
    }) as typeof fetch;
    await Bun.write(rt.store.configPath, JSON.stringify({ base_url: "http://config.example" }));

    await cli(rt, "--base-url", "http://flag.example", "auth", "status");
    await cli(rt, "auth", "status");
    delete rt.env.TOPCITED_BASE_URL;
    await cli(rt, "auth", "status");
    expect(seen.filter((_, i) => i % 2 === 0)).toEqual(["http://flag.example", "http://env.example", "http://config.example"]);
  });
});
