import { describe, expect, it } from "vitest";
import { run, type Io } from "../src/index.js";
import checkVectors from "../vectors/check.json";

function io(files: Record<string, string> = {}, body?: unknown, status = 200) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const x: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => 1_790_000_000,
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    fetch: (async (url: string) => {
      urls.push(String(url));
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }) as unknown as typeof fetch,
  };
  return { x, out, err, urls };
}

const card = (name: string) => checkVectors.scorecards.find((c) => c.name === name)!.scorecard;

describe("traivo-scorecard verify", () => {
  it("downloads the default endpoint and reports OK", async () => {
    const t = io({}, card("empty"));
    expect(await run(["verify"], t.x)).toBe(0);
    expect(t.urls).toEqual(["https://dapp.traivo.xyz/api/scorecard"]);
    expect(t.out.join("\n")).toMatch(/result {3}OK: 0 error\(s\), 0 warning\(s\)/);
    expect(t.out.join("\n")).toMatch(/does not replay price paths/);
  });

  it("says whether horizons were published or assumed", async () => {
    const t = io({}, card("consistent"));
    expect(await run(["verify"], t.x)).toBe(0);
    expect(t.out.join("\n")).toMatch(/horizon {2}published on every call/);
    const u = io({}, card("legacy_without_horizon"));
    expect(await run(["verify", "--horizon-days", "7"], u.x)).toBe(0);
    expect(u.out.join("\n")).toMatch(/2 of 2 call\(s\) lack horizon_s; assumed 7 days/);
  });

  it("accepts --url and --profile", async () => {
    const t = io({}, card("empty"));
    expect(await run(["verify", "--url", "http://localhost:8787/", "--profile", "alice"], t.x)).toBe(0);
    expect(t.urls).toEqual(["http://localhost:8787/api/profiles/alice"]);
  });

  it("prints mismatches and exits 1", async () => {
    const t = io({}, card("summary_mismatch"));
    expect(await run(["verify"], t.x)).toBe(1);
    const text = t.out.join("\n");
    expect(text).toMatch(/ERROR {2}summary {2}summary_mismatch/);
    expect(text).toMatch(/MISMATCH: 1 error/);
  });

  it("lists row mismatches with id, symbol and side", async () => {
    const row = checkVectors.rows.find((r) => r.name === "status_mismatch_expiry")!.row;
    const body = {
      summary: { total: 1, open: 0, closed: 1, wins: 0, losses: 1, winRate: 0, avgReturnPct: row.return_pct },
      suggestions: [row],
    };
    const t = io({ "card.json": JSON.stringify(body) });
    expect(await run(["verify", "--file", "card.json"], t.x)).toBe(1);
    expect(t.out.join("\n")).toMatch(/ERROR {2}b1 NVDA buy {2}status_mismatch/);
  });

  it("--json prints a machine-readable report", async () => {
    const t = io({}, card("consistent"));
    expect(await run(["verify", "--json"], t.x)).toBe(0);
    const r = JSON.parse(t.out.join("\n"));
    expect(r).toMatchObject({
      source: "https://dapp.traivo.xyz/api/scorecard",
      spec: 1,
      errors: 0,
      calls: 2,
      summaryRecomputed: true,
    });
  });

  it("--strict fails on warnings", async () => {
    const row = checkVectors.rows.find((r) => r.name === "warning_unreachable_target")!.row;
    const body = {
      summary: { total: 1, open: 1, closed: 0, wins: 0, losses: 0, winRate: null, avgReturnPct: null },
      suggestions: [row],
    };
    const t = io({ "c.json": JSON.stringify(body) });
    expect(await run(["verify", "--file", "c.json"], t.x)).toBe(0);
    expect(await run(["verify", "--file=c.json", "--strict"], t.x)).toBe(1);
  });

  it("exits 2 on HTTP errors, bad shapes and bad flags", async () => {
    const t = io({}, { error: "nope" }, 503);
    expect(await run(["verify"], t.x)).toBe(2);
    expect(t.err.join("\n")).toMatch(/HTTP 503/);
    const u = io({}, { hello: 1 });
    expect(await run(["verify"], u.x)).toBe(2);
    expect(u.err.join("\n")).toMatch(/no summary/);
    expect(await run(["verify", "--horizon-days", "0"], u.x)).toBe(2);
    expect(await run(["verify", "--url"], u.x)).toBe(2);
    expect(await run(["nope"], u.x)).toBe(2);
  });
});

describe("traivo-scorecard grade / help / version", () => {
  it("grades a call file against a price file", async () => {
    const call = { side: "buy", entry: 100, stop: 97, target: 106, createdAt: 1790000000 };
    const prices = [
      { t: 1790000060, price: 101 },
      { t: 1790000120, price: 106.2 },
    ];
    const t = io({ "call.json": JSON.stringify(call), "prices.json": JSON.stringify(prices) });
    expect(await run(["grade", "--call", "call.json", "--prices", "prices.json"], t.x)).toBe(0);
    expect(JSON.parse(t.out.join("\n"))).toMatchObject({
      status: "win",
      reason: "tp",
      resolvedAt: 1790000120,
      exit: 106.2,
    });
  });

  it("help and version", async () => {
    const t = io();
    expect(await run(["--help"], t.x)).toBe(0);
    expect(t.out[0]).toMatch(/^traivo-scorecard \d+\.\d+\.\d+/);
    expect(await run([], t.x)).toBe(2);
    const v = io();
    expect(await run(["--version"], v.x)).toBe(0);
    expect(v.out).toEqual(["0.1.0"]);
  });
});
