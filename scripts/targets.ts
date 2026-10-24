// Release targets. `asset` is the GitHub Release file name (install.sh relies
// on it); `npm` is the per-platform npm package, keyed by Node's
// process.platform / process.arch so the launcher can find it.
export interface Target {
  bun: string;
  asset: string;
  os: "linux" | "darwin" | "win32";
  cpu: "x64" | "arm64";
}

export const TARGETS: Target[] = [
  // x64 uses Bun's "baseline" build so it runs on CPUs without AVX2 (older CI VMs).
  { bun: "bun-linux-x64-baseline", asset: "topcited-linux-x64", os: "linux", cpu: "x64" },
  { bun: "bun-linux-arm64", asset: "topcited-linux-arm64", os: "linux", cpu: "arm64" },
  { bun: "bun-darwin-x64-baseline", asset: "topcited-darwin-x64", os: "darwin", cpu: "x64" },
  { bun: "bun-darwin-arm64", asset: "topcited-darwin-arm64", os: "darwin", cpu: "arm64" },
  { bun: "bun-windows-x64-baseline", asset: "topcited-windows-x64.exe", os: "win32", cpu: "x64" },
];

export function npmPackageName(t: Target): string {
  return `@topcited/cli-${t.os}-${t.cpu}`;
}
