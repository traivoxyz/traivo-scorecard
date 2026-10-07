# Traivo scorecard — grading spec v1

This document defines how Traivo grades every trade call Traivo AI prepares. It describes the grader that runs in
production (a cron job in the Traivo dapp) exactly as it behaves, including its limits. The reference implementation
in this repo (`grade`, `summarize`, `checkRow`) and the golden vectors in [`vectors/`](./vectors) follow this spec.

The key words MUST, MUST NOT and SHOULD are used as in RFC 2119.

## 1. Call

A call is created when Traivo AI prepares a trade for a user. It is logged before the user decides anything, so calls
the user ignored still count. A call has these fields (names as published by `GET /api/scorecard`):

| Field         | Type                                   | Meaning                                                                                                                                                                            |
| ------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | string                                 | Random identifier.                                                                                                                                                                 |
| `created_at`  | integer                                | Unix time in seconds when the call was logged.                                                                                                                                     |
| `block`       | string                                 | Ethereum mainnet block number (decimal string) of the on-chain quote the call was priced from, or the literal `"hyperliquid"` when the call was priced off the Hyperliquid mid.    |
| `symbol`      | string                                 | Asset symbol, for example `NVDA` (a tokenized stock) or `ETH`.                                                                                                                     |
| `side`        | `"buy"` \| `"sell"`                    | Direction. A sell is graded as a short: it wins when the price falls.                                                                                                              |
| `amount`      | number                                 | Size of the prepared trade: USDC in for buys, units of the asset in for sells. Informational; not used in grading.                                                                 |
| `entry`       | number                                 | Entry price in USD (see §3).                                                                                                                                                       |
| `reference`   | number \| null                         | Outside price at call time (the listed share for tokenized stocks, Chainlink ETH/USD for ETH, Hyperliquid for other routed crypto), or `null`. Informational; not used in grading. |
| `stop`        | number                                 | Stop level, price in USD.                                                                                                                                                          |
| `target`      | number                                 | Take-profit level, price in USD.                                                                                                                                                   |
| `horizon_s`   | integer                                | Horizon in seconds (see below).                                                                                                                                                    |
| `status`      | `"open"` \| `"win"` \| `"loss"`        | Grade.                                                                                                                                                                             |
| `reason`      | `"tp"` \| `"sl"` \| `"expiry"` \| null | Why the call closed. `null` while open.                                                                                                                                            |
| `resolved_at` | integer \| null                        | Unix time in seconds of the price sample that closed the call.                                                                                                                     |
| `exit`        | number \| null                         | The sampled price that closed the call.                                                                                                                                            |
| `return_pct`  | number \| null                         | Return in percent at `exit` (see §4).                                                                                                                                              |

Every call carries its own horizon, `horizon_s`, fixed when it is logged and published with the call. The app logs
calls with **7 days = 604 800 seconds**. Graders and verifiers MUST use the published `horizon_s`. Only when it is
missing (payloads published before the field was added) SHOULD they fall back to 7 days.

### 1.1 Stop and target

Traivo AI picks a stop distance `stopPct` and a take-profit distance `tpPct` in percent. The app clamps them to
`0.2 ≤ stopPct ≤ 50` and `0.2 ≤ tpPct ≤ 200` (defaults 3 and 6). The levels are then fixed once, at log time:

```
buy:   stop = entry × (1 − stopPct / 100)    target = entry × (1 + tpPct / 100)
sell:  stop = entry × (1 + stopPct / 100)    target = entry × (1 − tpPct / 100)
```

So for a buy `stop < entry < target`, and for a sell `target < entry < stop`. A sell with `tpPct ≥ 100` has a target
at or below zero, which no price can reach; such a call can only close by stop or expiry.

Levels are never moved after the call is logged.

## 2. Price samples

The grader runs about **once a minute**. Each run reads one live price per symbol and evaluates every open call
against it. A sample is a pair `(t, price)` where `t` is the run time in Unix seconds.

- A sample whose price is missing, zero, negative or not finite is **skipped**: the call stays open and the next run
  tries again.
- Samples taken before `created_at` do not apply to the call. A sample at exactly `created_at` does.
- Samples are evaluated in time order. The first sample that closes the call is final; later samples are ignored.

Ethereum mainnet produces a block about every 12 seconds, so a once-a-minute sampler sees the on-chain price of roughly
one block in five. The sample is the quote at the latest block when the run reads it; the blocks in between are not
looked at.

### 2.1 Sampling caveat

Only the sampled price is seen. A wick that touches the stop or the target between two samples and comes back is
**missed**, and a price that gaps through a level is closed at the sampled price, not at the level. Grades are
therefore "as seen by a once-a-minute sampler", not "as seen by a tick-level replay". Third-party verifiers that
replay higher-resolution data can legitimately disagree on calls where this matters, and SHOULD report such calls
separately from real mismatches.

## 3. Price sources

All on-chain prices are read on **Ethereum mainnet** through Uniswap V3 (QuoterV2) against **USDC**. Prices quoted in
USDC are taken as USD, one to one.

The live price for a symbol is chosen by this precedence (later wins):

1. **Hyperliquid mid** for every market Hyperliquid lists. This is the price for crypto that has no on-chain route on
   Ethereum.
2. **Routed on-chain price**: for every symbol with a swap route in Traivo (ETH and the other tokens Traivo
   discovered and verified), the price of a 100 USDC buy through that route. It overrides 1, so a routed asset is
   graded at the price a trade on Ethereum fills at, the same way it is entered.
3. **Tokenized stocks** (Ondo Global Markets tokens on Ethereum): the on-chain mid `(bid + ask) / 2`, where bid is the
   quote for selling 1 token for USDC and ask is the price of a 1 000 USDC buy. If only one side quotes, that side is
   used. Stock symbols win any name clash.

The `entry` price comes from the quote shown to the user when the call was prepared:

- On-chain route (tokenized stocks, ETH and the other routed tokens): the average execution price of the prepared
  size (`USDC in / tokens out` for buys, `USDC out / tokens in` for sells). It includes price impact for that size.
  `block` is the Ethereum block the quote was read at.
- Assets without an on-chain route: the Hyperliquid mid; `block` is then `"hyperliquid"`.

So entry and grading price come from the same venue: a routed asset is entered and graded on Ethereum, an unrouted
one on Hyperliquid. Because an on-chain entry is the execution price of the prepared size while the grading price is a
mid (tokenized stocks) or a small 100 USDC buy (other routed tokens), a call starts a little behind by roughly its
price impact. This is deliberate: it grades the trade the user would actually have got.

## 4. Return

```
buy:   return_pct = (price / entry − 1) × 100
sell:  return_pct = (1 − price / entry) × 100
```

Sell returns are inverted so that a positive return always means the call was right.

## 5. Grading rule

For each sample `(t, price)` that applies (§2), in time order:

```
tp      = buy ? price ≥ target : price ≤ target
sl      = buy ? price ≤ stop   : price ≥ stop
expired = t ≥ created_at + horizon_s

if not (tp or sl or expired):  stay open, go to the next sample
if tp:          status = win,  reason = tp
else if sl:     status = loss, reason = sl
else:           status = return_pct > 0 ? win : loss,  reason = expiry

resolved_at = t,  exit = price,  return_pct as in §4
```

Consequences, all covered by the golden vectors:

- **Target first → win. Stop first → loss.** "First" means the first sample that reaches the level.
- Touching a level counts: `price = target` wins, `price = stop` loses.
- **Expiry** is checked on samples at or after `created_at + horizon_s`. The boundary is inclusive. The call closes at
  the first applicable sample from then on, at that sample's price. If that sample also reaches the target or the stop,
  the reason is `tp` or `sl`, not `expiry`.
- At expiry, a return of exactly `0` (no move) is a **loss**. Only a strictly positive return wins.
- **Tie rule.** If one sample satisfies both `tp` and `sl`, the call is a **win by `tp`**: the grader checks the target
  before the stop. With the level geometry of §1.1 this cannot happen for calls the app creates; it only happens with
  inverted levels (for example a buy with `stop ≥ target`). A wick that crosses both levels between two samples is
  not a tie: it is invisible to the grader (§2.1), and only the sampled prices count.

## 6. Rounding

There is none at grading time. Prices, levels and returns are IEEE-754 double precision numbers, stored and published
as computed. Comparisons in §5 are exact on those doubles. Rounding happens only when numbers are displayed.

Implementations in other languages SHOULD reproduce the formulas in the same operation order. When comparing returns,
verifiers SHOULD allow an absolute tolerance of `1e-9` percentage points; `status`, `reason`, `resolved_at` and `exit`
MUST match exactly.

## 7. Summary

`summary` is computed over the calls it covers:

```
closed       = calls with status ≠ open
wins         = closed calls with status = win
losses       = closed − wins
winRate      = closed > 0 ? wins / closed : null          (a fraction 0..1, not a percent)
avgReturnPct = closed > 0 ? mean(return_pct over closed) : null   (a missing return_pct counts as 0)
open         = total − closed
```

Only closed calls count toward `winRate` and `avgReturnPct`. Open calls never count, in either direction.

## 8. Public endpoint

`GET https://dapp.traivo.xyz/api/scorecard` returns:

```json
{
  "summary": { "total": 0, "open": 0, "closed": 0, "wins": 0, "losses": 0, "winRate": null, "avgReturnPct": null },
  "suggestions": []
}
```

- Each entry in `suggestions` has the fields of §1, including `horizon_s`.
- `summary` covers the **latest 500** calls; `suggestions` lists the **latest 200**, newest first. When there are more
  than 200 calls the summary cannot be recomputed from the list alone.
- The result is cached for up to 30 seconds.
- Public profiles (`GET /api/profiles/:handle-or-address`, opt-in only) return the same `summary` and `suggestions`
  shape for one wallet's calls.

## 9. Internal consistency (what `verify` checks in v0.1)

A published closed call is consistent when re-running §5 on its own recorded sample `(resolved_at, exit)` gives back
its `status` and `reason`, and §4 on `exit` gives back its `return_pct`. In particular:

- `reason = tp` → `exit` reaches `target`, and `status = win`.
- `reason = sl` → `exit` reaches `stop`, does not reach `target`, and `status = loss`.
- `reason = expiry` → `exit` reaches neither level, `resolved_at ≥ created_at + horizon_s`, and
  `status = win` exactly when `return_pct > 0`.

`horizon_s` is the call's published horizon; for a call without one, the 7-day fallback of §1 is used and the
verifier reports how many calls needed it.

This proves each grade follows from the recorded exit. It does not prove the recorded exit was the first sample to
close the call; that needs the price path (§2) and is out of scope for v0.1 of the verifier.

## 10. Versioning

This is spec v1. Any change to §1.1, §2, §4, §5 or §7 gets a new spec version and new golden vectors in this repo.
