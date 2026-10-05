// Another computer sends its conversations to the owner's memory server through a
// Cloudflare Tunnel behind Cloudflare Access. A program there presents an Access
// service token next to the server's bearer token. These tests hold the client
// half: the service token is set up the way the API token is, reaches the server on
// every path that talks to it and on no other, and a refusal by Access is reported
// as Access and not as something else.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appContext, relayDashboard, relayGateway, relayHoncho, sessionsPage } from "../scripts/app-api.mjs";
import { configEnvironment } from "../scripts/config.mjs";
import { isCloudflareAccessBlock } from "../scripts/honcho-access.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");
const MCP_SERVER = path.join(ROOT, "scripts", "mcp-server.mjs");

const ACCESS_ID = "access-id-value.access";
const ACCESS_SECRET = "access-secret-value";
const API_TOKEN = "server-api-token";
const ACCESS_WARNING = /is behind Cloudflare Access and refused this computer; add an Access service token for that server/;

// Every credential variable any of these programs reads starts out unset, whatever
// the environment running the tests holds.
const CREDENTIAL_ENV = [
  "HONCHO_API_TOKEN",
  "HONCHO_API_BEARER_TOKEN",
  "HONCHO_CF_ACCESS_CLIENT_ID",
  "HONCHO_CF_ACCESS_CLIENT_SECRET",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "HONCHO_MCP_BEARER_TOKEN",
  "HONCHO_AGENT_BRIDGE_CONFIG",
  "HONCHO_BASE_URL",
];

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of CREDENTIAL_ENV) delete env[name];
  for (const [name, value] of Object.entries(extra)) {
    if (value === "" || value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

async function cli(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: childEnv(env), timeout: 60_000 });
    return { stdout, body: JSON.parse(stdout) };
  } catch (error) {
    if (!error.stdout) throw error;
    return { stdout: error.stdout, body: JSON.parse(error.stdout) };
  }
}

async function sandbox(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-access-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  await fsp.mkdir(home, { recursive: true });
  return {
    root,
    appHome,
    configPath: path.join(appHome, "config.json"),
    env: {
      HONCHO_AGENT_BRIDGE_HOME: appHome,
      HONCHO_AGENT_BRIDGE_USER_HOME: home,
      HOME: home,
      USERPROFILE: home,
      CODEX_PLUGIN_ROOT: ROOT,
      CLAUDE_PLUGIN_ROOT: ROOT,
    },
  };
}

function listen(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    t.after(() => server.close());
    resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

/**
 * A memory server behind Access: with the service token it answers like Honcho;
 * without it, Access refuses, with a 403 carrying cf-mitigated or with a redirect
 * to its login page on the team's cloudflareaccess.com domain.
 */
async function accessProtectedHoncho(t, { refusal = "403" } = {}) {
  const requests = [];
  const { url } = await listen(t, async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : null });
    const passes = request.headers["cf-access-client-id"] === ACCESS_ID && request.headers["cf-access-client-secret"] === ACCESS_SECRET;
    if (!passes) {
      if (refusal === "302") {
        response.writeHead(302, { location: "https://x.cloudflareaccess.com/cdn-cgi/access/login/memory.example?kid=1" });
        response.end();
      } else {
        response.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
        response.end("<html><title>Forbidden</title></html>");
      }
      return;
    }
    response.setHeader("content-type", "application/json");
    const pathname = new URL(request.url, "http://h").pathname;
    if (pathname === "/health") response.end(JSON.stringify({ status: "ok" }));
    else if (pathname.endsWith("/search")) response.end(JSON.stringify([{ id: "m1", content: "remembered" }]));
    else if (pathname.endsWith("/messages/list")) response.end(JSON.stringify({ items: [], total: 0 }));
    else if (pathname.endsWith("/sessions/list")) response.end(JSON.stringify({ items: [], total: 0, page: 1, pages: 1 }));
    else response.end(JSON.stringify({ ok: true, items: [], total: 0 }));
  });
  return { url, requests };
}

const SETUP = ["--agents", "claude", "--user-peer", "user_test"];
const withAccess = { HONCHO_CF_ACCESS_CLIENT_ID: ACCESS_ID, HONCHO_CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET };

test("setup takes the service token from the environment only, as a pair, and never prints it", async (t) => {
  const honcho = await accessProtectedHoncho(t);
  const { configPath, env } = await sandbox(t);
  const setup = ["setup", "apply", ...SETUP, "--honcho-url", honcho.url];

  const onArgv = await cli([...setup, "--access-client-id", ACCESS_ID, "--access-client-secret", ACCESS_SECRET], env);
  assert.equal(onArgv.body.ready, false);
  assert.ok(onArgv.body.issues.some((line) => /through HONCHO_CF_ACCESS_CLIENT_ID and HONCHO_CF_ACCESS_CLIENT_SECRET, not the command line/.test(line)));
  await assert.rejects(fsp.access(configPath), "nothing is written when the token came on the command line");

  const half = await cli(["setup", "plan", ...SETUP, "--honcho-url", honcho.url], { ...env, HONCHO_CF_ACCESS_CLIENT_ID: ACCESS_ID });
  assert.equal(half.body.ready, false);
  assert.ok(half.body.issues.some((line) => /needs both HONCHO_CF_ACCESS_CLIENT_ID and HONCHO_CF_ACCESS_CLIENT_SECRET/.test(line)));
  const otherHalf = await cli(["setup", "plan", ...SETUP, "--honcho-url", honcho.url], { ...env, HONCHO_CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET });
  assert.equal(otherHalf.body.ready, false);

  const plan = await cli(["setup", "plan", ...SETUP, "--honcho-url", honcho.url], { ...env, ...withAccess, HONCHO_API_TOKEN: API_TOKEN });
  assert.equal(plan.body.ready, true, plan.stdout);
  assert.deepEqual(plan.body.config.honcho.access, { clientId: "[redacted]", clientSecret: "[redacted]" });
  assert.equal(plan.body.warnings.some((line) => ACCESS_WARNING.test(line)), false, "the probe presented the service token");

  const applied = await cli(setup, { ...env, ...withAccess, HONCHO_API_TOKEN: API_TOKEN });
  assert.equal(applied.body.ok, true, applied.stdout);
  for (const output of [plan.stdout, applied.stdout]) {
    for (const secret of [ACCESS_ID, ACCESS_SECRET, API_TOKEN]) assert.equal(output.includes(secret), false, "no credential is printed");
  }
  const saved = JSON.parse(await fsp.readFile(configPath, "utf8"));
  assert.deepEqual(saved.honcho.access, { clientId: ACCESS_ID, clientSecret: ACCESS_SECRET });
  assert.equal(saved.honcho.apiToken, API_TOKEN);
  assert.equal(saved.honcho.accessClientId, undefined, "the shared bridge's fields are not used for the memory server");

  const health = honcho.requests.filter((entry) => entry.url === "/health").at(-1);
  assert.equal(health.headers.authorization, `Bearer ${API_TOKEN}`);
  assert.equal(health.headers["cf-access-client-id"], ACCESS_ID);
  assert.equal(health.headers["cf-access-client-secret"], ACCESS_SECRET);

  // A later setup without them keeps them for the same server.
  const again = await cli(["setup", "apply", "--agents", "codex,claude"], env);
  assert.equal(again.body.ok, true, again.stdout);
  assert.deepEqual(JSON.parse(await fsp.readFile(configPath, "utf8")).honcho.access, { clientId: ACCESS_ID, clientSecret: ACCESS_SECRET });

  const doctor = await cli(["doctor"], env);
  assert.equal(doctor.body.checks.find((check) => check.name === "honcho-health").ok, true);
  assert.equal(doctor.body.checks.find((check) => check.name === "honcho-workspaces").ok, true);
  for (const secret of [ACCESS_ID, ACCESS_SECRET]) assert.equal(doctor.stdout.includes(secret), false);

  // Another server does not get them.
  const moved = await cli(["setup", "apply", "--honcho-url", "http://127.0.0.1:9"], env);
  assert.equal(moved.body.ok, true, moved.stdout);
  const afterMove = JSON.parse(await fsp.readFile(configPath, "utf8"));
  assert.equal(afterMove.honcho.access, undefined, "the service token does not follow the collector to another server");
});

test("moving to another server warns that the saved service token stays behind", async (t) => {
  const { env } = await sandbox(t);
  const first = await cli(["setup", "apply", ...SETUP, "--honcho-url", "http://127.0.0.1:9"], { ...env, ...withAccess });
  assert.equal(first.body.ok, true, first.stdout);
  const plan = await cli(["setup", "plan", "--honcho-url", "http://127.0.0.1:10"], env);
  assert.ok(plan.body.warnings.some((line) => /Cloudflare Access service token saved for http:\/\/127\.0\.0\.1:9 is not carried to http:\/\/127\.0\.0\.1:10/.test(line)));
  assert.equal(plan.body.config.honcho.access, undefined);
});

for (const refusal of ["403", "302"]) {
  test(`setup and doctor report a ${refusal} from Cloudflare Access as Access`, async (t) => {
    const honcho = await accessProtectedHoncho(t, { refusal });
    const { env } = await sandbox(t);
    const plan = await cli(["setup", "plan", ...SETUP, "--honcho-url", honcho.url], env);
    assert.ok(plan.body.warnings.some((line) => ACCESS_WARNING.test(line)), JSON.stringify(plan.body.warnings));
    assert.equal(plan.body.warnings.some((line) => /API token/.test(line)), false, "it is not reported as a token problem");

    const detect = await cli(["setup", "apply", ...SETUP, "--honcho-url", honcho.url], env);
    assert.equal(detect.body.ok, true, detect.stdout);
    const doctor = await cli(["doctor"], env);
    const health = doctor.body.checks.find((check) => check.name === "honcho-health");
    assert.equal(health.ok, false);
    assert.equal(health.code, "cloudflare-access");
    assert.match(health.reason, ACCESS_WARNING);
    assert.match(health.error, ACCESS_WARNING);
    assert.equal(doctor.body.ok, false);
    if (refusal === "302") {
      assert.equal(honcho.requests.some((entry) => entry.url.includes("cdn-cgi")), false, "the login redirect is not followed");
    }
  });
}

test("a plain 403 from the server itself is not taken for Access", async () => {
  const plain = new Response("forbidden", { status: 403, headers: { "content-type": "text/plain", "cf-ray": "abc" } });
  assert.equal(await isCloudflareAccessBlock(plain), false);
  const named = new Response("<html>Cloudflare Access: you are not allowed</html>", { status: 403 });
  assert.equal(await isCloudflareAccessBlock(named), true);
  assert.equal(await named.text(), "<html>Cloudflare Access: you are not allowed</html>", "the body is still readable");
  const header = new Response("", { status: 403, headers: { "cf-access-domain": "memory.example" } });
  assert.equal(await isCloudflareAccessBlock(header), true);
  const elsewhere = new Response(null, { status: 302, headers: { location: "https://login.example.com/" } });
  assert.equal(await isCloudflareAccessBlock(elsewhere), false);
  const spoof = new Response(null, { status: 302, headers: { location: "https://cloudflareaccess.com.evil.example/" } });
  assert.equal(await isCloudflareAccessBlock(spoof), false);
});

test("the hook environment carries the service token, and the collector sends it with the token", async (t) => {
  const honcho = await accessProtectedHoncho(t);
  const { root } = await sandbox(t);
  const transcript = path.join(root, "claude.jsonl");
  await fsp.writeFile(transcript, `${JSON.stringify({ uuid: "u1", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "remember this" } })}\n`);

  const hookEnv = configEnvironment({
    honcho: { baseUrl: honcho.url, workspaceId: "memory", apiToken: API_TOKEN, access: { clientId: ACCESS_ID, clientSecret: ACCESS_SECRET }, accessClientId: "bridge-id", accessClientSecret: "bridge-secret" },
    user: { peerId: "user_test" },
    paths: { dataDir: path.join(root, "data") },
  }, "claude");
  assert.equal(hookEnv.HONCHO_CF_ACCESS_CLIENT_ID, ACCESS_ID);
  assert.equal(hookEnv.HONCHO_CF_ACCESS_CLIENT_SECRET, ACCESS_SECRET);
  assert.equal(Object.values(hookEnv).includes("bridge-secret"), false, "the shared bridge's token is not the memory server's");

  const run = async (env) => {
    try {
      return JSON.parse((await execFileAsync(process.execPath, [COLLECTOR, "--provider", "claude", "--transcript", transcript], { env: childEnv(env) })).stdout);
    } catch (error) {
      return JSON.parse(String(error.stderr || error.stdout).trim().split("\n").at(-1));
    }
  };
  const result = await run(hookEnv);
  assert.equal(result.ok, true, JSON.stringify(result));
  const writes = honcho.requests.filter((entry) => entry.method === "POST");
  assert.ok(writes.length > 0);
  for (const entry of writes) {
    assert.equal(entry.headers.authorization, `Bearer ${API_TOKEN}`);
    assert.equal(entry.headers["cf-access-client-id"], ACCESS_ID);
    assert.equal(entry.headers["cf-access-client-secret"], ACCESS_SECRET);
  }

  // The older names still work when the hook environment has none.
  const before = honcho.requests.length;
  const legacy = await run({
    ...hookEnv,
    HONCHO_CF_ACCESS_CLIENT_ID: "",
    HONCHO_CF_ACCESS_CLIENT_SECRET: "",
    CF_ACCESS_CLIENT_ID: ACCESS_ID,
    CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
    HONCHO_AGENT_HOOK_STATE: path.join(root, "legacy-state.json"),
  });
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(honcho.requests.slice(before).every((entry) => entry.headers["cf-access-client-id"] === ACCESS_ID), true);

  // Without it, Access refuses and the collector says so.
  const refused = await run({ ...hookEnv, HONCHO_CF_ACCESS_CLIENT_ID: "", HONCHO_CF_ACCESS_CLIENT_SECRET: "", HONCHO_AGENT_HOOK_STATE: path.join(root, "refused-state.json") });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Cloudflare Access/);
});

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

test("the MCP server sends the memory server's service token in direct mode, not the bridge's", async (t) => {
  const honcho = await accessProtectedHoncho(t);
  const { appHome, env } = await sandbox(t);
  await fsp.mkdir(appHome, { recursive: true });
  await fsp.writeFile(path.join(appHome, "config.json"), JSON.stringify({
    version: 1,
    user: { peerId: "user_test" },
    honcho: {
      baseUrl: honcho.url,
      workspaceId: "memory",
      apiToken: API_TOKEN,
      access: { clientId: ACCESS_ID, clientSecret: ACCESS_SECRET },
      accessClientId: "bridge-id",
      accessClientSecret: "bridge-secret",
    },
    agents: { codex: true, claude: false },
    paths: { dataDir: path.join(appHome, "data") },
  }));
  const child = spawn(process.execPath, [MCP_SERVER, "--provider", "codex"], { env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const rpc = rpcClient(child);
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  const search = await rpc("tools/call", { name: "search", arguments: { query: "decision" } });
  assert.equal(search.isError, false, JSON.stringify(search));
  const seen = honcho.requests.find((entry) => entry.url === "/v3/workspaces/memory/search");
  assert.equal(seen.headers.authorization, `Bearer ${API_TOKEN}`);
  assert.equal(seen.headers["cf-access-client-id"], ACCESS_ID);
  assert.equal(seen.headers["cf-access-client-secret"], ACCESS_SECRET);
});

test("the MCP server reports a refusal by Access as Access", async (t) => {
  const honcho = await accessProtectedHoncho(t, { refusal: "302" });
  const { appHome, env } = await sandbox(t);
  await fsp.mkdir(appHome, { recursive: true });
  await fsp.writeFile(path.join(appHome, "config.json"), JSON.stringify({
    version: 1,
    user: { peerId: "user_test" },
    honcho: { baseUrl: honcho.url, workspaceId: "memory" },
    agents: { codex: true, claude: false },
    paths: { dataDir: path.join(appHome, "data") },
  }));
  const child = spawn(process.execPath, [MCP_SERVER, "--provider", "codex"], { env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const rpc = rpcClient(child);
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  const search = await rpc("tools/call", { name: "search", arguments: { query: "decision" } });
  assert.equal(search.isError, true);
  assert.match(search.content[0].text, ACCESS_WARNING);
});

/** A local stand-in for the app's server, driving the relays with a given config. */
async function appServer(t, options) {
  return listen(t, async (request, response) => {
    const url = new URL(request.url, "http://ui");
    if (url.pathname.startsWith("/api/honcho/")) return relayHoncho(request, response, url, options);
    if (url.pathname.startsWith("/api/dashboard/")) return relayDashboard(request, response, url, options);
    if (url.pathname.startsWith("/api/gw/")) return relayGateway(request, response, url, options);
    response.writeHead(404);
    response.end();
  });
}

async function recordingServer(t) {
  const requests = [];
  const { url } = await listen(t, async (request, response) => {
    for await (const _chunk of request) {}
    requests.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  return { url, requests };
}

test("the app's relay adds the service token for the memory server only", async (t) => {
  const honcho = await accessProtectedHoncho(t);
  const dashboard = await recordingServer(t);
  const gateway = await recordingServer(t);
  const config = {
    version: 1,
    user: { peerId: "user_t" },
    honcho: { baseUrl: honcho.url, workspaceId: "memory", apiToken: API_TOKEN, access: { clientId: ACCESS_ID, clientSecret: ACCESS_SECRET } },
    agents: { codex: true },
  };
  const options = { env: { HONCHO_DASHBOARD_URL: dashboard.url, GATEWAY_UI_URL: gateway.url }, config, ports: { installed: false } };
  const app = await appServer(t, options);

  const relayed = await fetch(`${app.url}/api/honcho/v3/workspaces/memory/peers/list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(relayed.status, 200);
  const seen = honcho.requests.at(-1);
  assert.equal(seen.headers.authorization, `Bearer ${API_TOKEN}`);
  assert.equal(seen.headers["cf-access-client-id"], ACCESS_ID);
  assert.equal(seen.headers["cf-access-client-secret"], ACCESS_SECRET);

  await fetch(`${app.url}/api/dashboard/mcp/tools`);
  await fetch(`${app.url}/api/gw/api/status`);
  for (const other of [dashboard, gateway]) {
    assert.equal(other.requests.length, 1);
    const { headers } = other.requests[0];
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["cf-access-client-id"], undefined, "the service token is not sent to another program");
    assert.equal(headers["cf-access-client-secret"], undefined);
  }

  const page = await sessionsPage({ workspace: "memory" }, options);
  assert.equal(page.ok, true);
  const listing = honcho.requests.find((entry) => entry.url.includes("/sessions/list"));
  assert.equal(listing.headers["cf-access-client-id"], ACCESS_ID);

  const context = await appContext(options);
  assert.equal(context.honcho.hasAccess, true);
  assert.equal(JSON.stringify(context).includes(ACCESS_ID), false);
  assert.equal(JSON.stringify(context).includes(ACCESS_SECRET), false);
  assert.equal((await appContext({ ...options, config: { ...config, honcho: { ...config.honcho, access: undefined } } })).honcho.hasAccess, false);
});

for (const refusal of ["403", "302"]) {
  test(`the app's relay answers a ${refusal} from Access with 502 and says it was Access`, async (t) => {
    const honcho = await accessProtectedHoncho(t, { refusal });
    const config = { version: 1, honcho: { baseUrl: honcho.url, workspaceId: "memory" } };
    const options = { env: {}, config, ports: { installed: false } };
    const app = await appServer(t, options);
    const response = await fetch(`${app.url}/api/honcho/v3/workspaces/memory/peers/list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.unreachable, false);
    assert.equal(body.access, true);
    assert.equal(body.error, "Cloudflare Access가 이 컴퓨터를 막았습니다. 그 서버의 Access 서비스 토큰을 넣으세요.");

    await assert.rejects(sessionsPage({ workspace: "memory" }, options), (error) => error.access === true && /Cloudflare Access/.test(error.message));
  });
}

test("bridge disconnect removes the old shared-bridge settings and leaves the memory server's service token alone", async (t) => {
  const { configPath, env } = await sandbox(t);
  const applied = await cli(["setup", "apply", ...SETUP, "--honcho-url", "http://127.0.0.1:9"], { ...env, ...withAccess });
  assert.equal(applied.body.ok, true, applied.stdout);
  // What `bridge connect` of 0.3.28 and before left in the file.
  let saved = JSON.parse(await fsp.readFile(configPath, "utf8"));
  saved.honcho = { ...saved.honcho, mcpBridgeUrl: "https://bridge.example.com/mcp", mcpBridgeToken: "old-bridge-token", accessClientId: "bridge-id", accessClientSecret: "bridge-secret" };
  await fsp.writeFile(configPath, JSON.stringify(saved, null, 2));

  const disconnected = await cli(["bridge", "disconnect"], env);
  assert.equal(disconnected.body.ok, true, disconnected.stdout);
  assert.equal(disconnected.body.changed, true);
  saved = JSON.parse(await fsp.readFile(configPath, "utf8"));
  for (const key of ["mcpBridgeUrl", "mcpBridgeToken", "accessClientId", "accessClientSecret"]) assert.equal(saved.honcho[key], undefined, key);
  assert.deepEqual(saved.honcho.access, { clientId: ACCESS_ID, clientSecret: ACCESS_SECRET });

  const again = await cli(["bridge", "disconnect"], env);
  assert.equal(again.body.ok, true, again.stdout);
  assert.equal(again.body.changed, false);
  const gone = await cli(["bridge", "connect", "--url", "https://bridge.example.com/mcp"], env);
  assert.equal(gone.body.ok, false);
  assert.match(gone.body.error || JSON.stringify(gone.body), /teammates connect/);
});

test("the setup form's service token reaches the CLI through its environment, never its command line", async (t) => {
  const { createUiServer } = await import("../scripts/ui.mjs");
  const { appHome, env } = await sandbox(t);
  const saved = {};
  for (const name of [...Object.keys(env), ...CREDENTIAL_ENV]) saved[name] = process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const name of CREDENTIAL_ENV) delete process.env[name];
  Object.assign(process.env, env);
  const ui = createUiServer();
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  t.after(() => ui.close());
  const base = `http://127.0.0.1:${ui.address().port}`;
  const plan = (body) => fetch(`${base}/api/setup/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userPeer: "probe", honchoUrl: "http://127.0.0.1:9", agents: "claude", ...body }),
  });

  const text = await (await plan({ accessClientId: ACCESS_ID, accessClientSecret: ACCESS_SECRET })).text();
  const body = JSON.parse(text);
  assert.deepEqual(body.config.honcho.access, { clientId: "[redacted]", clientSecret: "[redacted]" }, "the CLI received both halves");
  assert.equal(body.issues.some((line) => /command line/.test(line)), false, "neither rode the command line");
  assert.equal(text.includes(ACCESS_ID) || text.includes(ACCESS_SECRET), false);

  const half = await (await plan({ accessClientId: ACCESS_ID })).json();
  assert.ok(half.issues.some((line) => /needs both/.test(line)));

  const context = await (await fetch(`${base}/api/app/context`)).json();
  assert.equal(context.honcho.hasAccess, false);
  await assert.rejects(fsp.access(path.join(appHome, "config.json")), "a plan writes nothing");
});
