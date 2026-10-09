// The team hub: one Cloudflare Worker per team, by default at https://team.<zone>.
// It keeps the team: its name, who is in it (the roster), each person's peer name and
// server address, and the requests between people (chat and collect) with whether the
// server's owner approved them. It also makes a person's server address in Cloudflare
// (tunnel, DNS, the servers Access app) with the admin's API token, which only the hub
// holds, as a Worker secret.
//
// It is also the team's one Jev guard. An admin gives the hub the team's Jev API key,
// and it stays here: when a teammate asks a member's server something, that server
// sends the question to POST /guard with its own guard token, and the hub asks Jev
// whether the question reaches for the owner's private life rather than the team's
// work. A member's server gets its token from POST /api/me/guard, naming the tunnel
// it runs; a new one ends the old, and so do moving the server to another computer
// and removing it.
//
// Two halves:
//   - The Worker's fetch checks the Cloudflare Access login on every request, by the
//     same rules as the gate's accessPerson: a Cf-Access-Jwt-Assertion signed RS256 by
//     the team's keys, issued by https://<teamDomain>, for the hub app's AUD, within
//     its times (60 s of leeway), naming a person's email, never a service token. It
//     then drops every x-hub-* header the caller sent, adds x-hub-email and passes the
//     request on. The hub app lets in anyone with a Google login, so a stranger can be
//     told which email the hub saw; the roster decides everything else.
//     The one path served without a login is /guard, exactly: a server asks it, not a
//     person, so a second Access app on <hubHost>/guard lets it through, and the guard
//     token in its Authorization header is checked instead. The Worker drops the
//     caller's x-hub-* headers there too and adds x-hub-guard alone. Anything else
//     under /guard still needs the login.
//   - TeamHub, the Durable Object, holds the state and answers the API. Of what the
//     caller says about who they are, it trusts x-hub-email and nothing else, and
//     x-hub-guard only as "this is a call to /guard; check its token".
//
// Bindings (env):
//   HUB            the Durable Object namespace; everything lives in the object "team"
//   TEAM           JSON set at deploy: { name, hubHost, zone, zoneId, accountId,
//                  teamDomain, idpId, peoplePolicyId, hubAud, admins: [email] }
//   CF_API_TOKEN   the admin's Cloudflare API token, a secret
//   CF_API_BASE, ACCESS_CERTS_URL, JEV_API_BASE   for the tests only, and taken only
//                  when they point at this machine (loopback)
//
// Only Web APIs (fetch, Request, Response, URL, crypto.subtle), so the same module
// runs in the Workers runtime and under Node for the tests. The deploy step uploads
// scripts/cloudflare-api.mjs beside this file and rewrites the import below, which
// therefore stays one literal line. Nothing here logs. No answer carries the API
// token or the Jev key, and the one tunnel token that leaves is the one POST
// /api/servers hands to the server's own owner. A guard token leaves once, in the
// answer to POST /api/me/guard; the hub keeps only its SHA-256. The questions and
// answers sent to /guard go to Jev and are never stored.
import { CLOUDFLARE_API_BASE, CloudflareApiError, cloudflareClient, deleteAccessApp, deleteHostRecord, deleteTunnel, ensurePeoplePolicy, ensureServersApp, ensureTunnel, ensureTunnelCname, ensureTunnelIngress, findTunnel, GATE_ORIGIN, normalizeEmail, removeLegacyHostApps, SERVERS_APP_MAX_HOSTS, SERVERS_APP_NAME, TUNNEL_PREFIX, tunnelToken } from "../../scripts/cloudflare-api.mjs";

const HUB_OBJECT = "team";
const CLOCK_LEEWAY_SECONDS = 60;
// An unknown key id makes the hub look at the team's keys again, at most once a
// minute, so made-up key ids cannot make it hammer Cloudflare. The keys are also
// fetched again after an hour, so a key Cloudflare retired stops being trusted.
const KEYS_REFETCH_MS = 60_000;
const KEYS_MAX_AGE_MS = 60 * 60_000;
const CERTS_TIMEOUT_MS = 5_000;
// Changes to Cloudflare run inside blockConcurrencyWhile, which the runtime stops
// after 30 s; one slow call fails on its own well before that.
const CLOUDFLARE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const APP_START_URL = "http://127.0.0.1:4180/#/start?team=";
// The label of the team's first admin server, the company server: memory.<zone>.
const COMPANY_LABEL = "memory";
const PEER = /^[A-Za-z0-9_.:@-]{1,64}$/;
// Agents write as assistant_* and automation_* peers; a person's peer is never one.
const AGENT_PEER = /^(?:assistant|automation)_/i;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const WORKSPACE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const EMAIL = /^[\x21-\x7e]+@[\x21-\x7e]+$/;
const REQUEST_ID = /^r-[0-9a-f]{16}$/;
const KINDS = new Set(["chat", "collect"]);
const MAX_NAMES = 50;
const NAME_LENGTH = 64;
const TEAM_NAME_LENGTH = 60;
// A Jev API key: one token of printable ASCII, no spaces.
const JEV_KEY = /^[\x21-\x7e]{8,1024}$/;
const GUARD_TOKEN = /^bearer +([0-9a-f]{64})$/i;
// A guard token is a server's, so a busy or broken server cannot spend the team's
// Jev budget alone. Counted in memory: a restarted object starts again from zero.
// A teammate's question costs two calls, one for it and one for the answer.
const GUARD_CALLS_PER_MINUTE = 240;
const GUARD_WINDOW_MS = 60_000;
const GUARD_TEXT_LENGTH = 16_000;
const GUARD_FIELD_LENGTH = 320;
const JEV_API_BASE = "https://api.typesafe.ai";
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 10_000;
// A 5xx or a dropped connection is asked once more, this long after.
const JEV_RETRY_MS = 300;
// At this score or above, the question is taken as reaching for the owner's private
// life, or the answer as giving it away.
const JEV_THRESHOLD = 0.7;
const OUT_OF_SCOPE = {
  type: "noul",
  instructions: "Is this query asking for private personal life, credentials, financial or health details about the memory owner, rather than shared work context (projects, code, decisions, schedules, documents)?",
  criteria: {
    true: "The query targets private personal matters, secrets, or credentials.",
    false: "The query is about work the team shares, or is general and harmless.",
  },
};
const SENSITIVE_ANSWER = {
  type: "noul",
  instructions: "A teammate asked the memory owner's work memory a question and will read this answer. Does the answer disclose private personal life, credentials or secrets, financial or health details about the owner or any person, rather than shared work context (projects, code, decisions, schedules, documents)?",
  criteria: {
    true: "The answer discloses private personal matters, secrets, credentials, financial or health details.",
    false: "The answer only covers shared work context, or is general and harmless.",
  },
};
// What /guard judges, each with its own question to Jev: a teammate's question
// before it reaches the memory, or the memory's answer before it reaches them.
const GUARD_CHECKS = {
  query: { name: "out_of_scope", question: OUT_OF_SCOPE },
  answer: { name: "sensitive_answer", question: SENSITIVE_ANSWER },
};

/** An answer other than success: its status, a code and a sentence in English. */
class HubError extends Error {
  constructor(status, code, detail, extra = {}) {
    super(detail);
    this.name = "HubError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** A URL the tests set, taken only when it points at this machine. */
function loopbackUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(text).hostname) ? text : "";
  } catch {
    return "";
  }
}

/** TEAM, read and checked. The team domain may be written with its scheme or a trailing slash. */
function teamSettings(env) {
  let team = env.TEAM;
  if (typeof team === "string") {
    try { team = JSON.parse(team); } catch { team = null; }
  }
  if (!team || typeof team !== "object") throw new HubError(500, "misconfigured", "The hub's TEAM setting is missing or is not JSON");
  const teamDomain = String(team.teamDomain || "").trim().replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  const hubHost = String(team.hubHost || "").trim().toLowerCase();
  const hubAud = String(team.hubAud || "").trim();
  if (!teamDomain || !hubHost || !hubAud) throw new HubError(500, "misconfigured", "The hub's TEAM setting lacks teamDomain, hubHost or hubAud");
  return {
    name: String(team.name || "").trim() || hubHost,
    hubHost,
    zone: String(team.zone || "").trim().toLowerCase(),
    zoneId: String(team.zoneId || ""),
    accountId: String(team.accountId || ""),
    teamDomain,
    idpId: String(team.idpId || ""),
    peoplePolicyId: String(team.peoplePolicyId || ""),
    hubAud,
    admins: [...new Set((Array.isArray(team.admins) ? team.admins : []).map(normalizeEmail).filter(Boolean))],
  };
}

/** A verified email as the hub keeps it: lower case, and one printable token. */
function verifiedEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL.test(email) && email.length <= 320 ? email : "";
}

// ------------------------------------------------------------ Cloudflare Access

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
// The team's keys, by certs URL (a team has one; the tests use several). A request
// that has to fetch them does so itself instead of waiting on another request's
// fetch: the Workers runtime ties a fetch to the request that started it.
const keyCaches = new Map();

function keyCache(certsUrl) {
  let cache = keyCaches.get(certsUrl);
  if (!cache) {
    cache = { keys: null, loadedAt: 0, failedAt: -Infinity, refetchedAt: -Infinity };
    keyCaches.set(certsUrl, cache);
  }
  return cache;
}

/** The team's RS256 keys by key id. A failed fetch keeps the keys already known. */
async function fetchAccessKeys(certsUrl, cache) {
  try {
    const response = await fetch(certsUrl, {
      headers: { accept: "application/json" },
      // The Workers runtime has no redirect: "error"; a redirect is not ok either way.
      redirect: "manual",
      signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const keys = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      try {
        keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, RS256, false, ["verify"]));
      } catch {}
    }
    if (!keys.size) throw new Error("no RS256 signing keys");
    cache.keys = keys;
    cache.loadedAt = Date.now();
  } catch {
    cache.failedAt = Date.now();
  }
}

async function accessKey(certsUrl, kid) {
  const cache = keyCache(certsUrl);
  let fetched = false;
  const stale = !cache.keys || Date.now() - cache.loadedAt > KEYS_MAX_AGE_MS;
  if (stale && Date.now() - cache.failedAt >= KEYS_REFETCH_MS) {
    await fetchAccessKeys(certsUrl, cache);
    fetched = true;
  }
  let key = cache.keys?.get(kid);
  // A key Cloudflare rotated in since the last fetch.
  if (!key && !fetched && Date.now() - cache.refetchedAt >= KEYS_REFETCH_MS) {
    cache.refetchedAt = Date.now();
    await fetchAccessKeys(certsUrl, cache);
    key = cache.keys?.get(kid);
  }
  return key || null;
}

function base64urlBytes(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function jsonSegment(segment) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlBytes(segment)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value;
}

/**
 * The verified email of the person behind a request, in lower case, or why there is
 * none. No claim is ever echoed back to the caller.
 */
async function accessPerson(assertion, team, certsUrl) {
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
  const key = await accessKey(certsUrl, header.kid);
  if (!key) return { reason: "unknown_key" };
  let signed = false;
  try {
    signed = await crypto.subtle.verify(RS256, key, base64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {}
  if (!signed) return { reason: "signature" };
  if (claims.iss !== `https://${team.teamDomain}`) return { reason: "issuer" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(team.hubAud)) return { reason: "audience" };
  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_LEEWAY_SECONDS) return { reason: "expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || now < claims.nbf - CLOCK_LEEWAY_SECONDS)) {
    return { reason: "not_yet_valid" };
  }
  // People only: a service token's assertion has a common_name and no email.
  const claimed = typeof claims.email === "string" ? claims.email.trim() : "";
  if (!claimed || claims.common_name) return { reason: "not_a_person" };
  // It goes into a header as it is.
  const email = verifiedEmail(claimed);
  return email ? { email } : { reason: "email" };
}

/**
 * Whether a browser sent this change from another site. Such a page can ride on the
 * person's Access cookie, so it changes nothing here. The app's own requests carry
 * neither header.
 */
function crossSite(request, hubHost) {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  return Boolean(origin) && origin !== `https://${hubHost}`;
}

// ------------------------------------------------------------------ answers

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(status, body) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** The answer for an error: its own for a HubError, 502 for Cloudflare, 500 for the rest. */
function failure(error, env = {}) {
  if (error instanceof HubError) return json(error.status, { error: error.code, detail: error.message, ...error.extra });
  if (error instanceof CloudflareApiError) {
    // The client already cuts its token out of every message; this is a second guard.
    const token = String(env.CF_API_TOKEN || "").trim();
    return json(502, { error: "cloudflare", detail: token ? error.message.split(token).join("[redacted]") : error.message });
  }
  return json(500, { error: "internal", detail: "The team hub could not do that; try again" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

const PAGE_STYLE = "body{margin:0;background:#f6f4ef;color:#24221d;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR','Segoe UI',sans-serif}"
  + "main{max-width:520px;margin:48px auto;padding:28px 32px;background:#fff;border:1px solid #e4dfd4;border-radius:12px}"
  + "h1{font-size:22px;margin:0}h2{font-size:16px;margin:26px 0 4px}.muted{color:#6b665c;margin-top:0}"
  + ".ok{color:#1d6b3a}.warn{color:#8a4b0b}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}"
  + ".address{padding:8px 12px;background:#f2efe8;border-radius:8px}"
  + "a.button{display:inline-block;padding:9px 16px;background:#24221d;color:#fff;border-radius:8px;text-decoration:none}";

function pageHtml(title, body) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>${body}
</main>
</body>
</html>
`;
}

/** GET /: the team, who is signed in, whether the roster has them, and how to join. */
function joinPage({ name, host, email, member }) {
  const roster = member
    ? '<p class="ok">이 이메일은 팀 명단에 있습니다.</p>'
    : '<p class="warn">이 이메일은 팀 명단에 없습니다. 팀 관리자에게 이 이메일을 보내고, 명단에 들어간 뒤 다시 여세요.</p>';
  return pageHtml(`${name} · Team Memory`, `
<h1>${escapeHtml(name)}</h1>
<p class="muted">Team Memory 팀</p>
<p><span class="mono">${escapeHtml(email)}</span> 계정으로 로그인했습니다.</p>
${roster}
<h2>팀에 들어가기</h2>
<p>Team Memory 앱의 처음 화면에서 <b>팀에 들어가기</b>를 누르고, 이 팀 주소를 붙여 넣으세요.</p>
<p class="address mono">${escapeHtml(host)}</p>
<p><a class="button" href="${escapeHtml(`${APP_START_URL}${encodeURIComponent(host)}`)}">앱에서 열기</a></p>
<p class="muted">앱이 이 컴퓨터에서 켜져 있어야 열립니다.</p>`);
}

function signedOutPage() {
  return pageHtml("Team Memory", `
<h1>로그인을 확인하지 못했습니다</h1>
<p>이 팀 주소는 Cloudflare Access에서 Google 로그인을 마친 뒤에 열립니다. 페이지를 새로 고치거나 다시 로그인하세요.</p>`);
}

// ------------------------------------------------------------------- inputs

/** The body as a JSON object; an empty body is {}. Read in pieces, so a huge one stops early. */
async function readJson(request) {
  const tooLarge = () => new HubError(413, "too_large", `The body is larger than ${MAX_BODY_BYTES} bytes`);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw new HubError(400, "bad_request", "The body is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HubError(400, "bad_request", "The body must be a JSON object");
  return value;
}

/**
 * A name a person typed (a computer, a folder, a project, the team), trimmed: 1 to
 * `max` characters, none of them a control or format character or a line break. Else null.
 */
function printable(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const length = [...text].length;
  return length >= 1 && length <= max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(text) ? text : null;
}

/** An optional name: missing or empty is null. */
function optionalName(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const name = printable(value, NAME_LENGTH);
  if (!name) throw new HubError(400, "bad_request", `${field} takes at most ${NAME_LENGTH} printable characters`);
  return name;
}

/** A list of up to 50 names, each up to 64 printable characters, without repeats. */
function nameList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_NAMES) {
    throw new HubError(400, "bad_request", `${field} is a list of at most ${MAX_NAMES} names`);
  }
  const names = value.map((item) => printable(item, NAME_LENGTH));
  if (names.includes(null)) throw new HubError(400, "bad_request", `Each of ${field} takes 1 to ${NAME_LENGTH} printable characters`);
  return [...new Set(names)];
}

function validPeer(value) {
  return typeof value === "string" && PEER.test(value) && !AGENT_PEER.test(value);
}

/** Lower case, anything but a-z, 0-9 and - made -, no - at either end, at most 32 characters. */
function dnsSafe(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
}

/** The peer made from an email's local part, with -2, -3... until no one has it. */
function peerFromEmail(email, taken) {
  const base = dnsSafe(email.split("@")[0]) || "member";
  if (!taken.has(base)) return base;
  for (let number = 2; ; number += 1) {
    if (!taken.has(`${base}-${number}`)) return `${base}-${number}`;
  }
}

function serverInput(body) {
  const label = body.label === undefined || body.label === null || body.label === "" ? null : body.label;
  if (label !== null && (typeof label !== "string" || !LABEL.test(label))) {
    throw new HubError(400, "bad_request", "label takes lower-case letters, digits and -, up to 32 characters");
  }
  if (typeof body.workspace !== "string" || !WORKSPACE.test(body.workspace)) {
    throw new HubError(400, "bad_request", "workspace takes the server's Honcho workspace: letters, digits and _ . : @ -");
  }
  if (body.replace !== undefined && body.replace !== null && typeof body.replace !== "boolean") {
    throw new HubError(400, "bad_request", "replace is true or false");
  }
  return { label, workspace: body.workspace, device: optionalName(body.device, "device"), replace: body.replace === true };
}

function requestInput(body) {
  if (!KINDS.has(body.kind)) throw new HubError(400, "bad_request", "kind is chat or collect");
  const server = typeof body.server === "string" ? body.server.trim().toLowerCase() : "";
  if (!server || server.length > 253) throw new HubError(400, "bad_request", "server takes the host of a server of the team");
  return { kind: body.kind, server, device: optionalName(body.device, "device"), folders: nameList(body.folders, "folders") };
}

/**
 * What a server sends to /guard, and what of it is judged: the answer when there is
 * one, else the query. Jev's state is tool, caller and workspace when given, then
 * the query, then the answer, each as it came; beside an answer the query is only
 * context and may be left out. Lengths count characters, not bytes.
 */
function guardInput(body) {
  const checked = body.answer === undefined || body.answer === null ? "query" : "answer";
  const text = (field, what) => {
    const value = body[field];
    if (typeof value !== "string" || !value.trim() || [...value].length > GUARD_TEXT_LENGTH) {
      throw new HubError(400, "bad_request", `${field} takes ${what}, 1 to ${GUARD_TEXT_LENGTH} characters`);
    }
    return value;
  };
  const state = {};
  for (const field of ["tool", "caller", "workspace"]) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || [...value].length > GUARD_FIELD_LENGTH) {
      throw new HubError(400, "bad_request", `${field} takes text of at most ${GUARD_FIELD_LENGTH} characters`);
    }
    state[field] = value;
  }
  if (checked === "query" || (body.query !== undefined && body.query !== null)) state.query = text("query", "the question asked");
  if (checked === "answer") state.answer = text("answer", "the answer about to go out");
  return { state, checked };
}

// ---------------------------------------------------------------------- Jev

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Jev's score for one question or answer (`checked`): how surely it reaches for, or
 * gives away, the owner's private life, from 0 to 1. A 5xx or a dropped connection
 * is often Jev's moment rather than the text's, so it is asked once more; a slow
 * answer is not, since a second wait would double the teammate's. Any failure is a
 * 502 jev_failed whose detail says what went wrong in the hub's own words, never
 * Jev's body, and never the key.
 */
async function jevScore(env, key, state, checked) {
  const { name, question } = GUARD_CHECKS[checked];
  const failed = (detail) => new HubError(502, "jev_failed", detail.split(key).join("[redacted]"));
  const base = (loopbackUrl(env.JEV_API_BASE) || JEV_API_BASE).replace(/\/+$/, "");
  const timedOut = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";
  const slow = `Jev did not answer within ${JEV_TIMEOUT_MS / 1000} s`;
  let response;
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === 2;
    try {
      response = await fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ state, model: JEV_MODEL, questions: { [name]: question } }),
        // The key goes to Jev alone: a redirect is a failure, not followed.
        redirect: "manual",
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
    } catch (error) {
      if (timedOut(error)) throw failed(slow);
      if (last) throw failed("Jev could not be reached");
      await pause(JEV_RETRY_MS);
      continue;
    }
    if (response.status < 500 || last) break;
    await response.body?.cancel().catch(() => {});
    await pause(JEV_RETRY_MS);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw failed(`Jev answered HTTP ${response.status}`);
  }
  let answer;
  try {
    answer = await response.json();
  } catch (error) {
    throw failed(timedOut(error) ? slow : "Jev's answer was not JSON");
  }
  const score = answer?.answers?.[name]?.noul;
  if (typeof score !== "number" || !Number.isFinite(score)) throw failed(`Jev's answer held no score for the ${checked}`);
  return score;
}

// -------------------------------------------------------------- the team's state
//
// Durable Object storage, all in the one object:
//   meta            { name, createdAt, seededAdmins }: the team's name, seeded from
//                   TEAM.name, and the emails of TEAM.admins already made admins
//   person:<email>  { email, peer, admin, addedAt, addedBy, firstLoginAt, lastLoginAt };
//                   each email of TEAM.admins is made an admin once (see seed), and an
//                   admin makes a member an admin or takes it away
//   server:<host>   { host, label, owner, workspace, company, createdOn, tunnelId,
//                   dnsRecordId, createdAt, updatedAt, guardHash?, guardIssuedAt? };
//                   one per person; guardHash is the SHA-256 (hex) of the server's
//                   guard token, while it has one
//   guard:<hash>    { host }: which server a guard token belongs to
//   request:<id>    { id, kind, from, fromPeer, server, owner, device, folders, status,
//                   projects, createdAt, decidedAt, revokedAt, dismissedAt }
//   serversApp      { id, aud } of the servers Access app, once it exists
//   jev             { key, setAt, setBy }: the team's Jev API key, while an admin has
//                   set one
// A member is a person with a record; an admin is one whose record says so.
//
// A request is pending until the server's owner approves or declines it; its sender
// may cancel it while pending, and the owner may revoke it once approved. Removing a
// server or a person ends the requests that concern them the same way.

const personKey = (email) => `person:${email}`;
const serverKey = (host) => `server:${host}`;
const requestKey = (id) => `request:${id}`;
const guardKey = (hash) => `guard:${hash}`;

function timestamp() {
  return new Date().toISOString();
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A server record as its owner sees it: without the hash of its guard token. */
function ownServerView(server) {
  const { guardHash: _guardHash, ...view } = server;
  return view;
}

/** Whether the team has a Jev key, when and by whom it was set: never the key. */
function jevView(record) {
  return { set: Boolean(record?.key), setAt: record?.setAt ?? null, setBy: record?.setBy ?? null };
}

/** The hosts of the servers app: the company server first, then the oldest first. */
function appHosts(servers) {
  return [...servers]
    .sort((a, b) => Number(Boolean(b.company)) - Number(Boolean(a.company))
      || String(a.createdAt).localeCompare(String(b.createdAt))
      || a.host.localeCompare(b.host))
    .map((server) => server.host);
}

function newestFirst(a, b) {
  return String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id);
}

function personView(person, servers) {
  return {
    email: person.email,
    peer: person.peer ?? null,
    admin: Boolean(person.admin),
    joined: Boolean(person.firstLoginAt),
    servers: servers.filter((server) => server.owner === person.email).map((server) => server.host),
  };
}

function adminPersonView(person, servers) {
  return { ...personView(person, servers), addedAt: person.addedAt ?? null, addedBy: person.addedBy ?? null, lastLoginAt: person.lastLoginAt ?? null };
}

function serverView(server, people) {
  return {
    host: server.host,
    label: server.label,
    owner: server.owner,
    ownerPeer: people.get(server.owner)?.peer ?? null,
    workspace: server.workspace,
    company: Boolean(server.company),
    createdOn: server.createdOn ?? null,
  };
}

const ROUTES = [
  ["GET", /^\/$/, "page"],
  ["GET", /^\/api\/me$/, "me"],
  ["POST", /^\/api\/me$/, "setPeer"],
  ["POST", /^\/api\/me\/guard$/, "issueGuard"],
  ["GET", /^\/api\/team$/, "team"],
  ["POST", /^\/api\/servers$/, "makeServer"],
  ["DELETE", /^\/api\/servers\/([^/]+)$/, "removeServer"],
  ["POST", /^\/api\/requests$/, "makeRequest"],
  ["GET", /^\/api\/requests$/, "requestLists"],
  ["POST", /^\/api\/requests\/([^/]+)\/(decide|cancel|dismiss|revoke|projects)$/, "changeRequest"],
  ["GET", /^\/api\/admin\/people$/, "adminPeople"],
  ["POST", /^\/api\/admin\/people$/, "addPerson"],
  ["DELETE", /^\/api\/admin\/people\/([^/]+)$/, "removePerson"],
  ["PUT", /^\/api\/admin\/people\/([^/]+)$/, "setAdmin"],
  ["PUT", /^\/api\/admin\/team$/, "renameTeam"],
  ["GET", /^\/api\/admin\/jev$/, "jevStatus"],
  ["PUT", /^\/api\/admin\/jev$/, "setJev"],
  ["DELETE", /^\/api\/admin\/jev$/, "clearJev"],
];
// POST /guard is not here: the Worker sends it with x-hub-guard instead of a login,
// and fetch takes it to guard(). No route of a person may start with /guard, which
// Access lets through.

/** The handler and decoded path parameters for a request; 404 or 405 when there is none. */
function routeFor(method, pathname) {
  const notFound = () => new HubError(404, "not_found", "The team hub has no such route");
  let known = false;
  for (const [routeMethod, pattern, handler] of ROUTES) {
    const found = pattern.exec(pathname);
    if (!found) continue;
    known = true;
    if (routeMethod !== method) continue;
    try {
      return { handler, params: found.slice(1).map((value) => decodeURIComponent(value)) };
    } catch {
      throw notFound();
    }
  }
  if (known) throw new HubError(405, "method_not_allowed", `${pathname} does not take ${method}`);
  throw notFound();
}

/** The Durable Object that holds the team. See the state above and the routes in ROUTES. */
export class TeamHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env;
    this.seeded = false;
    // Each server's recent calls to /guard (times in ms), by host.
    this.guardCalls = new Map();
  }

  async fetch(request) {
    try {
      const team = teamSettings(this.env);
      // Only the Worker sets it, and only for /guard.
      if (request.headers.get("x-hub-guard") === "1") {
        await this.seed(team);
        return await this.guard(request);
      }
      const email = verifiedEmail(request.headers.get("x-hub-email"));
      if (!email) throw new HubError(401, "unauthorized", "The team hub needs a Cloudflare Access login");
      await this.seed(team);
      const { handler, params } = routeFor(request.method, new URL(request.url).pathname);
      return await this[handler]({ request, email, team, params });
    } catch (error) {
      return failure(error, this.env);
    }
  }

  /**
   * On the first request of all, the team's name; and each email of TEAM.admins is
   * made an admin once, on the first request after the deploy that names it. `team
   * make` names the admin, so making the team again with another email adds that
   * admin (a member already on the roster becomes one). meta.seededAdmins remembers
   * who was made an admin this way, so one removed or taken off as admin later stays so.
   */
  async seed(team) {
    if (this.seeded) return;
    const meta = await this.storage.get("meta");
    if (!meta || !Array.isArray(meta.seededAdmins) || team.admins.some((email) => !meta.seededAdmins.includes(email))) {
      await this.exclusive(async () => {
        const now = timestamp();
        const current = await this.storage.get("meta");
        // A hub made before seededAdmins put TEAM.admins on the roster as added by
        // "setup", and no admin could be taken off or removed there: those count as
        // made admins already.
        const done = new Set(!current ? []
          : Array.isArray(current.seededAdmins) ? current.seededAdmins
            : [...(await this.people()).values()].filter((person) => person.addedBy === "setup").map((person) => person.email));
        const fresh = team.admins.filter((email) => !done.has(email));
        if (current && Array.isArray(current.seededAdmins) && !fresh.length) return;
        for (const email of fresh) {
          const person = await this.person(email);
          await this.storage.put(personKey(email), person
            ? { ...person, admin: true }
            : { email, peer: null, admin: true, addedAt: now, addedBy: "setup", firstLoginAt: null, lastLoginAt: null });
        }
        // Last, so a seed cut short runs again.
        await this.storage.put("meta", current
          ? { ...current, seededAdmins: [...done, ...fresh] }
          : { name: team.name, createdAt: now, seededAdmins: fresh });
      });
    }
    this.seeded = true;
  }

  /**
   * Runs `work` with no other request reaching the object meanwhile, as every change
   * to Cloudflare does. Its error is handed out rather than thrown inside: an
   * exception out of blockConcurrencyWhile would reset the object.
   */
  async exclusive(work) {
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try { return { value: await work() }; } catch (error) { return { error }; }
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  cloudflare() {
    return cloudflareClient({
      token: this.env.CF_API_TOKEN,
      baseUrl: loopbackUrl(this.env.CF_API_BASE) || CLOUDFLARE_API_BASE,
      fetchImpl: (...args) => fetch(...args),
      timeoutMs: CLOUDFLARE_TIMEOUT_MS,
    });
  }

  async meta(team) {
    return (await this.storage.get("meta")) || { name: team.name, createdAt: null };
  }

  async person(email) {
    return (await this.storage.get(personKey(email))) || null;
  }

  async member(email) {
    const person = await this.person(email);
    if (!person) throw new HubError(403, "not_member", `${email} is not on the team's roster; ask an admin of the team to add it`);
    return person;
  }

  async admin(email) {
    const person = await this.member(email);
    if (!person.admin) throw new HubError(403, "not_admin", "Only an admin of the team can do that");
    return person;
  }

  /** Everyone on the roster, by email. */
  async people() {
    return new Map([...(await this.storage.list({ prefix: "person:" })).values()].map((person) => [person.email, person]));
  }

  async servers() {
    return [...(await this.storage.list({ prefix: "server:" })).values()];
  }

  async requests() {
    return [...(await this.storage.list({ prefix: "request:" })).values()];
  }

  // ------------------------------------------------------------ the roster

  async page({ email, team }) {
    const [meta, person] = await Promise.all([this.meta(team), this.person(email)]);
    return html(200, joinPage({ name: meta.name, host: team.hubHost, email, member: Boolean(person) }));
  }

  /** GET /api/me: anyone. A member's call counts as a login. */
  async me({ email, team }) {
    const person = await this.person(email);
    if (person) {
      const now = timestamp();
      person.firstLoginAt ||= now;
      person.lastLoginAt = now;
      await this.storage.put(personKey(email), person);
    }
    const meta = await this.meta(team);
    const servers = (await this.servers()).filter((server) => server.owner === email).map(ownServerView);
    return json(200, {
      email,
      member: Boolean(person),
      admin: Boolean(person?.admin),
      peer: person?.peer ?? null,
      team: { name: meta.name, host: team.hubHost },
      servers,
    });
  }

  /** POST /api/me: the member's peer, set once; the one given, else one made from the email. */
  async setPeer({ request, email }) {
    const person = await this.member(email);
    const body = await readJson(request);
    const wanted = body.peer === undefined || body.peer === null || body.peer === "" ? null : body.peer;
    if (wanted !== null && !validPeer(wanted)) {
      throw new HubError(400, "bad_request", "peer takes 1 to 64 letters, digits and _ . : @ -, and does not start with assistant_ or automation_");
    }
    if (person.peer) {
      if (wanted === null || wanted === person.peer) return json(200, { peer: person.peer });
      throw new HubError(409, "peer_set", `Your peer is already ${person.peer}, and it is set only once`);
    }
    // Compared without case, so two people never look alike in a list.
    const taken = new Set([...(await this.people()).values()].map((item) => String(item.peer || "").toLowerCase()).filter(Boolean));
    if (wanted !== null && taken.has(wanted.toLowerCase())) throw new HubError(409, "peer_taken", `Someone in the team already has the peer ${wanted}`);
    const peer = wanted ?? peerFromEmail(email, taken);
    await this.storage.put(personKey(email), { ...person, peer });
    // Requests sent before the peer was set name it from now on.
    for (const item of await this.requests()) {
      if (item.from === email && !item.fromPeer) await this.storage.put(requestKey(item.id), { ...item, fromPeer: peer });
    }
    return json(200, { peer });
  }

  async team({ email, team }) {
    await this.member(email);
    const [meta, people, servers] = await Promise.all([this.meta(team), this.people(), this.servers()]);
    return json(200, {
      team: { name: meta.name, host: team.hubHost, zone: team.zone },
      people: [...people.values()].map((person) => personView(person, servers)),
      servers: servers.map((server) => serverView(server, people)),
    });
  }

  // ------------------------------------------------------------- servers

  /** POST /api/servers: the caller's server address, and the token its connector runs with. */
  async makeServer({ request, email, team }) {
    await this.member(email);
    const input = serverInput(await readJson(request));
    const made = await this.exclusive(() => this.provision(email, team, input));
    return json(made.replaced ? 200 : 201, made.answer);
  }

  async provision(email, team, input) {
    const person = await this.member(email);
    const servers = await this.servers();
    const own = servers.find((server) => server.owner === email) || null;
    if (own && !input.replace) {
      throw new HubError(409, "server_exists", `You already have a server at ${own.host}; send replace to move it to this computer`, { server: ownServerView(own) });
    }
    if (own && input.label && input.label !== own.label) {
      throw new HubError(409, "server_exists", `Your server is ${own.host}, and replace keeps that address; remove the server first to take another name`, { server: ownServerView(own) });
    }
    const company = own ? Boolean(own.company) : Boolean(person.admin) && !servers.some((server) => server.company);
    const label = own ? own.label : input.label || (company ? COMPANY_LABEL : dnsSafe(person.peer || email.split("@")[0]) || "member");
    const host = own ? own.host : company ? `${label}.${team.zone}` : `memory-${label}.${team.zone}`;
    if (!own) {
      // None of `servers` is the caller's here.
      if (host === team.hubHost || servers.some((server) => server.host === host)) {
        throw new HubError(409, "host_taken", `${host} is taken; choose another name`);
      }
      // The tunnel is named after the label, so two servers never share a label.
      if (servers.some((server) => server.label === label)) {
        throw new HubError(409, "host_taken", `The name ${label} is taken by another server of the team; choose another`);
      }
      if (servers.length >= SERVERS_APP_MAX_HOSTS) {
        throw new HubError(409, "too_many_servers", `The team has ${servers.length} servers, as many as one Access application holds`);
      }
    }

    const client = this.cloudflare();
    const tunnelName = `${TUNNEL_PREFIX}${label}`;
    // The old computer's guard token stops at once; the new computer asks for its own,
    // and the record written below has none.
    if (own?.guardHash) await this.storage.delete(guardKey(own.guardHash));
    // The old tunnel goes first, so the old computer's connector stops. So does any
    // tunnel of this name left from before (a provision cut short, the first
    // sharing): no computer that held its token may serve this host.
    if (own?.tunnelId) await deleteTunnel(client, team.accountId, own.tunnelId);
    const leftover = await findTunnel(client, team.accountId, tunnelName);
    if (leftover) await deleteTunnel(client, team.accountId, leftover.id);
    const tunnel = await ensureTunnel(client, team.accountId, tunnelName);
    await ensureTunnelIngress(client, team.accountId, tunnel.id, host, GATE_ORIGIN);
    const dns = await ensureTunnelCname(client, team.zoneId, host, tunnel.id);
    // The host's apps from the first sharing go before it joins the servers app:
    // Cloudflare may refuse a second app on the same domain, and ensureAccessApp,
    // finding no servers app by name, would take the old app of that domain over.
    await removeLegacyHostApps(client, team.accountId, host);
    const now = timestamp();
    const app = await ensureServersApp(client, team.accountId, {
      hosts: appHosts(own ? servers : [...servers, { host, company, createdAt: now }]),
      idpId: team.idpId,
      policyId: team.peoplePolicyId,
      known: await this.storage.get("serversApp"),
    });
    await this.storage.put("serversApp", { id: app.id, aud: app.aud });
    const token = await tunnelToken(client, team.accountId, tunnel.id);
    const server = {
      host,
      label,
      owner: email,
      workspace: input.workspace,
      company,
      createdOn: input.device ?? own?.createdOn ?? null,
      tunnelId: tunnel.id,
      dnsRecordId: dns.id,
      createdAt: own?.createdAt || now,
      updatedAt: now,
    };
    await this.storage.put(serverKey(host), server);
    return { replaced: Boolean(own), answer: { server, tunnelToken: token, teamDomain: team.teamDomain, aud: app.aud } };
  }

  /** DELETE /api/servers/<host>: its owner, or an admin. */
  async removeServer({ email, team, params: [rawHost] }) {
    const host = rawHost.trim().toLowerCase();
    await this.member(email);
    await this.exclusive(async () => {
      const caller = await this.member(email);
      const server = await this.storage.get(serverKey(host));
      if (!server) throw new HubError(404, "not_found", `No server of the team is at ${host}`);
      if (server.owner !== email && !caller.admin) throw new HubError(403, "forbidden", "Only the server's owner or an admin of the team can remove it");
      await this.deprovision(this.cloudflare(), team, server);
    });
    return json(200, { removed: host });
  }

  /**
   * Takes a server out of Cloudflare and the hub. Its hostname goes first, so the host
   * stops answering before it leaves the servers app; the app itself goes with the
   * last host. Its guard token stops and requests to the server end. Runs inside
   * exclusive.
   */
  async deprovision(client, team, server) {
    await deleteHostRecord(client, team.zoneId, server.host);
    const tunnel = server.tunnelId ? { id: server.tunnelId } : await findTunnel(client, team.accountId, `${TUNNEL_PREFIX}${server.label}`);
    if (tunnel) await deleteTunnel(client, team.accountId, tunnel.id);
    const rest = (await this.servers()).filter((item) => item.host !== server.host);
    const known = (await this.storage.get("serversApp")) || {};
    if (rest.length) {
      const app = await ensureServersApp(client, team.accountId, { hosts: appHosts(rest), idpId: team.idpId, policyId: team.peoplePolicyId, known });
      await this.storage.put("serversApp", { id: app.id, aud: app.aud });
    } else {
      await deleteAccessApp(client, team.accountId, { id: known.id || "", name: SERVERS_APP_NAME, domain: server.host });
      await this.storage.delete("serversApp");
    }
    await this.storage.delete(serverKey(server.host));
    if (server.guardHash) await this.storage.delete(guardKey(server.guardHash));
    await this.endRequests((item) => item.server === server.host);
  }

  /** The matching requests end: pending ones are cancelled, approved ones revoked. */
  async endRequests(matches) {
    const now = timestamp();
    for (const item of await this.requests()) {
      if (!matches(item)) continue;
      if (item.status === "pending") await this.storage.put(requestKey(item.id), { ...item, status: "cancelled" });
      else if (item.status === "approved") await this.storage.put(requestKey(item.id), { ...item, status: "revoked", revokedAt: now });
    }
  }

  // ------------------------------------------------------------ requests

  /** POST /api/requests: to a teammate's server. The same one still pending is returned as it is. */
  async makeRequest({ request, email }) {
    const person = await this.member(email);
    const input = requestInput(await readJson(request));
    const server = await this.storage.get(serverKey(input.server));
    if (!server) throw new HubError(404, "not_found", `No server of the team is at ${input.server}`);
    if (server.owner === email) throw new HubError(400, "own_server", "That server is your own; it needs no request");
    const pending = (await this.requests())
      .find((item) => item.from === email && item.server === server.host && item.kind === input.kind && item.status === "pending");
    if (pending) return json(200, { request: pending });
    const record = {
      id: `r-${randomHex(8)}`,
      kind: input.kind,
      from: email,
      fromPeer: person.peer ?? null,
      server: server.host,
      owner: server.owner,
      device: input.device,
      folders: input.folders,
      status: "pending",
      projects: [],
      createdAt: timestamp(),
      decidedAt: null,
      revokedAt: null,
      dismissedAt: null,
    };
    await this.storage.put(requestKey(record.id), record);
    return json(201, { request: record });
  }

  async requestLists({ email }) {
    await this.member(email);
    const all = (await this.requests()).sort(newestFirst);
    return json(200, {
      incoming: all.filter((item) => item.owner === email && item.status === "pending"),
      outgoing: all.filter((item) => item.from === email && item.status !== "cancelled" && !item.dismissedAt),
      granted: all.filter((item) => item.owner === email && item.status === "approved"),
    });
  }

  /** POST /api/requests/<id>/<action>: decide, cancel, dismiss, revoke or projects. */
  async changeRequest({ request, email, params: [id, action] }) {
    await this.member(email);
    const body = action === "decide" || action === "projects" ? await readJson(request) : {};
    const record = REQUEST_ID.test(id) ? await this.storage.get(requestKey(id)) : null;
    if (!record) throw new HubError(404, "not_found", "There is no such request");
    const byOwner = () => {
      if (record.owner !== email) throw new HubError(403, "forbidden", "Only the server's owner can do that");
    };
    const bySender = () => {
      if (record.from !== email) throw new HubError(403, "forbidden", "Only the request's sender can do that");
    };
    const whilePending = () => {
      if (record.status !== "pending") throw new HubError(409, "not_pending", `The request is ${record.status}, no longer pending`);
    };
    const whileApproved = () => {
      if (record.status !== "approved") throw new HubError(409, "not_approved", `The request is ${record.status}, not approved`);
    };
    const now = timestamp();
    let next;
    if (action === "decide") {
      byOwner();
      whilePending();
      if (typeof body.approve !== "boolean") throw new HubError(400, "bad_request", "approve is true or false");
      next = body.approve
        ? { ...record, status: "approved", projects: nameList(body.projects, "projects"), decidedAt: now }
        : { ...record, status: "declined", decidedAt: now };
    } else if (action === "cancel") {
      bySender();
      whilePending();
      next = { ...record, status: "cancelled" };
    } else if (action === "dismiss") {
      bySender();
      next = { ...record, dismissedAt: record.dismissedAt || now };
    } else if (action === "revoke") {
      byOwner();
      whileApproved();
      next = { ...record, status: "revoked", revokedAt: now };
    } else {
      byOwner();
      whileApproved();
      if (!Array.isArray(body.projects)) throw new HubError(400, "bad_request", "projects is a list of project names");
      next = { ...record, projects: nameList(body.projects, "projects") };
    }
    await this.storage.put(requestKey(id), next);
    return json(200, { request: next });
  }

  // --------------------------------------------------------------- admin

  async adminPeople({ email }) {
    await this.admin(email);
    const [people, servers] = await Promise.all([this.people(), this.servers()]);
    return json(200, { people: [...people.values()].map((person) => adminPersonView(person, servers)) });
  }

  /** POST /api/admin/people: into the people policy first, then onto the roster. */
  async addPerson({ request, email, team }) {
    await this.admin(email);
    const wanted = normalizeEmail((await readJson(request)).email);
    if (!wanted) throw new HubError(400, "bad_request", "email takes an email address");
    const existing = await this.person(wanted);
    const added = existing ? { person: existing, created: false } : await this.exclusive(async () => {
      const again = await this.person(wanted);
      if (again) return { person: again, created: false };
      await ensurePeoplePolicy(this.cloudflare(), team.accountId, { id: team.peoplePolicyId, add: [wanted] });
      const person = { email: wanted, peer: null, admin: false, addedAt: timestamp(), addedBy: email, firstLoginAt: null, lastLoginAt: null };
      await this.storage.put(personKey(wanted), person);
      return { person, created: true };
    });
    return json(added.created ? 201 : 200, { person: adminPersonView(added.person, await this.servers()) });
  }

  /**
   * DELETE /api/admin/people/<email>: out of the people policy first, so their logins
   * stop; then their server goes as DELETE /api/servers takes it, then the record,
   * and their requests end.
   */
  async removePerson({ email, team, params: [rawEmail] }) {
    await this.admin(email);
    const wanted = normalizeEmail(rawEmail);
    await this.exclusive(async () => {
      const person = wanted ? await this.person(wanted) : null;
      if (!person) throw new HubError(404, "not_found", "No one with that email is on the roster");
      if (wanted === email) throw new HubError(409, "own_email", "An admin cannot remove themselves; another admin can");
      const admins = [...(await this.people()).values()].filter((item) => item.admin);
      if (person.admin && admins.length <= 1) throw new HubError(409, "last_admin", "The team's last admin stays");
      const client = this.cloudflare();
      await ensurePeoplePolicy(client, team.accountId, { id: team.peoplePolicyId, remove: [wanted] });
      const server = (await this.servers()).find((item) => item.owner === wanted);
      if (server) await this.deprovision(client, team, server);
      await this.storage.delete(personKey(wanted));
      await this.endRequests((item) => item.from === wanted || item.owner === wanted);
    });
    return json(200, { removed: wanted });
  }

  /**
   * PUT /api/admin/people/<email> { admin }: makes a member an admin, or takes it
   * away. As with removing a person, an admin does not take it from themselves;
   * another admin can. So the team keeps an admin: whoever takes it from someone
   * else is one.
   */
  async setAdmin({ request, email, params: [rawEmail] }) {
    await this.admin(email);
    const wanted = normalizeEmail(rawEmail);
    const { admin } = await readJson(request);
    if (typeof admin !== "boolean") throw new HubError(400, "bad_request", "admin is true or false");
    const person = await this.exclusive(async () => {
      // Again here: an admin taken off meanwhile changes no one.
      await this.admin(email);
      const found = wanted ? await this.person(wanted) : null;
      if (!found) throw new HubError(404, "not_found", "No one with that email is on the roster");
      if (Boolean(found.admin) === admin) return found;
      if (!admin && wanted === email) throw new HubError(409, "own_email", "An admin cannot take admin from themselves; another admin can");
      const changed = { ...found, admin };
      await this.storage.put(personKey(wanted), changed);
      return changed;
    });
    return json(200, { person: adminPersonView(person, await this.servers()) });
  }

  async renameTeam({ request, email, team }) {
    await this.admin(email);
    const name = printable((await readJson(request)).name, TEAM_NAME_LENGTH);
    if (!name) throw new HubError(400, "bad_request", `name takes 1 to ${TEAM_NAME_LENGTH} printable characters`);
    await this.storage.put("meta", { ...(await this.meta(team)), name });
    return json(200, { team: { name, host: team.hubHost, zone: team.zone } });
  }

  // ------------------------------------------------------------ the Jev guard

  /** GET /api/admin/jev: whether the team has a Jev key. No answer ever carries the key. */
  async jevStatus({ email }) {
    await this.admin(email);
    return json(200, jevView(await this.storage.get("jev")));
  }

  /** PUT /api/admin/jev: sets the key, or replaces the one there. */
  async setJev({ request, email }) {
    await this.admin(email);
    const body = await readJson(request);
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!JEV_KEY.test(key)) {
      throw new HubError(400, "bad_request", "key takes the Jev API key: 8 to 1024 printable ASCII characters, without spaces");
    }
    const record = { key, setAt: timestamp(), setBy: email };
    await this.storage.put("jev", record);
    return json(200, jevView(record));
  }

  async clearJev({ email }) {
    await this.admin(email);
    await this.storage.delete("jev");
    return json(200, jevView(null));
  }

  /**
   * POST /api/me/guard { tunnelId }: a new guard token for the caller's own server,
   * which ends the one before. Only the computer running the server's current tunnel
   * gets one: a server moved to another computer keeps its address, and the computer
   * it left must not end the new one's token. The token is in this answer and
   * nowhere else; the hub keeps its hash.
   */
  async issueGuard({ request, email, team }) {
    await this.member(email);
    const body = await readJson(request);
    const tunnelId = typeof body.tunnelId === "string" ? body.tunnelId.trim() : "";
    const issued = await this.exclusive(async () => {
      await this.member(email);
      const server = (await this.servers()).find((item) => item.owner === email);
      if (!server) throw new HubError(404, "no_server", "You have no server in the team yet; make this computer's server first");
      if (!tunnelId) throw new HubError(400, "bad_request", "tunnelId takes the id of the tunnel this computer runs for your server");
      if (tunnelId !== server.tunnelId) {
        throw new HubError(409, "other_computer", "Your server runs on another computer now; this computer gets no guard token for it");
      }
      const token = randomHex(32);
      const hash = await sha256Hex(token);
      if (server.guardHash) await this.storage.delete(guardKey(server.guardHash));
      await this.storage.put(serverKey(server.host), { ...server, guardHash: hash, guardIssuedAt: timestamp() });
      await this.storage.put(guardKey(hash), { host: server.host });
      return { token, host: server.host };
    });
    const jev = await this.storage.get("jev");
    return json(200, { url: `https://${team.hubHost}/guard`, token: issued.token, host: issued.host, jev: { set: Boolean(jev?.key) } });
  }

  /**
   * POST /guard, from a member's server with its guard token: whether a teammate's
   * question may go on, or, with an answer in the body, whether that answer may go
   * back to them. `checked` says which was judged. Without a key the hub does not
   * judge and lets either go on.
   */
  async guard(request) {
    if (request.method !== "POST") throw new HubError(405, "method_not_allowed", "/guard takes POST");
    const server = await this.guardServer(request.headers.get("authorization"));
    if (!(await this.person(server.owner))) {
      throw new HubError(403, "not_member", "The server's owner is no longer on the team's roster");
    }
    this.countGuardCall(server.host);
    const { state, checked } = guardInput(await readJson(request));
    const record = await this.storage.get("jev");
    if (!record?.key) return json(200, { judged: false, checked, allowed: true, score: null, reason: "no_key" });
    const score = await jevScore(this.env, record.key, state, checked);
    return json(200, { judged: true, checked, allowed: score < JEV_THRESHOLD, score, threshold: JEV_THRESHOLD });
  }

  /** The server whose current guard token the Authorization header carries; else 401. */
  async guardServer(authorization) {
    const refused = () => new HubError(401, "bad_token", "/guard takes Authorization: Bearer and the server's current guard token");
    const token = GUARD_TOKEN.exec(String(authorization || "").trim())?.[1];
    if (!token) throw refused();
    const hash = await sha256Hex(token);
    const entry = await this.storage.get(guardKey(hash));
    const server = entry?.host ? await this.storage.get(serverKey(entry.host)) : null;
    if (!server || server.guardHash !== hash) throw refused();
    return server;
  }

  /** At most GUARD_CALLS_PER_MINUTE calls per server in any minute; the refused ones do not count. */
  countGuardCall(host) {
    const now = Date.now();
    const recent = (this.guardCalls.get(host) || []).filter((at) => now - at < GUARD_WINDOW_MS);
    if (recent.length >= GUARD_CALLS_PER_MINUTE) {
      this.guardCalls.set(host, recent);
      throw new HubError(429, "rate_limited", `A server asks /guard at most ${GUARD_CALLS_PER_MINUTE} times a minute; try again shortly`);
    }
    recent.push(now);
    this.guardCalls.set(host, recent);
  }
}

// --------------------------------------------------------------- the Worker

export default {
  async fetch(request, env) {
    let team;
    try { team = teamSettings(env); } catch (error) { return failure(error, env); }
    // /guard, exactly, is a server's call with its guard token, which the Durable
    // Object checks; no login, and no browser cookie that another site could ride.
    const guard = new URL(request.url).pathname === "/guard";
    let person = null;
    if (!guard) {
      const certsUrl = loopbackUrl(env.ACCESS_CERTS_URL) || `https://${team.teamDomain}/cdn-cgi/access/certs`;
      try { person = await accessPerson(request.headers.get("cf-access-jwt-assertion"), team, certsUrl); }
      catch { person = { reason: "error" }; }
      if (!person.email) {
        if (new URL(request.url).pathname === "/") return html(401, signedOutPage());
        return json(401, { error: "unauthorized", detail: "The team hub needs a Cloudflare Access login" });
      }
      if (crossSite(request, team.hubHost)) {
        return json(403, { error: "cross_site", detail: "Changes to the team come from the Team Memory app, not from another site" });
      }
    }
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith("x-hub-")) headers.delete(name);
    }
    if (guard) headers.set("x-hub-guard", "1");
    else headers.set("x-hub-email", person.email);
    try {
      const hub = env.HUB.get(env.HUB.idFromName(HUB_OBJECT));
      return await hub.fetch(new Request(request, { headers }));
    } catch {
      return json(503, { error: "unavailable", detail: "The team's state could not be reached; try again" });
    }
  },
};
