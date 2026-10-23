/** Fetch every page of a skip/limit list endpoint that returns a plain array. */
export async function pageAll<T>(fetchPage: (skip: number, limit: number) => Promise<T[]>, limit = 100): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; ; skip += limit) {
    const page = await fetchPage(skip, limit);
    out.push(...page);
    if (page.length < limit) return out;
  }
}
