// The gate in front of the Honcho API when this server is shared with the owner's
// other computers. The Cloudflare tunnel reaches only this process, never the API.
//
// Every request must carry `Authorization: Bearer <HONCHO_GATE_TOKEN>`. Only
// `GET /health` and `/v3/*` are forwarded, to http://api:8000 on the Compose
// network. Bodies stream both ways, so a dialectic chat's SSE answer arrives as it
// is written. No dependencies: it runs with the dashboard image's Node.
import crypto from "node:crypto";
import http from "node:http";

const TOKEN = String(process.env.HONCHO_GATE_TOKEN || "").trim();
const UPSTREAM = new URL(process.env.HONCHO_GATE_UPSTREAM || "http://api:8000");
const LISTEN_HOST = process.env.HONCHO_GATE_LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.HONCHO_GATE_LISTEN_PORT ?? 8010);
// The collector sends at most 100 messages of 24,000 characters in one request:
// about 7 MB of Korean text, 14 MB if every character were escaped. 20 MB is above both.
const MAX_BODY_BYTES = Number(process.env.HONCHO_GATE_MAX_BODY_BYTES || 20 * 1024 * 1024);

// RFC 9110 section 7.6.1, plus the proxy credentials that are for this hop only.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const upstreamAgent = new http.Agent({ keepAlive: true });
const tokenDigest = crypto.createHash("sha256").update(TOKEN).digest();

function reply(res, status, body) {
  if (res.headersSent) { res.destroy(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** Constant-time: both sides are hashed first, so their lengths never differ. */
function authorized(header) {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(header || ""));
  if (!match) return false;
  const presented = crypto.createHash("sha256").update(match[1]).digest();
  return crypto.timingSafeEqual(presented, tokenDigest);
}

/**
 * Only origin-form targets, and no dot segments in any spelling, so a path that
 * looks like /v3/ here cannot resolve to something else upstream.
 */
function allowed(method, target) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) return false;
  const pathname = target.split("?", 1)[0];
  if (pathname.includes("\\")) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return false;
  if (pathname === "/health") return method === "GET" || method === "HEAD";
  return pathname.startsWith("/v3/");
}

function forwardHeaders(source, extra = {}) {
  const named = new Set(String(source.connection || "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean));
  const result = {};
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || named.has(key)) continue;
    result[key] = value;
  }
  return { ...result, ...extra };
}

function handle(req, res) {
  if (!authorized(req.headers.authorization)) {
    return reply(res, 401, { error: "unauthorized", detail: "This server needs its gate token as a Bearer token." });
  }
  if (!allowed(req.method, req.url)) return reply(res, 404, { error: "not_found" });
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return reply(res, 413, { error: "payload_too_large", limitBytes: MAX_BODY_BYTES });
  }

  // The Authorization header goes upstream unchanged: Honcho runs with auth off
  // and ignores it. Host becomes the API's own name, which its TRUSTED_HOSTS lists.
  const upstream = http.request({
    protocol: UPSTREAM.protocol,
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || 80,
    method: req.method,
    path: req.url,
    agent: upstreamAgent,
    headers: forwardHeaders(req.headers, { host: UPSTREAM.host }),
  });

  upstream.on("response", (answer) => {
    res.writeHead(answer.statusCode || 502, forwardHeaders(answer.headers));
    res.flushHeaders();
    answer.pipe(res);
    answer.on("error", () => res.destroy());
  });
  let refused = false;
  upstream.on("error", () => { if (!refused) reply(res, 502, { error: "upstream_unavailable" }); });
  // A caller that goes away mid-stream ends the upstream request too.
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });

  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY_BYTES && !refused) {
      refused = true;
      req.unpipe(upstream);
      upstream.destroy();
      reply(res, 413, { error: "payload_too_large", limitBytes: MAX_BODY_BYTES });
      req.resume();
    }
  });
  req.pipe(upstream);
}

if (!TOKEN) {
  process.stderr.write("HONCHO_GATE_TOKEN is empty; the gate does not start without a token.\n");
  process.exit(1);
}

const server = http.createServer(handle);
// A dialectic answer can stream for minutes; only the request itself is timed.
server.requestTimeout = 600_000;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  process.stdout.write(`${JSON.stringify({ gate: "listening", port: server.address().port, upstream: UPSTREAM.origin })}\n`);
});

// As PID 1 in its container, Node would otherwise ignore the stop signal.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
