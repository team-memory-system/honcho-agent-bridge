// A stand-in for the Cloudflare API v4 calls sharing makes: zones, the Access
// organization, identity providers, reusable policies, Access apps, tunnels and DNS
// records, kept in memory behind a local HTTP server. Every request is recorded with
// its bearer token and body, so tests can check what was sent. Nothing reaches the
// network.
import crypto from "node:crypto";
import http from "node:http";

export const API_TOKEN = "fake-cloudflare-api-token-0123456789abcdef";
export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const ZONE_ID = "fedcba9876543210fedcba9876543210";
export const ZONE = "example.com";
export const TEAM_DOMAIN = "example-team.cloudflareaccess.com";

function id() {
  return crypto.randomUUID();
}

function hex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** A connector token shaped like Cloudflare's: base64 JSON {a, t, s}. */
export function connectorToken(tunnelId) {
  return Buffer.from(JSON.stringify({ a: ACCOUNT_ID, t: tunnelId, s: crypto.randomBytes(32).toString("base64") })).toString("base64");
}

export async function startFakeCloudflare({ token = API_TOKEN, idps = null, zones = null } = {}) {
  const state = {
    zones: zones || [{ id: ZONE_ID, name: ZONE, account: { id: ACCOUNT_ID } }],
    organization: { auth_domain: TEAM_DOMAIN, name: "Example team" },
    idps: idps || [
      { id: "idp-otp-0001", name: "One-time PIN", type: "onetimepin" },
      { id: "idp-google-0001", name: "Google", type: "google" },
    ],
    policies: [],
    apps: [],
    tunnels: [],
    tunnelTokens: {},
    configurations: {},
    connections: {},
    records: [],
  };
  const requests = [];

  function send(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
  }

  function ok(response, result, info) {
    send(response, 200, { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
  }

  function fail(response, status, code, message) {
    send(response, status, { success: false, errors: [{ code, message }], messages: [], result: null });
  }

  function page(response, items, query) {
    const perPage = Number(query.get("per_page") || 20);
    const number = Number(query.get("page") || 1);
    const slice = items.slice((number - 1) * perPage, number * perPage);
    ok(response, slice, { page: number, per_page: perPage, count: slice.length, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / perPage)) });
  }

  function handle(method, segments, query, body, response) {
    const [root, accountOrZone, ...rest] = segments;
    if (root === "zones" && !accountOrZone && method === "GET") {
      const name = query.get("name");
      return page(response, state.zones.filter((zone) => !name || zone.name === name), query);
    }
    if (root === "zones" && rest[0] === "dns_records") {
      if (accountOrZone !== ZONE_ID) return fail(response, 404, 7003, "Could not route to /zones/x, perhaps your object identifier is invalid?");
      const recordId = rest[1];
      if (!recordId && method === "GET") {
        const exact = query.get("name.exact");
        return page(response, state.records.filter((record) => !exact || record.name === exact), query);
      }
      if (!recordId && method === "POST") {
        const record = { id: hex(16), ...body };
        state.records.push(record);
        return ok(response, record);
      }
      const record = state.records.find((item) => item.id === recordId);
      if (!record) return fail(response, 404, 81044, "Record does not exist.");
      if (method === "PATCH") { Object.assign(record, body); return ok(response, record); }
      if (method === "DELETE") { state.records = state.records.filter((item) => item !== record); return ok(response, { id: record.id }); }
    }
    if (root !== "accounts" || accountOrZone !== ACCOUNT_ID) return fail(response, 404, 7003, "No route for that URI");
    const [kind, sub, itemId, extra] = rest;
    if (kind === "access" && sub === "organizations" && method === "GET") return ok(response, state.organization);
    if (kind === "access" && sub === "identity_providers" && method === "GET") return page(response, state.idps, query);
    if (kind === "access" && sub === "policies") {
      if (!itemId && method === "GET") return page(response, state.policies, query);
      if (!itemId && method === "POST") {
        const policy = { id: id(), reusable: true, ...body };
        state.policies.push(policy);
        return ok(response, policy);
      }
      const policy = state.policies.find((item) => item.id === itemId);
      if (!policy) return fail(response, 404, 12130, "access.api.error.policy_not_found");
      if (method === "GET") return ok(response, policy);
      if (method === "PUT") {
        for (const key of Object.keys(policy)) if (!["id", "reusable"].includes(key)) delete policy[key];
        Object.assign(policy, body);
        return ok(response, policy);
      }
    }
    if (kind === "access" && sub === "apps") {
      // Cloudflare answers with each policy in full; the fake gives id and precedence.
      const view = (app) => ({ ...app, policies: (app.policies || []).map((item) => ({ ...state.policies.find((policy) => policy.id === item.id), id: item.id, precedence: item.precedence })) });
      if (!itemId && method === "GET") return page(response, state.apps.map(view), query);
      if (!itemId && method === "POST") {
        const app = { id: id(), aud: hex(32), ...body };
        state.apps.push(app);
        return ok(response, view(app));
      }
      const app = state.apps.find((item) => item.id === itemId);
      if (!app) return fail(response, 404, 12130, "access.api.error.app_not_found");
      if (method === "GET") return ok(response, view(app));
      if (method === "PUT") {
        for (const key of Object.keys(app)) if (!["id", "aud"].includes(key)) delete app[key];
        Object.assign(app, body);
        return ok(response, view(app));
      }
      if (method === "DELETE") { state.apps = state.apps.filter((item) => item !== app); return ok(response, { id: app.id }); }
    }
    if (kind === "cfd_tunnel") {
      const tunnelId = sub;
      if (!tunnelId && method === "GET") {
        const name = query.get("name");
        const deleted = query.get("is_deleted");
        return page(response, state.tunnels.filter((item) => (!name || item.name === name) && (deleted !== "false" || !item.deleted_at)), query);
      }
      if (!tunnelId && method === "POST") {
        if (state.tunnels.some((item) => item.name === body.name && !item.deleted_at)) return fail(response, 409, 1013, "You already have a tunnel with this name");
        const tunnel = { id: id(), name: body.name, config_src: body.config_src || "local", created_at: new Date().toISOString(), deleted_at: null };
        state.tunnels.push(tunnel);
        state.tunnelTokens[tunnel.id] = connectorToken(tunnel.id);
        return ok(response, tunnel);
      }
      const tunnel = state.tunnels.find((item) => item.id === tunnelId && !item.deleted_at);
      if (!tunnel) return fail(response, 404, 1003, "Tunnel not found");
      if (itemId === "token" && method === "GET") return ok(response, state.tunnelTokens[tunnel.id]);
      if (itemId === "configurations" && method === "GET") {
        return ok(response, { tunnel_id: tunnel.id, version: 0, config: state.configurations[tunnel.id] || null, source: "cloudflare" });
      }
      if (itemId === "configurations" && method === "PUT") {
        state.configurations[tunnel.id] = body.config;
        return ok(response, { tunnel_id: tunnel.id, version: 1, config: body.config, source: "cloudflare" });
      }
      if (itemId === "connections" && method === "DELETE") { state.connections[tunnel.id] = 0; return ok(response, null); }
      if (!itemId && method === "DELETE") {
        if (state.connections[tunnel.id]) return fail(response, 400, 1022, "Cannot delete tunnel with active connections");
        tunnel.deleted_at = new Date().toISOString();
        return ok(response, tunnel);
      }
    }
    void extra;
    return fail(response, 404, 7003, "No route for that URI");
  }

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://fake");
    const segments = url.pathname.replace(/^\/client\/v4\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    requests.push({
      method: request.method,
      path: `/${segments.join("/")}`,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.authorization || "",
    });
    if (request.headers.authorization !== `Bearer ${token}`) return fail(response, 403, 10000, "Authentication error");
    try { handle(request.method, segments, url.searchParams, body, response); }
    catch (error) { fail(response, 500, 500, String(error?.message || error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/client/v4`;
  return {
    baseUrl,
    state,
    requests,
    /** Requests that changed something, as "METHOD /path". */
    writes() {
      return requests.filter((item) => item.method !== "GET").map((item) => `${item.method} ${item.path}`);
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
