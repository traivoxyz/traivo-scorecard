import { readFile } from "node:fs/promises";
import { checkScorecard, type Issue, type Report } from "./check.js";
import { DEFAULT_BASE_URL, fetchScorecard, parseScorecard, scorecardUrl } from "./fetch.js";
import { DEFAULT_HORIZON_S, grade } from "./grade.js";
import type { Call, PriceSample, Scorecard } from "./types.js";
import { SPEC_VERSION, VERSION } from "./version.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  readFile?: (path: string) => Promise<string>;
  /** Current Unix time in seconds (for `overdue` warnings). */
  now?: () => number;
}

const HELP = `traivo-scorecard ${VERSION} (scorecard spec v${SPEC_VERSION})

Usage
  traivo-scorecard verify [--url <url>] [--profile <handle|address>] [--file <path>]
                          [--horizon-days <n>] [--json] [--strict]
  traivo-scorecard grade --call <call.json> --prices <prices.json>
  traivo-scorecard --help | --version

verify  Download Traivo's public scorecard and check that every call is internally
        consistent: re-grading its own recorded exit gives back its status, reason and
        return, its levels sit on the right side of entry, and the summary adds up.
        It does not replay price paths (see README, Limitations).

  --url <url>           Base URL or full endpoint (default ${DEFAULT_BASE_URL})
  --profile <id>        Check one opt-in public profile instead of the whole scorecard
  --file <path>         Check a saved JSON file instead of downloading
  --horizon-days <n>    Horizon to assume for calls without horizon_s (default 7)
  --json                Print the report as JSON
  --strict              Exit 1 on warnings too

grade   Grade one call against a price path with the reference grader.
        call.json:   {"side","entry","stop","target","createdAt","horizonS"?}
        prices.json: [{"t": <unix s>, "price": <number|null>}, ...]

Exit codes: 0 consistent, 1 mismatches found, 2 usage or network error.`;

type Flags = Record<string, string | true>;

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) flags[k] = inline;
    else if (["json", "strict", "help", "version"].includes(k)) flags[k] = true;
    else {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`);
      flags[k] = v;
    }
  }
  return flags;
}

const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);

function line(i: Issue): string {
  const who = i.id === null ? "summary" : `${i.id}${i.symbol ? ` ${i.symbol}` : ""}${i.side ? ` ${i.side}` : ""}`;
  return `  ${i.severity === "error" ? "ERROR" : "WARN "}  ${who}  ${i.code}: ${i.message}`;
}

function printReport(io: Io, source: string, card: Scorecard, r: Report) {
  const s = card.summary;
  io.out(`traivo-scorecard ${VERSION} · spec v${SPEC_VERSION}`);
  io.out(`source   ${source}`);
  io.out(`calls    ${r.calls} listed (${r.open} open, ${r.closed} closed); summary covers ${s.total}`);
  io.out(
    r.horizonAssumed === 0
      ? "horizon  published on every call (horizon_s)"
      : `horizon  ${r.horizonAssumed} of ${r.calls} call(s) lack horizon_s; assumed ${r.horizonS / 86400} days for those`,
  );
  io.out(
    `summary  ${r.summaryRecomputed ? "recomputed from the listed calls" : "not recomputed (it covers calls that are not listed); arithmetic checked only"}`,
  );
  if (r.issues.length) {
    io.out("");
    for (const i of r.issues) io.out(line(i));
    io.out("");
  }
  io.out(`result   ${r.errors ? "MISMATCH" : "OK"}: ${r.errors} error(s), ${r.warnings} warning(s)`);
  io.out("note     v0.1 checks internal consistency only; it does not replay price paths.");
}

async function verify(flags: Flags, io: Io): Promise<number> {
  const days = str(flags, "horizon-days");
  const horizonS = days === undefined ? DEFAULT_HORIZON_S : Number(days) * 86400;
  if (!Number.isFinite(horizonS) || horizonS <= 0) throw new Error("--horizon-days must be a positive number");
  const file = str(flags, "file");
  let card: Scorecard;
  let source: string;
  if (file) {
    const read = io.readFile ?? ((p: string) => readFile(p, "utf8"));
    card = parseScorecard(JSON.parse(await read(file)));
    source = file;
  } else {
    source = scorecardUrl(str(flags, "url") ?? DEFAULT_BASE_URL, str(flags, "profile"));
    card = await fetchScorecard(source, { fetch: io.fetch, userAgent: `traivo-scorecard/${VERSION}` });
  }
  const now = (io.now ?? (() => Math.floor(Date.now() / 1000)))();
  const report = checkScorecard(card, { horizonS, now });
  if (flags.json) io.out(JSON.stringify({ source, spec: SPEC_VERSION, ...report }, null, 2));
  else printReport(io, source, card, report);
  return report.errors || (flags.strict && report.warnings) ? 1 : 0;
}

async function gradeCmd(flags: Flags, io: Io): Promise<number> {
  const callPath = str(flags, "call");
  const pricesPath = str(flags, "prices");
  if (!callPath || !pricesPath) throw new Error("grade needs --call and --prices");
  const read = io.readFile ?? ((p: string) => readFile(p, "utf8"));
  const call = JSON.parse(await read(callPath)) as Call;
  const prices = JSON.parse(await read(pricesPath)) as PriceSample[];
  if (!Array.isArray(prices)) throw new Error("prices.json must be an array of {t, price}");
  io.out(JSON.stringify(grade(call, prices), null, 2));
  return 0;
}

/** CLI entry point. Returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
      io.out(HELP);
      return cmd ? 0 : 2;
    }
    if (cmd === "--version" || cmd === "-v") {
      io.out(VERSION);
      return 0;
    }
    const flags = parseFlags(rest);
    if (flags.help) {
      io.out(HELP);
      return 0;
    }
    if (cmd === "verify") return await verify(flags, io);
    if (cmd === "grade") return await gradeCmd(flags, io);
    throw new Error(`unknown command: ${cmd}`);
  } catch (e) {
    io.err(`traivo-scorecard: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
