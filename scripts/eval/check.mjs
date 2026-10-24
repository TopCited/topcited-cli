// Grades a fresh-agent eval run (.github/workflows/agent-eval.yml).
// Plain Node, no dependencies: the eval job installs nothing but Claude Code.
//
//   node check.mjs --transcript run.jsonl --truth results.json --results-exit 0 --installed /path/to/topcited
//
// Exits 0 when every check passes; prints a Markdown report either way.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A Bash command the agent ran that asks for monitoring results or gaps. */
const RESULTS_COMMAND = /\btopcited\b[^\n|;&]*\b(monitor\s+results|api\s+\S*monitoring\/(gaps|metrics|share-of-voice))/;

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[“”"'‘’`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse Claude Code `--output-format stream-json` lines. */
export function parseTranscript(text) {
  const commands = [];
  let result;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c.type === "tool_use" && c.name === "Bash" && typeof c.input?.command === "string") commands.push(c.input.command);
      }
    } else if (ev.type === "result") {
      result = ev;
    }
  }
  return { commands, result };
}

/** Gap prompts from `topcited monitor results --json`. */
export function gapTexts(truth) {
  return (truth?.sets ?? []).flatMap((s) => (s.gaps ?? []).map((g) => g.query_text)).filter(Boolean);
}

export function evaluate({ transcript, truth, resultsExit, installed, maxTurns }) {
  const { commands, result } = parseTranscript(transcript);
  const answer = normalize(result?.result ?? "");
  const gaps = gapTexts(truth);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add("agent finished", Boolean(result) && !result.is_error, result ? `${result.subtype ?? "?"} after ${result.num_turns ?? "?"} turns` : "no result event (timed out or crashed)");
  if (maxTurns && result?.num_turns) add("within turn cap", result.num_turns <= maxTurns, `${result.num_turns}/${maxTurns}`);
  add("CLI installed", Boolean(installed), installed || "no topcited binary on PATH or in ~/.local/bin");
  const ran = commands.filter((c) => RESULTS_COMMAND.test(c));
  add("agent ran a results command", ran.length > 0, ran[0] ?? `none of ${commands.length} Bash commands`);
  add("`topcited monitor results` exits 0", resultsExit === 0, `exit ${resultsExit}`);

  if (!gaps.length) {
    add("answer reflects no gaps", /\bno (visibility )?gaps\b|\bnot? .*gaps? found\b|\bzero gaps\b/.test(answer), "ground truth has no gaps");
  } else {
    // Match a gap by its full prompt, or by its first 40 characters (agents trim long prompts).
    const named = gaps.filter((g) => {
      const n = normalize(g);
      return answer.includes(n) || (n.length > 40 && answer.includes(n.slice(0, 40)));
    });
    add("answer names gaps", named.length > 0, named.length ? `${named.length}/${gaps.length} named, e.g. "${named[0]}"` : `none of ${gaps.length} gaps named`);
  }
  return { pass: checks.every((c) => c.ok), checks, answer: result?.result ?? "" };
}

export function report(r) {
  const rows = r.checks.map((c) => `| ${c.ok ? "✅" : "❌"} | ${c.name} | ${String(c.detail).replace(/\|/g, "\\|").slice(0, 200)} |`);
  return [
    `## Fresh-agent eval: ${r.pass ? "PASS" : "FAIL"}`,
    "",
    "| | Check | Detail |",
    "|---|---|---|",
    ...rows,
    "",
    "<details><summary>Final answer</summary>",
    "",
    r.answer || "(none)",
    "",
    "</details>",
    "",
  ].join("\n");
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const transcriptPath = arg("--transcript");
  const truthPath = arg("--truth");
  let truth;
  try {
    truth = truthPath && existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, "utf8")) : undefined;
  } catch {
    truth = undefined;
  }
  const r = evaluate({
    transcript: transcriptPath && existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "",
    truth,
    resultsExit: Number(arg("--results-exit") ?? 1),
    installed: arg("--installed") || "",
    maxTurns: Number(arg("--max-turns") ?? 0),
  });
  process.stdout.write(report(r));
  process.exit(r.pass ? 0 : 1);
}
