import { describe, expect, it } from "vitest";
import { checkScorecard, fetchScorecard, scorecardUrl } from "../src/index.js";

/** Network test: only runs with TRAIVO_LIVE=1 (optionally TRAIVO_URL=<base url>). */
describe.runIf(process.env.TRAIVO_LIVE === "1")("live scorecard", () => {
  it("downloads and passes the consistency checks", async () => {
    const card = await fetchScorecard(scorecardUrl(process.env.TRAIVO_URL));
    const report = checkScorecard(card, { now: Math.floor(Date.now() / 1000) });
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
  }, 30_000);
});
