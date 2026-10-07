import { describe, expect, it } from "vitest";
import { checkRow, checkScorecard, grade, levelsFor, summarize } from "../src/index.js";
import type { Call, Grade, PriceSample, ScorecardRow, Scorecard, Side, Summary } from "../src/index.js";
import gradeVectors from "../vectors/grade.json";
import levelVectors from "../vectors/levels.json";
import summarizeVectors from "../vectors/summarize.json";
import checkVectors from "../vectors/check.json";

const near = (a: number | null, b: number | null, tol: number) =>
  a === null || b === null ? a === b : Math.abs(a - b) <= tol;

describe("vectors/grade.json", () => {
  const tol = gradeVectors.tolerance.returnPct;
  it("has cases", () => expect(gradeVectors.cases.length).toBeGreaterThanOrEqual(25));
  for (const v of gradeVectors.cases) {
    it(v.name, () => {
      const g = grade(v.call as Call, v.prices as PriceSample[]);
      const e = v.expected as Grade;
      expect({ status: g.status, reason: g.reason, resolvedAt: g.resolvedAt, exit: g.exit }).toEqual({
        status: e.status,
        reason: e.reason,
        resolvedAt: e.resolvedAt,
        exit: e.exit,
      });
      expect(near(g.returnPct, e.returnPct, tol), `returnPct ${g.returnPct} vs ${e.returnPct}`).toBe(true);
    });
  }
});

describe("vectors/levels.json", () => {
  for (const v of levelVectors.cases) {
    it(v.name, () => {
      const { side, entry, stopPct, tpPct } = v.input;
      expect(levelsFor(side as Side, entry, stopPct, tpPct)).toEqual(v.expected);
    });
  }
});

describe("vectors/summarize.json", () => {
  for (const v of summarizeVectors.cases) {
    it(v.name, () => {
      const s = summarize(v.calls as { status: "open" | "win" | "loss"; return_pct: number | null }[]);
      const e = v.expected as Summary;
      expect({ ...s, winRate: null, avgReturnPct: null }).toEqual({ ...e, winRate: null, avgReturnPct: null });
      expect(near(s.winRate, e.winRate, summarizeVectors.tolerance.winRate)).toBe(true);
      expect(near(s.avgReturnPct, e.avgReturnPct, summarizeVectors.tolerance.avgReturnPct)).toBe(true);
    });
  }
});

describe("vectors/check.json rows", () => {
  for (const v of checkVectors.rows) {
    it(v.name, () => {
      const options = (v as { options?: { horizonS?: number; now?: number } }).options ?? {};
      const codes = checkRow(v.row as unknown as ScorecardRow, options)
        .map((i) => i.code)
        .sort();
      expect(codes).toEqual([...v.expected.codes].sort());
    });
  }
});

describe("vectors/check.json scorecards", () => {
  for (const v of checkVectors.scorecards) {
    it(v.name, () => {
      const r = checkScorecard(v.scorecard as unknown as Scorecard);
      expect(r.issues.map((i) => i.code).sort()).toEqual([...v.expected.codes].sort());
      expect(r.summaryRecomputed).toBe(v.expected.summaryRecomputed);
      expect(r.horizonAssumed).toBe(v.expected.horizonAssumed);
    });
  }
});
