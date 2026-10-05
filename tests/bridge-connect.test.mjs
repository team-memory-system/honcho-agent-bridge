// Asking someone else's memory needs four values in config.json and nothing else.
// These tests hold the path a teammate takes: the values arrive without touching the
// command line, they are saved only once the bridge really answers with them, and
// nothing else the installer does quietly throws them away.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { BRIDGE_TOKEN, startBridge } from "./fake-bridge.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const TOKEN = BRIDGE_TOKEN;
const ACCESS_ID = "client-id-value.access";
const ACCESS_SECRET = "client-secret-value";

async function workspace(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-connect-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  await fsp.mkdir(home, { recursive: true });
  const env = { HONCHO_AGENT_BRIDGE_HOME: appHome, HONCHO_AGENT_BRIDGE_USER_HOME: home, HOME: home, USERPROFILE: home };
  for (const name of ["HONCHO_MCP_BEARER_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "HONCHO_AGENT_BRIDGE_CONFIG"]) env[name] = "";
  return { configPath: path.join(appHome, "config.json"), env };
}

async function cli(args, env) {
  const merged = { ...process.env, ...env };
  for (const [name, value] of Object.entries(env)) if (value === "") delete merged[name];
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: merged, timeout: 60_000 });
    return { stdout, body: JSON.parse(stdout) };
  } catch (error) {
    if (!error.stdout) throw error;
    return { stdout: error.stdout, body: JSON.parse(error.stdout) };
  }
}

const secretEnv = (extra = {}) => ({
  HONCHO_MCP_BEARER_TOKEN: TOKEN,
  CF_ACCESS_CLIENT_ID: ACCESS_ID,
  CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
  ...extra,
});

test("connect saves the four values privately, after the bridge has answered with them", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { configPath, env } = await workspace(t);

  const { stdout, body } = await cli(["bridge", "connect", "--url", bridge.url], { ...env, ...secretEnv() });

  assert.equal(body.ok, true, stdout);
  assert.equal(body.saved, true);
  assert.deepEqual(body.tools, ["chat"], "the tool list is the bridge's, reached through the plugin's own MCP server");
  assert.equal(body.hasBridgeCredential, true);
  assert.equal(body.hasAccessCredential, true);
  for (const secret of [TOKEN, ACCESS_ID, ACCESS_SECRET]) {
    assert.equal(stdout.includes(secret), false, "no credential is ever printed");
  }

  const saved = JSON.parse(await fsp.readFile(configPath, "utf8"));
  assert.equal(saved.version, 1, "the MCP server ignores a config without it");
  assert.deepEqual(
    { url: saved.honcho.mcpBridgeUrl, token: saved.honcho.mcpBridgeToken, id: saved.honcho.accessClientId, secret: saved.honcho.accessClientSecret },
    { url: bridge.url, token: TOKEN, id: ACCESS_ID, secret: ACCESS_SECRET },
  );
  assert.deepEqual(saved.agents, { codex: false, claude: false }, "asking someone else's memory installs no hooks");
  if (process.platform !== "win32") assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o600);

  const initialize = bridge.seen.find((entry) => entry.message?.method === "initialize");
  assert.equal(initialize.headers["cf-access-client-id"], ACCESS_ID);
  assert.equal(initialize.headers["cf-access-client-secret"], ACCESS_SECRET);
});

test("a wrong token is refused at connect, and nothing is saved", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { configPath, env } = await workspace(t);

  const { body } = await cli(["bridge", "connect", "--url", bridge.url], { ...env, ...secretEnv({ HONCHO_MCP_BEARER_TOKEN: "wrong" }) });

  assert.equal(body.ok, false);
  assert.equal(body.saved, false);
  assert.match(body.error, /401/);
  await assert.rejects(fsp.access(configPath), "a failed connect leaves no file behind");
});

test("a failed connect puts the previous file back exactly", async (t) => {
  const bridge = await startBridge();
  const { configPath, env } = await workspace(t);
  await cli(["bridge", "connect", "--url", bridge.url], { ...env, ...secretEnv() });
  const before = await fsp.readFile(configPath, "utf8");
  await new Promise((resolve) => bridge.server.close(() => resolve()));

  const { body } = await cli(["bridge", "connect", "--url", bridge.url.replace("/mcp", "/other")], { ...env, ...secretEnv() });

  assert.equal(body.ok, false);
  assert.equal(await fsp.readFile(configPath, "utf8"), before);
});

test("secrets on the command line are refused, not used", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { configPath, env } = await workspace(t);

  const { body } = await cli(
    ["bridge", "connect", "--url", bridge.url, "--mcp-bridge-token", TOKEN, "--access-client-secret", ACCESS_SECRET],
    env,
  );

  assert.equal(body.ok, false);
  assert.match(body.issues.join(" "), /not the command line/);
  assert.equal(bridge.seen.length, 0, "nothing was sent anywhere");
  await assert.rejects(fsp.access(configPath));
});

test("a plain-http address is refused unless it is on this machine", async (t) => {
  const { env } = await workspace(t);
  const remote = await cli(["bridge", "connect", "--url", "http://bridge.example.com/mcp"], { ...env, ...secretEnv() });
  assert.equal(remote.body.ok, false);
  assert.match(remote.body.issues.join(" "), /must use https/);

  const halfToken = await cli(["bridge", "connect", "--url", "https://bridge.example.com/mcp"], {
    ...env,
    ...secretEnv({ CF_ACCESS_CLIENT_SECRET: "" }),
  });
  assert.match(halfToken.body.issues.join(" "), /both its ID and its secret/);
});

test("setup keeps a connected bridge instead of rebuilding the config without it", async (t) => {
  // setupPlan builds config.json afresh; before this it carried only apiToken over,
  // so installing hooks later silently disconnected the shared bridge.
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { configPath, env } = await workspace(t);
  await cli(["bridge", "connect", "--url", bridge.url], { ...env, ...secretEnv() });

  const applied = await cli(
    ["setup", "apply", "--agents", "codex", "--user-peer", "user_test", "--honcho-url", "http://127.0.0.1:9"],
    env,
  );
  assert.equal(applied.body.ok, true, applied.stdout);

  const saved = JSON.parse(await fsp.readFile(configPath, "utf8"));
  assert.equal(saved.honcho.mcpBridgeUrl, bridge.url);
  assert.equal(saved.honcho.mcpBridgeToken, TOKEN);
  assert.equal(saved.honcho.accessClientSecret, ACCESS_SECRET);
  assert.equal(saved.user.peerId, "user_test");
});

test("status and doctor describe a relay-only machine without failing on what it does not need", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { env } = await workspace(t);
  await cli(["bridge", "connect", "--url", bridge.url], { ...env, ...secretEnv() });

  const status = await cli(["bridge", "status"], env);
  assert.deepEqual(
    { connected: status.body.connected, url: status.body.url, bridge: status.body.hasBridgeCredential, access: status.body.hasAccessCredential },
    { connected: true, url: bridge.url, bridge: true, access: true },
  );

  const tested = await cli(["bridge", "test"], env);
  assert.equal(tested.body.ok, true);
  assert.deepEqual(tested.body.tools, ["chat"]);

  const doctor = await cli(["doctor"], env);
  assert.equal(doctor.body.ok, true, JSON.stringify(doctor.body.checks));
  assert.deepEqual(doctor.body.checks.map((check) => check.name), ["configuration", "shared-bridge"],
    "no runtime, local Honcho or hook check on a machine that installs none");
});

test("disconnect removes the values, and a file that only held them goes too", async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.server.close());
  const { configPath, env } = await workspace(t);
  await cli(["bridge", "connect", "--url", bridge.url], { ...env, ...secretEnv() });

  const { body } = await cli(["bridge", "disconnect"], env);
  assert.equal(body.ok, true);
  assert.equal(body.connected, false);
  assert.equal(body.removedConfig, true);
  await assert.rejects(fsp.access(configPath));

  const again = await cli(["bridge", "connect", "--url", bridge.url], { ...env, ...secretEnv() });
  assert.equal(again.body.ok, true, "a later connect is not blocked by a leftover file");
});

test("ui open starts one detached setup screen and reuses it", async (t) => {
  const { env } = await workspace(t);
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(() => resolve()));
  const uiEnv = { ...env, HONCHO_AGENT_BRIDGE_UI_PORT: String(port) };

  const first = await cli(["ui", "open", "--no-browser"], uiEnv);
  t.after(() => { try { process.kill(first.body.pid); } catch {} });
  assert.equal(first.body.ok, true, first.stdout);
  assert.equal(first.body.started, true);
  assert.equal(first.body.url, `http://127.0.0.1:${port}`);

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await page.text(), /id="bridge-form"/, "it outlived the command that started it");

  const second = await cli(["ui", "open", "--no-browser"], uiEnv);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.started, false, "a running screen is reused, not doubled");

  const onScreen = await cli(["ui", "open", "--screen", "models", "--no-browser"], uiEnv);
  assert.equal(onScreen.body.ok, true);
  assert.match(onScreen.body.url, /#\/models$/, "--screen opens the app on that screen");
  const bad = await cli(["ui", "open", "--screen", "x?y=1", "--no-browser"], uiEnv);
  assert.equal(bad.body.ok, false);
});

test("ui open does not mistake another program on its port for the setup screen", async (t) => {
  const { env } = await workspace(t);
  const other = http.createServer((request, response) => response.end("<html>something else</html>"));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => other.close());

  const { body } = await cli(["ui", "open", "--no-browser"], { ...env, HONCHO_AGENT_BRIDGE_UI_PORT: String(other.address().port) });
  assert.equal(body.ok, false);
  assert.match(body.error, /Something else is answering/);
});
