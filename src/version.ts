import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** `topcited-cli/<version> (<os>; <arch>)` — the backend tags requests from this prefix. */
export function userAgent(): string {
  return `topcited-cli/${VERSION} (${process.platform}; ${process.arch})`;
}
