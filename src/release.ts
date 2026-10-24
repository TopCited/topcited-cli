import type { Runtime } from "./runtime";
import { userAgent } from "./version";

export const REPO = "TopCited/topcited-cli";

export interface Release {
  tag: string;
  version: string;
  assets: { name: string; url: string }[];
}

/** GitHub token for release lookups while the repo is private (optional once public). */
function githubToken(env: Runtime["env"]): string | undefined {
  return env.TOPCITED_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
}

export function githubHeaders(env: Runtime["env"], accept = "application/vnd.github+json"): Record<string, string> {
  const token = githubToken(env);
  return { Accept: accept, "User-Agent": userAgent(), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** The latest published release, or undefined when it can't be determined. */
export async function latestRelease(rt: Runtime, timeoutMs = 5000): Promise<Release | undefined> {
  const api = rt.env.TOPCITED_RELEASES_API ?? `https://api.github.com/repos/${REPO}/releases/latest`;
  try {
    const res = await rt.fetch(api, { headers: githubHeaders(rt.env), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tag_name: string; assets?: { name: string; url: string }[] };
    return {
      tag: body.tag_name,
      version: body.tag_name.replace(/^v/, ""),
      assets: (body.assets ?? []).map((a) => ({ name: a.name, url: a.url })),
    };
  } catch {
    return undefined;
  }
}

/** -1, 0, 1 for semver-ish versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core!.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Asset name for this machine, matching scripts/targets.ts. */
export function assetName(platform = process.platform, arch = process.arch): string | undefined {
  const os = platform === "win32" ? "windows" : platform;
  if (!["linux", "darwin", "windows"].includes(os) || !["x64", "arm64"].includes(arch)) return undefined;
  if (os === "windows" && arch !== "x64") return undefined;
  return `topcited-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}
