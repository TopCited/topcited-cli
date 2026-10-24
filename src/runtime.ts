import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Store } from "./config";

/**
 * Everything the CLI touches outside itself. Commands only go through this,
 * so tests can run the whole CLI in-process with fakes.
 */
export interface Runtime {
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  stdinIsTTY: boolean;
  fetch: typeof fetch;
  store: Store;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Best effort; returns false when no browser could be launched. */
  openBrowser: (url: string) => boolean;
  readStdin: () => Promise<string>;
  /** Only called when stdin and stderr are TTYs. */
  prompt: (question: string) => Promise<string>;
  /** The running executable, and how it was installed (decides what `upgrade` does). */
  execPath: string;
  install: InstallKind;
}

export type InstallKind = "binary" | "npm" | "source";

function installKind(): InstallKind {
  if (process.execPath.replaceAll("\\", "/").includes("/node_modules/@topcited/cli-")) return "npm";
  // Compiled binaries run their entry point from Bun's embedded filesystem.
  return Bun.main.includes("$bunfs") || Bun.main.includes("~BUN") ? "binary" : "source";
}

function canOpenBrowser(env: Runtime["env"]): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CI) return false;
  if (process.platform === "linux") return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return process.platform === "darwin" || process.platform === "win32";
}

export function defaultRuntime(): Runtime {
  const env = process.env;
  return {
    env,
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    fetch: globalThis.fetch,
    store: new Store(),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    openBrowser(url) {
      if (!canOpenBrowser(env)) return false;
      const [cmd, ...args] =
        process.platform === "darwin"
          ? ["open", url]
          : process.platform === "win32"
            ? ["cmd", "/c", "start", '""', url]
            : ["xdg-open", url];
      try {
        const child = spawn(cmd!, args, { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
        return true;
      } catch {
        return false;
      }
    },
    readStdin: () => new Response(Bun.stdin.stream()).text(),
    execPath: process.execPath,
    install: installKind(),
    async prompt(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}
