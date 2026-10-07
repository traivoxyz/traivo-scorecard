import type { Scorecard } from "./types.js";

export const DEFAULT_BASE_URL = "https://dapp.traivo.xyz";

/**
 * Endpoint URL from a base URL (`https://dapp.traivo.xyz`) or a full endpoint URL.
 * With `profile`, points at the opt-in public profile of that handle or address.
 */
export function scorecardUrl(input: string = DEFAULT_BASE_URL, profile?: string): string {
  const u = new URL(input);
  if (/\/api\/(scorecard|profiles\/[^/]+)\/?$/.test(u.pathname)) return u.toString();
  const base = u.pathname.replace(/\/+$/, "");
  u.pathname = profile ? `${base}/api/profiles/${encodeURIComponent(profile)}` : `${base}/api/scorecard`;
  u.search = "";
  return u.toString();
}

/** Validate the top-level shape of a scorecard payload. Row-level problems are left to `checkScorecard`. */
export function parseScorecard(json: unknown): Scorecard {
  const o = json as { summary?: unknown; suggestions?: unknown } | null;
  if (!o || typeof o !== "object") throw new Error("scorecard payload is not a JSON object");
  if (!o.summary || typeof o.summary !== "object") throw new Error("scorecard payload has no summary object");
  if (!Array.isArray(o.suggestions)) throw new Error("scorecard payload has no suggestions array");
  if (!o.suggestions.every((r) => r && typeof r === "object")) throw new Error("suggestions must be objects");
  return o as Scorecard;
}

export interface FetchOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  userAgent?: string;
}

/** Download and shape-check a public scorecard (or public profile). */
export async function fetchScorecard(url: string, opts: FetchOptions = {}): Promise<Scorecard> {
  const f = opts.fetch ?? globalThis.fetch;
  const res = await f(url, {
    headers: { accept: "application/json", "user-agent": opts.userAgent ?? "traivo-scorecard" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  return parseScorecard(await res.json());
}
