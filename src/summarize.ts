import type { Status, Summary } from "./types.js";

/** Anything with a status and a return: a published row or a graded call. */
export interface Summarizable {
  status: Status;
  return_pct?: number | null;
  returnPct?: number | null;
}

/**
 * Summary exactly as the scorecard publishes it (SPEC §7). Only closed calls count toward
 * `winRate` and `avgReturnPct`; a missing return counts as 0.
 */
export function summarize(calls: readonly Summarizable[]): Summary {
  const closed = calls.filter((c) => c.status !== "open");
  const wins = closed.filter((c) => c.status === "win").length;
  const avgReturnPct = closed.length
    ? closed.reduce((s, c) => s + (c.return_pct ?? c.returnPct ?? 0), 0) / closed.length
    : null;
  return {
    total: calls.length,
    open: calls.length - closed.length,
    closed: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: closed.length ? wins / closed.length : null,
    avgReturnPct,
  };
}
