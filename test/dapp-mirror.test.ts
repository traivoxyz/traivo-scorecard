import { describe, expect, it } from "vitest";
import { grade } from "../src/index.js";
import type { Call, PriceSample } from "../src/index.js";
import gradeVectors from "../vectors/grade.json";

/**
 * A line-for-line port of the grading loop in the dapp's cron job (`runBook` in
 * `src/worker/lib/book.ts`), run once per sample against a single-row "table".
 * It exists to prove that `grade()` over a path equals the cron grader over the same samples.
 */
type Row = {
  side: "buy" | "sell";
  entry: number;
  stop: number;
  target: number;
  created_at: number;
  horizon_s: number;
  status: string;
  reason: string | null;
  resolved_at: number | null;
  exit: number | null;
  return_pct: number | null;
};

function cronRun(s: Row, t: number, rows: Map<string, number>) {
  if (s.status !== "open") return;
  const px = rows.get("X") ?? null;
  if (!px) return;
  const ret = (s.side === "buy" ? px / s.entry - 1 : 1 - px / s.entry) * 100;
  const tp = s.side === "buy" ? px >= s.target : px <= s.target;
  const sl = s.side === "buy" ? px <= s.stop : px >= s.stop;
  const expired = t >= s.created_at + s.horizon_s;
  if (!tp && !sl && !expired) return;
  const status = tp ? "win" : sl ? "loss" : ret > 0 ? "win" : "loss";
  const reason = tp ? "tp" : sl ? "sl" : "expiry";
  Object.assign(s, { status, reason, resolved_at: t, exit: px, return_pct: ret });
}

function mirror(call: Call, prices: PriceSample[]) {
  const s: Row = {
    side: call.side,
    entry: call.entry,
    stop: call.stop,
    target: call.target,
    created_at: call.createdAt,
    horizon_s: call.horizonS ?? 604800,
    status: "open",
    reason: null,
    resolved_at: null,
    exit: null,
    return_pct: null,
  };
  // The cron only sees a call once it exists, and runs in time order.
  const runs = [...prices].sort((a, b) => a.t - b.t).filter((p) => p.t >= call.createdAt);
  for (const p of runs) cronRun(s, p.t, p.price === null ? new Map() : new Map([["X", p.price]]));
  return { status: s.status, reason: s.reason, resolvedAt: s.resolved_at, exit: s.exit, returnPct: s.return_pct };
}

/** Deterministic PRNG so the property test is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("grade() equals the dapp cron grader", () => {
  for (const v of gradeVectors.cases) {
    it(`vector ${v.name}`, () => {
      const call = v.call as Call;
      // The dapp skips falsy prices only; negative prices are not part of the comparison.
      const prices = (v.prices as PriceSample[]).filter((p) => p.price === null || p.price >= 0);
      expect(grade(call, prices)).toEqual(mirror(call, prices));
    });
  }

  it("on 5,000 random paths", () => {
    const rand = mulberry32(22);
    const T0 = 1_790_000_000;
    for (let n = 0; n < 5000; n++) {
      const side = rand() < 0.5 ? "buy" : "sell";
      const entry = 1 + rand() * 500;
      const stopPct = 0.2 + rand() * 10;
      const tpPct = 0.2 + rand() * 20;
      const call: Call = {
        side,
        entry,
        stop: side === "buy" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100),
        target: side === "buy" ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100),
        createdAt: T0,
        horizonS: rand() < 0.5 ? 604800 : 3600,
      };
      const prices: PriceSample[] = [];
      let px = entry;
      const step = call.horizonS! / 20;
      for (let k = 0; k < 30; k++) {
        px *= 1 + (rand() - 0.5) * 0.04;
        const t = T0 - step + Math.floor(k * step * (0.8 + rand() * 0.4));
        prices.push({ t, price: rand() < 0.05 ? null : rand() < 0.02 ? 0 : px });
      }
      expect(grade(call, prices)).toEqual(mirror(call, prices));
    }
  });
});
