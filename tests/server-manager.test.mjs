import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyServerBundle,
  dockerCliEnvironment,
  ensureHonchoSource,
  honchoSourcePin,
  honchoSourceProbe,
  serverPlan,
  serverPrepare,
  serverStart,
  serverStatus,
  serverStop,
  serverVerify,
} from "../scripts/server-manager.mjs";

// Nothing in this file may reach the network. Every call that could fetch the
// Honcho source is given its own runner or a stub.
const noFetch = async () => ({ ok: true, fetched: false, directory: "(stubbed)" });

const ROUTER_KEY = "0123456789abcdef".repeat(4);
const CHAT_PREFIXES = [
  "DERIVER_MODEL_CONFIG",
  "SUMMARY_MODEL_CONFIG",
  "DREAM_DEDUCTION_MODEL_CONFIG",
  "DREAM_INDUCTION_MODEL_CONFIG",
  ...["minimal", "low", "medium", "high", "max"].map((level) => `DIALECTIC_LEVELS__${level}__MODEL_CONFIG`),
];

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

// The gateway is a separate program with its own CLI. Every personal prepare here
// gets a stand-in for fetching its source and for running that CLI, the same way
// every prepare gets `noFetch` for the Honcho source.
function fakeGateway({
  ready = true,
  apiKey = ROUTER_KEY,
  models = ["claude-sonnet-5-5", "gpt-6-luna"],
  install = { ok: true, autostart: "launchd", uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" },
} = {}) {
  const calls = [];
  return {
    calls,
    options: {
      gatewaySourceFetcher: async ({ directory }) => {
        await fsp.mkdir(path.join(directory, "gateway"), { recursive: true });
        await fsp.writeFile(path.join(directory, "gateway", "cli.mjs"), "// stand-in; never executed\n");
        return { ok: true, fetched: false, updated: false, state: "current", directory };
      },
      gatewayRunner: async (_command, args) => {
        calls.push(args[1]);
        if (args[1] === "install") return { code: install.ok ? 0 : 1, stdout: JSON.stringify(install) };
        if (args[1] === "connect-info") {
          return {
            code: 0,
            stdout: JSON.stringify(ready
              ? { ok: true, ready: true, baseUrl: "http://127.0.0.1:11400/v1", apiKey, models, reason: "" }
              : { ok: true, ready: false, models: [], reason: "no account is logged in" }),
          };
        }
        return { code: 1, stdout: JSON.stringify({ ok: false, error: `unexpected ${args[1]}` }) };
      },
    },
  };
}

const gatewayStub = () => fakeGateway().options;

test("Windows Compose uses an isolated anonymous Docker config without changing the user config", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-docker-config-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "server");
  const environment = await dockerCliEnvironment(serverDirectory, {
    platform: "win32",
    env: { USERPROFILE: path.join(root, "user") },
  });
  assert.equal(environment.COMPOSE_PROJECT_NAME, "honcho-agent-bridge");
  assert.equal(environment.DOCKER_CONFIG, path.join(root, "runtime", "docker-cli"));
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(environment.DOCKER_CONFIG, "config.json"), "utf8")),
    { auths: { "https://index.docker.io/v1/": {} } },
  );
  assert.equal(environment.DOCKER_CONFIG.includes(environment.USERPROFILE), false);
});

test("server lifecycle rejects mistyped profiles before any mutation", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-invalid-profile-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "installed");
  let called = false;
  const hostRuntime = new Proxy({}, { get: () => async () => { called = true; return { ok: true }; } });
  const runner = async () => { called = true; return { stdout: "", stderr: "" }; };
  const inspector = async () => { called = true; return { installed: true, running: true }; };

  await assert.rejects(serverPrepare({
    profile: "personl",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: root } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  }), /Unsupported server profile/);
  await assert.rejects(serverStart({
    profile: "personl",
    hostRuntime,
    preparedServer: { ok: true, ready: true },
    serverDirectory: destination,
    composeRunner: runner,
  }), /Unsupported server profile/);
  await assert.rejects(serverStatus({
    profile: "personl",
    hostRuntime,
    serverDirectory: destination,
    dockerInspector: inspector,
    composeRunner: runner,
  }), /Unsupported server profile/);
  await assert.rejects(serverStop({
    profile: "personl",
    hostRuntime,
    serverDirectory: destination,
    composeRunner: runner,
  }), /Unsupported server profile/);
  await assert.rejects(serverVerify({ profile: "personl", serverDirectory: destination }), /Unsupported server profile/);
  assert.equal(called, false);
  await assert.rejects(fsp.access(destination));
});

test("personal plan fails closed on native Linux", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-linux-plan-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const personal = await serverPlan({
    profile: "personal",
    platform: "linux",
    dockerInspector: async () => ({ installed: true, running: true }),
    bundleInspector: async () => ({ ok: true, directory: root, missing: [] }),
  });
  assert.equal(personal.ready, false);
  assert.ok(personal.issues.some((item) => item.includes("requires macOS or Windows")));
});

test("server bundle updates preserve the installed private environment", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-server-copy-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  await fsp.mkdir(source, { recursive: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(source, "compose.yaml"), "name: updated\n");
  await fsp.writeFile(path.join(source, ".env"), "LLM_OPENAI_API_KEY=must-not-install\n");
  await fsp.writeFile(path.join(destination, "compose.yaml"), "name: old\n");
  await fsp.writeFile(path.join(destination, ".env"), "LLM_OPENAI_API_KEY=private-existing\n", { mode: 0o600 });

  const result = await copyServerBundle(source, destination);
  assert.equal(result.changed, true);
  assert.equal(await fsp.readFile(path.join(destination, "compose.yaml"), "utf8"), "name: updated\n");
  assert.equal(await fsp.readFile(path.join(destination, ".env"), "utf8"), "LLM_OPENAI_API_KEY=private-existing\n");
  assert.equal(await fsp.readFile(path.join(`${destination}.previous`, "compose.yaml"), "utf8"), "name: old\n");
  assert.equal(await fsp.readFile(path.join(`${destination}.previous`, ".env"), "utf8"), "LLM_OPENAI_API_KEY=private-existing\n");
  if (process.platform !== "win32") {
    assert.equal((await fsp.stat(path.join(destination, ".env"))).mode & 0o777, 0o600);
  }
});

test("server bundle swap restores both current and prior backup when the final rename fails", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-server-swap-failure-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  await fsp.mkdir(source, { recursive: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(source, "marker"), "candidate\n");
  await fsp.writeFile(path.join(destination, "marker"), "current\n");
  await fsp.writeFile(path.join(previous, "marker"), "prior-backup\n");
  const fileSystem = new Proxy(fsp, {
    get(target, property) {
      if (property !== "rename") return target[property];
      return async (from, to) => {
        if (String(from).includes(".candidate-") && path.resolve(to) === path.resolve(destination)) {
          throw new Error("injected final rename failure");
        }
        return fsp.rename(from, to);
      };
    },
  });

  await assert.rejects(
    copyServerBundle(source, destination, { fileSystem }),
    /injected final rename failure/,
  );
  assert.equal(await fsp.readFile(path.join(destination, "marker"), "utf8"), "current\n");
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "prior-backup\n");
  const leftovers = (await fsp.readdir(root)).filter(item => /\.(?:candidate|failed|saved)-/.test(item));
  assert.deepEqual(leftovers, []);
});

test("server bundle swap reports a secret-bearing candidate retained after cleanup failure", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-server-retained-candidate-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  const secretEnvironment = "LLM_OPENAI_API_KEY=retained-candidate-secret\n";
  await fsp.mkdir(source, { recursive: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(source, "marker"), "candidate\n");
  await fsp.writeFile(path.join(destination, "marker"), "current\n");
  await fsp.writeFile(path.join(destination, ".env"), secretEnvironment);
  await fsp.writeFile(path.join(previous, "marker"), "prior-backup\n");
  let finalRenameFailed = false;
  const fileSystem = new Proxy(fsp, {
    get(target, property) {
      if (property === "rename") {
        return async (from, to) => {
          if (String(from).includes(".candidate-") && path.resolve(to) === path.resolve(destination)) {
            finalRenameFailed = true;
            throw new Error("injected final rename failure");
          }
          return fsp.rename(from, to);
        };
      }
      if (property === "rm") {
        return async (targetPath, options) => {
          if (finalRenameFailed && String(targetPath).includes(".candidate-")) {
            throw new Error("injected candidate cleanup failure");
          }
          return fsp.rm(targetPath, options);
        };
      }
      return target[property];
    },
  });
  let captured;

  await assert.rejects(copyServerBundle(source, destination, { fileSystem }), (error) => {
    captured = error;
    return /injected final rename failure/.test(error.message)
      && /injected candidate cleanup failure/.test(error.message);
  });
  assert.equal(captured.rollback.ok, false);
  assert.ok(captured.rollback.issues.some(item => item.includes("candidate bundle cleanup failed")));
  assert.equal(captured.rollback.retainedPaths.length, 1);
  const retained = captured.rollback.retainedPaths[0];
  assert.ok(retained.includes(".candidate-"));
  assert.equal(await fsp.readFile(path.join(retained, ".env"), "utf8"), secretEnvironment);
  assert.equal(await fsp.readFile(path.join(destination, "marker"), "utf8"), "current\n");
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "prior-backup\n");
});

test("successful bundle swap reports a retained saved backup when its cleanup fails", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-server-retained-saved-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  const priorSecret = "LLM_OPENAI_API_KEY=prior-backup-secret\n";
  await fsp.mkdir(source, { recursive: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(source, "marker"), "candidate\n");
  await fsp.writeFile(path.join(destination, "marker"), "current\n");
  await fsp.writeFile(path.join(previous, ".env"), priorSecret);
  const fileSystem = new Proxy(fsp, {
    get(target, property) {
      if (property !== "rm") return target[property];
      return async (targetPath, options) => {
        if (String(targetPath).includes(".previous.saved-")) {
          throw new Error("injected saved backup cleanup failure");
        }
        return fsp.rm(targetPath, options);
      };
    },
  });

  const result = await copyServerBundle(source, destination, { fileSystem });
  assert.equal(result.ok, false);
  assert.equal(result.cleanup.ok, false);
  assert.match(result.cleanup.issues[0], /saved backup cleanup failure/);
  assert.equal(result.retainedPaths.length, 1);
  assert.ok(result.retainedPaths[0].includes(".previous.saved-"));
  assert.equal(await fsp.readFile(path.join(result.retainedPaths[0], ".env"), "utf8"), priorSecret);
  assert.equal(await fsp.readFile(path.join(destination, "marker"), "utf8"), "candidate\n");
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "current\n");
});

test("portable prepare fails closed and propagates retained backup cleanup details", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-portable-retained-saved-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  const priorSecret = "LLM_OPENAI_API_KEY=portable-prior-secret\n";
  await fsp.mkdir(source, { recursive: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(source, "compose.yaml"), "name: portable-candidate\n");
  await fsp.writeFile(path.join(source, ".env.example"), "LLM_OPENAI_API_KEY=\n");
  await fsp.writeFile(path.join(destination, "marker"), "portable-current\n");
  await fsp.writeFile(path.join(destination, ".env"), "LLM_OPENAI_API_KEY=current-secret\n");
  await fsp.writeFile(path.join(previous, ".env"), priorSecret);
  const fileSystem = new Proxy(fsp, {
    get(target, property) {
      if (property !== "rm") return target[property];
      return async (targetPath, options) => {
        if (String(targetPath).includes(".previous.saved-")) {
          throw new Error("injected portable saved cleanup failure");
        }
        return fsp.rm(targetPath, options);
      };
    },
  });

  const result = await serverPrepare({
    profile: "portable",
    fileSystem,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ready, false);
  assert.match(result.issues[0], /portable saved cleanup failure/);
  assert.equal(result.retainedPaths.length, 1);
  assert.ok(result.retainedPaths[0].includes(".previous.saved-"));
  assert.equal(await fsp.readFile(path.join(result.retainedPaths[0], ".env"), "utf8"), priorSecret);
  assert.equal(await fsp.readFile(path.join(destination, "compose.yaml"), "utf8"), "name: portable-candidate\n");
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "portable-current\n");
});

async function personalBundle(root) {
  const source = path.join(root, "source");
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, "compose.yaml"), "name: test\n");
  await fsp.writeFile(path.join(source, "host-profile.personal.json"), JSON.stringify({
    gateway: { uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" },
  }));
  await fsp.writeFile(path.join(source, "gateway-source.json"), JSON.stringify({
    repo: "https://github.com/team-memory-system/subscription-gateway",
    ref: "main",
  }));
  await fsp.writeFile(path.join(source, "env.personal.example"), `
POSTGRES_PASSWORD=
LLM_VLLM_API_KEY=
LLM_VLLM_BASE_URL=http://host.docker.internal:11400/v1
DERIVER_MODEL_CONFIG__TRANSPORT=openai
DERIVER_MODEL_CONFIG__MODEL=gpt-6-luna
DERIVER_MODEL_CONFIG__THINKING_EFFORT=low
DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11400/v1
DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_VLLM_API_KEY
EMBEDDING_MAX_INPUT_TOKENS=8192
EMBEDDING_MODEL_CONFIG__TRANSPORT=openai
EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192
EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_OPENAI_COMPATIBLE_API_KEY
DIALECTIC_LEVELS__high__MODEL_CONFIG__THINKING_EFFORT=low
`);
  return source;
}

test("personal server prepare adds missing safe profile settings without replacing other secrets or custom values", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-profile-merge-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, ".env"), [
    "POSTGRES_PASSWORD=private-existing-password",
    "LLM_VLLM_API_KEY=private-existing-key",
    "LLM_OPENAI_COMPATIBLE_API_KEY=private-ollama-key",
    "CUSTOM_SETTING=keep-me",
    "DERIVER_MODEL_CONFIG__MODEL=gpt-old",
    "DERIVER_MODEL_CONFIG__THINKING_EFFORT=low",
    "DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY=private-direct-key",
    "DERIVER_MODEL_CONFIG__FALLBACK__MODEL=external-model",
    "DERIVER_MODEL_CONFIG__OVERRIDES__PROVIDER_PARAMS__EXTRA_HEADERS__AUTHORIZATION=Basic private-header",
    "EMBEDDING_MAX_INPUT_TOKENS=2048",
    "",
  ].join("\n"), { mode: 0o600 });
  let installedEnvironment = "";
  const result = await serverPrepare({
    profile: "personal",
    hostRuntime: {
      status: async () => ({ running: false }),
      prepare: async ({ installedServerDir }) => {
        installedEnvironment = await fsp.readFile(path.join(installedServerDir, ".env"), "utf8");
        return { ok: true, ready: true };
      },
    },
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.environment.created, false);
  assert.equal(result.environment.updated, true);
  assert.match(installedEnvironment, /^POSTGRES_PASSWORD=private-existing-password$/m);
  assert.match(installedEnvironment, /^LLM_OPENAI_COMPATIBLE_API_KEY=private-ollama-key$/m);
  // The router key belongs to the gateway, so the gateway's replaces the old one.
  assert.match(installedEnvironment, new RegExp(`^LLM_VLLM_API_KEY=${ROUTER_KEY}$`, "m"));
  assert.match(installedEnvironment, /^CUSTOM_SETTING=keep-me$/m);
  assert.match(installedEnvironment, /^DERIVER_MODEL_CONFIG__MODEL=gpt-6-luna$/m);
  assert.match(installedEnvironment, /^DERIVER_MODEL_CONFIG__THINKING_EFFORT=low$/m);
  assert.match(installedEnvironment, /^EMBEDDING_MAX_INPUT_TOKENS=8192$/m);
  assert.match(installedEnvironment, /^DIALECTIC_LEVELS__high__MODEL_CONFIG__THINKING_EFFORT=low$/m);
  assert.equal((installedEnvironment.match(/^LLM_VLLM_API_KEY=/gm) || []).length, 1);
  assert.equal(installedEnvironment.includes("private-direct-key"), false);
  assert.equal(installedEnvironment.includes("external-model"), false);
  assert.equal(installedEnvironment.includes("private-header"), false);
});

test("personal server prepare generates only missing local secrets for an existing environment", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-existing-secrets-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, ".env"), "CUSTOM_SETTING=keep-me\n", { mode: 0o600 });
  let environment = {};
  const result = await serverPrepare({
    profile: "personal",
    hostRuntime: {
      status: async () => ({ running: false }),
      prepare: async ({ installedServerDir }) => {
        environment = Object.fromEntries((await fsp.readFile(path.join(installedServerDir, ".env"), "utf8")).split(/\r?\n/).flatMap((line) => {
          const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
          return match ? [[match[1], match[2]]] : [];
        }));
        return { ok: true, ready: true };
      },
    },
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(environment.CUSTOM_SETTING, "keep-me");
  assert.ok(environment.POSTGRES_PASSWORD.length >= 24);
  assert.equal(environment.LLM_VLLM_API_KEY, ROUTER_KEY, "the router key comes from the gateway, not from this installer");
  assert.equal(environment.LLM_OPENAI_COMPATIBLE_API_KEY, "ollama-local");
});

test("personal server prepare installs its environment before preparing host services", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-prepare-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const events = [];
  const hostRuntime = {
    prepare: async ({ profile, installedServerDir, skipGateway }) => {
      events.push("host-prepare");
      assert.equal(profile, "personal");
      assert.equal(installedServerDir, destination);
      assert.equal(skipGateway, true, "prepare already installed the gateway");
      const environment = await fsp.readFile(path.join(installedServerDir, ".env"), "utf8");
      assert.match(environment, /POSTGRES_PASSWORD=\S+/);
      assert.match(environment, /LLM_VLLM_API_KEY=\S+/);
      return { ok: true, ready: true, prepared: true };
    },
  };
  const result = await serverPrepare({
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.host.prepared, true);
  assert.deepEqual(events, ["host-prepare"]);
});

test("personal server prepare fails closed before host setup when Windows .env ACLs cannot be restricted", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-acl-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  let hostPrepareCalled = false;
  const aclCalls = [];

  await assert.rejects(
    serverPrepare({
      profile: "personal",
      platform: "win32",
      env: { USERNAME: "alice", SystemRoot: "C:\\Windows" },
      privateFileRunner: async (command, args) => {
        aclCalls.push({ command, args: [...args] });
        if (command.endsWith("\\whoami.exe")) return { ok: true, stdout: '"WORKSTATION\\alice","S-1-5-21-1-2-3-1001"\r\n' };
        if (args.includes("/reset")) return { ok: true };
        return { ok: false };
      },
      hostRuntime: {
        prepare: async () => { hostPrepareCalled = true; return { ok: true, ready: true }; },
      },
      preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
      honchoSourceFetcher: noFetch,
      ...gatewayStub(),
      serverDirectory: destination,
    }),
    /ACL restriction failed/,
  );

  assert.equal(hostPrepareCalled, false);
  assert.ok(aclCalls.some((item) => item.command.endsWith("\\icacls.exe") && item.args.includes("/grant:r")));
  await assert.rejects(fsp.access(path.join(destination, ".env")));
});

test("personal server update stops a running host before swapping the installed bundle", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-update-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, "old-marker"), "old\n");
  const events = [];
  const hostRuntime = {
    status: async () => { events.push("host-status"); return { ok: true, running: true }; },
    stop: async () => {
      events.push("host-stop");
      assert.equal(await fsp.readFile(path.join(destination, "old-marker"), "utf8"), "old\n");
      return { ok: true, stopped: true };
    },
    prepare: async () => {
      events.push("host-prepare");
      await assert.rejects(fsp.access(path.join(destination, "old-marker")));
      return { ok: true, ready: true };
    },
  };
  const result = await serverPrepare({
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostStoppedForUpdate, true);
  assert.deepEqual(events, ["host-status", "host-stop", "host-prepare"]);
});

test("concurrent prepares allow only one candidate to enter and keep the original at previous", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-concurrent-success-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, "marker"), "original-current\n");
  let resolveEntered;
  let releasePrepare;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const release = new Promise(resolve => { releasePrepare = resolve; });
  t.after(() => releasePrepare());
  let prepareCalls = 0;
  const hostRuntime = {
    status: async () => ({ ok: true, running: false }),
    prepare: async () => {
      prepareCalls += 1;
      resolveEntered();
      await release;
      return { ok: true, ready: true };
    },
  };
  const options = {
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  };

  const first = serverPrepare(options);
  await entered;
  await assert.rejects(serverPrepare(options), (error) => error.code === "HONCHO_AGENT_BRIDGE_SERVER_LIFECYCLE_BUSY");
  assert.equal(prepareCalls, 1);
  assert.equal(await fsp.readFile(path.join(destination, "compose.yaml"), "utf8"), "name: test\n");
  assert.equal(await fsp.readFile(path.join(`${destination}.previous`, "marker"), "utf8"), "original-current\n");
  releasePrepare();
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(prepareCalls, 1);
  assert.equal(await fsp.readFile(path.join(`${destination}.previous`, "marker"), "utf8"), "original-current\n");
  await assert.rejects(fsp.access(`${destination}.lifecycle.lock`));
});

test("concurrent rejected prepare cannot disturb rollback of the original and its prior previous", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-concurrent-rollback-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(destination, "marker"), "original-current\n");
  await fsp.writeFile(path.join(previous, "marker"), "original-previous\n");
  let resolveEntered;
  let releasePrepare;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const release = new Promise(resolve => { releasePrepare = resolve; });
  t.after(() => releasePrepare());
  let prepareCalls = 0;
  const hostRuntime = {
    status: async () => ({ ok: true, running: false }),
    prepare: async () => {
      prepareCalls += 1;
      resolveEntered();
      await release;
      return { ok: false, ready: false, issues: ["candidate rejected after barrier"] };
    },
  };
  const options = {
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  };

  const first = serverPrepare(options);
  await entered;
  await assert.rejects(serverPrepare(options), (error) => error.code === "HONCHO_AGENT_BRIDGE_SERVER_LIFECYCLE_BUSY");
  assert.equal(prepareCalls, 1);
  releasePrepare();
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.rollback.ok, true);
  assert.equal(prepareCalls, 1);
  assert.equal(await fsp.readFile(path.join(destination, "marker"), "utf8"), "original-current\n");
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "original-previous\n");
  await assert.rejects(fsp.access(`${destination}.lifecycle.lock`));
});

test("personal update validates candidate secrets before inspecting or stopping the running host", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-candidate-secrets-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  // The chat settings all take the gateway's key, so the missing one is an
  // embedding provider's.
  await fsp.appendFile(path.join(source, "env.personal.example"), [
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_UNAVAILABLE_API_KEY",
    "",
  ].join("\n"));
  const destination = path.join(root, "installed");
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, "old-marker"), "old\n");
  let hostCalled = false;
  const hostRuntime = new Proxy({}, { get: () => async () => { hostCalled = true; return { ok: true, ready: true }; } });

  const result = await serverPrepare({
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingSecretFields, ["LLM_UNAVAILABLE_API_KEY"]);
  assert.equal(result.hostStoppedForUpdate, false);
  assert.equal(hostCalled, false);
  assert.equal(await fsp.readFile(path.join(destination, "old-marker"), "utf8"), "old\n");
  assert.equal((await fsp.readdir(root)).some(item => item.includes(".candidate-")), false);
});

test("personal host readiness failure restores both backups and restarts the previously running host", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-host-rollback-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(destination, "marker"), "current\n");
  const originalEnvironment = "POSTGRES_PASSWORD=private\nLLM_VLLM_API_KEY=private-vllm\nLLM_OPENAI_COMPATIBLE_API_KEY=private-ollama\n";
  await fsp.writeFile(path.join(destination, ".env"), originalEnvironment);
  await fsp.writeFile(path.join(previous, "marker"), "prior-backup\n");
  const events = [];
  let prepareCalls = 0;
  const hostRuntime = {
    status: async () => ({ ok: true, running: true }),
    stop: async () => { events.push("stop"); return { ok: true, stopped: true }; },
    prepare: async ({ installedServerDir }) => {
      prepareCalls += 1;
      if (prepareCalls === 1) {
        events.push("prepare-candidate");
        assert.equal(await fsp.readFile(path.join(installedServerDir, "compose.yaml"), "utf8"), "name: test\n");
        return { ok: false, ready: false, issues: ["candidate Ollama is unavailable"] };
      }
      events.push("prepare-restored");
      assert.equal(await fsp.readFile(path.join(installedServerDir, "marker"), "utf8"), "current\n");
      return { ok: true, ready: true };
    },
    start: async ({ skipPrepare }) => {
      assert.equal(skipPrepare, true);
      events.push("start-restored");
      return { ok: true, running: true };
    },
  };

  const result = await serverPrepare({
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ready, false);
  assert.equal(result.rollback.ok, true);
  assert.equal(result.rollback.restored, true);
  assert.match(result.issues[0], /candidate Ollama is unavailable/);
  assert.deepEqual(events, ["stop", "prepare-candidate", "prepare-restored", "start-restored"]);
  assert.equal(await fsp.readFile(path.join(destination, "marker"), "utf8"), "current\n");
  assert.equal(await fsp.readFile(path.join(destination, ".env"), "utf8"), originalEnvironment);
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "prior-backup\n");
});

test("fresh personal host failure removes the candidate installation", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-fresh-rollback-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const result = await serverPrepare({
    profile: "personal",
    hostRuntime: {
      prepare: async () => ({ ok: false, ready: false, issues: ["host profile rejected"] }),
    },
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, false);
  assert.equal(result.rollback.ok, true);
  assert.equal(result.rollback.bundle.removedFreshInstall, true);
  await assert.rejects(fsp.access(destination));
  assert.equal((await fsp.readdir(root)).some(item => item.includes(".candidate-") || item.includes(".failed-")), false);
});

test("personal rollback reports a retained failed candidate instead of hiding cleanup failure", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-retained-failed-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  const originalEnvironment = "POSTGRES_PASSWORD=private\nLLM_VLLM_API_KEY=private-vllm\nLLM_OPENAI_COMPATIBLE_API_KEY=private-ollama\n";
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(destination, "marker"), "original-current\n");
  await fsp.writeFile(path.join(destination, ".env"), originalEnvironment);
  await fsp.writeFile(path.join(previous, "marker"), "original-previous\n");
  const fileSystem = new Proxy(fsp, {
    get(target, property) {
      if (property !== "rm") return target[property];
      return async (targetPath, options) => {
        if (String(targetPath).includes(".failed-")) {
          throw new Error("injected failed candidate cleanup failure");
        }
        return fsp.rm(targetPath, options);
      };
    },
  });

  const result = await serverPrepare({
    profile: "personal",
    fileSystem,
    hostRuntime: {
      status: async () => ({ ok: true, running: false }),
      prepare: async () => ({ ok: false, ready: false, issues: ["candidate host rejected"] }),
    },
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  });
  assert.equal(result.ok, false);
  assert.equal(result.rollback.ok, false);
  assert.ok(result.rollback.issues.some(item => item.includes("failed candidate cleanup failure")));
  assert.equal(result.retainedPaths.length, 1);
  const retained = result.retainedPaths[0];
  assert.ok(retained.includes(".failed-"));
  assert.match(await fsp.readFile(path.join(retained, ".env"), "utf8"), new RegExp(`^LLM_VLLM_API_KEY=${ROUTER_KEY}$`, "m"));
  assert.equal(await fsp.readFile(path.join(destination, "marker"), "utf8"), "original-current\n");
  assert.equal(await fsp.readFile(path.join(destination, ".env"), "utf8"), originalEnvironment);
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "original-previous\n");
});

test("personal host exception keeps the original error visible when host recovery also fails", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-recovery-error-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const previous = `${destination}.previous`;
  await fsp.mkdir(destination, { recursive: true });
  await fsp.mkdir(previous, { recursive: true });
  await fsp.writeFile(path.join(destination, "marker"), "current\n");
  await fsp.writeFile(path.join(previous, "marker"), "prior-backup\n");
  let prepareCalls = 0;
  const original = new Error("candidate preparation exploded");
  let captured;

  await assert.rejects(serverPrepare({
    profile: "personal",
    hostRuntime: {
      status: async () => ({ ok: true, running: true }),
      stop: async () => ({ ok: true, stopped: true }),
      prepare: async () => {
        prepareCalls += 1;
        if (prepareCalls === 1) throw original;
        throw new Error("restored host preparation exploded");
      },
      start: async () => { throw new Error("must not start after failed recovery preparation"); },
    },
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    serverDirectory: destination,
  }), (error) => {
    captured = error;
    return /candidate preparation exploded/.test(error.message)
      && /restored host preparation exploded/.test(error.message);
  });
  assert.equal(captured.cause, original);
  assert.equal(captured.rollback.ok, false);
  assert.ok(captured.rollback.issues.some(item => item.includes("restored host preparation exploded")));
  assert.equal(await fsp.readFile(path.join(destination, "marker"), "utf8"), "current\n");
  assert.equal(await fsp.readFile(path.join(previous, "marker"), "utf8"), "prior-backup\n");
});

test("personal start prepares under its existing lifecycle lock without reentrant deadlock", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-start-unlocked-prepare-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const events = [];
  const result = await serverStart({
    profile: "personal",
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gatewayStub(),
    model: "claude-sonnet-5-5",
    serverDirectory: destination,
    hostRuntime: {
      prepare: async () => { events.push("prepare"); return { ok: true, ready: true }; },
      start: async ({ skipPrepare }) => {
        assert.equal(skipPrepare, true);
        events.push("start");
        return { ok: true, running: true };
      },
    },
    composeRunner: async () => { events.push("compose"); return { stdout: "started\n", stderr: "" }; },
    healthWaiter: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["prepare", "start", "compose"]);
  await assert.rejects(fsp.access(`${destination}.lifecycle.lock`));
  // Start prepares again, and the model it was given reaches that prepare.
  assert.equal(parseEnv(await fsp.readFile(path.join(destination, ".env"), "utf8")).DERIVER_MODEL_CONFIG__MODEL, "claude-sonnet-5-5");
});

test("personal start requires a healthy host before Compose and rolls it back on Compose failure", async () => {
  const events = [];
  const hostRuntime = {
    start: async ({ skipPrepare }) => { assert.equal(skipPrepare, true); events.push("host-start"); return { ok: true, running: true }; },
    stop: async () => { events.push("host-stop"); return { ok: true, stopped: true }; },
  };
  const preparedServer = { ok: true, ready: true, installation: {}, environment: {} };
  const started = await serverStart({
    profile: "personal",
    hostRuntime,
    preparedServer,
    serverDirectory: path.join(os.tmpdir(), "honcho-agent-bridge-start-order"),
    composeRunner: async () => { events.push("compose-start"); return { stdout: "started\n", stderr: "" }; },
    healthWaiter: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(started.ok, true);
  assert.equal(started.host.running, true);
  assert.deepEqual(events, ["host-start", "compose-start"]);

  events.length = 0;
  await assert.rejects(
    serverStart({
      profile: "personal",
      hostRuntime,
      preparedServer,
      serverDirectory: path.join(os.tmpdir(), "honcho-agent-bridge-start-rollback"),
      composeRunner: async () => { events.push("compose-start"); throw new Error("compose failed"); },
    }),
    /compose failed/,
  );
  assert.deepEqual(events, ["host-start", "compose-start", "host-stop"]);
});

test("personal start never invokes Compose when the host runtime is unhealthy", async () => {
  let composeCalled = false;
  const result = await serverStart({
    profile: "personal",
    hostRuntime: {
      start: async () => ({ ok: false, running: false, issues: ["router unavailable"] }),
    },
    preparedServer: { ok: true, ready: true, installation: {}, environment: {} },
    serverDirectory: path.join(os.tmpdir(), "honcho-agent-bridge-start-blocked"),
    composeRunner: async () => { composeCalled = true; return { stdout: "", stderr: "" }; },
  });
  assert.equal(result.ok, false);
  assert.equal(composeCalled, false);
  assert.equal(result.host.issues[0], "router unavailable");
});

test("personal status combines Docker and host health", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-status-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "compose.yaml"), "name: test\n");
  const result = await serverStatus({
    profile: "personal",
    serverDirectory: root,
    hostRuntime: { status: async () => ({ ok: true, running: true, gateway: { ok: true, router: { ok: true } } }) },
    dockerInspector: async () => ({ installed: true, running: true }),
    composeRunner: async () => ({ stdout: `${JSON.stringify({ Service: "api", State: "running" })}\n` }),
    healthWaiter: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.running, true);
  assert.equal(result.host.gateway.router.ok, true);
});

test("personal stop orders Compose before host shutdown and still stops host without a Compose bundle", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-personal-stop-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "compose.yaml"), "name: test\n");
  const events = [];
  const hostRuntime = { stop: async () => { events.push("host-stop"); return { ok: true, stopped: true }; } };
  const result = await serverStop({
    profile: "personal",
    serverDirectory: root,
    hostRuntime,
    composeRunner: async () => { events.push("compose-stop"); return { stdout: "stopped\n", stderr: "" }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["compose-stop", "host-stop"]);

  events.length = 0;
  await fsp.rm(path.join(root, "compose.yaml"));
  const hostOnly = await serverStop({ profile: "personal", serverDirectory: root, hostRuntime });
  assert.equal(hostOnly.ok, true);
  assert.deepEqual(events, ["host-stop"]);
});

test("portable server lifecycle never invokes personal host services", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-portable-lifecycle-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "compose.yaml"), "name: test\n");
  const hostRuntime = new Proxy({}, { get: () => async () => { throw new Error("portable must not call host runtime"); } });
  const started = await serverStart({
    profile: "portable",
    hostRuntime,
    preparedServer: { ok: true, ready: true, installation: {}, environment: {} },
    serverDirectory: root,
    composeRunner: async () => ({ stdout: "started\n", stderr: "" }),
    healthWaiter: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(started.ok, true);
  assert.equal("host" in started, false);

  const status = await serverStatus({
    profile: "portable",
    hostRuntime,
    serverDirectory: root,
    dockerInspector: async () => ({ installed: true, running: true }),
    composeRunner: async () => ({ stdout: `${JSON.stringify({ Service: "api", State: "running" })}\n` }),
    healthWaiter: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(status.ok, true);
  assert.equal("host" in status, false);

  const stopped = await serverStop({
    profile: "portable",
    hostRuntime,
    serverDirectory: root,
    composeRunner: async () => ({ stdout: "stopped\n", stderr: "" }),
  });
  assert.equal(stopped.ok, true);
  assert.equal("host" in stopped, false);
});

function fakeResponse(document, { status = 200, onCancel = () => {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => document,
    body: { cancel: async () => onCancel() },
  };
}

function healthyVerifyStatus() {
  return {
    ok: true,
    installed: true,
    running: true,
    docker: { installed: true, running: true },
    host: {
      running: true,
      gateway: { ok: true, loggedIn: true, router: { url: "http://127.0.0.1:11400/v1", ok: true } },
      ollama: { healthy: true, resident: true, model: "qwen3-embedding-honcho-8192" },
    },
  };
}

test("personal verify proves long 1536d embeddings and both Docker-to-host routes without a live completion", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-verify-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // The probe asks about the endpoints this install actually configured, so the
  // installed environment is what decides which routes have to answer.
  const installedEnvironment = [
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1",
    "DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11400/v1",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(root, ".env"), installedEnvironment);
  const calls = [];
  let composeArgs = null;
  const result = await serverVerify({
    profile: "personal",
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async (_directory, args) => {
      composeArgs = args;
      return {
        stdout: `${JSON.stringify({ ollama: { ok: true, status: 200 }, router: { ok: true, status: 200 } })}\n`,
        stderr: "",
      };
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/api/embed")) {
        const body = JSON.parse(options.body);
        assert.equal(body.model, "qwen3-embedding-honcho-8192");
        assert.equal(body.truncate, false);
        assert.equal(body.dimensions, 1536);
        assert.ok(body.input.split("\n").length > 2048);
        return fakeResponse({
          model: body.model,
          prompt_eval_count: 3001,
          embeddings: [Array(1536).fill(0.25)],
        });
      }
      if (String(url) === "http://127.0.0.1:8001/health") return fakeResponse({ status: "ok" });
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.liveCompletion, false);
  assert.equal(result.checks.embedding.promptLongEnough, true);
  assert.equal(result.checks.embedding.promptEvalCount, 3001);
  assert.equal(result.checks.embedding.vectorLength, 1536);
  assert.equal(result.checks.containerHost.ollama.ok, true);
  assert.equal(result.checks.containerHost.router.ok, true);
  assert.equal(result.checks.status.host.routerHealthy, true);
  assert.deepEqual(composeArgs.slice(0, 5), ["exec", "-T", "api", "python", "-c"]);
  assert.match(composeArgs.at(-1), /host\.docker\.internal:11434\/api\/version/);
  assert.match(composeArgs.at(-1), /host\.docker\.internal:11400\/health/);
  assert.equal(result.checks.completion.skipped, true);
  assert.equal(calls.some((call) => call.url.includes("chat/completions")), false);
  assert.equal(await fsp.readFile(path.join(root, ".env"), "utf8"), installedEnvironment, "verify never writes to the installed environment");
});

test("verify does not demand a router the installed environment never configured", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-verify-norouter-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(
    path.join(root, ".env"),
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1\n",
  );
  let composeArgs = null;
  const result = await serverVerify({
    profile: "personal",
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async (_directory, args) => {
      composeArgs = args;
      return { stdout: `${JSON.stringify({ ollama: { ok: true, status: 200 } })}\n`, stderr: "" };
    },
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith("/api/embed")) {
        const body = JSON.parse(options.body);
        return fakeResponse({ model: body.model, prompt_eval_count: 3001, embeddings: [Array(1536).fill(0.25)] });
      }
      if (String(url) === "http://127.0.0.1:8001/health") return fakeResponse({ status: "ok" });
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(result.ok, true, "a completion endpoint is not a precondition for every install");
  assert.equal(result.checks.containerHost.ollama.ok, true);
  assert.equal(result.checks.containerHost.router.skipped, true);
  assert.equal(composeArgs.at(-1).includes("/health"), false, "the unconfigured endpoint is never probed");
});

test("verify skips the container probe entirely when no host endpoint is configured", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-verify-none-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, ".env"), "POSTGRES_PASSWORD=x\n");
  let composeCalled = false;
  const result = await serverVerify({
    profile: "personal",
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async () => { composeCalled = true; return { stdout: "", stderr: "" }; },
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith("/api/embed")) {
        const body = JSON.parse(options.body);
        return fakeResponse({ model: body.model, prompt_eval_count: 3001, embeddings: [Array(1536).fill(0.25)] });
      }
      if (String(url) === "http://127.0.0.1:8001/health") return fakeResponse({ status: "ok" });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  assert.equal(result.checks.containerHost.skipped, true);
  assert.equal(result.checks.containerHost.ok, true);
  assert.equal(composeCalled, false);
});

test("personal verify fails when Ollama cannot prove more than 2048 tokens or exact dimensions", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-verify-shape-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = await serverVerify({
    profile: "personal",
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async () => ({
      stdout: `${JSON.stringify({ ollama: { ok: true, status: 200 }, router: { ok: true, status: 200 } })}\n`,
      stderr: "",
    }),
    fetchImpl: async (url) => String(url).endsWith("/api/embed")
      ? fakeResponse({ prompt_eval_count: 2048, embeddings: [Array(1535).fill(0)] })
      : fakeResponse({ status: "ok" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.embedding.promptLongEnough, false);
  assert.equal(result.checks.embedding.dimensionsMatch, false);
  assert.equal(result.checks.embedding.vectorLength, 1535);
});

test("live verification calls the router as the deriver would, reads the key only in-process, and discards the body", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-verify-live-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const responseMarker = "must-never-parse-completion-body";
  await fsp.writeFile(path.join(root, ".env"), [
    "DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11400/v1",
    "DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_VLLM_API_KEY",
    "DERIVER_MODEL_CONFIG__MODEL=gpt-6-luna",
    "DERIVER_MODEL_CONFIG__THINKING_EFFORT=low",
    `LLM_VLLM_API_KEY=${ROUTER_KEY}`,
    "",
  ].join("\n"));
  let completionCancelled = false;
  let completionCalls = 0;
  let composeArgs = null;
  const result = await serverVerify({
    profile: "personal",
    liveCompletion: true,
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async (_directory, args) => {
      composeArgs = args;
      return {
        stdout: `${JSON.stringify({ router: { ok: true, status: 200 } })}\n`,
        stderr: "",
      };
    },
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith("/api/embed")) {
        return fakeResponse({ prompt_eval_count: 3000, embeddings: [Array(1536).fill(0)] });
      }
      if (String(url).endsWith("/chat/completions")) {
        completionCalls += 1;
        assert.equal(String(url), "http://127.0.0.1:11400/v1/chat/completions");
        assert.equal(options.headers.Authorization, `Bearer ${ROUTER_KEY}`);
        const body = JSON.parse(options.body);
        assert.equal(body.model, "gpt-6-luna");
        assert.equal(body.max_completion_tokens, 32);
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.stream, false);
        return fakeResponse({ choices: [{ message: { content: responseMarker } }] }, {
          onCancel: () => { completionCancelled = true; },
        });
      }
      return fakeResponse({ status: "ok" });
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(completionCalls, 1);
  assert.equal(completionCancelled, true);
  assert.deepEqual(result.checks.completion, { ok: true, model: "gpt-6-luna" });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ROUTER_KEY), false);
  assert.equal(serialized.includes(responseMarker), false);
  assert.equal(JSON.stringify(composeArgs).includes(ROUTER_KEY), false);
});

test("live verification never sends the key to a router that is not on this machine", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-verify-remote-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, ".env"), [
    "DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=https://example.test/v1",
    "DERIVER_MODEL_CONFIG__MODEL=gpt-6-luna",
    `LLM_VLLM_API_KEY=${ROUTER_KEY}`,
    "",
  ].join("\n"));
  const requested = [];
  const result = await serverVerify({
    profile: "personal",
    liveCompletion: true,
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async () => ({ stdout: "{}\n", stderr: "" }),
    fetchImpl: async (url) => {
      requested.push(String(url));
      return String(url).endsWith("/api/embed")
        ? fakeResponse({ prompt_eval_count: 3000, embeddings: [Array(1536).fill(0)] })
        : fakeResponse({ status: "ok" });
    },
  });
  assert.equal(result.checks.completion.ok, false);
  assert.equal(requested.some((url) => url.includes("example.test") || url.includes("chat/completions")), false);
  assert.equal(JSON.stringify(result).includes(ROUTER_KEY), false);
});

test("personal prepare stops at the gateway login and says where to log in, touching nothing installed", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-login-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, ".env"), "CUSTOM_SETTING=keep-me\n", { mode: 0o600 });
  const gateway = fakeGateway({ ready: false });
  let hostCalled = false;
  const hostRuntime = new Proxy({}, { get: () => async () => { hostCalled = true; return { ok: true, ready: true }; } });

  const result = await serverPrepare({
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gateway.options,
    serverDirectory: destination,
  });
  assert.equal(result.ok, true, "a missing login is the user's next step, not a failure");
  assert.equal(result.ready, false);
  assert.equal(result.nextAction.kind, "gateway-login");
  assert.equal(result.nextAction.url, "http://127.0.0.1:11450");
  assert.match(result.nextAction.message, /log in with Codex and\/or Claude in the gateway screen, then run server prepare --profile personal again/);
  assert.equal(result.next, result.nextAction.message);
  assert.equal(result.gateway.reason, "no account is logged in");
  assert.equal("missingSecretFields" in result, false, "nothing asks the user for a key");
  assert.deepEqual(gateway.calls, ["install", "connect-info"]);
  assert.equal(hostCalled, false);
  assert.equal(await fsp.readFile(path.join(destination, ".env"), "utf8"), "CUSTOM_SETTING=keep-me\n");
  assert.equal((await fsp.readdir(root)).some((item) => item.includes(".candidate-")), false);
});

test("personal prepare writes the gateway's router, key and chosen model into the private .env", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-ready-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const gateway = fakeGateway({ models: ["claude-sonnet-5-5", "gpt-5.5", "gpt-6-luna"] });
  let hostOptions = null;

  const result = await serverPrepare({
    profile: "personal",
    hostRuntime: { prepare: async (options) => { hostOptions = options; return { ok: true, ready: true }; } },
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gateway.options,
    serverDirectory: destination,
  });
  assert.equal(result.ok, true, result.issues?.join(", "));
  assert.equal(result.ready, true);
  assert.equal(result.chatModel, "gpt-6-luna");
  assert.equal(result.chatModelSource, "default");
  assert.equal(result.gateway.routerUrl, "http://127.0.0.1:11400/v1");
  assert.equal(result.gateway.autostart, "launchd");
  assert.equal(result.gateway.routerKeyUpdated, true);
  assert.deepEqual(result.gateway.models, ["claude-sonnet-5-5", "gpt-5.5", "gpt-6-luna"]);
  assert.deepEqual(result.missingSecretFields, []);
  assert.equal(hostOptions.skipGateway, true);
  assert.equal(JSON.stringify(result).includes(ROUTER_KEY), false, "the key is in the private .env and in no result");

  const text = await fsp.readFile(path.join(destination, ".env"), "utf8");
  const environment = parseEnv(text);
  assert.equal(environment.LLM_VLLM_API_KEY, ROUTER_KEY);
  assert.equal(environment.LLM_VLLM_BASE_URL, "http://host.docker.internal:11400/v1");
  for (const prefix of CHAT_PREFIXES) {
    assert.equal(environment[`${prefix}__MODEL`], "gpt-6-luna", prefix);
    assert.equal(environment[`${prefix}__THINKING_EFFORT`], "low", prefix);
    assert.equal(environment[`${prefix}__OVERRIDES__BASE_URL`], "http://host.docker.internal:11400/v1", prefix);
    assert.equal(environment[`${prefix}__OVERRIDES__API_KEY_ENV`], "LLM_VLLM_API_KEY", prefix);
  }
  // Embeddings stay on Ollama.
  assert.equal(environment.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL, "http://host.docker.internal:11434/v1");
  assert.equal(environment.EMBEDDING_MODEL_CONFIG__MODEL, "qwen3-embedding-honcho-8192");
  assert.equal(environment.LLM_OPENAI_COMPATIBLE_API_KEY, "ollama-local");
  assert.equal(text.includes("11435"), false);
  assert.equal((text.match(/^LLM_VLLM_API_KEY=/gm) || []).length, 1);
  if (process.platform !== "win32") {
    assert.equal((await fsp.stat(path.join(destination, ".env"))).mode & 0o777, 0o600);
  }
});

test("re-running prepare updates the key and model and keeps what the user edited", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-rerun-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const hostRuntime = { status: async () => ({ running: false }), prepare: async () => ({ ok: true, ready: true }) };
  const prepare = (gateway, extra = {}) => serverPrepare({
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...gateway.options,
    serverDirectory: destination,
    ...extra,
  });
  const envPath = path.join(destination, ".env");

  assert.equal((await prepare(fakeGateway())).ready, true);
  const first = parseEnv(await fsp.readFile(envPath, "utf8"));
  // What the user changes by hand is theirs.
  await fsp.appendFile(envPath, "CUSTOM_SETTING=keep-me\nLOG_LEVEL=DEBUG\n");

  const rotatedKey = "fedcba9876543210".repeat(4);
  const second = await prepare(fakeGateway({ apiKey: rotatedKey }), { model: "claude-sonnet-5-5" });
  assert.equal(second.ready, true, second.issues?.join(", "));
  assert.equal(second.chatModel, "claude-sonnet-5-5");
  assert.equal(second.chatModelSource, "override");
  assert.equal(second.gateway.routerKeyUpdated, true);
  assert.equal(second.environment.updated, true);
  assert.equal(JSON.stringify(second).includes(rotatedKey), false);
  const secondText = await fsp.readFile(envPath, "utf8");
  const updated = parseEnv(secondText);
  assert.equal(updated.LLM_VLLM_API_KEY, rotatedKey);
  assert.equal((secondText.match(/^LLM_VLLM_API_KEY=/gm) || []).length, 1);
  for (const prefix of CHAT_PREFIXES) assert.equal(updated[`${prefix}__MODEL`], "claude-sonnet-5-5", prefix);
  assert.equal(updated.CUSTOM_SETTING, "keep-me");
  assert.equal(updated.LOG_LEVEL, "DEBUG");
  assert.equal(updated.POSTGRES_PASSWORD, first.POSTGRES_PASSWORD, "the database password is never regenerated");

  // Nothing changed at the gateway: nothing changes in the file, and the model
  // chosen last time stays without being asked for again.
  const third = await prepare(fakeGateway({ apiKey: rotatedKey }));
  assert.equal(third.ready, true);
  assert.equal(third.chatModel, "claude-sonnet-5-5");
  assert.equal(third.chatModelSource, "kept");
  assert.equal(third.environment.updated, false);
  assert.equal(third.gateway.routerKeyUpdated, false);
  assert.equal(await fsp.readFile(envPath, "utf8"), secondText);
});

test("prepare keeps the installed chat model while the gateway offers it, and goes back to the default when it does not", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-kept-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const envPath = path.join(destination, ".env");
  await fsp.mkdir(destination, { recursive: true });
  const prepare = () => serverPrepare({
    profile: "personal",
    hostRuntime: { status: async () => ({ running: false }), prepare: async () => ({ ok: true, ready: true }) },
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    ...fakeGateway({ models: ["gpt-6-luna", "claude-sonnet-5-5"] }).options,
    serverDirectory: destination,
  });

  // Chosen on an earlier run; gpt-6-luna would win the preference order.
  await fsp.writeFile(envPath, "DERIVER_MODEL_CONFIG__MODEL=claude-sonnet-5-5\n", { mode: 0o600 });
  const kept = await prepare();
  assert.equal(kept.ready, true, kept.issues?.join(", "));
  assert.deepEqual([kept.chatModel, kept.chatModelSource], ["claude-sonnet-5-5", "kept"]);
  const environment = parseEnv(await fsp.readFile(envPath, "utf8"));
  for (const prefix of CHAT_PREFIXES) assert.equal(environment[`${prefix}__MODEL`], "claude-sonnet-5-5", prefix);

  // A model the gateway stopped offering is not kept.
  await fsp.writeFile(envPath, "DERIVER_MODEL_CONFIG__MODEL=claude-opus-5-5\n", { mode: 0o600 });
  const replaced = await prepare();
  assert.equal(replaced.ready, true, replaced.issues?.join(", "));
  assert.deepEqual([replaced.chatModel, replaced.chatModelSource], ["gpt-6-luna", "default"]);
});

test("server start keeps an earlier --model without being given it again", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-start-kept-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const hostRuntime = {
    status: async () => ({ running: false }),
    prepare: async () => ({ ok: true, ready: true }),
    start: async () => ({ ok: true, running: true }),
  };
  const common = {
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    serverDirectory: destination,
  };
  const prepared = await serverPrepare({ ...common, ...gatewayStub(), model: "claude-sonnet-5-5" });
  assert.equal(prepared.chatModelSource, "override");

  const started = await serverStart({
    ...common,
    ...gatewayStub(),
    composeRunner: async () => ({ stdout: "started\n", stderr: "" }),
    healthWaiter: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(started.ok, true);
  const environment = parseEnv(await fsp.readFile(path.join(destination, ".env"), "utf8"));
  for (const prefix of CHAT_PREFIXES) assert.equal(environment[`${prefix}__MODEL`], "claude-sonnet-5-5", prefix);
});

test("a requested model the gateway does not offer, or a failed gateway install, stops prepare before the bundle", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-refused-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  let hostCalled = false;
  const hostRuntime = new Proxy({}, { get: () => async () => { hostCalled = true; return { ok: true, ready: true }; } });
  const base = {
    profile: "personal",
    hostRuntime,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    serverDirectory: destination,
  };

  const unknown = await serverPrepare({ ...base, ...fakeGateway().options, model: "gpt-7" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ready, false);
  assert.match(unknown.issues[0], /does not offer the model "gpt-7"\. It offers: claude-sonnet-5-5, gpt-6-luna/);

  const broken = fakeGateway({ install: { ok: false, error: "npm install failed" } });
  const failed = await serverPrepare({ ...base, ...broken.options });
  assert.equal(failed.ok, false);
  assert.match(failed.issues[0], /gateway install failed: npm install failed/);
  assert.deepEqual(broken.calls, ["install"], "connect-info is not asked of a gateway that did not install");

  assert.equal(hostCalled, false);
  await assert.rejects(fsp.access(destination), "no bundle was installed");
});

test("personal plan shows the gateway steps and asks for no key", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-plan-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  await fsp.mkdir(path.join(source, "host"), { recursive: true });
  await fsp.writeFile(path.join(source, "host", "supervisor.mjs"), "// supervisor\n");
  await fsp.writeFile(path.join(source, "host", "qwen3-embedding-8192.Modelfile"), "FROM qwen3-embedding:8b\n");
  const inspectors = {
    profile: "personal",
    platform: "darwin",
    dockerInspector: async () => ({ installed: true, running: true }),
    bundleInspector: async () => ({ ok: true, directory: source, missing: [] }),
    honchoSourceInspector: async () => ({ present: true, fetchable: false }),
  };

  const plan = await serverPlan({
    ...inspectors,
    gatewaySourceInspector: async () => ({
      state: "missing",
      present: false,
      fetchable: true,
      pin: { repo: "https://github.com/team-memory-system/subscription-gateway", ref: "main" },
    }),
  });
  assert.equal(plan.ready, true, plan.issues.join(", "));
  assert.deepEqual(plan.operations.map((item) => item.type), [
    "fetch-gateway-source",
    "gateway-install",
    "gateway-connect",
    "write-environment",
    "install-bundle",
    "prepare-ollama",
  ]);
  assert.equal(plan.gateway.uiUrl, "http://127.0.0.1:11450");
  assert.equal(plan.gateway.routerUrl, "http://127.0.0.1:11400/v1");
  assert.match(plan.warnings.join(" "), /Subscription gateway source will be downloaded from https:\/\/github\.com\/team-memory-system\/subscription-gateway \(main\)/);
  assert.equal(/proxy|11435|LLM_VLLM_API_KEY/i.test(JSON.stringify(plan)), false, "no proxy and no key to supply");

  const blocked = await serverPlan({
    ...inspectors,
    gatewaySourceInspector: async () => ({
      state: "missing",
      present: false,
      fetchable: false,
      reason: "git is not installed, so the subscription gateway source cannot be fetched",
    }),
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.issues.join(" "), /subscription gateway cannot be installed: git is not installed/);
});

test("the source pin only accepts an https repository and a plausible ref", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-pin-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const write = (value) => fsp.writeFile(path.join(root, "honcho-source.json"), value, "utf8");

  assert.equal((await honchoSourcePin(root)).ok, false, "a missing pin is not an error, just absent");

  await write("{ not json");
  assert.match((await honchoSourcePin(root)).reason, /not valid JSON/);

  // Both values are handed to git on a command line.
  for (const rejected of [
    { repo: "git@github.com:team/repo.git", ref: "main" },
    { repo: "http://github.com/team/repo", ref: "main" },
    { repo: "https://github.com/team/repo", ref: "main; rm -rf /" },
    { repo: "https://github.com/team/repo", ref: "--upload-pack=touch" },
    { repo: "https://github.com/team/repo", ref: "--depth" },
    { repo: "https://github.com/team/repo", ref: "main", commit: "abc123" },
  ]) {
    await write(JSON.stringify(rejected));
    assert.equal((await honchoSourcePin(root)).ok, false, `accepted ${JSON.stringify(rejected)}`);
  }

  await write(JSON.stringify({ repo: "https://github.com/team-memory-system/honcho-selfhost", ref: "main" }));
  const pin = await honchoSourcePin(root);
  assert.equal(pin.ok, true);
  assert.equal(pin.repo, "https://github.com/team-memory-system/honcho-selfhost");
  assert.equal(pin.ref, "main");
});

test("a plugin without the Honcho source plans a download instead of failing", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-fetch-plan-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "compose.yaml"), "services: {}\n");
  await fsp.writeFile(path.join(root, ".env.example"), "LOG_LEVEL=INFO\n");
  await fsp.writeFile(path.join(root, "honcho-source.json"), JSON.stringify({
    repo: "https://github.com/team-memory-system/honcho-selfhost",
    ref: "main",
  }));
  const bundle = {
    ok: false,
    directory: root,
    missing: ["honcho/Dockerfile", "honcho/LICENSE", "honcho/local-dashboard/Dockerfile"],
  };
  const docker = { installed: true, running: true };
  const gitPresent = async () => ({ stdout: "git version 2.0\n", stderr: "" });

  const withGit = await serverPlan({
    dockerInspector: async () => docker,
    bundleInspector: async () => bundle,
    honchoSourceInspector: () => honchoSourceProbe(root, { runner: gitPresent }),
  });
  assert.equal(withGit.ready, true, withGit.issues?.join(", "));
  assert.match(withGit.warnings.join(" "), /will be downloaded from https:\/\/github\.com\/team-memory-system\/honcho-selfhost \(main\)/);
  assert.equal(withGit.honchoSource.fetchable, true);
  // Planning must not create anything.
  assert.deepEqual(
    (await fsp.readdir(root)).sort(),
    [".env.example", "compose.yaml", "honcho-source.json"],
  );

  const withoutGit = await serverPlan({
    dockerInspector: async () => docker,
    bundleInspector: async () => bundle,
    honchoSourceInspector: () => honchoSourceProbe(root, { runner: async () => { throw new Error("git not found"); } }),
  });
  assert.equal(withoutGit.ready, false);
  assert.match(withoutGit.issues.join(" "), /git is not installed/);

  // No pin at all is still a hard failure: there is nowhere to fetch from.
  await fsp.rm(path.join(root, "honcho-source.json"));
  const unpinned = await serverPlan({
    dockerInspector: async () => docker,
    bundleInspector: async () => bundle,
    honchoSourceInspector: () => honchoSourceProbe(root, { runner: gitPresent }),
  });
  assert.equal(unpinned.ready, false);
  assert.match(unpinned.issues.join(" "), /no source pin is bundled/);
});

test("the fetch stages the clone, drops its history, and leaves nothing behind on failure", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-fetch-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "honcho-source.json"), JSON.stringify({
    repo: "https://github.com/team-memory-system/honcho-selfhost",
    ref: "main",
  }));

  const calls = [];
  const fakeClone = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "--version") return { stdout: "git version 2.0\n", stderr: "" };
    if (args[0] === "clone") {
      const target = args[args.length - 1];
      await fsp.mkdir(path.join(target, ".git"), { recursive: true });
      await fsp.mkdir(path.join(target, "local-dashboard"), { recursive: true });
      await fsp.writeFile(path.join(target, "Dockerfile"), "FROM scratch\n");
      await fsp.writeFile(path.join(target, "LICENSE"), "AGPL\n");
      await fsp.writeFile(path.join(target, "local-dashboard", "Dockerfile"), "FROM scratch\n");
      return { stdout: "", stderr: "" };
    }
    return { stdout: "11fc292b1bf8e2c7f4e0a5ee2721b2fbe4f29772\n", stderr: "" };
  };

  const fetched = await ensureHonchoSource(root, { runner: fakeClone });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.fetched, true);
  assert.equal(fetched.commit, "11fc292b1bf8e2c7f4e0a5ee2721b2fbe4f29772");
  // The clone goes to a staging path so an interrupted fetch cannot look complete.
  const clone = calls.find(call => call[1] === "clone");
  assert.equal(clone[clone.length - 1], path.join(root, "honcho.fetching"));
  assert.ok(clone.includes("--single-branch") && clone.includes("--depth"));
  assert.equal(await bundleFileExists(root, "honcho/Dockerfile"), true);
  assert.equal(await bundleFileExists(root, "honcho/.git"), false, "the clone's history is not kept");
  assert.equal(await bundleFileExists(root, "honcho.fetching"), false);

  // A second call is a no-op and does not run git again.
  calls.length = 0;
  const again = await ensureHonchoSource(root, { runner: fakeClone });
  assert.deepEqual(again, { ok: true, fetched: false, directory: path.join(root, "honcho") });
  assert.deepEqual(calls, []);

  const broken = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-fetch-fail-"));
  t.after(() => fsp.rm(broken, { recursive: true, force: true }));
  await fsp.writeFile(path.join(broken, "honcho-source.json"), JSON.stringify({
    repo: "https://github.com/team-memory-system/honcho-selfhost",
    ref: "main",
  }));
  const failing = await ensureHonchoSource(broken, {
    runner: async (command, args) => {
      if (args[0] === "--version") return { stdout: "git version 2.0\n", stderr: "" };
      const error = new Error("clone failed");
      error.stderr = "fatal: repository not found";
      throw error;
    },
  });
  assert.equal(failing.ok, false);
  assert.match(failing.error, /repository not found/);
  assert.deepEqual(await fsp.readdir(broken), ["honcho-source.json"]);
});

async function bundleFileExists(directory, relative) {
  try { await fsp.access(path.join(directory, relative)); return true; } catch { return false; }
}
