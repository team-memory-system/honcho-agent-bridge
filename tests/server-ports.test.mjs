import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chooseServerPorts,
  ensureDockerRunning,
  installedServerPorts,
  portInUse,
  serverPlan,
  serverPrepare,
  serverStart,
} from "../scripts/server-manager.mjs";

// Starting a shared server asks the team hub for its Jev guard token with this
// computer's team login; no test here reaches a real one.
process.env.HONCHO_AGENT_TEAM_AUTH = path.join(os.tmpdir(), `no-team-login-${process.pid}`, "team-auth.json");

const noFetch = async () => ({ ok: true, fetched: false, directory: "(stubbed)" });

test("portInUse sees a listener on 127.0.0.1 and a free port as free", async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  assert.equal(await portInUse(port), true);
  const free = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port: value } = probe.address();
      probe.close(() => resolve(value));
    });
  });
  assert.equal(await portInUse(free), false);
});

test("a new install moves off busy default ports", async () => {
  const busy = new Set([8001, 8002, 4173]);
  const ports = await chooseServerPorts({ inUse: async (port) => busy.has(port) });
  assert.deepEqual(ports, { api: 8003, dashboard: 4174 });
});

test("plan reports moved ports and a startable Docker Desktop instead of stopping", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-plan-ports-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR = path.join(root, "installed");
  t.after(() => { delete process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR; });
  const bundle = path.join(root, "bundle");
  await fsp.mkdir(bundle, { recursive: true });
  await fsp.writeFile(path.join(bundle, ".env.example"), "HONCHO_API_PORT=8001\n");
  const plan = await serverPlan({
    profile: "portable",
    platform: "darwin",
    dockerInspector: async () => ({ installed: true, running: false }),
    dockerAppFinder: async () => "/Applications/Docker.app",
    bundleInspector: async () => ({ ok: true, directory: bundle, missing: [] }),
    honchoSourceInspector: async () => ({ present: true }),
    portChooser: async () => ({ api: 8002, dashboard: 4173 }),
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.apiUrl, "http://127.0.0.1:8002");
  assert.equal(plan.dashboardUrl, "http://127.0.0.1:4173");
  assert.ok(plan.warnings.some((line) => /Docker Desktop is not running; server prepare starts it/.test(line)));
  assert.ok(plan.warnings.some((line) => /Port 8001 is already used .* will use 8002/.test(line)));

  const noApp = await serverPlan({
    profile: "portable",
    platform: "linux",
    dockerInspector: async () => ({ installed: true, running: false }),
    dockerAppFinder: async () => "",
    bundleInspector: async () => ({ ok: true, directory: bundle, missing: [] }),
    honchoSourceInspector: async () => ({ present: true }),
    portChooser: async () => ({ api: 8001, dashboard: 4173 }),
  });
  assert.equal(noApp.ready, false);
  assert.match(noApp.issues[0], /engine is not running/);
});

test("ensureDockerRunning starts Docker Desktop once and waits for the engine", async () => {
  let probes = 0;
  const launched = [];
  const result = await ensureDockerRunning({
    platform: "darwin",
    inspector: async () => ({ installed: true, running: ++probes >= 3 }),
    appFinder: async () => "/Applications/Docker.app",
    launcher: (app) => launched.push(app),
    intervalMs: 1,
  });
  assert.equal(result.running, true);
  assert.equal(result.started, true);
  assert.deepEqual(launched, ["/Applications/Docker.app"]);

  const running = await ensureDockerRunning({
    inspector: async () => ({ installed: true, running: true }),
    appFinder: async () => { throw new Error("must not look for the app"); },
    launcher: () => { throw new Error("must not launch"); },
  });
  assert.equal(running.started, false);

  const timedOut = await ensureDockerRunning({
    platform: "darwin",
    inspector: async () => ({ installed: true, running: false }),
    appFinder: async () => "/Applications/Docker.app",
    launcher: () => {},
    intervalMs: 1,
    timeoutMs: 5,
  });
  assert.equal(timedOut.running, false);
  assert.match(timedOut.error, /did not answer/);
});

test("prepare writes chosen ports for a new install and keeps an installed install's ports", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-prepare-ports-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, "compose.yaml"), "name: portable\n");
  await fsp.writeFile(path.join(source, ".env.example"), "LLM_OPENAI_API_KEY=set\nHONCHO_API_PORT=8001\nHONCHO_DASHBOARD_PORT=4173\n");
  const prepare = (portChooser) => serverPrepare({
    profile: "portable",
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: noFetch,
    serverDirectory: destination,
    portChooser,
  });

  const first = await prepare(async () => ({ api: 8005, dashboard: 4175 }));
  assert.equal(first.ok, true);
  assert.deepEqual(await installedServerPorts(destination), { installed: true, api: 8005, dashboard: 4175 });

  const second = await prepare(async () => { throw new Error("an installed server keeps its ports"); });
  assert.equal(second.ok, true);
  assert.deepEqual(await installedServerPorts(destination), { installed: true, api: 8005, dashboard: 4175 });
});

test("start reports a taken port as an issue and checks health on the installed port", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-start-ports-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "installed");
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, ".env"), "HONCHO_API_PORT=8007\nHONCHO_DASHBOARD_PORT=4177\n");

  const blocked = await serverStart({
    profile: "portable",
    preparedServer: { ok: true, ready: true },
    serverDirectory: destination,
    composeRunner: async () => {
      const error = new Error("compose failed");
      error.stderr = "Error response from daemon: Ports are not available: listen tcp 127.0.0.1:8007: bind: address already in use";
      throw error;
    },
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.issues[0], /Port 8007 or 4177/);
  assert.match(blocked.next, /HONCHO_API_PORT/);

  const checked = [];
  const started = await serverStart({
    profile: "portable",
    preparedServer: { ok: true, ready: true },
    serverDirectory: destination,
    composeRunner: async () => ({ stdout: "", stderr: "" }),
    healthWaiter: async (url) => { checked.push(url); return { ok: true }; },
  });
  assert.equal(started.ok, true);
  assert.deepEqual(checked, ["http://127.0.0.1:8007/health"]);
  assert.equal(started.apiUrl, "http://127.0.0.1:8007");
  assert.equal(started.dashboardUrl, "http://127.0.0.1:4177");
});
