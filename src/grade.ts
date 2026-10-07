import type { Call, Grade, PriceSample, Side } from "./types.js";

/** Horizon used by every call Traivo has logged so far: 7 days. */
export const DEFAULT_HORIZON_S = 7 * 86400;

/** Clamp range the app applies to the stop distance, in percent. */
export const STOP_PCT_RANGE = [0.2, 50] as const;
/** Clamp range the app applies to the take-profit distance, in percent. */
export const TP_PCT_RANGE = [0.2, 200] as const;

const OPEN: Grade = { status: "open", reason: null, resolvedAt: null, exit: null, returnPct: null };

/** True for a usable sampled price: a finite number above zero. Anything else is skipped. */
export function isPrice(price: unknown): price is number {
  return typeof price === "number" && Number.isFinite(price) && price > 0;
}

/** Stop and target levels from distances in percent, fixed once when the call is logged (SPEC §1.1). */
export function levelsFor(side: Side, entry: number, stopPct: number, tpPct: number): { stop: number; target: number } {
  const stop = side === "buy" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  const target = side === "buy" ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  return { stop, target };
}

/** Return in percent at `price`. Sells are inverted so a positive return always means the call was right (SPEC §4). */
export function returnPct(side: Side, entry: number, price: number): number {
  return (side === "buy" ? price / entry - 1 : 1 - price / entry) * 100;
}

function assertCall(call: Call): void {
  if (call.side !== "buy" && call.side !== "sell") throw new TypeError(`side must be "buy" or "sell"`);
  if (!isPrice(call.entry)) throw new TypeError("entry must be a finite number above zero");
  if (!Number.isFinite(call.stop) || !Number.isFinite(call.target))
    throw new TypeError("stop and target must be finite");
  if (!Number.isFinite(call.createdAt)) throw new TypeError("createdAt must be finite");
  const h = call.horizonS ?? DEFAULT_HORIZON_S;
  if (!Number.isFinite(h) || h < 0) throw new TypeError("horizonS must be a finite number >= 0");
}

/**
 * Evaluate one sample against an open call (one cron run, SPEC §5).
 * Returns the closing grade, or `null` when the call stays open (including when the price is unusable).
 * Does not check `t >= createdAt`; {@link grade} does.
 */
export function gradeSample(call: Call, t: number, price: number | null): Grade | null {
  if (!isPrice(price)) return null;
  const ret = returnPct(call.side, call.entry, price);
  const tp = call.side === "buy" ? price >= call.target : price <= call.target;
  const sl = call.side === "buy" ? price <= call.stop : price >= call.stop;
  const expired = t >= call.createdAt + (call.horizonS ?? DEFAULT_HORIZON_S);
  if (!tp && !sl && !expired) return null;
  const status = tp ? "win" : sl ? "loss" : ret > 0 ? "win" : "loss";
  const reason = tp ? "tp" : sl ? "sl" : "expiry";
  return { status, reason, resolvedAt: t, exit: price, returnPct: ret };
}

/**
 * Grade a call against a price path (SPEC §2 and §5). Pure: the input is not mutated.
 * Samples are sorted by time (stable), samples before `createdAt` are ignored, unusable prices are skipped,
 * and the first sample that closes the call is final. Returns an open grade when no sample closes it.
 */
export function grade(call: Call, prices: readonly PriceSample[]): Grade {
  assertCall(call);
  const path = prices
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.t - b.s.t || a.i - b.i)
    .map(({ s }) => s);
  for (const s of path) {
    if (!Number.isFinite(s.t) || s.t < call.createdAt) continue;
    const g = gradeSample(call, s.t, s.price);
    if (g) return g;
  }
  return { ...OPEN };
}
