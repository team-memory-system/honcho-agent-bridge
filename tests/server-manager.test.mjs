import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyServerBundle,
  dockerCliEnvironment,
  serverPrepare,
  serverStart,
  serverStatus,
  serverStop,
  serverVerify,
} from "../scripts/server-manager.mjs";

test("Windows Compose uses an isolated anonymous Docker config without changing the user config", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-docker-config-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "server");
  const environment = await dockerCliEnvironment(serverDirectory, {
    platform: "win32",
    env: { USERPROFILE: path.join(root, "user") },
  });
  assert.equal(environment.COMPOSE_PROJECT_NAME, "agent-memory");
  assert.equal(environment.DOCKER_CONFIG, path.join(root, "runtime", "docker-cli"));
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(environment.DOCKER_CONFIG, "config.json"), "utf8")),
    { auths: { "https://index.docker.io/v1/": {} } },
  );
  assert.equal(environment.DOCKER_CONFIG.includes(environment.USERPROFILE), false);
});

test("server bundle updates preserve the installed private environment", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-server-copy-"));
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
  if (process.platform !== "win32") {
    assert.equal((await fsp.stat(path.join(destination, ".env"))).mode & 0o777, 0o600);
  }
});

async function personalBundle(root) {
  const source = path.join(root, "source");
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, "compose.yaml"), "name: test\n");
  await fsp.writeFile(path.join(source, "env.personal.example"), `
POSTGRES_PASSWORD=
LLM_VLLM_API_KEY=
DERIVER_MODEL_CONFIG__TRANSPORT=openai
DERIVER_MODEL_CONFIG__MODEL=gpt-5.6-sol
DERIVER_MODEL_CONFIG__THINKING_EFFORT=high
DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11435/v1
DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_VLLM_API_KEY
EMBEDDING_MAX_INPUT_TOKENS=8192
EMBEDDING_MODEL_CONFIG__TRANSPORT=openai
EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192
EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_OPENAI_COMPATIBLE_API_KEY
DIALECTIC_LEVELS__high__MODEL_CONFIG__THINKING_EFFORT=high
`);
  return source;
}

test("personal server prepare adds missing safe profile settings without replacing secrets or custom values", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-personal-profile-merge-"));
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
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.environment.created, false);
  assert.equal(result.environment.updated, true);
  assert.match(installedEnvironment, /^POSTGRES_PASSWORD=private-existing-password$/m);
  assert.match(installedEnvironment, /^LLM_VLLM_API_KEY=private-existing-key$/m);
  assert.match(installedEnvironment, /^CUSTOM_SETTING=keep-me$/m);
  assert.match(installedEnvironment, /^DERIVER_MODEL_CONFIG__MODEL=gpt-5\.6-sol$/m);
  assert.match(installedEnvironment, /^DERIVER_MODEL_CONFIG__THINKING_EFFORT=high$/m);
  assert.match(installedEnvironment, /^EMBEDDING_MAX_INPUT_TOKENS=8192$/m);
  assert.match(installedEnvironment, /^DIALECTIC_LEVELS__high__MODEL_CONFIG__THINKING_EFFORT=high$/m);
  assert.equal((installedEnvironment.match(/^LLM_VLLM_API_KEY=/gm) || []).length, 1);
  assert.equal(installedEnvironment.includes("private-direct-key"), false);
  assert.equal(installedEnvironment.includes("external-model"), false);
  assert.equal(installedEnvironment.includes("private-header"), false);
});

test("personal server prepare generates only missing local secrets for an existing environment", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-personal-existing-secrets-"));
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
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(environment.CUSTOM_SETTING, "keep-me");
  assert.ok(environment.POSTGRES_PASSWORD.length >= 24);
  assert.ok(environment.LLM_VLLM_API_KEY.length >= 32);
  assert.equal(environment.LLM_OPENAI_COMPATIBLE_API_KEY, "ollama-local");
});

test("personal server prepare installs its environment before preparing host services", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-personal-prepare-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = await personalBundle(root);
  const destination = path.join(root, "installed");
  const events = [];
  const hostRuntime = {
    prepare: async ({ profile, installedServerDir }) => {
      events.push("host-prepare");
      assert.equal(profile, "personal");
      assert.equal(installedServerDir, destination);
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
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.host.prepared, true);
  assert.deepEqual(events, ["host-prepare"]);
});

test("personal server prepare fails closed before host setup when Windows .env ACLs cannot be restricted", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-personal-acl-"));
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
      serverDirectory: destination,
    }),
    /ACL restriction failed/,
  );

  assert.equal(hostPrepareCalled, false);
  assert.ok(aclCalls.some((item) => item.command.endsWith("\\icacls.exe") && item.args.includes("/grant:r")));
  await assert.rejects(fsp.access(path.join(destination, ".env")));
});

test("personal server update stops a running host before swapping the installed bundle", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-personal-update-"));
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
    serverDirectory: destination,
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostStoppedForUpdate, true);
  assert.deepEqual(events, ["host-status", "host-stop", "host-prepare"]);
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
    serverDirectory: path.join(os.tmpdir(), "agent-memory-start-order"),
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
      serverDirectory: path.join(os.tmpdir(), "agent-memory-start-rollback"),
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
      start: async () => ({ ok: false, running: false, issues: ["proxy unavailable"] }),
    },
    preparedServer: { ok: true, ready: true, installation: {}, environment: {} },
    serverDirectory: path.join(os.tmpdir(), "agent-memory-start-blocked"),
    composeRunner: async () => { composeCalled = true; return { stdout: "", stderr: "" }; },
  });
  assert.equal(result.ok, false);
  assert.equal(composeCalled, false);
  assert.equal(result.host.issues[0], "proxy unavailable");
});

test("personal status combines Docker and host health", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-personal-status-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "compose.yaml"), "name: test\n");
  const result = await serverStatus({
    profile: "personal",
    serverDirectory: root,
    hostRuntime: { status: async () => ({ ok: true, running: true, proxy: { healthy: true } }) },
    dockerInspector: async () => ({ installed: true, running: true }),
    composeRunner: async () => ({ stdout: `${JSON.stringify({ Service: "api", State: "running" })}\n` }),
    healthWaiter: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.running, true);
  assert.equal(result.host.proxy.healthy, true);
});

test("personal stop orders Compose before host shutdown and still stops host without a Compose bundle", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-personal-stop-"));
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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-portable-lifecycle-"));
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
      proxy: { healthy: true, port: 11435, model: "gpt-5.6-sol" },
      ollama: { healthy: true, resident: true, model: "qwen3-embedding-honcho-8192" },
    },
  };
}

test("personal verify proves long 1536d embeddings and both Docker-to-host routes without a live completion", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-verify-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const calls = [];
  let composeArgs = null;
  const result = await serverVerify({
    profile: "personal",
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async (_directory, args) => {
      composeArgs = args;
      return {
        stdout: `${JSON.stringify({ ollama: { ok: true, status: 200 }, proxy: { ok: true, status: 200 } })}\n`,
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
  assert.equal(result.checks.containerHost.proxy.ok, true);
  assert.deepEqual(composeArgs.slice(0, 5), ["exec", "-T", "api", "python", "-c"]);
  assert.match(composeArgs.at(-1), /host\.docker\.internal:11434\/api\/version/);
  assert.match(composeArgs.at(-1), /host\.docker\.internal:11435\/health/);
  assert.equal(result.checks.completion.skipped, true);
  assert.equal(calls.some((call) => call.url.includes("chat/completions")), false);
  await assert.rejects(fsp.access(path.join(root, ".env")));
});

test("personal verify fails when Ollama cannot prove more than 2048 tokens or exact dimensions", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-verify-shape-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = await serverVerify({
    profile: "personal",
    serverDirectory: root,
    statusInspector: async () => healthyVerifyStatus(),
    composeRunner: async () => ({
      stdout: `${JSON.stringify({ ollama: { ok: true, status: 200 }, proxy: { ok: true, status: 200 } })}\n`,
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

test("live verification reads the proxy secret only in-process and discards the completion body", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-verify-live-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const secret = "must-never-appear-in-output-or-argv";
  const responseMarker = "must-never-parse-completion-body";
  await fsp.writeFile(path.join(root, ".env"), `DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_VLLM_API_KEY\nLLM_VLLM_API_KEY=${secret}\n`);
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
        stdout: `${JSON.stringify({ ollama: { ok: true, status: 200 }, proxy: { ok: true, status: 200 } })}\n`,
        stderr: "",
      };
    },
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith("/api/embed")) {
        return fakeResponse({ prompt_eval_count: 3000, embeddings: [Array(1536).fill(0)] });
      }
      if (String(url).endsWith("/v1/chat/completions")) {
        completionCalls += 1;
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        const body = JSON.parse(options.body);
        assert.equal(body.model, "gpt-5.6-sol");
        assert.equal(body.max_completion_tokens, 32);
        assert.equal(body.reasoning_effort, "high");
        assert.equal(body.stream, false);
        return fakeResponse({ choices: [{ message: { content: responseMarker } }] }, {
          onCancel: () => { completionCancelled = true; },
        });
      }
      return fakeResponse({ status: "ok" });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(completionCalls, 1);
  assert.equal(completionCancelled, true);
  assert.deepEqual(result.checks.completion, {
    ok: true,
    model: "gpt-5.6-sol",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(responseMarker), false);
  assert.equal(JSON.stringify(composeArgs).includes(secret), false);
});
