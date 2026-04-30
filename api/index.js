// api/index.js
// Edge Relay - Optimized for stealth

export const config = {
  runtime: "edge",
  regions: ["iad1", "cdg1", "sin1", "hnd1"],
};

const ORIGIN_SERVER = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const BYPASS_TOKEN = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
const RATE_LIMIT_MAX = 45;
const RATE_WINDOW_MS = 60 * 1000;

const REMOVED_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port", "x-vercel-proxy-signature"
]);

const rateLimiter = new Map();

function isRateLimited(clientId) {
  const now = Date.now();
  const records = rateLimiter.get(clientId) || [];
  const recent = records.filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimiter.set(clientId, recent);
  return false;
}

function genRequestId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

function healthCheck() {
  return new Response(
    JSON.stringify({
      status: "ok",
      time: new Date().toISOString(),
      service: "edge-relay"
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Request-ID": genRequestId(),
      },
    }
  );
}

export default async function handler(req) {
  const url = new URL(req.url);
  
  if (url.pathname === "/health" || url.pathname === "/_health") {
    return healthCheck();
  }

  if (!ORIGIN_SERVER) {
    return new Response(
      JSON.stringify({ error: "Service unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const clientIp = req.headers.get("cf-connecting-ip") ||
                   req.headers.get("x-forwarded-for")?.split(",")[0] ||
                   "unknown";

  if (isRateLimited(clientIp)) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded", retryAfter: 60 }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } }
    );
  }

  try {
    const target = ORIGIN_SERVER + url.pathname + url.search;
    
    const headers = new Headers();
    let realIp = null;
    
    for (const [k, v] of req.headers) {
      const key = k.toLowerCase();
      if (REMOVED_HEADERS.has(key)) continue;
      if (key.startsWith("x-vercel-")) continue;
      if (key === "x-real-ip") { realIp = v; continue; }
      if (key === "x-forwarded-for") { if (!realIp) realIp = v; continue; }
      headers.set(key, v);
    }
    
    headers.set("x-request-id", genRequestId());
    headers.set("x-edge-region", process.env.VERCEL_REGION || "auto");
    
    if (realIp) headers.set("x-forwarded-for", realIp);
    if (BYPASS_TOKEN) headers.set("x-vercel-protection-bypass", BYPASS_TOKEN);
    
    const method = req.method;
    const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method);
    
    const fetchOpts = { method, headers, redirect: "manual" };
    
    if (hasBody) {
      const cl = req.headers.get("content-length");
      if (cl && parseInt(cl) > 10 * 1024 * 1024) {
        return new Response(
          JSON.stringify({ error: "Payload too large" }),
          { status: 413, headers: { "Content-Type": "application/json" } }
        );
      }
      fetchOpts.body = req.body;
      fetchOpts.duplex = "half";
    }
    
    const upstream = await fetch(target, fetchOpts);
    
    const respHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (lk === "transfer-encoding") continue;
      if (lk === "alt-svc") continue;
      respHeaders.set(k, v);
    }
    
    respHeaders.set("x-content-type-options", "nosniff");
    
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
    
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Service unavailable" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
