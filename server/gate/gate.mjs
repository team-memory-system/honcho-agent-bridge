// The gate in front of the Honcho API when this server is shared. The Cloudflare
// tunnel reaches only this process, never the API or the MCP bridge.
//
// Two doors, each with its own key:
//   - `GET /health` and `/v3/*`, for the owner's other computers, need
//     `Authorization: Bearer <HONCHO_GATE_TOKEN>` and go to http://api:8000 on the
//     Compose network.
//   - `/mcp` and `/mcp/*`, for teammates' MCP clients, need a Cloudflare Access
//     login instead. The `Cf-Access-Jwt-Assertion` Cloudflare adds must be signed by
//     the team's key (HONCHO_GATE_ACCESS_TEAM_DOMAIN), name this app's audience
//     (HONCHO_GATE_ACCESS_AUD, comma-separated for several) and carry a person's
//     email. The request then goes to the MCP bridge (HONCHO_GATE_MCP_UPSTREAM) with
//     the caller's own credentials replaced by HONCHO_TEAM_MCP_TOKEN and the verified
//     email. Until all four are set, /mcp is not found.
// Bodies stream both ways, so a dialectic chat's SSE answer arrives as it is
// written. No dependencies: it runs with the dashboard image's Node.
import crypto from "node:crypto";
import http from "node:http";

const TOKEN = String(process.env.HONCHO_GATE_TOKEN || "").trim();
const UPSTREAM = new URL(process.env.HONCHO_GATE_UPSTREAM || "http://api:8000");
const LISTEN_HOST = process.env.HONCHO_GATE_LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.HONCHO_GATE_LISTEN_PORT ?? 8010);
// The collector sends at most 100 messages of 24,000 characters in one request:
// about 7 MB of Korean text, 14 MB if every character were escaped. 20 MB is above both.
const MAX_BODY_BYTES = Number(process.env.HONCHO_GATE_MAX_BODY_BYTES || 20 * 1024 * 1024);

// Cloudflare Access in front of /mcp. The team domain may be written with its
// scheme or a trailing slash; the issuer Cloudflare signs is always https://<domain>.
const ACCESS_TEAM_DOMAIN = String(process.env.HONCHO_GATE_ACCESS_TEAM_DOMAIN || "")
  .trim().replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase();
const ACCESS_AUDIENCES = String(process.env.HONCHO_GATE_ACCESS_AUD || "")
  .split(",").map((item) => item.trim()).filter(Boolean);
const TEAM_MCP_TOKEN = String(process.env.HONCHO_TEAM_MCP_TOKEN || "").trim();
const MCP_UPSTREAM_SETTING = String(process.env.HONCHO_GATE_MCP_UPSTREAM || "").trim();
const ACCESS_ISSUER = `https://${ACCESS_TEAM_DOMAIN}`;
// Only the tests set this, to serve the keys from a local server; Compose never does.
const ACCESS_CERTS_URL = String(process.env.HONCHO_GATE_ACCESS_CERTS_URL || "").trim()
  || `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const CLOCK_LEEWAY_SECONDS = 60;
// An unknown key id makes the gate look at the team's keys again, at most once a
// minute, so made-up key ids cannot make it hammer Cloudflare. The keys are also
// fetched again after an hour, so a key Cloudflare retired stops being trusted.
const KEYS_REFETCH_MS = 60_000;
const KEYS_MAX_AGE_MS = 60 * 60_000;

/** What /mcp lacks, or nothing when it is on. */
function mcpMissing() {
  const missing = [];
  let upstream = null;
  try { upstream = new URL(MCP_UPSTREAM_SETTING); } catch {}
  if (upstream?.protocol !== "http:") missing.push("HONCHO_GATE_MCP_UPSTREAM");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ACCESS_TEAM_DOMAIN)) missing.push("HONCHO_GATE_ACCESS_TEAM_DOMAIN");
  if (!ACCESS_AUDIENCES.length) missing.push("HONCHO_GATE_ACCESS_AUD");
  // It goes into a header as it is, so it must be one printable token.
  if (!/^[\x21-\x7e]+$/.test(TEAM_MCP_TOKEN)) missing.push("HONCHO_TEAM_MCP_TOKEN");
  return missing;
}
const MCP_MISSING = mcpMissing();
const MCP_UPSTREAM = MCP_MISSING.length ? null : new URL(MCP_UPSTREAM_SETTING);

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
 * Where a request may go: "mcp" for /mcp and /mcp/*, "api" for GET /health and
 * /v3/*, else nowhere (null). Only origin-form targets, and no dot segments in any
 * spelling, so a path that looks like /v3/ or /mcp here cannot resolve to
 * something else upstream.
 */
function routeFor(method, target) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) return null;
  const pathname = target.split("?", 1)[0];
  if (pathname.includes("\\")) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return "mcp";
  if (pathname === "/health") return method === "GET" || method === "HEAD" ? "api" : null;
  return pathname.startsWith("/v3/") ? "api" : null;
}

function forwardHeaders(source, extra = {}, drop = () => false) {
  const named = new Set(String(source.connection || "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean));
  const result = {};
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || named.has(key) || drop(key)) continue;
    result[key] = value;
  }
  return { ...result, ...extra };
}

// ------------------------------------------------------------ Cloudflare Access

const accessKeys = { keys: null, loadedAt: 0, failedAt: -Infinity, refetchedAt: -Infinity, loading: null };

/** The team's RS256 keys by key id. A failed fetch keeps the keys already known. */
async function fetchAccessKeys() {
  try {
    const response = await fetch(ACCESS_CERTS_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const keys = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      try {
        keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }));
      } catch {}
    }
    if (!keys.size) throw new Error("no RS256 signing keys");
    accessKeys.keys = keys;
    accessKeys.loadedAt = Date.now();
  } catch (error) {
    accessKeys.failedAt = Date.now();
    process.stderr.write(`${JSON.stringify({ gate: "access_keys_unavailable", detail: String(error?.message || error) })}\n`);
  }
}

/** One fetch at a time; requests that arrive meanwhile wait for the same one. */
function loadAccessKeys() {
  if (!accessKeys.loading) {
    accessKeys.loading = fetchAccessKeys().finally(() => { accessKeys.loading = null; });
  }
  return accessKeys.loading;
}

async function accessKey(kid) {
  let fetched = false;
  const stale = !accessKeys.keys || Date.now() - accessKeys.loadedAt > KEYS_MAX_AGE_MS;
  if (stale && Date.now() - accessKeys.failedAt >= KEYS_REFETCH_MS) {
    await loadAccessKeys();
    fetched = true;
  }
  let key = accessKeys.keys?.get(kid);
  // A key Cloudflare rotated in since the last fetch.
  if (!key && !fetched && Date.now() - accessKeys.refetchedAt >= KEYS_REFETCH_MS) {
    accessKeys.refetchedAt = Date.now();
    await loadAccessKeys();
    key = accessKeys.keys?.get(kid);
  }
  return key || null;
}

function jsonSegment(segment) {
  const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value;
}

/**
 * The verified email of the person behind a request, or why there is none. Only
 * the reason is ever logged; no claim is echoed back to the caller.
 */
async function accessPerson(assertion) {
  if (typeof assertion !== "string" || !assertion) return { reason: "missing" };
  const parts = assertion.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return { reason: "malformed" };
  let header;
  let claims;
  try {
    header = jsonSegment(parts[0]);
    claims = jsonSegment(parts[1]);
  } catch {
    return { reason: "malformed" };
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return { reason: "algorithm" };
  const key = await accessKey(header.kid);
  if (!key) return { reason: "unknown_key" };
  let signed = false;
  try {
    signed = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  } catch {}
  if (!signed) return { reason: "signature" };
  if (claims.iss !== ACCESS_ISSUER) return { reason: "issuer" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((audience) => typeof audience === "string" && ACCESS_AUDIENCES.includes(audience))) {
    return { reason: "audience" };
  }
  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_LEEWAY_SECONDS) return { reason: "expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || now < claims.nbf - CLOCK_LEEWAY_SECONDS)) {
    return { reason: "not_yet_valid" };
  }
  // People only: a service token's assertion has a common_name and no email.
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (!email || claims.common_name) return { reason: "not_a_person" };
  // It goes into a header as it is.
  if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(email) || email.length > 320) return { reason: "email" };
  return { email };
}

/** Everything the caller sent that could speak for someone, or for another workspace or peer. */
function callerCredential(key) {
  return key === "authorization" || key === "cookie" || key.startsWith("cf-access-") || key.startsWith("x-honcho-");
}

async function handleMcp(req, res) {
  if (!MCP_UPSTREAM) return reply(res, 404, { error: "not_found" });
  let person;
  try { person = await accessPerson(req.headers["cf-access-jwt-assertion"]); }
  catch { person = { reason: "error" }; }
  if (!person.email) {
    process.stderr.write(`${JSON.stringify({ gate: "mcp_refused", reason: person.reason })}\n`);
    return reply(res, 401, { error: "unauthorized", detail: "This path needs a Cloudflare Access login." });
  }
  if (res.destroyed || req.socket?.destroyed) return;
  return forward(req, res, MCP_UPSTREAM, forwardHeaders(req.headers, {
    host: MCP_UPSTREAM.host,
    authorization: `Bearer ${TEAM_MCP_TOKEN}`,
    "cf-access-authenticated-user-email": person.email,
  }, callerCredential));
}

function handle(req, res) {
  const route = routeFor(req.method, req.url);
  // A teammate has no gate token, only a Cloudflare Access login; the gate token
  // stays the owner's.
  if (route === "mcp") {
    return handleMcp(req, res).catch(() => reply(res, 502, { error: "upstream_unavailable" }));
  }
  if (!authorized(req.headers.authorization)) {
    return reply(res, 401, { error: "unauthorized", detail: "This server needs its gate token as a Bearer token." });
  }
  if (route !== "api") return reply(res, 404, { error: "not_found" });
  // The Authorization header goes upstream unchanged: Honcho runs with auth off
  // and ignores it. Host becomes the API's own name, which its TRUSTED_HOSTS lists.
  return forward(req, res, UPSTREAM, forwardHeaders(req.headers, { host: UPSTREAM.host }));
}

function forward(req, res, target, headers) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return reply(res, 413, { error: "payload_too_large", limitBytes: MAX_BODY_BYTES });
  }

  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: req.url,
    agent: upstreamAgent,
    headers,
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
  process.stdout.write(`${JSON.stringify({
    gate: "listening",
    port: server.address().port,
    upstream: UPSTREAM.origin,
    mcp: MCP_UPSTREAM?.origin || null,
  })}\n`);
  // Said once, so an /mcp that answers 404 can be traced to what it lacks.
  if (MCP_UPSTREAM_SETTING && MCP_MISSING.length) {
    process.stderr.write(`${JSON.stringify({ gate: "mcp_off", missing: MCP_MISSING })}\n`);
  }
});

// As PID 1 in its container, Node would otherwise ignore the stop signal.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
