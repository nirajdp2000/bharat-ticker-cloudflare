/**
 * bharat-ticker-cloudflare — native scraper Worker (FREE plan).
 *
 * Reimplements the bharat /api/v1/sb/* adapter directly on Cloudflare Workers,
 * fetching real Indian-market data with plain `fetch` (no curl-cffi / no native
 * deps) — verified that Groww + Tickertape answer Cloudflare-style TLS without
 * browser impersonation. No Northflank, no container, no paid plan.
 *
 * DATA-LATENCY CONTRACT (do not break — mirrors the app's armed rule):
 *   LIVE  (lowest-latency, REAL-TIME only — NEVER Yahoo):
 *     • /sb/quotes          → Groww latest_prices_ohlc (real-time NSE, rich)
 *     • /sb/intraday/{sym}  → Tickertape charts/inter (real NSE ticks → OHLC)
 *   HISTORICAL (Yahoo allowed — it is 15-min delayed, fine for the past):
 *     • /sb/candles/{sym}   → Yahoo daily OHLCV
 *     • /sb/history/{sym}   → Yahoo intraday/daily over a date range
 *
 * A LIVE endpoint that can't get a real-time source returns nothing for that
 * symbol (quotes: omit; intraday: []) so the caller's armed cascade fills it —
 * we never serve delayed data dressed up as live.
 *
 * Free-plan limit respected: ≤50 subrequests per invocation. localhost chunks
 * /sb/quotes at 30 symbols/call → 30 Groww fetches, safely under the cap.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GROWW = (sym) =>
  `https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_prices_ohlc/${encodeURIComponent(sym)}`;
const TT = "https://api.tickertape.in";
const YH = (sym) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`;

// Verified sids so the hottest symbol needs no /stocks/list lookup.
const SID_SEED = { RELIANCE: "RELI" };

// Per-route edge cache (seconds). Absorbs repeated polls so a burst of pollers
// shares ONE upstream sweep. Keys are full path+query, so each 30-symbol chunk
// localhost sends is its own entry.
const TTL = [
  { re: /^\/api\/v1\/ping$/, ttl: 0 },
  { re: /^\/api\/v1\/sb\/quotes/, ttl: 5 },
  { re: /^\/api\/v1\/sb\/intraday\//, ttl: 20 },
  { re: /^\/api\/v1\/sb\/candles\//, ttl: 120 },
  { re: /^\/api\/v1\/sb\/history\//, ttl: 600 },
];

// ── small helpers ────────────────────────────────────────────────────────────
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type,x-api-key",
};
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}
function num(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}
const int = (v) => Math.trunc(num(v));
function ttlFor(pathname) {
  for (const r of TTL) if (r.re.test(pathname)) return r.ttl;
  return 0;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
  if (!r.ok) return null;
  const t = await r.text();
  if (!t || !"{[".includes(t[0])) return null;
  try { return JSON.parse(t); } catch { return null; }
}
const ttGet = (path, qs = "") => getJson(`${TT}${path}${qs}`);

// ── LIVE: quotes (Groww, real-time NSE) ──────────────────────────────────────
function growwToQuote(sym, d) {
  const price = num(d.ltp) || num(d.close);
  if (!(price > 0)) return null;
  const prev = num(d.close);
  const q = {
    symbol: sym,
    companyName: sym,            // localhost overlays its own name/sector
    sector: "Unknown",
    price: Number(price.toFixed(2)),
    high: num(d.high) || price,
    low: num(d.low) || price,
    change: num(d.dayChange),
    changePct: num(d.dayChangePerc),
    volume: int(d.volume),
    source: "groww",
    dataQuality: "live",
    feedLagSec: 0,
    asOf: d.tsInMillis ? new Date(Number(d.tsInMillis)).toISOString() : new Date().toISOString(),
  };
  if (num(d.open) > 0) q.open = num(d.open);
  if (prev > 0) q.previousClose = prev;
  if (num(d.yearHighPrice) > 0) q.week52High = num(d.yearHighPrice);
  if (num(d.yearLowPrice) > 0) q.week52Low = num(d.yearLowPrice);
  if (num(d.highPriceRange) > 0) q.upperCircuit = num(d.highPriceRange);
  if (num(d.lowPriceRange) > 0) q.lowerCircuit = num(d.lowPriceRange);
  return q;
}

async function handleQuotes(url) {
  const raw = (url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const symbols = [...new Set(raw)].slice(0, 45);   // dedupe + stay under the subrequest cap
  if (symbols.length === 0) return json({ quotes: [] });
  const settled = await Promise.allSettled(
    symbols.map(async (s) => growwToQuote(s, await getJson(GROWW(s)))),
  );
  const quotes = settled.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
  return json({ quotes, count: quotes.length, source: "groww", asOf: new Date().toISOString() });
}

// ── LIVE: intraday (Tickertape real ticks → OHLC buckets) ────────────────────
async function letterMap(letter, ctx) {
  letter = letter.toLowerCase();
  const key = new Request(`https://edge.sid/${letter}`);
  const hit = await caches.default.match(key);
  if (hit) return new Map(Object.entries(await hit.json()));
  const j = await ttGet("/stocks/list", `?filter=${letter}`);
  const m = {};
  for (const x of j?.data || []) if (x?.ticker && x?.sid) m[String(x.ticker).toUpperCase()] = x.sid;
  ctx.waitUntil(
    caches.default.put(key, new Response(JSON.stringify(m), { headers: { "cache-control": "public, max-age=86400" } })),
  );
  return new Map(Object.entries(m));
}
async function resolveSid(symbol, ctx) {
  symbol = symbol.toUpperCase();
  if (SID_SEED[symbol]) return SID_SEED[symbol];
  const first = symbol[0];
  if (!/[A-Z]/.test(first)) return null;
  return (await letterMap(first, ctx)).get(symbol) || null;
}
// minutes per bar from an interval token like "30minute" / "5m" / "1d".
function barMinutes(interval) {
  const m = String(interval || "").match(/(\d+)/);
  const n = m ? Number(m[1]) : 30;
  return /day|^1d|d$/i.test(interval) ? 1440 : Math.max(1, n);
}
function bucketPoints(points, minutes) {
  const ms = minutes * 60_000;
  const buckets = new Map();
  for (const p of points) {
    const t = Date.parse(p.ts);
    if (!Number.isFinite(t)) continue;
    const b = Math.floor(t / ms) * ms;
    const lp = num(p.lp), v = int(p.v);
    let o = buckets.get(b);
    if (!o) { o = { open: lp, high: lp, low: lp, close: lp, volume: 0 }; buckets.set(b, o); }
    o.high = Math.max(o.high, lp);
    o.low = Math.min(o.low, lp);
    o.close = lp;
    o.volume += v;
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, o]) => {
    const ts = new Date(b).toISOString();
    return { timestamp: ts, open: o.open, high: o.high, low: o.low, close: o.close, volume: o.volume, oi: 0,
      0: ts, 1: o.open, 2: o.high, 3: o.low, 4: o.close, 5: o.volume };
  });
}
async function handleIntraday(url, symbol, ctx) {
  const interval = url.searchParams.get("interval") || "30minute";
  const sid = await resolveSid(symbol, ctx);
  if (!sid) return json({ candles: [], source: "tickertape", note: "sid-unresolved" });   // armed-fill upstream, never Yahoo
  const j = await ttGet(`/stocks/charts/inter/${encodeURIComponent(sid)}`, `?duration=1d`);
  const points = j?.data?.[0]?.points || [];
  const candles = bucketPoints(points, barMinutes(interval));
  return json({ candles, source: "tickertape", interval, asOf: new Date().toISOString() });
}

// ── HISTORICAL: candles + history (Yahoo — delayed, fine for the past) ────────
function yhInterval(interval) {
  const s = String(interval || "1d").toLowerCase();
  if (/day|^1d$/.test(s)) return "1d";
  const n = (s.match(/(\d+)/) || [, "30"])[1];
  if (/hour|h/.test(s)) return `${n}h`;
  return `${n}m`;
}
function yahooCandles(j) {
  const r = j?.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null) continue;
    const t = new Date(ts[i] * 1000).toISOString();
    const o = num(q.open?.[i]), h = num(q.high?.[i]), l = num(q.low?.[i]), cl = num(c), v = int(q.volume?.[i]);
    out.push({ timestamp: t, open: o, high: h, low: l, close: cl, volume: v, oi: 0,
      0: t, 1: o, 2: h, 3: l, 4: cl, 5: v });
  }
  return out;
}
async function handleCandles(url, symbol) {
  const range = url.searchParams.get("range") || "6mo";
  const interval = yhInterval(url.searchParams.get("interval") || "1d");
  const j = await getJson(`${YH(symbol + ".NS")}?range=${range}&interval=${interval}`);
  return json({ candles: yahooCandles(j), source: "yahoo", range, interval });
}
async function handleHistory(url, symbol) {
  const interval = yhInterval(url.searchParams.get("interval") || "30minute");
  const from = url.searchParams.get("from"), to = url.searchParams.get("to");
  let qs = `interval=${interval}`;
  if (from && to) qs += `&period1=${Math.floor(Date.parse(from) / 1000)}&period2=${Math.floor(Date.parse(to) / 1000) + 86400}`;
  else qs += `&range=${url.searchParams.get("range") || "3mo"}`;
  const j = await getJson(`${YH(symbol + ".NS")}?${qs}`);
  return json({ candles: yahooCandles(j), source: "yahoo", interval });
}

// ── router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "method-not-allowed" }, 405);

    if (pathname === "/" || pathname === "/api/v1/ping")
      return json({ pong: true, service: "bharat-ticker-cloudflare", runtime: "workers-native", ts: new Date().toISOString() });

    // edge cache for cacheable GETs (absorbs repeated polls within TTL)
    const ttl = ttlFor(pathname);
    const ckey = new Request("https://edge.cache" + pathname + url.search);
    if (ttl > 0) {
      const hit = await caches.default.match(ckey);
      if (hit) {
        const age = (Date.now() - Number(hit.headers.get("x-edge-stored") || 0)) / 1000;
        if (age <= ttl) {
          const h = new Headers(hit.headers); h.set("x-edge-cache", "HIT"); h.set("x-edge-age", age.toFixed(1));
          return new Response(hit.body, { status: hit.status, headers: h });
        }
      }
    }

    let resp;
    try {
      if (pathname === "/api/v1/sb/quotes") resp = await handleQuotes(url);
      else if (pathname.startsWith("/api/v1/sb/intraday/")) resp = await handleIntraday(url, decodeURIComponent(pathname.split("/").pop()), ctx);
      else if (pathname.startsWith("/api/v1/sb/candles/")) resp = await handleCandles(url, decodeURIComponent(pathname.split("/").pop()));
      else if (pathname.startsWith("/api/v1/sb/history/")) resp = await handleHistory(url, decodeURIComponent(pathname.split("/").pop()));
      else if (pathname === "/api/v1/sb/diagnostics") resp = json({ ok: true, live: ["groww", "tickertape"], historical: ["yahoo"] });
      // Endpoints not (yet) reimplemented (context/fundamentals/resolve): 200 empty
      // so localhost falls through its own sources instead of erroring.
      else if (pathname.startsWith("/api/v1/sb/")) resp = json({});
      else resp = json({ error: "not-found", path: pathname }, 404);
    } catch (e) {
      resp = json({ error: "worker-exception", detail: String(e?.message || e) }, 200); // 200-empty-ish → caller armed-fills
    }

    if (ttl > 0 && resp.status === 200) {
      const body = await resp.clone().arrayBuffer();
      const h = new Headers(resp.headers);
      h.set("x-edge-stored", Date.now().toString());
      h.set("x-edge-cache", "MISS");
      // Explicit cache-control so the Cloudflare edge actually stores it (the
      // Cache API skips responses with no caching directive). Our own x-edge-age
      // check still governs freshness; this is just to make `put` stick.
      // NOTE: a no-op under `wrangler dev --local` (miniflare doesn't persist the
      // default cache) — it caches normally once deployed to the edge.
      h.set("cache-control", `public, max-age=${ttl}`);
      ctx.waitUntil(caches.default.put(ckey, new Response(body, { status: 200, headers: h })));
      return new Response(body, { status: 200, headers: h });
    }
    return resp;
  },
};
