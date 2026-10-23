import { Command } from "commander";
import { VERSION } from "./version";

export function buildProgram(): Command {
  const program = new Command("topcited")
    .description("TopCited: AI visibility (GEO) from your terminal and your agents.")
    .version(VERSION, "-v, --version")
    .showHelpAfterError();
  return program;
}

export async function run(argv: string[]): Promise<number> {
  await buildProgram().parseAsync(argv, { from: "user" });
  return 0;
}
