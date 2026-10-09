// The app's own read-only routes for the folder picker, the project list and the
// dashboard's flow, the projects the memory server can open to a teammate, and the
// hour the nightly backup runs at.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { backupScheduleInvocation, createUiServer } from "../scripts/ui.mjs";

const ENV = ["HONCHO_AGENT_BRIDGE_HOME", "HONCHO_AGENT_BRIDGE_CONFIG", "HONCHO_AGENT_BRIDGE_USER_HOME"];
const saved = {};
let workdir;
let home;
let ui;
let port;

function send(pathname, { method = "GET", body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

before(async () => {
  for (const name of ENV) saved[name] = process.env[name];
  workdir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-bridge-app-routes-")));
  home = path.join(workdir, "home");
  await fsp.mkdir(path.join(home, "Documents"), { recursive: true });
  await fsp.mkdir(path.join(home, ".config"), { recursive: true });
  process.env.HONCHO_AGENT_BRIDGE_HOME = path.join(workdir, "app");
  delete process.env.HONCHO_AGENT_BRIDGE_CONFIG;
  process.env.HONCHO_AGENT_BRIDGE_USER_HOME = home;
  ui = createUiServer();
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  port = ui.address().port;
});

after(async () => {
  await new Promise((resolve) => ui.close(() => resolve()));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fsp.rm(workdir, { recursive: true, force: true });
});

test("the folder route lists a folder, starts at this user's home, and answers a bad path with its reason", async () => {
  const started = await send("/api/app/folders");
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.path, home);
  assert.equal(started.body.parent, workdir);
  assert.deepEqual(started.body.folders, [{ name: "Documents", path: path.join(home, "Documents") }]);
  assert.deepEqual(started.body.roots[0], { kind: "home", path: home });
  assert.equal(started.body.truncated, false);

  const inside = await send(`/api/app/folders?path=${encodeURIComponent(path.join(home, "Documents"))}`);
  assert.equal(inside.body.path, path.join(home, "Documents"));
  assert.equal(inside.body.parent, home);
  assert.deepEqual(inside.body.folders, []);

  const relative = await send("/api/app/folders?path=Documents");
  assert.equal(relative.status, 200);
  assert.equal(relative.body.ok, false);
  assert.equal(relative.body.reason, "not-absolute");

  const missing = await send(`/api/app/folders?path=${encodeURIComponent(path.join(home, "nope"))}`);
  assert.equal(missing.body.reason, "missing");
});

test("the project route reads the transcripts the configuration names", async () => {
  const project = path.join(home, "dev", "app");
  await fsp.mkdir(path.join(project, ".git"), { recursive: true });
  await fsp.mkdir(path.join(project, "src"), { recursive: true });
  const claudeRoot = path.join(workdir, "claude-projects");
  await fsp.mkdir(path.join(claudeRoot, "-app"), { recursive: true });
  await fsp.writeFile(path.join(claudeRoot, "-app", "s.jsonl"), `${JSON.stringify({ type: "user", cwd: path.join(project, "src") })}\n`);
  const codexDay = path.join(home, ".codex", "sessions", "2026", "10", "06");
  await fsp.mkdir(codexDay, { recursive: true });
  await fsp.writeFile(path.join(codexDay, "rollout-x.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: project } })}\n`);
  // Not read: the configuration moves Claude Code's transcripts elsewhere.
  await fsp.mkdir(path.join(home, ".claude", "projects", "-app"), { recursive: true });
  await fsp.writeFile(path.join(home, ".claude", "projects", "-app", "ignored.jsonl"), `${JSON.stringify({ cwd: project })}\n`);

  await fsp.mkdir(process.env.HONCHO_AGENT_BRIDGE_HOME, { recursive: true });
  await fsp.writeFile(path.join(process.env.HONCHO_AGENT_BRIDGE_HOME, "config.json"), JSON.stringify({
    version: 1,
    sources: { claude: { root: claudeRoot } },
  }));

  const response = await send("/api/app/projects");
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.scanned, 2);
  assert.equal(response.body.withoutFolder, 0);
  assert.equal(response.body.projects.length, 1);
  const [listed] = response.body.projects;
  assert.equal(listed.path, project);
  assert.equal(listed.name, "app");
  assert.equal(listed.sessions, 2);
  assert.deepEqual(listed.agents, { claude: 1, codex: 1 });
  assert.equal(listed.exists, true);
  assert.match(listed.lastAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("the projects to open to a teammate are the memory server's, and one that cannot be read says so", async () => {
  // A stand-in memory server: one project's session from another computer, and one
  // an automation ran at /.
  const sessions = [
    { id: "a", metadata: { project_id: "p-0123456789ab", project_name: "flypiano", cwd: "/Users/someone/dev/flypiano", last_imported_at: "2026-10-07T10:00:00.000Z" } },
    { id: "b", metadata: { cwd: "/" } },
  ];
  const honcho = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const url = new URL(request.url, "http://honcho");
      if (request.method !== "POST" || url.pathname !== "/v3/workspaces/memory/sessions/list") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: sessions, total: sessions.length, page: 1, size: 100, pages: 1 }));
    });
  });
  await new Promise((resolve) => honcho.listen(0, "127.0.0.1", resolve));
  const empty = path.join(workdir, "no-transcripts");
  await fsp.mkdir(empty, { recursive: true });
  await fsp.mkdir(process.env.HONCHO_AGENT_BRIDGE_HOME, { recursive: true });
  await fsp.writeFile(path.join(process.env.HONCHO_AGENT_BRIDGE_HOME, "config.json"), JSON.stringify({
    version: 1,
    honcho: { baseUrl: `http://127.0.0.1:${honcho.address().port}`, workspaceId: "memory" },
    sources: { claude: { root: empty }, codex: { root: empty } },
  }));

  assert.equal((await send("/api/team/projects")).status, 405);
  const listed = await send("/api/team/projects", { method: "POST", body: { keep: [{ id: "p-abcdef012345", name: "kept" }, { id: "nope" }] } });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ok, true);
  assert.deepEqual(listed.body.projects, [
    { id: "p-0123456789ab", name: "flypiano", sessions: 1, lastAt: "2026-10-07T10:00:00.000Z", folder: "/Users/someone/dev/flypiano" },
    { id: "p-abcdef012345", name: "kept", sessions: 0, lastAt: null, folder: null },
  ]);

  await new Promise((resolve) => honcho.close(resolve));
  const down = await send("/api/team/projects", { method: "POST", body: {} });
  assert.equal(down.body.ok, false);
  assert.equal(down.body.projects, undefined);
  assert.match(down.body.error, /^기억 서버에서 프로젝트를 읽지 못했습니다 \(ECONNREFUSED\)\.$/);
});

test("가드 시험 fills one project's scope first and waits for Honcho to copy it", async () => {
  const asked = [];
  let statusCalls = 0;
  const honcho = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://honcho");
      asked.push(`${request.method} ${url.pathname}`);
      const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (url.pathname === "/v3/workspaces/memory/scopes") return json({ id: JSON.parse(raw).id }, 201);
      if (url.pathname === "/v3/workspaces/memory/sessions/list") {
        const wanted = JSON.parse(raw || "{}").filters?.metadata?.project_id;
        const items = wanted === "p-0123456789ab" ? [{ id: "a", metadata: { project_id: wanted } }] : [];
        return json({ items, total: items.length, page: 1, size: 100, pages: 1 });
      }
      if (url.pathname === "/v3/workspaces/memory/scopes/p-0123456789ab/sessions") { response.writeHead(204).end(); return undefined; }
      if (url.pathname === "/v3/workspaces/memory/scopes/p-0123456789ab/status") {
        statusCalls += 1;
        return json({ backfill_status: { a: { state: statusCalls > 1 ? "completed" : "pending" } } });
      }
      return json({ detail: "not found" }, 404);
    });
  });
  await new Promise((resolve) => honcho.listen(0, "127.0.0.1", resolve));
  const empty = path.join(workdir, "no-transcripts-scope");
  await fsp.mkdir(empty, { recursive: true });
  await fsp.mkdir(process.env.HONCHO_AGENT_BRIDGE_HOME, { recursive: true });
  await fsp.writeFile(path.join(process.env.HONCHO_AGENT_BRIDGE_HOME, "config.json"), JSON.stringify({
    version: 1,
    honcho: { baseUrl: `http://127.0.0.1:${honcho.address().port}`, workspaceId: "memory" },
    sources: { claude: { root: empty }, codex: { root: empty } },
    paths: { dataDir: path.join(workdir, "scope-data") },
  }));

  const none = await send("/api/team/scope", { method: "POST", body: { project: { id: "nope" } } });
  assert.deepEqual(none.body, { ok: false, error: "프로젝트를 고르세요." });
  const filled = await send("/api/team/scope", { method: "POST", body: { project: { id: "p-0123456789ab", name: "jev" } } });
  assert.equal(filled.body.ok, true);
  assert.equal(filled.body.settled, true);
  assert.deepEqual(filled.body.scope, { id: "p-0123456789ab", name: "jev", added: 1, sessions: 1 });
  assert.ok(asked.includes("POST /v3/workspaces/memory/scopes"));
  assert.ok(asked.includes("POST /v3/workspaces/memory/scopes/p-0123456789ab/sessions"));
  assert.equal(statusCalls, 2);
  await new Promise((resolve) => honcho.close(resolve));
});

test("the flow route counts what waits to go and what went, for the agents that collect", async () => {
  const appHome = process.env.HONCHO_AGENT_BRIDGE_HOME;
  const dataDir = path.join(appHome, "data");
  await fsp.mkdir(appHome, { recursive: true });
  await fsp.writeFile(path.join(appHome, "config.json"), JSON.stringify({ version: 1, agents: { claude: true, codex: false } }));
  const write = async (file, value) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  await write(path.join(dataDir, "spool", "claude", "pending", "a.json"), {});
  await write(path.join(dataDir, "spool", "claude", "pending", "b.json"), {});
  await write(path.join(dataDir, "spool", "claude", "pending", "c.tmp"), "");
  await write(path.join(dataDir, "state", "claude.json"), { version: 1, sessions: {
    one: { last_imported_at: "2026-10-06T10:00:00.000Z" },
    two: { last_imported_at: "2026-10-07T01:30:00.000Z" },
  } });
  // Codex does not collect here, so its leftovers are not counted.
  await write(path.join(dataDir, "spool", "codex", "pending", "x.json"), {});
  await write(path.join(dataDir, "state", "codex.json"), { version: 1, sessions: { three: { last_imported_at: "2026-10-08T00:00:00.000Z" } } });

  const response = await send("/api/app/flow");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, collect: { pending: 2, sessions: 2, lastSentAt: "2026-10-07T01:30:00.000Z" }, targets: [], backfill: null });

  // A state caught mid-write counts as nothing sent until it is whole again.
  await write(path.join(dataDir, "state", "claude.json"), "{\"version\":1,\"sess");
  assert.deepEqual((await send("/api/app/flow")).body.collect, { pending: 2, sessions: 0, lastSentAt: null });

  // Past conversations on their way: a run still going says how far it got; a run
  // whose process is gone counts as not running, and the last finished one stays.
  await write(path.join(dataDir, "state", "backfill-status.json"), {
    version: 1,
    running: { pid: process.pid, startedAt: "2026-10-07T02:00:00.000Z", considered: 40, examined: 12, remaining: 28, sent_sessions: 9, failed: 0 },
    lastRun: { startedAt: "2026-10-06T02:00:00.000Z", finishedAt: "2026-10-06T02:05:00.000Z", considered: 5, examined: 5, remaining: 0, sent_sessions: 5, failed: 0 },
  });
  assert.deepEqual((await send("/api/app/flow")).body.backfill, {
    running: { considered: 40, examined: 12, remaining: 28, sent: 9, failed: 0, at: "2026-10-07T02:00:00.000Z" },
    lastRun: { considered: 5, examined: 5, remaining: 0, sent: 5, failed: 0, at: "2026-10-06T02:05:00.000Z" },
  });
  await write(path.join(dataDir, "state", "backfill-status.json"), { version: 1, running: { pid: 2 ** 22 + 7, considered: 1 }, lastRun: null });
  assert.deepEqual((await send("/api/app/flow")).body.backfill, { running: null, lastRun: null });
});

test("the app's read-only routes answer only GET", async () => {
  for (const route of ["/api/app/folders", "/api/app/projects", "/api/app/flow"]) {
    const posted = await send(route, { method: "POST", body: {} });
    assert.equal(posted.status, 405, route);
    assert.equal(posted.body.ok, false);
  }
});

test("the backup schedule passes an hour only when it is one", async () => {
  assert.deepEqual(backupScheduleInvocation({ on: true }), ["backup", "schedule", "on"]);
  assert.deepEqual(backupScheduleInvocation({}), ["backup", "schedule", "off"]);
  assert.deepEqual(backupScheduleInvocation(undefined), ["backup", "schedule", "off"]);
  assert.deepEqual(backupScheduleInvocation({ on: "true" }), ["backup", "schedule", "off"], "only true turns it on");
  assert.deepEqual(backupScheduleInvocation({ on: true, hour: 0 }), ["backup", "schedule", "on", "--hour=0"]);
  assert.deepEqual(backupScheduleInvocation({ on: false, hour: 23 }), ["backup", "schedule", "off", "--hour=23"]);
  assert.deepEqual(backupScheduleInvocation({ on: true, hour: null }), ["backup", "schedule", "on"]);
  for (const hour of [24, -1, 1.5, "5", "--hour=1", true, Number.NaN]) {
    assert.equal(backupScheduleInvocation({ on: true, hour }), null, String(hour));
  }

  const refused = await send("/api/backup/schedule", { method: "POST", body: { on: true, hour: 24 } });
  assert.equal(refused.status, 200);
  assert.deepEqual(refused.body, { ok: false, error: "Choose an hour from 0 to 23." });
});
