// Signing in to the team: Google, through Cloudflare Access, for this app and its
// collector.
//
// Everything a team shares sits behind Cloudflare Access: the team hub at
// https://team.<zone> and every member's server. A person logs in to Access with
// Google in the browser. A program does what Claude Code does for a remote MCP
// server, Access's Managed OAuth: this app registers itself as an OAuth client
// (dynamic client registration, redirecting to its own loopback address), the
// browser logs in once, and from then on the app holds an opaque access token (15
// minutes) and a refresh token. Access turns the access token into the signed
// assertion the hub and the gates check, so nobody copies a token anywhere.
//
// A team has two Access applications, so two logins are kept:
//   hub       the hub, open to any Google login; the hub itself decides who is in
//             the team, so it can name the email it saw to someone who is not
//   servers   every server of the team, one application with one destination per
//             server, so one login reaches all of them
// Which login a request needs follows from its host: the hub's, or any other.
//
// A server also tells this computer's requests from the owner's other computers:
// each computer registers once with a server's gate (POST /team-memory/devices) and
// keeps the device key it gets back. It goes with every request to that server in
// X-Team-Memory-Device, so one computer can be cut off on its own. It is never
// shown.
//
// Files under <dataDir>/state, owner-only, never printed:
//   team-auth.json       the hub's host, the email it saw, both logins (client id,
//                        endpoints, tokens, expiry), the logins Access stopped
//                        refreshing (when, whose, where) and the device keys by host
//   team-login.json      logins started in the browser and not finished yet
//                        (state, PKCE verifier), and the ones whose callback failed,
//                        dropped after ten minutes
//   team-auth.json.lock  held while a token is refreshed, so two collectors never
//                        spend one refresh token twice
// HONCHO_AGENT_TEAM_AUTH names team-auth.json for the collector's hook runs.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { installPaths } from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";

export const DEVICE_HEADER = "X-Team-Memory-Device";
export const TEAM_AUTH_ENV = "HONCHO_AGENT_TEAM_AUTH";
export const LOGIN_KINDS = Object.freeze(["hub", "servers"]);
export const CALLBACK_PATH = "/oauth/callback";

const PENDING_MS = 10 * 60_000;
// A token this close to its end is refreshed before it is used.
const REFRESH_MARGIN_MS = 60_000;
// Access issues 15-minute tokens unless an app says otherwise.
const DEFAULT_TOKEN_SECONDS = 900;
const TIMEOUT_MS = 20_000;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Why the team cannot be reached: `login_needed` (sign in again) or `login_failed`.
 * `details` names the login it is about (`kind`, `host`) when that is known.
 */
export class TeamLoginError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TeamLoginError";
    this.code = code;
    Object.assign(this, details);
  }
}

/** A host of the team (the hub's or a server's), lower case, or null. */
export function teamHost(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      host = url.hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\/+$/, "").replace(/\.$/, "");
  return HOSTNAME.test(host) ? host : null;
}

export function teamAuthPaths(config = null, env = process.env) {
  const authFile = path.resolve(String(env[TEAM_AUTH_ENV] || "").trim()
    || path.join(installPaths(config).dataDir, "state", "team-auth.json"));
  return {
    authFile,
    pendingFile: path.join(path.dirname(authFile), "team-login.json"),
    lockFile: `${authFile}.lock`,
  };
}

async function readJsonFile(file) {
  try {
    const value = JSON.parse(await fsp.readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** What team-auth.json holds, with every part present. */
export async function readTeamAuth(paths) {
  const value = await readJsonFile(paths.authFile);
  return {
    version: 1,
    hub: typeof value?.hub === "string" ? value.hub : null,
    email: typeof value?.email === "string" ? value.email : null,
    me: value?.me && typeof value.me === "object" ? value.me : {},
    logins: value?.logins && typeof value.logins === "object" ? value.logins : {},
    ended: value?.ended && typeof value.ended === "object" ? value.ended : {},
    devices: value?.devices && typeof value.devices === "object" ? value.devices : {},
  };
}

async function writeTeamAuth(paths, auth) {
  await writePrivateFileAtomic(paths.authFile, `${JSON.stringify(auth, null, 2)}\n`);
}

/** Changes team-auth.json under its lock: `change` gets the current contents and returns the new. */
async function updateTeamAuth(paths, change) {
  const lock = await acquireFileLock(paths.lockFile, { attempts: 100, delayMs: 100, staleMs: 60_000 });
  if (!lock) throw new Error("Another program is changing the team login; try again in a moment");
  try {
    const next = await change(await readTeamAuth(paths));
    if (next) await writeTeamAuth(paths, next);
    return next;
  } finally {
    await releaseFileLock(lock);
  }
}

/** Which login a host needs: the hub's own, or the servers'. */
export function loginKindFor(auth, host) {
  return auth.hub && host === auth.hub ? "hub" : "servers";
}

// ------------------------------------------------------------------ OAuth

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function fetchJson(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new TeamLoginError("login_failed", `${new URL(url).host} could not be reached: ${error?.cause?.code || error?.name || "network error"}`);
  }
  const text = await response.text().catch(() => "");
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, ok: response.ok, body };
}

/**
 * The OAuth endpoints Access serves for a host (RFC 8414, on the host itself). Only
 * https endpoints on the issuer's own host are taken.
 */
export async function discoverLogin(host, { fetchImpl = globalThis.fetch } = {}) {
  const answer = await fetchJson(fetchImpl, `https://${host}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
  const meta = answer.body;
  if (!answer.ok || !meta || typeof meta.issuer !== "string") {
    throw new TeamLoginError("login_failed", `${host} does not offer a Google login for programs (HTTP ${answer.status}); its Cloudflare Access app needs Managed OAuth`);
  }
  let issuer;
  try { issuer = new URL(meta.issuer); } catch { throw new TeamLoginError("login_failed", `${host} names an issuer that is not a URL`); }
  const endpoint = (name, required = true) => {
    const value = meta[name];
    if (!value && !required) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.host !== issuer.host) throw new Error("other host");
      return url.toString();
    } catch {
      throw new TeamLoginError("login_failed", `${host} names no usable ${name}`);
    }
  };
  if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes("S256")) {
    throw new TeamLoginError("login_failed", `${host} does not take S256 PKCE`);
  }
  return {
    issuer: issuer.toString().replace(/\/$/, ""),
    authorizationEndpoint: endpoint("authorization_endpoint"),
    tokenEndpoint: endpoint("token_endpoint"),
    registrationEndpoint: endpoint("registration_endpoint"),
    revocationEndpoint: endpoint("revocation_endpoint", false),
  };
}

async function registerClient(meta, redirectUri, fetchImpl) {
  const answer = await fetchJson(fetchImpl, meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Team Memory",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = answer.body?.client_id;
  if (!answer.ok || typeof clientId !== "string" || !clientId) {
    throw new TeamLoginError("login_failed", `Access did not register this app for the login (HTTP ${answer.status})`);
  }
  return clientId;
}

/** The logins waiting for the browser, and the ones whose callback failed, younger than ten minutes. */
async function readLogins(paths, now) {
  const value = await readJsonFile(paths.pendingFile);
  const pending = value?.pending && typeof value.pending === "object" ? value.pending : {};
  const failed = Array.isArray(value?.failed) ? value.failed : [];
  return {
    pending: Object.fromEntries(Object.entries(pending).filter(([, item]) => item && now - Number(item.createdAt) < PENDING_MS)),
    failed: failed.filter((item) => item && now - Number(item.at) < PENDING_MS),
  };
}

async function writeLogins(paths, { pending, failed }) {
  await writePrivateFileAtomic(paths.pendingFile, `${JSON.stringify({ version: 1, pending, failed }, null, 2)}\n`);
}

/**
 * Where a browser signs out of Access for `host`: the application's own domain and
 * the team domain, the issuer of its OAuth metadata (<team>.cloudflareaccess.com).
 * Access keeps a session cookie on each, and the team domain's signs the same Google
 * account straight back in, so switching accounts needs both.
 */
export function accessLogouts(host, issuer) {
  let teamDomain = null;
  try {
    const url = new URL(issuer);
    if (url.protocol === "https:") teamDomain = url.hostname;
  } catch {}
  return [...new Set([teamHost(host), teamDomain].filter(Boolean))].map((domain) => `https://${domain}/cdn-cgi/access/logout`);
}

/**
 * Starts a browser login to the Access app of `host` for `kind`: registers this app
 * as a client when it has no client for this redirect yet, and returns the address
 * to open, the login's `id` (not its state, which stays secret) for the page to ask
 * about it, and where to sign out of Access. The state and the PKCE verifier wait in
 * team-login.json. Every start is a new state: one that something came back for is
 * spent, so opening its address again never works.
 */
export async function startLogin({ host, kind, redirectUri, paths, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const name = teamHost(host);
  if (!name) throw new TeamLoginError("login_failed", "The address to log in to is not a host name");
  if (!LOGIN_KINDS.includes(kind)) throw new TeamLoginError("login_failed", `Unknown login: ${kind}`);
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) || redirect.pathname !== CALLBACK_PATH) {
    throw new TeamLoginError("login_failed", "The login must come back to this app's own loopback address");
  }
  const meta = await discoverLogin(name, { fetchImpl });
  const auth = await readTeamAuth(paths);
  const known = auth.logins[kind];
  const clientId = known?.clientId && known.issuer === meta.issuer && known.redirectUri === redirect.toString()
    ? known.clientId
    : await registerClient(meta, redirect.toString(), fetchImpl);
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(32));
  const id = base64url(crypto.randomBytes(9));
  const resource = `https://${name}`;
  const { pending, failed } = await readLogins(paths, now);
  pending[state] = {
    id,
    kind,
    host: name,
    resource,
    verifier,
    clientId,
    redirectUri: redirect.toString(),
    issuer: meta.issuer,
    tokenEndpoint: meta.tokenEndpoint,
    revocationEndpoint: meta.revocationEndpoint,
    createdAt: now,
  };
  await writeLogins(paths, { pending, failed });
  const url = new URL(meta.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect.toString(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();
  return { url: url.toString(), state, id, kind, host: name, logouts: accessLogouts(name, meta.issuer) };
}

async function tokenRequest(fetchImpl, endpoint, form) {
  const answer = await fetchJson(fetchImpl, endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  return answer;
}

function tokensFrom(body, now, previousRefresh = null) {
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  if (!accessToken) return null;
  const seconds = Number(body.expires_in);
  return {
    accessToken,
    expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TOKEN_SECONDS) * 1000,
    // A server that does not rotate refresh tokens sends none back.
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previousRefresh,
  };
}

/**
 * Finishes a browser login with what came back to the callback: exchanges the code
 * for tokens and keeps them as the login of the kind it was started for. Whatever
 * came back spends the state; a failure is kept for ten minutes under the login's
 * id, so the page waiting for it hears at once instead of waiting it out.
 */
export async function finishLogin({ state, code, error, errorDescription, paths, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const { pending, failed } = await readLogins(paths, now);
  const started = typeof state === "string" ? pending[state] : null;
  if (!started) throw new TeamLoginError("login_failed", "This login was not started here, or it waited too long; start it again");
  delete pending[state];
  await writeLogins(paths, { pending, failed });
  try {
    return await exchangeCode(started, { code, error, errorDescription, paths, fetchImpl, now });
  } catch (problem) {
    // Read again: the page may have started another login meanwhile.
    const latest = await readLogins(paths, now);
    latest.failed.push({
      id: started.id || null,
      kind: started.kind,
      error: problem?.reason || "failed",
      detail: String(problem?.detail ?? problem?.message ?? problem).slice(0, 200),
      at: now,
    });
    await writeLogins(paths, { pending: latest.pending, failed: latest.failed.slice(-10) });
    throw problem;
  }
}

async function exchangeCode(started, { code, error, errorDescription, paths, fetchImpl, now }) {
  if (error) {
    const detail = String(errorDescription || error).slice(0, 200);
    throw new TeamLoginError("login_failed", `The login was refused: ${detail}`, { reason: "refused", detail });
  }
  if (typeof code !== "string" || !code) throw new TeamLoginError("login_failed", "The login came back without a code", { reason: "no_code", detail: "no code" });
  const answer = await tokenRequest(fetchImpl, started.tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: started.redirectUri,
    client_id: started.clientId,
    code_verifier: started.verifier,
    resource: started.resource,
  });
  const tokens = answer.ok ? tokensFrom(answer.body, now) : null;
  if (!tokens) throw new TeamLoginError("login_failed", `Access did not give a token for the login (HTTP ${answer.status})`, { reason: "no_token", detail: `HTTP ${answer.status}` });
  await updateTeamAuth(paths, (auth) => ({
    ...auth,
    ended: Object.fromEntries(Object.entries(auth.ended).filter(([kind]) => kind !== started.kind)),
    logins: {
      ...auth.logins,
      [started.kind]: {
        host: started.host,
        resource: started.resource,
        issuer: started.issuer,
        clientId: started.clientId,
        redirectUri: started.redirectUri,
        tokenEndpoint: started.tokenEndpoint,
        revocationEndpoint: started.revocationEndpoint,
        ...tokens,
        loggedInAt: new Date(now).toISOString(),
      },
    },
  }));
  return { ok: true, kind: started.kind, host: started.host };
}

/**
 * A usable access token for `kind`, refreshed when it is about to end. Throws
 * TeamLoginError `login_needed` when there is no login or Access no longer takes it,
 * and `login_failed` when Access could not be asked (the login is kept).
 */
export async function accessToken({ kind, paths, fetchImpl = globalThis.fetch, now = () => Date.now(), force = false }) {
  const current = (await readTeamAuth(paths)).logins[kind];
  if (!current?.accessToken) throw new TeamLoginError("login_needed", `Log in to the team first (${kind})`, { kind });
  if (!force && Number(current.expiresAt) - now() > REFRESH_MARGIN_MS) return current.accessToken;
  let token = null;
  let outage = null;
  await updateTeamAuth(paths, async (auth) => {
    const login = auth.logins[kind];
    if (!login?.accessToken) return null;
    // Another process may have refreshed it while this one waited for the lock.
    if (login.accessToken !== current.accessToken && Number(login.expiresAt) - now() > REFRESH_MARGIN_MS) {
      token = login.accessToken;
      return null;
    }
    // A login that cannot be refreshed any more ends, and is remembered as ended (when,
    // whose, where) so the screens say so and offer the login again.
    const end = () => {
      const logins = { ...auth.logins };
      delete logins[kind];
      return { ...auth, logins, ended: { ...auth.ended, [kind]: { at: new Date(now()).toISOString(), email: auth.email || null, host: login.host || null } } };
    };
    if (!login.refreshToken) return end();
    const answer = await tokenRequest(fetchImpl, login.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: login.refreshToken,
      client_id: login.clientId,
      resource: login.resource,
    });
    const tokens = answer.ok ? tokensFrom(answer.body, now(), login.refreshToken) : null;
    if (!tokens) {
      // A refresh token Access refuses will not work later either; anything else
      // (an outage) keeps the login for the next try.
      if (answer.status === 400 || answer.status === 401) return end();
      outage = answer.status;
      return null;
    }
    token = tokens.accessToken;
    return { ...auth, logins: { ...auth.logins, [kind]: { ...login, ...tokens, refreshedAt: new Date(now()).toISOString() } } };
  });
  if (!token && outage !== null) throw new TeamLoginError("login_failed", `Access did not refresh the team login (HTTP ${outage}); try again in a moment`, { kind });
  if (!token) throw new TeamLoginError("login_needed", `The team login has ended (${kind}); log in again`, { kind });
  return token;
}

// ---------------------------------------------------------------- requests

/** The device key this computer holds for a server, as its header value, or null. */
export function deviceHeaderValue(auth, host) {
  const device = auth.devices[host];
  return device?.id && device?.secret ? `${device.id}.${device.secret}` : null;
}

function isAccessChallenge(response) {
  return response.status === 401 && /realm="?oauth/i.test(response.headers.get("www-authenticate") || "");
}

/**
 * fetch to a host of the team with this computer's login, and its device key for
 * that host when it has one (unless `device: false`). A token Access turns down is
 * refreshed once and the request sent again.
 */
export async function teamFetch(url, init = {}, { paths, fetchImpl = globalThis.fetch, device = true, now } = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new TeamLoginError("login_failed", "A team host is only reached over https");
  const auth = await readTeamAuth(paths);
  const kind = loginKindFor(auth, target.hostname);
  const send = async (force) => {
    const token = await accessToken({ kind, paths, fetchImpl, force, ...(now ? { now } : {}) }).catch((error) => {
      if (error instanceof TeamLoginError && !error.host) error.host = target.hostname;
      throw error;
    });
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${token}`);
    const key = device ? deviceHeaderValue(auth, target.hostname) : null;
    if (key) headers.set(DEVICE_HEADER, key);
    return fetchImpl(target, { ...init, headers, redirect: "manual", signal: init.signal || AbortSignal.timeout(TIMEOUT_MS) });
  };
  let response = await send(false);
  if (isAccessChallenge(response)) {
    await response.arrayBuffer().catch(() => {});
    response = await send(true);
    if (isAccessChallenge(response)) throw new TeamLoginError("login_needed", `${target.hostname} no longer takes this computer's login; log in again`, { kind, host: target.hostname });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new TeamLoginError("login_needed", `${target.hostname} sent this computer to a login page; log in again`, { kind, host: target.hostname });
  }
  return response;
}

/** teamFetch for JSON: the body, or an error naming the status and the server's own words. */
export async function teamJson(url, { method = "GET", body, paths, fetchImpl, device = true } = {}) {
  const response = await teamFetch(url, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, { paths, fetchImpl, device });
  const text = await response.text().catch(() => "");
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error(value?.detail || value?.error || `HTTP ${response.status} from ${new URL(url).hostname}`);
    error.status = response.status;
    error.code = value?.error || null;
    error.payload = value;
    throw error;
  }
  return value ?? {};
}

/**
 * The headers a request to `baseUrl` carries when it is a team server this computer
 * registered with: the login and the device key. Nothing for any other server.
 */
export async function teamHeaders(baseUrl, { paths, fetchImpl = globalThis.fetch } = {}) {
  let host;
  try { host = new URL(baseUrl).hostname; } catch { return {}; }
  const auth = await readTeamAuth(paths);
  const key = deviceHeaderValue(auth, host);
  if (!key) return {};
  const token = await accessToken({ kind: loginKindFor(auth, host), paths, fetchImpl });
  return { Authorization: `Bearer ${token}`, [DEVICE_HEADER]: key };
}

// ------------------------------------------------------------ hub, devices

/**
 * Remembers the team this computer belongs to and what the hub said about this
 * person (email, peer, admin, the team's name), for the screens to show offline.
 */
export async function setTeam({ hub, email, peer, admin, name }, { paths }) {
  const host = teamHost(hub);
  if (!host) throw new Error("The team address is not a host name");
  return updateTeamAuth(paths, (auth) => {
    // Another team's logins and devices mean nothing here; the first team's are its own.
    const same = !auth.hub || auth.hub === host;
    const known = same ? auth.me || {} : {};
    return {
      ...auth,
      hub: host,
      email: email ? String(email).toLowerCase() : same ? auth.email : null,
      me: {
        peer: peer !== undefined ? peer : known.peer || null,
        admin: admin !== undefined ? Boolean(admin) : Boolean(known.admin),
        team: name !== undefined ? name : known.team || null,
      },
      logins: same ? auth.logins : {},
      ended: same ? auth.ended : {},
      devices: same ? auth.devices : {},
    };
  });
}

export async function saveDevice(host, device, { paths }) {
  const name = teamHost(host);
  if (!name) throw new Error("The server address is not a host name");
  if (!/^d-[0-9a-f]{16}$/.test(String(device?.id)) || !/^[A-Za-z0-9_-]{20,128}$/.test(String(device?.secret))) {
    throw new Error("The server gave back a device key this app cannot use");
  }
  return updateTeamAuth(paths, (auth) => ({
    ...auth,
    devices: {
      ...auth.devices,
      [name]: { id: device.id, secret: device.secret, name: device.name || "", email: device.email || auth.email, registeredAt: new Date().toISOString() },
    },
  }));
}

export async function forgetDevice(host, { paths }) {
  return updateTeamAuth(paths, (auth) => {
    if (!auth.devices[host]) return null;
    const devices = { ...auth.devices };
    delete devices[host];
    return { ...auth, devices };
  });
}

/**
 * Registers this computer with the gate of `host` (the caller must be its owner or
 * allowed to collect into it) and keeps the device key. One already kept is kept.
 */
export async function registerDevice(host, { name, paths, fetchImpl }) {
  const server = teamHost(host);
  if (!server) throw new Error("The server address is not a host name");
  const auth = await readTeamAuth(paths);
  if (auth.devices[server]) return { ok: true, host: server, id: auth.devices[server].id, kept: true };
  const answer = await teamJson(`https://${server}/team-memory/devices`, {
    method: "POST",
    body: { name: String(name || "").slice(0, 64) || "computer" },
    paths,
    fetchImpl,
    device: false,
  });
  // The gate hands back the whole header value, <id>.<secret>; the secret is kept apart.
  const key = String(answer.key || "");
  const secret = key.startsWith(`${answer.id}.`) ? key.slice(String(answer.id).length + 1) : key;
  await saveDevice(server, { id: answer.id, secret, name: answer.name }, { paths });
  return { ok: true, host: server, id: answer.id, kept: false };
}

/** What the gate of `host` lets this computer do, with its device key when it has one. */
export async function serverWhoami(host, { paths, fetchImpl }) {
  return teamJson(`https://${teamHost(host)}/team-memory/whoami`, { paths, fetchImpl });
}

/**
 * Who this computer is signed in as, without a token, for the app's screens: each
 * login, or when it `ended` without a sign-out, and the browser logins whose callback
 * `failed` in the last ten minutes, by id.
 */
export async function teamLoginStatus({ paths, now = Date.now() }) {
  const auth = await readTeamAuth(paths);
  const { failed } = await readLogins(paths, now);
  const login = (kind) => {
    const item = auth.logins[kind];
    if (!item?.accessToken) return { signedIn: false, ...(auth.ended[kind] ? { ended: auth.ended[kind] } : {}) };
    return { signedIn: Boolean(item.refreshToken) || Number(item.expiresAt) > now, host: item.host || null, loggedInAt: item.loggedInAt || null };
  };
  return {
    hub: auth.hub,
    email: auth.email,
    peer: auth.me.peer || null,
    admin: Boolean(auth.me.admin),
    team: auth.me.team || null,
    hubLogin: login("hub"),
    serversLogin: login("servers"),
    devices: Object.entries(auth.devices).map(([host, device]) => ({ host, id: device.id, name: device.name || "" })),
    failed: failed.map((item) => ({ id: item.id, kind: item.kind, error: item.error, detail: item.detail, at: new Date(Number(item.at)).toISOString() })),
  };
}

/** Signs this computer out of the team: tokens are revoked where Access offers it, then forgotten. */
export async function signOut({ paths, fetchImpl = globalThis.fetch }) {
  const auth = await readTeamAuth(paths);
  for (const login of Object.values(auth.logins)) {
    if (!login?.revocationEndpoint || !login.refreshToken) continue;
    await tokenRequest(fetchImpl, login.revocationEndpoint, { token: login.refreshToken, token_type_hint: "refresh_token", client_id: login.clientId }).catch(() => {});
  }
  await fsp.rm(paths.authFile, { force: true });
  await fsp.rm(paths.pendingFile, { force: true });
  return { ok: true };
}
