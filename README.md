# bharat-ticker-cloudflare

A **native Cloudflare Worker** (runs on the **FREE** plan) that reimplements the
bharat-ticker `/api/v1/sb/*` feed directly at the edge — no origin, no container,
no Northflank. It fetches real Indian-market data with plain `fetch` (verified
that Groww + Tickertape answer Cloudflare-style TLS with no `curl-cffi` browser
impersonation needed).

```
localhost / superbrain ──▶ Cloudflare Worker (src/index.js) ──▶ Groww · Tickertape · Yahoo
                              free plan, native JS                real-time NSE   /   history
```

## Data-latency contract (mirrors the app's armed rule)

**Lowest-latency live data only — Yahoo is 15-min delayed, so it is used for
history exclusively.**

**Yahoo never serves the current market day** — today's bar always comes from a
live source; Yahoo is used only for dates `< today`.

| Endpoint | Source | Latency |
|---|---|---|
| `GET /api/v1/sb/quotes?symbols=A,B` | **Groww** `latest_prices_ohlc` | **real-time** NSE (LTP/OHLC, change, vol, 52-wk, circuits, buy/sell qty, OI) |
| `GET /api/v1/sb/intraday/{sym}?interval=30minute` | **Tickertape** ticks → OHLC | **real-time** NSE |
| `GET /api/v1/sb/candles/{sym}?range=6mo&interval=1d` | Yahoo (`<today`) **+ today from Groww** | past historical · today live |
| `GET /api/v1/sb/history/{sym}?interval=30minute&from=&to=` | Yahoo (`<today`) **+ today from Tickertape** | past historical · today live |
| `GET /api/v1/sb/context` | **NSE** indices/VIX/FII-DII · **Investing** macro · **Tickertape** MMI | real-time |
| `GET /api/v1/sb/fundamentals/{sym}` | **screener.in** | ratios |
| `GET /api/v1/sb/resolve?q=` | **Tickertape** universe | symbol/name/isin |
| `GET /api/v1/sb/mmi`, `/api/v1/ping` | Tickertape / — | live / liveness |

A live endpoint that can't reach a real-time source returns nothing for that
symbol (`quotes`: omitted; `intraday`: `[]`) so the caller's armed cascade fills
it — **delayed data is never served as live.** `context`/`fundamentals` degrade
field-by-field (best-effort per source; NSE/screener may rate-limit CF egress).

## How it works

- **Quotes** — fan out one Groww call per symbol in parallel, map to the exact
  superbrain quote shape. localhost chunks at 30 symbols/call, so each invocation
  makes ≤30 subrequests (well under the free plan's 50/invocation cap).
- **Intraday** — resolve the Tickertape `sid` (seeded for hot names, else one
  cached `/stocks/list?filter=<letter>` lookup), pull today's real ticks, bucket
  them into the requested interval's OHLC bars.
- **Candles/history** — Yahoo for settled past bars; today's daily bar is rebuilt
  from the live Groww quote, today's intraday from Tickertape — so the current
  day is never the 15-min-delayed Yahoo value.
- **Context** — NSE `/api/allIndices` (+ Tickertape index fallback) for indices &
  VIX, Investing.com for FX/commodities, NSE for FII/DII, Tickertape for MMI.
- **Edge cache** — short per-route TTL (quotes 5s, intraday 20s, candles 120s,
  history 600s, context 60s, fundamentals 1h) via the Cache API, so a burst of
  pollers shares one upstream sweep. Responses carry `x-edge-cache` + `x-edge-age`.

## Deploy (free)

```bash
npm install
npx wrangler login
npx wrangler deploy
```

No paid plan, no Docker, no secrets. Goes live at
`https://bharat-ticker-cloudflare.<acct>.workers.dev` — the same URL localhost
already points at, so **no localhost change needed**; the CF endpoint now serves
real scraped data instead of proxying Northflank.

## Verify after deploy

```bash
curl "https://bharat-ticker-cloudflare.<acct>.workers.dev/api/v1/sb/quotes?symbols=RELIANCE,TCS"
curl "https://bharat-ticker-cloudflare.<acct>.workers.dev/api/v1/sb/intraday/RELIANCE?interval=30minute"
curl "https://bharat-ticker-cloudflare.<acct>.workers.dev/api/v1/sb/candles/RELIANCE?range=1mo&interval=1d"
```

> **Egress-IP caveat:** the Worker scrapes from Cloudflare's IPs. Groww/Tickertape
> were reachable in testing; if they ever rate-limit/block the edge, live calls
> return empty and the caller armed-fills. Re-check with the commands above.

## Scope / limits

- Ported: `quotes`, `intraday`, `candles`, `history`, `context`, `fundamentals`,
  `resolve`, `mmi`, `ping` — every endpoint localhost consumes.
- Not ported (no consumer / impossible on Workers): `/sb/stream` (SSE),
  `1second`/`10second` tick intervals (need a persistent sampler + Postgres),
  `recorder` / `warm` / `scans` / `screen`. These return `{}`.
- Best-effort (subject to CF egress-IP blocks): NSE indices + FII/DII, screener.in
  fundamentals. Each degrades field-by-field; the caller fills the rest.
- Free Workers: 100k req/day, 50 subrequests/invocation — fine for localhost's
  30-symbol chunks (context ≈7 subrequests).
