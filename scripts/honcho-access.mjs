// How a request reaches the memory server (config.honcho.baseUrl), and how a
// refusal by Cloudflare Access is told apart from any other failure.
//
// A server on another computer sits behind a Cloudflare Tunnel protected by
// Cloudflare Access. A device on the team's WARP passes by identity; a machine
// without WARP presents an Access service token (CF-Access-Client-Id/Secret) next
// to the server's own bearer token. Every caller builds its headers here, so the
// collector, the MCP server, the app and setup's probes send the same thing.
//
// These are credentials for the memory server only. The shared-bridge connection
// (config.honcho.accessClientId/Secret, written by `bridge connect`) is a different
// server's token and is never read here.
import { publicUrl } from "./redact.mjs";

/** Where setup (and the collector, through its hook environment) reads the service token. */
export const ACCESS_ENV = Object.freeze({
  clientId: "HONCHO_CF_ACCESS_CLIENT_ID",
  clientSecret: "HONCHO_CF_ACCESS_CLIENT_SECRET",
});

/** The collector's older names, read only when the ones above are not set. */
const LEGACY_ACCESS_ENV = Object.freeze({
  clientId: "CF_ACCESS_CLIENT_ID",
  clientSecret: "CF_ACCESS_CLIENT_SECRET",
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function pair(clientId, clientSecret) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "").trim();
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

/** The service token saved for the memory server, or null. Both halves or nothing. */
export function configuredAccess(config) {
  const access = config?.honcho?.access;
  return access && typeof access === "object" ? pair(access.clientId, access.clientSecret) : null;
}

/** A service token from the environment, or null. */
export function environmentAccess(env = process.env, { legacy = false } = {}) {
  return pair(env[ACCESS_ENV.clientId], env[ACCESS_ENV.clientSecret])
    || (legacy ? pair(env[LEGACY_ACCESS_ENV.clientId], env[LEGACY_ACCESS_ENV.clientSecret]) : null);
}

/** The headers every request to the memory server carries: its bearer token and the Access service token. */
export function honchoHeaders({ token = "", access = null } = {}, extra = {}) {
  const headers = { ...extra };
  const bearer = String(token || "").trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (access?.clientId && access?.clientSecret) {
    headers["CF-Access-Client-Id"] = access.clientId;
    headers["CF-Access-Client-Secret"] = access.clientSecret;
  }
  return headers;
}

/**
 * fetch with redirects followed only within the memory server's own origin.
 *
 * Access answers a request it refuses with a redirect to its login page on
 * *.cloudflareaccess.com; followed, that is a 200 HTML page that looks like an
 * answer. A redirect to any other origin is returned as it is, so the service
 * token and the bearer token never travel to another host either.
 */
export async function fetchHoncho(url, init = {}) {
  let target = new URL(url);
  let options = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(target, options);
    if (!REDIRECT_STATUSES.has(response.status) || hop >= MAX_REDIRECTS) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    let next;
    try { next = new URL(location, target); } catch { return response; }
    if (next.origin !== target.origin) return response;
    await response.arrayBuffer().catch(() => {});
    const method = String(options.method || "GET").toUpperCase();
    if (response.status === 303 || ([301, 302].includes(response.status) && method !== "GET" && method !== "HEAD")) {
      options = { ...options, method: "GET", body: undefined };
    }
    target = next;
  }
}

function isAccessHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com");
}

/**
 * Whether Cloudflare Access, not the memory server, answered: a redirect to its
 * login page, or a 403 that carries its headers or names it. The response's own
 * body stays readable.
 */
export async function isCloudflareAccessBlock(response) {
  if (!response) return false;
  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get("location");
    if (!location) return false;
    try {
      return isAccessHost(new URL(location, response.url || "http://invalid").hostname);
    } catch {
      return false;
    }
  }
  if (response.status !== 403) return false;
  for (const [name] of response.headers) {
    const key = name.toLowerCase();
    if (key === "cf-mitigated" || key.startsWith("cf-access-")) return true;
  }
  const text = await response.clone().text().catch(() => "");
  return /cloudflare\s+access/i.test(text);
}

/** What setup and doctor say when Access refused this computer. */
export function accessRefusedMessage(url) {
  return `${publicUrl(url)} is behind Cloudflare Access and refused this computer; connect Cloudflare WARP with the team account, or add an Access service token`;
}

/** The same, for the app's screens. */
export const ACCESS_REFUSED_KO = "Cloudflare Access가 이 컴퓨터를 막았습니다. WARP를 팀 계정으로 켜거나 Access 서비스 토큰을 넣으세요.";

export const ACCESS_CODE = "cloudflare-access";
