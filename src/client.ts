import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./generated/schema";
import { userAgent } from "./version";

export const DEFAULT_BASE_URL = "https://api.topcited.ai";

export type ApiClient = Client<paths>;

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

/** Typed client over the public OpenAPI contract (src/generated/schema.d.ts). */
export function createApiClient(opts: ClientOptions): ApiClient {
  const headers: Record<string, string> = { "User-Agent": userAgent() };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  return createClient<paths>({
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    headers,
    fetch: opts.fetch,
  });
}
