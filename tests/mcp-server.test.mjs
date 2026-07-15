import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "scripts", "mcp-server.mjs");
const EXPECTED_TOOLS = [
  "server_info", "inspect_workspace", "list_workspaces", "search", "get_metadata", "set_metadata", "create_peer",
  "list_peers", "chat", "get_peer_card", "set_peer_card", "get_peer_context", "get_representation", "create_session",
  "list_sessions", "delete_session", "clone_session", "add_peers_to_session", "remove_peers_from_session",
  "get_session_peers", "inspect_session", "add_messages_to_session", "get_session_messages", "get_session_message",
  "get_session_context", "list_conclusions", "query_conclusions", "create_conclusions", "delete_conclusion",
  "schedule_dream", "get_queue_status",
];

function startApi() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ status: "ok" }));
    else response.end(JSON.stringify({ items: [{ id: "message-1", content: "remembered" }], total: 1 }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function rpcClient(child) {
  let nextId = 1;
  const waiting = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  return (method, params = {}) => {
    const id = nextId++;
    const result = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  };
}

test("bundled MCP exposes all 31 tools, forwards search, and honors tool toggles", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-mcp-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const appHome = path.join(root, "app");
  const userHome = path.join(root, "user");
  const dataDir = path.join(appHome, "data");
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(
    path.join(appHome, "config.json"),
    JSON.stringify({
      version: 1,
      user: { peerId: "user_test" },
      honcho: { baseUrl: `http://127.0.0.1:${api.port}`, workspaceId: "memory" },
      agents: { codex: true, claude: false },
      paths: { dataDir },
    }),
  );
  const child = spawn(process.execPath, [SERVER, "--provider", "codex"], {
    env: { ...process.env, AGENT_MEMORY_HOME: appHome, AGENT_MEMORY_USER_HOME: userHome, HOME: userHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const rpc = rpcClient(child);

  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  assert.equal(initialized.serverInfo.name, "Agent Memory Honcho");
  const negotiated = await rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {} });
  assert.equal(negotiated.protocolVersion, "2025-11-25");
  await assert.rejects(rpc("initialize", { capabilities: {} }), /protocolVersion/);
  const listed = await rpc("tools/list");
  assert.equal(listed.tools.length, 31);
  assert.deepEqual(listed.tools.map((entry) => entry.name), EXPECTED_TOOLS);

  const search = await rpc("tools/call", { name: "search", arguments: { query: "project decision", limit: 4 } });
  assert.equal(search.isError, false);
  assert.equal(search.structuredContent.total, 1);
  const forwarded = api.requests.find((entry) => entry.url === "/v3/workspaces/memory/search");
  assert.deepEqual(forwarded.body, { query: "project decision", limit: 4 });

  await fsp.writeFile(path.join(dataDir, "mcp-tools.json"), JSON.stringify({ disabled_tools: ["delete_session"] }));
  const filtered = await rpc("tools/list");
  assert.equal(filtered.tools.length, 30);
  assert.equal(filtered.tools.some((entry) => entry.name === "delete_session"), false);
  const disabled = await rpc("tools/call", { name: "delete_session", arguments: { session_id: "s1" } });
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /disabled/);
});
