import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * On-disk state under ~/.config/topcited (or $XDG_CONFIG_HOME/topcited, or
 * $TOPCITED_CONFIG_DIR):
 *   credentials.json (0600)  API keys, keyed by API base URL
 *   config.json              base URL and per-host settings (active brand)
 *   state.json               update-check bookkeeping
 * Keying by base URL lets one machine hold prod and staging logins side by side.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TOPCITED_CONFIG_DIR) return env.TOPCITED_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "topcited");
}

export interface StoredCredential {
  api_key: string;
  key_prefix: string;
  key_name?: string | null;
  expires_at?: string | null;
  user_email?: string | null;
  created_at: string;
}

export type Credentials = Record<string, StoredCredential>;

export interface HostConfig {
  brand_id?: string;
  brand_name?: string;
}

export interface Config {
  base_url?: string;
  hosts?: Record<string, HostConfig>;
}

export interface State {
  update_checked_at?: string;
  latest_version?: string;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  try {
    return (await file.json()) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomic write (temp file + rename) so a crash never leaves half a credentials
 * file. The temp file is created with its final mode, so a secret is never
 * readable by others even for a moment. The random suffix keeps concurrent
 * writers in one process from colliding.
 */
async function writeJson(path: string, data: unknown, mode: number): Promise<void> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (mode === 0o600) await chmod(dir, 0o700); // mkdir doesn't tighten an existing dir
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode, flag: "wx" });
    await chmod(tmp, mode); // the umask can only have removed bits; make it exact
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export class Store {
  constructor(readonly dir: string = configDir()) {}

  get credentialsPath(): string {
    return join(this.dir, "credentials.json");
  }
  get configPath(): string {
    return join(this.dir, "config.json");
  }
  get statePath(): string {
    return join(this.dir, "state.json");
  }
  get pendingLoginPath(): string {
    return join(this.dir, "pending-login.json");
  }

  readCredentials(): Promise<Credentials> {
    return readJson<Credentials>(this.credentialsPath, {});
  }
  async getCredential(baseUrl: string): Promise<StoredCredential | undefined> {
    return (await this.readCredentials())[baseUrl];
  }
  async setCredential(baseUrl: string, cred: StoredCredential): Promise<void> {
    const all = await this.readCredentials();
    all[baseUrl] = cred;
    await writeJson(this.credentialsPath, all, 0o600);
  }
  /** Returns whether a credential was removed. */
  async deleteCredential(baseUrl: string): Promise<boolean> {
    const all = await this.readCredentials();
    if (!(baseUrl in all)) return false;
    delete all[baseUrl];
    await writeJson(this.credentialsPath, all, 0o600);
    return true;
  }

  readConfig(): Promise<Config> {
    return readJson<Config>(this.configPath, {});
  }
  async getHost(baseUrl: string): Promise<HostConfig> {
    return (await this.readConfig()).hosts?.[baseUrl] ?? {};
  }
  async setHost(baseUrl: string, patch: HostConfig): Promise<void> {
    const cfg = await this.readConfig();
    cfg.hosts = { ...cfg.hosts, [baseUrl]: { ...cfg.hosts?.[baseUrl], ...patch } };
    await writeJson(this.configPath, cfg, 0o644);
  }

  readState(): Promise<State> {
    return readJson<State>(this.statePath, {});
  }
  async writeState(state: State): Promise<void> {
    await writeJson(this.statePath, state, 0o644);
  }

  /** Device logins waiting for approval, keyed by base URL like credentials. */
  async readPending<T>(baseUrl: string): Promise<T | undefined> {
    return (await readJson<Record<string, T>>(this.pendingLoginPath, {}))[baseUrl];
  }
  async writePending(baseUrl: string, data: unknown): Promise<void> {
    const all = await readJson<Record<string, unknown>>(this.pendingLoginPath, {});
    all[baseUrl] = data;
    await writeJson(this.pendingLoginPath, all, 0o600);
  }
  async clearPending(baseUrl: string): Promise<void> {
    const all = await readJson<Record<string, unknown>>(this.pendingLoginPath, {});
    if (!(baseUrl in all)) return;
    delete all[baseUrl];
    if (Object.keys(all).length) await writeJson(this.pendingLoginPath, all, 0o600);
    else await rm(this.pendingLoginPath, { force: true });
  }
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The web app that pairs with an API host: api.topcited.ai → topcited.ai. */
export function uiUrlFor(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.hostname.startsWith("api.")) u.hostname = u.hostname.slice(4);
    // Local dev: backend :8000, frontend :3000.
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.port = "3000";
    return u.origin;
  } catch {
    return "https://topcited.ai";
  }
}

export function keyPrefix(apiKey: string): string {
  return apiKey.slice(0, 12); // matches the backend's indexed key prefix (PREFIX_LEN)
}

/** `tc_abcd1234…wxyz`: enough to recognise a key, never enough to use it. */
export function maskKey(apiKey: string): string {
  return apiKey.length <= 16 ? `${apiKey.slice(0, 3)}…` : `${keyPrefix(apiKey)}…${apiKey.slice(-4)}`;
}
