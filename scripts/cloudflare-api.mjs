// Cloudflare API v4, as far as sharing a Team Memory server needs it.
//
// The owner gives the app an API token (Bearer) with these permissions and no more:
//   Account  Cloudflare Tunnel: Edit
//   Account  Access: Apps and Policies: Edit
//   Account  Access: Organizations, Identity Providers, and Groups: Read
//   Zone     DNS: Edit, Zone: Read
// With it the app makes, for every server that is shared:
//   - a remotely managed tunnel whose one ingress rule sends <host> to the gate
//     (http://gate:8010, the Compose service) and everything else to 404;
//   - a proxied CNAME <host> -> <tunnel id>.cfargotunnel.com in the owner's zone;
//   - a "people" Access app on <host>: Google login, the reusable "Team Memory people"
//     policy, and Managed OAuth so Claude Code and Codex can log in to /mcp;
//   - a "gate" Access app on <host>/v3 and <host>/health with a Bypass policy, so the
//     owner's other computers keep using the gate token there.
// A team with a hub (server/hub/hub.mjs, a Worker that holds the admin's token) has
// two Access apps instead, both with Google login and Managed OAuth:
//   - the servers app, "Team Memory servers": every server host of the team as one
//     destination each, behind the people policy. It replaces a host's two per-host
//     apps above, which go when the host joins it;
//   - the hub app, "Team Memory hub <host>", behind the reusable "Team Memory
//     everyone" policy: anyone with a login reaches the hub, which keeps the roster.
// and a third without a login: the guard app, "Team Memory hub <host> guard", on
// <host>/guard alone with the Bypass policy, where members' servers ask the hub to
// judge a teammate's question with a guard token the hub checks.
//
// Every ensure* helper looks first (by name, else by domain), creates only what is
// missing and updates only what differs, so running it twice changes nothing.
// Nothing here logs, and no error carries the API token or a tunnel token.
// The hub Worker imports this file too, so it uses Web APIs only (fetch, URL,
// AbortSignal) and must stay free of Node imports.

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export const GATE_ORIGIN = "http://gate:8010";
export const PEOPLE_POLICY_NAME = "Team Memory people";
export const BYPASS_POLICY_NAME = "Team Memory gate token";
export const TUNNEL_PREFIX = "team-memory-";
const PER_PAGE = 50;
const MAX_PAGES = 100;

export class CloudflareApiError extends Error {
  constructor(message, { status = null, code = null, method = null, path = null } = {}) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.code = code;
    this.method = method;
    this.path = path;
  }
}

// Which permission a refused call needed, in the words of the token screen.
const PERMISSION_HINTS = [
  [/\/cfd_tunnel/, "Account / Cloudflare Tunnel / Edit"],
  [/\/access\/(?:apps|policies)/, "Account / Access: Apps and Policies / Edit"],
  [/\/access\/(?:organizations|identity_providers)/, "Account / Access: Organizations, Identity Providers, and Groups / Read"],
  [/\/dns_records/, "Zone / DNS / Edit"],
  [/^\/zones/, "Zone / Zone / Read"],
];

function permissionHint(apiPath) {
  const found = PERMISSION_HINTS.find(([pattern]) => pattern.test(apiPath));
  return found ? ` (the API token needs ${found[1]})` : "";
}

/**
 * A client bound to one API token. `request` resolves to Cloudflare's whole answer
 * ({success, result, result_info}); `get` to its result; `list` walks every page.
 */
export function cloudflareClient({ token, baseUrl = CLOUDFLARE_API_BASE, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const apiToken = String(token || "").trim();
  if (!apiToken) throw new CloudflareApiError("No Cloudflare API token was given");
  const base = String(baseUrl).replace(/\/+$/, "");
  const redact = (text) => String(text ?? "").split(apiToken).join("[redacted]");

  async function request(method, apiPath, { query, body } = {}) {
    const url = new URL(`${base}${apiPath}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: `Bearer ${apiToken}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error?.cause?.code || error?.name || "network error";
      throw new CloudflareApiError(redact(`Cloudflare could not be reached for ${method} ${apiPath}: ${reason}`), { method, path: apiPath });
    }
    const text = await response.text().catch(() => "");
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok || !payload || typeof payload !== "object" || payload.success === false) {
      const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
      const detail = first
        ? `${first.code ? `${first.code} ` : ""}${String(first.message || "").slice(0, 300)}`.trim()
        : payload ? "" : "the answer was not JSON";
      const refused = response.status === 401 || response.status === 403 || first?.code === 10000;
      const message = `Cloudflare ${method} ${apiPath} failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}${refused ? permissionHint(apiPath) : ""}`;
      throw new CloudflareApiError(redact(message), { status: response.status, code: first?.code ?? null, method, path: apiPath });
    }
    return payload;
  }

  async function get(apiPath, query) {
    return (await request("GET", apiPath, { query })).result;
  }

  async function list(apiPath, query = {}) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await request("GET", apiPath, { query: { ...query, page, per_page: PER_PAGE } });
      const result = Array.isArray(payload.result) ? payload.result : [];
      items.push(...result);
      const totalPages = Number(payload.result_info?.total_pages);
      if (!result.length || !Number.isFinite(totalPages) || page >= totalPages) break;
    }
    return items;
  }

  return {
    request,
    get,
    list,
    post: async (apiPath, body) => (await request("POST", apiPath, { body })).result,
    put: async (apiPath, body) => (await request("PUT", apiPath, { body })).result,
    patch: async (apiPath, body) => (await request("PATCH", apiPath, { body })).result,
    delete: async (apiPath, query) => (await request("DELETE", apiPath, { query })).result,
  };
}

function isNotFound(error) {
  return error instanceof CloudflareApiError && error.status === 404;
}

function enc(value) {
  return encodeURIComponent(String(value));
}

// ------------------------------------------------------------ zone, account

/** The zone of that exact name the token can see, and the account it is in. */
export async function findZone(client, name) {
  const wanted = String(name || "").trim().toLowerCase();
  const zones = await client.list("/zones", { name: wanted });
  const zone = zones.find((item) => String(item?.name || "").toLowerCase() === wanted);
  if (!zone) throw new CloudflareApiError(`The API token cannot see a zone named ${wanted}; check the name and that the token includes it (Zone / Zone / Read)`);
  if (!zone.account?.id) throw new CloudflareApiError(`Cloudflare did not say which account the zone ${wanted} is in`);
  return { id: zone.id, name: zone.name, accountId: zone.account.id };
}

/** Every zone the token can see, by name. */
export async function listZones(client) {
  return (await client.list("/zones")).map((zone) => ({ id: zone.id, name: zone.name, accountId: zone.account?.id || null }));
}

/** The account's Zero Trust team domain, <team>.cloudflareaccess.com. */
export async function accessTeamDomain(client, accountId) {
  const organization = await client.get(`/accounts/${enc(accountId)}/access/organizations`);
  const domain = String(organization?.auth_domain || "").trim().toLowerCase();
  if (!domain) throw new CloudflareApiError("This account has no Zero Trust team domain yet; open Zero Trust in the Cloudflare dashboard once to create it");
  return domain;
}

export async function listIdentityProviders(client, accountId) {
  return (await client.list(`/accounts/${enc(accountId)}/access/identity_providers`))
    .map((item) => ({ id: item.id, name: item.name, type: item.type }));
}

/**
 * The Google login people use. One Google provider is taken as it is; with several,
 * `wanted` (an id or a name) must say which.
 */
export function chooseGoogleIdp(providers, wanted = "") {
  const google = providers.filter((item) => item.type === "google" || item.type === "google-apps");
  const choice = String(wanted || "").trim();
  if (choice) {
    const match = google.find((item) => item.id === choice)
      || google.find((item) => String(item.name || "").toLowerCase() === choice.toLowerCase());
    if (!match) {
      throw new CloudflareApiError(`No Google login named ${choice} in Zero Trust; the Google logins are: ${google.map((item) => `${item.name} (${item.id})`).join(", ") || "none"}`);
    }
    return match;
  }
  if (google.length === 1) return google[0];
  if (!google.length) {
    throw new CloudflareApiError("Zero Trust has no Google login yet; add one under Settings > Authentication > Login methods, then run this again");
  }
  throw new CloudflareApiError(`Zero Trust has ${google.length} Google logins; choose one with --idp <name|id>: ${google.map((item) => `${item.name} (${item.id})`).join(", ")}`);
}

// ------------------------------------------------------------------- tunnels

/** The remotely managed tunnel of that name, made when missing. */
export async function ensureTunnel(client, accountId, name) {
  const base = `/accounts/${enc(accountId)}/cfd_tunnel`;
  const found = (await client.list(base, { name, is_deleted: "false" }))
    .find((item) => item?.name === name && !item.deleted_at);
  if (found) {
    if (found.config_src && found.config_src !== "cloudflare") {
      throw new CloudflareApiError(`The tunnel ${name} is managed by a local config file, so its routes cannot be set here; delete it in the Cloudflare dashboard or choose another name`);
    }
    return { id: found.id, name, created: false };
  }
  const created = await client.post(base, { name, config_src: "cloudflare" });
  return { id: created.id, name, created: true };
}

export async function findTunnel(client, accountId, name) {
  const found = (await client.list(`/accounts/${enc(accountId)}/cfd_tunnel`, { name, is_deleted: "false" }))
    .find((item) => item?.name === name && !item.deleted_at);
  return found ? { id: found.id, name } : null;
}

/** The token a connector runs the tunnel with. A secret: never log or print it. */
export async function tunnelToken(client, accountId, tunnelId) {
  const token = await client.get(`/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/token`);
  if (typeof token !== "string" || !token.trim()) throw new CloudflareApiError("Cloudflare returned no tunnel token");
  return token.trim();
}

export function ingressFor(hostname, service = GATE_ORIGIN) {
  return [{ hostname, service }, { service: "http_status:404" }];
}

function sameIngress(current, desired) {
  if (!Array.isArray(current) || current.length !== desired.length) return false;
  return desired.every((rule, index) => (current[index]?.hostname || undefined) === rule.hostname
    && current[index]?.service === rule.service
    && !current[index]?.path);
}

/** The tunnel sends <hostname> to the gate and nothing else anywhere. */
export async function ensureTunnelIngress(client, accountId, tunnelId, hostname, service = GATE_ORIGIN) {
  const apiPath = `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`;
  const desired = ingressFor(hostname, service);
  let current = null;
  try { current = await client.get(apiPath); } catch (error) { if (!isNotFound(error)) throw error; }
  if (sameIngress(current?.config?.ingress, desired)) return { changed: false };
  await client.put(apiPath, { config: { ingress: desired } });
  return { changed: true };
}

/** Removes the tunnel; its connectors are cleaned up first, as Cloudflare requires. */
export async function deleteTunnel(client, accountId, tunnelId) {
  const base = `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`;
  try { await client.delete(`${base}/connections`); } catch (error) { if (!isNotFound(error)) throw error; }
  try { await client.delete(base); return true; } catch (error) { if (isNotFound(error)) return false; throw error; }
}

// ----------------------------------------------------------------------- DNS

export function tunnelTarget(tunnelId) {
  return `${tunnelId}.cfargotunnel.com`;
}

async function recordsNamed(client, zoneId, host) {
  return (await client.list(`/zones/${enc(zoneId)}/dns_records`, { "name.exact": host }))
    .filter((item) => String(item?.name || "").toLowerCase() === host);
}

/**
 * A proxied CNAME <host> -> <tunnel>.cfargotunnel.com. A CNAME that already points
 * at a tunnel is moved; any other record of that name is the owner's and is left
 * alone with an error.
 */
export async function ensureTunnelCname(client, zoneId, host, tunnelId) {
  const target = tunnelTarget(tunnelId);
  const records = await recordsNamed(client, zoneId, host);
  const other = records.find((item) => item.type !== "CNAME");
  if (other) throw new CloudflareApiError(`${host} already has a record of type ${other.type}; remove it in the Cloudflare dashboard or choose another name`);
  const cname = records.find((item) => item.type === "CNAME");
  if (!cname) {
    const created = await client.post(`/zones/${enc(zoneId)}/dns_records`, {
      type: "CNAME", name: host, content: target, proxied: true, ttl: 1, comment: "Team Memory",
    });
    return { id: created.id, created: true, updated: false };
  }
  if (cname.content === target && cname.proxied === true) return { id: cname.id, created: false, updated: false };
  if (!/\.cfargotunnel\.com$/i.test(String(cname.content || ""))) {
    throw new CloudflareApiError(`${host} already points at ${cname.content}; remove that record in the Cloudflare dashboard or choose another name`);
  }
  await client.patch(`/zones/${enc(zoneId)}/dns_records/${enc(cname.id)}`, { content: target, proxied: true });
  return { id: cname.id, created: false, updated: true };
}

export async function deleteHostRecord(client, zoneId, host) {
  let removed = 0;
  for (const record of await recordsNamed(client, zoneId, host)) {
    if (record.type !== "CNAME" || !/\.cfargotunnel\.com$/i.test(String(record.content || ""))) continue;
    try { await client.delete(`/zones/${enc(zoneId)}/dns_records/${enc(record.id)}`); removed += 1; }
    catch (error) { if (!isNotFound(error)) throw error; }
  }
  return removed;
}

// ------------------------------------------------------------------ policies

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@,;<>"']{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email) ? email : "";
}

/** The emails a policy lets in, in its own order. */
export function policyEmails(policy) {
  return (policy?.include || []).map((rule) => normalizeEmail(rule?.email?.email)).filter(Boolean);
}

async function findPolicy(client, accountId, { id = "", name }) {
  const base = `/accounts/${enc(accountId)}/access/policies`;
  if (id) {
    try { return await client.get(`${base}/${enc(id)}`); } catch (error) { if (!isNotFound(error)) throw error; }
  }
  return (await client.list(base)).find((item) => item?.name === name) || null;
}

function policyBody(policy, include, decision) {
  return {
    name: policy.name,
    decision,
    include,
    ...(Array.isArray(policy.exclude) && policy.exclude.length ? { exclude: policy.exclude } : {}),
    ...(Array.isArray(policy.require) && policy.require.length ? { require: policy.require } : {}),
  };
}

/**
 * The reusable allow policy holding the team's email list. `add` and `remove` edit
 * the emails; any rule that is not an email (a group the owner added by hand) stays.
 */
export async function ensurePeoplePolicy(client, accountId, { id = "", add = [], remove = [] } = {}) {
  const base = `/accounts/${enc(accountId)}/access/policies`;
  const adding = add.map(normalizeEmail).filter(Boolean);
  const removing = new Set(remove.map(normalizeEmail).filter(Boolean));
  const existing = await findPolicy(client, accountId, { id, name: PEOPLE_POLICY_NAME });
  if (!existing) {
    const emails = [...new Set(adding)].filter((email) => !removing.has(email));
    if (!emails.length) throw new CloudflareApiError("The people policy needs at least one email");
    const created = await client.post(base, {
      name: PEOPLE_POLICY_NAME,
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
    });
    return { id: created.id, emails, created: true, updated: false };
  }
  const before = policyEmails(existing);
  const emails = [...new Set([...before, ...adding])].filter((email) => !removing.has(email));
  const others = (existing.include || []).filter((rule) => !normalizeEmail(rule?.email?.email));
  const unchanged = existing.decision === "allow" && emails.length === before.length && emails.every((email, index) => email === before[index]);
  if (unchanged) return { id: existing.id, emails, created: false, updated: false };
  const include = [...others, ...emails.map((email) => ({ email: { email } }))];
  if (!include.length) throw new CloudflareApiError("The people policy cannot be left empty");
  await client.put(`${base}/${enc(existing.id)}`, policyBody({ ...existing, name: PEOPLE_POLICY_NAME }, include, "allow"));
  return { id: existing.id, emails, created: false, updated: true };
}

/** Everyone, as far as Access goes: the gate token guards /v3 and /health instead. */
export async function ensureBypassPolicy(client, accountId, { id = "" } = {}) {
  const base = `/accounts/${enc(accountId)}/access/policies`;
  const include = [{ everyone: {} }];
  const existing = await findPolicy(client, accountId, { id, name: BYPASS_POLICY_NAME });
  if (!existing) {
    const created = await client.post(base, { name: BYPASS_POLICY_NAME, decision: "bypass", include });
    return { id: created.id, created: true, updated: false };
  }
  const everyoneOnly = existing.decision === "bypass"
    && Array.isArray(existing.include) && existing.include.length === 1 && existing.include[0]?.everyone;
  if (everyoneOnly) return { id: existing.id, created: false, updated: false };
  await client.put(`${base}/${enc(existing.id)}`, { name: BYPASS_POLICY_NAME, decision: "bypass", include });
  return { id: existing.id, created: false, updated: true };
}

// ---------------------------------------------------------------------- apps

export function peopleAppName(host) {
  return `Team Memory ${host}`;
}

export function bypassAppName(host) {
  return `Team Memory ${host} gate token`;
}

/** The people app: Google login for the team list, and Managed OAuth for agents. */
export function peopleAppBody({ host, idpId, policyId }) {
  return {
    name: peopleAppName(host),
    type: "self_hosted",
    domain: host,
    destinations: [{ type: "public", uri: host }],
    allowed_idps: [idpId],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    policies: [{ id: policyId, precedence: 1 }],
    oauth_configuration: {
      enabled: true,
      dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true },
      grant: { session_duration: "336h" },
    },
  };
}

/** /v3 and /health pass Access untouched; the gate token guards them. */
export function bypassAppBody({ host, policyId }) {
  return {
    name: bypassAppName(host),
    type: "self_hosted",
    domain: `${host}/v3`,
    destinations: [{ type: "public", uri: `${host}/v3` }, { type: "public", uri: `${host}/health` }],
    policies: [{ id: policyId, precedence: 1 }],
  };
}

function containsAll(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => containsAll(actual[key], value));
}

function sortedJoin(values) {
  return [...(values || [])].map(String).sort().join(",");
}

/** Whether the app already is what `desired` asks for, in every field it sets. */
export function appMatches(existing, desired) {
  if (!existing) return false;
  for (const key of ["name", "type", "domain", "auto_redirect_to_identity", "session_duration"]) {
    if (key in desired && existing[key] !== desired[key]) return false;
  }
  if (desired.destinations) {
    const uris = (items) => sortedJoin((items || []).map((item) => `${item?.type || "public"}:${item?.uri}`));
    if (uris(existing.destinations) !== uris(desired.destinations)) return false;
  }
  if (desired.allowed_idps && sortedJoin(existing.allowed_idps) !== sortedJoin(desired.allowed_idps)) return false;
  const policies = (items) => sortedJoin((items || []).map((item) => `${item?.id}@${item?.precedence ?? 1}`));
  if (policies(existing.policies) !== policies(desired.policies)) return false;
  if (desired.oauth_configuration && !containsAll(existing.oauth_configuration, desired.oauth_configuration)) return false;
  return true;
}

async function findApp(client, accountId, { id = "", name, domain }) {
  const base = `/accounts/${enc(accountId)}/access/apps`;
  if (id) {
    try { return await client.get(`${base}/${enc(id)}`); } catch (error) { if (!isNotFound(error)) throw error; }
  }
  const apps = await client.list(base);
  return apps.find((item) => item?.name === name) || apps.find((item) => item?.domain === domain) || null;
}

/** The Access app `desired` describes: found by name, else by domain; made or updated. */
export async function ensureAccessApp(client, accountId, desired, { id = "" } = {}) {
  const base = `/accounts/${enc(accountId)}/access/apps`;
  const existing = await findApp(client, accountId, { id, name: desired.name, domain: desired.domain });
  if (!existing) {
    const created = await client.post(base, desired);
    return { id: created.id, aud: created.aud || "", created: true, updated: false };
  }
  if (appMatches(existing, desired)) return { id: existing.id, aud: existing.aud || "", created: false, updated: false };
  const updated = await client.put(`${base}/${enc(existing.id)}`, desired);
  return { id: existing.id, aud: updated?.aud || existing.aud || "", created: false, updated: true };
}

export async function deleteAccessApp(client, accountId, { id = "", name, domain }) {
  const existing = await findApp(client, accountId, { id, name, domain });
  if (!existing) return false;
  try { await client.delete(`/accounts/${enc(accountId)}/access/apps/${enc(existing.id)}`); return true; }
  catch (error) { if (isNotFound(error)) return false; throw error; }
}

// --------------------------------------------------------------- one server

/**
 * Everything one shared server needs in Cloudflare: its tunnel and that tunnel's
 * ingress, the hostname, the people app and the gate-token app. Returns the
 * tunnel token (a secret) beside ids and the people app's AUD tag.
 */
export async function ensureServerHost(client, { accountId, zoneId, host, tunnelName, idpId, peoplePolicyId, bypassPolicyId, known = {} }) {
  const tunnel = await ensureTunnel(client, accountId, tunnelName);
  const ingress = await ensureTunnelIngress(client, accountId, tunnel.id, host);
  const dns = await ensureTunnelCname(client, zoneId, host, tunnel.id);
  const people = await ensureAccessApp(client, accountId, peopleAppBody({ host, idpId, policyId: peoplePolicyId }), { id: known.peopleAppId });
  if (!people.aud) throw new CloudflareApiError(`Cloudflare returned no AUD tag for the Access app on ${host}`);
  const bypass = await ensureAccessApp(client, accountId, bypassAppBody({ host, policyId: bypassPolicyId }), { id: known.bypassAppId });
  const token = await tunnelToken(client, accountId, tunnel.id);
  return {
    host,
    tunnelId: tunnel.id,
    tunnelName,
    tunnelToken: token,
    aud: people.aud,
    peopleAppId: people.id,
    bypassAppId: bypass.id,
    dnsRecordId: dns.id,
    changes: {
      tunnel: tunnel.created ? "created" : "kept",
      ingress: ingress.changed ? "updated" : "kept",
      dns: dns.created ? "created" : dns.updated ? "updated" : "kept",
      peopleApp: people.created ? "created" : people.updated ? "updated" : "kept",
      bypassApp: bypass.created ? "created" : bypass.updated ? "updated" : "kept",
    },
  };
}

/** Removes what ensureServerHost made; what is already gone is not an error. */
export async function removeServerHost(client, { accountId, zoneId, host, tunnelName, known = {} }) {
  const peopleApp = await deleteAccessApp(client, accountId, { id: known.peopleAppId, name: peopleAppName(host), domain: host });
  const bypassApp = await deleteAccessApp(client, accountId, { id: known.bypassAppId, name: bypassAppName(host), domain: `${host}/v3` });
  const dnsRecords = await deleteHostRecord(client, zoneId, host);
  const tunnel = known.tunnelId ? { id: known.tunnelId } : await findTunnel(client, accountId, tunnelName);
  const tunnelRemoved = tunnel ? await deleteTunnel(client, accountId, tunnel.id) : false;
  return { peopleApp, bypassApp, dnsRecords, tunnel: tunnelRemoved };
}

// ------------------------------------------------------------- the team hub
//
// The hub makes each server's tunnel and hostname with the helpers above, but every
// server host shares one Access app, and the hub has an app of its own. Managed
// OAuth grants on both last a year, so the app's refresh token outlives the 24 h
// browser session.

export const SERVERS_APP_NAME = "Team Memory servers";
// One Access app takes at most 50 destinations.
export const SERVERS_APP_MAX_HOSTS = 50;
export const EVERYONE_POLICY_NAME = "Team Memory everyone";
// The hub app is called "Team Memory hub <host>".
export const HUB_APP_NAME = "Team Memory hub";

function managedOAuth() {
  return {
    enabled: true,
    dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true },
    grant: { session_duration: "8760h" },
  };
}

/** The servers app: every server host of the team, the people policy, Google login, Managed OAuth. */
export function serversAppBody({ hosts, idpId, policyId }) {
  return {
    name: SERVERS_APP_NAME,
    type: "self_hosted",
    domain: hosts[0],
    destinations: hosts.map((uri) => ({ type: "public", uri })),
    allowed_idps: [idpId],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    policies: [{ id: policyId, precedence: 1 }],
    oauth_configuration: managedOAuth(),
  };
}

/**
 * The servers app holding exactly `hosts` (1 to 50, the first is its domain), made
 * when missing and updated when it differs. `known.id` is its id from before, if any.
 * Returns { id, aud, created, updated }.
 */
export async function ensureServersApp(client, accountId, { hosts, idpId, policyId, known = {} }) {
  const list = [...new Set((hosts || []).map((host) => String(host).trim().toLowerCase()).filter(Boolean))];
  if (!list.length || list.length > SERVERS_APP_MAX_HOSTS) {
    throw new CloudflareApiError(`The servers app holds 1 to ${SERVERS_APP_MAX_HOSTS} hosts, not ${list.length}`);
  }
  const app = await ensureAccessApp(client, accountId, serversAppBody({ hosts: list, idpId, policyId }), { id: known?.id || "" });
  if (!app.aud) throw new CloudflareApiError("Cloudflare returned no AUD tag for the servers app");
  return app;
}

/**
 * Deletes the two per-host apps the first sharing made for `host` (peopleAppName and
 * bypassAppName). They are matched by exact name only, never by domain, since the
 * servers app may have that same domain.
 */
export async function removeLegacyHostApps(client, accountId, host) {
  const base = `/accounts/${enc(accountId)}/access/apps`;
  const apps = await client.list(base);
  const removed = { peopleApp: false, bypassApp: false };
  for (const [kind, name] of [["peopleApp", peopleAppName(host)], ["bypassApp", bypassAppName(host)]]) {
    for (const app of apps.filter((item) => item?.name === name)) {
      try { await client.delete(`${base}/${enc(app.id)}`); removed[kind] = true; }
      catch (error) { if (!isNotFound(error)) throw error; }
    }
  }
  return removed;
}

/**
 * The reusable allow policy for anyone with a login, for the hub app: the hub itself
 * decides who is in the team. A policy `id` names is used only if it has this name,
 * so another policy is never opened to everyone; rules the owner added by hand
 * (exclude, require) stay.
 */
export async function ensureEveryonePolicy(client, accountId, { id = "" } = {}) {
  const base = `/accounts/${enc(accountId)}/access/policies`;
  const include = [{ everyone: {} }];
  let existing = await findPolicy(client, accountId, { id, name: EVERYONE_POLICY_NAME });
  if (existing && existing.name !== EVERYONE_POLICY_NAME) existing = await findPolicy(client, accountId, { name: EVERYONE_POLICY_NAME });
  if (!existing) {
    const created = await client.post(base, { name: EVERYONE_POLICY_NAME, decision: "allow", include });
    return { id: created.id, created: true, updated: false };
  }
  const everyoneOnly = existing.decision === "allow"
    && Array.isArray(existing.include) && existing.include.length === 1 && existing.include[0]?.everyone;
  if (everyoneOnly) return { id: existing.id, created: false, updated: false };
  await client.put(`${base}/${enc(existing.id)}`, policyBody(existing, include, "allow"));
  return { id: existing.id, created: false, updated: true };
}

/** The hub app on `host`: the everyone policy, Google login, Managed OAuth. */
export function hubAppBody({ host, idpId, policyId }) {
  return {
    name: `${HUB_APP_NAME} ${host}`,
    type: "self_hosted",
    domain: host,
    destinations: [{ type: "public", uri: host }],
    allowed_idps: [idpId],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    policies: [{ id: policyId, precedence: 1 }],
    oauth_configuration: managedOAuth(),
  };
}

/**
 * The hub's guard app: <host>/guard passes Access untouched, behind the Bypass
 * policy, since a server calls it rather than a person; the guard token guards it.
 * The hub's Worker serves only /guard itself without a login.
 */
export function hubGuardAppBody({ host, policyId }) {
  return {
    name: `${HUB_APP_NAME} ${host} guard`,
    type: "self_hosted",
    domain: `${host}/guard`,
    destinations: [{ type: "public", uri: `${host}/guard` }],
    policies: [{ id: policyId, precedence: 1 }],
  };
}
