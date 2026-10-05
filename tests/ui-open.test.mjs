// `ui open` starts the app's screen once, detached, and reuses it; it tells it apart
// from another program on the same port by the page's marker. `bridge disconnect`
// clears what the shared bridge of 0.3.28 and before left in the configuration.
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

async function workspace(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-ui-open-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  await fsp.mkdir(home, { recursive: true });
  const env = { HONCHO_AGENT_BRIDGE_HOME: appHome, HONCHO_AGENT_BRIDGE_USER_HOME: home, HOME: home, USERPROFILE: home };
  for (const name of ["HONCHO_MCP_BEARER_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "HONCHO_AGENT_BRIDGE_CONFIG"]) env[name] = "";
  return { appHome, configPath: path.join(appHome, "config.json"), env };
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

test("bridge disconnect removes a configuration that only held the old shared bridge", async (t) => {
  const { appHome, configPath, env } = await workspace(t);
  await fsp.mkdir(appHome, { recursive: true });
  // What `bridge connect` of 0.3.28 and before wrote on a computer that never ran setup.
  await fsp.writeFile(configPath, JSON.stringify({
    version: 1,
    honcho: { mcpBridgeUrl: "https://bridge.example.com/mcp", mcpBridgeToken: "old-bridge-token", accessClientId: "bridge-id", accessClientSecret: "bridge-secret" },
    agents: { codex: false, claude: false },
  }, null, 2));

  const { body } = await cli(["bridge", "disconnect"], env);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.changed, true);
  assert.equal(body.removedConfig, true);
  await assert.rejects(fsp.access(configPath));

  const again = await cli(["bridge", "disconnect"], env);
  assert.equal(again.body.ok, true);
  assert.equal(again.body.changed, false);
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
  assert.match(await page.text(), /id="team-memory-app"/, "it outlived the command that started it");

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
