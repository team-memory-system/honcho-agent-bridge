// The Cloudflare client and its ensure helpers against a local fake of the API: every
// request carries the bearer token, the bodies are what Cloudflare documents, a
// second run changes nothing, and no error carries a token.
import assert from "node:assert/strict";
import test from "node:test";

import {
  appMatches,
  bypassAppBody,
  BYPASS_POLICY_NAME,
  chooseGoogleIdp,
  CloudflareApiError,
  cloudflareClient,
  ensureAccessApp,
  ensureBypassPolicy,
  ensureEveryonePolicy,
  ensurePeoplePolicy,
  ensureServerHost,
  ensureServersApp,
  ensureTunnelCname,
  EVERYONE_POLICY_NAME,
  findZone,
  accessTeamDomain,
  HUB_APP_NAME,
  hubAppBody,
  hubGuardAppBody,
  listIdentityProviders,
  peopleAppBody,
  PEOPLE_POLICY_NAME,
  removeLegacyHostApps,
  removeServerHost,
  SERVERS_APP_NAME,
  serversAppBody,
} from "../scripts/cloudflare-api.mjs";
import { ACCOUNT_ID, API_TOKEN, startFakeCloudflare, TEAM_DOMAIN, ZONE, ZONE_ID } from "./fake-cloudflare.mjs";

async function fake(t, options) {
  const server = await startFakeCloudflare(options);
  t.after(() => server.close());
  const client = cloudflareClient({ token: API_TOKEN, baseUrl: server.baseUrl });
  return { server, client };
}

test("every request carries the bearer token, and the zone, team domain and Google login are found", async (t) => {
  const { server, client } = await fake(t);
  assert.deepEqual(await findZone(client, ZONE), { id: ZONE_ID, name: ZONE, accountId: ACCOUNT_ID });
  assert.equal(await accessTeamDomain(client, ACCOUNT_ID), TEAM_DOMAIN);
  const idp = chooseGoogleIdp(await listIdentityProviders(client, ACCOUNT_ID));
  assert.equal(idp.id, "idp-google-0001");
  assert.ok(server.requests.length >= 3);
  for (const request of server.requests) assert.equal(request.authorization, `Bearer ${API_TOKEN}`);
  assert.deepEqual(server.requests[0].query, { name: ZONE, page: "1", per_page: "50" });

  await assert.rejects(findZone(client, "other.example.com"), /cannot see a zone named other\.example\.com/);
});

test("several Google logins need --idp; none is a clear error", () => {
  const providers = [
    { id: "g1", name: "Google", type: "google" },
    { id: "g2", name: "Workspace", type: "google-apps" },
    { id: "o1", name: "PIN", type: "onetimepin" },
  ];
  assert.throws(() => chooseGoogleIdp(providers), /2 Google logins; choose one with --idp/);
  assert.equal(chooseGoogleIdp(providers, "workspace").id, "g2");
  assert.equal(chooseGoogleIdp(providers, "g1").id, "g1");
  assert.throws(() => chooseGoogleIdp(providers, "o1"), /No Google login named o1/);
  assert.throws(() => chooseGoogleIdp([providers[2]]), /no Google login yet/);
});

test("the people policy is one reusable allow list of emails, edited in place", async (t) => {
  const { server, client } = await fake(t);
  const first = await ensurePeoplePolicy(client, ACCOUNT_ID, { add: ["Owner@Example.com"] });
  assert.equal(first.created, true);
  const created = server.requests.find((item) => item.method === "POST");
  assert.equal(created.path, `/accounts/${ACCOUNT_ID}/access/policies`);
  assert.deepEqual(created.body, { name: PEOPLE_POLICY_NAME, decision: "allow", include: [{ email: { email: "owner@example.com" } }] });

  const before = server.writes().length;
  const again = await ensurePeoplePolicy(client, ACCOUNT_ID, { add: ["owner@example.com"] });
  assert.equal(again.updated, false);
  assert.equal(again.id, first.id);
  assert.equal(server.writes().length, before, "nothing written when the email is already there");

  // A rule the owner added by hand stays.
  server.state.policies[0].include.push({ group: { id: "group-1" } });
  const added = await ensurePeoplePolicy(client, ACCOUNT_ID, { id: first.id, add: ["mate@example.com"] });
  assert.equal(added.updated, true);
  assert.deepEqual(added.emails, ["owner@example.com", "mate@example.com"]);
  const put = server.requests.at(-1);
  assert.equal(put.method, "PUT");
  assert.equal(put.path, `/accounts/${ACCOUNT_ID}/access/policies/${first.id}`);
  assert.deepEqual(put.body.include, [{ group: { id: "group-1" } }, { email: { email: "owner@example.com" } }, { email: { email: "mate@example.com" } }]);

  const removed = await ensurePeoplePolicy(client, ACCOUNT_ID, { id: first.id, remove: ["mate@example.com"] });
  assert.deepEqual(removed.emails, ["owner@example.com"]);
  assert.equal(server.state.policies.length, 1, "always the one policy");

  const bypass = await ensureBypassPolicy(client, ACCOUNT_ID);
  assert.equal(bypass.created, true);
  assert.deepEqual(server.requests.at(-1).body, { name: BYPASS_POLICY_NAME, decision: "bypass", include: [{ everyone: {} }] });
  assert.equal((await ensureBypassPolicy(client, ACCOUNT_ID)).created, false);
});

test("a server's tunnel, ingress, hostname and Access apps are made once and kept on a second run", async (t) => {
  const { server, client } = await fake(t);
  const people = await ensurePeoplePolicy(client, ACCOUNT_ID, { add: ["owner@example.com"] });
  const bypass = await ensureBypassPolicy(client, ACCOUNT_ID);
  const args = {
    accountId: ACCOUNT_ID,
    zoneId: ZONE_ID,
    host: "memory.example.com",
    tunnelName: "team-memory-memory",
    idpId: "idp-google-0001",
    peoplePolicyId: people.id,
    bypassPolicyId: bypass.id,
  };
  const start = server.requests.length;
  const first = await ensureServerHost(client, args);
  const calls = server.requests.slice(start);
  assert.deepEqual(first.changes, { tunnel: "created", ingress: "updated", dns: "created", peopleApp: "created", bypassApp: "created" });
  assert.match(first.aud, /^[0-9a-f]{64}$/);
  assert.equal(first.tunnelToken, server.state.tunnelTokens[first.tunnelId]);

  const body = (method, suffix) => calls.find((item) => item.method === method && item.path.endsWith(suffix))?.body;
  assert.deepEqual(body("POST", "/cfd_tunnel"), { name: "team-memory-memory", config_src: "cloudflare" });
  assert.deepEqual(calls.find((item) => item.method === "GET" && item.path.endsWith("/cfd_tunnel")).query.is_deleted, "false");
  assert.deepEqual(body("PUT", "/configurations"), {
    config: { ingress: [{ hostname: "memory.example.com", service: "http://gate:8010" }, { service: "http_status:404" }] },
  });
  assert.deepEqual(body("POST", "/dns_records"), {
    type: "CNAME", name: "memory.example.com", content: `${first.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment: "Team Memory",
  });
  const apps = calls.filter((item) => item.method === "POST" && item.path.endsWith("/access/apps")).map((item) => item.body);
  assert.deepEqual(apps[0], {
    name: "Team Memory memory.example.com",
    type: "self_hosted",
    domain: "memory.example.com",
    destinations: [{ type: "public", uri: "memory.example.com" }],
    allowed_idps: ["idp-google-0001"],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    policies: [{ id: people.id, precedence: 1 }],
    oauth_configuration: {
      enabled: true,
      dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true },
      grant: { session_duration: "336h" },
    },
  });
  assert.deepEqual(apps[1], {
    name: "Team Memory memory.example.com gate token",
    type: "self_hosted",
    domain: "memory.example.com/v3",
    destinations: [{ type: "public", uri: "memory.example.com/v3" }, { type: "public", uri: "memory.example.com/health" }],
    policies: [{ id: bypass.id, precedence: 1 }],
  });
  for (const call of calls) assert.equal(call.authorization, `Bearer ${API_TOKEN}`);

  const writes = server.writes().length;
  const second = await ensureServerHost(client, args);
  assert.equal(server.writes().length, writes, "a second run only reads");
  assert.deepEqual(second.changes, { tunnel: "kept", ingress: "kept", dns: "kept", peopleApp: "kept", bypassApp: "kept" });
  assert.equal(second.aud, first.aud);
  assert.equal(second.tunnelId, first.tunnelId);

  // What drifted is put back, and only that.
  server.state.apps[0].session_duration = "1h";
  server.state.configurations[first.tunnelId].ingress[0].service = "http://localhost:8010";
  const third = await ensureServerHost(client, args);
  assert.deepEqual(third.changes, { tunnel: "kept", ingress: "updated", dns: "kept", peopleApp: "updated", bypassApp: "kept" });
  assert.equal(server.state.apps[0].session_duration, "24h");
  assert.equal(server.state.apps.length, 2);
  assert.equal(server.state.tunnels.length, 1);
  assert.equal(server.state.records.length, 1);

  const removed = await removeServerHost(client, { accountId: ACCOUNT_ID, zoneId: ZONE_ID, host: "memory.example.com", tunnelName: "team-memory-memory" });
  assert.deepEqual(removed, { peopleApp: true, bypassApp: true, dnsRecords: 1, tunnel: true });
  assert.equal(server.state.apps.length, 0);
  assert.equal(server.state.records.length, 0);
  assert.ok(server.state.tunnels[0].deleted_at);
  const order = server.writes().slice(-5);
  assert.deepEqual(order.slice(-2), [`DELETE /accounts/${ACCOUNT_ID}/cfd_tunnel/${first.tunnelId}/connections`, `DELETE /accounts/${ACCOUNT_ID}/cfd_tunnel/${first.tunnelId}`]);
  assert.deepEqual(await removeServerHost(client, { accountId: ACCOUNT_ID, zoneId: ZONE_ID, host: "memory.example.com", tunnelName: "team-memory-memory" }),
    { peopleApp: false, bypassApp: false, dnsRecords: 0, tunnel: false }, "removing twice is not an error");
});

test("a hostname the owner already uses for something else is left alone", async (t) => {
  const { server, client } = await fake(t);
  server.state.records.push({ id: "r1", type: "A", name: "memory.example.com", content: "192.0.2.1", proxied: false });
  await assert.rejects(ensureTunnelCname(client, ZONE_ID, "memory.example.com", "t1"), /already has a record of type A/);
  server.state.records = [{ id: "r2", type: "CNAME", name: "memory.example.com", content: "site.example.net", proxied: true }];
  await assert.rejects(ensureTunnelCname(client, ZONE_ID, "memory.example.com", "t1"), /already points at site\.example\.net/);
  server.state.records = [{ id: "r3", type: "CNAME", name: "memory.example.com", content: "old.cfargotunnel.com", proxied: true }];
  const moved = await ensureTunnelCname(client, ZONE_ID, "memory.example.com", "t1");
  assert.deepEqual(moved, { id: "r3", created: false, updated: true });
  assert.deepEqual(server.requests.at(-1).body, { content: "t1.cfargotunnel.com", proxied: true });
});

test("API and HTTP failures say what failed and which permission, never the token", async (t) => {
  const { server } = await fake(t);
  const wrong = cloudflareClient({ token: `${API_TOKEN}-wrong`, baseUrl: server.baseUrl });
  await assert.rejects(findZone(wrong, ZONE), (error) => {
    assert.ok(error instanceof CloudflareApiError);
    assert.equal(error.status, 403);
    assert.match(error.message, /HTTP 403: 10000 Authentication error \(the API token needs Zone \/ Zone \/ Read\)/);
    assert.equal(error.message.includes(API_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(API_TOKEN), false);
    return true;
  });

  const client = cloudflareClient({ token: API_TOKEN, baseUrl: server.baseUrl });
  await assert.rejects(client.get(`/accounts/${ACCOUNT_ID}/cfd_tunnel/missing/token`), /HTTP 404: 1003 Tunnel not found/);

  const unreachable = cloudflareClient({ token: API_TOKEN, baseUrl: "http://127.0.0.1:9/client/v4", timeoutMs: 2_000 });
  await assert.rejects(unreachable.get("/zones"), (error) => {
    assert.match(error.message, /could not be reached/);
    assert.equal(error.message.includes(API_TOKEN), false);
    return true;
  });

  const echo = cloudflareClient({
    token: API_TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: `Invalid access token ${API_TOKEN}` }] }), { status: 400 }),
  });
  await assert.rejects(echo.get("/zones"), (error) => {
    assert.equal(error.message.includes(API_TOKEN), false, "even a token Cloudflare echoes back is cut out");
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
  const notJson = cloudflareClient({ token: API_TOKEN, fetchImpl: async () => new Response("<html>", { status: 502 }) });
  await assert.rejects(notJson.get("/zones"), /HTTP 502: the answer was not JSON/);
  assert.throws(() => cloudflareClient({ token: " " }), /No Cloudflare API token/);
});

test("an app matches only when every field the app sets is already so", () => {
  const desired = peopleAppBody({ host: "memory.example.com", idpId: "idp-1", policyId: "p1" });
  const existing = { ...structuredClone(desired), id: "a1", aud: "x", policies: [{ id: "p1", precedence: 1, name: "Team Memory people", decision: "allow" }], oauth_configuration: { ...desired.oauth_configuration, extra: true } };
  assert.equal(appMatches(existing, desired), true);
  assert.equal(appMatches({ ...existing, allowed_idps: ["idp-2"] }, desired), false);
  assert.equal(appMatches({ ...existing, oauth_configuration: { enabled: true } }, desired), false);
  assert.equal(appMatches({ ...existing, policies: [] }, desired), false);
  const gate = bypassAppBody({ host: "memory.example.com", policyId: "b1" });
  assert.equal(appMatches({ ...gate, destinations: [...gate.destinations].reverse() }, gate), true, "destination order does not matter");
});

// ------------------------------------------------------------- the team hub

const MANAGED_OAUTH_YEAR = {
  enabled: true,
  dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true },
  grant: { session_duration: "8760h" },
};

test("the servers app holds every server host of the team in one app, made once and changed in place", async (t) => {
  const { server, client } = await fake(t);
  const people = await ensurePeoplePolicy(client, ACCOUNT_ID, { add: ["owner@example.com"] });
  const args = { idpId: "idp-google-0001", policyId: people.id };

  const first = await ensureServersApp(client, ACCOUNT_ID, { ...args, hosts: ["Memory.example.com"] });
  assert.equal(first.created, true);
  assert.match(first.aud, /^[0-9a-f]{64}$/);
  assert.deepEqual(server.requests.find((item) => item.method === "POST" && item.path.endsWith("/access/apps")).body, {
    name: SERVERS_APP_NAME,
    type: "self_hosted",
    domain: "memory.example.com",
    destinations: [{ type: "public", uri: "memory.example.com" }],
    allowed_idps: ["idp-google-0001"],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    policies: [{ id: people.id, precedence: 1 }],
    oauth_configuration: MANAGED_OAUTH_YEAR,
  });

  const writes = server.writes().length;
  const same = await ensureServersApp(client, ACCOUNT_ID, { ...args, hosts: ["memory.example.com"], known: { id: first.id, aud: first.aud } });
  assert.deepEqual(same, { id: first.id, aud: first.aud, created: false, updated: false });
  assert.equal(server.writes().length, writes, "nothing written when the hosts are already there");

  const hosts = ["memory.example.com", "memory-bob.example.com", "memory-bob.example.com"];
  const extended = await ensureServersApp(client, ACCOUNT_ID, { ...args, hosts, known: { id: first.id } });
  assert.deepEqual(extended, { id: first.id, aud: first.aud, created: false, updated: true });
  assert.equal(server.state.apps.length, 1);
  assert.deepEqual(server.state.apps[0].destinations, [{ type: "public", uri: "memory.example.com" }, { type: "public", uri: "memory-bob.example.com" }]);
  assert.equal(server.requests.at(-1).method, "PUT");

  await assert.rejects(ensureServersApp(client, ACCOUNT_ID, { ...args, hosts: [] }), /holds 1 to 50 hosts, not 0/);
  const many = Array.from({ length: 51 }, (_, index) => `memory-${index}.example.com`);
  await assert.rejects(ensureServersApp(client, ACCOUNT_ID, { ...args, hosts: many }), /holds 1 to 50 hosts, not 51/);
  assert.deepEqual(serversAppBody({ hosts: many.slice(0, 2), ...args }).destinations.map((item) => item.uri), many.slice(0, 2));
});

test("a host's apps from the first sharing go by their exact names, never by domain", async (t) => {
  const { server, client } = await fake(t);
  server.state.apps.push(
    { id: "a-people", aud: "1", name: "Team Memory memory-bob.example.com", domain: "memory-bob.example.com" },
    { id: "a-gate", aud: "2", name: "Team Memory memory-bob.example.com gate token", domain: "memory-bob.example.com/v3" },
    { id: "a-servers", aud: "3", name: SERVERS_APP_NAME, domain: "memory-bob.example.com" },
    { id: "a-other", aud: "4", name: "Team Memory memory-carol.example.com", domain: "memory-carol.example.com" },
  );
  assert.deepEqual(await removeLegacyHostApps(client, ACCOUNT_ID, "memory-bob.example.com"), { peopleApp: true, bypassApp: true });
  assert.deepEqual(server.state.apps.map((app) => app.id), ["a-servers", "a-other"]);
  assert.deepEqual(await removeLegacyHostApps(client, ACCOUNT_ID, "memory-bob.example.com"), { peopleApp: false, bypassApp: false }, "removing twice is not an error");
});

test("the everyone policy lets anyone with a login in, keeps the owner's own rules, and never opens another policy", async (t) => {
  const { server, client } = await fake(t);
  const people = await ensurePeoplePolicy(client, ACCOUNT_ID, { add: ["owner@example.com"] });
  const first = await ensureEveryonePolicy(client, ACCOUNT_ID);
  assert.equal(first.created, true);
  assert.deepEqual(server.requests.at(-1).body, { name: EVERYONE_POLICY_NAME, decision: "allow", include: [{ everyone: {} }] });
  const writes = server.writes().length;
  assert.deepEqual(await ensureEveryonePolicy(client, ACCOUNT_ID, { id: first.id }), { id: first.id, created: false, updated: false });
  assert.equal(server.writes().length, writes);

  // Another policy's id is not taken: the people policy stays an email list.
  assert.equal((await ensureEveryonePolicy(client, ACCOUNT_ID, { id: people.id })).id, first.id);
  assert.deepEqual(server.state.policies.find((item) => item.id === people.id).include, [{ email: { email: "owner@example.com" } }]);

  // Changed by hand: the include is put back, an exclude the owner added stays.
  const policy = server.state.policies.find((item) => item.id === first.id);
  policy.include = [{ email: { email: "someone@example.com" } }];
  policy.exclude = [{ email: { email: "blocked@example.com" } }];
  assert.deepEqual(await ensureEveryonePolicy(client, ACCOUNT_ID, { id: first.id }), { id: first.id, created: false, updated: true });
  assert.deepEqual(server.requests.at(-1).body, {
    name: EVERYONE_POLICY_NAME, decision: "allow", include: [{ everyone: {} }], exclude: [{ email: { email: "blocked@example.com" } }],
  });
});

test("the hub app is the hub's host behind the everyone policy, with Google login and a year of Managed OAuth", async (t) => {
  const desired = hubAppBody({ host: "team.example.com", idpId: "idp-google-0001", policyId: "policy-everyone" });
  assert.deepEqual(desired, {
    name: `${HUB_APP_NAME} team.example.com`,
    type: "self_hosted",
    domain: "team.example.com",
    destinations: [{ type: "public", uri: "team.example.com" }],
    allowed_idps: ["idp-google-0001"],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    policies: [{ id: "policy-everyone", precedence: 1 }],
    oauth_configuration: MANAGED_OAUTH_YEAR,
  });
  assert.equal(desired.name, "Team Memory hub team.example.com");
  const { server, client } = await fake(t);
  const made = await ensureAccessApp(client, ACCOUNT_ID, desired);
  assert.equal(made.created, true);
  const writes = server.writes().length;
  assert.equal((await ensureAccessApp(client, ACCOUNT_ID, desired, { id: made.id })).updated, false, "a second run changes nothing");
  assert.equal(server.writes().length, writes);
});

test("the hub's guard app is <host>/guard alone, behind the bypass policy, beside the hub app", async (t) => {
  const desired = hubGuardAppBody({ host: "team.example.com", policyId: "policy-bypass" });
  assert.deepEqual(desired, {
    name: `${HUB_APP_NAME} team.example.com guard`,
    type: "self_hosted",
    domain: "team.example.com/guard",
    destinations: [{ type: "public", uri: "team.example.com/guard" }],
    policies: [{ id: "policy-bypass", precedence: 1 }],
  });
  const { server, client } = await fake(t);
  const bypass = await ensureBypassPolicy(client, ACCOUNT_ID);
  const everyone = await ensureEveryonePolicy(client, ACCOUNT_ID);
  const hub = await ensureAccessApp(client, ACCOUNT_ID, hubAppBody({ host: "team.example.com", idpId: "idp-google-0001", policyId: everyone.id }));
  const guard = await ensureAccessApp(client, ACCOUNT_ID, hubGuardAppBody({ host: "team.example.com", policyId: bypass.id }));
  assert.equal(guard.created, true, "the hub app on the same host is not taken for it");
  assert.notEqual(guard.id, hub.id);
  assert.equal(server.state.apps.length, 2);
  const writes = server.writes().length;
  assert.equal((await ensureAccessApp(client, ACCOUNT_ID, hubGuardAppBody({ host: "team.example.com", policyId: bypass.id }), { id: guard.id })).updated, false);
  assert.equal((await ensureAccessApp(client, ACCOUNT_ID, hubAppBody({ host: "team.example.com", idpId: "idp-google-0001", policyId: everyone.id }))).id, hub.id, "nor the guard app for the hub app");
  assert.equal(server.writes().length, writes);
});
