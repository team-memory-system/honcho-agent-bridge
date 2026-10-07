// The share gate is the only thing the Cloudflare tunnel reaches, so what matters:
// only /health, /v3/*, /mcp and the gate's own /team-memory/* answer at all; the
// gate token opens /health and /v3/* as before and nothing else; anyone else is a
// person with a verified Cloudflare Access login, who may do only what access.json
// says (an owner; chat, with the projects opened to them; collect), and on /v3 only
// from a computer whose device key the gate gave out. What passes arrives upstream
// as it was sent and streams back, except a collector's requests, which are checked
// and rewritten to their own sessions. Neither the API nor the MCP bridge ever sees
// a caller's credentials, and the bridge sees only the gate's scope headers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCESS_AUD,
  ACCESS_ISSUER,
  ACCESS_TEAM_DOMAIN,
  PERSON_EMAIL,
  accessKey,
  personClaims,
  signAssertion,
  startAccessCerts,
} from "./fake-access.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "server", "gate", "gate.mjs");
const COMPOSE = path.join(ROOT, "server", "compose.yaml");
const TOKEN = "gate-test-token-6f1c0a8e";
const TEAM_MCP_TOKEN = "team-mcp-test-token-2d9b7e41";
// The people of access.json: an owner, a teammate who may chat, two who collect
// (into a workspace of their own, and into the server's), and one in no list.
const OWNER_EMAIL = "owner@example.com";
const CHAT_EMAIL = PERSON_EMAIL;
const COLLECT_EMAIL = "collector@example.com";
const HELPER_EMAIL = "helper@example.com";
const STRANGER_EMAIL = "stranger@example.com";
const PROJECTS = [{ id: "p-0123456789ab", name: "honcho" }, { id: "p-abcdef012345", name: "팀 메모리" }];
const prefixOf = (email) => `tm-${crypto.createHash("sha256").update(email).digest("hex").slice(0, 12)}_`;
const COLLECT_PREFIX = prefixOf(COLLECT_EMAIL);
const COLLECT_REFUSED = { error: "forbidden", detail: "This server takes only your own conversations" };

let upstream;
let upstreamPort;
let gate;
let gatePort;
let gateState;
const seen = [];
let releaseStream = () => {};
let mcpUpstream;
let mcpPort;
const mcpSeen = [];
let releaseMcpStream = () => {};
let certs;
const gates = [];
const stateDirs = [];
// Made once: RSA key generation is the slow part of these tests.
const signingKey = accessKey("kid-current");
const rotatedKey = accessKey("kid-rotated");
const strangerKey = accessKey("kid-current");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** access.json as the owner's app writes it, with `overrides` on top. */
function accessFile(overrides = {}) {
  return {
    version: 1,
    // Not in the case Access signs it: emails match whatever their case.
    owners: ["Owner@Example.com"],
    workspace: "memory",
    people: {
      [CHAT_EMAIL]: {
        peer: "teammate",
        // Anything that is not a well-formed project never reaches the MCP bridge.
        chat: { projects: [...PROJECTS, { id: "honcho", name: "not a scope id" }, "p-0123456789ab"] },
      },
      [COLLECT_EMAIL]: { peer: "collector", collect: { workspace: "company" } },
      [HELPER_EMAIL]: { peer: "helper", collect: {} },
    },
    revokedDevices: [],
    ...overrides,
  };
}

/** Replaces access.json in one rename, as the owner's app does. A string is written as it is. */
async function writeAccess(stateDir, value) {
  const temporary = path.join(stateDir, `.access.json.${crypto.randomBytes(4).toString("hex")}`);
  await fsp.writeFile(temporary, typeof value === "string" ? value : JSON.stringify(value));
  await fsp.rename(temporary, path.join(stateDir, "access.json"));
}

/** A new state directory with `access` as its access.json (none for null). */
async function stateDirectory(access = accessFile()) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "gate-state-"));
  stateDirs.push(directory);
  if (access !== null) await writeAccess(directory, access);
  return directory;
}

function startGate(env) {
  const child = spawn(process.execPath, [GATE], {
    env: { PATH: process.env.PATH, HONCHO_GATE_LISTEN_HOST: "127.0.0.1", HONCHO_GATE_LISTEN_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

/** A gate that is listening, with its port and state directory. Stopped after all tests. */
async function launchGate(env, { access } = {}) {
  const stateDir = env.HONCHO_GATE_STATE_DIR || await stateDirectory(access);
  const child = startGate({ HONCHO_GATE_STATE_DIR: stateDir, ...env });
  gates.push(child);
  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const line = buffered.split("\n")[0];
      try { resolve(JSON.parse(line).port); } catch {}
    });
    child.once("exit", (code) => reject(new Error(`gate exited with ${code}`)));
  });
  return { child, port, stateDir };
}

function mcpEnv(overrides = {}) {
  return {
    HONCHO_GATE_TOKEN: TOKEN,
    HONCHO_GATE_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    HONCHO_GATE_MCP_UPSTREAM: `http://127.0.0.1:${mcpPort}`,
    // Written as an owner might: with its scheme, and the audience among others.
    HONCHO_GATE_ACCESS_TEAM_DOMAIN: `https://${ACCESS_TEAM_DOMAIN}/`,
    HONCHO_GATE_ACCESS_AUD: `aud-another-app, ${ACCESS_AUD}`,
    HONCHO_GATE_ACCESS_CERTS_URL: certs.url,
    HONCHO_TEAM_MCP_TOKEN: TEAM_MCP_TOKEN,
    ...overrides,
  };
}

function request(pathname, { method = "GET", headers = {}, body, port = gatePort } = {}) {
  return new Promise((resolve, reject) => {
    // A fresh connection each time: the over-limit test leaves its socket expecting
    // a body that never comes, and a reused one would hang the next request.
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A streamed answer's chunks. The upstream finishes only once the first chunk came through. */
function streamed(pathname, { method = "POST", headers = {}, body, release }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request({ hostname: "127.0.0.1", port: gatePort, path: pathname, method, headers, agent: false }, (res) => {
      assert.equal(res.statusCode, 200);
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        chunks.push(chunk);
        // A gate that buffered the whole answer would never get here.
        if (chunks.length === 1) release();
      });
      res.on("end", () => resolve({ chunks, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("the stream was buffered")));
    req.end(body);
  });
}

/** Retries `check` until it passes: the gate looks at access.json once a second at most. */
async function eventually(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const auth = { authorization: `Bearer ${TOKEN}` };
const json = { "content-type": "application/json" };
const assertionHeader = (claims = personClaims(), key = signingKey, header) =>
  ({ "cf-access-jwt-assertion": signAssertion(key, claims, header) });
const loginAs = (email) => assertionHeader(personClaims({ email }));
const withDevice = (email, key) => ({ ...loginAs(email), "x-team-memory-device": key });
const scopesOf = (received) => JSON.parse(Buffer.from(received.headers["x-honcho-allowed-scopes"], "base64url").toString("utf8"));

/** A new device key for `email`'s computer. */
async function register(email, { name = "MacBook Pro", port = gatePort } = {}) {
  const answer = await request("/team-memory/devices", { port, method: "POST", headers: { ...loginAs(email), ...json }, body: JSON.stringify({ name }) });
  assert.equal(answer.status, 201, answer.text);
  return answer.json;
}

async function readDevices(stateDir = gateState) {
  return JSON.parse(await fsp.readFile(path.join(stateDir, "devices.json"), "utf8"));
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (req.url.startsWith("/v3/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write("data: first\n\n");
      await new Promise((resolve) => { releaseStream = resolve; });
      res.end("data: second\n\n");
      return;
    }
    res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstreamPort = await listen(upstream);
  mcpUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    mcpSeen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" });
      res.write("event: message\ndata: first\n\n");
      await new Promise((resolve) => { releaseMcpStream = resolve; });
      res.end("event: message\ndata: second\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  mcpPort = await listen(mcpUpstream);
  certs = await startAccessCerts([signingKey]);
  ({ child: gate, port: gatePort, stateDir: gateState } = await launchGate(mcpEnv()));
});

after(async () => {
  // Each gate writes what it has not written yet as it stops, so wait for that.
  await Promise.all(gates.map((child) => (child.exitCode !== null || child.signalCode !== null
    ? null
    : new Promise((resolve) => { child.once("exit", resolve); child.kill(); }))));
  for (const server of [upstream, mcpUpstream]) {
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }
  await certs?.close();
  await Promise.all(stateDirs.map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

// ------------------------------------------------------------ the gate token

test("no token, a wrong token or another scheme is refused with 401", async () => {
  const before = seen.length;
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN}x` }]) {
    const answer = await request("/v3/workspaces/list", { method: "POST", headers });
    assert.equal(answer.status, 401);
    assert.equal(answer.json.error, "unauthorized");
    assert.match(answer.headers["content-type"], /application\/json/);
  }
  assert.equal(seen.length, before, "nothing unauthorized reached the API");
});

test("only GET /health and /v3/* reach the API", async () => {
  const before = seen.length;
  for (const [method, target] of [
    ["GET", "/"],
    ["GET", "/docs"],
    ["GET", "/openapi.json"],
    ["POST", "/health"],
    ["GET", "/v2/workspaces"],
    ["GET", "/v3"],
    ["GET", "/v3/../docs"],
    ["GET", "/v3/%2e%2e/docs"],
  ]) {
    const answer = await request(target, { method, headers: auth });
    assert.equal(answer.status, 404, `${method} ${target}`);
  }
  assert.equal(seen.length, before);
  const health = await request("/health", { headers: auth });
  assert.equal(health.status, 201);
  assert.equal(seen.at(-1).url, "/health");
});

test("method, path, query, body and headers arrive upstream as sent", async () => {
  const body = JSON.stringify({ messages: [{ content: "안녕하세요".repeat(1000) }] });
  const answer = await request("/v3/workspaces/memory/sessions/s1/messages?limit=5&x=a%20b", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "x-custom": "kept",
      connection: "keep-alive, x-drop",
      "x-drop": "1",
      "x-team-memory-device": "d-0123456789abcdef.not-for-the-api",
    },
    body,
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.headers["x-upstream"], "yes");
  const received = seen.at(-1);
  assert.equal(received.method, "POST");
  assert.equal(received.url, "/v3/workspaces/memory/sessions/s1/messages?limit=5&x=a%20b");
  assert.equal(received.body, body);
  assert.equal(received.headers.authorization, `Bearer ${TOKEN}`, "passed upstream unchanged");
  assert.equal(received.headers["x-custom"], "kept");
  assert.equal(received.headers["x-drop"], undefined, "a header named in Connection is hop-by-hop");
  assert.equal(received.headers["x-team-memory-device"], undefined, "a device key is the gate's alone, even next to the token");
  assert.equal(received.headers.host, `127.0.0.1:${upstreamPort}`, "Host is the API's own");
});

test("a streamed answer arrives chunk by chunk", async () => {
  const { chunks, headers } = await streamed("/v3/stream", { headers: auth, body: "{}", release: () => releaseStream() });
  assert.equal(headers["transfer-encoding"], "chunked");
  assert.equal(chunks[0], "data: first\n\n");
  assert.equal(chunks.join(""), "data: first\n\ndata: second\n\n");
});

test("a body over the limit is refused", async () => {
  const answer = await request("/v3/big", {
    method: "POST",
    headers: { ...auth, "content-length": String(21 * 1024 * 1024) },
  }).catch((error) => ({ error }));
  assert.equal(answer.status, 413);
});

test("the gate refuses to start without a token", async () => {
  const child = startGate({ HONCHO_GATE_TOKEN: "  ", HONCHO_GATE_UPSTREAM: `http://127.0.0.1:${upstreamPort}` });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /HONCHO_GATE_TOKEN is empty/);
});

test("the gate token opens no other door", async () => {
  for (const [method, target] of [
    ["GET", "/team-memory/whoami"],
    ["POST", "/team-memory/devices"],
    ["DELETE", "/team-memory/devices/d-0123456789abcdef"],
    ["POST", "/mcp"],
  ]) {
    const answer = await request(target, { method, headers: { ...auth, ...json }, body: method === "POST" ? "{}" : undefined });
    assert.equal(answer.status, 401, `${method} ${target}`);
    assert.equal(answer.json.error, "unauthorized");
  }
});

// ------------------------------------------------------------ who is calling

test("whoami tells a person what this server lets them do, whatever the case of their email", async () => {
  const nothing = { owner: false, chat: null, collect: false, device: null };
  const cases = [
    [OWNER_EMAIL, { email: OWNER_EMAIL, ...nothing, owner: true }],
    [CHAT_EMAIL, { email: CHAT_EMAIL, ...nothing, chat: { projects: PROJECTS } }],
    ["TeamMate@Example.COM", { email: CHAT_EMAIL, ...nothing, chat: { projects: PROJECTS } }],
    [COLLECT_EMAIL, { email: COLLECT_EMAIL, ...nothing, collect: true }],
    [HELPER_EMAIL, { email: HELPER_EMAIL, ...nothing, collect: true }],
    [STRANGER_EMAIL, { email: STRANGER_EMAIL, ...nothing }],
  ];
  for (const [email, expected] of cases) {
    const answer = await request("/team-memory/whoami", { headers: loginAs(email) });
    assert.equal(answer.status, 200, email);
    assert.deepEqual(answer.json, expected, email);
    assert.equal(answer.headers["cache-control"], "no-store");
  }
  const anonymous = await request("/team-memory/whoami");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error, "unauthorized");
});

test("the gate's own paths answer only their own method", async () => {
  for (const [method, target] of [
    ["GET", "/team-memory"],
    ["POST", "/team-memory/whoami"],
    ["GET", "/team-memory/whoami/"],
    ["GET", "/team-memory/devices"],
    ["PUT", "/team-memory/devices"],
    ["GET", "/team-memory/devices/d-0123456789abcdef"],
    ["DELETE", "/team-memory/devices/not-a-device"],
    ["DELETE", "/team-memory/devices/d-0123456789ABCDEF"],
    ["GET", "/team-memory/%2e%2e/health"],
  ]) {
    const answer = await request(target, { method, headers: loginAs(OWNER_EMAIL) });
    assert.equal(answer.status, 404, `${method} ${target}`);
  }
});

// ------------------------------------------------------------------ devices

test("an owner or a collector registers a computer and gets its key once; devices.json keeps only the key's hash, owner-only", async () => {
  const startedAt = Date.now();
  const made = await register(OWNER_EMAIL, { name: "  첸징의 MacBook Pro  " });
  assert.deepEqual(Object.keys(made), ["id", "key", "name"]);
  assert.match(made.id, /^d-[0-9a-f]{16}$/);
  assert.equal(made.name, "첸징의 MacBook Pro");
  const [id, secret, ...rest] = made.key.split(".");
  assert.equal(id, made.id, "the key is the header's whole value, <id>.<secret>");
  assert.deepEqual(rest, []);
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(secret, "base64url").length, 32);
  const collector = await register(COLLECT_EMAIL, { name: "office" });
  assert.notEqual(collector.id, made.id);

  const file = path.join(gateState, "devices.json");
  const text = await fsp.readFile(file, "utf8");
  const saved = JSON.parse(text);
  assert.equal(saved.version, 1);
  const device = saved.devices[made.id];
  assert.deepEqual(Object.keys(device), ["email", "name", "keyHash", "createdAt", "lastSeenAt"]);
  assert.equal(device.email, OWNER_EMAIL);
  assert.equal(device.name, "첸징의 MacBook Pro");
  assert.equal(device.keyHash, crypto.createHash("sha256").update(secret).digest("hex"));
  assert.ok(Date.parse(device.createdAt) >= startedAt - 1_000);
  assert.equal(device.lastSeenAt, null);
  assert.equal(saved.devices[collector.id].email, COLLECT_EMAIL);
  assert.ok(!text.includes(secret), "the secret itself is never written");
  if (process.platform !== "win32") assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);

  const whoami = await request("/team-memory/whoami", { headers: withDevice(OWNER_EMAIL, made.key) });
  assert.deepEqual(whoami.json.device, { id: made.id, name: "첸징의 MacBook Pro" });
  assert.ok(!whoami.text.includes(secret));
});

test("a person who neither owns nor collects registers nothing, and a name is 1 to 64 printable characters", async () => {
  const post = (email, body) => request("/team-memory/devices", { method: "POST", headers: { ...loginAs(email), ...json }, body });
  for (const email of [CHAT_EMAIL, STRANGER_EMAIL]) {
    const answer = await post(email, JSON.stringify({ name: "laptop" }));
    assert.equal(answer.status, 403, email);
    assert.equal(answer.json.error, "forbidden");
  }
  for (const name of ["", "   ", "x".repeat(65), "가".repeat(65), "two\nlines", "a\ttab", "zero​width", "line separator", 42, null, ["laptop"]]) {
    const answer = await post(OWNER_EMAIL, JSON.stringify({ name }));
    assert.equal(answer.status, 400, JSON.stringify(name));
    assert.equal(answer.json.error, "invalid_name");
  }
  for (const body of ["", "{", "not json", "{}", JSON.stringify("laptop")]) {
    assert.equal((await post(OWNER_EMAIL, body)).status, 400, body);
  }
  assert.equal((await register(OWNER_EMAIL, { name: "가".repeat(64) })).name, "가".repeat(64));
  const anonymous = await request("/team-memory/devices", { method: "POST", headers: json, body: JSON.stringify({ name: "laptop" }) });
  assert.equal(anonymous.status, 401);
});

test("an email registers at most 50 computers; a revoked one no longer counts", async () => {
  const { port, stateDir } = await launchGate(mcpEnv());
  const made = [];
  for (let index = 0; index < 50; index += 1) made.push(await register(OWNER_EMAIL, { name: `computer ${index}`, port }));
  const oneMore = () => request("/team-memory/devices", { port, method: "POST", headers: { ...loginAs(OWNER_EMAIL), ...json }, body: JSON.stringify({ name: "one more" }) });
  const refused = await oneMore();
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, "too_many_devices");
  // Another email has its own 50.
  await register(COLLECT_EMAIL, { port });

  // The owner's app revokes one: its place is free again.
  await writeAccess(stateDir, accessFile({ revokedDevices: [made[0].id] }));
  const again = await eventually(async () => {
    const answer = await oneMore();
    assert.equal(answer.status, 201);
    return answer.json;
  });
  assert.equal((await oneMore()).status, 429);
  const saved = await readDevices(stateDir);
  assert.equal(Object.keys(saved.devices).length, 52);
  assert.ok(saved.devices[made[0].id], "a revoked device stays listed for the owner's app");
  assert.ok(saved.devices[again.id]);
});

// Permissions do not stop root, and Windows has none of these modes.
test("a key is handed out only once devices.json has it", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const { port, stateDir } = await launchGate(mcpEnv());
  await fsp.chmod(stateDir, 0o500);
  try {
    const answer = await request("/team-memory/devices", { port, method: "POST", headers: { ...loginAs(OWNER_EMAIL), ...json }, body: JSON.stringify({ name: "laptop" }) });
    assert.equal(answer.status, 500);
    assert.equal(answer.json.error, "devices_unwritable");
    assert.equal(answer.json.key, undefined);
  } finally {
    await fsp.chmod(stateDir, 0o700);
  }
  const made = await register(OWNER_EMAIL, { port });
  assert.deepEqual(Object.keys((await readDevices(stateDir)).devices), [made.id], "the unsaved one was not kept");
});

test("a device removes its own key, and only its own", async () => {
  const first = await register(COLLECT_EMAIL, { name: "first" });
  const second = await register(COLLECT_EMAIL, { name: "second" });
  const remove = (id, headers) => request(`/team-memory/devices/${id}`, { method: "DELETE", headers });
  for (const [name, headers] of Object.entries({
    "no key": loginAs(COLLECT_EMAIL),
    "another device's key, even the same person's": withDevice(COLLECT_EMAIL, second.key),
    "its key under another login": withDevice(OWNER_EMAIL, first.key),
    "a wrong secret": withDevice(COLLECT_EMAIL, `${first.id}.${"A".repeat(43)}`),
  })) {
    const answer = await remove(first.id, headers);
    assert.equal(answer.status, 403, name);
    assert.equal(answer.json.error, "forbidden", name);
  }
  assert.equal((await remove(first.id, { "x-team-memory-device": first.key })).status, 401, "a key is no login");
  assert.ok((await readDevices()).devices[first.id], "still there");

  const removed = await remove(first.id, withDevice(COLLECT_EMAIL, first.key));
  assert.equal(removed.status, 204);
  assert.equal(removed.text, "");
  const saved = await readDevices();
  assert.equal(saved.devices[first.id], undefined);
  assert.ok(saved.devices[second.id], "the other computer keeps its key");
  // The key went with it.
  assert.equal((await request("/team-memory/whoami", { headers: withDevice(COLLECT_EMAIL, first.key) })).json.device, null);
  assert.equal((await remove(first.id, withDevice(COLLECT_EMAIL, first.key))).status, 403);
  const write = await request("/v3/workspaces/company/sessions", { method: "POST", headers: { ...withDevice(COLLECT_EMAIL, first.key), ...json }, body: JSON.stringify({ id: "s1" }) });
  assert.equal(write.status, 403);
});

// ------------------------------------------------------------------ /health

test("/health answers the gate token, and without a device anyone this server lets in", async () => {
  for (const email of [OWNER_EMAIL, CHAT_EMAIL, COLLECT_EMAIL]) {
    const answer = await request("/health", { headers: { ...loginAs(email), authorization: "Bearer oauth:not-the-gate-token", cookie: "CF_Authorization=x" } });
    assert.equal(answer.status, 201, email);
    const received = seen.at(-1);
    assert.equal(received.url, "/health");
    for (const name of ["authorization", "cookie", "cf-access-jwt-assertion"]) assert.equal(received.headers[name], undefined, `${email}: ${name}`);
  }
  const before = seen.length;
  const stranger = await request("/health", { headers: loginAs(STRANGER_EMAIL) });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error, "forbidden");
  assert.equal((await request("/health")).status, 401);
  assert.equal(seen.length, before);
  assert.equal((await request("/health", { headers: auth })).status, 201);
});

// ------------------------------------------------------------- /v3 for people

test("a person's /v3 request needs a valid device key of their own", async () => {
  const owner = await register(OWNER_EMAIL);
  const collector = await register(COLLECT_EMAIL);
  const [, ownerSecret] = owner.key.split(".");
  const before = seen.length;
  const cases = {
    "no key": [loginAs(OWNER_EMAIL), 403],
    "not a key": [withDevice(OWNER_EMAIL, "not-a-key"), 403],
    "the id alone": [withDevice(OWNER_EMAIL, owner.id), 403],
    "a wrong secret": [withDevice(OWNER_EMAIL, `${owner.id}.${"A".repeat(43)}`), 403],
    "an unknown id": [withDevice(OWNER_EMAIL, `d-0000000000000000.${ownerSecret}`), 403],
    "another person's device": [withDevice(OWNER_EMAIL, collector.key), 403],
    "the owner's key under another login": [withDevice(CHAT_EMAIL, owner.key), 403],
    "the key without a login": [{ "x-team-memory-device": owner.key }, 401],
  };
  for (const [name, [headers, status]] of Object.entries(cases)) {
    const answer = await request("/v3/workspaces/list", { method: "POST", headers: { ...headers, ...json }, body: "{}" });
    assert.equal(answer.status, status, name);
    assert.ok(!answer.text.includes(ownerSecret), `${name}: the answer does not echo the key`);
  }
  assert.equal(seen.length, before, "nothing reached the API");
});

test("an owner's request from a registered computer reaches the API as sent, without the caller's credentials", async () => {
  const owner = await register(OWNER_EMAIL);
  const body = JSON.stringify({ filters: { metadata: { note: "안녕하세요".repeat(200) } } });
  const answer = await request("/v3/workspaces/memory/sessions/list?page=2&size=5&x=a%20b", {
    method: "POST",
    headers: {
      ...withDevice(OWNER_EMAIL, owner.key),
      ...json,
      authorization: "Bearer oauth:access-token",
      cookie: "CF_Authorization=from-the-browser",
      "cf-access-client-id": "spoofed.access",
      "x-team-memory-anything": "x",
      "x-honcho-host": "kept",
      "x-custom": "kept",
    },
    body,
  });
  assert.equal(answer.status, 201);
  assert.equal(answer.headers["x-upstream"], "yes");
  const received = seen.at(-1);
  assert.equal(received.method, "POST");
  assert.equal(received.url, "/v3/workspaces/memory/sessions/list?page=2&size=5&x=a%20b");
  assert.equal(received.body, body);
  for (const name of ["authorization", "cookie", "cf-access-jwt-assertion", "cf-access-client-id", "x-team-memory-device", "x-team-memory-anything"]) {
    assert.equal(received.headers[name], undefined, `${name} is dropped`);
  }
  assert.equal(received.headers["x-honcho-host"], "kept", "Honcho's own client headers stay");
  assert.equal(received.headers["x-custom"], "kept");
  assert.equal(received.headers.host, `127.0.0.1:${upstreamPort}`);

  // Any method and any /v3 path: the owner's computer is the owner.
  const removed = await request("/v3/workspaces/memory/sessions/s1", { method: "DELETE", headers: withDevice(OWNER_EMAIL, owner.key) });
  assert.equal(removed.status, 201);
  assert.equal(seen.at(-1).method, "DELETE");
  assert.equal(seen.at(-1).url, "/v3/workspaces/memory/sessions/s1");
});

test("an owner's streamed answer arrives chunk by chunk", async () => {
  const owner = await register(OWNER_EMAIL);
  const { chunks } = await streamed("/v3/stream", {
    headers: withDevice(OWNER_EMAIL, owner.key),
    body: "{}",
    release: () => releaseStream(),
  });
  assert.equal(chunks[0], "data: first\n\n");
  assert.equal(chunks.join(""), "data: first\n\ndata: second\n\n");
});

// -------------------------------------------------------------- access.json

test("without a readable access.json nobody but the gate token gets in, until one appears", async () => {
  const { port, stateDir } = await launchGate(mcpEnv(), { access: null });
  const whoami = async () => (await request("/team-memory/whoami", { port, headers: loginAs(OWNER_EMAIL) })).json;
  assert.deepEqual(await whoami(), { email: OWNER_EMAIL, owner: false, chat: null, collect: false, device: null });
  const registration = await request("/team-memory/devices", { port, method: "POST", headers: { ...loginAs(OWNER_EMAIL), ...json }, body: JSON.stringify({ name: "laptop" }) });
  assert.equal(registration.status, 403);
  assert.equal((await request("/mcp", { port, method: "POST", headers: { ...loginAs(OWNER_EMAIL), ...json }, body: "{}" })).status, 403);
  assert.equal((await request("/health", { port, headers: loginAs(OWNER_EMAIL) })).status, 403);
  assert.equal((await request("/health", { port, headers: auth })).status, 201);
  assert.equal((await request("/v3/workspaces/list", { port, method: "POST", headers: auth, body: "{}" })).status, 201);

  // The owner's app writes it, and the gate reads it within about a second.
  await writeAccess(stateDir, accessFile());
  await eventually(async () => assert.equal((await whoami()).owner, true));
  // A file the gate cannot read, or of another version, lets nobody in again.
  for (const unreadable of ["{ not json", JSON.stringify(accessFile({ version: 2 }))]) {
    await writeAccess(stateDir, unreadable);
    await eventually(async () => assert.equal((await whoami()).owner, false));
    await writeAccess(stateDir, accessFile());
    await eventually(async () => assert.equal((await whoami()).owner, true));
  }
});

test("access.json is read again when it changes: a device revoked and given back, a person let in, a collector taken off", async () => {
  const { port, stateDir } = await launchGate(mcpEnv());
  const owner = await register(OWNER_EMAIL, { port });
  const collector = await register(COLLECT_EMAIL, { port });
  const ownerCall = (key = owner.key) => request("/v3/workspaces/list", { port, method: "POST", headers: { ...withDevice(OWNER_EMAIL, key), ...json }, body: "{}" });
  const collectCall = () => request("/v3/workspaces/company/sessions", { port, method: "POST", headers: { ...withDevice(COLLECT_EMAIL, collector.key), ...json }, body: JSON.stringify({ id: "s1" }) });
  assert.equal((await ownerCall()).status, 201);
  assert.equal((await collectCall()).status, 201);

  const people = accessFile().people;
  await writeAccess(stateDir, accessFile({
    revokedDevices: [owner.id],
    people: { ...people, [STRANGER_EMAIL]: { peer: "stranger", chat: { projects: [PROJECTS[1]] } } },
  }));
  await eventually(async () => assert.equal((await ownerCall()).status, 403));
  const whoami = await request("/team-memory/whoami", { port, headers: withDevice(OWNER_EMAIL, owner.key) });
  assert.equal(whoami.json.owner, true);
  assert.equal(whoami.json.device, null, "a revoked device is no device");
  // The owner's other computers are untouched.
  const another = await register(OWNER_EMAIL, { port, name: "another" });
  assert.equal((await ownerCall(another.key)).status, 201);
  // A person let in to chat asks only the project opened to them.
  assert.deepEqual((await request("/team-memory/whoami", { port, headers: loginAs(STRANGER_EMAIL) })).json.chat, { projects: [PROJECTS[1]] });
  assert.equal((await request("/mcp", { port, method: "POST", headers: { ...loginAs(STRANGER_EMAIL), ...json }, body: "{}" })).status, 200);
  assert.deepEqual(scopesOf(mcpSeen.at(-1)), [PROJECTS[1]]);

  // The collector is taken off and the revoked device given back.
  const { [COLLECT_EMAIL]: _collector, ...withoutCollector } = people;
  await writeAccess(stateDir, accessFile({ people: withoutCollector }));
  await eventually(async () => assert.equal((await collectCall()).status, 403));
  assert.equal((await ownerCall()).status, 201);
  const registration = await request("/team-memory/devices", { port, method: "POST", headers: { ...loginAs(COLLECT_EMAIL), ...json }, body: JSON.stringify({ name: "laptop" }) });
  assert.equal(registration.status, 403);
  assert.ok((await readDevices(stateDir)).devices[collector.id], "their device stays listed for the owner's app");
});

test("lastSeenAt is written on a device's first /v3 request, then at most once a minute, and as the gate stops", async () => {
  const { child, port, stateDir } = await launchGate(mcpEnv());
  const owner = await register(OWNER_EMAIL, { port });
  const call = () => request("/v3/workspaces/list", { port, method: "POST", headers: { ...withDevice(OWNER_EMAIL, owner.key), ...json }, body: "{}" });
  // whoami is no /v3 request.
  await request("/team-memory/whoami", { port, headers: withDevice(OWNER_EMAIL, owner.key) });
  assert.equal((await readDevices(stateDir)).devices[owner.id].lastSeenAt, null);

  assert.equal((await call()).status, 201);
  const first = await eventually(async () => {
    const at = (await readDevices(stateDir)).devices[owner.id].lastSeenAt;
    assert.ok(at);
    return at;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await call()).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await readDevices(stateDir)).devices[owner.id].lastSeenAt, first, "not written again within the minute");

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  const last = (await readDevices(stateDir)).devices[owner.id].lastSeenAt;
  assert.ok(last > first, "the later request is written as the gate stops");
  assert.deepEqual((await fsp.readdir(stateDir)).sort(), ["access.json", "devices.json"], "no temporary file is left");
  if (process.platform !== "win32") assert.equal((await fsp.stat(path.join(stateDir, "devices.json"))).mode & 0o777, 0o600);

  // Started again, the gate knows the computer from devices.json.
  const { port: restarted } = await launchGate(mcpEnv({ HONCHO_GATE_STATE_DIR: stateDir }));
  const whoami = await request("/team-memory/whoami", { port: restarted, headers: withDevice(OWNER_EMAIL, owner.key) });
  assert.deepEqual(whoami.json.device, { id: owner.id, name: "MacBook Pro" });
});

test("a devices.json the gate cannot read is replaced at the next registration", async () => {
  const stateDir = await stateDirectory();
  await fsp.writeFile(path.join(stateDir, "devices.json"), "{ not json", { mode: 0o600 });
  const { port } = await launchGate(mcpEnv({ HONCHO_GATE_STATE_DIR: stateDir }));
  const made = await register(OWNER_EMAIL, { port });
  assert.deepEqual(Object.keys((await readDevices(stateDir)).devices), [made.id]);
});

// ------------------------------------------------------ collecting teammates

test("a collector's three requests reach the API rewritten to their own sessions", async () => {
  const device = await register(COLLECT_EMAIL);
  const headers = {
    ...withDevice(COLLECT_EMAIL, device.key),
    "content-type": "application/json; charset=utf-8",
    authorization: "Bearer oauth:access-token",
    cookie: "CF_Authorization=from-the-browser",
    "x-honcho-host": "kept",
  };
  const send = (target, body) => request(target, { method: "POST", headers, body });
  const arrived = () => {
    const received = seen.at(-1);
    assert.equal(received.method, "POST");
    assert.equal(received.headers["content-length"], String(Buffer.byteLength(received.body)), "a fresh length");
    assert.equal(received.headers["content-type"], "application/json");
    for (const name of ["authorization", "cookie", "cf-access-jwt-assertion", "x-team-memory-device"]) {
      assert.equal(received.headers[name], undefined, `${name} is dropped`);
    }
    assert.equal(received.headers["x-honcho-host"], "kept");
    return received;
  };

  // A session: its id gets the person's prefix; the rest arrives as sent.
  const session = {
    id: "claude-0f1e2d3c",
    metadata: { source: "claude", title: "회의록 정리" },
    peers: {
      collector: { observe_me: true, observe_others: false },
      assistant_claude: { observe_me: false },
      automation_claude: { observe_me: false },
    },
    configuration: {},
    scopes: ["p-0123456789ab", "p-abcdef012345"],
  };
  assert.equal((await send("/v3/workspaces/company/sessions", JSON.stringify(session))).status, 201);
  let received = arrived();
  assert.equal(received.url, "/v3/workspaces/company/sessions");
  assert.deepEqual(JSON.parse(received.body), { ...session, id: `${COLLECT_PREFIX}claude-0f1e2d3c` });

  // An id with the prefix keeps it, once; someone else's prefix is not theirs.
  for (const [id, expected] of [
    [`${COLLECT_PREFIX}claude-0f1e2d3c`, `${COLLECT_PREFIX}claude-0f1e2d3c`],
    [`${prefixOf(OWNER_EMAIL)}x`, `${COLLECT_PREFIX}${prefixOf(OWNER_EMAIL)}x`],
  ]) {
    assert.equal((await send("/v3/workspaces/company/sessions", JSON.stringify({ id }))).status, 201);
    assert.deepEqual(JSON.parse(arrived().body), { id: expected });
  }

  // Messages: the session in the path gets the prefix.
  const messages = {
    messages: [
      { peer_id: "collector", content: "안녕하세요", metadata: { source_turn_hash: "abc" }, created_at: "2026-10-07T00:00:00Z" },
      { peer_id: "assistant_claude", content: "네", configuration: {} },
      { peer_id: "automation_codex", content: "scheduled" },
    ],
  };
  assert.equal((await send("/v3/workspaces/company/sessions/claude-0f1e2d3c/messages", JSON.stringify(messages))).status, 201);
  received = arrived();
  assert.equal(received.url, `/v3/workspaces/company/sessions/${COLLECT_PREFIX}claude-0f1e2d3c/messages`);
  assert.deepEqual(JSON.parse(received.body), messages);

  // Reading them back: page, size and reverse only, and an empty body or {}.
  const list = "/v3/workspaces/company/sessions/claude-0f1e2d3c/messages/list";
  for (const body of ["", "{}", " { } "]) {
    assert.equal((await send(`${list}?page=2&size=100&reverse=false`, body)).status, 201);
    received = arrived();
    assert.equal(received.url, `/v3/workspaces/company/sessions/${COLLECT_PREFIX}claude-0f1e2d3c/messages/list?page=2&size=100&reverse=false`);
    assert.equal(received.body, "{}");
  }
  assert.equal((await send(list, "")).status, 201);
  assert.equal(arrived().url, `/v3/workspaces/company/sessions/${COLLECT_PREFIX}claude-0f1e2d3c/messages/list`);

  // A collector with no workspace of their own writes to the server's.
  const helper = await register(HELPER_EMAIL);
  const helperSession = (workspace) => request(`/v3/workspaces/${workspace}/sessions`, { method: "POST", headers: { ...withDevice(HELPER_EMAIL, helper.key), ...json }, body: JSON.stringify({ id: "s1" }) });
  assert.equal((await helperSession("memory")).status, 201);
  assert.deepEqual(JSON.parse(seen.at(-1).body), { id: `${prefixOf(HELPER_EMAIL)}s1` });
  assert.equal((await helperSession("company")).status, 403);
});

test("anything else a collector sends is refused, and none of it reaches the API", async () => {
  const device = await register(COLLECT_EMAIL);
  const headers = { ...withDevice(COLLECT_EMAIL, device.key), ...json };
  const session = (extra = {}) => JSON.stringify({ id: "s1", ...extra });
  const messages = (...items) => JSON.stringify({ messages: items });
  const said = { peer_id: "collector", content: "hi" };
  const sessions = "/v3/workspaces/company/sessions";
  const added = `${sessions}/s1/messages`;
  const list = `${sessions}/s1/messages/list`;
  const tooLong = "x".repeat(512 - COLLECT_PREFIX.length + 1);
  const cases = [
    ["another workspace", "POST", "/v3/workspaces/memory/sessions", session()],
    ["listing the workspace's sessions", "POST", `${sessions}/list`, "{}"],
    ["searching a session", "POST", `${sessions}/s1/search`, JSON.stringify({ query: "?" })],
    ["deleting a session", "DELETE", `${sessions}/s1`, ""],
    ["adding peers to a session", "POST", `${sessions}/s1/peers`, "{}"],
    ["uploading a file", "POST", `${added}/upload`, "{}"],
    ["reading one message", "GET", `${added}/m1`, ""],
    ["reading back with GET", "GET", list, ""],
    ["a trailing slash", "POST", `${sessions}/`, session()],
    ["a workspace of their own", "POST", "/v3/workspaces", JSON.stringify({ id: "company" })],
    ["a peer's chat", "POST", "/v3/workspaces/company/peers/collector/chat", JSON.stringify({ query: "?" })],
    ["an escaped workspace", "POST", "/v3/workspaces/compan%79/sessions", session()],
    ["an escaped session", "POST", "/v3/workspaces/company/sessions/s%2F1/messages", messages(said)],
    ["a query on a session", "POST", `${sessions}?x=1`, session()],
    ["a query on messages", "POST", `${added}?x=1`, messages(said)],
    ["another query when reading back", "POST", `${list}?page=1&filters=x`, "{}"],
    ["a filter when reading back", "POST", list, JSON.stringify({ filters: { peer_id: "owner" } })],
    ["a list when reading back", "POST", list, "[]"],
    ["a session key Honcho also reads", "POST", sessions, session({ name: "owner-session" })],
    ["peer_names", "POST", sessions, session({ peer_names: { owner: {} } })],
    ["an id that is not a string", "POST", sessions, JSON.stringify({ id: 7 })],
    ["no id", "POST", sessions, JSON.stringify({ metadata: {} })],
    ["an id Honcho would not take", "POST", sessions, JSON.stringify({ id: "a/b" })],
    ["an id too long once prefixed", "POST", sessions, JSON.stringify({ id: tooLong })],
    ["a path session too long once prefixed", "POST", `${sessions}/${tooLong}/messages`, messages(said)],
    ["another person's peer", "POST", sessions, session({ peers: { owner: {} } })],
    ["the peers as a list", "POST", sessions, session({ peers: ["collector"] })],
    ["a scope that is no project", "POST", sessions, session({ scopes: ["honcho"] })],
    ["a scope in capitals", "POST", sessions, session({ scopes: ["p-0123456789AB"] })],
    ["the scopes as a string", "POST", sessions, session({ scopes: "p-0123456789ab" })],
    ["a message as another person", "POST", added, messages(said, { peer_id: "owner", content: "hi" })],
    ["a message with no peer", "POST", added, messages({ content: "hi" })],
    ["a message key Honcho does not take", "POST", added, messages({ ...said, session_id: "other" })],
    ["a body key next to the messages", "POST", added, JSON.stringify({ messages: [said], session_id: "other" })],
    ["messages that are not a list", "POST", added, JSON.stringify({ messages: said })],
    ["a body that is not JSON", "POST", sessions, "{"],
    ["a body that is not UTF-8", "POST", sessions, Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])],
    ["an empty body", "POST", sessions, ""],
  ];
  const before = seen.length;
  for (const [name, method, target, body] of cases) {
    const answer = await request(target, { method, headers, body });
    assert.equal(answer.status, 403, name);
    assert.deepEqual(answer.json, COLLECT_REFUSED, name);
  }
  assert.equal(seen.length, before, "nothing refused reached the API");

  // The longest id that fits once prefixed passes.
  const longest = "x".repeat(512 - COLLECT_PREFIX.length);
  assert.equal((await request(sessions, { method: "POST", headers, body: JSON.stringify({ id: longest }) })).status, 201);
  assert.equal(JSON.parse(seen.at(-1).body).id, `${COLLECT_PREFIX}${longest}`);
});

test("a collector's body is read up to the same limit as any other", async () => {
  const { port } = await launchGate(mcpEnv({ HONCHO_GATE_MAX_BODY_BYTES: "1024" }));
  const device = await register(COLLECT_EMAIL, { port });
  const target = "/v3/workspaces/company/sessions/s1/messages";
  const headers = { ...withDevice(COLLECT_EMAIL, device.key), ...json };
  const big = JSON.stringify({ messages: [{ peer_id: "collector", content: "x".repeat(2_048) }] });
  const before = seen.length;
  const declared = await request(target, { port, method: "POST", headers, body: big });
  assert.equal(declared.status, 413);
  assert.equal(declared.json.error, "payload_too_large");
  // Sent in chunks with no length, it is counted as it arrives.
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: target, method: "POST", headers, agent: false }, (res) => {
      resolve(res.statusCode);
      res.resume();
    });
    req.on("error", reject);
    req.write(big.slice(0, 512));
    req.end(big.slice(512));
  });
  assert.equal(chunked, 413);
  assert.equal(seen.length, before);
  const small = await request(target, { port, method: "POST", headers, body: JSON.stringify({ messages: [{ peer_id: "collector", content: "hi" }] }) });
  assert.equal(small.status, 201);
});

test("a refusal is logged with its reason, never with an email, a key or a token", async () => {
  const { child, port } = await launchGate(mcpEnv());
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  const device = await register(COLLECT_EMAIL, { port });
  const [, secret] = device.key.split(".");
  await request("/mcp", { port, method: "POST", headers: assertionHeader(personClaims({ email: STRANGER_EMAIL, aud: ["aud-of-another-app"] })), body: "{}" });
  await request("/v3/workspaces/company/sessions", { port, method: "POST", headers: { ...withDevice(COLLECT_EMAIL, `${device.id}.${"B".repeat(43)}`), ...json }, body: "{}" });
  await request("/v3/workspaces/memory/sessions", {
    port,
    method: "POST",
    headers: { ...withDevice(COLLECT_EMAIL, device.key), ...json, authorization: `Bearer ${TOKEN}x` },
    body: JSON.stringify({ id: "a-session-name" }),
  });
  await request("/mcp", { port, method: "POST", headers: { ...loginAs(STRANGER_EMAIL), ...json }, body: "{}" });
  const refusals = () => log.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.gate === "refused");
  await eventually(() => assert.equal(refusals().length, 4));
  assert.deepEqual(refusals().map(({ door, status, reason }) => [door, status, reason]), [
    ["mcp", 401, "audience"],
    ["api", 403, "device_unknown"],
    ["api", 403, "collect_workspace"],
    ["mcp", 403, "not_allowed"],
  ]);
  for (const value of [COLLECT_EMAIL, STRANGER_EMAIL, secret, "B".repeat(43), device.id, TOKEN, "a-session-name", ACCESS_AUD]) {
    assert.ok(!log.includes(value), `the log does not carry ${value}`);
  }
});

// -------------------------------------------------------------------- /mcp

test("a person's Access login reaches the MCP bridge as that person, with the caller's credentials replaced", async () => {
  const before = seen.length;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat", arguments: { query: "누구?" } } });
  const answer = await request("/mcp?probe=1", {
    method: "POST",
    headers: {
      ...assertionHeader(),
      authorization: `Bearer ${TOKEN}`,
      cookie: "CF_Authorization=from-the-browser",
      "cf-access-authenticated-user-email": "boss@example.com",
      "cf-access-client-id": "spoofed.access",
      "x-honcho-workspace-id": "someone-else",
      "X-Honcho-User-Name": "someone-else",
      "x-honcho-scope-mode": "all",
      "x-team-memory-device": "d-0123456789abcdef.not-for-the-bridge",
      "mcp-session-id": "session-1",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["mcp-session-id"], "session-1");
  const received = mcpSeen.at(-1);
  assert.equal(received.method, "POST");
  assert.equal(received.url, "/mcp?probe=1");
  assert.equal(received.body, body);
  assert.equal(received.headers.authorization, `Bearer ${TEAM_MCP_TOKEN}`, "the bridge sees the gate's token, never the caller's");
  assert.equal(received.headers["cf-access-authenticated-user-email"], PERSON_EMAIL, "the verified email, not the spoofed one");
  assert.equal(received.headers["x-honcho-scope-mode"], "projects", "the gate's scope, not the caller's");
  assert.deepEqual(scopesOf(received), PROJECTS);
  assert.equal(received.headers.host, `127.0.0.1:${mcpPort}`);
  assert.equal(received.headers["mcp-session-id"], "session-1");
  assert.equal(received.headers.accept, "application/json, text/event-stream");
  for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-id", "x-honcho-workspace-id", "x-honcho-user-name", "x-team-memory-device"]) {
    assert.equal(received.headers[name], undefined, `${name} is dropped`);
  }
  assert.equal(seen.length, before, "nothing went to the API");

  // Any method, and paths below /mcp.
  const removed = await request("/mcp/", { method: "DELETE", headers: assertionHeader() });
  assert.equal(removed.status, 200);
  assert.equal(mcpSeen.at(-1).method, "DELETE");
  assert.equal(mcpSeen.at(-1).url, "/mcp/");
});

test("/mcp: an owner asks every project, a person with chat only theirs, and anyone else is refused", async () => {
  const spoofed = {
    "x-honcho-scope-mode": "all",
    "x-honcho-allowed-scopes": Buffer.from(JSON.stringify([{ id: "p-ffffffffffff", name: "secret" }])).toString("base64url"),
    // Spelled with "_", which some servers read as "-".
    x_honcho_scope_mode: "all",
    cf_access_authenticated_user_email: "boss@example.com",
    "x-team-memory-device": "d-0123456789abcdef.not-for-the-bridge",
  };
  const ask = (email) => request("/mcp", { method: "POST", headers: { ...loginAs(email), ...json, ...spoofed }, body: "{}" });
  assert.equal((await ask(OWNER_EMAIL)).status, 200);
  let received = mcpSeen.at(-1);
  assert.equal(received.headers["x-honcho-scope-mode"], "all");
  assert.equal(received.headers["x-honcho-allowed-scopes"], undefined, "an owner has no list: every project");
  for (const name of ["x-team-memory-device", "x_honcho_scope_mode", "cf_access_authenticated_user_email"]) {
    assert.equal(received.headers[name], undefined, `${name} is dropped`);
  }
  assert.equal(received.headers["cf-access-authenticated-user-email"], OWNER_EMAIL);

  assert.equal((await ask(CHAT_EMAIL)).status, 200);
  received = mcpSeen.at(-1);
  assert.equal(received.headers["x-honcho-scope-mode"], "projects");
  assert.match(received.headers["x-honcho-allowed-scopes"], /^[A-Za-z0-9_-]+$/, "base64url");
  assert.deepEqual(scopesOf(received), PROJECTS);

  const before = mcpSeen.length;
  for (const email of [COLLECT_EMAIL, STRANGER_EMAIL]) {
    const answer = await ask(email);
    assert.equal(answer.status, 403, email);
    assert.equal(answer.json.error, "forbidden", email);
  }
  assert.equal(mcpSeen.length, before, "nothing refused reached the MCP bridge");
});

test("expiry and not-before allow up to 60 seconds of clock difference", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [personClaims({ exp: now - 30 }), personClaims({ nbf: now + 30 })]) {
    const answer = await request("/mcp", { method: "POST", headers: assertionHeader(claims), body: "{}" });
    assert.equal(answer.status, 200, JSON.stringify(claims));
  }
});

test("an MCP stream arrives chunk by chunk", async () => {
  const { chunks, headers } = await streamed("/mcp", {
    method: "GET",
    headers: { ...assertionHeader(), accept: "text/event-stream" },
    release: () => releaseMcpStream(),
  });
  assert.equal(headers["content-type"], "text/event-stream");
  assert.equal(chunks[0], "event: message\ndata: first\n\n");
  assert.equal(chunks.join(""), "event: message\ndata: first\n\nevent: message\ndata: second\n\n");
});

test("/mcp refuses every assertion that is not a person's valid login for this app, without echoing it", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { email: _email, ...withoutEmail } = personClaims();
  const cases = {
    "missing assertion": {},
    "only the gate token": { authorization: `Bearer ${TOKEN}` },
    "not a JWT": { "cf-access-jwt-assertion": "not-a-jwt" },
    "bad signature": assertionHeader(personClaims(), strangerKey),
    "wrong aud": assertionHeader(personClaims({ aud: ["aud-of-another-app"] })),
    "wrong iss": assertionHeader(personClaims({ iss: "https://another-team.example" })),
    expired: assertionHeader(personClaims({ exp: now - 120 })),
    "no exp": assertionHeader(personClaims({ exp: undefined })),
    "not yet valid": assertionHeader(personClaims({ nbf: now + 600 })),
    "no email": assertionHeader(withoutEmail),
    "empty email": assertionHeader(personClaims({ email: "  " })),
    "service token": assertionHeader({ ...withoutEmail, common_name: "0000.access", sub: "" }),
    "another algorithm": assertionHeader(personClaims(), signingKey, { alg: "HS256" }),
    "signature of another token": {
      "cf-access-jwt-assertion": (() => {
        const forged = signAssertion(signingKey, personClaims({ email: "boss@example.com" })).split(".");
        forged[2] = signAssertion(signingKey, personClaims()).split(".")[2];
        return forged.join(".");
      })(),
    },
  };
  const before = mcpSeen.length;
  for (const [name, headers] of Object.entries(cases)) {
    const answer = await request("/mcp", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
    assert.equal(answer.status, 401, name);
    assert.equal(answer.json.error, "unauthorized", name);
    for (const claim of [PERSON_EMAIL, "boss@example.com", ACCESS_AUD, ACCESS_ISSUER, "0000.access"]) {
      assert.ok(!answer.text.includes(claim), `${name}: the answer does not echo ${claim}`);
    }
  }
  assert.equal(mcpSeen.length, before, "nothing refused reached the MCP bridge");
});

test("an unknown key id makes the gate fetch the team's keys once more, at most once a minute", async () => {
  const ownCerts = await startAccessCerts([signingKey]);
  try {
    const { port } = await launchGate(mcpEnv({ HONCHO_GATE_ACCESS_CERTS_URL: ownCerts.url }));
    const call = (key) => request("/mcp", { port, method: "POST", headers: assertionHeader(personClaims(), key), body: "{}" });

    assert.equal((await call(signingKey)).status, 200);
    assert.equal((await call(signingKey)).status, 200);
    assert.equal(ownCerts.fetches, 1, "the keys are fetched once and kept");

    // Cloudflare rotates in a new key: the first token signed with it is let in.
    ownCerts.keys = [signingKey, rotatedKey];
    assert.equal((await call(rotatedKey)).status, 200);
    assert.equal(ownCerts.fetches, 2, "one more fetch for the new key id");

    // A made-up key id within the same minute is refused without asking again.
    const madeUp = accessKey("kid-made-up");
    assert.equal((await call(madeUp)).status, 401);
    assert.equal((await call(madeUp)).status, 401);
    assert.equal(ownCerts.fetches, 2);
  } finally {
    await ownCerts.close();
  }
});

test("/mcp is not found until upstream, team domain, audience and token are all set", async () => {
  const partial = [
    { HONCHO_GATE_MCP_UPSTREAM: "", HONCHO_GATE_ACCESS_TEAM_DOMAIN: "", HONCHO_GATE_ACCESS_AUD: "", HONCHO_TEAM_MCP_TOKEN: "" },
    { HONCHO_GATE_MCP_UPSTREAM: "" },
    { HONCHO_GATE_ACCESS_TEAM_DOMAIN: "" },
    { HONCHO_GATE_ACCESS_AUD: " , " },
    { HONCHO_TEAM_MCP_TOKEN: " " },
  ];
  const before = mcpSeen.length;
  for (const overrides of partial) {
    const { port } = await launchGate(mcpEnv(overrides));
    const mcp = await request("/mcp", { port, method: "POST", headers: assertionHeader(), body: "{}" });
    assert.equal(mcp.status, 404, JSON.stringify(overrides));
    assert.equal(mcp.json.error, "not_found");
    const api = await request("/v3/workspaces/list", { port, method: "POST", headers: auth, body: "{}" });
    assert.equal(api.status, 201, "/v3 works the same without /mcp");
  }
  assert.equal(mcpSeen.length, before);
});

test("an Access login alone does not open /v3, and with the gate token /v3 passes Access headers through as before", async () => {
  const before = seen.length;
  const refused = await request("/v3/workspaces/list", { method: "POST", headers: assertionHeader(), body: "{}" });
  assert.equal(refused.status, 403, "a person's /v3 request needs a device key");
  assert.equal(seen.length, before);

  const headers = { ...auth, ...assertionHeader(), "x-honcho-user-name": "kept", cookie: "kept=1" };
  const answer = await request("/v3/workspaces/list", { method: "POST", headers, body: "{}" });
  assert.equal(answer.status, 201);
  const received = seen.at(-1);
  assert.equal(received.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(received.headers["cf-access-jwt-assertion"], headers["cf-access-jwt-assertion"]);
  assert.equal(received.headers["cf-access-authenticated-user-email"], undefined);
  assert.equal(received.headers["x-honcho-user-name"], "kept");
  assert.equal(received.headers.cookie, "kept=1");
});

test("without the Access team domain and audience only the gate token gets in", async () => {
  for (const overrides of [{ HONCHO_GATE_ACCESS_TEAM_DOMAIN: "" }, { HONCHO_GATE_ACCESS_AUD: " , " }]) {
    const { port } = await launchGate(mcpEnv(overrides));
    for (const [method, target, status] of [
      ["GET", "/team-memory/whoami", 404],
      ["POST", "/team-memory/devices", 404],
      ["POST", "/mcp", 404],
      ["POST", "/v3/workspaces/list", 401],
      ["GET", "/health", 401],
    ]) {
      const answer = await request(target, { port, method, headers: { ...loginAs(OWNER_EMAIL), ...json }, body: method === "POST" ? "{}" : undefined });
      assert.equal(answer.status, status, `${JSON.stringify(overrides)} ${method} ${target}`);
    }
    assert.equal((await request("/v3/workspaces/list", { port, method: "POST", headers: auth, body: "{}" })).status, 201);
    assert.equal((await request("/health", { port, headers: auth })).status, 201);
  }
});

// ------------------------------------------------------------------ Compose

/** The lines below one service's name in compose.yaml. */
function composeService(text, name) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `compose.yaml has the ${name} service`);
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

test("Compose gives the gate its state directory and the bridge the gate's scopes, and the gate's health check still passes", async () => {
  const compose = await fsp.readFile(COMPOSE, "utf8");
  const gateService = composeService(compose, "gate");
  assert.match(gateService, /^ {6}HONCHO_GATE_STATE_DIR: \/gate-state$/m);
  assert.match(gateService, /^ {6}- \.\.\/runtime\/gate:\/gate-state$/m, "mounted read-write");
  assert.match(composeService(compose, "mcp"), /^ {6}HONCHO_MCP_SCOPE_FROM_GATE: "1"$/m);

  const check = JSON.parse(/^ {6}test: (\[.*\])$/m.exec(gateService)[1]);
  assert.deepEqual(check.slice(0, 3), ["CMD", "node", "-e"]);
  const script = check[3].replace("http://127.0.0.1:8010/", `http://127.0.0.1:${gatePort}/`);
  assert.notEqual(script, check[3], "the check asks the gate's own port");
  const run = (token) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { env: { PATH: process.env.PATH, HONCHO_GATE_TOKEN: token }, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(await run(TOKEN), 0, "healthy with the gate token");
  assert.equal(await run("not-the-token"), 1);
});

/** One `NAME: value` line of a service's environment in compose.yaml, as written. */
function composeSetting(service, name) {
  return new RegExp(`^ {6}${name}: (.*)$`, "m").exec(service)?.[1];
}

test("the dashboard reads 조회 기록 from mcp's /audit with the token mcp checks, and the gate never passes /audit on", async () => {
  const compose = await fsp.readFile(COMPOSE, "utf8");
  const dashboard = composeService(compose, "dashboard");
  const mcp = composeService(compose, "mcp");
  assert.equal(composeSetting(mcp, "HONCHO_AUDIT_READ"), '"1"');
  assert.match(composeSetting(mcp, "HONCHO_AUDIT_DSN"), /@database:5432\//);
  const auditUrl = new URL(composeSetting(dashboard, "HONCHO_MCP_AUDIT_URL"));
  assert.equal(auditUrl.origin, `http://mcp:${JSON.parse(composeSetting(mcp, "HONCHO_MCP_PORT"))}`);
  assert.equal(auditUrl.pathname, "/audit");
  const mcpPath = composeSetting(mcp, "HONCHO_MCP_PATH");
  assert.equal(mcpPath, "/mcp");
  assert.ok(auditUrl.pathname !== mcpPath && !auditUrl.pathname.startsWith(`${mcpPath}/`), "outside what the gate passes to mcp");
  assert.equal(composeSetting(dashboard, "HONCHO_MCP_BEARER_TOKEN"), "${HONCHO_TEAM_MCP_TOKEN:-}");
  assert.equal(composeSetting(mcp, "HONCHO_MCP_BEARER_TOKEN"), composeSetting(dashboard, "HONCHO_MCP_BEARER_TOKEN"));
  // A server that is not shared has no mcp service at all, and its dashboard still starts.
  assert.doesNotMatch(dashboard, /^ {6}mcp:/m);
  assert.doesNotMatch(dashboard, /^ {4}profiles:/m);

  const before = mcpSeen.length;
  for (const target of ["/audit", "/audit?limit=1000", "/mcp/../audit", "/mcp/%2e%2e/audit", "/mcp/..%2faudit"]) {
    for (const headers of [loginAs(OWNER_EMAIL), auth]) {
      assert.equal((await request(target, { headers })).status, 404, target);
    }
  }
  assert.equal(mcpSeen.length, before, "no /audit reached the bridge");
});

test("mcp takes the Jev gate's settings from the private .env, off while they are empty, and the repository holds no key or guard token", async () => {
  const compose = await fsp.readFile(COMPOSE, "utf8");
  const mcp = composeService(compose, "mcp");
  const settings = {
    HONCHO_JEV_GATE: "${HONCHO_JEV_GATE:-}",
    // In a team: the hub's guard and this server's own token for it, which the app
    // writes to the .env; the key stays in the hub.
    HONCHO_JEV_GUARD_URL: "${HONCHO_JEV_GUARD_URL:-}",
    HONCHO_JEV_GUARD_TOKEN: "${HONCHO_JEV_GUARD_TOKEN:-}",
    TYPESAFE_API_KEY: "${TYPESAFE_API_KEY:-}",
    TYPESAFE_BASE_URL: "${TYPESAFE_BASE_URL:-}",
    HONCHO_JEV_MODEL: "${HONCHO_JEV_MODEL:-}",
    // The bridge reads these three as they are: an empty threshold stops it from
    // starting, and an empty tool list would judge nothing.
    HONCHO_JEV_THRESHOLD: "${HONCHO_JEV_THRESHOLD:-0.7}",
    HONCHO_JEV_FAIL_MODE: "${HONCHO_JEV_FAIL_MODE:-open}",
    HONCHO_JEV_TOOLS: "${HONCHO_JEV_TOOLS:-chat}",
  };
  for (const [name, value] of Object.entries(settings)) assert.equal(composeSetting(mcp, name), value, name);
  for (const service of ["dashboard", "gate", "tunnel"]) assert.doesNotMatch(composeService(compose, service), /JEV|TYPESAFE|GUARD/, service);

  const example = await fsp.readFile(path.join(ROOT, "server", ".env.example"), "utf8");
  for (const name of Object.keys(settings)) {
    assert.match(example, new RegExp(`^# ${name}: \\S`, "m"), `${name} is described in .env.example`);
    assert.doesNotMatch(example, new RegExp(`^${name}=`, "m"), `${name} has no value in .env.example`);
  }
});
