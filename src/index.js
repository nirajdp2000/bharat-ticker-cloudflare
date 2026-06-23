/**
 * bharat-ticker-cloudflare — native scraper Worker (FREE plan), field-complete.
 *
 * Reimplements the bharat /api/v1/sb/* adapter directly on Cloudflare Workers
 * with plain `fetch` (no curl-cffi / native deps). All sources verified to
 * answer Cloudflare-style TLS: Groww, Tickertape, NSE public, Investing.com,
 * screener.in. No Northflank, no container, no paid plan.
 *
 * LATENCY CONTRACT — Yahoo is 15-min delayed, so it is used for PAST data ONLY,
 * never the current market day:
 *   /sb/quotes        LIVE  Groww latest_prices_ohlc (real-time NSE, rich)
 *   /sb/intraday/{s}  LIVE  Tickertape ticks → OHLC (today's session)
 *   /sb/candles/{s}   daily: Yahoo for dates < today; TODAY's bar from Groww
 *   /sb/history/{s}   Yahoo for dates < today; TODAY from Tickertape
 *   /sb/context       LIVE  NSE indices + Investing macro + NSE FII/DII + TT MMI
 *   /sb/fundamentals  screener.in ratios
 *   /sb/resolve       Tickertape universe
 * A live source that misses returns nothing (quotes omit / candles[] ) so the
 * caller's armed cascade fills it — delayed data is never served as live.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GROWW = (s) =>
  `https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_prices_ohlc/${encodeURIComponent(s)}`;
const TT = "https://api.tickertape.in";
const NSE = "https://www.nseindia.com";
const YH = (s) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}`;

const SID_SEED = { RELIANCE: "RELI" };

// macro label → Investing.com pairId (real-time chart)
const MACRO = { USDINR: 2124, BRENT: 8833, GOLD: 8830, SENSEX: 17936 };
// context index name → Tickertape index sid (fallback if NSE is IP-blocked)
const IDX_SID = { "NIFTY 50": ".NSEI", "NIFTY BANK": ".NSEBANK" };

const TTL = [
  { re: /^\/api\/v1\/ping$/, ttl: 0 },
  { re: /^\/api\/v1\/sb\/quotes/, ttl: 5 },
  { re: /^\/api\/v1\/sb\/intraday\//, ttl: 20 },
  { re: /^\/api\/v1\/sb\/candles\//, ttl: 120 },
  { re: /^\/api\/v1\/sb\/history\//, ttl: 600 },
  { re: /^\/api\/v1\/sb\/context/, ttl: 60 },
  { re: /^\/api\/v1\/sb\/(mmi)/, ttl: 60 },
  { re: /^\/api\/v1\/sb\/fundamentals\//, ttl: 3600 },
  { re: /^\/api\/v1\/sb\/(resolve|universe)/, ttl: 3600 },
];

// ── helpers ──────────────────────────────────────────────────────────────────
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type,x-api-key",
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });
function num(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}
const int = (v) => Math.trunc(num(v));
const ttlFor = (p) => (TTL.find((r) => r.re.test(p)) || { ttl: 0 }).ttl;

// IST helpers (the feed's market timezone)
function nowIST() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
function istDate() { return nowIST().toISOString().slice(0, 10); }
function isMarketOpen() {
  const d = nowIST(), dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
  if (!r.ok) return null;
  const t = await r.text();
  if (!t || !"{[".includes(t[0])) return null;
  try { return JSON.parse(t); } catch { return null; }
}
async function getText(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) return null;
  return r.text();
}
const ttGet = (path, qs = "") => getJson(`${TT}${path}${qs}`);
// NSE needs a Referer + Accept; its public JSON answers plain fetch when the IP
// isn't datacenter-blocked. Best-effort — null on block (caller degrades).
const nseGet = (path, referer) => getJson(`${NSE}${path}`, { Referer: referer || `${NSE}/`, "Accept-Language": "en-US,en;q=0.9" });

// ── LIVE quotes (Tickertape batch) ───────────────────────────────────────────
// NOTE: Groww answered a residential IP but BLOCKS Cloudflare's datacenter IPs
// (quotes came back empty from the deployed edge). Tickertape's batch endpoint
// IS reachable from Workers and is real-time NSE, so quotes route through it.
// Trade-off: Tickertape batch lacks Groww-only fields (circuits, 52-wk, buy/sell
// qty, OI) — none of which localhost consumes. `open` (which it DOES use) is
// recovered from the day's first intraday tick, cached per (symbol, day).
function ttToQuote(sym, r, open) {
  const price = num(r?.price);
  if (!(price > 0)) return null;
  const prev = num(r.close), change = num(r.change), live = isMarketOpen();
  const now = new Date().toISOString();
  const q = {
    symbol: sym, companyName: sym,
    price: +price.toFixed(2), change, changePct: prev > 0 ? +((change / prev) * 100).toFixed(2) : 0,
    open: open || undefined, high: num(r.high) || price, low: num(r.low) || price,
    volume: int(r.volume), previousClose: prev || undefined,
    source: "tickertape_realtime_nse", dataQuality: live ? "REAL_TIME" : "LAST_CLOSE", live,
    feedLatencyMs: 0, asOf: now, fetchedAt: now, feedLagSec: 0,
  };
  for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
  return q;
}
// Session open = first intraday tick; fixed once set at 09:15, so cache per
// (symbol, IST-day) — a quote sweep costs ~0 extra after the first fill.
async function openForSymbol(sid, ctx) {
  const key = new Request(`https://edge.open/${istDate()}/${encodeURIComponent(sid)}`);
  const hit = await caches.default.match(key);
  if (hit) { const v = Number(await hit.text()); return v > 0 ? v : null; }
  const j = await ttGet(`/stocks/charts/inter/${encodeURIComponent(sid)}`, `?duration=1d`);
  const pts = j?.data?.[0]?.points || [];
  const today = istDate();
  const first = pts.find((p) => String(p.ts).slice(0, 10) === today) || pts[0];
  const open = first ? num(first.lp) : 0;
  if (open > 0) ctx.waitUntil(caches.default.put(key, new Response(String(open), { headers: { "cache-control": "public, max-age=28800" } })));
  return open > 0 ? open : null;
}
async function handleQuotes(url, ctx) {
  const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 45);
  if (!symbols.length) return json({ quotes: [] });
  const sidMap = new Map();
  await Promise.all(symbols.map(async (s) => { const sid = await resolveSid(s, ctx); if (sid) sidMap.set(s, sid); }));
  if (!sidMap.size) return json({ quotes: [], count: 0, source: "tickertape_realtime_nse" });
  const j = await ttGet("/stocks/quotes", `?sids=${[...sidMap.values()].join(",")}`);
  const bySid = new Map((j?.data || []).map((r) => [r.sid, r]));
  const quotes = (await Promise.all([...sidMap.entries()].map(async ([sym, sid]) => {
    const r = bySid.get(sid); if (!r) return null;
    return ttToQuote(sym, r, await openForSymbol(sid, ctx).catch(() => null));
  }))).filter(Boolean);
  return json({ quotes, count: quotes.length, source: "tickertape_realtime_nse", asOf: new Date().toISOString() });
}

// ── sid resolution (Tickertape universe, cached per-letter) ──────────────────
async function letterList(letter, ctx) {
  letter = letter.toLowerCase();
  const key = new Request(`https://edge.sid/${letter}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const j = await ttGet("/stocks/list", `?filter=${letter}`);
  const rows = (j?.data || []).filter((x) => x?.ticker && x?.sid)
    .map((x) => ({ ticker: String(x.ticker).toUpperCase(), sid: x.sid, name: x.name || x.ticker, isin: x.isin || null }));
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(rows), { headers: { "cache-control": "public, max-age=86400" } })));
  return rows;
}
async function resolveSid(symbol, ctx) {
  symbol = symbol.toUpperCase();
  if (SID_SEED[symbol]) return SID_SEED[symbol];
  if (!/[A-Z]/.test(symbol[0])) return null;
  return (await letterList(symbol[0], ctx)).find((r) => r.ticker === symbol)?.sid || null;
}

// ── LIVE intraday (Tickertape ticks → OHLC) ──────────────────────────────────
function barMinutes(interval) {
  if (/day|^1d/i.test(interval)) return 1440;
  const m = String(interval || "").match(/(\d+)/);
  return Math.max(1, m ? Number(m[1]) : 30);
}
function bucketPoints(points, minutes) {
  const ms = minutes * 60_000, b = new Map();
  for (const p of points) {
    const t = Date.parse(p.ts); if (!Number.isFinite(t)) continue;
    const k = Math.floor(t / ms) * ms, lp = num(p.lp), v = int(p.v);
    let o = b.get(k);
    if (!o) { o = { open: lp, high: lp, low: lp, close: lp, volume: 0 }; b.set(k, o); }
    o.high = Math.max(o.high, lp); o.low = Math.min(o.low, lp); o.close = lp; o.volume += v;
  }
  return [...b.entries()].sort((a, c) => a[0] - c[0]).map(([k, o]) => {
    const ts = new Date(k).toISOString();
    return { timestamp: ts, open: o.open, high: o.high, low: o.low, close: o.close, volume: o.volume, oi: 0,
      0: ts, 1: o.open, 2: o.high, 3: o.low, 4: o.close, 5: o.volume };
  });
}
async function ttTodayBars(symbol, minutes, ctx) {
  const sid = await resolveSid(symbol, ctx);
  if (!sid) return [];
  const j = await ttGet(`/stocks/charts/inter/${encodeURIComponent(sid)}`, `?duration=1d`);
  const today = istDate();
  return bucketPoints(j?.data?.[0]?.points || [], minutes).filter((c) => c.timestamp.slice(0, 10) === today);
}
async function handleIntraday(url, symbol, ctx) {
  const interval = url.searchParams.get("interval") || "30minute";
  const sid = await resolveSid(symbol, ctx);
  if (!sid) return json({ candles: [], source: "tickertape", note: "sid-unresolved" });
  const j = await ttGet(`/stocks/charts/inter/${encodeURIComponent(sid)}`, `?duration=1d`);
  const candles = bucketPoints(j?.data?.[0]?.points || [], barMinutes(interval));
  return json({ candles, source: "tickertape_realtime_nse", interval,
    dataQuality: isMarketOpen() ? "REAL_TIME" : "TODAY_SESSION", count: candles.length });
}

// ── HISTORICAL candles/history (Yahoo for PAST; today from live) ─────────────
function yhInterval(interval) {
  const s = String(interval || "1d").toLowerCase();
  if (/day|^1d$/.test(s)) return "1d";
  const n = (s.match(/(\d+)/) || [, "30"])[1];
  return /hour|h/.test(s) ? `${n}h` : `${n}m`;
}
function yahooCandles(j) {
  const r = j?.chart?.result?.[0]; if (!r) return [];
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {}, out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    const t = new Date(ts[i] * 1000).toISOString();
    const o = num(q.open?.[i]), h = num(q.high?.[i]), l = num(q.low?.[i]), c = num(q.close[i]), v = int(q.volume?.[i]);
    out.push({ timestamp: t, open: o, high: h, low: l, close: c, volume: v, oi: 0, 0: t, 1: o, 2: h, 3: l, 4: c, 5: v });
  }
  return out;
}
async function handleCandles(url, symbol, ctx) {
  const range = url.searchParams.get("range") || "6mo";
  const interval = yhInterval(url.searchParams.get("interval") || "1d");
  const today = istDate();
  const j = await getJson(`${YH(symbol + ".NS")}?range=${range}&interval=${interval}`);
  let candles = yahooCandles(j).filter((c) => c.timestamp.slice(0, 10) < today);   // Yahoo = PAST only
  let liveLast = false;
  if (interval === "1d") {
    // TODAY's daily bar from the live Tickertape session (aggregate the day's
    // ticks into one OHLC bar) — never Yahoo for the current day.
    const tb = await ttTodayBars(symbol, 1440, ctx).catch(() => []);
    const b = tb[tb.length - 1];
    if (b) {
      const ts = `${today}T03:45:00.000Z`;
      candles.push({ timestamp: ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, oi: 0,
        0: ts, 1: b.open, 2: b.high, 3: b.low, 4: b.close, 5: b.volume });
      liveLast = true;
    }
  }
  return json({ symbol, interval, range, count: candles.length, liveLastBar: liveLast, candles, pastSource: "yahoo", todaySource: liveLast ? "tickertape_live" : null });
}
async function handleHistory(url, symbol, ctx) {
  const rawInt = url.searchParams.get("interval") || "30minute";
  const interval = yhInterval(rawInt);
  const from = url.searchParams.get("from"), to = url.searchParams.get("to");
  const today = istDate();
  let qs = `interval=${interval}`;
  if (from && to) qs += `&period1=${Math.floor(Date.parse(from) / 1000)}&period2=${Math.floor(Date.parse(to) / 1000) + 86400}`;
  else qs += `&range=${url.searchParams.get("range") || "3mo"}`;
  const j = await getJson(`${YH(symbol + ".NS")}?${qs}`);
  let candles = yahooCandles(j).filter((c) => c.timestamp.slice(0, 10) < today);   // Yahoo = PAST only
  // TODAY from the live scraper (Tickertape), never Yahoo.
  const todayBars = await ttTodayBars(symbol, barMinutes(rawInt), ctx).catch(() => []);
  candles = candles.concat(todayBars).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return json({ symbol, interval, count: candles.length, candles, pastSource: "yahoo", todaySource: todayBars.length ? "tickertape_live" : null });
}

// ── LIVE context (indices + macro + FII/DII + MMI) ───────────────────────────
async function macroOne(pairId) {
  const j = await getJson(`https://api.investing.com/api/financialdata/${pairId}/historical/chart/?period=P1M&interval=P1D&pointscount=60`, { "domain-id": "www" });
  const rows = j?.data || [];
  const closes = rows.map((r) => r?.[4]).filter((x) => x != null);
  if (closes.length < 2) return null;
  const price = num(closes.at(-1)), prev = num(closes.at(-2));
  if (!(price > 0) || !(prev > 0)) return null;
  return { price: +price.toFixed(2), changePct: +(((price - prev) / prev) * 100).toFixed(2), source: "investing.com" };
}
async function nseIndices() {
  const j = await nseGet("/api/allIndices", `${NSE}/market-data/live-equity-market`);
  const out = {};
  for (const d of j?.data || []) {
    const name = String(d.index || "").toUpperCase();
    out[name] = { last: num(d.last), changePct: num(d.percentChange), change: num(d.variation),
      advances: d.advances != null ? int(d.advances) : null, declines: d.declines != null ? int(d.declines) : null };
  }
  return out;
}
async function ttIndex(sid) {
  const j = await ttGet("/stocks/quotes", `?sids=${encodeURIComponent(sid)}`);
  const r = j?.data?.[0]; if (!r) return null;
  const prev = num(r.close), last = num(r.price);
  return { last, change: num(r.change), changePct: prev > 0 ? +(((last - prev) / prev) * 100).toFixed(2) : 0, advances: null, declines: null };
}
async function nseFiiDii() {
  const j = await nseGet("/api/fiidiiTradeReact", `${NSE}/reports-indices-fii-dii`);
  const rows = Array.isArray(j) ? j : j?.data || [];
  let fii = null, dii = null, date = null;
  for (const r of rows) {
    const cat = String(r.category || "").toUpperCase();
    const net = r.netValue ?? r.net; date = r.date || date;
    const v = net != null ? num(net) : null;
    if (cat.includes("FII") || cat.includes("FPI")) fii = v; else if (cat.includes("DII")) dii = v;
  }
  if (fii == null && dii == null) return null;
  return { date, fiiNetBuy: fii || 0, diiNetBuy: dii || 0, mood: (fii || 0) >= 0 ? "BULLISH" : "BEARISH", source: "NSE_PUBLIC" };
}
async function handleContext() {
  const NAMES = ["NIFTY 50", "NIFTY BANK", "NIFTY NEXT 50", "NIFTY IT", "NIFTY MIDCAP 100"];
  const [idxAll, mUS, mBR, mGO, mSE, fiiDii, mmiRaw] = await Promise.all([
    nseIndices().catch(() => ({})),
    macroOne(MACRO.USDINR).catch(() => null), macroOne(MACRO.BRENT).catch(() => null),
    macroOne(MACRO.GOLD).catch(() => null), macroOne(MACRO.SENSEX).catch(() => null),
    nseFiiDii().catch(() => null), ttGet("/mmi/now").catch(() => null),
  ]);
  const indices = {};
  for (const n of NAMES) if (idxAll[n]) indices[n] = idxAll[n];
  // fallback for the core indices if NSE was blocked
  for (const [n, sid] of Object.entries(IDX_SID)) if (!indices[n]) { const t = await ttIndex(sid).catch(() => null); if (t) indices[n] = t; }
  const vix = idxAll["INDIA VIX"]?.last ?? null;
  const macro = {}; if (mUS) macro.USDINR = mUS; if (mBR) macro.BRENT = mBR; if (mGO) macro.GOLD = mGO; if (mSE) macro.SENSEX = mSE;
  const niftyPct = indices["NIFTY 50"]?.changePct || 0;
  const usdinrPct = macro.USDINR?.changePct || 0, brentPct = macro.BRENT?.changePct || 0;
  const riskOn = niftyPct - Math.max(0, usdinrPct * 0.8) - Math.max(0, brentPct * 0.5);
  const regime = riskOn >= 0.8 ? "RISK_ON" : riskOn <= -0.8 ? "RISK_OFF" : "BALANCED";
  return json({ regime, riskOnScore: +riskOn.toFixed(2), indices, vix, macro, fiiDii,
    marketMood: mmiRaw?.data || mmiRaw || null, marketOpen: isMarketOpen(), generatedAt: nowIST().toISOString() });
}

// ── fundamentals (screener.in) ───────────────────────────────────────────────
const RATIO_RE = /<li[^>]*>[\s\S]*?<span[^>]*class="name"[^>]*>\s*([\s\S]*?)\s*<\/span>[\s\S]*?<span[^>]*class="number"[^>]*>\s*([\d,.\-]+)\s*<\/span>/gi;
function lastRowValue(sectionHtml, label) {
  const rows = sectionHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) if (row.toLowerCase().includes(label.toLowerCase())) {
    const tds = [...row.matchAll(/<td[^>]*>\s*(-?[\d,]+\.?\d*)\s*<\/td>/gi)].map((m) => num(m[1]));
    if (tds.length) return tds.at(-1);
  }
  return null;
}
async function handleFundamentals(symbol) {
  const variants = [symbol, symbol.replace(/&/g, ""), symbol.replace(/-/g, "")];
  for (const v of variants) {
    const html = await getText(`https://www.screener.in/company/${encodeURIComponent(v)}/consolidated/`).catch(() => null)
      || await getText(`https://www.screener.in/company/${encodeURIComponent(v)}/`).catch(() => null);
    if (!html || html.length < 5000) continue;
    const ratios = {};
    for (const m of html.matchAll(RATIO_RE)) ratios[m[1].replace(/\s+/g, " ").trim().toLowerCase()] = num(m[2]);
    const gv = (...keys) => { for (const k of keys) for (const rk in ratios) if (rk.includes(k.toLowerCase())) return ratios[rk]; return null; };
    const price = gv("current price"), bv = gv("book value");
    const pe = gv("stock p/e", "p/e");
    const plStart = html.indexOf('id="profit-loss"'), bsStart = html.indexOf('id="balance-sheet"'), cfStart = html.indexOf('id="cash-flow"');
    const plHtml = plStart > -1 ? html.slice(plStart, bsStart > -1 ? bsStart : plStart + 35000) : "";
    const bsHtml = bsStart > -1 ? html.slice(bsStart, cfStart > -1 ? cfStart : bsStart + 25000) : "";
    const sales = lastRowValue(plHtml, "Sales") ?? lastRowValue(plHtml, "Revenue") ?? lastRowValue(plHtml, "Total Income");
    const np = lastRowValue(plHtml, "Net Profit") ?? lastRowValue(plHtml, "Profit after tax");
    const borrow = lastRowValue(bsHtml, "Borrowings"), eqCap = lastRowValue(bsHtml, "Equity Capital"), reserves = lastRowValue(bsHtml, "Reserves");
    const promoter = html.match(/Promoters[\s\S]{0,400}?<td[^>]*>\s*(\d{1,2}\.\d{1,2})%/i);
    const opm = html.match(/OPM\s*%[\s\S]{0,100}?<td[^>]*>\s*(-?\d+\.?\d*)\s*%?\s*<\/td>/i);
    const data = {
      symbol, pe, pb: price && bv > 0 ? +(price / bv).toFixed(2) : null,
      roe: gv("roe"), roce: gv("roce"),
      debtToEquity: borrow != null && eqCap != null && reserves != null && eqCap + reserves !== 0 ? +(borrow / (eqCap + reserves)).toFixed(2) : null,
      promoterHolding: promoter ? num(promoter[1]) : null,
      dividendYield: gv("dividend yield"), operatingMargin: opm ? num(opm[1]) : null,
      netMargin: sales > 0 && np != null ? +((np / sales) * 100).toFixed(1) : null,
      marketCap: gv("market cap"), bookValue: bv, faceValue: gv("face value"),
      eps: gv("eps") || (price && pe > 0 ? +(price / pe).toFixed(2) : null),
      source: "screener.in",
    };
    if (["pe", "pb", "roe", "roce", "marketCap"].some((k) => data[k] != null)) return json(data);
  }
  return json({ symbol, source: "unavailable" }, 200);
}

// ── resolve / universe (Tickertape) ──────────────────────────────────────────
async function handleResolve(url, ctx) {
  const q = (url.searchParams.get("q") || "").trim().toUpperCase();
  if (!q) return json({ query: q, count: 0, matches: [] });
  const rows = await letterList(q[0], ctx).catch(() => []);
  const exact = rows.filter((r) => r.ticker === q);
  const partial = rows.filter((r) => r.ticker !== q && r.ticker.includes(q));
  const matches = [...exact, ...partial].slice(0, 20).map((r) => ({ symbol: r.ticker, name: r.name, exchange: "NSE", isin: r.isin }));
  return json({ query: q, count: matches.length, matches });
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

    const ttl = ttlFor(pathname);
    const ckey = new Request("https://edge.cache" + pathname + url.search);
    if (ttl > 0) {
      const hit = await caches.default.match(ckey);
      if (hit) {
        const age = (Date.now() - Number(hit.headers.get("x-edge-stored") || 0)) / 1000;
        if (age <= ttl) { const h = new Headers(hit.headers); h.set("x-edge-cache", "HIT"); h.set("x-edge-age", age.toFixed(1)); return new Response(hit.body, { status: hit.status, headers: h }); }
      }
    }

    const seg = decodeURIComponent(pathname.split("/").pop());
    let resp;
    try {
      if (pathname === "/api/v1/sb/quotes") resp = await handleQuotes(url, ctx);
      else if (pathname.startsWith("/api/v1/sb/intraday/")) resp = await handleIntraday(url, seg, ctx);
      else if (pathname.startsWith("/api/v1/sb/candles/")) resp = await handleCandles(url, seg, ctx);
      else if (pathname.startsWith("/api/v1/sb/history/")) resp = await handleHistory(url, seg, ctx);
      else if (pathname === "/api/v1/sb/context") resp = await handleContext();
      else if (pathname === "/api/v1/sb/mmi") { const m = await ttGet("/mmi/now"); resp = json(m?.data || m || {}); }
      else if (pathname.startsWith("/api/v1/sb/fundamentals/")) resp = await handleFundamentals(seg);
      else if (pathname === "/api/v1/sb/resolve") resp = await handleResolve(url, ctx);
      else if (pathname === "/api/v1/sb/diagnostics") resp = json({ ok: true, live: ["groww", "tickertape", "nse", "investing"], historical: ["yahoo"], fundamentals: ["screener.in"] });
      else if (pathname.startsWith("/api/v1/sb/")) resp = json({});
      else resp = json({ error: "not-found", path: pathname }, 404);
    } catch (e) {
      resp = json({ error: "worker-exception", detail: String(e?.message || e) }, 200);
    }

    if (ttl > 0 && resp.status === 200) {
      const body = await resp.clone().arrayBuffer();
      const h = new Headers(resp.headers);
      h.set("x-edge-stored", Date.now().toString());
      h.set("x-edge-cache", "MISS");
      h.set("cache-control", `public, max-age=${ttl}`);
      ctx.waitUntil(caches.default.put(ckey, new Response(body, { status: 200, headers: h })));
      return new Response(body, { status: 200, headers: h });
    }
    return resp;
  },
};
