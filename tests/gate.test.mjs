// The share gate is the only thing the Cloudflare tunnel reaches, so what matters:
// nothing passes without the token, only /health and /v3/* pass at all, and what
// passes arrives upstream as it was sent and comes back as it is streamed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "server", "gate", "gate.mjs");
const TOKEN = "gate-test-token-6f1c0a8e";

let upstream;
let upstreamPort;
let gate;
let gatePort;
const seen = [];
let releaseStream = () => {};

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

function request(pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: gatePort, path: pathname, method, headers }, (res) => {
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
  gate = startGate({ HONCHO_GATE_TOKEN: TOKEN, HONCHO_GATE_UPSTREAM: `http://127.0.0.1:${upstreamPort}` });
  gatePort = await new Promise((resolve, reject) => {
    let buffered = "";
    gate.stdout.on("data", (chunk) => {
      buffered += chunk;
      const line = buffered.split("\n")[0];
      try { resolve(JSON.parse(line).port); } catch {}
    });
    gate.once("exit", (code) => reject(new Error(`gate exited with ${code}`)));
  });
});

after(async () => {
  gate?.kill();
  upstream?.closeAllConnections?.();
  if (upstream) await new Promise((resolve) => upstream.close(() => resolve()));
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
