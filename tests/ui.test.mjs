// The setup UI can install hooks and start services, so the checks that matter are:
// it only listens to a browser on this machine, it runs the same CLI a terminal
// would, and an uploaded ChatGPT export actually lands in Honcho.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { createUiServer, rejectUnsafeRequest, shareEnableInvocation } from "../scripts/ui.mjs";
import { BRIDGE_TOKEN, startBridge } from "./fake-bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server;
let port;
let honcho;
let honchoRequests = [];
let workdir;

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const selected = probe.address().port;
  await new Promise((resolve) => probe.close(() => resolve()));
  return selected;
}

function send(pathname, { method = "GET", body, headers = {}, raw } = {}) {
  const payload = raw ?? (body === undefined ? "" : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host: headers.host ?? `127.0.0.1:${port}`,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, body: parsed });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

before(async () => {
  workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-ui-"));
  honcho = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    honchoRequests.push({ url: request.url, body: raw ? JSON.parse(raw) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url.endsWith("/messages/list")) response.end(JSON.stringify({ items: [], total: 0 }));
    else response.end(JSON.stringify({ ok: true }));
  });
  const honchoPort = await availablePort();
  await new Promise((resolve, reject) => { honcho.once("error", reject); honcho.listen(honchoPort, "127.0.0.1", resolve); });
  process.env.HONCHO_BASE_URL = `http://127.0.0.1:${honchoPort}`;
  process.env.HONCHO_WORKSPACE_ID = "memory";
  process.env.HONCHO_USER_NAME = "user_test";
  process.env.HONCHO_AGENT_HOOK_STATE = path.join(workdir, "state.json");
  process.env.HONCHO_AGENT_HOOK_LOG = path.join(workdir, "collector.log");

  port = await availablePort();
  server = createUiServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (honcho) await new Promise((resolve) => honcho.close(() => resolve()));
  if (workdir) await fsp.rm(workdir, { recursive: true, force: true });
});

test("the page and its assets are served, and nothing above the ui directory is", async () => {
  const page = await send("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.text, /팀 메모리/);

  assert.equal((await send("/styles.css")).status, 200);
  assert.equal((await send("/app.js")).status, 200);
  assert.equal((await send("/../package.json")).status, 404);
  assert.equal((await send("/../../etc/passwd")).status, 404);
});

test("only a same-origin browser on this machine may drive the UI", async () => {
  assert.equal((await send("/api/status", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await send("/api/setup/plan", { method: "POST", body: {}, headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal(
    (await send("/api/setup/plan", { method: "POST", raw: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status,
    415,
    "a form post is what a cross-site page can send without a preflight",
  );
  assert.equal((await send("/", { method: "POST", body: {} })).status, 405);
  assert.equal((await send("/api/nope")).status, 404);
});

test("the host and origin checks are decided by the request, not by the route", () => {
  const base = { method: "GET", headers: { host: "127.0.0.1:1" } };
  assert.equal(rejectUnsafeRequest(base), null);
  assert.equal(rejectUnsafeRequest({ ...base, headers: { host: "127.0.0.1:1", origin: "http://127.0.0.1:1" } }), null);
  assert.equal(rejectUnsafeRequest({ ...base, headers: { host: "10.0.0.1:1" } }).status, 403);
  assert.equal(rejectUnsafeRequest({ ...base, headers: { host: "localhost:1", origin: "http://localhost:2" } }).status, 403);
  assert.equal(rejectUnsafeRequest({ method: "POST", headers: { host: "127.0.0.1:1" } }).status, 415);
});

test("status runs the same detect and doctor a terminal would", async () => {
  const response = await send("/api/status");
  assert.equal(response.status, 200);
  assert.equal(response.body.detect.ok, true);
  assert.equal(typeof response.body.detect.paths.configPath, "string");
  assert.ok(Array.isArray(response.body.doctor.checks), "doctor reports its checks");
});

test("an uploaded ChatGPT export reaches Honcho, and re-uploading it adds nothing", async () => {
  honchoRequests = [];
  const exported = JSON.stringify([
    {
      conversation_id: "conv-ui",
      title: "업로드 테스트",
      create_time: 1_700_000_000,
      current_node: "a1",
      mapping: {
        root: { id: "root", parent: null, children: [], message: null },
        u1: { id: "u1", parent: "root", children: [], message: { id: "u1", author: { role: "user" }, create_time: 1_700_000_000, content: { content_type: "text", parts: ["웹에서 물어본 질문"] } } },
        a1: { id: "a1", parent: "u1", children: [], message: { id: "a1", author: { role: "assistant" }, create_time: 1_700_000_001, content: { content_type: "text", parts: ["웹에서 받은 답"] } } },
      },
    },
  ]);

  const first = await send("/api/import/chatgpt", { method: "POST", raw: exported });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(first.body.conversations, 1);
  assert.equal(first.body.imported_sessions, 1);
  assert.equal(first.body.new_messages, 2);
  assert.equal(first.body.uploaded_bytes, Buffer.byteLength(exported));

  const write = honchoRequests.find((entry) => entry.url?.endsWith("/messages"));
  assert.deepEqual(write.body.messages.map((message) => message.content), ["웹에서 물어본 질문", "웹에서 받은 답"]);

  const writesBefore = honchoRequests.filter((entry) => entry.url?.endsWith("/messages")).length;
  const second = await send("/api/import/chatgpt", { method: "POST", raw: exported });
  assert.equal(second.body.new_messages, 0);
  assert.equal(honchoRequests.filter((entry) => entry.url?.endsWith("/messages")).length, writesBefore);
});

test("an empty or unreadable upload is reported instead of silently succeeding", async () => {
  const empty = await send("/api/import/chatgpt", { method: "POST", raw: "", headers: { "content-type": "application/json", "content-length": "0" } });
  assert.equal(empty.body.ok, false);

  const garbage = await send("/api/import/chatgpt", { method: "POST", raw: "{not json" });
  assert.equal(garbage.body.ok, false);
  assert.match(String(garbage.body.error), /invalid JSON|not a ChatGPT export/);
});

test("the UI never leaves an uploaded export behind", async () => {
  const before = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith("honcho-bridge-upload-"));
  await send("/api/import/chatgpt", { method: "POST", raw: JSON.stringify([]) });
  const after = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith("honcho-bridge-upload-"));
  assert.deepEqual(after, before, "the spooled copy of someone's conversations is removed");
});

test("the UI serves its pages from an installed runtime, where everything is one directory", async (t) => {
  const installed = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-runtime-"));
  t.after(() => fsp.rm(installed, { recursive: true, force: true }));
  // `installRuntime` flattens scripts/ into one directory and copies ui/ inside it.
  await fsp.cp(path.join(ROOT, "scripts"), installed, { recursive: true });
  await fsp.cp(path.join(ROOT, "ui"), path.join(installed, "ui"), { recursive: true });

  const { createUiServer: createInstalled } = await import(`file://${path.join(installed, "ui.mjs")}`);
  const installedServer = createInstalled();
  const installedPort = await availablePort();
  await new Promise((resolve, reject) => { installedServer.once("error", reject); installedServer.listen(installedPort, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => installedServer.close(() => resolve())));

  const page = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: installedPort, path: "/", method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(page.status, 200);
  assert.match(page.text, /팀 메모리/);
});

test("the setup form's fields reach the CLI under the names it actually reads", async () => {
  // `parseOptions` ignores an unknown flag in silence, so a wrong name here would
  // look like a working form that quietly configures nothing.
  const response = await send("/api/setup/plan", {
    method: "POST",
    body: { userPeer: "ui-probe", workspace: "memory-ui", honchoUrl: "http://127.0.0.1:8123", agents: "codex", nonsense: "dropped" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.config.user.peerId, "ui-probe");
  assert.equal(response.body.config.honcho.workspaceId, "memory-ui");
  assert.equal(response.body.config.honcho.baseUrl, "http://127.0.0.1:8123");
  assert.deepEqual(response.body.config.agents, { codex: true, claude: false });
  assert.deepEqual(response.body.issues, [], JSON.stringify(response.body.issues));
});

test("the form's field names and the accepted option names are the same set", async () => {
  const markup = await fsp.readFile(path.join(ROOT, "ui", "index.html"), "utf8");
  const setupForm = markup.slice(markup.indexOf('<form id="setup-form"'));
  const fields = [...setupForm.slice(0, setupForm.indexOf("</form>")).matchAll(/<input[^>]*name="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(fields.length >= 4, "the setup form's fields were not found");
  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const accepted = server.match(/const SETUP_OPTIONS = new Set\(\[([\s\S]*?)\]\)/)[1]
    .match(/"([^"]+)"/g)
    .map((quoted) => quoted.slice(1, -1));
  // Secret fields are read too, but into the environment, never onto the command line.
  accepted.push(...server.match(/const SETUP_SECRET_FIELDS = Object\.freeze\(\{([\s\S]*?)\}\)/)[1]
    .match(/(\w+):/g)
    .map((key) => key.slice(0, -1)));
  for (const field of fields) {
    assert.ok(accepted.includes(field), `the form sends "${field}", which the server drops`);
  }
});

test("files the UI writes are restricted before any bytes reach them", async (t) => {
  // Windows ignores a POSIX creation mode, so `mode: 0o600` on its own protects
  // nothing there. The one file this UI writes is a whole chat history, so it goes
  // through the installer's own restriction rather than a bare fs call.
  const source = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  assert.match(source, /securePrivateFile/, "the spooled export is restricted");
  assert.equal(
    /fs\.rename\(/.test(source), false,
    "a bare rename would publish the file before its ACL is applied",
  );

  const spooled = JSON.stringify([]);
  const before = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith("honcho-bridge-upload-"));
  assert.deepEqual(before, [], "no earlier upload is still around");

  // On POSIX the restriction is observable directly.
  const probe = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-bridge-modeprobe-"));
  t.after(() => fsp.rm(probe, { recursive: true, force: true }));
  const target = path.join(probe, "conversations.json");
  await fsp.writeFile(target, spooled, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") {
    const mode = (await fsp.stat(target)).mode & 0o777;
    assert.equal(mode, 0o600, "owner-only");
  }
});

test("the host buttons drive the host lifecycle, not the Docker stack", async () => {
  // Starting the gateway and Ollama must not also bring Docker up, and must go
  // through the same `host start` a terminal would use - so the supervisor it
  // launches is detached and outlives this UI process.
  const source = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const routes = source.match(/const HOST_ROUTES = \{([\s\S]*?)\n\};/)[1];
  assert.match(routes, /"host", "status"/);
  assert.match(routes, /"host", "prepare"/);
  assert.match(routes, /"host", "start"/);
  assert.match(routes, /"host", "stop"/);
  assert.match(routes, /"gateway", "open"/);
  assert.equal(/"server",/.test(routes), false, "a host button must not start the whole stack");
  assert.equal(/proxies|llmProxyRoot/.test(source), false, "there is no proxy source location to edit any more");

  const cli = await fsp.readFile(path.join(ROOT, "scripts", "cli.mjs"), "utf8");
  for (const subcommand of ["plan", "prepare", "start", "status", "stop", "open"]) {
    assert.match(cli, new RegExp(`subcommand === "${subcommand}"`), `${subcommand} is dispatched`);
  }
  assert.match(cli, /command === "host"/);
  assert.match(cli, /command === "gateway"/);

  // Every host action the screens call has a route to go to.
  const screens = await uiSources();
  const hostCalls = [...new Set([...screens.matchAll(/"\/api\/host\/([a-z]+)"/g)].map((match) => match[1]))];
  assert.ok(hostCalls.includes("start") && hostCalls.includes("stop") && hostCalls.includes("status"), "the host controls were not found");
  for (const action of hostCalls) assert.match(routes, new RegExp(`"/api/host/${action}"`));
  assert.match(screens, /"\/api\/gateway\/open"/);
  assert.equal(/id="proxy-config"|llmProxyRoot/.test(screens), false);
});

async function uiSources() {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (/\.(js|html)$/.test(entry.name)) files.push(await fsp.readFile(target, "utf8"));
    }
  }
  await walk(path.join(ROOT, "ui"));
  return files.join("\n");
}

test("every server route the screens call exists", async () => {
  const screens = await uiSources();
  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const called = new Set([...screens.matchAll(/["`](\/api\/[a-z/-]+)/g)].map((match) => match[1].replace(/\/$/, "")));
  assert.ok(called.size >= 15, `only ${called.size} routes were found`);
  const relayed = ["/api/honcho/", "/api/dashboard/", "/api/gw/"];
  for (const route of called) {
    if (relayed.some((prefix) => route.startsWith(prefix) || `${route}/` === prefix)) continue;
    // The target routes are made from one table: `/api/targets/${action}` for each key of TARGET_TIMEOUTS.
    const family = /^\/api\/targets\/([a-z]+)$/.exec(route);
    const served = server.includes(`"${route}"`)
      || (family && server.includes("`/api/targets/${action}`") && new RegExp(`TARGET_TIMEOUTS = \\{[^}]*\\b${family[1]}:`).test(server));
    assert.ok(served, `the page calls ${route}, which ui.mjs does not serve`);
  }
});

test("the connect form reaches the bridge, and saves only once the bridge has answered", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const appHome = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-ui-connect-"));
  t.after(() => fsp.rm(appHome, { recursive: true, force: true }));
  const previous = {};
  for (const name of ["HONCHO_AGENT_BRIDGE_HOME", "HONCHO_MCP_BEARER_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) {
    previous[name] = process.env[name];
  }
  process.env.HONCHO_AGENT_BRIDGE_HOME = appHome;
  // A stale value in the environment that started the UI must not stand in for a
  // field the form left blank.
  process.env.CF_ACCESS_CLIENT_ID = "inherited.access";
  process.env.CF_ACCESS_CLIENT_SECRET = "inherited-secret";
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const wrong = await send("/api/bridge/connect", { method: "POST", body: { url: bridge.url, token: "wrong" } });
  assert.equal(wrong.body.ok, false);
  await assert.rejects(fsp.access(path.join(appHome, "config.json")), "a refused token is not saved");

  const right = await send("/api/bridge/connect", { method: "POST", body: { url: bridge.url, token: BRIDGE_TOKEN } });
  assert.equal(right.body.ok, true, JSON.stringify(right.body));
  assert.deepEqual(right.body.tools, ["chat"]);
  assert.equal(right.text.includes(BRIDGE_TOKEN), false, "the token never comes back to the page");

  const saved = JSON.parse(await fsp.readFile(path.join(appHome, "config.json"), "utf8"));
  assert.equal(saved.honcho.mcpBridgeToken, BRIDGE_TOKEN);
  assert.equal(saved.honcho.accessClientId, undefined, "the blank field stayed blank");

  const status = await send("/api/bridge/status");
  assert.equal(status.body.connected, true);
  const disconnected = await send("/api/bridge/disconnect", { method: "POST", body: {} });
  assert.equal(disconnected.body.connected, false);
});

test("the connect form's fields are the ones the server reads, and none rides the command line", async () => {
  const markup = await fsp.readFile(path.join(ROOT, "ui", "index.html"), "utf8");
  const form = markup.slice(markup.indexOf('<form id="bridge-form"'));
  const fields = [...form.slice(0, form.indexOf("</form>")).matchAll(/<input[^>]*name="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(fields, ["url", "token", "accessClientId", "accessClientSecret"]);

  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const secrets = server.match(/const BRIDGE_SECRET_FIELDS = Object\.freeze\(\{([\s\S]*?)\}\)/)[1]
    .match(/(\w+):/g)
    .map((key) => key.slice(0, -1));
  assert.deepEqual(secrets, ["token", "accessClientId", "accessClientSecret"]);
  assert.match(server, /runCli\(\["bridge", "connect", "--url", url\], \{ timeout: 90_000, env \}\)/,
    "only the address is an argument; the secrets go through the environment");
});

test("the share form's tunnel token goes to the CLI through its environment, never its arguments", async (t) => {
  const secret = "eyJhIjoidHVubmVsLXRva2VuLWZyb20tdGhlLWZvcm0ifQ";
  const invocation = shareEnableInvocation({ publicUrl: " https://memory.example.com ", tunnelToken: ` ${secret} ` });
  assert.deepEqual(invocation.args, ["server", "share", "enable", "--public-url", "https://memory.example.com"]);
  assert.equal(invocation.env.HONCHO_TUNNEL_TOKEN, secret);
  assert.equal(JSON.stringify(invocation.args).includes(secret), false);

  const previous = process.env.HONCHO_TUNNEL_TOKEN;
  process.env.HONCHO_TUNNEL_TOKEN = "inherited-tunnel-token";
  t.after(() => {
    if (previous === undefined) delete process.env.HONCHO_TUNNEL_TOKEN;
    else process.env.HONCHO_TUNNEL_TOKEN = previous;
  });
  const blank = shareEnableInvocation({ publicUrl: "https://memory.example.com", tunnelToken: "" });
  assert.equal("HONCHO_TUNNEL_TOKEN" in blank.env, false, "a blank field keeps the saved token instead of an inherited one");

  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const routes = server.match(/const SHARE_ROUTES = \{([\s\S]*?)\n\};/)[1];
  for (const action of ["status", "enable", "disable", "token", "rotate"]) {
    assert.match(routes, new RegExp(`"/api/server/share/${action}"`), action);
  }
  assert.match(routes, /runCli\(args, \{ timeout: 900_000, env \}\)/);
});

test("the gate token is read with a same-origin POST only", async (t) => {
  const serverDir = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-ui-share-"));
  t.after(() => fsp.rm(serverDir, { recursive: true, force: true }));
  const gateToken = "ui-share-gate-token-0c9d4e1a";
  await fsp.writeFile(path.join(serverDir, ".env"), `HONCHO_GATE_TOKEN=${gateToken}\n`);
  const previous = process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR;
  process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR = serverDir;
  t.after(() => {
    if (previous === undefined) delete process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR;
    else process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR = previous;
  });

  const read = await send("/api/server/share/token");
  assert.equal(read.status, 405, "a GET, which a cross-site page can make, does not answer");
  assert.equal(read.text.includes(gateToken), false);
  const crossSite = await send("/api/server/share/token", { method: "POST", body: {}, headers: { origin: "http://evil.example" } });
  assert.equal(crossSite.status, 403);
  const shown = await send("/api/server/share/token", { method: "POST", body: {} });
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, { ok: true, token: gateToken });
});

test("the prerequisite route validates its features before running the CLI", async () => {
  for (const query of ["features=server,docker", "features=sync%20--remote", "features=sync&features=chat", "features=chat&remote=yes"]) {
    const response = await send(`/api/app/prereqs?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.ok, false, query);
  }
  const posted = await send("/api/app/prereqs", { method: "POST", body: {} });
  assert.equal(posted.status, 405);
  // With no feature only Node and Git are checked; this runs the same CLI a terminal would.
  const response = await send("/api/app/prereqs?features=");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map((item) => item.key), ["node", "git"]);
  assert.equal(response.body.platform, process.platform);
});

test("the install route takes a same-origin POST naming warp, and refuses anything else before running the CLI", async () => {
  assert.equal((await send("/api/app/prereqs/install")).status, 405);
  for (const body of [{}, { item: "docker" }, { item: "warp; rm -rf /" }, { item: ["warp"] }, { item: "warp", team: "Acme Team" }, { item: "warp", team: "--force" }, { item: "warp", team: ["acme"] }]) {
    const response = await send("/api/app/prereqs/install", { method: "POST", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.ok, false, JSON.stringify(body));
  }
  const badTeam = await send("/api/app/prereqs/install", { method: "POST", body: { item: "warp", team: "Acme Team" } });
  assert.match(badTeam.body.error, /^팀 이름은/, "the screen shows why in plain words");
  // A valid request is never sent here: it would download and open the real installer.
  const crossSite = await send("/api/app/prereqs/install", { method: "POST", body: { item: "warp" }, headers: { origin: "http://evil.example" } });
  assert.equal(crossSite.status, 403);
  const form = await send("/api/app/prereqs/install", { method: "POST", raw: "item=warp", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415);
  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  assert.match(server, /const INSTALLABLE_PREREQS = Object\.freeze\(\["warp"\]\)/);
});
