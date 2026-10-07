// The whole team, end to end, with Cloudflare and Honcho stood in for: the hub
// Worker (server/hub/hub.mjs) behind a stand-in for Access's Managed OAuth
// (fake-team.mjs), each member's gate (server/gate/gate.mjs) spawned with its own
// folder, and this app's side (team-auth.mjs, team-hub.mjs, gate-access.mjs) as the
// app runs it. What matters: one Google login per application and no token anyone
// copies; the owner's other computer writes through its own device key; a teammate
// asks before anything opens, writes only their own sessions into the company
// server, and asks only the projects opened to them; one computer is cut off on its
// own; and leaving the team ends it all.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { cloudflareClient, ensurePeoplePolicy } from "../scripts/cloudflare-api.mjs";
import { gateStatePaths, grantChat, grantCollect, revokeDevice, setGateOwners } from "../scripts/gate-access.mjs";
import { finishLogin, registerDevice, startLogin, teamAuthPaths, teamFetch } from "../scripts/team-auth.mjs";
import { hubCall, teamWhoami } from "../scripts/team-hub.mjs";
import hubWorker, { TeamHub } from "../server/hub/hub.mjs";
import { ACCESS_ISSUER, ACCESS_TEAM_DOMAIN, accessKey, signAssertion, startAccessCerts } from "./fake-access.mjs";
import { ACCOUNT_ID, API_TOKEN, startFakeCloudflare, ZONE, ZONE_ID } from "./fake-cloudflare.mjs";
import { fakeTeam } from "./fake-team.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "server", "gate", "gate.mjs");
const HUB_HOST = `team.${ZONE}`;
const HUB_AUD = "aud-hub-0123456789abcdef";
const REDIRECT = "http://127.0.0.1:4180/oauth/callback";
const ME = "me@example.com";
const ALICE = "alice@example.com";

let certs;
let cloudflare;
let honcho;
let mcp;
const honchoSeen = [];
const mcpSeen = [];
const gates = new Map();
const children = [];
const servers = [];
let fake;
let hubEnv;
let tmp;
const signingKey = accessKey("kid-team-flow");
const hosts = { [HUB_HOST]: { app: "hub", handle: (...args) => toHub(...args) } };

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** A Durable Object namespace with one object, its storage a Map. */
function fakeNamespace(env) {
  const store = new Map();
  let queue = Promise.resolve();
  const storage = {
    async get(key) { return structuredClone(store.get(key)); },
    async put(key, value) { store.set(key, structuredClone(value)); },
    async delete(key) { return store.delete(key); },
    async list({ prefix = "" } = {}) {
      return new Map([...store].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, structuredClone(value)]));
    },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile(fn) {
      const run = queue.then(fn);
      queue = run.catch(() => {});
      return run;
    },
  };
  let object = null;
  return {
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: (request) => {
        object ||= new TeamHub(ctx, env);
        return object.fetch(request);
      },
    }),
  };
}

/** The assertion Access hands the origin for a person, for one application. */
function assertion(email, aud) {
  const now = Math.floor(Date.now() / 1000);
  return signAssertion(signingKey, { aud: [aud], email, exp: now + 300, iat: now, nbf: now, iss: ACCESS_ISSUER, type: "app", sub: crypto.randomUUID() });
}

function serversAud() {
  return cloudflare.state.apps.find((app) => app.name === "Team Memory servers")?.aud;
}

/** A gate for one member's server, with its own folder, owned by `owner`. */
async function startGate(host, owner) {
  const stateDir = path.join(tmp, "gates", host);
  await fs.mkdir(stateDir, { recursive: true });
  const paths = { dir: stateDir, accessFile: path.join(stateDir, "access.json"), devicesFile: path.join(stateDir, "devices.json"), lockFile: path.join(stateDir, "access.json.lock") };
  await setGateOwners(paths, { owners: [owner], workspace: "memory" });
  const child = spawn(process.execPath, [GATE], {
    env: {
      PATH: process.env.PATH,
      HONCHO_GATE_LISTEN_HOST: "127.0.0.1",
      HONCHO_GATE_LISTEN_PORT: "0",
      HONCHO_GATE_TOKEN: crypto.randomBytes(16).toString("hex"),
      HONCHO_GATE_UPSTREAM: `http://127.0.0.1:${honcho}`,
      HONCHO_GATE_MCP_UPSTREAM: `http://127.0.0.1:${mcp}`,
      HONCHO_GATE_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN,
      HONCHO_GATE_ACCESS_AUD: serversAud(),
      HONCHO_GATE_ACCESS_CERTS_URL: certs.url,
      HONCHO_TEAM_MCP_TOKEN: "team-mcp-token-0123456789",
      HONCHO_GATE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  if (process.env.TEAM_FLOW_DEBUG) child.stderr.on("data", (chunk) => process.stderr.write(`[gate] ${chunk}`));
  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      try { resolve(JSON.parse(buffered.split("\n")[0]).port); } catch {}
    });
    child.once("exit", (code) => reject(new Error(`gate exited with ${code}`)));
  });
  gates.set(host, { port, paths });
  return paths;
}

/** What Access does in front of a server: the person's assertion added, the request passed to that server's gate. */
async function toGate(request, { email, url }) {
  const gate = gates.get(url.hostname);
  if (!gate) return new Response("no tunnel", { status: 530 });
  const headers = Object.fromEntries([...request.headers].filter(([name]) => name !== "host"));
  headers["cf-access-jwt-assertion"] = assertion(email, serversAud());
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
  const answer = await fetch(`http://127.0.0.1:${gate.port}${url.pathname}${url.search}`, { method: request.method, headers, body });
  return new Response(await answer.arrayBuffer(), { status: answer.status, headers: answer.headers });
}

async function toHub(request, { email }) {
  const headers = new Headers(request.headers);
  headers.set("cf-access-jwt-assertion", assertion(email, HUB_AUD));
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  return hubWorker.fetch(new Request(request.url, { method: request.method, headers, body }), hubEnv);
}

/** The gate looks at access.json again at most once a second. */
const reread = () => new Promise((resolve) => setTimeout(resolve, 1_100));

/** One person's computer: its own team-auth.json. */
async function computer(name) {
  return teamAuthPaths(null, { HONCHO_AGENT_TEAM_AUTH: path.join(tmp, "computers", name, "team-auth.json") });
}

/** A browser login as `email` to the application of `host`. */
async function login(paths, email, host, kind) {
  fake.state.loginAs = email;
  const started = await startLogin({ host, kind, redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
  const back = new URL(fake.browserLogin(started.url));
  await finishLogin({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: back.searchParams.get("error"), paths, fetchImpl: fake.fetch });
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "team-flow-"));
  certs = await startAccessCerts([signingKey]);
  cloudflare = await startFakeCloudflare();
  const client = cloudflareClient({ token: API_TOKEN, baseUrl: cloudflare.baseUrl });
  const people = await ensurePeoplePolicy(client, ACCOUNT_ID, { add: [ME] });
  const honchoServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    honchoSeen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: [], total: 0 }));
  });
  const mcpServer = http.createServer((req, res) => {
    mcpSeen.push({ url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  honcho = await listen(honchoServer);
  mcp = await listen(mcpServer);
  servers.push(honchoServer, mcpServer);
  hubEnv = {
    TEAM: JSON.stringify({
      name: "예시 팀",
      hubHost: HUB_HOST,
      zone: ZONE,
      zoneId: ZONE_ID,
      accountId: ACCOUNT_ID,
      teamDomain: ACCESS_TEAM_DOMAIN,
      idpId: "idp-google-0001",
      peoplePolicyId: people.id,
      hubAud: HUB_AUD,
      admins: [ME],
    }),
    CF_API_TOKEN: API_TOKEN,
    CF_API_BASE: cloudflare.baseUrl,
    ACCESS_CERTS_URL: certs.url,
  };
  hubEnv.HUB = fakeNamespace(hubEnv);
  // A server's host joins once the hub has made it, as its tunnel would.
  fake = fakeTeam({ hosts });
});

after(async () => {
  for (const child of children) child.kill();
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  await certs?.close();
  await cloudflare?.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("a team from its admin's first login to a teammate leaving it", async () => {
  // ── The admin logs in to the hub: on the list, an admin, a peer from the email ──
  const desk = await computer("me-desk");
  await login(desk, ME, HUB_HOST, "hub");
  const me = await teamWhoami({ hub: HUB_HOST, peer: "user_chen", paths: desk, fetchImpl: fake.fetch });
  assert.equal(me.member, true);
  assert.equal(me.admin, true);
  assert.equal(me.peer, "user_chen", "the peer this computer already used is kept");
  assert.equal(me.team.name, "예시 팀");

  // ── The admin's server: the team's company server, made by the hub ──
  const made = await hubCall("POST", "/api/servers", { workspace: "memory", device: "MacBook" }, { paths: desk, fetchImpl: fake.fetch });
  assert.equal(made.server.host, `memory.${ZONE}`);
  assert.equal(made.server.company, true);
  assert.match(made.tunnelToken, /^[A-Za-z0-9+/=]+$/);
  assert.equal(made.aud, serversAud());
  const company = made.server.host;
  hosts[company] = { app: "servers", handle: toGate };
  const companyGate = await startGate(company, ME);

  // ── The admin's other computer: logs in, registers, writes through its own key ──
  const laptop = await computer("me-laptop");
  await login(laptop, ME, HUB_HOST, "hub");
  await teamWhoami({ hub: HUB_HOST, paths: laptop, fetchImpl: fake.fetch });
  await login(laptop, ME, company, "servers");
  const laptopDevice = await registerDevice(company, { name: "laptop", paths: laptop, fetchImpl: fake.fetch });
  const write = await teamFetch(`https://${company}/v3/workspaces/memory/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "claude-1", peers: { user_chen: {} } }),
  }, { paths: laptop, fetchImpl: fake.fetch });
  assert.equal(write.status, 200, await write.clone().text());
  assert.equal(JSON.parse(honchoSeen.at(-1).body).id, "claude-1", "the owner's session goes as it is");

  // ── Alice: not on the list, then added by the admin ──
  const alicePc = await computer("alice");
  await login(alicePc, ALICE, HUB_HOST, "hub");
  const stranger = await teamWhoami({ hub: HUB_HOST, paths: alicePc, fetchImpl: fake.fetch });
  assert.equal(stranger.member, false);
  assert.equal(stranger.email, ALICE);
  await hubCall("POST", "/api/admin/people", { email: ALICE }, { paths: desk, fetchImpl: fake.fetch });
  assert.ok(cloudflare.state.policies.find((policy) => policy.id === JSON.parse(hubEnv.TEAM).peoplePolicyId).include.some((rule) => rule.email?.email === ALICE));
  const alice = await teamWhoami({ hub: HUB_HOST, paths: alicePc, fetchImpl: fake.fetch });
  assert.equal(alice.member, true);
  assert.equal(alice.peer, "alice");

  // Logged in, but nothing is open to her yet.
  await login(alicePc, ALICE, company, "servers");
  await assert.rejects(registerDevice(company, { name: "alice-pc", paths: alicePc, fetchImpl: fake.fetch }), { status: 403 });
  const closed = await teamFetch(`https://${company}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { paths: alicePc, fetchImpl: fake.fetch, device: false });
  assert.equal(closed.status, 403);

  // ── She asks to collect into the company server; the admin approves ──
  const asked = await hubCall("POST", "/api/requests", { kind: "collect", server: company, device: "alice-pc", folders: ["honcho"] }, { paths: alicePc, fetchImpl: fake.fetch });
  const request = asked.request || asked;
  const incoming = await hubCall("GET", "/api/requests", undefined, { paths: desk, fetchImpl: fake.fetch });
  assert.deepEqual(incoming.incoming.map((item) => item.id), [request.id]);
  await grantCollect(companyGate, { email: ALICE, peer: "alice", workspace: "memory" });
  await reread();
  await hubCall("POST", `/api/requests/${request.id}/decide`, { approve: true }, { paths: desk, fetchImpl: fake.fetch });
  const answered = await hubCall("GET", "/api/requests", undefined, { paths: alicePc, fetchImpl: fake.fetch });
  assert.equal(answered.outgoing.find((item) => item.id === request.id).status, "approved");

  // Her computer registers, and her sessions land under her own prefix.
  await registerDevice(company, { name: "alice-pc", paths: alicePc, fetchImpl: fake.fetch });
  const hers = await teamFetch(`https://${company}/v3/workspaces/memory/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "claude-9", peers: { alice: {}, assistant_claude: {} } }),
  }, { paths: alicePc, fetchImpl: fake.fetch });
  assert.equal(hers.status, 200);
  const prefix = `tm-${crypto.createHash("sha256").update(ALICE).digest("hex").slice(0, 12)}_`;
  assert.equal(JSON.parse(honchoSeen.at(-1).body).id, `${prefix}claude-9`);
  // She cannot write as someone else, nor read the server.
  const impostor = await teamFetch(`https://${company}/v3/workspaces/memory/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "x", peers: { user_chen: {} } }),
  }, { paths: alicePc, fetchImpl: fake.fetch });
  assert.equal(impostor.status, 403);
  const reading = await teamFetch(`https://${company}/v3/workspaces/memory/sessions/list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { paths: alicePc, fetchImpl: fake.fetch });
  assert.equal(reading.status, 403);

  // ── She asks for chat; the admin opens one project ──
  const chat = await hubCall("POST", "/api/requests", { kind: "chat", server: company }, { paths: alicePc, fetchImpl: fake.fetch });
  await grantChat(companyGate, { email: ALICE, peer: "alice", projects: [{ id: "p-0123456789ab", name: "honcho" }] });
  await reread();
  await hubCall("POST", `/api/requests/${(chat.request || chat).id}/decide`, { approve: true, projects: ["honcho"] }, { paths: desk, fetchImpl: fake.fetch });
  const asking = await teamFetch(`https://${company}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { paths: alicePc, fetchImpl: fake.fetch, device: false });
  assert.equal(asking.status, 200);
  const seen = mcpSeen.at(-1).headers;
  assert.equal(seen["x-honcho-scope-mode"], "projects");
  assert.deepEqual(JSON.parse(Buffer.from(seen["x-honcho-allowed-scopes"], "base64url").toString("utf8")), [{ id: "p-0123456789ab", name: "honcho" }]);
  assert.equal(seen["cf-access-authenticated-user-email"], ALICE);
  assert.equal(seen.authorization, "Bearer team-mcp-token-0123456789", "the bridge sees the gate's token, never the caller's");

  // ── One computer cut off: the laptop, not the desk's other rights ──
  await revokeDevice(companyGate, { id: laptopDevice.id });
  await reread();
  const cut = await teamFetch(`https://${company}/v3/workspaces/memory/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "claude-2" }),
  }, { paths: laptop, fetchImpl: fake.fetch });
  assert.ok([401, 403].includes(cut.status), `a revoked device is refused (got ${cut.status})`);

  // ── Alice leaves the team: off the list ──
  await hubCall("DELETE", `/api/admin/people/${encodeURIComponent(ALICE)}`, undefined, { paths: desk, fetchImpl: fake.fetch });
  const gone = await teamWhoami({ hub: HUB_HOST, paths: alicePc, fetchImpl: fake.fetch });
  assert.equal(gone.member, false);
  assert.equal(cloudflare.state.policies.find((policy) => policy.id === JSON.parse(hubEnv.TEAM).peoplePolicyId).include.some((rule) => rule.email?.email === ALICE), false);
  assert.ok(gates.get(company).paths, "the company server itself stays");
});
