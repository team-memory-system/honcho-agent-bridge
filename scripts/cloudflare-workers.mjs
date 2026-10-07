// The team hub's Worker, deployed with the admin's Cloudflare API token.
//
// The hub (server/hub/hub.mjs) runs as the Worker script `team-memory-hub`, with one
// Durable Object class, TeamHub, holding the whole team. It goes up as two ES
// modules: hub.mjs, and the cloudflare-api.mjs beside this file, which the hub
// imports to make each member's server address (the import is pointed at the
// uploaded copy). With them go three bindings:
//   HUB           the Durable Object namespace, made by the first upload's migration
//   TEAM          plain-text JSON naming the team's Cloudflare side; no secret
//   CF_API_TOKEN  the admin's API token, as a secret Cloudflare never shows again
// so the token needs two permissions more than sharing a server did:
//   Account  Workers: Admin                  making a Worker takes Admin since
//                                            Cloudflare's granular Workers roles
//                                            (2026-09); the legacy Workers
//                                            Scripts: Edit does the same
//   Zone     Workers Routes: Edit            on the zone, for the custom domain
// The hub answers at https://<hubHost> through a Workers custom domain, and its
// workers.dev address is turned off: nothing reaches it except through Access.
//
// A multipart upload does not fit cloudflare-api.mjs's JSON client, so this file
// has its own small one, with the same rule: no error ever carries the token.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLOUDFLARE_API_BASE, CloudflareApiError } from "./cloudflare-api.mjs";
import { sourceServerDir } from "./server-manager.mjs";

export const HUB_SCRIPT = "team-memory-hub";
export const HUB_CLASS = "TeamHub";
export const HUB_BINDING = "HUB";
// The newest runtime behaviour this code was written against.
export const HUB_COMPATIBILITY_DATE = "2026-09-01";
export const HUB_IMPORT = "../../scripts/cloudflare-api.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_PERMISSION = " (the API token needs Account / Workers / Admin, and Zone / Workers Routes / Edit on the zone)";

/** The two modules of the hub as they are uploaded: the hub, its import pointed at its neighbour. */
export async function hubModules({ serverSource = sourceServerDir(), scriptsDir = HERE } = {}) {
  const hub = await fsp.readFile(path.join(serverSource, "hub", "hub.mjs"), "utf8");
  const quoted = `"${HUB_IMPORT}"`;
  if (hub.split(quoted).length !== 2) throw new Error(`hub.mjs must import ${HUB_IMPORT} exactly once`);
  return [
    { name: "hub.mjs", content: hub.replace(quoted, "\"./cloudflare-api.mjs\"") },
    { name: "cloudflare-api.mjs", content: await fsp.readFile(path.join(scriptsDir, "cloudflare-api.mjs"), "utf8") },
  ];
}

/** A client for the Workers API calls the hub needs, bound to one token. */
export function workersClient({ token, baseUrl = CLOUDFLARE_API_BASE, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const apiToken = String(token || "").trim();
  if (!apiToken) throw new CloudflareApiError("No Cloudflare API token was given");
  const base = String(baseUrl).replace(/\/+$/, "");
  const redact = (text) => String(text ?? "").split(apiToken).join("[redacted]");

  async function request(method, apiPath, { json, form } = {}) {
    const headers = { Authorization: `Bearer ${apiToken}`, Accept: "application/json" };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    let response;
    try {
      response = await fetchImpl(`${base}${apiPath}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new CloudflareApiError(redact(`Cloudflare could not be reached for ${method} ${apiPath}: ${error?.cause?.code || error?.name || "network error"}`), { method, path: apiPath });
    }
    const text = await response.text().catch(() => "");
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok || !payload || payload.success === false) {
      const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
      const detail = first ? `${first.code ? `${first.code} ` : ""}${String(first.message || "").slice(0, 300)}`.trim() : payload ? "" : "the answer was not JSON";
      const refused = response.status === 401 || response.status === 403 || first?.code === 10000;
      throw new CloudflareApiError(
        redact(`Cloudflare ${method} ${apiPath} failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}${refused ? WORKERS_PERMISSION : ""}`),
        { status: response.status, code: first?.code ?? null, method, path: apiPath },
      );
    }
    return payload.result;
  }
  return { request };
}

/** The upload's metadata: the module to run, the bindings, and the migration a first upload needs. */
export function hubMetadata({ team, token, first }) {
  return {
    main_module: "hub.mjs",
    compatibility_date: HUB_COMPATIBILITY_DATE,
    bindings: [
      { type: "durable_object_namespace", name: HUB_BINDING, class_name: HUB_CLASS },
      { type: "plain_text", name: "TEAM", text: JSON.stringify(team) },
      { type: "secret_text", name: "CF_API_TOKEN", text: token },
    ],
    ...(first ? { migrations: { new_tag: "v1", new_sqlite_classes: [HUB_CLASS] } } : {}),
  };
}

async function scriptExists(client, accountId, scriptName) {
  try {
    await client.request("GET", `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/settings`);
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Uploads the hub (made, or replaced with the same Durable Object), turns its
 * workers.dev address off and serves it at `hubHost`. The Durable Object's state
 * survives a new upload; only the code and the bindings change.
 */
export async function deployHub(client, { accountId, zoneId, hubHost, team, token, modules, scriptName = HUB_SCRIPT }) {
  const account = encodeURIComponent(accountId);
  const script = encodeURIComponent(scriptName);
  const first = !(await scriptExists(client, accountId, scriptName));
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(hubMetadata({ team, token, first }))], { type: "application/json" }), "metadata.json");
  for (const module of modules) {
    form.append(module.name, new Blob([module.content], { type: "application/javascript+module" }), module.name);
  }
  await client.request("PUT", `/accounts/${account}/workers/scripts/${script}`, { form });
  await client.request("POST", `/accounts/${account}/workers/scripts/${script}/subdomain`, { json: { enabled: false, previews_enabled: false } });
  const domain = await client.request("PUT", `/accounts/${account}/workers/domains`, {
    json: { hostname: hubHost, service: scriptName, zone_id: zoneId, environment: "production" },
  });
  return { script: scriptName, created: first, domainId: domain?.id || null };
}

/** Takes the hub down: its custom domain, then the script and its Durable Object. */
export async function removeHub(client, { accountId, hubHost, scriptName = HUB_SCRIPT }) {
  const account = encodeURIComponent(accountId);
  const domains = await client.request("GET", `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(hubHost)}`).catch(() => []);
  for (const domain of Array.isArray(domains) ? domains : []) {
    if (domain?.hostname === hubHost && domain?.id) await client.request("DELETE", `/accounts/${account}/workers/domains/${encodeURIComponent(domain.id)}`);
  }
  try {
    await client.request("DELETE", `/accounts/${account}/workers/scripts/${encodeURIComponent(scriptName)}?force=true`);
    return { removed: true };
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return { removed: false };
    throw error;
  }
}
