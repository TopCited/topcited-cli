import { Command, CommanderError } from "commander";
import { registerApi } from "./commands/api";
import { registerAuth } from "./commands/auth";
import { registerBrand } from "./commands/brand";
import { registerDoctor } from "./commands/doctor";
import { registerUpgrade } from "./commands/upgrade";
import { registerUsage } from "./commands/usage";
import type { Action, Register } from "./commands/types";
import { Context, type GlobalOptions } from "./context";
import { CliError, Exit, type ExitCode } from "./errors";
import { defaultRuntime, type Runtime } from "./runtime";
import { checkForUpdate } from "./update-notice";
import { VERSION } from "./version";

const REGISTER: Register[] = [registerAuth, registerBrand, registerUsage, registerApi, registerDoctor, registerUpgrade];

const HELP_FOOTER = `
Common flows:
  $ topcited auth login                    sign in (prints a URL and code to approve)
  $ topcited brand list                    your brands
  $ topcited usage                         plan and T-coin balance
  $ topcited api /monitoring/query-sets    any public endpoint, raw
  $ topcited doctor                        diagnose config, auth, connectivity

Agents: output is JSON when stdout is not a terminal (or with --json); errors
are a JSON object on stderr; exit codes: 0 ok, 1 error, 2 usage, 3 auth,
4 payment/quota, 5 not found, 6 conflict, 7 --wait timed out.
Env: TOPCITED_API_KEY, TOPCITED_BASE_URL, TOPCITED_BRAND.`;

export function buildProgram(rt: Runtime, jsonHint: boolean): Command {
  const program = new Command("topcited")
    .description("TopCited: AI visibility (GEO) from your terminal and your agents.")
    .version(VERSION, "-v, --version")
    .option("--json", "print JSON (default when stdout is not a terminal)")
    .option("--base-url <url>", "API base URL (default: $TOPCITED_BASE_URL or https://api.topcited.ai)")
    .option("--brand <brand>", "brand id, id prefix or name (default: $TOPCITED_BRAND or `brand use`)")
    .addHelpText("after", HELP_FOOTER)
    .showHelpAfterError(!jsonHint)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => rt.stdout(s),
      writeErr: (s) => rt.stderr(s),
      // In JSON mode the usage error goes out as an envelope instead (see run()).
      outputError: (s, write) => (jsonHint ? undefined : write(s)),
    });

  const action: Action = (handler) => async (...args: unknown[]) => {
    const cmd = args.at(-1) as Command;
    const opts = args.at(-2) as Record<string, unknown>;
    const positional = args.slice(0, -2);
    const ctx = await Context.create(rt, cmd.optsWithGlobals<GlobalOptions>());
    await handler(ctx, opts, ...positional);
  };
  for (const register of REGISTER) register(program, action);
  return program;
}

function emitError(rt: Runtime, err: CliError, json: boolean): void {
  if (json) rt.stderr(JSON.stringify(err.toJSON()) + "\n");
  else rt.stderr(`error: ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ""}`);
}

/** Run the CLI; resolves to the process exit code. */
export async function run(argv: string[], rt: Runtime = defaultRuntime()): Promise<ExitCode> {
  const jsonHint = argv.includes("--json") || !rt.stdoutIsTTY;
  const program = buildProgram(rt, jsonHint);
  // No notice for `upgrade` itself, or in JSON mode (stderr stays JSON Lines).
  const notice = argv[0] === "upgrade" || jsonHint ? Promise.resolve(undefined) : checkForUpdate(rt).catch(() => undefined);
  try {
    await program.parseAsync(argv, { from: "user" });
    const update = await notice;
    if (update) {
      rt.stderr(update.text);
      await update.shown();
    }
    return Exit.OK;
  } catch (e) {
    await notice; // let the check finish its state write; no notice on failure
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.exitCode === 0) return Exit.OK;
      // Bare `topcited` / `topcited auth` prints help: fine for a person, a usage
      // error for a program (its stdout got help text, not JSON).
      if (e.code === "commander.help") {
        if (!jsonHint) return Exit.OK;
        emitError(rt, new CliError({ exit: Exit.USAGE, code: "usage", message: "Missing subcommand.", hint: "See `topcited <command> --help`." }), true);
        return Exit.USAGE;
      }
      const message = e.message.replace(/^error: /, "");
      if (jsonHint) emitError(rt, new CliError({ exit: Exit.USAGE, code: "usage", message }), true);
      return Exit.USAGE;
    }
    const err =
      e instanceof CliError
        ? e
        : new CliError({ exit: Exit.ERROR, code: "internal_error", message: e instanceof Error ? e.message : String(e) });
    emitError(rt, err, jsonHint);
    return err.exit;
  }
}
