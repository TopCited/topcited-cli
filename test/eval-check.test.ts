import { describe, expect, test } from "bun:test";
// @ts-expect-error plain JS module (runs under node in the eval job)
import { evaluate, gapTexts, parseTranscript, report } from "../scripts/eval/check.mjs";

const bash = (command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
const result = (text: string, extra: object = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 9, result: text, ...extra });
const TRUTH = {
  sets: [
    { name: "Core", gaps: [{ query_text: "best payroll software for startups", competitors_mentioned: ["Gusto"] }] },
    { name: "Other", gaps: [{ query_text: "How do I run payroll for contractors in multiple US states without an accountant?" }] },
  ],
};
const transcript = (answer: string) =>
  [bash("curl -fsSL http://127.0.0.1:8765/install.sh | sh"), bash("~/.local/bin/topcited monitor results --json"), result(answer)].join("\n");
const base = { truth: TRUTH, resultsExit: 0, installed: "/home/runner/.local/bin/topcited", maxTurns: 30 };

describe("fresh-agent eval checker", () => {
  test("passes when installed, results ran and exit 0, and the answer names a gap", () => {
    const r = evaluate({ ...base, transcript: transcript('Your top gaps: "Best payroll software for startups" (Gusto shows up, you don\'t).') });
    expect(r.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(report(r)).toContain("Fresh-agent eval: PASS");
  });

  test("a long gap prompt matches on its first 40 characters", () => {
    const r = evaluate({ ...base, transcript: transcript("Gap: how do I run payroll for contractors in multiple…") });
    expect(r.pass).toBe(true);
  });

  test("fails when the answer names no real gap", () => {
    const r = evaluate({ ...base, transcript: transcript("You should improve your SEO in general.") });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c: { name: string }) => c.name === "answer names gaps").ok).toBe(false);
  });

  test("fails without install, a results command, or a clean exit", () => {
    expect(evaluate({ ...base, installed: "", transcript: transcript("best payroll software for startups") }).pass).toBe(false);
    expect(evaluate({ ...base, resultsExit: 3, transcript: transcript("best payroll software for startups") }).pass).toBe(false);
    const noResults = [bash("topcited brand list"), result("best payroll software for startups")].join("\n");
    expect(evaluate({ ...base, transcript: noResults }).pass).toBe(false);
  });

  test("fails on a missing result event or too many turns", () => {
    expect(evaluate({ ...base, transcript: bash("topcited monitor results") }).pass).toBe(false);
    const long = [bash("topcited monitor results"), result("best payroll software for startups", { num_turns: 31 })].join("\n");
    expect(evaluate({ ...base, transcript: long }).pass).toBe(false);
  });

  test("with no gaps in ground truth, the answer must say so", () => {
    const truth = { sets: [{ gaps: [] }] };
    expect(evaluate({ ...base, truth, transcript: transcript("Good news: no visibility gaps right now.") }).pass).toBe(true);
    expect(evaluate({ ...base, truth, transcript: transcript("Your gaps are X and Y.") }).pass).toBe(false);
  });

  test("raw api calls to the gaps endpoint count as a results command", () => {
    const t = [bash("topcited api /monitoring/gaps -f query_set_id=x"), result("best payroll software for startups")].join("\n");
    expect(parseTranscript(t).commands).toHaveLength(1);
    expect(evaluate({ ...base, transcript: t }).pass).toBe(true);
  });

  test("gapTexts flattens every set", () => {
    expect(gapTexts(TRUTH)).toHaveLength(2);
    expect(gapTexts(undefined)).toEqual([]);
  });

  test("runs as a node script and exits non-zero on failure", async () => {
    const proc = Bun.spawn(["node", "scripts/eval/check.mjs", "--transcript", "/nonexistent", "--results-exit", "0"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(out).toContain("Fresh-agent eval: FAIL");
  });
});
