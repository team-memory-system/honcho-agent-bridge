import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  deriveHostTopology,
  hostPlan,
  hostPrepare,
  hostStart,
  hostStatus,
  hostStop,
  parseDotEnv,
  resolveHostPaths,
  windowsBatchInvocation,
} from "../scripts/host-manager.mjs";

const execFileAsync = promisify(execFile);
const OS_REGISTRATION = /launchctl|schtasks|systemctl|^reg(?:\.exe)?$/i;

function response(data = {}, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// The gateway CLI is a separate program; every test talks to a stand-in through the
// injectable runner. Its file only has to exist, because the runner is never real.
async function placeGatewayCli(directory) {
  await fsp.mkdir(path.join(directory, "gateway"), { recursive: true });
  await fsp.writeFile(path.join(directory, "gateway", "cli.mjs"), "// stand-in; never executed\n");
}

function gatewayStatusDocument({ routerOk = true, loggedIn = true } = {}) {
  return {
    ok: true,
    ui: { url: "http://127.0.0.1:11450", ok: true },
    router: { url: "http://127.0.0.1:11400/v1", ok: routerOk },
    autostart: { kind: "launchd", installed: true },
    accounts: loggedIn ? [{ id: "codex-1", backend: "codex", loggedIn: true, serving: routerOk }] : [],
    models: loggedIn ? ["gpt-6-luna"] : [],
  };
}

function healthyGatewayRunner(calls = []) {
  return async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd || "" });
    if (args[1] === "install") {
      return { code: 0, stdout: JSON.stringify({ ok: true, autostart: "launchd", uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" }) };
    }
    if (args[1] === "status") return { code: 0, stdout: JSON.stringify(gatewayStatusDocument()) };
    return { code: 1, stdout: JSON.stringify({ ok: false, error: `unexpected ${args[1]}` }) };
  };
}

test("dotenv and topology derivation discard credentials and translate Docker host endpoints", () => {
  const environment = parseDotEnv(`
LLM_VLLM_API_KEY="private-shared-value"
DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11400/v1
DERIVER_MODEL_CONFIG__MODEL=gpt-6-luna
EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192
EMBEDDING_MAX_INPUT_TOKENS=8192
EMBEDDING_VECTOR_DIMENSIONS=1536
`);
  const root = path.join(os.tmpdir(), "honcho-agent-bridge-topology");
  const homeDir = path.join(root, "home");
  const paths = { ...resolveHostPaths({ installedServerDir: path.join(root, "server"), platform: "darwin", env: {}, homeDir }), homeDir, env: {} };
  const topology = deriveHostTopology({ environment, paths, platform: "darwin" });

  assert.deepEqual(topology.gateway, {
    directory: path.join(root, "runtime", "subscription-gateway"),
    uiUrl: "http://127.0.0.1:11450",
    routerUrl: "http://127.0.0.1:11400/v1",
  });
  assert.equal("proxies" in topology, false, "there are no proxies to manage any more");
  assert.equal("proxy" in topology, false);
  assert.equal(topology.ollama.baseUrl, "http://127.0.0.1:11434");
  assert.equal(topology.ollama.contextLength, 8192);
  assert.equal(topology.ollama.dimensions, 1536);
  assert.equal(topology.ollama.keepAlive, -1);
  assert.equal(JSON.stringify(topology).includes("private-shared-value"), false);
});

test("non-secret host profile overrides topology and rejects secret-bearing fields", () => {
  const root = path.join(os.tmpdir(), "honcho-agent-bridge-profile");
  const homeDir = path.join(root, "home");
  const paths = { ...resolveHostPaths({ installedServerDir: path.join(root, "server"), platform: "linux", env: {}, homeDir }), homeDir, env: {} };
  const topology = deriveHostTopology({
    environment: {},
    profileConfig: {
      gateway: { uiUrl: "http://127.0.0.1:22150", routerUrl: "http://localhost:22100/v1/" },
      ollama: { enabled: true, baseUrl: "http://127.0.0.1:22134", model: "qwen3-embedding-honcho-8192", contextLength: 8192 },
    },
    paths,
    platform: "linux",
  });
  assert.equal(topology.gateway.uiUrl, "http://127.0.0.1:22150");
  assert.equal(topology.gateway.routerUrl, "http://localhost:22100/v1");
  assert.equal(topology.ollama.baseUrl, "http://127.0.0.1:22134");
  assert.throws(
    () => deriveHostTopology({ environment: {}, profileConfig: { gateway: { apiKey: "must-not-live-here" } }, paths }),
    /must not contain secret field/,
  );
  assert.throws(
    () => deriveHostTopology({ environment: {}, profileConfig: { gateway: { routerUrl: "http://example.test:11400/v1" } }, paths }),
    /loopback/,
    "the router Honcho is pointed at is always on this machine",
  );
  assert.throws(
    () => deriveHostTopology({ environment: {}, profileConfig: { ollama: { keepAlive: "forever" } }, paths }),
    /keep-alive setting/,
  );
});

test("Windows batch commands use cmd.exe without Node shell interpolation", () => {
  const invocation = windowsBatchInvocation(
    "C:\\Program Files\\nodejs\\npm.cmd",
    ["exec", "--yes", "pnpm@10.14.0", "--", "install"],
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  );
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args, [
    '/d /s /v:off /c ""C:\\Program Files\\nodejs\\npm.cmd" "exec" "--yes" "pnpm@10.14.0" "--" "install""',
  ]);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.throws(() => windowsBatchInvocation("C:\\npm.cmd", ['bad"argument'], {}), /unsupported characters/);
  assert.throws(() => windowsBatchInvocation("C:\\100%\\npm.cmd", [], {}), /unsupported characters/);
});

async function hostFixture(root) {
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const hostDir = path.join(serverDir, "host");
  await fsp.mkdir(hostDir, { recursive: true });
  await fsp.copyFile(new URL("../server/host-profile.personal.json", import.meta.url), path.join(serverDir, "host-profile.personal.json"));
  await fsp.copyFile(new URL("../server/gateway-source.json", import.meta.url), path.join(serverDir, "gateway-source.json"));
  await fsp.writeFile(path.join(serverDir, ".env"), `
LLM_VLLM_API_KEY=private-router-key-never-print-0123456789
LLM_VLLM_BASE_URL=http://host.docker.internal:11400/v1
EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192
EMBEDDING_MAX_INPUT_TOKENS=8192
EMBEDDING_VECTOR_DIMENSIONS=1536
`);
  await fsp.copyFile(new URL("../server/host/supervisor.mjs", import.meta.url), path.join(hostDir, "supervisor.mjs"));
  await fsp.writeFile(path.join(hostDir, "qwen3-embedding-8192.Modelfile"), "FROM qwen3-embedding:8b\nPARAMETER num_ctx 8192\n");

  const tools = path.join(root, "tools");
  await fsp.mkdir(tools);
  const ollama = path.join(tools, "ollama");
  await fsp.writeFile(ollama, "");
  const calls = [];
  const models = new Set();
  const run = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "which") return args[0] === "ollama" ? { ok: true, stdout: `${ollama}\n` } : { ok: false };
    if (command === ollama && args[0] === "--version") return { ok: true, stdout: "ollama version 1.0\n" };
    if (command === ollama && args[0] === "list") {
      return { ok: true, stdout: `NAME ID SIZE MODIFIED\n${[...models].map((model) => `${model} id 1 GB now`).join("\n")}\n` };
    }
    if (command === ollama && (args[0] === "pull" || args[0] === "create")) { models.add(args[1]); return { ok: true }; }
    if (command === ollama && args[0] === "show") return { ok: true, stdout: "FROM qwen3-embedding:8b\nPARAMETER num_ctx 8192\n" };
    return { ok: true, stdout: "" };
  };
  return { homeDir, appHome, serverDir, ollama, run, calls, gatewayDir: path.join(appHome, "runtime", "subscription-gateway") };
}

test("personal host prepare fetches and installs the gateway, creates the Qwen alias once, and writes no secret", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-prepare-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await hostFixture(root);
  const events = [];
  const gatewayCalls = [];
  const fetched = [];
  const runner = healthyGatewayRunner(gatewayCalls);
  const options = {
    profile: "personal",
    installedServerDir: fixture.serverDir,
    platform: "darwin",
    env: { HOME: fixture.homeDir, HONCHO_AGENT_BRIDGE_HOME: fixture.appHome },
    homeDir: fixture.homeDir,
    run: async (command, args) => { events.push(`run:${args[0]}`); return fixture.run(command, args); },
    fetchImpl: async () => response({ version: "1.0" }),
    gatewaySourceInspector: async () => (await fsp.access(fixture.gatewayDir).then(() => true, () => false))
      ? { state: "current", present: true, fetchable: false, directory: fixture.gatewayDir }
      : { state: "missing", present: false, fetchable: true, directory: fixture.gatewayDir, pin: { repo: "https://github.com/team-memory-system/subscription-gateway", ref: "main" } },
    gatewaySourceFetcher: async ({ pinDirectory, directory }) => {
      events.push("gateway-fetch");
      fetched.push({ pinDirectory, directory });
      await placeGatewayCli(directory);
      return { ok: true, fetched: true, updated: false, state: "current", directory, repo: "https://github.com/team-memory-system/subscription-gateway", ref: "main", commit: "a".repeat(40) };
    },
    gatewayRunner: async (command, args, runOptions) => { events.push(`gateway:${args[1]}`); return runner(command, args, runOptions); },
  };

  const firstPlan = await hostPlan(options);
  assert.equal(firstPlan.ready, true, firstPlan.issues?.join(", "));
  assert.deepEqual(firstPlan.operations.map((item) => item.type), [
    "fetch-gateway-source",
    "gateway-install",
    "ollama-pull",
    "ollama-create",
    "write-host-config",
  ]);
  assert.equal(firstPlan.topology.gateway.uiUrl, "http://127.0.0.1:11450");
  assert.equal(firstPlan.executables.ollama, fixture.ollama);
  for (const gone of ["auth", "proxy", "proxies"]) assert.equal(gone in firstPlan, false, `${gone} is not reported any more`);

  const prepared = await hostPrepare(options);
  assert.equal(prepared.ready, true, prepared.issues?.join(", "));
  assert.deepEqual(fetched, [{ pinDirectory: fixture.serverDir, directory: fixture.gatewayDir }], "the installed server's pin names the gateway");
  assert.deepEqual(gatewayCalls.map((call) => call.args), [[path.join(fixture.gatewayDir, "gateway", "cli.mjs"), "install"]]);
  assert.equal(gatewayCalls[0].cwd, fixture.gatewayDir);
  assert.ok(events.indexOf("gateway:install") < events.indexOf("run:pull"), "the gateway is installed before the long model pull");
  assert.equal(prepared.gateway.autostart, "launchd");
  assert.equal(JSON.stringify(prepared).includes("private-router-key"), false);

  const privateConfig = JSON.parse(await fsp.readFile(prepared.configFile, "utf8"));
  assert.deepEqual(privateConfig.gateway, {
    directory: fixture.gatewayDir,
    uiUrl: "http://127.0.0.1:11450",
    routerUrl: "http://127.0.0.1:11400/v1",
  });
  assert.equal(privateConfig.ollama.executable, fixture.ollama);
  assert.equal(JSON.stringify(privateConfig).includes("private-router-key"), false, "the host config holds no key");
  for (const gone of ["proxy", "proxies"]) assert.equal(gone in privateConfig, false);
  if (process.platform !== "win32") assert.equal((await fsp.stat(prepared.configFile)).mode & 0o777, 0o600);

  const secondPlan = await hostPlan(options);
  assert.equal(secondPlan.ollama.baseModelPresent, true);
  assert.equal(secondPlan.ollama.aliasMatches, true);
  assert.deepEqual(secondPlan.operations.map((item) => item.type), ["gateway-install", "write-host-config"]);

  const stopped = await hostStop(options);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.preservedConfig, true, "stopping keeps the host config so a restart needs no re-prepare");
  await fsp.access(prepared.configFile);
  assert.equal(gatewayCalls.length, 1, "host stop leaves the gateway alone");
  assert.equal(fixture.calls.some((call) => OS_REGISTRATION.test(call.command)), false);
});

test("host prepare fails closed when the gateway cannot be fetched or installed", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-gateway-fail-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await hostFixture(root);
  const base = {
    profile: "personal",
    installedServerDir: fixture.serverDir,
    platform: "darwin",
    env: { HOME: fixture.homeDir, HONCHO_AGENT_BRIDGE_HOME: fixture.appHome },
    homeDir: fixture.homeDir,
    run: fixture.run,
    fetchImpl: async () => response({ version: "1.0" }),
  };

  const unfetchable = await hostPlan({
    ...base,
    gatewaySourceInspector: async () => ({ state: "missing", present: false, fetchable: false, reason: "git is not installed, so the subscription gateway source cannot be fetched" }),
  });
  assert.equal(unfetchable.ready, false);
  assert.match(unfetchable.issues.join(" "), /subscription gateway cannot be installed: git is not installed/);

  const installFails = await hostPrepare({
    ...base,
    gatewaySourceInspector: async () => ({ state: "missing", present: false, fetchable: true, pin: { repo: "https://github.com/team-memory-system/subscription-gateway", ref: "main" } }),
    gatewaySourceFetcher: async ({ directory }) => { await placeGatewayCli(directory); return { ok: true, fetched: true, directory }; },
    gatewayRunner: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: "npm install failed with Bearer sk-private-token" }) }),
  });
  assert.equal(installFails.ok, false);
  assert.match(installFails.issues[0], /gateway install failed: npm install failed/);
  assert.equal(installFails.issues[0].includes("sk-private-token"), false, "the CLI's error is redacted before it is repeated");
  assert.equal(fixture.calls.some((call) => call.args[0] === "pull"), false, "nothing else runs after a failed gateway install");
  await assert.rejects(fsp.access(path.join(fixture.appHome, "runtime", "host", "host-config.json")));
});

async function writeRuntimeConfig(paths, ollama = { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "qwen3-embedding-honcho-8192" }) {
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(paths.configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    gateway: { directory: paths.gatewayDir, uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" },
    ollama,
    state: { configFile: paths.configFile, pidFile: paths.pidFile, logDir: paths.logDir },
    supervisorFile: paths.supervisorFile,
  }));
}

async function claimPid(paths, pid = process.pid) {
  await fsp.writeFile(paths.pidFile, JSON.stringify({
    pid,
    startedAt: new Date().toISOString(),
    configFile: paths.configFile,
    supervisorFile: paths.supervisorFile,
  }));
}

test("host start waits for the gateway router, Ollama, and model residency instead of accepting PID alone", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-start-wait-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "linux", env, homeDir });
  await writeRuntimeConfig(paths);
  await claimPid(paths);
  await placeGatewayCli(paths.gatewayDir);
  let statusCalls = 0;
  let psCalls = 0;
  const result = await hostStart({
    profile: "personal",
    installedServerDir: serverDir,
    platform: "linux",
    env,
    homeDir,
    skipPrepare: true,
    startTimeoutMs: 2_000,
    statusPollMs: 10,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/ps")) {
        psCalls += 1;
        return response({ models: psCalls >= 2 ? [{ name: "qwen3-embedding-honcho-8192:latest" }] : [] });
      }
      return response({ status: "ok" });
    },
    gatewayRunner: async () => {
      statusCalls += 1;
      return { code: 0, stdout: JSON.stringify(gatewayStatusDocument({ routerOk: statusCalls >= 3 })) };
    },
    spawnImpl: () => ({ unref() {} }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.gateway.router.ok, true);
  assert.ok(statusCalls >= 3, "it kept asking until the router answered");
  assert.ok(psCalls >= 2);
});

test("host start stops waiting when the gateway has no login and says where to log in", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-start-login-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "darwin", env, homeDir });
  await writeRuntimeConfig(paths);
  await claimPid(paths);
  await placeGatewayCli(paths.gatewayDir);
  const started = Date.now();
  const result = await hostStart({
    profile: "personal",
    installedServerDir: serverDir,
    platform: "darwin",
    env,
    homeDir,
    skipPrepare: true,
    startTimeoutMs: 60_000,
    statusPollMs: 10,
    fetchImpl: async (url) => String(url).endsWith("/api/ps")
      ? response({ models: [{ name: "qwen3-embedding-honcho-8192" }] })
      : response({ status: "ok" }),
    gatewayRunner: async () => ({ code: 0, stdout: JSON.stringify(gatewayStatusDocument({ routerOk: false, loggedIn: false })) }),
    spawnImpl: () => ({ unref() {} }),
  });
  assert.ok(Date.now() - started < 5_000, "it did not wait out the start timeout");
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.gateway.loggedIn, false);
  assert.equal(result.nextAction.kind, "gateway-login");
  assert.equal(result.nextAction.url, "http://127.0.0.1:11450");
  assert.match(result.nextAction.message, /log in with Codex and\/or Claude/);
});

async function windowsStopFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-stop-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "win32", env, homeDir });
  await writeRuntimeConfig(paths, { enabled: false, baseUrl: "http://127.0.0.1:11434", executable: "ollama", model: "unused" });
  await claimPid(paths, 4242);
  return { homeDir, appHome, serverDir, env, paths };
}

test("Windows host stop does not report success when taskkill fails", async (t) => {
  const fixture = await windowsStopFixture(t);
  const calls = [];
  const result = await hostStop({
    profile: "personal",
    installedServerDir: fixture.serverDir,
    platform: "win32",
    env: fixture.env,
    homeDir: fixture.homeDir,
    gracefulStopTimeoutMs: 0,
    forcedStopTimeoutMs: 0,
    isProcessAlive: () => true,
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "taskkill") return { ok: false };
      return { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.equal(result.signaled, false);
  assert.ok(calls.some((item) => item.command === "taskkill" && item.args.includes("/F")));
});

test("Windows host stop tracks the original process after its PID file disappears", async (t) => {
  const fixture = await windowsStopFixture(t);
  let alive = true;
  const calls = [];
  const result = await hostStop({
    profile: "personal",
    installedServerDir: fixture.serverDir,
    platform: "win32",
    env: fixture.env,
    homeDir: fixture.homeDir,
    gracefulStopTimeoutMs: 0,
    forcedStopTimeoutMs: 0,
    isProcessAlive: () => alive,
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "taskkill") {
        await fsp.rm(fixture.paths.pidFile, { force: true });
        alive = false;
        return { ok: true };
      }
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, true);
  assert.equal(result.signaled, true);
  assert.ok(calls.some((item) => item.command === "taskkill" && item.args.includes("4242")));
});

test("supervisor refuses to start twice", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-supervisor-twice-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  await fsp.mkdir(state, { recursive: true });
  const configFile = path.join(state, "host-config.json");
  const supervisorFile = fileURLToPath(new URL("../server/host/supervisor.mjs", import.meta.url));
  // A live PID file is what stops a second supervisor: the app can press start twice,
  // or a terminal and the app can both press it, and only one supervisor runs.
  await fsp.writeFile(path.join(state, "pid.json"), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    configFile,
    supervisorFile,
  }));
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434" },
    state: { configFile, pidFile: path.join(state, "pid.json"), logDir: path.join(state, "logs") },
    supervisorFile,
  }));
  const { stdout } = await execFileAsync(process.execPath, [supervisorFile, "--config", configFile], { timeout: 5_000 });
  assert.match(stdout, /supervisor-already-running/);
  // The running supervisor's own PID file is left exactly as it was.
  const record = JSON.parse(await fsp.readFile(path.join(state, "pid.json"), "utf8"));
  assert.equal(record.pid, process.pid);
});

test("supervisor keeps the embedding warm and stops cleanly on SIGTERM", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-supervisor-warm-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // A stand-in Ollama: it answers the version probe and returns a 1536-wide vector.
  const embeds = [];
  const ollama = http.createServer(async (request, reply) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    reply.setHeader("content-type", "application/json");
    if (request.url === "/api/version") return reply.end(JSON.stringify({ version: "test" }));
    if (request.url === "/api/embed") {
      embeds.push(JSON.parse(body));
      return reply.end(JSON.stringify({ embeddings: [Array(1536).fill(0.1)] }));
    }
    reply.statusCode = 404;
    reply.end("{}");
  });
  const port = await freePort();
  await new Promise((resolve) => ollama.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => ollama.close(resolve)));

  const state = path.join(root, "state");
  await fsp.mkdir(state, { recursive: true });
  const configFile = path.join(state, "host-config.json");
  const pidFile = path.join(state, "pid.json");
  const supervisorFile = fileURLToPath(new URL("../server/host/supervisor.mjs", import.meta.url));
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    ollama: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}`,
      executable: path.join(root, "no-such-ollama"),
      model: "qwen3-embedding-honcho-8192",
      dimensions: 1536,
      keepAlive: -1,
      warmIntervalMs: 60_000,
      manageService: false,
    },
    state: { configFile, pidFile, logDir: path.join(state, "logs") },
    supervisorFile,
  }));
  const child = spawn(process.execPath, [supervisorFile, "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  assert.equal(await waitUntil(() => output.includes("embedding-resident")), true, output);
  assert.equal(embeds[0].model, "qwen3-embedding-honcho-8192");
  assert.equal(embeds[0].truncate, false);
  await fsp.access(pidFile);
  child.kill("SIGTERM");
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 5_000);
    timer.unref();
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
  assert.equal(/proxy/i.test(output), false, "the supervisor runs no proxy");
  await assert.rejects(fsp.access(pidFile));
});

test("host start launches the supervisor itself and registers nothing with the OS", async (t) => {
  // The whole point: no launchd, no schtasks, no systemd from this repository. The
  // supervisor is started detached so it outlives the terminal or the UI process that
  // asked. The gateway's own install may register its autostart; that is its CLI's
  // business, and here it is a stand-in.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-spawn-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "darwin", env, homeDir });
  await writeRuntimeConfig(paths, { enabled: false, baseUrl: "http://127.0.0.1:11434", model: "unused" });
  await placeGatewayCli(paths.gatewayDir);

  const spawned = [];
  const ran = [];
  const gatewayCalls = [];
  const options = {
    profile: "personal",
    installedServerDir: serverDir,
    platform: "darwin",
    env,
    homeDir,
    skipPrepare: true,
    startTimeoutMs: 1_000,
    statusPollMs: 10,
    nodePath: "/absolute/node",
    fetchImpl: async () => response({ status: "ok" }),
    run: async (command, args) => { ran.push({ command, args }); return { ok: true, stdout: "", stderr: "" }; },
    gatewayRunner: healthyGatewayRunner(gatewayCalls),
    spawnImpl: (command, args, spawnOptions) => {
      spawned.push({ command, args, spawnOptions });
      return { unref() {} };
    },
  };

  const started = await hostStart(options);
  assert.equal(started.started, true);
  assert.equal(started.alreadyRunning, false);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "/absolute/node");
  assert.deepEqual(spawned[0].args, [paths.supervisorFile, "--config", paths.configFile]);
  assert.equal(spawned[0].spawnOptions.detached, true, "it must outlive its parent");
  assert.equal(spawned[0].spawnOptions.stdio, "ignore");
  assert.deepEqual(ran, [], "no launchctl, schtasks or systemctl call");
  assert.equal("startup" in started, false, "there is no startup adapter to report");
  assert.deepEqual([...new Set(gatewayCalls.map((call) => call.args[1]))], ["status"], "a prepared start only asks the gateway how it is");

  // With a live PID file it must not start a second supervisor.
  await claimPid(paths);
  const again = await hostStart(options);
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.started, false);
  assert.equal(spawned.length, 1, "the running supervisor is reused");
});

test("a full host start installs the gateway through its CLI and registers nothing itself", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-full-start-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await hostFixture(root);
  const gatewayCalls = [];
  const spawned = [];
  const result = await hostStart({
    profile: "personal",
    installedServerDir: fixture.serverDir,
    platform: "darwin",
    env: { HOME: fixture.homeDir, HONCHO_AGENT_BRIDGE_HOME: fixture.appHome },
    homeDir: fixture.homeDir,
    run: fixture.run,
    fetchImpl: async (url) => String(url).endsWith("/api/ps")
      ? response({ models: [{ name: "qwen3-embedding-honcho-8192" }] })
      : response({ version: "1.0" }),
    gatewaySourceInspector: async () => ({ state: "current", present: true, fetchable: false, directory: fixture.gatewayDir }),
    gatewaySourceFetcher: async ({ directory }) => { await placeGatewayCli(directory); return { ok: true, fetched: false, updated: false, state: "current", directory }; },
    gatewayRunner: healthyGatewayRunner(gatewayCalls),
    spawnImpl: (command, args) => { spawned.push({ command, args }); return { unref() {} }; },
    startTimeoutMs: 1_000,
    statusPollMs: 10,
  });
  // The supervisor spawn is a stand-in, so its PID file never appears; everything
  // this start could do by itself has still happened.
  assert.deepEqual(gatewayCalls.map((call) => call.args[1]).slice(0, 2), ["install", "status"]);
  assert.equal(spawned.length, 1);
  assert.equal(fixture.calls.some((call) => OS_REGISTRATION.test(call.command)), false);
  assert.equal(result.gateway.router.ok, true);
});

test("host status reports liveness from the process, not from a heartbeat file", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-liveness-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "darwin", env, homeDir });
  await writeRuntimeConfig(paths, { enabled: false, baseUrl: "http://127.0.0.1:11434", model: "unused" });
  await placeGatewayCli(paths.gatewayDir);
  // An old record with no heartbeat field at all: liveness is the PID being alive.
  await fsp.writeFile(paths.pidFile, JSON.stringify({
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
    configFile: paths.configFile,
    supervisorFile: paths.supervisorFile,
  }));

  const status = await hostStatus({
    profile: "personal",
    installedServerDir: serverDir,
    platform: "darwin",
    env,
    homeDir,
    fetchImpl: async () => response({ status: "ok" }),
    gatewayRunner: healthyGatewayRunner(),
  });
  assert.equal(status.running, true, "a very old startedAt must not read as dead");
  assert.equal(status.ok, true);
  assert.equal("disabled" in status, false, "there is no disabled marker any more");
  assert.equal("startup" in status, false);
  assert.equal(status.supervisor.pid, process.pid);
  assert.equal("heartbeatAgeMs" in status.supervisor, false);
  assert.equal(status.gateway.router.ok, true);
  assert.equal(status.gateway.autostart.kind, "launchd");
});

test("host status says the gateway is missing instead of calling it healthy", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-no-gateway-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "darwin", env, homeDir });
  await writeRuntimeConfig(paths, { enabled: false, baseUrl: "http://127.0.0.1:11434", model: "unused" });
  await claimPid(paths);
  let asked = false;
  const status = await hostStatus({
    profile: "personal",
    installedServerDir: serverDir,
    platform: "darwin",
    env,
    homeDir,
    fetchImpl: async () => response({ status: "ok" }),
    gatewayRunner: async () => { asked = true; return { code: 0, stdout: "{}" }; },
  });
  assert.equal(status.ok, false);
  assert.equal(status.running, true);
  assert.equal(status.gateway.installed, false);
  assert.match(status.gateway.error, /not installed/);
  assert.equal(asked, false, "there was no CLI to run");
});
