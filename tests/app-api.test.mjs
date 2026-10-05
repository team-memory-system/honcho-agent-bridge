// The app is one origin in front of three programs. What matters: each request
// lands on the program it names and nowhere else, the Honcho token is added by
// the server and never handed to the page, a program that is down is reported
// as down, and the tool switches write only tool names the MCP server knows.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { appContext, localTools, sessionsPage, setLocalTool } from "../scripts/app-api.mjs";
import { ALL_TOOLS, WRITE_TOOLS } from "../scripts/mcp-tool-defaults.mjs";
import { createUiServer } from "../scripts/ui.mjs";

const upstreams = {};
let ui;
let uiPort;
let workdir;
const saved = {};

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function recorder(name, respond) {
  upstreams[name] = { requests: [] };
  return async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    upstreams[name].requests.push({ method: request.method, url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : null });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(respond(request, raw ? JSON.parse(raw) : null)));
  };
}

function send(pathname, { method = "GET", body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: uiPort,
      path: pathname,
      method,
      headers: { host: `127.0.0.1:${uiPort}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

const MESSAGES = {
  "codex-1": [
    { id: "p", peer_id: "user_t", content: "<environment_context>\n  <cwd>/x</cwd>", metadata: { direct_user: true } },
    { id: "q", peer_id: "user_t", content: "통합 화면을 만들자\n자세한 건 나중에", metadata: { direct_user: true } },
    { id: "r", peer_id: "assistant_codex", content: "좋습니다. 먼저 목록부터 봅니다.", metadata: {} },
  ],
};

before(async () => {
  workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-app-"));
  for (const name of ["HONCHO_BASE_URL", "HONCHO_API_BEARER_TOKEN", "HONCHO_DASHBOARD_URL", "GATEWAY_UI_URL", "HONCHO_AGENT_BRIDGE_HOME"]) saved[name] = process.env[name];

  const honcho = await listen(recorder("honcho", (request) => {
    const url = new URL(request.url, "http://h");
    if (url.pathname.endsWith("/sessions/list")) {
      return { items: [{ id: "codex-1", created_at: "2026-09-30T10:00:00Z", metadata: { source: "codex", cwd: "/Users/t/dev/team-memory" } }], total: 1, page: 1, pages: 1 };
    }
    const messages = /\/sessions\/([^/]+)\/messages\/list$/.exec(url.pathname);
    if (messages) return { items: MESSAGES[decodeURIComponent(messages[1])] || [], total: 3, page: 1, pages: 1 };
    return { ok: true, path: url.pathname, search: url.search };
  }));
  const dashboard = await listen(recorder("dashboard", () => ({ tools: [], enabled_count: 0 })));
  const gateway = await listen(recorder("gateway", () => ({ ok: true, mode: "drain" })));
  process.env.HONCHO_BASE_URL = `http://127.0.0.1:${honcho.port}`;
  process.env.HONCHO_API_BEARER_TOKEN = "server-side-token";
  process.env.HONCHO_DASHBOARD_URL = `http://127.0.0.1:${dashboard.port}`;
  process.env.GATEWAY_UI_URL = `http://127.0.0.1:${gateway.port}`;
  process.env.HONCHO_AGENT_BRIDGE_HOME = workdir;
  upstreams.servers = [honcho.server, dashboard.server, gateway.server];

  ui = createUiServer();
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  uiPort = ui.address().port;
});

after(async () => {
  await new Promise((resolve) => ui.close(() => resolve()));
  for (const server of upstreams.servers) server.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fsp.rm(workdir, { recursive: true, force: true });
});

test("a Honcho request is relayed with this install's token, and only v3 routes are", async () => {
  upstreams.honcho.requests.length = 0;
  const response = await send("/api/honcho/v3/workspaces/memory/peers/list?page=2&size=5", { method: "POST", body: { filters: { a: 1 } } });
  assert.equal(response.status, 200);
  assert.equal(response.body.path, "/v3/workspaces/memory/peers/list");
  assert.equal(response.body.search, "?page=2&size=5");
  const [seen] = upstreams.honcho.requests;
  assert.equal(seen.headers.authorization, "Bearer server-side-token");
  assert.deepEqual(seen.body, { filters: { a: 1 } });

  assert.equal((await send("/api/honcho/admin/secrets")).status, 400);
});

test("the dashboard and the gateway each receive their own paths", async () => {
  upstreams.dashboard.requests.length = 0;
  upstreams.gateway.requests.length = 0;
  await send("/api/dashboard/mcp/tools");
  await send("/api/gw/api/mode", { method: "POST", body: { mode: "balance" } });
  assert.equal(upstreams.dashboard.requests[0].url, "/api/dashboard/mcp/tools");
  assert.equal(upstreams.dashboard.requests[0].headers.authorization, undefined, "the Honcho token is not sent to the dashboard");
  assert.equal(upstreams.gateway.requests[0].url, "/api/mode");
  assert.deepEqual(upstreams.gateway.requests[0].body, { mode: "balance" });
  assert.equal(upstreams.gateway.requests[0].headers.authorization, undefined, "the Honcho token is not sent to the gateway");
  assert.equal((await send("/api/gw/health")).status, 400, "only the gateway's API is relayed");
});

test("a login step reaches the gateway without an Origin, and its refusal comes back as it said it", async () => {
  // The gateway takes a POST only with no Origin or one equal to http://<Host>;
  // the relay sends none, and Host is the gateway's own.
  const seen = [];
  const refusing = await listen(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    seen.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) });
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "localhost:1455/auth/callback 로 시작하는 주소가 아닙니다" }));
  });
  const previous = process.env.GATEWAY_UI_URL;
  process.env.GATEWAY_UI_URL = `http://127.0.0.1:${refusing.port}`;
  try {
    const response = await send("/api/gw/api/login/callback", { method: "POST", body: { account: "codex-1", address: "http://localhost:9/x" } });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { ok: false, error: "localhost:1455/auth/callback 로 시작하는 주소가 아닙니다" });
    assert.equal(seen[0].url, "/api/login/callback");
    assert.deepEqual(seen[0].body, { account: "codex-1", address: "http://localhost:9/x" });
    assert.equal(seen[0].headers.origin, undefined);
    assert.equal(seen[0].headers.host, `127.0.0.1:${refusing.port}`);
    assert.equal(seen[0].headers["content-type"], "application/json");
  } finally {
    process.env.GATEWAY_UI_URL = previous;
    refusing.server.close();
  }
});

test("a program that is down is reported as down, not as an empty answer", async () => {
  const previous = process.env.GATEWAY_UI_URL;
  process.env.GATEWAY_UI_URL = "http://127.0.0.1:9";
  try {
    const response = await send("/api/gw/api/status");
    assert.equal(response.status, 502);
    assert.equal(response.body.unreachable, true);
    assert.match(response.body.error, /게이트웨이/);
  } finally {
    process.env.GATEWAY_UI_URL = previous;
  }
});

test("the page's context says where things are, and never carries the token", async () => {
  const context = await appContext({ config: { version: 1, user: { peerId: "user_t" }, honcho: { baseUrl: "http://127.0.0.1:1", apiToken: "saved-token", workspaceId: "ws" }, agents: { codex: true } }, ports: { installed: false } });
  assert.equal(context.configured, true);
  assert.equal(context.user.peerId, "user_t");
  assert.equal(context.workspace, "ws");
  assert.equal(context.honcho.hasToken, true);
  assert.equal(context.localServer, null);
  assert.equal(JSON.stringify(context).includes("saved-token"), false);
  assert.equal(JSON.stringify(context).includes("server-side-token"), false);
});

test("the context counts the teammates' memory Claude Code and Codex reach, and says when the old bridge settings are still saved", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-context-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(path.join(home, ".codex"), { recursive: true });
  await fsp.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "team-alice": { type: "http", url: "https://memory-alice.example.com/mcp" }, other: { command: "x" } } }));
  await fsp.writeFile(path.join(home, ".codex", "config.toml"), '[mcp_servers.team-alice]\nurl = "https://memory-alice.example.com/mcp"\n\n[mcp_servers.team-bob]\nurl = "https://memory-bob.example.com/mcp"\n');
  const teamOptions = { homeDir: home, env: {} };
  const config = { version: 1, user: { peerId: "user_t" }, honcho: { baseUrl: "http://127.0.0.1:1", workspaceId: "ws" }, agents: { codex: true } };
  const context = await appContext({ config, ports: { installed: false }, teamOptions });
  assert.deepEqual(context.teamMemory, { connected: 2, claude: 1, codex: 2 });
  assert.equal(context.oldBridge, false);
  assert.equal("sharedBridge" in context, false);

  const leftover = await appContext({ config: { version: 1, honcho: { mcpBridgeUrl: "https://bridge.example.com/mcp", mcpBridgeToken: "old-token" }, agents: { codex: false, claude: false } }, ports: { installed: false }, teamOptions: { homeDir: path.join(home, "none"), env: {} } });
  assert.equal(leftover.oldBridge, true);
  assert.equal(leftover.configured, false, "a file only the old bridge wrote does not count as set up");
  assert.deepEqual(leftover.teamMemory, { connected: 0, claude: 0, codex: 0 });
  assert.equal(JSON.stringify(leftover).includes("old-token"), false);
});

test("a conversation is named by what the person first said, not by a harness preamble", async () => {
  const page = await sessionsPage({ workspace: "memory", source: "codex" }, { config: null, ports: { installed: false } });
  assert.equal(page.total, 1);
  const [item] = page.items;
  assert.equal(item.title, "통합 화면을 만들자");
  assert.equal(item.preview, "좋습니다. 먼저 목록부터 봅니다.");
  assert.equal(item.source, "codex");
  assert.equal(item.project, "team-memory");
  const listing = upstreams.honcho.requests.find((request) => request.url.includes("/sessions/list"));
  assert.match(listing.url, /reverse=true/, "newest first");
  assert.deepEqual(listing.body, { filters: { metadata: { source: "codex" } } });
});

test("tool switches start at recall only and write only known names", async () => {
  const config = { version: 1, paths: { dataDir: path.join(workdir, "data") } };
  const initial = await localTools({ config });
  assert.equal(initial.tools.length, ALL_TOOLS.length);
  assert.deepEqual(initial.tools.filter((tool) => !tool.enabled).map((tool) => tool.name).sort(), [...WRITE_TOOLS].sort());

  const changed = await setLocalTool({ name: "create_peer", enabled: true }, { config });
  assert.equal(changed.tools.find((tool) => tool.name === "create_peer").enabled, true);
  const written = JSON.parse(await fsp.readFile(path.join(workdir, "data", "mcp-tools.json"), "utf8"));
  assert.equal(written.disabled_tools.includes("create_peer"), false);
  assert.equal(written.disabled_tools.includes("delete_session"), true);
  if (process.platform !== "win32") assert.equal((await fsp.stat(path.join(workdir, "data", "mcp-tools.json"))).mode & 0o077, 0);

  await assert.rejects(setLocalTool({ name: "rm_rf", enabled: true }, { config }), /Unknown MCP tool/);
  await assert.rejects(setLocalTool({ name: "chat", enabled: "yes" }, { config }), /true or false/);
});

test("a server token typed into the setup form reaches the CLI but not its command line", async () => {
  const response = await send("/api/setup/plan", { method: "POST", body: { userPeer: "probe", honchoUrl: "http://127.0.0.1:9", agents: "codex", apiToken: "typed-token" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.config.honcho.apiToken, "[redacted]", "the CLI received a token");
  const server = await fsp.readFile(new URL("../scripts/ui.mjs", import.meta.url), "utf8");
  assert.equal(/SETUP_OPTIONS = new Set\([^)]*apiToken/.test(server), false, "the token is not a command-line option");
});
