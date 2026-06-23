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

| Endpoint | Source | Latency |
|---|---|---|
| `GET /api/v1/sb/quotes?symbols=A,B` | **Groww** `latest_prices_ohlc` | **real-time** NSE (LTP/OHLC, change, volume, 52-wk, circuits) |
| `GET /api/v1/sb/intraday/{sym}?interval=30minute` | **Tickertape** `charts/inter` (ticks → OHLC buckets) | **real-time** NSE |
| `GET /api/v1/sb/candles/{sym}?range=6mo&interval=1d` | Yahoo | historical daily |
| `GET /api/v1/sb/history/{sym}?interval=30minute&from=&to=` | Yahoo | historical |
| `GET /api/v1/ping` | — | liveness |

A live endpoint that can't reach a real-time source returns nothing for that
symbol (`quotes`: omitted; `intraday`: `[]`) so the caller's armed cascade fills
it — **delayed data is never served as live.** Unimplemented `/sb/*` endpoints
(`context`, `fundamentals`, `resolve`) return `{}` so the caller falls back cleanly.

## How it works

- **Quotes** — fan out one Groww call per symbol in parallel, map to the exact
  superbrain quote shape. localhost chunks at 30 symbols/call, so each invocation
  makes ≤30 subrequests (well under the free plan's 50/invocation cap).
- **Intraday** — resolve the Tickertape `sid` (seeded for hot names, else one
  cached `/stocks/list?filter=<letter>` lookup), pull today's real ticks, bucket
  them into the requested interval's OHLC bars.
- **Edge cache** — short per-route TTL (quotes 5s, intraday 20s, candles 120s,
  history 600s) via the Cache API, so a burst of pollers shares one upstream
  sweep. Responses carry `x-edge-cache: HIT|MISS` + `x-edge-age`.

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

- Live = quotes + today's intraday. Historical candles/history = Yahoo.
- `context` / `fundamentals` / `resolve` not yet ported (return `{}` → caller
  fallback). Add later if needed.
- Free Workers: 100k req/day, 50 subrequests/invocation — fine for localhost's
  30-symbol chunks.
