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
  DEFAULT_EMBEDDING_ALIAS,
  EMBEDDING_ALIASES,
  HOST_LAUNCHD_LABEL,
  HOST_RUN_VALUE,
  HOST_SYSTEMD_UNIT,
  deriveHostTopology,
  embeddingModelfile,
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

// launchctl, reg and systemctl as fakes: what is registered, what launchd runs, and
// every call. The real ones are never reached: under `node --test` the default
// runner refuses them.
function fakeAutostart() {
  const calls = [];
  const state = { loaded: false, running: false, registry: new Map(), systemdAvailable: true };
  const done = { code: 0, stdout: "", stderr: "" };
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const name = String(command).split(/[\\/]/).pop();
    if (name === "launchctl") {
      if (args[0] === "print") {
        return state.loaded ? { code: 0, stdout: `state = ${state.running ? "running" : "not running"}\n`, stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
      }
      if (args[0] === "bootstrap") { state.loaded = true; state.running = true; return done; }
      if (args[0] === "bootout") { state.loaded = false; state.running = false; return done; }
      if (args[0] === "kickstart") { state.running = true; return done; }
    }
    if (name === "reg.exe") {
      const key = `${args[1]}\\${args[args.indexOf("/v") + 1]}`;
      if (args[0] === "add") { state.registry.set(key, args[args.indexOf("/d") + 1]); return done; }
      if (args[0] === "query") return state.registry.has(key) ? done : { code: 1, stdout: "", stderr: "not found" };
      if (args[0] === "delete") return state.registry.delete(key) ? done : { code: 1, stdout: "", stderr: "not found" };
    }
    if (name === "systemctl") {
      if (args[1] === "show-environment" && !state.systemdAvailable) return { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" };
      return done;
    }
    return { code: 1, stdout: "", stderr: `unexpected ${command}` };
  };
  const lines = () => calls.map((call) => `${String(call.command).split(/[\\/]/).pop()} ${call.args.join(" ")}`);
  return { runner, calls, state, lines, options: { autostartRunner: runner, uid: 501, sleep: async () => {} } };
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

// `embeddingModel` is what the installed .env names (null leaves it out, so the
// bundled profile decides). `shown` overrides what `ollama show --modelfile` prints
// for an alias; otherwise it prints the Modelfile the alias was created from.
async function hostFixture(root, { embeddingModel = DEFAULT_EMBEDDING_ALIAS, presentModels = [], shown = {} } = {}) {
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
${embeddingModel ? `EMBEDDING_MODEL_CONFIG__MODEL=${embeddingModel}` : ""}
EMBEDDING_MAX_INPUT_TOKENS=8192
EMBEDDING_VECTOR_DIMENSIONS=1536
`);
  await fsp.copyFile(new URL("../server/host/supervisor.mjs", import.meta.url), path.join(hostDir, "supervisor.mjs"));

  const tools = path.join(root, "tools");
  await fsp.mkdir(tools);
  const ollama = path.join(tools, "ollama");
  await fsp.writeFile(ollama, "");
  const calls = [];
  const models = new Set(presentModels);
  const created = [];
  const modelfiles = new Map();
  const run = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "which") return args[0] === "ollama" ? { ok: true, stdout: `${ollama}\n` } : { ok: false };
    if (command === ollama && args[0] === "--version") return { ok: true, stdout: "ollama version 1.0\n" };
    if (command === ollama && args[0] === "list") {
      return { ok: true, stdout: `NAME ID SIZE MODIFIED\n${[...models].map((model) => `${model} id 1 GB now`).join("\n")}\n` };
    }
    if (command === ollama && args[0] === "pull") { models.add(args[1]); return { ok: true }; }
    if (command === ollama && args[0] === "create") {
      const file = args[args.indexOf("-f") + 1];
      const modelfile = await fsp.readFile(file, "utf8");
      created.push({ model: args[1], file, modelfile });
      modelfiles.set(args[1], modelfile);
      models.add(args[1]);
      return { ok: true };
    }
    if (command === ollama && args[0] === "show") {
      return { ok: true, stdout: shown[args[2]] ?? modelfiles.get(args[2]) ?? "" };
    }
    return { ok: true, stdout: "" };
  };
  return { homeDir, appHome, serverDir, ollama, run, calls, created, gatewayDir: path.join(appHome, "runtime", "subscription-gateway") };
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

  const autostart = fakeAutostart();
  const stopped = await hostStop({ ...options, ...autostart.options });
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.autostart, { registered: false, kind: "launchd", removed: false }, "nothing was registered, so nothing was removed");
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

function ollamaOnlyOptions(fixture) {
  return {
    profile: "personal",
    installedServerDir: fixture.serverDir,
    platform: "darwin",
    env: { HOME: fixture.homeDir, HONCHO_AGENT_BRIDGE_HOME: fixture.appHome },
    homeDir: fixture.homeDir,
    run: fixture.run,
    fetchImpl: async () => response({ version: "1.0" }),
    skipGateway: true,
    gatewaySourceInspector: async () => ({ state: "current", present: true, fetchable: false, directory: fixture.gatewayDir }),
  };
}

test("embedding aliases each have one fixed base, and topology keeps the alias an installed .env names", () => {
  assert.deepEqual(EMBEDDING_ALIASES, {
    "qwen3-embedding-4b-honcho-8192": "qwen3-embedding:4b",
    "qwen3-embedding-honcho-8192": "qwen3-embedding:8b",
  });
  assert.equal(DEFAULT_EMBEDDING_ALIAS, "qwen3-embedding-4b-honcho-8192");
  assert.equal(embeddingModelfile({ baseModel: "qwen3-embedding:4b", contextLength: 8192 }), "FROM qwen3-embedding:4b\nPARAMETER num_ctx 8192\n");

  const root = path.join(os.tmpdir(), "honcho-agent-bridge-embedding-alias");
  const homeDir = path.join(root, "home");
  const paths = { ...resolveHostPaths({ installedServerDir: path.join(root, "server"), platform: "darwin", env: {}, homeDir }), homeDir, env: {} };
  const bundled = { ollama: { enabled: true, model: "qwen3-embedding-4b-honcho-8192", baseModel: "qwen3-embedding:4b", contextLength: 8192 } };

  const fresh = deriveHostTopology({ environment: {}, profileConfig: bundled, paths });
  assert.equal(fresh.ollama.model, "qwen3-embedding-4b-honcho-8192");
  assert.equal(fresh.ollama.baseModel, "qwen3-embedding:4b");

  const existing = deriveHostTopology({ environment: { EMBEDDING_MODEL_CONFIG__MODEL: "qwen3-embedding-honcho-8192" }, profileConfig: bundled, paths });
  assert.equal(existing.ollama.model, "qwen3-embedding-honcho-8192", "the installed alias made the stored vectors");
  assert.equal(existing.ollama.baseModel, "qwen3-embedding:8b", "the base comes from the alias table, not the bundled profile");

  const mislabelled = deriveHostTopology({
    environment: {},
    profileConfig: { ollama: { model: "qwen3-embedding-honcho-8192", baseModel: "qwen3-embedding:4b" } },
    paths,
  });
  assert.equal(mislabelled.ollama.baseModel, "qwen3-embedding:8b", "a known alias is never paired with another base");

  const custom = deriveHostTopology({ environment: { EMBEDDING_MODEL_CONFIG__MODEL: "my-embedder" }, profileConfig: bundled, paths });
  assert.equal(custom.ollama.model, "qwen3-embedding-4b-honcho-8192", "an unknown installed alias does not override the profile");

  const noProfile = deriveHostTopology({ environment: {}, paths });
  assert.equal(noProfile.ollama.model, "qwen3-embedding-4b-honcho-8192");
  assert.equal(noProfile.ollama.baseModel, "qwen3-embedding:4b");
});

test("a fresh personal host prepare creates the 4B alias from a Modelfile generated for it", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-4b-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await hostFixture(root, { embeddingModel: null });
  const options = ollamaOnlyOptions(fixture);

  const plan = await hostPlan(options);
  assert.equal(plan.ready, true, plan.issues?.join(", "));
  assert.equal(plan.topology.ollama.model, "qwen3-embedding-4b-honcho-8192");
  assert.equal(plan.topology.ollama.baseModel, "qwen3-embedding:4b");
  assert.deepEqual(plan.operations.filter((item) => item.type.startsWith("ollama-")), [
    { type: "ollama-pull", model: "qwen3-embedding:4b" },
    { type: "ollama-create", model: "qwen3-embedding-4b-honcho-8192", baseModel: "qwen3-embedding:4b" },
  ]);

  const prepared = await hostPrepare(options);
  assert.equal(prepared.ready, true, prepared.issues?.join(", "));
  assert.deepEqual(fixture.calls.filter((call) => call.args[0] === "pull").map((call) => call.args[1]), ["qwen3-embedding:4b"]);
  assert.equal(fixture.created.length, 1);
  const [created] = fixture.created;
  assert.equal(created.model, "qwen3-embedding-4b-honcho-8192");
  assert.equal(created.file, path.join(fixture.appHome, "runtime", "host", "qwen3-embedding-4b-honcho-8192.Modelfile"));
  assert.equal(created.modelfile, "FROM qwen3-embedding:4b\nPARAMETER num_ctx 8192\n");
  if (process.platform !== "win32") assert.equal((await fsp.stat(created.file)).mode & 0o777, 0o600);
  const config = JSON.parse(await fsp.readFile(prepared.configFile, "utf8"));
  assert.equal(config.ollama.model, "qwen3-embedding-4b-honcho-8192");
  assert.equal(config.ollama.baseModel, "qwen3-embedding:4b");

  const again = await hostPlan(options);
  assert.equal(again.ollama.aliasMatches, true);
  assert.equal(again.operations.some((item) => item.type.startsWith("ollama-")), false);
});

test("an install whose .env names the 8B alias keeps it and only ever creates it from 8B", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-8b-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // The bundled host profile (copied by the fixture) now names the 4B alias.
  const bundled = JSON.parse(await fsp.readFile(new URL("../server/host-profile.personal.json", import.meta.url), "utf8"));
  assert.equal(bundled.ollama.model, "qwen3-embedding-4b-honcho-8192");
  const fixture = await hostFixture(root, { embeddingModel: "qwen3-embedding-honcho-8192" });
  const options = ollamaOnlyOptions(fixture);

  const plan = await hostPlan(options);
  assert.equal(plan.ready, true, plan.issues?.join(", "));
  assert.equal(plan.topology.ollama.model, "qwen3-embedding-honcho-8192");
  assert.equal(plan.topology.ollama.baseModel, "qwen3-embedding:8b");

  const prepared = await hostPrepare(options);
  assert.equal(prepared.ready, true, prepared.issues?.join(", "));
  assert.deepEqual(fixture.calls.filter((call) => call.args[0] === "pull").map((call) => call.args[1]), ["qwen3-embedding:8b"]);
  assert.deepEqual(fixture.created.map((item) => [item.model, item.modelfile]), [
    ["qwen3-embedding-honcho-8192", "FROM qwen3-embedding:8b\nPARAMETER num_ctx 8192\n"],
  ]);
  assert.equal(fixture.calls.some((call) => call.args.includes("qwen3-embedding:4b")), false, "nothing touches the 4B base");
  assert.equal(fixture.calls.some((call) => call.args.includes("qwen3-embedding-4b-honcho-8192")), false);
  const config = JSON.parse(await fsp.readFile(prepared.configFile, "utf8"));
  assert.equal(config.ollama.model, "qwen3-embedding-honcho-8192");
});

test("an existing alias that names another known base is recreated from the base its table entry fixes", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-alias-base-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // What `ollama show --modelfile` prints for a healthy alias: a commented hint and a blob path.
  const healthy = "# Modelfile generated by \"ollama show\"\n# FROM qwen3-embedding-honcho-8192:latest\n\nFROM /models/blobs/sha256-abc\nPARAMETER num_ctx 8192\n";
  const kept = await hostFixture(path.join(root, "kept"), {
    embeddingModel: "qwen3-embedding-honcho-8192",
    presentModels: ["qwen3-embedding:8b", "qwen3-embedding-honcho-8192:latest"],
    shown: { "qwen3-embedding-honcho-8192": healthy },
  });
  const keptPlan = await hostPlan(ollamaOnlyOptions(kept));
  assert.equal(keptPlan.ollama.aliasMatches, true);
  assert.equal(keptPlan.operations.some((item) => item.type.startsWith("ollama-")), false, "a healthy production alias is left alone");

  const wrong = await hostFixture(path.join(root, "wrong"), {
    embeddingModel: "qwen3-embedding-honcho-8192",
    presentModels: ["qwen3-embedding:8b", "qwen3-embedding-honcho-8192"],
    shown: { "qwen3-embedding-honcho-8192": "FROM qwen3-embedding:4b\nPARAMETER num_ctx 8192\n" },
  });
  const wrongPlan = await hostPlan(ollamaOnlyOptions(wrong));
  assert.equal(wrongPlan.ollama.aliasPresent, true);
  assert.equal(wrongPlan.ollama.aliasMatches, false);
  const prepared = await hostPrepare(ollamaOnlyOptions(wrong));
  assert.equal(prepared.ready, true, prepared.issues?.join(", "));
  assert.deepEqual(wrong.created.map((item) => [item.model, item.modelfile]), [
    ["qwen3-embedding-honcho-8192", "FROM qwen3-embedding:8b\nPARAMETER num_ctx 8192\n"],
  ]);
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
    ...fakeAutostart().options,
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
    ...fakeAutostart().options,
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
  return { homeDir, appHome, serverDir, env, paths, autostart: fakeAutostart() };
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
    ...fixture.autostart.options,
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
    ...fixture.autostart.options,
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
  assert.ok(fixture.autostart.lines().includes("reg.exe delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v TeamMemoryHost /f"),
    "the Run value goes before the supervisor is stopped");
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

test("supervisor exits 0 on a config it cannot use, so no autostart loops on it, and --log takes its output", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-supervisor-noconfig-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const supervisorFile = fileURLToPath(new URL("../server/host/supervisor.mjs", import.meta.url));
  const logFile = path.join(root, "logs", "supervisor.log");
  const { stdout } = await execFileAsync(process.execPath, [supervisorFile, "--config", path.join(root, "missing.json"), "--log", logFile], { timeout: 5_000 });
  assert.equal(stdout, "", "with --log nothing goes to stdout");
  const lines = (await fsp.readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.event), ["supervisor-config-invalid"]);
  if (process.platform !== "win32") assert.equal((await fsp.stat(logFile)).mode & 0o777, 0o600);
});

test("at login the supervisor waits for Ollama and retries a failed warmup with backoff instead of exiting", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-supervisor-login-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // Ollama's own app is not up yet at login; when it is, the model is not loaded
  // for the first request.
  let embeds = 0;
  const ollama = http.createServer(async (request, reply) => {
    for await (const chunk of request) void chunk;
    reply.setHeader("content-type", "application/json");
    if (request.url === "/api/version") return reply.end(JSON.stringify({ version: "test" }));
    if (request.url === "/api/embed") {
      embeds += 1;
      if (embeds === 1) { reply.statusCode = 500; return reply.end(JSON.stringify({ error: "model is loading" })); }
      return reply.end(JSON.stringify({ embeddings: [Array(1536).fill(0.1)] }));
    }
    reply.statusCode = 404;
    reply.end("{}");
  });
  const port = await freePort();
  t.after(() => new Promise((resolve) => ollama.close(() => resolve())));

  const state = path.join(root, "state");
  await fsp.mkdir(state, { recursive: true });
  const configFile = path.join(state, "host-config.json");
  const pidFile = path.join(state, "pid.json");
  const logFile = path.join(state, "logs", "supervisor.log");
  const supervisorFile = fileURLToPath(new URL("../server/host/supervisor.mjs", import.meta.url));
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    ollama: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}`,
      // Not this app's copy: it gets its grace, and this path is never run.
      executable: path.join(root, "no-such-ollama"),
      owned: false,
      manageService: true,
      model: "qwen3-embedding-4b-honcho-8192",
      dimensions: 1536,
      keepAlive: -1,
      warmIntervalMs: 60_000,
      warmRetryMs: 200,
      startupGraceMs: 20_000,
      serviceCheckIntervalMs: 60_000,
    },
    state: { configFile, pidFile, logDir: path.dirname(logFile) },
    supervisorFile,
  }));
  const child = spawn(process.execPath, [supervisorFile, "--config", configFile, "--log", logFile], { stdio: "ignore" });
  t.after(() => { if (child.exitCode == null) child.kill("SIGKILL"); });
  const events = async () => (await fsp.readFile(logFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).event);

  assert.equal(await waitUntil(async () => (await events()).includes("ollama-waiting")), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, "still running with no Ollama");
  await new Promise((resolve) => ollama.listen(port, "127.0.0.1", resolve));

  assert.equal(await waitUntil(async () => (await events()).includes("embedding-resident")), true, JSON.stringify(await events()));
  const seen = await events();
  assert.ok(seen.indexOf("embedding-warmup-failed") < seen.indexOf("embedding-warmup-retry"));
  assert.ok(seen.indexOf("embedding-warmup-retry") < seen.indexOf("embedding-resident"), "retried long before the 60 s warm interval");
  assert.equal(seen.includes("ollama-started") || seen.includes("ollama-error"), false, "Ollama's own app came up; no second serve was started");

  child.kill("SIGTERM");
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 5_000);
    timer.unref();
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, "a deliberate stop exits 0, which launchd and systemd do not restart");
});

async function autostartFixture(t, platform) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `honcho-agent-bridge-host-autostart-${platform}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  // OLLAMA_MODELS reaches the supervisor at login too; a key never does.
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome, SystemRoot: "C:\\Windows", OLLAMA_MODELS: "/Volumes/models", OLLAMA_API_KEY: "must-not-be-written", OLLAMA_HOST: "0.0.0.0" };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform, env, homeDir });
  await writeRuntimeConfig(paths, { enabled: false, baseUrl: "http://127.0.0.1:11434", model: "unused" });
  await placeGatewayCli(paths.gatewayDir);
  const autostart = fakeAutostart();
  const spawned = [];
  const ran = [];
  const options = {
    profile: "personal",
    installedServerDir: serverDir,
    platform,
    env,
    homeDir,
    skipPrepare: true,
    startTimeoutMs: 200,
    statusPollMs: 10,
    nodePath: "/absolute/node",
    fetchImpl: async () => response({ status: "ok" }),
    run: async (command, args) => { ran.push({ command, args }); return { ok: true, stdout: "", stderr: "" }; },
    gatewayRunner: healthyGatewayRunner(),
    spawnImpl: (command, args, spawnOptions) => {
      spawned.push({ command, args, spawnOptions });
      return { unref() {} };
    },
    ...autostart.options,
  };
  const command = ["/absolute/node", paths.supervisorFile, "--config", paths.configFile, "--log", path.join(paths.logDir, "supervisor.log")];
  return { root, homeDir, paths, autostart, spawned, ran, options, command };
}

test("macOS: host start registers a RunAtLoad LaunchAgent that restarts only a crashed supervisor, and starts it through launchd", async (t) => {
  const f = await autostartFixture(t, "darwin");
  const plistPath = path.join(f.homeDir, "Library", "LaunchAgents", `${HOST_LAUNCHD_LABEL}.plist`);

  const started = await hostStart(f.options);
  assert.equal(started.started, true);
  assert.equal(started.startedBy, "launchd");
  assert.equal(started.alreadyRunning, false);
  assert.deepEqual(f.spawned, [], "launchd starts it, not a detached spawn");
  assert.deepEqual(f.autostart.lines(), [
    `launchctl print gui/501/${HOST_LAUNCHD_LABEL}`,
    `launchctl bootstrap gui/501 ${plistPath}`,
  ]);
  assert.deepEqual(started.autostart, { registered: true, kind: "launchd", path: plistPath, changed: true });
  assert.equal("warnings" in started, false);

  const plist = await fsp.readFile(plistPath, "utf8");
  assert.ok(plist.includes(`<key>Label</key>\n\t<string>${HOST_LAUNCHD_LABEL}</string>`));
  assert.ok(plist.includes(`<key>ProgramArguments</key>\n\t<array>\n${f.command.map((part) => `\t\t<string>${part}</string>`).join("\n")}\n\t</array>`),
    "exactly what host start would spawn");
  assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  // A duplicate exits 0 at once (the PID file), and so does a stop; only a crash is restarted.
  assert.match(plist, /<key>KeepAlive<\/key>\n\t<dict>\n\t\t<key>SuccessfulExit<\/key>\n\t\t<false\/>\n\t<\/dict>/);
  assert.ok(plist.includes(`<key>WorkingDirectory</key>\n\t<string>${f.paths.runtimeDir}</string>`));
  assert.ok(plist.includes(`<key>StandardErrorPath</key>\n\t<string>${path.join(f.paths.logDir, "supervisor.error.log")}</string>`));
  assert.ok(plist.includes(`<key>HOME</key>\n\t\t<string>${f.homeDir}</string>`));
  assert.ok(plist.includes("<key>OLLAMA_MODELS</key>\n\t\t<string>/Volumes/models</string>"));
  assert.equal(plist.includes("must-not-be-written"), false, "no credential-like variable");
  assert.equal(plist.includes("OLLAMA_HOST"), false, "the host config says where Ollama listens");
  await fsp.access(f.paths.logDir);

  assert.deepEqual((await hostStatus(f.options)).autostart, { registered: true, kind: "launchd" });

  // Running, and the agent unchanged: left alone.
  await claimPid(f.paths);
  f.autostart.calls.length = 0;
  const again = await hostStart(f.options);
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.started, false);
  assert.deepEqual(f.autostart.lines(), [`launchctl print gui/501/${HOST_LAUNCHD_LABEL}`]);
  assert.equal(again.autostart.changed, false);

  // Loaded but not running (stopped by hand): kickstarted, not bootstrapped twice.
  await fsp.rm(f.paths.pidFile);
  f.autostart.state.running = false;
  f.autostart.calls.length = 0;
  const kicked = await hostStart(f.options);
  assert.equal(kicked.startedBy, "launchd");
  assert.deepEqual(f.autostart.lines(), [
    `launchctl print gui/501/${HOST_LAUNCHD_LABEL}`,
    `launchctl kickstart gui/501/${HOST_LAUNCHD_LABEL}`,
  ]);
  assert.deepEqual(f.spawned, []);

  // A new node (an upgrade, say) changes the agent: booted out and bootstrapped again.
  f.autostart.calls.length = 0;
  await hostStart({ ...f.options, nodePath: "/newer/node" });
  assert.deepEqual(f.autostart.lines().map((line) => line.split(" ").slice(0, 2).join(" ")), ["launchctl print", "launchctl bootout", "launchctl bootstrap"]);
  assert.ok((await fsp.readFile(plistPath, "utf8")).includes("<string>/newer/node</string>"));

  f.autostart.calls.length = 0;
  const stopped = await hostStop(f.options);
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.autostart, { registered: false, kind: "launchd", removed: true });
  assert.ok(f.autostart.lines().includes(`launchctl bootout gui/501/${HOST_LAUNCHD_LABEL}`));
  await assert.rejects(fsp.access(plistPath));
  assert.deepEqual((await hostStatus(f.options)).autostart, { registered: false, kind: "launchd" });
  assert.equal(f.ran.some((call) => OS_REGISTRATION.test(call.command)), false, "the Ollama runner never registers anything");
});

test("Windows: host start sets the TeamMemoryHost Run value to a hidden wscript and starts the same command now", async (t) => {
  const f = await autostartFixture(t, "win32");
  const vbsPath = path.join(f.paths.runtimeDir, "supervisor.vbs");
  const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

  const started = await hostStart(f.options);
  assert.equal(started.startedBy, "spawn", "a Run value only acts at the next logon");
  const added = f.autostart.calls.find((call) => call.command.endsWith("reg.exe") && call.args[0] === "add");
  assert.deepEqual(added.args, [
    "add", runKey, "/v", HOST_RUN_VALUE, "/t", "REG_SZ", "/d",
    `"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "${vbsPath}"`, "/f",
  ]);
  const raw = await fsp.readFile(vbsPath);
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], "UTF-16 so any path survives");
  const vbs = raw.subarray(2).toString("utf16le");
  assert.ok(vbs.includes(`shell.CurrentDirectory = "${f.paths.runtimeDir}"`));
  assert.ok(vbs.includes(`shell.Run "${f.command.join(" ")}", 0, False`), vbs);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].command, f.command[0]);
  assert.deepEqual(f.spawned[0].args, f.command.slice(1), "the same command the Run value starts at logon");
  assert.equal(f.spawned[0].spawnOptions.detached, true);
  assert.deepEqual(started.autostart, { registered: true, kind: "windows-run", path: vbsPath, changed: true });
  assert.deepEqual((await hostStatus(f.options)).autostart, { registered: true, kind: "windows-run" });

  const stopped = await hostStop(f.options);
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.autostart, { registered: false, kind: "windows-run", removed: true });
  assert.ok(f.autostart.lines().includes(`reg.exe delete ${runKey} /v ${HOST_RUN_VALUE} /f`));
  await assert.rejects(fsp.access(vbsPath));
  assert.deepEqual((await hostStatus(f.options)).autostart, { registered: false, kind: "windows-run" });
});

test("Linux: host start enables team-memory-host.service and starts the supervisor through systemd", async (t) => {
  const f = await autostartFixture(t, "linux");
  const unitPath = path.join(f.homeDir, ".config", "systemd", "user", HOST_SYSTEMD_UNIT);

  const started = await hostStart(f.options);
  assert.equal(started.startedBy, "systemd");
  assert.deepEqual(f.spawned, []);
  assert.deepEqual(f.autostart.lines(), [
    "systemctl --user show-environment",
    "systemctl --user daemon-reload",
    `systemctl --user enable ${HOST_SYSTEMD_UNIT}`,
    `systemctl --user restart ${HOST_SYSTEMD_UNIT}`,
  ]);
  const unit = await fsp.readFile(unitPath, "utf8");
  assert.ok(unit.includes(`ExecStart=${f.command.map((part) => `"${part}"`).join(" ")}`), unit);
  assert.ok(unit.includes(`WorkingDirectory=${f.paths.runtimeDir}`));
  assert.ok(unit.includes('Environment="OLLAMA_MODELS=/Volumes/models"'));
  assert.equal(unit.includes("must-not-be-written"), false);
  assert.match(unit, /^Restart=on-failure$/m, "a duplicate or a stop exits 0 and is not restarted");
  assert.ok(unit.includes(`StandardError=append:${path.join(f.paths.logDir, "supervisor.error.log")}`));
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.deepEqual((await hostStatus(f.options)).autostart, { registered: true, kind: "systemd" });

  f.autostart.calls.length = 0;
  const stopped = await hostStop(f.options);
  assert.equal(stopped.ok, true);
  assert.deepEqual(f.autostart.lines(), [
    `systemctl --user disable --now ${HOST_SYSTEMD_UNIT}`,
    "systemctl --user daemon-reload",
  ]);
  await assert.rejects(fsp.access(unitPath));
  assert.deepEqual((await hostStatus(f.options)).autostart, { registered: false, kind: "systemd" });
});

test("host start still starts the supervisor when no autostart can be registered, and says so", async (t) => {
  const f = await autostartFixture(t, "linux");
  f.autostart.state.systemdAvailable = false;
  const started = await hostStart(f.options);
  assert.equal(started.startedBy, "spawn");
  assert.deepEqual(f.spawned[0].args, f.command.slice(1));
  assert.equal(started.autostart.registered, false);
  assert.equal(started.autostart.kind, "systemd");
  assert.match(started.autostart.error, /systemd --user is not available, so the host supervisor cannot start by itself/);
  assert.match(started.warnings[0], /will not come back after a reboot/);
});

test("host stop fails when the autostart cannot be removed, since the supervisor would come back at login", async (t) => {
  const f = await autostartFixture(t, "darwin");
  await hostStart(f.options);
  const failing = async (command, args) => (args[0] === "bootout"
    ? { code: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error" }
    : f.autostart.runner(command, args));
  const stopped = await hostStop({ ...f.options, autostartRunner: failing });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.autostart.registered, true);
  assert.match(stopped.autostart.error, /launchctl bootout failed: Boot-out failed/);
  assert.match(stopped.warning, /may start again at the next login/);
});

test("a full host start installs the gateway through its CLI and registers only the supervisor's own autostart", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-full-start-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fixture = await hostFixture(root);
  const gatewayCalls = [];
  const spawned = [];
  const autostart = fakeAutostart();
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
    ...autostart.options,
  });
  // launchd is a stand-in, so the supervisor's PID file never appears; everything
  // this start could do by itself has still happened.
  assert.deepEqual(gatewayCalls.map((call) => call.args[1]).slice(0, 2), ["install", "status"]);
  assert.deepEqual(spawned, [], "the supervisor starts through its LaunchAgent");
  assert.deepEqual(autostart.lines().map((line) => line.split(" ").slice(0, 3).join(" ")), [
    `launchctl print gui/501/${HOST_LAUNCHD_LABEL}`,
    "launchctl bootstrap gui/501",
  ]);
  assert.equal(fixture.calls.some((call) => OS_REGISTRATION.test(call.command)), false, "the Ollama runner never registers anything");
  assert.equal(result.gateway.router.ok, true);
  assert.equal(result.autostart.registered, true);
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
