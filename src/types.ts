export type Side = "buy" | "sell";
export type Status = "open" | "win" | "loss";
export type Reason = "tp" | "sl" | "expiry";

/** A call as the grader needs it. Times are Unix seconds. */
export interface Call {
  side: Side;
  /** Entry price in USD. */
  entry: number;
  /** Stop level in USD. */
  stop: number;
  /** Take-profit level in USD. */
  target: number;
  /** Unix seconds when the call was logged. */
  createdAt: number;
  /** Horizon in seconds. Defaults to {@link DEFAULT_HORIZON_S} (7 days). */
  horizonS?: number;
}

/** One price sample. A `null`, zero, negative or non-finite price is skipped. */
export interface PriceSample {
  t: number;
  price: number | null;
}

/** Result of grading a call. All result fields are `null` while the call is open. */
export interface Grade {
  status: Status;
  reason: Reason | null;
  resolvedAt: number | null;
  exit: number | null;
  returnPct: number | null;
}

/** A call exactly as published by `GET /api/scorecard` (snake_case). */
export interface ScorecardRow {
  id: string;
  created_at: number;
  /** Ethereum mainnet block number of the on-chain quote, or `"hyperliquid"` for calls priced off the Hyperliquid mid. */
  block: string;
  symbol: string;
  side: Side;
  /** USDC in for buys, units of the asset in for sells. */
  amount: number;
  entry: number;
  /** Outside price at call time (listed share, Chainlink ETH/USD or Hyperliquid), informational only. */
  reference: number | null;
  stop: number;
  target: number;
  /** Horizon in seconds. Published on every call; older payloads may lack it. */
  horizon_s?: number | null;
  status: Status;
  reason: Reason | null;
  resolved_at: number | null;
  exit: number | null;
  return_pct: number | null;
}

/** Aggregate published next to the calls. `winRate` is a fraction (0..1), not a percent. */
export interface Summary {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgReturnPct: number | null;
}

export interface Scorecard {
  summary: Summary;
  suggestions: ScorecardRow[];
}
