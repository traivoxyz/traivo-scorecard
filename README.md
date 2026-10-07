# traivo-scorecard

The grading rules behind [Traivo](https://dapp.traivo.xyz)'s public scorecard, written down so anyone can check them.

Every trade Traivo AI prepares is logged as a **call** (entry, stop, target, 7-day horizon) before the user decides
anything, and graded against what the price did next. This repo contains:

- [`SPEC.md`](./SPEC.md) — what a call is, the win/loss rules, price sources, the sampling caveat and rounding.
- `@traivo/scorecard` — a pure TypeScript grader (`grade`, `summarize`) that behaves exactly like the production
  grader, plus consistency checks for published calls.
- [`vectors/`](./vectors) — golden vectors (inputs + expected status, reason and return) so implementations in any
  language can test themselves against the spec.
- `traivo-scorecard verify` — a CLI that downloads the live scorecard and checks every published call.

No numbers are quoted here on purpose. The scorecard itself is public:
[`https://dapp.traivo.xyz/api/scorecard`](https://dapp.traivo.xyz/api/scorecard).

## Quick start

```sh
git clone <this repo> && cd traivo-scorecard
pnpm install && pnpm build
node dist/cli.js verify                 # checks https://dapp.traivo.xyz/api/scorecard
node dist/cli.js verify --json          # machine-readable report
node dist/cli.js verify --profile <handle-or-address>   # one opt-in public profile
```

Exit code `0` means every call is consistent, `1` means mismatches were found (printed one per line), `2` means a
usage or network error.

As a library:

```ts
import { grade, levelsFor, summarize } from "@traivo/scorecard";

const { stop, target } = levelsFor("buy", 100, 3, 6); // 97, 106
const result = grade({ side: "buy", entry: 100, stop, target, createdAt: 1790000000 }, [
  { t: 1790000060, price: 101 },
  { t: 1790000120, price: 106.2 },
]);
// { status: "win", reason: "tp", resolvedAt: 1790000120, exit: 106.2, returnPct: 6.2000000000000055 }
```

## The rules in one screen

See [`SPEC.md`](./SPEC.md) for the full text. In short:

- Levels are fixed when the call is logged: buy `stop = entry × (1 − stop%)`, `target = entry × (1 + tp%)`; sells
  mirror that.
- Prices are sampled about once a minute. On each sample: target reached → **win (`tp`)**; else stop reached →
  **loss (`sl`)**; else, once the call's horizon (`horizon_s`, 7 days) has passed → **win if the return is above zero, otherwise loss
  (`expiry`)**. The first sample that closes the call is final.
- Touching a level counts. A gap through a level closes at the sampled price. A return of exactly 0 at expiry is a
  loss. If one sample reaches both levels (only possible with inverted levels) it is a win: target is checked first.
- Returns for sells are inverted, so a positive return always means the call was right.
- Win rate and average return count **closed calls only**.
- Price sources: on Ethereum mainnet, through Uniswap V3 against USDC, for anything Traivo can swap there (the mid
  for tokenized stocks, which are Ondo Global Markets tokens; a 100 USDC buy quote for ETH and other routed tokens),
  and the Hyperliquid mid for crypto without an on-chain route. A call is graded on the same venue it is entered on.

## API

| Export                            | What it does                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `grade(call, prices)`             | Grade a call against a price path. Pure; returns `{ status, reason, resolvedAt, exit, returnPct }`. |
| `gradeSample(call, t, price)`     | One grader run: the closing grade for this sample, or `null` if the call stays open.                |
| `levelsFor(side, entry, s%, tp%)` | Stop and target levels exactly as the app stores them.                                              |
| `returnPct(side, entry, price)`   | Return in percent, inverted for sells.                                                              |
| `summarize(calls)`                | `{ total, open, closed, wins, losses, winRate, avgReturnPct }` as the scorecard publishes it.       |
| `checkRow(row, opts?)`            | Internal-consistency issues for one published call (snake_case row from the API).                   |
| `checkScorecard(card, opts?)`     | Checks every call plus the summary; returns a report with `errors`, `warnings` and `issues`.        |
| `fetchScorecard(url)`             | Download and shape-check a scorecard or public profile payload.                                     |
| `scorecardUrl(base?, profile?)`   | Endpoint URL from a base URL.                                                                       |
| `run(argv, io)`                   | The CLI, callable from code.                                                                        |
| `DEFAULT_HORIZON_S`               | `604800` (7 days).                                                                                  |

CLI:

```
traivo-scorecard verify [--url <url>] [--profile <handle|address>] [--file <path>]
                        [--horizon-days <n>] [--json] [--strict]
traivo-scorecard grade --call <call.json> --prices <prices.json>
```

### What `verify` checks

For every published call: the fields have the right types; the levels sit on the right side of entry; an open call
has no result; and a closed call is reproducible from its own recorded exit — re-grading the sample
`(resolved_at, exit)` must give back its `status` and `reason`, and the return formula must give back its
`return_pct`. Expiry is judged against the call's published `horizon_s`. Then the summary must add up, and when it covers exactly the listed calls it is recomputed from them.

Warnings (do not fail unless `--strict`): levels outside the app's stop/take-profit ranges, a sell target that no
price can reach, and calls still open more than an hour past their horizon.

## Golden vectors

| File                     | Covers                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vectors/grade.json`     | Buy and sell: target first, stop first, exact touches, gaps, expiry win/loss/no-move, tie rule, skipped prices, unsorted paths, float edges, horizons. |
| `vectors/levels.json`    | Stop/target levels, including float rounding and an unreachable sell target.                                                                           |
| `vectors/summarize.json` | Summary counts, win rate and average return.                                                                                                           |
| `vectors/check.json`     | Consistent and inconsistent published rows and scorecards (with and without `horizon_s`), with the expected issue codes.                               |

`status`, `reason`, `resolvedAt` and `exit` must match exactly; returns and rates within `1e-9`. The test suite
also runs a line-for-line port of the production grading loop against every vector and 5,000 random paths.

## How Traivo uses it

The dapp's cron grader implements `SPEC.md`; this package is the reference copy of the same rules, and the golden
vectors are the contract between them: a change to the grading rules has to change the spec version and the vectors.
`traivo-scorecard verify` is what anyone (including us) can run against the live endpoint to confirm every published
grade follows from its own data.

## Limitations

- **No price-path replay in v0.1.** `verify` proves each grade follows from the recorded exit. It does not prove the
  recorded exit was the _first_ sample to reach a level, or that the exit price matches the market at that time.
  That needs historical Ethereum and Hyperliquid prices at the grader's sampling times; `grade()` is ready for it,
  the data source is not part of this release.
- **Sampling.** The production grader samples about once a minute (Ethereum makes a block about every 12 seconds, so
  most blocks are never looked at), and wicks between samples are missed. A tick-level
  replay can disagree with the published grade on such calls without either being wrong under its own rules.
- **Horizon fallback.** Each call publishes `horizon_s` and `verify` uses it. Only for a payload without it (published
  before the field existed) does `verify` assume 7 days; the report says how many calls needed that, and
  `--horizon-days` changes the fallback.
- **Partial lists.** The endpoint lists the latest 200 calls while the summary covers the latest 500, so with more
  than 200 calls only the summary arithmetic is checked, not its totals.

## Development

```sh
pnpm install
pnpm lint        # prettier --check
pnpm typecheck
pnpm test        # golden vectors, no network
TRAIVO_LIVE=1 pnpm test   # also checks the live endpoint (TRAIVO_URL to point elsewhere)
pnpm build
```

## Links

Traivo $TRVO — The AI trading copilot for Ethereum Chain: it reads your wallet, watches the market, and prepares every trade for you to approve.

- Telegram: https://t.me/traivo
- X: https://x.com/traivoxyz
- Website: https://traivo.xyz
- Docs: https://docs.traivo.xyz
- App: https://dapp.traivo.xyz
- GitHub: https://github.com/traivoxyz

## License

[MIT](./LICENSE) © Traivo
