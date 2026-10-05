// The share gate is the only thing the Cloudflare tunnel reaches, so what matters:
// nothing passes without the token, only /health and /v3/* pass at all, and what
// passes arrives upstream as it was sent and comes back as it is streamed. /mcp is
// the one door without the token: only a person's verified Cloudflare Access login
// opens it, and the MCP bridge sees the gate's credentials, never the caller's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
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
const TOKEN = "gate-test-token-6f1c0a8e";
const TEAM_MCP_TOKEN = "team-mcp-test-token-2d9b7e41";

let upstream;
let upstreamPort;
let gate;
let gatePort;
const seen = [];
let releaseStream = () => {};
let mcpUpstream;
let mcpPort;
const mcpSeen = [];
let releaseMcpStream = () => {};
let certs;
const gates = [];
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

function startGate(env) {
  const child = spawn(process.execPath, [GATE], {
    env: { PATH: process.env.PATH, HONCHO_GATE_LISTEN_HOST: "127.0.0.1", HONCHO_GATE_LISTEN_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

/** A gate that is listening, with its port. Killed after all tests. */
async function launchGate(env) {
  const child = startGate(env);
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
  return { child, port };
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

const auth = { authorization: `Bearer ${TOKEN}` };

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
  ({ child: gate, port: gatePort } = await launchGate(mcpEnv()));
});

after(async () => {
  for (const child of gates) child.kill();
  for (const server of [upstream, mcpUpstream]) {
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }
  await certs?.close();
});

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
    headers: { ...auth, "content-type": "application/json", "x-custom": "kept", connection: "keep-alive, x-drop", "x-drop": "1" },
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
  assert.equal(received.headers.host, `127.0.0.1:${upstreamPort}`, "Host is the API's own");
});

test("a streamed answer arrives chunk by chunk", async () => {
  const chunks = await new Promise((resolve, reject) => {
    const received = [];
    const req = http.request({ hostname: "127.0.0.1", port: gatePort, path: "/v3/stream", method: "POST", headers: auth }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["transfer-encoding"], "chunked");
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        received.push(chunk);
        // The upstream only finishes once the first event came through, so a gate
        // that buffered the whole answer would never get here.
        if (received.length === 1) releaseStream();
      });
      res.on("end", () => resolve(received));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("the stream was buffered")));
    req.end("{}");
  });
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

// ---------------------------------------------------------------- /mcp

const assertionHeader = (claims = personClaims(), key = signingKey, header) =>
  ({ "cf-access-jwt-assertion": signAssertion(key, claims, header) });

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
  assert.equal(received.headers.host, `127.0.0.1:${mcpPort}`);
  assert.equal(received.headers["mcp-session-id"], "session-1");
  assert.equal(received.headers.accept, "application/json, text/event-stream");
  for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-id", "x-honcho-workspace-id", "x-honcho-user-name"]) {
    assert.equal(received.headers[name], undefined, `${name} is dropped`);
  }
  assert.equal(seen.length, before, "nothing went to the API");

  // Any method, and paths below /mcp.
  const removed = await request("/mcp/", { method: "DELETE", headers: assertionHeader() });
  assert.equal(removed.status, 200);
  assert.equal(mcpSeen.at(-1).method, "DELETE");
  assert.equal(mcpSeen.at(-1).url, "/mcp/");
});

test("expiry and not-before allow up to 60 seconds of clock difference", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [personClaims({ exp: now - 30 }), personClaims({ nbf: now + 30 })]) {
    const answer = await request("/mcp", { method: "POST", headers: assertionHeader(claims), body: "{}" });
    assert.equal(answer.status, 200, JSON.stringify(claims));
  }
});

test("an MCP stream arrives chunk by chunk", async () => {
  const chunks = await new Promise((resolve, reject) => {
    const received = [];
    const req = http.request({
      hostname: "127.0.0.1", port: gatePort, path: "/mcp", method: "GET",
      headers: { ...assertionHeader(), accept: "text/event-stream" },
    }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "text/event-stream");
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        received.push(chunk);
        if (received.length === 1) releaseMcpStream();
      });
      res.on("end", () => resolve(received));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("the stream was buffered")));
    req.end();
  });
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

test("an Access login does not open /v3, and /v3 passes Access headers through as before", async () => {
  const before = seen.length;
  const refused = await request("/v3/workspaces/list", { method: "POST", headers: assertionHeader(), body: "{}" });
  assert.equal(refused.status, 401);
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
