// When the config names an MCP bridge and this computer has no memory of its own,
// this process stops implementing the tools and relays to that bridge instead. That
// is what keeps a teammate's call inside the owner's audit log and judgment gate.
// A computer with both is tests/mcp-shared.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "scripts", "mcp-server.mjs");
const TOKEN = "bridge-token";

function startBridge({ sse = false } = {}) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const message = raw ? JSON.parse(raw) : null;
    seen.push({ headers: request.headers, message });

    if (message?.method === "initialize") {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "Local Honcho MCP", version: "1" },
        },
      });
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-abc" });
      response.end(body);
      return;
    }
    if (message && message.id === undefined) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("");
      return;
    }
    const result = message.method === "tools/list"
      ? { tools: [{ name: "chat", description: "Ask Honcho", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] }
      : { content: [{ type: "text", text: "relayed answer" }], isError: false };
    const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (sse) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${payload}\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

async function client(t, config) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-relay-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.writeFile(path.join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });

  const child = spawn(process.execPath, [SERVER, "--provider", "claude"], {
    env: { ...process.env, HONCHO_AGENT_BRIDGE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = waiting.get(message.id);
      if (resolve) { waiting.delete(message.id); resolve(message); }
    }
  });

  let id = 0;
  const send = (method, params) => {
    id += 1;
    const current = id;
    return new Promise((resolve) => {
      waiting.set(current, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    });
  };
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  return { send, stderr: () => stderr };
}

function relayConfig(port, extra = {}) {
  return {
    version: 1,
    honcho: {
      baseUrl: "http://127.0.0.1:1",
      workspaceId: "memory",
      mcpBridgeUrl: `http://127.0.0.1:${port}/mcp`,
      mcpBridgeToken: TOKEN,
      timeoutMs: 20_000,
      ...extra,
    },
    user: { peerId: "user_test" },
    peers: { assistants: { claude: "assistant_claude" } },
  };
}

test("a configured bridge decides the tool list, and the relay never calls Honcho directly", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { send } = await client(t, relayConfig(bridge.port));

  const list = await send("tools/list", {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["chat"], "the bridge's narrowed list wins over the local 31");

  const call = await send("tools/call", { name: "chat", arguments: { query: "지난주 결정" } });
  assert.equal(call.result.isError, false);
  assert.equal(call.result.content[0].text, "relayed answer");

  const forwarded = bridge.seen.map((entry) => entry.message?.method);
  assert.deepEqual(forwarded, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  const toolCall = bridge.seen.at(-1);
  assert.deepEqual(toolCall.message.params, { name: "chat", arguments: { query: "지난주 결정" } });
});

test("the relay presents the bearer token, the Access service token, and the session", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { send } = await client(t, relayConfig(bridge.port, {
    accessClientId: "client.access",
    accessClientSecret: "client-secret",
  }));

  await send("tools/list", {});
  const [initialize, , list] = bridge.seen;
  assert.equal(initialize.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(initialize.headers["cf-access-client-id"], "client.access");
  assert.equal(initialize.headers["cf-access-client-secret"], "client-secret");
  assert.equal(initialize.headers["mcp-session-id"], undefined, "there is no session before initialize answers");
  assert.equal(list.headers["mcp-session-id"], "session-abc", "the session the bridge handed back is reused");
  assert.match(list.headers["mcp-protocol-version"], /^2025-06-18$/, "the client's negotiated version is carried through");
});

test("an event-stream response is read the same as a JSON one", async (t) => {
  const bridge = await startBridge({ sse: true });
  t.after(() => bridge.server.close());
  const { send } = await client(t, relayConfig(bridge.port));

  const list = await send("tools/list", {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["chat"]);
});

test("an unreachable bridge is an error, not a silent fallback to the local tools", async (t) => {
  const bridge = await startBridge();
  const port = bridge.port;
  await new Promise((resolve) => bridge.server.close(() => resolve()));
  const { send } = await client(t, relayConfig(port));

  const list = await send("tools/list", {});
  assert.ok(list.error, "a broken bridge must not quietly expose the full local tool set");

  const call = await send("tools/call", { name: "chat", arguments: { query: "x" } });
  assert.equal(call.result.isError, true);
});

test("without a bridge URL the local tools are served as before", async (t) => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-tools-"));
  t.after(() => fsp.rm(empty, { recursive: true, force: true }));
  const toolConfigPath = path.join(empty, "tool-config.json");
  await fsp.writeFile(toolConfigPath, JSON.stringify({ version: 1, disabled_tools: [] }));

  const config = relayConfig(1);
  delete config.honcho.mcpBridgeUrl;
  config.mcp = { toolConfigPath };
  const { send } = await client(t, config);

  const list = await send("tools/list", {});
  assert.equal(list.result.tools.length, 31, "the direct mode still exposes the full tool set");
  assert.ok(list.result.tools.some((tool) => tool.name === "chat"));
  assert.ok(list.result.tools.some((tool) => tool.name === "search"), "a tool the bridge did not offer proves this is the local set");
});
