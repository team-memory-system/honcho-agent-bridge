import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
const MAIN = path.join(ROOT, "scripts", "main.mjs");

async function runCli(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(String(error.stdout || "{}"));
  }
}

/** A Honcho that answers only with the token, the way one behind its own auth does. */
async function tokenApi(t, token) {
  const api = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ detail: "unauthorized" }));
    } else if (request.url === "/health") response.end(JSON.stringify({ status: "ok" }));
    else response.end(JSON.stringify({ items: [], total: 0 }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  return `http://127.0.0.1:${api.address().port}`;
}

async function sandbox(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-setup-fixes-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  return {
    root,
    appHome,
    env: {
      HONCHO_AGENT_BRIDGE_HOME: appHome,
      HONCHO_AGENT_BRIDGE_USER_HOME: home,
      HOME: home,
      CODEX_PLUGIN_ROOT: ROOT,
      CLAUDE_PLUGIN_ROOT: ROOT,
      HONCHO_API_TOKEN: "",
    },
  };
}

test("setup takes the API token from HONCHO_API_TOKEN and doctor's health check sends it", async (t) => {
  const url = await tokenApi(t, "test-api-token");
  const { appHome, env } = await sandbox(t);
  const setup = ["setup", "apply", "--agents", "claude", "--user-peer", "user_test", "--honcho-url", url];

  const withoutToken = await runCli(["setup", "plan", ...setup.slice(2)], env);
  assert.ok(withoutToken.warnings.some((line) => /requires an API token; set HONCHO_API_TOKEN/.test(line)));

  const refused = await runCli([...setup, "--api-token", "on-the-command-line"], env);
  assert.equal(refused.ready, false);
  assert.ok(refused.issues.some((line) => /through HONCHO_API_TOKEN, not the command line/.test(line)));

  const applied = await runCli(setup, { ...env, HONCHO_API_TOKEN: "test-api-token" });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.nextSteps.map((step) => step.action), ["reload-plugins"]);
  const config = JSON.parse(await fsp.readFile(path.join(appHome, "config.json"), "utf8"));
  assert.equal(config.honcho.apiToken, "test-api-token");

  const doctor = await runCli(["doctor"], env);
  assert.equal(doctor.checks.find((check) => check.name === "honcho-health").ok, true);
  assert.equal(doctor.checks.find((check) => check.name === "honcho-workspaces").ok, true);
});

test("the Codex hook names the PATH node that resolves to this node, not its versioned folder", async (t) => {
  const { root, env } = await sandbox(t);
  const bin = path.join(root, "bin");
  await fsp.mkdir(bin, { recursive: true });
  await fsp.symlink(process.execPath, path.join(bin, process.platform === "win32" ? "node.exe" : "node"));
  const applied = await runCli(
    ["setup", "apply", "--agents", "codex", "--user-peer", "user_test", "--honcho-url", "http://127.0.0.1:9"],
    { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  );
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.nextSteps.map((step) => step.action), ["approve-hook"]);
  const hooks = JSON.parse(await fsp.readFile(path.join(env.HOME, ".codex", "hooks.json"), "utf8"));
  const command = hooks.hooks.Stop[0].hooks[0].command;
  assert.ok(command.startsWith(`"${path.join(bin, "node")}"`), command);

  // doctor accepts it under a PATH without that link.
  const doctor = await runCli(["doctor"], env);
  assert.equal(doctor.checks.find((check) => check.name === "codex-hook").ok, true);
});

test("the Claude hook ignores a Codex rollout that Codex handed it", async (t) => {
  const { root, env } = await sandbox(t);
  const gateLog = path.join(root, "gate.log");
  const hookEnv = { ...process.env, ...env, HONCHO_AGENT_GATE_LOG: gateLog };
  const run = (provider, transcript) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [MAIN, "--provider", provider], { env: hookEnv }, (error) => {
      if (error && error.code !== 1) reject(error);
      else resolve(error ? 1 : 0);
    });
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript }));
  });

  const codexRollout = path.join(root, "user", ".codex", "sessions", "2026", "09", "30", "rollout-x.jsonl");
  assert.equal(await run("claude", codexRollout), 0);
  await assert.rejects(fsp.access(gateLog), "a foreign transcript must not reach the queue");

  const claudeTranscript = path.join(root, "user", ".claude", "projects", "p", "s.jsonl");
  assert.equal(await run("codex", claudeTranscript), 0);
  await assert.rejects(fsp.access(gateLog));

  await run("claude", claudeTranscript);
  await fsp.access(gateLog);
});
