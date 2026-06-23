/**
 * bharat-ticker-cloudflare — edge proxy Worker.
 *
 * Sits in FRONT of the Northflank bharat-ticker origin. It does NOT run the
 * app (curl-cffi / playwright / asyncpg / live-sampler all need a persistent
 * Python process — impossible on Workers). It proxies + edge-caches the HTTP
 * API at Cloudflare's edge, and transparently passes SSE/WebSocket/POST
 * straight through. Northflank stays the single source of truth.
 *
 * Config via wrangler.toml [vars] / secrets:
 *   ORIGIN          required  e.g. https://p01--bharat-ticker--xxxx.code.run
 *   CORS_ORIGIN     optional  default "*"
 *   CLIENT_API_KEY  optional  if set, callers must send x-api-key / ?key=
 *   ORIGIN_API_KEY  optional  if set, forwarded to origin as x-edge-key
 */

// path-pattern -> { ttl, swr } in seconds. First match wins (order matters).
// ttl  = serve from edge without touching origin.
// swr  = extra window where we serve stale instantly + revalidate in background.
const CACHE_RULES = [
  // --- never cache: streaming / live / admin / mutations ---
  { re: /^\/api\/v1\/(ws|sb\/stream)\//, ttl: 0, swr: 0 },        // SSE + WS
  { re: /^\/api\/v1\/sb\/(recorder|warm|cache|diagnostics)/, ttl: 0, swr: 0 },
  { re: /^\/api\/v1\/ping/, ttl: 0, swr: 0 },

  // --- live quotes: very short edge cache absorbs burst/fan-out ---
  { re: /^\/api\/v1\/sb\/quotes/, ttl: 5, swr: 10 },
  { re: /^\/api\/v1\/sb\/quote\//, ttl: 5, swr: 10 },

  // --- today's intraday bars: ~30s on origin ---
  { re: /^\/api\/v1\/sb\/intraday\//, ttl: 20, swr: 40 },

  // --- scans / screens ---
  { re: /^\/api\/v1\/sb\/(scans|screen)/, ttl: 30, swr: 60 },

  // --- macro context ---
  { re: /^\/api\/v1\/sb\/(context|mmi)/, ttl: 300, swr: 900 },

  // --- historical candles (daily mostly static; trailing bar refreshes) ---
  { re: /^\/api\/v1\/sb\/(candles|history)\//, ttl: 120, swr: 600 },

  // --- slow-moving reference ---
  { re: /^\/api\/v1\/sb\/fundamentals\//, ttl: 3600, swr: 7200 },
  { re: /^\/api\/v1\/sb\/(universe|resolve|intervals)/, ttl: 3600, swr: 7200 },
];

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function ruleFor(pathname) {
  for (const r of CACHE_RULES) if (r.re.test(pathname)) return r;
  return { ttl: 0, swr: 0 }; // default: pass through, no cache
}

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.CORS_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key,authorization",
    "access-control-max-age": "86400",
  };
}

function withExtra(resp, extra) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function unauthorized(env) {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

// Build the upstream request to the Northflank origin.
function buildOriginRequest(request, url, origin, env) {
  const target = origin.replace(/\/$/, "") + url.pathname + url.search;
  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.delete("host");
  if (env.ORIGIN_API_KEY) headers.set("x-edge-key", env.ORIGIN_API_KEY);
  return new Request(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });
}

// Stable cache key independent of which CF hostname was used to reach us.
function cacheKey(url) {
  return new Request("https://edge.cache" + url.pathname + url.search, { method: "GET" });
}

async function revalidate(originReq, key, rule, ctx) {
  try {
    const fresh = await fetch(originReq);
    if (fresh.ok) ctx.waitUntil(storeInCache(key, fresh.clone(), rule));
  } catch (_) { /* keep last-good */ }
}

async function storeInCache(key, resp, rule) {
  const h = new Headers(resp.headers);
  h.set("x-edge-stored", Date.now().toString());
  h.set("cache-control", `public, max-age=${rule.ttl + rule.swr}`);
  await caches.default.put(key, new Response(resp.body, { status: resp.status, headers: h }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ORIGIN;

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(env) });

    if (!origin)
      return new Response("ORIGIN not configured", { status: 500 });

    // optional client gate
    if (env.CLIENT_API_KEY) {
      const supplied = request.headers.get("x-api-key") || url.searchParams.get("key");
      if (supplied !== env.CLIENT_API_KEY) return unauthorized(env);
    }

    const isUpgrade = (request.headers.get("upgrade") || "").toLowerCase() === "websocket";
    const rule = ruleFor(url.pathname);
    const originReq = buildOriginRequest(request, url, origin, env);

    // WebSocket: proxy the upgrade straight through, untouched.
    if (isUpgrade) return fetch(originReq);

    // Non-GET or non-cacheable (SSE/admin/mutations): transparent passthrough.
    if (request.method !== "GET" || rule.ttl === 0) {
      const resp = await fetch(originReq);
      return withExtra(resp, { ...corsHeaders(env), "x-edge-cache": "BYPASS" });
    }

    // Cacheable GET — manual stale-while-revalidate over the Cache API.
    const key = cacheKey(url);
    const hit = await caches.default.match(key);
    if (hit) {
      const stored = Number(hit.headers.get("x-edge-stored") || 0);
      const ageS = (Date.now() - stored) / 1000;
      if (ageS <= rule.ttl)
        return withExtra(hit, { ...corsHeaders(env), "x-edge-cache": "HIT", "x-edge-age": ageS.toFixed(1) });
      // stale but within SWR: serve immediately, refresh in background.
      ctx.waitUntil(revalidate(buildOriginRequest(request, url, origin, env), key, rule, ctx));
      return withExtra(hit, { ...corsHeaders(env), "x-edge-cache": "STALE", "x-edge-age": ageS.toFixed(1) });
    }

    // Miss: fetch origin, cache if OK, return.
    const resp = await fetch(originReq);
    if (resp.ok) ctx.waitUntil(storeInCache(key, resp.clone(), rule));
    return withExtra(resp, { ...corsHeaders(env), "x-edge-cache": "MISS" });
  },
};
