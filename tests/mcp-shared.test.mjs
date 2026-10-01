// A computer that syncs its own conversations and is also connected to a teammate's
// shared bridge gets both: its own recall tools as always, and the bridge's tools
// as `shared_<name>`. A computer with only the bridge keeps the plain relay.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hasOwnMemory, sharedNote, sharedTools } from "../scripts/mcp-shared-tools.mjs";
import { ALL_TOOLS } from "../scripts/mcp-tool-defaults.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "scripts", "mcp-server.mjs");
const TOKEN = "bridge-token";
const CHAT_SCHEMA = { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"] };

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function startHoncho() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url.endsWith("/search")) response.end(JSON.stringify([{ id: "m1", content: "my own memory" }]));
    else if (request.url.endsWith("/chat")) response.end(JSON.stringify({ content: "my own answer" }));
    else response.end(JSON.stringify({ items: [], total: 0 }));
  });
  const port = await listen(server);
  return { server, requests, port };
}

async function startBridge({ tools = [{ name: "chat", description: "Ask Honcho", inputSchema: CHAT_SCHEMA }] } = {}) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const message = raw ? JSON.parse(raw) : null;
    seen.push({ headers: request.headers, message });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (message?.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Local Honcho MCP", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools };
    } else {
      result = { content: [{ type: "text", text: `teammate answer from ${message.params.name}` }], isError: false };
    }
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-shared" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const port = await listen(server);
  const close = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return { server, seen, port, url: `http://127.0.0.1:${port}/mcp`, host: `127.0.0.1:${port}`, close };
}

async function closedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function client(t, config, { disabledTools = [], args = [] } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-shared-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const dataDir = path.join(home, "data");
  await fsp.mkdir(dataDir, { recursive: true });
  const toolFile = path.join(dataDir, "mcp-tools.json");
  await fsp.writeFile(toolFile, JSON.stringify({ disabled_tools: disabledTools }));
  await fsp.writeFile(path.join(home, "config.json"), JSON.stringify({ ...config, paths: { dataDir } }), { mode: 0o600 });

  const child = spawn(process.execPath, [SERVER, "--provider", "claude", ...args], {
    env: { ...process.env, HONCHO_AGENT_BRIDGE_HOME: home, HONCHO_AGENT_BRIDGE_USER_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());

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
  return { send, toolFile };
}

/** A computer that syncs to its own server, and is also connected to a shared bridge. */
function bothConfig(honchoPort, bridgeUrl) {
  return {
    version: 1,
    user: { peerId: "user_test" },
    honcho: {
      baseUrl: `http://127.0.0.1:${honchoPort}`,
      workspaceId: "memory",
      mcpBridgeUrl: bridgeUrl,
      mcpBridgeToken: TOKEN,
      timeoutMs: 20_000,
    },
    agents: { codex: false, claude: true },
    peers: { assistants: { claude: "assistant_claude" } },
  };
}

/** What `bridge connect` writes on a computer that does nothing else. */
function bridgeOnlyConfig(bridgeUrl) {
  return {
    version: 1,
    agents: { codex: false, claude: false },
    honcho: { mcpBridgeUrl: bridgeUrl, mcpBridgeToken: TOKEN, timeoutMs: 20_000 },
  };
}

const names = (list) => list.result.tools.map((entry) => entry.name);

test("own memory and a shared bridge: the local tools, plus the bridge's as shared_*", async (t) => {
  const honcho = await startHoncho();
  t.after(() => honcho.server.close());
  const bridge = await startBridge();
  t.after(bridge.close);
  const { send } = await client(t, bothConfig(honcho.port, bridge.url), { disabledTools: ["delete_session"] });

  const list = await send("tools/list", {});
  const listed = names(list);
  assert.deepEqual(listed.filter((name) => !name.startsWith("shared_")), ALL_TOOLS.filter((name) => name !== "delete_session"),
    "the local tools are exactly what they were, switches included");
  assert.deepEqual(listed.filter((name) => name.startsWith("shared_")), ["shared_chat"]);
  const shared = list.result.tools.find((entry) => entry.name === "shared_chat");
  assert.equal(shared.description, `${sharedNote(bridge.host)} Ask Honcho`);
  assert.match(shared.description, /^Asks the shared memory at 127\.0\.0\.1:\d+ \(a teammate's memory\), not yours\./);
  assert.deepEqual(shared.inputSchema, CHAT_SCHEMA, "the bridge's schema passes through unchanged");

  const sharedCall = await send("tools/call", { name: "shared_chat", arguments: { query: "what did we decide?" } });
  assert.equal(sharedCall.result.isError, false);
  assert.equal(sharedCall.result.content[0].text, "teammate answer from chat");
  const relayed = bridge.seen.filter((entry) => entry.message?.method === "tools/call");
  assert.deepEqual(relayed.map((entry) => entry.message.params), [{ name: "chat", arguments: { query: "what did we decide?" } }],
    "the prefix is stripped on the way to the bridge");

  const search = await send("tools/call", { name: "search", arguments: { query: "my decision" } });
  assert.equal(search.result.isError, false);
  assert.deepEqual(search.result.structuredContent, { result: [{ id: "m1", content: "my own memory" }] });
  assert.ok(honcho.requests.some((entry) => entry.url === "/v3/workspaces/memory/search"), "search reached this user's own Honcho");

  const ownChat = await send("tools/call", { name: "chat", arguments: { query: "about me" } });
  assert.equal(ownChat.result.isError, false);
  assert.ok(honcho.requests.some((entry) => entry.url === "/v3/workspaces/memory/peers/assistant_claude/chat"),
    "the unprefixed chat is this user's own");
  assert.equal(bridge.seen.filter((entry) => entry.message?.method === "tools/call").length, 1, "only shared_chat went to the bridge");
});

test("a bridge-only computer keeps the plain relay, with the bridge's own names", async (t) => {
  const bridge = await startBridge();
  t.after(bridge.close);
  const { send } = await client(t, bridgeOnlyConfig(bridge.url));

  const list = await send("tools/list", {});
  assert.deepEqual(names(list), ["chat"]);
  assert.equal(list.result.tools[0].description, "Ask Honcho", "nothing is added to the bridge's own description");

  const call = await send("tools/call", { name: "chat", arguments: { query: "x" } });
  assert.equal(call.result.content[0].text, "teammate answer from chat");
});

test("an unreachable bridge leaves the local tools listed and working, and shared calls fail clearly", async (t) => {
  const honcho = await startHoncho();
  t.after(() => honcho.server.close());
  const port = await closedPort();
  const { send } = await client(t, bothConfig(honcho.port, `http://127.0.0.1:${port}/mcp`));

  const list = await send("tools/list", {});
  assert.ok(list.result, "the list itself does not fail");
  assert.deepEqual(names(list), [...ALL_TOOLS], "every local tool, and no shared tool from a bridge never reached");

  const search = await send("tools/call", { name: "search", arguments: { query: "still here" } });
  assert.equal(search.result.isError, false);

  const call = await send("tools/call", { name: "shared_chat", arguments: { query: "x" } });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, new RegExp(`shared memory at 127\\.0\\.0\\.1:${port} \\(a teammate's memory\\) failed`));
  assert.match(call.result.content[0].text, /own memory tools are unaffected/);
});

test("a bridge that goes down after listing makes only the shared call fail", async (t) => {
  const honcho = await startHoncho();
  t.after(() => honcho.server.close());
  const bridge = await startBridge();
  const { send } = await client(t, bothConfig(honcho.port, bridge.url));

  assert.ok(names(await send("tools/list", {})).includes("shared_chat"));
  await bridge.close();

  const again = await send("tools/list", {});
  assert.ok(names(again).includes("search"));
  const call = await send("tools/call", { name: "shared_chat", arguments: { query: "x" } });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /a teammate's memory\) failed/);
  const search = await send("tools/call", { name: "search", arguments: { query: "x" } });
  assert.equal(search.result.isError, false);
});

test("the local tool switches never hide shared tools, and shared tools are never written to mcp-tools.json", async (t) => {
  const honcho = await startHoncho();
  t.after(() => honcho.server.close());
  const bridge = await startBridge();
  t.after(bridge.close);
  // Switching off the local chat, and even naming the shared one, changes nothing on the shared side.
  const disabled = ["chat", "shared_chat", "search"];
  const { send, toolFile } = await client(t, bothConfig(honcho.port, bridge.url), { disabledTools: disabled });

  const listed = names(await send("tools/list", {}));
  assert.equal(listed.includes("chat"), false);
  assert.equal(listed.includes("search"), false);
  assert.equal(listed.includes("shared_chat"), true);
  const call = await send("tools/call", { name: "shared_chat", arguments: { query: "x" } });
  assert.equal(call.result.isError, false);
  const local = await send("tools/call", { name: "chat", arguments: { query: "x" } });
  assert.equal(local.result.isError, true);
  assert.match(local.result.content[0].text, /disabled/);

  assert.deepEqual(JSON.parse(await fsp.readFile(toolFile, "utf8")), { disabled_tools: disabled }, "listing writes nothing");
  assert.equal(ALL_TOOLS.some((name) => name.startsWith("shared_")), false, "the dashboard's switch list holds local tools only");
});

test("the CLI's probes can ask for one side only", async (t) => {
  const honcho = await startHoncho();
  t.after(() => honcho.server.close());
  const bridge = await startBridge();
  t.after(bridge.close);

  const onlyBridge = await client(t, bothConfig(honcho.port, bridge.url), { args: ["--only", "bridge"] });
  assert.deepEqual(names(await onlyBridge.send("tools/list", {})), ["chat"], "`bridge connect` checks the bridge itself");

  const onlyLocal = await client(t, bothConfig(honcho.port, bridge.url), { args: ["--only", "local"] });
  assert.deepEqual(names(await onlyLocal.send("tools/list", {})), [...ALL_TOOLS]);

  const port = await closedPort();
  const down = await client(t, bothConfig(honcho.port, `http://127.0.0.1:${port}/mcp`), { args: ["--only", "bridge"] });
  assert.ok((await down.send("tools/list", {})).error, "a probe of a down bridge fails even when local tools exist");
});

test("a shared name that would collide with a local tool is skipped", () => {
  const bridgeTools = [
    { name: "chat", description: "Ask Honcho", inputSchema: CHAT_SCHEMA },
    { name: "search", description: "Search", inputSchema: { type: "object" } },
    { name: "chat", description: "A duplicate from the bridge" },
    { description: "no name" },
  ];
  // No local tool starts with shared_ today; a future one must win over the bridge's.
  const listed = sharedTools(bridgeTools, { host: "bridge.example", localNames: ["search", "shared_search"] });
  assert.deepEqual(listed.map((entry) => entry.name), ["shared_chat"]);
  assert.deepEqual(listed[0].inputSchema, CHAT_SCHEMA);
  assert.equal(listed[0].description, "Asks the shared memory at bridge.example (a teammate's memory), not yours. Ask Honcho");

  const down = sharedTools(bridgeTools.slice(0, 1), { host: "bridge.example", localNames: [], unreachable: true });
  assert.match(down[0].description, /unreachable right now/);
});

test("own memory means a server, a user and an agent whose conversations are sent", () => {
  assert.equal(hasOwnMemory({ honcho: { baseUrl: "http://127.0.0.1:8001" }, user: { peerId: "u" }, agents: { claude: true } }), true);
  assert.equal(hasOwnMemory({ honcho: { mcpBridgeUrl: "https://b" }, agents: { codex: false, claude: false } }), false);
  assert.equal(hasOwnMemory({ honcho: { baseUrl: "http://127.0.0.1:8001" }, user: { peerId: "u" }, agents: { claude: false } }), false);
  assert.equal(hasOwnMemory({ honcho: { baseUrl: "http://127.0.0.1:8001" }, user: { peerId: "u" } }), false);
});
