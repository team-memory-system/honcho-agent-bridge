// The gate in front of this server when it is shared. The Cloudflare tunnel reaches
// only this process, never the Honcho API or the MCP bridge, and Cloudflare Access
// covers the whole host, so whatever comes through the tunnel carries a login.
//
// Who is calling:
//   - `Authorization: Bearer <HONCHO_GATE_TOKEN>`: the owner, for `GET /health` and
//     `/v3/*` only, passed to the API (HONCHO_GATE_UPSTREAM, http://api:8000 on the
//     Compose network) as it was sent. The Compose health check holds this token.
//   - otherwise a person, by the `Cf-Access-Jwt-Assertion` Cloudflare adds. It must
//     be signed by the team's key (HONCHO_GATE_ACCESS_TEAM_DOMAIN), name this app's
//     audience (HONCHO_GATE_ACCESS_AUD, comma-separated for several) and carry a
//     person's email. Until both are set, only the gate token works.
//
// What a person may do is in HONCHO_GATE_STATE_DIR (/gate-state):
//   - access.json, written by the owner's app and read again when it changes
//     (looked at once a second at most): the owners, the teammates who may `chat`
//     (with the projects opened to them) and those who collect into this server.
//     Missing or unreadable, it lets nobody in but the gate token.
//   - devices.json, written by the gate alone. A computer that writes here
//     registers once and then sends `X-Team-Memory-Device: <id>.<secret>`; only the
//     secret's hash is kept, and access.json can revoke one device.
//
// The doors:
//   GET    /team-memory/whoami        any person: what this server lets them do
//   POST   /team-memory/devices       an owner or a collector: a new device key
//   DELETE /team-memory/devices/<id>  that device itself
//   GET    /health                    an owner, or a person with chat or collect
//   /v3/*                             a person's registered device: an owner's
//                                     requests as sent; a collector's only when they
//                                     write or read back their own conversations
//   /mcp, /mcp/*                      an owner (every project) or a person with chat
//                                     (the projects opened to them), to the MCP
//                                     bridge (HONCHO_GATE_MCP_UPSTREAM) with
//                                     HONCHO_TEAM_MCP_TOKEN, the verified email and
//                                     the scope headers. Until upstream, team domain,
//                                     audience and token are all set, it is not found.
// A person's credentials and device key never go upstream, and on /mcp no
// x-honcho-* header of theirs does either, so the bridge can trust the gate's.
// Bodies stream both ways, so a dialectic chat's SSE answer arrives as it is
// written; only a collector's requests are read whole, to be checked and rewritten.
// No dependencies: it runs with the dashboard image's Node.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const TOKEN = String(process.env.HONCHO_GATE_TOKEN || "").trim();
const UPSTREAM = new URL(process.env.HONCHO_GATE_UPSTREAM || "http://api:8000");
const LISTEN_HOST = process.env.HONCHO_GATE_LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.HONCHO_GATE_LISTEN_PORT ?? 8010);
// The collector sends at most 100 messages of 24,000 characters in one request:
// about 7 MB of Korean text, 14 MB if every character were escaped. 20 MB is above both.
const MAX_BODY_BYTES = Number(process.env.HONCHO_GATE_MAX_BODY_BYTES || 20 * 1024 * 1024);
// A registration says only the computer's name.
const DEVICE_BODY_BYTES = 16 * 1024;

// Cloudflare Access in front of every door. The team domain may be written with its
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

// What the owner allows (access.json) and the computers that registered (devices.json).
const STATE_DIR = path.resolve(String(process.env.HONCHO_GATE_STATE_DIR || "").trim() || "/gate-state");
const ACCESS_FILE = path.join(STATE_DIR, "access.json");
const DEVICES_FILE = path.join(STATE_DIR, "devices.json");
const ACCESS_CHECK_MS = 1_000;
const SEEN_WRITE_MS = 60_000;
const MAX_DEVICES_PER_EMAIL = 50;
const DEVICE_HEADER = "x-team-memory-device";
// <id>.<secret>: d- and 16 hex, then 32 random bytes in base64url.
const DEVICE_KEY = /^(d-[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
const DEVICE_ID = /^d-[0-9a-f]{16}$/;
const DEVICE_PATH = /^\/team-memory\/devices\/(d-[0-9a-f]{16})$/;
const SCOPE_ID = /^p-[0-9a-f]{12}$/;
// Honcho's own rule for workspace and session names, so none needs escaping in a path.
const RESOURCE_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_SESSION_ID_LENGTH = 512;

/** What telling people apart lacks, or nothing when Access is on. */
function accessMissing() {
  const missing = [];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ACCESS_TEAM_DOMAIN)) missing.push("HONCHO_GATE_ACCESS_TEAM_DOMAIN");
  if (!ACCESS_AUDIENCES.length) missing.push("HONCHO_GATE_ACCESS_AUD");
  return missing;
}
const ACCESS_MISSING = accessMissing();
const ACCESS_ON = !ACCESS_MISSING.length;

/** What /mcp lacks, or nothing when it is on. */
function mcpMissing() {
  const missing = [];
  let upstream = null;
  try { upstream = new URL(MCP_UPSTREAM_SETTING); } catch {}
  if (upstream?.protocol !== "http:") missing.push("HONCHO_GATE_MCP_UPSTREAM");
  missing.push(...ACCESS_MISSING);
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
const NOT_FOUND = Object.freeze({ error: "not_found" });

function log(event) {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

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

/** A refusal, with its reason in the log. A reason never carries a claim, a key or a token. */
function refuse(res, door, status, body, reason) {
  log({ gate: "refused", door, status, reason });
  reply(res, status, body);
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest();

/** Constant-time: both sides are hashed first, so their lengths never differ. */
function holdsGateToken(header) {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(header || ""));
  if (!match) return false;
  return crypto.timingSafeEqual(sha256(match[1]), tokenDigest);
}

/**
 * Which door a request knocks on, or null for none: "health" (GET /health), "api"
 * (/v3/*), "mcp" (/mcp, /mcp/*), "whoami", "register" and "unregister" (the gate's
 * own /team-memory/*). Only origin-form targets, and no dot segments in any
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
  if (pathname === "/health") return method === "GET" || method === "HEAD" ? "health" : null;
  if (pathname.startsWith("/v3/")) return "api";
  if (pathname === "/team-memory/whoami") return method === "GET" ? "whoami" : null;
  if (pathname === "/team-memory/devices") return method === "POST" ? "register" : null;
  if (DEVICE_PATH.test(pathname)) return method === "DELETE" ? "unregister" : null;
  return null;
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

// Some servers read "_" in a header name as "-", so a name is judged both ways.
const headerName = (key) => key.replace(/_/g, "-");
/** The device key is the gate's alone: it goes nowhere upstream. */
const deviceKeyHeader = (key) => headerName(key).startsWith("x-team-memory-");
/** What a person sent that could speak for them. None of it goes upstream. */
function personCredential(key) {
  const name = headerName(key);
  return name === "authorization" || name === "cookie" || name.startsWith("cf-access-") || deviceKeyHeader(name);
}
/** On /mcp also anything that could pick another workspace, peer or scope. */
const mcpCredential = (key) => personCredential(key) || headerName(key).startsWith("x-honcho-");
// A collector's body is sent as the gate wrote it, with headers to match.
const BODY_HEADERS = new Set(["content-length", "content-type", "content-encoding", "expect"]);

/** The whole request body. Past `limit` bytes it rejects with `tooLarge`. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error("payload too large"), { tooLarge: true });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) { reject(tooLarge()); return; }
    const chunks = [];
    let received = 0;
    const onData = (chunk) => {
      received += chunk.length;
      if (received <= limit) { chunks.push(chunk); return; }
      req.off("data", onData);
      req.resume();
      reject(tooLarge());
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
    req.once("close", () => reject(new Error("the caller went away")));
  });
}

// Bytes that are not UTF-8 are refused, not silently replaced.
const utf8 = new TextDecoder("utf-8", { fatal: true });

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
    log({ gate: "access_keys_unavailable", detail: String(error?.message || error) });
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

// ------------------------------------------------------------------ access.json

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const filledString = (value) => typeof value === "string" && value !== "";
const lowerEmail = (value) => value.trim().toLowerCase();

/** access.json as the gate uses it. Anything but version 1 throws, which lets nobody in. */
function policyFrom(raw) {
  if (!isObject(raw) || raw.version !== 1) throw new Error("not a version 1 access file");
  const workspace = filledString(raw.workspace) ? raw.workspace : null;
  const people = new Map();
  for (const [email, entry] of Object.entries(isObject(raw.people) ? raw.people : {})) {
    if (!isObject(entry)) continue;
    let chat = null;
    if (isObject(entry.chat)) {
      // Each project goes to the MCP bridge as a scope, so only well-formed ones.
      const projects = Array.isArray(entry.chat.projects) ? entry.chat.projects : [];
      chat = {
        projects: projects
          .filter((project) => isObject(project) && typeof project.id === "string" && SCOPE_ID.test(project.id) && typeof project.name === "string")
          .map(({ id, name }) => ({ id, name })),
      };
    }
    let collect = null;
    if (isObject(entry.collect)) {
      // Their own workspace, else the server's. One that is set but empty or not a
      // string is no workspace at all.
      const own = entry.collect.workspace;
      collect = own === undefined || own === null ? workspace : filledString(own) ? own : null;
    }
    people.set(lowerEmail(email), { peer: filledString(entry.peer) ? entry.peer : null, chat, collect });
  }
  return {
    owners: new Set((Array.isArray(raw.owners) ? raw.owners : []).filter((email) => typeof email === "string").map(lowerEmail)),
    people,
    revoked: new Set((Array.isArray(raw.revokedDevices) ? raw.revokedDevices : []).filter((id) => typeof id === "string")),
  };
}

const access = { policy: null, version: null, checkedAt: -Infinity, checking: null };

/** Reads access.json again when it changed since the last look. */
async function refreshAccess() {
  access.checkedAt = Date.now();
  let version;
  try {
    const stat = await fsp.stat(ACCESS_FILE);
    // A rename, a rewrite and a chmod each change one of these.
    version = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch (error) {
    version = error?.code === "ENOENT" ? "missing" : "unreadable";
  }
  if (version === access.version) return;
  access.version = version;
  access.policy = null;
  if (version === "missing" || version === "unreadable") {
    log({ gate: "access_file", state: version });
    return;
  }
  try {
    access.policy = policyFrom(JSON.parse(await fsp.readFile(ACCESS_FILE, "utf8")));
    log({ gate: "access_file", state: "loaded", owners: access.policy.owners.size, people: access.policy.people.size });
  } catch {
    log({ gate: "access_file", state: "unreadable" });
  }
}

/** access.json as it is now, looked at once a second at most. Null lets nobody in. */
async function currentPolicy() {
  if (!access.checking && Date.now() - access.checkedAt >= ACCESS_CHECK_MS) {
    access.checking = refreshAccess().finally(() => { access.checking = null; });
  }
  if (access.checking) await access.checking;
  return access.policy;
}

/** What the person with this (lower-case) email may do under `policy`. */
function rolesOf(policy, email) {
  const person = policy?.people.get(email);
  return {
    owner: Boolean(policy?.owners.has(email)),
    peer: person?.peer ?? null,
    chat: person?.chat ?? null,
    // The workspace a collector writes to, or null.
    collect: person?.collect ?? null,
  };
}

// ----------------------------------------------------------------- devices.json

// <id> -> { email, name, keyHash, createdAt, lastSeenAt }, as devices.json has them.
const devices = new Map();
let devicesWriting = Promise.resolve();
// lastSeenAt reaches the file at most once a minute (and when the gate stops).
const seen = { dirty: false, timer: null, flushedAt: -Infinity };

function validDevice(id, device) {
  return DEVICE_ID.test(id) && isObject(device) && filledString(device.email) && typeof device.name === "string"
    && typeof device.keyHash === "string" && /^[0-9a-f]{64}$/.test(device.keyHash)
    && typeof device.createdAt === "string" && (device.lastSeenAt == null || typeof device.lastSeenAt === "string");
}

/** devices.json into memory. One that cannot be read is logged and replaced on the next write. */
async function loadDevices() {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(DEVICES_FILE, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") log({ gate: "devices_file", state: "unreadable" });
    return;
  }
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.devices)) {
    log({ gate: "devices_file", state: "unreadable" });
    return;
  }
  for (const [id, device] of Object.entries(raw.devices)) {
    if (!validDevice(id, device)) continue;
    const { email, name, keyHash, createdAt, lastSeenAt } = device;
    devices.set(id, { email: lowerEmail(email), name, keyHash, createdAt, lastSeenAt: lastSeenAt ?? null });
  }
}

/** Runs `task` after every earlier change to devices.json, so two writes never cross. */
function devicesTask(task) {
  const run = devicesWriting.then(task);
  devicesWriting = run.catch(() => {});
  return run;
}

/** devices.json from memory: owner-only, replaced in one rename. */
async function saveDevices() {
  seen.dirty = false;
  const text = `${JSON.stringify({ version: 1, devices: Object.fromEntries(devices) }, null, 2)}\n`;
  const temporary = path.join(STATE_DIR, `.devices.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await fsp.writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, DEVICES_FILE);
  } catch (error) {
    seen.dirty = true;
    await fsp.rm(temporary, { force: true }).catch(() => {});
    log({ gate: "devices_file", state: "unwritable", code: error?.code || "error" });
    throw error;
  }
}

/** An authorized /v3 request of this device: it was seen now. */
function deviceSeen(id) {
  const device = devices.get(id);
  if (!device) return;
  device.lastSeenAt = new Date().toISOString();
  seen.dirty = true;
  if (seen.timer) return;
  seen.timer = setTimeout(() => {
    seen.timer = null;
    if (!seen.dirty) return;
    seen.flushedAt = Date.now();
    devicesTask(saveDevices).catch(() => {});
  }, Math.max(0, seen.flushedAt + SEEN_WRITE_MS - Date.now()));
  seen.timer.unref();
}

/**
 * The device a request names in X-Team-Memory-Device, when it is valid: registered
 * here, the secret's hash matching (constant time), registered by this email and
 * not revoked. Otherwise why not, for the log.
 */
function deviceOf(header, email, policy) {
  if (header === undefined) return { reason: "no_device" };
  const match = DEVICE_KEY.exec(String(header).trim());
  if (!match) return { reason: "device_malformed" };
  const [, id, secret] = match;
  const device = devices.get(id);
  // Hashed and compared whether or not the id is known.
  const presented = sha256(secret);
  const expected = device ? Buffer.from(device.keyHash, "hex") : Buffer.alloc(presented.length);
  if (!crypto.timingSafeEqual(presented, expected) || !device) return { reason: "device_unknown" };
  if (device.email !== email) return { reason: "device_of_another" };
  if (!policy || policy.revoked.has(id)) return { reason: "device_revoked" };
  return { id, device };
}

/** 1 to 64 printable characters (any script, no control or line-breaking ones), or null. */
function deviceName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = [...name].length;
  return length >= 1 && length <= 64 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(name) ? name : null;
}

const DEVICES_UNWRITABLE = Object.freeze({ error: "devices_unwritable", detail: "The gate could not save its list of devices." });

async function registerDevice(req, res, email, roles, policy) {
  if (!roles.owner && !roles.collect) {
    return refuse(res, "register", 403, {
      error: "forbidden",
      detail: "Only this server's owners and the teammates who collect into it register a computer here.",
    }, "not_allowed");
  }
  let body;
  try {
    body = JSON.parse(utf8.decode(await readBody(req, DEVICE_BODY_BYTES)));
  } catch (error) {
    if (error?.tooLarge) return reply(res, 413, { error: "payload_too_large", limitBytes: DEVICE_BODY_BYTES });
    if (res.destroyed) return;
    return reply(res, 400, { error: "invalid_request", detail: "Send the computer's name as JSON: {\"name\": \"...\"}." });
  }
  const name = deviceName(body?.name);
  if (!name) return reply(res, 400, { error: "invalid_name", detail: "A device name is 1 to 64 printable characters." });
  let made;
  try {
    made = await devicesTask(async () => {
      // A revoked device no longer counts: the owner freed its place.
      let active = 0;
      for (const [id, device] of devices) if (device.email === email && !policy?.revoked.has(id)) active += 1;
      if (active >= MAX_DEVICES_PER_EMAIL) return null;
      let id;
      do id = `d-${crypto.randomBytes(8).toString("hex")}`; while (devices.has(id));
      const secret = crypto.randomBytes(32).toString("base64url");
      devices.set(id, { email, name, keyHash: sha256(secret).toString("hex"), createdAt: new Date().toISOString(), lastSeenAt: null });
      try {
        await saveDevices();
      } catch (error) {
        devices.delete(id);
        throw error;
      }
      // The only time the secret leaves the gate. `key` is the header's whole value.
      return { id, key: `${id}.${secret}`, name };
    });
  } catch {
    return reply(res, 500, DEVICES_UNWRITABLE);
  }
  if (!made) {
    return refuse(res, "register", 429, {
      error: "too_many_devices",
      detail: `This email already has ${MAX_DEVICES_PER_EMAIL} computers registered here, the most there can be.`,
    }, "device_limit");
  }
  return reply(res, 201, made);
}

async function unregisterDevice(res, id, device) {
  if (device.id !== id) {
    return refuse(res, "unregister", 403, {
      error: "forbidden",
      detail: "Only the device itself, with its own key, removes it.",
    }, device.reason || "device_other");
  }
  try {
    await devicesTask(async () => {
      const record = devices.get(id);
      if (!record) return;
      devices.delete(id);
      try {
        await saveDevices();
      } catch (error) {
        devices.set(id, record);
        throw error;
      }
    });
  } catch {
    return reply(res, 500, DEVICES_UNWRITABLE);
  }
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

// ---------------------------------------------------------- collecting teammates

const COLLECT_REFUSED = Object.freeze({ error: "forbidden", detail: "This server takes only your own conversations" });
// The three requests a collector may send, to POST: a session, its messages, and
// reading those back. Raw segments only: an escaped one is never one of these.
const COLLECT_PATH = /^\/v3\/workspaces\/([A-Za-z0-9_-]+)\/sessions(?:\/([A-Za-z0-9_-]+)\/messages(\/list)?)?$/;
const SESSION_KEYS = ["id", "metadata", "peers", "configuration", "scopes"];
const MESSAGE_KEYS = ["peer_id", "content", "metadata", "created_at", "configuration"];
const LIST_QUERY = ["page", "size", "reverse"];

/** A teammate's sessions on a company server: tm- + 12 hex of sha256(lower-case email) + _. */
function sessionPrefix(email) {
  return `tm-${sha256(email.toLowerCase()).toString("hex").slice(0, 12)}_`;
}

/** `id` as one of the person's own sessions, or null when it cannot be one. */
function ownSession(id, prefix) {
  if (typeof id !== "string" || !RESOURCE_NAME.test(id)) return null;
  const own = id.startsWith(prefix) ? id : `${prefix}${id}`;
  return own.length <= MAX_SESSION_ID_LENGTH ? own : null;
}

/** A peer a collector may write as: their own, or an agent's or an automation's. */
function peerAllowed(peer, roles) {
  if (typeof peer !== "string") return false;
  return (roles.peer !== null && peer === roles.peer) || peer.startsWith("assistant_") || peer.startsWith("automation_");
}

const onlyKeys = (value, allowed) => isObject(value) && Object.keys(value).every((key) => allowed.includes(key));

/**
 * Where a collector's request goes, or why it is refused. Checked before the body is
 * read: the method, the path, the workspace, the query and the session in the path.
 */
function collectTarget(method, target, roles, prefix) {
  if (method !== "POST") return { reason: "collect_method" };
  const queryAt = target.indexOf("?");
  const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
  const search = queryAt < 0 ? "" : target.slice(queryAt + 1);
  const match = COLLECT_PATH.exec(pathname);
  if (!match) return { reason: "collect_path" };
  const [, workspace, session, list] = match;
  if (workspace !== roles.collect) return { reason: "collect_workspace" };
  const kind = !session ? "session" : list ? "list" : "messages";
  let query = "";
  if (kind === "list") {
    const params = new URLSearchParams(search);
    if ([...params.keys()].some((key) => !LIST_QUERY.includes(key))) return { reason: "collect_query" };
    query = params.toString();
  } else if (search) {
    return { reason: "collect_query" };
  }
  if (kind === "session") return { kind, path: `/v3/workspaces/${workspace}/sessions` };
  const own = ownSession(session, prefix);
  if (!own) return { reason: "collect_session" };
  const suffix = kind === "list" ? `/list${query ? `?${query}` : ""}` : "";
  return { kind, path: `/v3/workspaces/${workspace}/sessions/${own}/messages${suffix}` };
}

/** The body the gate sends instead of the collector's, or why it is refused. */
function collectBody(kind, raw, roles, prefix) {
  let body;
  try {
    const text = utf8.decode(raw);
    body = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    return { reason: "collect_body" };
  }
  if (kind === "list") {
    // Reading back takes no filter: an empty body or {}.
    return body === undefined || (isObject(body) && !Object.keys(body).length) ? { text: "{}" } : { reason: "collect_body" };
  }
  if (kind === "messages") {
    if (!onlyKeys(body, ["messages"]) || !Array.isArray(body.messages)) return { reason: "collect_body" };
    for (const message of body.messages) {
      if (!onlyKeys(message, MESSAGE_KEYS)) return { reason: "collect_body" };
      if (!peerAllowed(message.peer_id, roles)) return { reason: "collect_peer" };
    }
    return { text: JSON.stringify(body) };
  }
  if (!onlyKeys(body, SESSION_KEYS)) return { reason: "collect_body" };
  const own = ownSession(body.id, prefix);
  if (!own) return { reason: "collect_session" };
  if (body.peers != null && (!isObject(body.peers) || !Object.keys(body.peers).every((peer) => peerAllowed(peer, roles)))) {
    return { reason: "collect_peer" };
  }
  if (body.scopes != null && (!Array.isArray(body.scopes) || !body.scopes.every((scope) => typeof scope === "string" && SCOPE_ID.test(scope)))) {
    return { reason: "collect_scope" };
  }
  body.id = own;
  return { text: JSON.stringify(body) };
}

/** A collector's request: checked, rewritten to their own sessions, sent with a fresh length. */
async function collect(req, res, email, roles, deviceId) {
  const prefix = sessionPrefix(email);
  const target = collectTarget(req.method, req.url, roles, prefix);
  if (target.reason) return refuse(res, "api", 403, COLLECT_REFUSED, target.reason);
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error?.tooLarge) return reply(res, 413, { error: "payload_too_large", limitBytes: MAX_BODY_BYTES });
    res.destroy();
    return;
  }
  const body = collectBody(target.kind, raw, roles, prefix);
  if (body.reason) return refuse(res, "api", 403, COLLECT_REFUSED, body.reason);
  if (res.destroyed) return;
  deviceSeen(deviceId);
  return forward(req, res, UPSTREAM, forwardHeaders(req.headers, {
    host: UPSTREAM.host,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body.text)),
  }, (key) => personCredential(key) || BODY_HEADERS.has(key)), { path: target.path, body: body.text });
}

// ------------------------------------------------------------------------ doors

/** The projects opened to a chat person, as the MCP bridge reads them: base64url of the JSON list. */
const allowedScopes = (projects) => Buffer.from(JSON.stringify(projects)).toString("base64url");

const LET_IN_NOWHERE = Object.freeze({ error: "forbidden", detail: "This server's owner has not let you in." });

async function handle(req, res) {
  const route = routeFor(req.method, req.url);
  if (!route) return reply(res, 404, NOT_FOUND);
  const api = route === "health" || route === "api";
  // The owner's gate token, as before: /health and /v3/* exactly as sent. The
  // Authorization header goes upstream unchanged: Honcho runs with auth off and
  // ignores it. Host becomes the API's own name, which its TRUSTED_HOSTS lists.
  if (api && holdsGateToken(req.headers.authorization)) {
    return forward(req, res, UPSTREAM, forwardHeaders(req.headers, { host: UPSTREAM.host }, deviceKeyHeader));
  }
  if (route === "mcp" && !MCP_UPSTREAM) return reply(res, 404, NOT_FOUND);
  if (!ACCESS_ON) {
    // Nobody can be told apart: the gate token is the only key, and the doors for
    // people are not there.
    if (!api) return reply(res, 404, NOT_FOUND);
    return refuse(res, route, 401, { error: "unauthorized", detail: "This server needs its gate token as a Bearer token." }, "no_gate_token");
  }
  let person;
  try { person = await accessPerson(req.headers["cf-access-jwt-assertion"]); }
  catch { person = { reason: "error" }; }
  if (!person.email) {
    return refuse(res, route, 401, {
      error: "unauthorized",
      detail: api ? "This server needs a Cloudflare Access login, or its gate token." : "This path needs a Cloudflare Access login.",
    }, person.reason);
  }
  const policy = await currentPolicy();
  if (res.destroyed || req.socket?.destroyed) return;
  const email = person.email.toLowerCase();
  const roles = rolesOf(policy, email);
  const device = deviceOf(req.headers[DEVICE_HEADER], email, policy);

  switch (route) {
    case "whoami":
      return reply(res, 200, {
        email,
        owner: roles.owner,
        chat: roles.chat ? { projects: roles.chat.projects } : null,
        collect: Boolean(roles.collect),
        device: device.id ? { id: device.id, name: device.device.name } : null,
      });
    case "register":
      return registerDevice(req, res, email, roles, policy);
    case "unregister":
      return unregisterDevice(res, DEVICE_PATH.exec(req.url.split("?", 1)[0])[1], device);
    case "health":
      if (!roles.owner && !roles.chat && !roles.collect) return refuse(res, route, 403, LET_IN_NOWHERE, "not_allowed");
      return forward(req, res, UPSTREAM, forwardHeaders(req.headers, { host: UPSTREAM.host }, personCredential));
    case "api":
      if (!device.id) {
        return refuse(res, route, 403, {
          error: "forbidden",
          detail: "This computer has no valid device key for this server: none was sent, or it is unknown or revoked.",
        }, device.reason);
      }
      if (roles.owner) {
        deviceSeen(device.id);
        return forward(req, res, UPSTREAM, forwardHeaders(req.headers, { host: UPSTREAM.host }, personCredential));
      }
      if (roles.collect) return collect(req, res, email, roles, device.id);
      return refuse(res, route, 403, {
        error: "forbidden",
        detail: "Only this server's owners and the teammates who collect into it use its API.",
      }, "not_allowed");
    case "mcp": {
      let scope;
      if (roles.owner) scope = { "x-honcho-scope-mode": "all" };
      else if (roles.chat) scope = { "x-honcho-scope-mode": "projects", "x-honcho-allowed-scopes": allowedScopes(roles.chat.projects) };
      else return refuse(res, route, 403, { error: "forbidden", detail: "This server's owner has not opened its memory to you." }, "not_allowed");
      return forward(req, res, MCP_UPSTREAM, forwardHeaders(req.headers, {
        host: MCP_UPSTREAM.host,
        authorization: `Bearer ${TEAM_MCP_TOKEN}`,
        "cf-access-authenticated-user-email": person.email,
        ...scope,
      }, mcpCredential));
    }
    default:
      return reply(res, 404, NOT_FOUND);
  }
}

/**
 * Sends the request on and streams the answer back. `rewritten` ({ path, body }) is
 * a collector's request the gate read whole: it goes as the gate wrote it.
 */
function forward(req, res, target, headers, rewritten = null) {
  if (!rewritten) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return reply(res, 413, { error: "payload_too_large", limitBytes: MAX_BODY_BYTES });
    }
  }

  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: rewritten ? rewritten.path : req.url,
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

  if (rewritten) {
    upstream.end(rewritten.body);
    return;
  }
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

await loadDevices();
await refreshAccess();

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    log({ gate: "error", name: error?.name || "Error" });
    reply(res, 500, { error: "internal_error" });
  });
});
// A dialectic answer can stream for minutes; only the request itself is timed.
server.requestTimeout = 600_000;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  process.stdout.write(`${JSON.stringify({
    gate: "listening",
    port: server.address().port,
    upstream: UPSTREAM.origin,
    mcp: MCP_UPSTREAM?.origin || null,
    access: ACCESS_ON,
  })}\n`);
  // Said once, so a door that answers 404 can be traced to what it lacks.
  if (!ACCESS_ON) log({ gate: "access_off", missing: ACCESS_MISSING });
  if (MCP_UPSTREAM_SETTING && MCP_MISSING.length) log({ gate: "mcp_off", missing: MCP_MISSING });
});

// As PID 1 in its container, Node would otherwise ignore the stop signal.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearTimeout(seen.timer);
    // lastSeenAt the file has not had yet is written before the gate goes.
    const saved = seen.dirty ? devicesTask(saveDevices).catch(() => {}) : Promise.resolve();
    saved.then(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
