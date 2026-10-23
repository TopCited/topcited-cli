import { describe, expect, test } from "bun:test";
import { uiUrlFor } from "../src/config";
import { Exit, fromHttp } from "../src/errors";
import { cli, testRuntime } from "./helpers";

const ctx = { uiUrl: "https://topcited.ai" };

describe("HTTP → exit code mapping (D4)", () => {
  test.each([
    [401, { error: { code: "UNAUTHORIZED", message: "bad key" } }, Exit.AUTH],
    [402, { error: { code: "QUOTA_EXCEEDED", message: "out of coins" } }, Exit.PAYMENT],
    [404, { error: { code: "NOT_FOUND", message: "Query set not found" } }, Exit.NOT_FOUND],
    [404, { detail: "Brand not found" }, Exit.NOT_FOUND],
    [409, { error: { code: "ALREADY_EXISTS", message: "dup" } }, Exit.CONFLICT],
    [422, { detail: [{ loc: ["body", "name"], msg: "Field required" }] }, Exit.ERROR],
    [500, { error: { code: "INTERNAL_ERROR", message: "boom" } }, Exit.ERROR],
  ])("%d → %d", (status, body, exit) => {
    expect(fromHttp(status, body, ctx).exit).toBe(exit);
  });

  test("402 points at billing", () => {
    expect(fromHttp(402, {}, ctx).hint).toContain("https://topcited.ai/settings/billing");
  });

  test("a missing route (bare Not Found / 405) is version skew, not a missing resource", () => {
    for (const [status, body] of [[404, { detail: "Not Found" }], [405, { detail: "Method Not Allowed" }]] as const) {
      const err = fromHttp(status, body, ctx);
      expect(err.code).toBe("unsupported_operation");
      expect(err.hint).toContain("topcited upgrade");
    }
  });

  test("validation errors list the fields", () => {
    expect(fromHttp(422, { detail: [{ loc: ["body", "name"], msg: "Field required" }] }, ctx).message).toBe(
      "name: Field required",
    );
  });

  test("env-key 401s don't tell you to log in", () => {
    expect(fromHttp(401, {}, { ...ctx, keyFromEnv: true }).hint).toContain("TOPCITED_API_KEY");
  });
});

describe("error envelope and usage errors", () => {
  test("network failure → exit 1, JSON envelope on stderr", async () => {
    const rt = testRuntime({ env: { TOPCITED_API_KEY: "tc_x" } });
    expect(await cli(rt, "--base-url", "http://127.0.0.1:9", "auth", "status")).toBe(1);
    const env = rt.errJson().at(-1);
    expect(Object.keys(env).sort()).toEqual(["code", "hint", "message", "status"]);
    expect(env.code).toBe("network_error");
  });

  test("unknown option → exit 2 with a usage envelope", async () => {
    const rt = testRuntime();
    expect(await cli(rt, "auth", "status", "--nope")).toBe(2);
    expect(rt.errJson().at(-1)).toMatchObject({ code: "usage" });
  });

  test("human mode prints error/hint lines", async () => {
    const rt = testRuntime({ tty: true });
    expect(await cli(rt, "auth", "status")).toBe(3);
    expect(rt.err()).toBe("error: Not logged in.\nhint: Run `topcited auth login`, or set TOPCITED_API_KEY.\n");
  });

  test("--help exits 0 and lists common flows", async () => {
    const rt = testRuntime();
    expect(await cli(rt, "--help")).toBe(0);
    expect(rt.out()).toContain("Common flows:");
  });
});

describe("uiUrlFor", () => {
  test.each([
    ["https://api.topcited.ai", "https://topcited.ai"],
    ["https://api.staging.topcited.cloud", "https://staging.topcited.cloud"],
    ["http://localhost:8000", "http://localhost:3000"],
  ])("%s → %s", (api, ui) => expect(uiUrlFor(api)).toBe(ui));
});
