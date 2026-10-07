import { DEFAULT_HORIZON_S, STOP_PCT_RANGE, TP_PCT_RANGE, gradeSample, isPrice, returnPct } from "./grade.js";
import { summarize } from "./summarize.js";
import type { Call, Scorecard, ScorecardRow, Summary } from "./types.js";

/** Absolute tolerance for `return_pct` and summary rates, in the same units as the value (SPEC §6). */
export const RETURN_TOLERANCE = 1e-9;
/** The scorecard endpoint lists at most this many calls. */
export const LIST_LIMIT = 200;

export type IssueCode =
  // errors
  | "bad_row"
  | "duplicate_id"
  | "bad_levels"
  | "open_has_result"
  | "missing_result"
  | "resolved_before_created"
  | "return_mismatch"
  | "not_closable"
  | "reason_mismatch"
  | "status_mismatch"
  | "list_length"
  | "summary_arithmetic"
  | "summary_mismatch"
  // warnings
  | "level_bounds"
  | "unreachable_target"
  | "overdue";

export type Severity = "error" | "warning";

export interface Issue {
  /** Call id, or `null` for summary-level issues. */
  id: string | null;
  symbol?: string;
  side?: string;
  code: IssueCode;
  severity: Severity;
  message: string;
}

export interface CheckOptions {
  /**
   * Fallback horizon in seconds, used only for rows that do not publish `horizon_s`.
   * Default {@link DEFAULT_HORIZON_S} (7 days). A published `horizon_s` always wins.
   */
  horizonS?: number;
  /** Current Unix time in seconds. When set, open calls well past their horizon get an `overdue` warning. */
  now?: number;
  /** Grace after the horizon before `overdue` is reported. Default 1 hour. */
  overdueGraceS?: number;
}

export interface Report {
  /** Fallback horizon used for rows without `horizon_s`. */
  horizonS: number;
  /** Rows that did not publish `horizon_s`, so the fallback horizon was assumed for them. */
  horizonAssumed: number;
  calls: number;
  open: number;
  closed: number;
  /** True when the summary covered exactly the published calls and was recomputed from them. */
  summaryRecomputed: boolean;
  errors: number;
  warnings: number;
  issues: Issue[];
}

const ERRORS: ReadonlySet<IssueCode> = new Set([
  "bad_row",
  "duplicate_id",
  "bad_levels",
  "open_has_result",
  "missing_result",
  "resolved_before_created",
  "return_mismatch",
  "not_closable",
  "reason_mismatch",
  "status_mismatch",
  "list_length",
  "summary_arithmetic",
  "summary_mismatch",
]);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || num(v);
const close = (a: number, b: number, tol = RETURN_TOLERANCE) => Math.abs(a - b) <= tol;
const fmt = (n: number) => String(Number(n.toPrecision(12)));

/** Shape check for one published row; returns a reason when it is not usable. */
function shapeError(r: Record<string, unknown>): string | null {
  if (typeof r.id !== "string" || !r.id) return "id must be a non-empty string";
  if (r.side !== "buy" && r.side !== "sell") return `side must be "buy" or "sell", got ${JSON.stringify(r.side)}`;
  if (r.status !== "open" && r.status !== "win" && r.status !== "loss")
    return `status must be open, win or loss, got ${JSON.stringify(r.status)}`;
  if (r.reason !== null && r.reason !== "tp" && r.reason !== "sl" && r.reason !== "expiry")
    return `reason must be tp, sl, expiry or null, got ${JSON.stringify(r.reason)}`;
  for (const k of ["created_at", "entry", "stop", "target"] as const)
    if (!num(r[k])) return `${k} must be a finite number`;
  for (const k of ["resolved_at", "exit", "return_pct"] as const)
    if (!numOrNull(r[k])) return `${k} must be a finite number or null`;
  if (r.horizon_s !== undefined && r.horizon_s !== null && !(num(r.horizon_s) && r.horizon_s > 0))
    return "horizon_s must be a finite number above zero when present";
  if (!isPrice(r.entry)) return "entry must be above zero";
  return null;
}

/** True when the row publishes a usable `horizon_s`. */
export function hasHorizon(row: Pick<ScorecardRow, "horizon_s">): row is { horizon_s: number } {
  return num(row.horizon_s) && row.horizon_s > 0;
}

/**
 * The grader's view of a published row. Uses the row's own `horizon_s` when published,
 * otherwise `fallbackHorizonS` (default 7 days).
 */
export function toCall(row: ScorecardRow, fallbackHorizonS = DEFAULT_HORIZON_S): Call {
  return {
    side: row.side,
    entry: row.entry,
    stop: row.stop,
    target: row.target,
    createdAt: row.created_at,
    horizonS: hasHorizon(row) ? row.horizon_s : fallbackHorizonS,
  };
}

/**
 * Internal consistency of one published call (SPEC §9): levels sit on the right side of entry,
 * and for a closed call, re-grading its own recorded sample `(resolved_at, exit)` gives back its
 * status, reason and return. This does not replay the price path.
 */
export function checkRow(row: ScorecardRow, opts: CheckOptions = {}): Issue[] {
  const raw = row as unknown as Record<string, unknown>;
  const base = {
    id: typeof raw.id === "string" ? raw.id : null,
    symbol: typeof raw.symbol === "string" ? raw.symbol : undefined,
    side: typeof raw.side === "string" ? raw.side : undefined,
  };
  const issues: Issue[] = [];
  const add = (code: IssueCode, message: string) =>
    issues.push({ ...base, code, severity: ERRORS.has(code) ? "error" : "warning", message });

  const bad = shapeError(raw);
  if (bad) {
    add("bad_row", bad);
    return issues;
  }

  const { side, entry, stop, target } = row;
  const horizonS = hasHorizon(row) ? row.horizon_s : (opts.horizonS ?? DEFAULT_HORIZON_S);
  const ordered = side === "buy" ? stop < entry && entry < target : target < entry && entry < stop;
  if (!ordered)
    add(
      "bad_levels",
      side === "buy"
        ? `buy needs stop < entry < target, got stop ${fmt(stop)}, entry ${fmt(entry)}, target ${fmt(target)}`
        : `sell needs target < entry < stop, got target ${fmt(target)}, entry ${fmt(entry)}, stop ${fmt(stop)}`,
    );
  else {
    const stopPct = side === "buy" ? (1 - stop / entry) * 100 : (stop / entry - 1) * 100;
    const tpPct = side === "buy" ? (target / entry - 1) * 100 : (1 - target / entry) * 100;
    const inRange = (v: number, [lo, hi]: readonly [number, number]) => v >= lo - 1e-6 && v <= hi + 1e-6;
    if (!inRange(stopPct, STOP_PCT_RANGE) || !inRange(tpPct, TP_PCT_RANGE))
      add(
        "level_bounds",
        `implied stop ${fmt(stopPct)}% / take-profit ${fmt(tpPct)}% outside the app's ranges ${STOP_PCT_RANGE.join("–")}% / ${TP_PCT_RANGE.join("–")}%`,
      );
    if (side === "sell" && target <= 0) add("unreachable_target", `sell target ${fmt(target)} can never be reached`);
  }

  if (row.status === "open") {
    const leftovers = (["reason", "resolved_at", "exit", "return_pct"] as const).filter((k) => row[k] !== null);
    if (leftovers.length) add("open_has_result", `open call has ${leftovers.join(", ")} set`);
    if (opts.now !== undefined && opts.now >= row.created_at + horizonS + (opts.overdueGraceS ?? 3600))
      add("overdue", `still open ${fmt((opts.now - row.created_at) / 86400)} days after it was logged`);
    return issues;
  }

  if (row.reason === null || row.resolved_at === null || row.exit === null || row.return_pct === null) {
    const missing = (["reason", "resolved_at", "exit", "return_pct"] as const).filter((k) => row[k] === null);
    add("missing_result", `closed call is missing ${missing.join(", ")}`);
    return issues;
  }
  if (!isPrice(row.exit)) {
    add("missing_result", `exit must be a price above zero, got ${fmt(row.exit)}`);
    return issues;
  }
  if (row.resolved_at < row.created_at) add("resolved_before_created", "resolved_at is before created_at");

  const expectedRet = returnPct(side, entry, row.exit);
  if (!close(row.return_pct, expectedRet))
    add("return_mismatch", `return_pct ${fmt(row.return_pct)} but exit ${fmt(row.exit)} gives ${fmt(expectedRet)}`);

  const g = gradeSample(toCall(row, opts.horizonS), row.resolved_at, row.exit);
  if (!g) {
    add(
      "not_closable",
      `exit ${fmt(row.exit)} reaches neither stop ${fmt(stop)} nor target ${fmt(target)}, and resolved_at is before the ${fmt(horizonS / 86400)}-day horizon`,
    );
    return issues;
  }
  if (g.reason !== row.reason)
    add("reason_mismatch", `published reason ${row.reason}, but exit ${fmt(row.exit)} closes it by ${g.reason}`);
  if (g.status !== row.status)
    add(
      "status_mismatch",
      `published ${row.status}, but ${g.reason} at exit ${fmt(row.exit)} (return ${fmt(g.returnPct ?? 0)}%) is a ${g.status}`,
    );
  return issues;
}

function summaryIssues(
  s: Summary,
  rows: readonly ScorecardRow[],
  valid: boolean,
): { issues: Issue[]; recomputed: boolean } {
  const issues: Issue[] = [];
  const add = (code: IssueCode, message: string) => issues.push({ id: null, code, severity: "error", message });
  const ints = [s.total, s.open, s.closed, s.wins, s.losses];
  if (!ints.every((n) => Number.isInteger(n) && n >= 0) || !numOrNull(s.winRate) || !numOrNull(s.avgReturnPct)) {
    add("summary_arithmetic", "summary has missing or non-numeric fields");
    return { issues, recomputed: false };
  }
  if (s.open + s.closed !== s.total)
    add("summary_arithmetic", `open ${s.open} + closed ${s.closed} ≠ total ${s.total}`);
  if (s.wins + s.losses !== s.closed)
    add("summary_arithmetic", `wins ${s.wins} + losses ${s.losses} ≠ closed ${s.closed}`);
  if (s.closed === 0 ? s.winRate !== null : s.winRate === null || !close(s.winRate, s.wins / s.closed))
    add("summary_arithmetic", `winRate ${s.winRate} ≠ wins / closed`);
  if ((s.closed === 0) !== (s.avgReturnPct === null))
    add("summary_arithmetic", "avgReturnPct must be null exactly when there are no closed calls");

  if (rows.length !== Math.min(s.total, LIST_LIMIT))
    add(
      "list_length",
      `summary covers ${s.total} calls, so ${Math.min(s.total, LIST_LIMIT)} should be listed, got ${rows.length}`,
    );

  if (!valid || s.total !== rows.length) return { issues, recomputed: false };
  const r = summarize(rows);
  const same =
    r.total === s.total &&
    r.open === s.open &&
    r.closed === s.closed &&
    r.wins === s.wins &&
    r.losses === s.losses &&
    (r.winRate === null ? s.winRate === null : s.winRate !== null && close(r.winRate, s.winRate)) &&
    (r.avgReturnPct === null
      ? s.avgReturnPct === null
      : s.avgReturnPct !== null && close(r.avgReturnPct, s.avgReturnPct));
  if (!same) add("summary_mismatch", `published ${JSON.stringify(s)}, recomputed ${JSON.stringify(r)}`);
  return { issues, recomputed: true };
}

/** Check every published call and the summary. */
export function checkScorecard(card: Scorecard, opts: CheckOptions = {}): Report {
  const horizonS = opts.horizonS ?? DEFAULT_HORIZON_S;
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const row of card.suggestions) {
    issues.push(...checkRow(row, opts));
    if (typeof row.id === "string") {
      if (seen.has(row.id))
        issues.push({
          id: row.id,
          symbol: row.symbol,
          side: row.side,
          code: "duplicate_id",
          severity: "error",
          message: "id listed more than once",
        });
      seen.add(row.id);
    }
  }
  const valid = !issues.some((i) => i.code === "bad_row");
  const s = summaryIssues(card.summary, card.suggestions, valid);
  issues.push(...s.issues);
  const open = card.suggestions.filter((r) => r.status === "open").length;
  return {
    horizonS,
    horizonAssumed: card.suggestions.filter((r) => !hasHorizon(r)).length,
    calls: card.suggestions.length,
    open,
    closed: card.suggestions.length - open,
    summaryRecomputed: s.recomputed,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    issues,
  };
}
