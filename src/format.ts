/** Human-readable rendering helpers. JSON output never goes through these. */

export type Column<T> = [header: string, value: (row: T) => unknown];

export function table<T>(rows: T[], columns: Column<T>[]): string {
  if (!rows.length) return "(none)";
  const cells = rows.map((r) => columns.map(([, get]) => cell(get(r))));
  const headers = columns.map(([h]) => h);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...cells.map(line)].join("\n");
}

function cell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (Array.isArray(v)) return v.join(",");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** `key: value` lines, aligned. */
export function fields(pairs: [string, unknown][]): string {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${(k + ":").padEnd(w + 1)}  ${cell(v)}`).join("\n");
}

export function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "-";
}

export function when(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "-";
}
