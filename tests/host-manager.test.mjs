import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  deriveHostTopology,
  encodeStartupContent,
  hostPlan,
  hostPrepare,
  hostStart,
  hostStop,
  parseDotEnv,
  resolveHostPaths,
  startupAdapter,
  windowsBatchInvocation,
} from "../scripts/host-manager.mjs";

const execFileAsync = promisify(execFile);

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

function topologyFixture(root, platform = "darwin") {
  const homeDir = path.join(root, "user");
  const env = { HOME: homeDir, AGENT_MEMORY_HOME: path.join(root, "app") };
  const resolved = resolveHostPaths({ platform, env, homeDir });
  const paths = { ...resolved, homeDir, env };
  const topology = deriveHostTopology({
    environment: {
      DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL: "http://host.docker.internal:11435/v1",
      DERIVER_MODEL_CONFIG__MODEL: "gpt-5.6-sol",
      EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL: "http://host.docker.internal:11434/v1",
      EMBEDDING_MODEL_CONFIG__MODEL: "qwen3-embedding-honcho-8192",
      EMBEDDING_MAX_INPUT_TOKENS: "8192",
      EMBEDDING_VECTOR_DIMENSIONS: "1536",
    },
    paths,
    platform,
    homeDir,
  });
  return { homeDir, env, paths, topology };
}

test("dotenv and topology derivation discard credentials and translate Docker host endpoints", () => {
  const environment = parseDotEnv(`
LLM_VLLM_API_KEY="private-shared-value"
DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11435/v1
DERIVER_MODEL_CONFIG__MODEL=gpt-5.6-sol
EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192
EMBEDDING_MAX_INPUT_TOKENS=8192
EMBEDDING_VECTOR_DIMENSIONS=1536
`);
  const root = path.join(os.tmpdir(), "agent-memory-topology");
  const homeDir = path.join(root, "home");
  const paths = { ...resolveHostPaths({ installedServerDir: path.join(root, "server"), platform: "darwin", env: {}, homeDir }), homeDir, env: {} };
  const topology = deriveHostTopology({ environment, paths, platform: "darwin", homeDir });

  assert.equal(topology.proxy.baseUrl, "http://127.0.0.1:11435");
  assert.equal(topology.proxy.defaultModel, "gpt-5.6-sol");
  assert.equal(topology.ollama.baseUrl, "http://127.0.0.1:11434");
  assert.equal(topology.ollama.contextLength, 8192);
  assert.equal(topology.ollama.dimensions, 1536);
  assert.equal(topology.ollama.keepAlive, -1);
  assert.equal(JSON.stringify(topology).includes("private-shared-value"), false);
});

test("non-secret host profile overrides topology and rejects secret-bearing fields", () => {
  const root = path.join(os.tmpdir(), "agent-memory-profile");
  const homeDir = path.join(root, "home");
  const paths = { ...resolveHostPaths({ installedServerDir: path.join(root, "server"), platform: "linux", env: {}, homeDir }), homeDir, env: {} };
  const topology = deriveHostTopology({
    environment: {},
    profileConfig: {
      codexProxy: { enabled: true, baseUrl: "http://127.0.0.1:22135", defaultModel: "gpt-5.6-sol" },
      ollama: { enabled: true, baseUrl: "http://127.0.0.1:22134", model: "qwen3-embedding-honcho-8192", contextLength: 8192 },
    },
    paths,
    platform: "linux",
    homeDir,
  });
  assert.equal(topology.proxy.port, 22135);
  assert.equal(topology.ollama.baseUrl, "http://127.0.0.1:22134");
  assert.throws(
    () => deriveHostTopology({ environment: {}, profileConfig: { codexProxy: { apiKey: "must-not-live-here" } }, paths, homeDir }),
    /must not contain secret field/,
  );
  assert.throws(
    () => deriveHostTopology({ environment: {}, profileConfig: { codexProxy: { enabled: true, baseUrl: "http://example.test:11435" } }, paths, homeDir }),
    /loopback endpoint/,
  );
  assert.throws(
    () => deriveHostTopology({ environment: {}, profileConfig: { ollama: { keepAlive: "forever" } }, paths, homeDir }),
    /keep-alive setting/,
  );
});

test("native startup adapters supervise restart without embedding secrets", () => {
  const root = path.join(os.tmpdir(), "agent-memory-adapters");
  const fixture = topologyFixture(root);
  const launchd = startupAdapter({ kind: "launchagent", nodePath: "/absolute/node", topology: fixture.topology, paths: fixture.paths });
  assert.match(launchd.content, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(launchd.content, /<string>\/absolute\/node<\/string>/);

  const windows = startupAdapter({ kind: "windows-task", nodePath: "C:\\Program Files\\nodejs\\node.exe", topology: fixture.topology, paths: { ...fixture.paths, homeDir: "C:\\Users\\Test", runtimeDir: "C:\\Agent Memory\\기억 runtime\\host" } });
  assert.match(windows.content, /<RestartOnFailure>/);
  assert.match(windows.content, /encoding="UTF-16"/);
  assert.match(windows.content, /<Interval>PT1M<\/Interval>/);
  assert.match(windows.content, /<Count>255<\/Count>/);
  assert.equal(windows.encoding, "utf16le-bom");
  assert.equal(windows.content.includes(`/v:off /c &quot;&quot;${windows.launcherPath}&quot;&quot;`), true);
  assert.match(windows.launcherContent, /2>&1/);
  assert.doesNotMatch(windows.launcherContent, /start "Agent Memory Host"/);
  const encodedWindowsTask = encodeStartupContent(windows.content, windows.encoding);
  assert.equal(Buffer.isBuffer(encodedWindowsTask), true);
  assert.deepEqual([...encodedWindowsTask.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(encodedWindowsTask.subarray(2).toString("utf16le"), windows.content);

  const systemd = startupAdapter({ kind: "systemd-user", nodePath: "/usr/bin/node", topology: fixture.topology, paths: fixture.paths });
  assert.match(systemd.content, /Restart=on-failure/);
  assert.match(systemd.content, /ExecStart="\/usr\/bin\/node"/);

  const fallback = startupAdapter({ kind: "direct-fallback", nodePath: "/usr/bin/node", topology: fixture.topology, paths: fixture.paths });
  assert.match(fallback.content, /^#!\/bin\/sh/);
  assert.match(fallback.content, /while \[ ! -e/);
  assert.match(fallback.content, /sleep 10/);
  for (const adapter of [launchd, windows, systemd, fallback]) assert.equal(JSON.stringify(adapter).includes("private-secret"), false);
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

test("personal prepare uses frozen proxy dependencies, creates Qwen alias once, and keeps secrets out of results", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-host-prepare-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const proxyDir = path.join(serverDir, "honcho", "codex-openai-proxy");
  const hostDir = path.join(serverDir, "host");
  await fsp.mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await fsp.mkdir(proxyDir, { recursive: true });
  await fsp.mkdir(hostDir, { recursive: true });
  const sharedSecret = "private-shared-value-never-print";
  await fsp.writeFile(path.join(homeDir, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "access-value", refresh_token: "refresh-value" } }));
  await fsp.writeFile(path.join(serverDir, ".env"), `
LLM_VLLM_API_KEY=${sharedSecret}
DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11435/v1
DERIVER_MODEL_CONFIG__MODEL=gpt-5.6-sol
EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192
EMBEDDING_MAX_INPUT_TOKENS=8192
EMBEDDING_VECTOR_DIMENSIONS=1536
`);
  await fsp.writeFile(path.join(proxyDir, "package.json"), JSON.stringify({ name: "test-proxy" }));
  await fsp.writeFile(path.join(proxyDir, "server.mjs"), "process.exit(0);\n");
  await fsp.writeFile(path.join(proxyDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fsp.copyFile(new URL("../server/host/supervisor.mjs", import.meta.url), path.join(hostDir, "supervisor.mjs"));
  await fsp.writeFile(path.join(hostDir, "qwen3-embedding-8192.Modelfile"), "FROM qwen3-embedding:8b\nPARAMETER num_ctx 8192\n");

  const tools = path.join(root, "tools");
  await fsp.mkdir(tools);
  const executables = {
    npm: path.join(tools, "npm"),
    pnpm: path.join(tools, "pnpm"),
    ollama: path.join(tools, "ollama"),
  };
  await Promise.all(Object.values(executables).map((target) => fsp.writeFile(target, "")));
  const calls = [];
  const models = new Set();
  const run = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd || "" });
    if (command === "which") {
      const target = executables[args[0]];
      return target ? { ok: true, stdout: `${target}\n` } : { ok: false };
    }
    if (command === executables.npm && args[0] === "--version") return { ok: true, stdout: "10.0.0\n" };
    if (command === executables.pnpm && args[0] === "--version") return { ok: true, stdout: "10.14.0\n" };
    if (command === executables.pnpm && args[0] === "install") {
      await fsp.mkdir(path.join(proxyDir, "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
      return { ok: true };
    }
    if (command === executables.ollama && args[0] === "--version") return { ok: true, stdout: "ollama version 1.0\n" };
    if (command === executables.ollama && args[0] === "list") {
      return { ok: true, stdout: `NAME ID SIZE MODIFIED\n${[...models].map((model) => `${model} id 1 GB now`).join("\n")}\n` };
    }
    if (command === executables.ollama && args[0] === "pull") { models.add(args[1]); return { ok: true }; }
    if (command === executables.ollama && args[0] === "create") { models.add(args[1]); return { ok: true }; }
    if (command === executables.ollama && args[0] === "show") return { ok: true, stdout: "FROM qwen3-embedding:8b\nPARAMETER num_ctx 8192\n" };
    return { ok: true, stdout: "" };
  };
  const fetchImpl = async () => response({ version: "1.0" });
  const options = {
    profile: "personal",
    installedServerDir: serverDir,
    platform: "darwin",
    env: { HOME: homeDir, AGENT_MEMORY_HOME: appHome },
    homeDir,
    run,
    fetchImpl,
  };

  const firstPlan = await hostPlan(options);
  assert.equal(firstPlan.ready, true);
  assert.equal(firstPlan.proxy.dependencyMode, "pnpm-frozen");
  assert.equal(firstPlan.proxy.sharedSecretConfigured, true);
  assert.equal(JSON.stringify(firstPlan).includes(sharedSecret), false);
  assert.equal(firstPlan.executables.ollama, executables.ollama);

  const prepared = await hostPrepare(options);
  assert.equal(prepared.ready, true);
  assert.equal(JSON.stringify(prepared).includes(sharedSecret), false);
  assert.ok(calls.some((item) => item.command === executables.pnpm && item.args.includes("--frozen-lockfile")));
  assert.ok(calls.some((item) => item.command === executables.ollama && item.args[0] === "pull"));
  assert.ok(calls.some((item) => item.command === executables.ollama && item.args[0] === "create"));

  const privateConfig = JSON.parse(await fsp.readFile(prepared.configFile, "utf8"));
  assert.equal(privateConfig.proxy.sharedSecret, sharedSecret);
  assert.equal(privateConfig.ollama.executable, executables.ollama);
  if (process.platform !== "win32") assert.equal((await fsp.stat(prepared.configFile)).mode & 0o777, 0o600);

  const secondPlan = await hostPlan(options);
  assert.equal(secondPlan.proxy.dependenciesReady, true);
  assert.equal(secondPlan.ollama.baseModelPresent, true);
  assert.equal(secondPlan.ollama.aliasMatches, true);
  assert.equal(secondPlan.operations.some((item) => item.type === "ollama-pull" || item.type === "ollama-create"), false);

  const stopped = await hostStop(options);
  assert.equal(stopped.ok, true);
  await fsp.access(path.join(appHome, "runtime", "host", "disabled"));
});

test("host start waits for proxy, Ollama, and model residency instead of accepting PID alone", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-host-start-wait-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, AGENT_MEMORY_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "linux", env, homeDir });
  const adapterPath = path.join(paths.runtimeDir, "start-host.sh");
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(adapterPath, "#!/bin/sh\n");
  await fsp.writeFile(paths.pidFile, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    configFile: paths.configFile,
    supervisorFile: paths.supervisorFile,
  }));
  await fsp.writeFile(paths.configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    proxy: { enabled: true, baseUrl: "http://127.0.0.1:11435", port: 11435, defaultModel: "gpt-5.6-sol", sharedSecret: "private" },
    ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "qwen3-embedding-honcho-8192" },
    state: { configFile: paths.configFile, disabledFile: paths.disabledFile, pidFile: paths.pidFile, logDir: paths.logDir },
    supervisorFile: paths.supervisorFile,
    startup: { kind: "direct-fallback", path: adapterPath, label: "agent-memory-host" },
  }));
  let psCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/ps")) {
      psCalls += 1;
      return response({ models: psCalls >= 3 ? [{ name: "qwen3-embedding-honcho-8192:latest" }] : [] });
    }
    return response({ status: "ok" });
  };
  const result = await hostStart({
    profile: "personal",
    installedServerDir: serverDir,
    platform: "linux",
    env,
    homeDir,
    skipPrepare: true,
    startTimeoutMs: 2_000,
    statusPollMs: 10,
    fetchImpl,
    spawnImpl: () => ({ unref() {} }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.ok(psCalls >= 3);
});

async function windowsStopFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-host-stop-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, AGENT_MEMORY_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "win32", env, homeDir });
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(paths.configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    proxy: { enabled: false, baseUrl: "http://127.0.0.1:11435" },
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434", executable: "ollama", model: "unused" },
    state: { configFile: paths.configFile, disabledFile: paths.disabledFile, pidFile: paths.pidFile, logDir: paths.logDir },
    supervisorFile: paths.supervisorFile,
    startup: { kind: "windows-task", path: path.join(paths.runtimeDir, "task.xml"), label: "AgentMemoryHost" },
  }));
  await fsp.writeFile(paths.pidFile, JSON.stringify({
    pid: 4242,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    configFile: paths.configFile,
    supervisorFile: paths.supervisorFile,
  }));
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
      if (command === "schtasks.exe") {
        await fsp.rm(fixture.paths.pidFile, { force: true });
        return { ok: true };
      }
      if (command === "taskkill") {
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

test("Windows start keeps the logon task and directly launches when no interactive token is available", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-windows-task-fallback-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "Agent Memory");
  const serverDir = path.join(appHome, "server");
  const env = {
    HOME: homeDir,
    AGENT_MEMORY_HOME: appHome,
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "win32", env, homeDir });
  const taskPath = path.join(paths.runtimeDir, "AgentMemoryHost.task.xml");
  const launcherPath = path.join(paths.runtimeDir, "start-host.cmd");
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(taskPath, "task");
  await fsp.writeFile(launcherPath, "@echo off\r\n");
  await fsp.writeFile(paths.configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    proxy: { enabled: false, baseUrl: "http://127.0.0.1:11435" },
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434" },
    state: { configFile: paths.configFile, disabledFile: paths.disabledFile, pidFile: paths.pidFile, logDir: paths.logDir },
    supervisorFile: paths.supervisorFile,
    startup: { kind: "windows-task", path: taskPath, launcherPath, label: "AgentMemoryHost" },
  }));
  const calls = [];
  const spawns = [];
  const result = await hostStart({
    profile: "personal",
    installedServerDir: serverDir,
    platform: "win32",
    env,
    homeDir,
    skipPrepare: true,
    taskStartupGraceMs: 0,
    startTimeoutMs: 0,
    run: async (command, args) => {
      calls.push({ command, args });
      return { ok: true };
    },
    spawnImpl: (command, args, options) => {
      spawns.push({ command, args, options });
      return { unref() {} };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.activation.mode, "windows-task-direct-fallback");
  assert.equal(result.activation.scheduledLaunchRequested, true);
  assert.equal(calls.filter((item) => item.command === "schtasks.exe").length, 2);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, env.ComSpec);
  assert.equal(spawns[0].args[0].includes(`"${launcherPath}"`), true);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.windowsVerbatimArguments, true);
});

test("supervisor exits cleanly on a disabled marker without printing its private secret", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-supervisor-disabled-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  await fsp.mkdir(state, { recursive: true });
  const configFile = path.join(state, "host-config.json");
  const disabledFile = path.join(state, "disabled");
  const secret = "private-supervisor-secret";
  const supervisorFile = fileURLToPath(new URL("../server/host/supervisor.mjs", import.meta.url));
  await fsp.writeFile(disabledFile, "disabled\n");
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    proxy: {
      enabled: true,
      baseUrl: "http://127.0.0.1:11435",
      port: 11435,
      defaultModel: "gpt-5.6-sol",
      authPath: path.join(root, "auth.json"),
      sourceDir: root,
      entrypoint: path.join(root, "proxy.mjs"),
      sharedSecret: secret,
    },
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434" },
    state: { configFile, disabledFile, pidFile: path.join(state, "pid.json"), logDir: path.join(state, "logs") },
    supervisorFile,
  }));
  const { stdout, stderr } = await execFileAsync(process.execPath, [supervisorFile, "--config", configFile], { timeout: 5_000 });
  assert.match(stdout, /supervisor-disabled/);
  assert.equal(`${stdout}${stderr}`.includes(secret), false);
  await assert.rejects(fsp.access(path.join(state, "pid.json")));
});

test("supervisor restarts a failed proxy and then honors the disabled marker", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-supervisor-restart-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const port = await freePort();
  const state = path.join(root, "state");
  const proxyDir = path.join(root, "proxy");
  await fsp.mkdir(state, { recursive: true });
  await fsp.mkdir(proxyDir, { recursive: true });
  const countFile = path.join(proxyDir, "starts.txt");
  const proxyFile = path.join(proxyDir, "server.mjs");
  await fsp.writeFile(proxyFile, `
import fsp from "node:fs/promises";
import http from "node:http";
const countFile = ${JSON.stringify(countFile)};
const count = Number(await fsp.readFile(countFile, "utf8").catch(() => "0")) + 1;
await fsp.writeFile(countFile, String(count));
if (count === 1) process.exit(17);
http.createServer((_request, response) => response.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`);
  const configFile = path.join(state, "host-config.json");
  const disabledFile = path.join(state, "disabled");
  const pidFile = path.join(state, "pid.json");
  const secret = "private-restart-secret";
  const supervisorFile = fileURLToPath(new URL("../server/host/supervisor.mjs", import.meta.url));
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    proxy: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}`,
      port,
      defaultModel: "gpt-5.6-sol",
      authPath: path.join(root, "auth.json"),
      sourceDir: proxyDir,
      entrypoint: proxyFile,
      sharedSecret: secret,
    },
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434" },
    state: { configFile, disabledFile, pidFile, logDir: path.join(state, "logs") },
    supervisorFile,
  }));
  const child = spawn(process.execPath, [supervisorFile, "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  assert.equal(await waitUntil(async () => Number(await fsp.readFile(countFile, "utf8").catch(() => "0")) >= 2), true);
  assert.equal(await waitUntil(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}`)).ok; } catch { return false; }
  }), true);
  assert.equal((await readFileNumber(countFile)), 2);
  await fsp.writeFile(disabledFile, "disabled\n");
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 5_000);
    timer.unref();
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
  assert.equal(output.includes(secret), false);
  await assert.rejects(fsp.access(pidFile));
});

async function readFileNumber(target) {
  return Number(await fsp.readFile(target, "utf8"));
}
