# bharat-ticker-cloudflare

Cloudflare **Worker edge proxy + cache** that sits in **front of** the Northflank
`bharat-ticker` deployment. It speeds up reads at Cloudflare's edge and gives you
CDN / WAF / custom-domain in front of the API — **without touching Northflank**.

## Why this is a proxy, not a port

The real `bharat-ticker` app cannot run on Cloudflare:

- `curl-cffi` — native libcurl (TLS impersonation for Groww/Tickertape/BSE)
- `playwright` — needs a real Chromium process
- `asyncpg` / `uvloop` — native, persistent event loop
- live tick-sampler / SSE / in-memory cache — need a **long-lived process**

Cloudflare Workers run on V8 isolates (or Pyodide WASM) with no persistent
process and no native binaries, so a faithful port is impossible. The app stays
on Northflank; this Worker just proxies + caches it at the edge.

```
client ──▶ Cloudflare Worker (this repo) ──▶ Northflank bharat-ticker (origin)
              edge cache / SWR / CORS              real app, unchanged
```

## What it does

- Proxies every path to `ORIGIN` (set in `wrangler.toml`).
- Edge-caches GET reads with per-route TTL + **stale-while-revalidate**
  (serves stale instantly, refreshes in background). See `CACHE_RULES` in
  [`src/worker.js`](src/worker.js).
- Passes **SSE** (`/sb/stream/*`), **WebSocket** (`/ws/ticks*`), and all
  POST/mutations straight through, uncached.
- Adds CORS. Optional client API-key gate.

| Route | Edge TTL | Stale-while-revalidate |
|---|---|---|
| `/sb/quotes`, `/sb/quote/*` | 5s | 10s |
| `/sb/intraday/*` | 20s | 40s |
| `/sb/scans`, `/sb/screen` | 30s | 60s |
| `/sb/candles/*`, `/sb/history/*` | 120s | 600s |
| `/sb/context`, `/sb/mmi` | 300s | 900s |
| `/sb/fundamentals/*`, `/sb/universe`, `/sb/resolve`, `/sb/intervals` | 1h | 2h |
| `/sb/stream/*`, `/ws/*`, `/sb/recorder`, `/sb/warm`, `/sb/cache`, `/sb/diagnostics`, `/ping` | no cache | — |

Every response carries `x-edge-cache: HIT | STALE | MISS | BYPASS` and
`x-edge-age` so you can see what the edge did.

## Deploy

```bash
npm install
npx wrangler deploy
```

First deploy prompts a Cloudflare login. Worker goes live at
`https://bharat-ticker-cloudflare.<your-subdomain>.workers.dev`.

### Config

Edit `wrangler.toml` → `[vars].ORIGIN` if the Northflank URL changes.

Optional secrets (never commit these):

```bash
wrangler secret put CLIENT_API_KEY   # require x-api-key on every request
wrangler secret put ORIGIN_API_KEY   # forwarded to origin as x-edge-key
```

### Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in secrets if you use them
npx wrangler dev
```

## Custom domain (optional)

In the Cloudflare dashboard: **Workers & Pages → this worker → Settings →
Domains & Routes → Add custom domain** (e.g. `api.yourdomain.com`). DNS is wired
automatically; Northflank is unaffected.

## Test after deploy

```bash
curl -i https://bharat-ticker-cloudflare.<sub>.workers.dev/api/v1/ping
curl -i https://bharat-ticker-cloudflare.<sub>.workers.dev/api/v1/sb/quotes?symbols=RELIANCE
#   ^ second identical call within 5s returns x-edge-cache: HIT
```
