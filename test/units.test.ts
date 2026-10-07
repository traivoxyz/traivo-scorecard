import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VERSION,
  checkScorecard,
  fetchScorecard,
  grade,
  gradeSample,
  parseScorecard,
  scorecardUrl,
  type Call,
  type ScorecardRow,
} from "../src/index.js";

const call: Call = { side: "buy", entry: 100, stop: 97, target: 106, createdAt: 1_790_000_000 };

describe("grade input", () => {
  it("rejects malformed calls", () => {
    expect(() => grade({ ...call, side: "long" as "buy" }, [])).toThrow(/side/);
    expect(() => grade({ ...call, entry: 0 }, [])).toThrow(/entry/);
    expect(() => grade({ ...call, stop: NaN }, [])).toThrow(/stop/);
    expect(() => grade({ ...call, createdAt: Infinity }, [])).toThrow(/createdAt/);
    expect(() => grade({ ...call, horizonS: -1 }, [])).toThrow(/horizonS/);
  });

  it("does not mutate the price path", () => {
    const prices = [
      { t: 1_790_000_180, price: 106.2 },
      { t: 1_790_000_060, price: 101 },
    ];
    const copy = structuredClone(prices);
    grade(call, prices);
    expect(prices).toEqual(copy);
  });

  it("skips samples with a non-finite time", () => {
    expect(grade(call, [{ t: NaN, price: 50 }]).status).toBe("open");
  });

  it("gradeSample skips unusable prices", () => {
    for (const p of [null, 0, -1, NaN, Infinity]) expect(gradeSample(call, 1_790_000_060, p)).toBeNull();
  });
});

describe("checkScorecard with more calls than are listed", () => {
  it("checks summary arithmetic but does not recompute it", () => {
    const row: ScorecardRow = {
      id: "x",
      created_at: 1_790_000_000,
      block: "23456789",
      symbol: "NVDA",
      side: "buy",
      amount: 10,
      entry: 100,
      reference: null,
      stop: 97,
      target: 106,
      status: "open",
      reason: null,
      resolved_at: null,
      exit: null,
      return_pct: null,
    };
    const suggestions = Array.from({ length: 200 }, (_, i) => ({ ...row, id: `c${i}` }));
    const ok = checkScorecard({
      summary: { total: 350, open: 300, closed: 50, wins: 20, losses: 30, winRate: 0.4, avgReturnPct: -0.5 },
      suggestions,
    });
    expect(ok.summaryRecomputed).toBe(false);
    expect(ok.errors).toBe(0);
    const bad = checkScorecard({
      summary: { total: 350, open: 300, closed: 50, wins: 20, losses: 30, winRate: 0.5, avgReturnPct: -0.5 },
      suggestions: suggestions.slice(0, 150),
    });
    expect(bad.issues.map((i) => i.code).sort()).toEqual(["list_length", "summary_arithmetic"]);
  });
});

describe("fetch helpers", () => {
  it("scorecardUrl normalises base and endpoint URLs", () => {
    expect(scorecardUrl()).toBe("https://dapp.traivo.xyz/api/scorecard");
    expect(scorecardUrl("https://dapp.traivo.xyz/")).toBe("https://dapp.traivo.xyz/api/scorecard");
    expect(scorecardUrl("https://dapp.traivo.xyz/api/scorecard")).toBe("https://dapp.traivo.xyz/api/scorecard");
    expect(scorecardUrl("https://dapp.traivo.xyz", "0xAbC")).toBe("https://dapp.traivo.xyz/api/profiles/0xAbC");
    expect(scorecardUrl("https://dapp.traivo.xyz/api/profiles/bob")).toBe("https://dapp.traivo.xyz/api/profiles/bob");
  });

  it("parseScorecard rejects bad shapes", () => {
    expect(() => parseScorecard(null)).toThrow();
    expect(() => parseScorecard({ summary: {} })).toThrow(/suggestions/);
    expect(() => parseScorecard({ summary: {}, suggestions: [1] })).toThrow(/objects/);
  });

  it("fetchScorecard surfaces HTTP errors", async () => {
    const f = (async () => ({ ok: false, status: 500, json: async () => "down" })) as unknown as typeof fetch;
    await expect(fetchScorecard("https://example.test/api/scorecard", { fetch: f })).rejects.toThrow(/HTTP 500/);
  });
});

describe("package", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
