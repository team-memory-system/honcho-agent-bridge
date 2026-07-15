import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");

async function runCli(args, env) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

test("server verify CLI advertises opt-in completion and routes the profile", async () => {
  const help = await runCli(["help"], {});
  assert.ok(help.usage.includes("server verify [--profile personal] [--live-completion]"));
  await assert.rejects(
    runCli(["server", "verify", "--profile", "portable"], {}),
    (error) => {
      const output = JSON.parse(String(error.stdout || "{}"));
      assert.equal(output.ok, false);
      assert.equal(output.profile, "portable");
      assert.match(output.issues[0], /requires --profile personal/);
      return true;
    },
  );
});

test("setup apply installs an isolated runtime and preserves unrelated host hooks", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-cli-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  const codexHooks = path.join(home, ".codex", "hooks.json");
  const claudeSettings = path.join(home, ".claude", "settings.json");
  await fsp.mkdir(path.dirname(codexHooks), { recursive: true });
  await fsp.mkdir(path.dirname(claudeSettings), { recursive: true });
  const hostRuntimeMarker = path.join(appHome, "runtime", "host", "supervisor.pid.json");
  await fsp.mkdir(path.dirname(hostRuntimeMarker), { recursive: true });
  await fsp.writeFile(hostRuntimeMarker, "host-must-survive-collector-updates\n");
  await fsp.writeFile(codexHooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-codex-hook" }] }] } }));
  await fsp.writeFile(
    claudeSettings,
    JSON.stringify({
      theme: "dark",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "keep-claude-hook" }] },
          {
            matcher: "mixed-entry",
            hooks: [
              { type: "command", command: "old-codex-honcho-sync" },
              { type: "command", command: "keep-mixed-hook" },
            ],
          },
        ],
      },
    }),
  );
  const env = { AGENT_MEMORY_HOME: appHome, AGENT_MEMORY_USER_HOME: home, HOME: home };
  const args = [
    "setup",
    "apply",
    "--agents",
    "codex,claude",
    "--user-peer",
    "user_test",
    "--workspace",
    "memory",
    "--honcho-url",
    "http://127.0.0.1:9",
  ];

  const first = await runCli(args, env);
  assert.equal(first.ok, true);
  assert.equal(first.hooks.find((entry) => entry.provider === "claude").mode, "bundled-plugin");

  const config = JSON.parse(await fsp.readFile(path.join(appHome, "config.json"), "utf8"));
  assert.equal(config.user.peerId, "user_test");
  assert.deepEqual(config.agents, { codex: true, claude: true });
  if (process.platform !== "win32") {
    assert.equal((await fsp.stat(path.join(appHome, "config.json"))).mode & 0o777, 0o600);
  }
  await fsp.access(path.join(appHome, "runtime", "collector", "mcp-server.mjs"));
  assert.equal(await fsp.readFile(hostRuntimeMarker, "utf8"), "host-must-survive-collector-updates\n");

  const codex = JSON.parse(await fsp.readFile(codexHooks, "utf8"));
  assert.equal(codex.hooks.Stop.length, 2);
  assert.equal(JSON.stringify(codex).includes("keep-codex-hook"), true);
  assert.equal(JSON.stringify(codex).includes("agent-memory"), true);

  const claude = JSON.parse(await fsp.readFile(claudeSettings, "utf8"));
  assert.equal(claude.theme, "dark");
  assert.equal(claude.hooks.Stop.length, 2);
  assert.equal(JSON.stringify(claude).includes("keep-claude-hook"), true);
  assert.equal(JSON.stringify(claude).includes("keep-mixed-hook"), true);
  assert.equal(claude.hooks.Stop.find((entry) => entry.matcher === "mixed-entry").hooks.length, 1);
  assert.equal(JSON.stringify(claude).includes("codex-honcho-sync"), false);

  const runtimeMarker = path.join(root, "stable-runtime-used");
  await fsp.writeFile(
    path.join(appHome, "runtime", "collector", "main.mjs"),
    `import fsp from "node:fs/promises"; await fsp.writeFile(${JSON.stringify(runtimeMarker)}, "yes");\n`,
  );
  await execFileAsync(process.execPath, [CLI, "hook", "claude"], { env: { ...process.env, ...env } });
  assert.equal(await fsp.readFile(runtimeMarker, "utf8"), "yes", "the bundled Claude hook must dispatch into the stable runtime");

  config.honcho.apiToken = "private-test-token";
  await fsp.writeFile(path.join(appHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const replanned = await runCli(["setup", "plan"], env);
  assert.equal(replanned.config.honcho.apiToken, "[redacted]");
  const second = await runCli(args, env);
  assert.equal(second.ok, true);
  const preservedConfig = JSON.parse(await fsp.readFile(path.join(appHome, "config.json"), "utf8"));
  assert.equal(preservedConfig.honcho.apiToken, "private-test-token");
  const codexAgain = JSON.parse(await fsp.readFile(codexHooks, "utf8"));
  assert.equal(codexAgain.hooks.Stop.length, 2, "reapplying must not duplicate the managed hook");
  await fsp.access(path.join(appHome, "runtime", "collector.previous", "main.mjs"));
  assert.equal(await fsp.readFile(hostRuntimeMarker, "utf8"), "host-must-survive-collector-updates\n");
});

test("setup apply refuses malformed host settings before installing anything", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-invalid-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  const codexHooks = path.join(home, ".codex", "hooks.json");
  await fsp.mkdir(path.dirname(codexHooks), { recursive: true });
  await fsp.writeFile(codexHooks, "{ this is not json\n");
  const env = { AGENT_MEMORY_HOME: appHome, AGENT_MEMORY_USER_HOME: home, HOME: home };

  await assert.rejects(
    runCli(
      ["setup", "apply", "--agents", "codex", "--user-peer", "user_test", "--honcho-url", "http://127.0.0.1:9"],
      env,
    ),
    (error) => String(error.stdout || "").includes("Refusing to modify invalid JSON settings"),
  );
  assert.equal(await fsp.readFile(codexHooks, "utf8"), "{ this is not json\n");
  await assert.rejects(fsp.access(path.join(appHome, "runtime", "collector")));
  await assert.rejects(fsp.access(path.join(appHome, "config.json")));
});

test("setup apply restores runtime and host files byte-for-byte when the final config write fails", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-rollback-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  const codexHooks = path.join(home, ".codex", "hooks.json");
  const claudeSettings = path.join(home, ".claude", "settings.json");
  const codexOriginal = '{  "theme": "keep", "hooks": {} }\n';
  const claudeOriginal = '{\n    "theme": "keep-claude"\n}\n';
  await fsp.mkdir(path.dirname(codexHooks), { recursive: true });
  await fsp.mkdir(path.dirname(claudeSettings), { recursive: true });
  await fsp.mkdir(appHome, { recursive: true });
  await fsp.writeFile(codexHooks, codexOriginal);
  await fsp.writeFile(claudeSettings, claudeOriginal);
  const env = { ...process.env, AGENT_MEMORY_HOME: appHome, AGENT_MEMORY_USER_HOME: home, HOME: home };
  const child = spawn(
    process.execPath,
    [
      CLI,
      "setup",
      "apply",
      "--agents",
      "codex,claude",
      "--user-peer",
      "user_test",
      "--honcho-url",
      "http://127.0.0.1:9",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  await fsp.mkdir(path.join(appHome, `config.json.tmp-${child.pid}`));
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stdout, /changes were rolled back/);
  assert.equal(await fsp.readFile(codexHooks, "utf8"), codexOriginal);
  assert.equal(await fsp.readFile(claudeSettings, "utf8"), claudeOriginal);
  await assert.rejects(fsp.access(path.join(appHome, "runtime", "collector")));
  await assert.rejects(fsp.access(path.join(appHome, "config.json")));
  await assert.rejects(fsp.access(path.join(appHome, "setup.lock")));
});

test("setup apply refuses a concurrent live setup owner", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-setup-lock-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  await fsp.mkdir(appHome, { recursive: true });
  await fsp.writeFile(path.join(appHome, "setup.lock"), JSON.stringify({ pid: process.pid, nonce: "live-owner" }));
  const env = { AGENT_MEMORY_HOME: appHome, AGENT_MEMORY_USER_HOME: home, HOME: home };
  await assert.rejects(
    runCli(
      ["setup", "apply", "--agents", "codex", "--user-peer", "user_test", "--honcho-url", "http://127.0.0.1:9"],
      env,
    ),
    (error) => String(error.stdout || "").includes("setup is already running"),
  );
  await assert.rejects(fsp.access(path.join(appHome, "runtime")));
  await assert.rejects(fsp.access(path.join(appHome, "config.json")));
});

test("setup plan rejects an invalid Honcho URL without mutation", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-plan-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const env = { AGENT_MEMORY_HOME: path.join(root, "app"), AGENT_MEMORY_USER_HOME: path.join(root, "user"), HOME: path.join(root, "user") };
  await assert.rejects(
    runCli(["setup", "plan", "--agents", "codex", "--user-peer", "user_test", "--honcho-url", "not-a-url"], env),
    (error) => String(error.stdout || "").includes("Honcho URL is invalid"),
  );
  await assert.rejects(fsp.access(path.join(root, "app", "config.json")));
});

test("setup rejects and redacts secrets embedded in the Honcho URL", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-secret-url-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const env = { AGENT_MEMORY_HOME: path.join(root, "app"), AGENT_MEMORY_USER_HOME: path.join(root, "user"), HOME: path.join(root, "user") };
  await assert.rejects(
    runCli(
      [
        "setup",
        "plan",
        "--agents",
        "codex",
        "--user-peer",
        "user_test",
        "--honcho-url",
        "https://user:password@example.test/api?foo=secret#fragment",
      ],
      env,
    ),
    (error) => {
      const output = String(error.stdout || "");
      assert.match(output, /must not contain credentials/);
      assert.equal(output.includes("password"), false);
      assert.equal(output.includes("foo=secret"), false);
      return true;
    },
  );
});

test("doctor verifies runtime version, host plugins, Honcho access, and MCP handshake", async (t) => {
  const api = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ status: "ok" }));
    else response.end(JSON.stringify({ items: [], total: 0 }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-doctor-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  const env = {
    AGENT_MEMORY_HOME: appHome,
    AGENT_MEMORY_USER_HOME: home,
    HOME: home,
    CODEX_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_ROOT: ROOT,
  };
  await runCli(
    [
      "setup",
      "apply",
      "--agents",
      "codex,claude",
      "--user-peer",
      "user_test",
      "--honcho-url",
      `http://127.0.0.1:${api.address().port}`,
    ],
    env,
  );
  const result = await runCli(["doctor"], env);
  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "runtime").actualVersion, "0.2.0");
  assert.equal(result.checks.find((check) => check.name === "mcp").enabledToolCount, 31);
  assert.equal(result.checks.find((check) => check.name === "codex-plugin").enabled, true);
  assert.equal(result.checks.find((check) => check.name === "claude-plugin").enabled, true);
});
