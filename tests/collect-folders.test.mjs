// Setup can choose which folders' conversations this computer's own server takes:
// only some folders, or every folder but some, so folders made later are taken
// too. What matters: a session outside the choice never reaches the own server, a
// ChatGPT import is never held back by it, a target keeps its own folders, and
// `backfill` sends the past sessions of the chosen folders once and only once.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { COLLECT_FOLDERS_ENV, collectFolders, configEnvironment } from "../scripts/config.mjs";
import { collectFoldersFromEnvironment, outsideCollectFolders, targetEnvironment } from "../scripts/targets.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");

/** A Honcho that keeps what it is sent, so the collector's reconciliation sees it. */
async function fakeHoncho() {
  const state = { requests: [], sessions: new Map() };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(request.url, "http://h");
    state.requests.push({ method: request.method, path: url.pathname, body });
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") return response.end(JSON.stringify({ status: "ok" }));
    const list = /\/sessions\/([^/]+)\/messages\/list$/.exec(url.pathname);
    if (list) {
      const stored = state.sessions.get(decodeURIComponent(list[1])) || [];
      const page = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("size") || 100);
      return response.end(JSON.stringify({ items: stored.slice((page - 1) * size, page * size), total: stored.length }));
    }
    const write = /\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (write) {
      const id = decodeURIComponent(write[1]);
      state.sessions.set(id, [...(state.sessions.get(id) || []), ...body.messages]);
      return response.end(JSON.stringify(body.messages));
    }
    if (url.pathname.endsWith("/sessions/list")) return response.end(JSON.stringify({ items: [], total: 0, page: 1, pages: 0 }));
    return response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.server = server;
  state.sessionIds = () => [...state.sessions.keys()].sort();
  state.writes = () => state.requests.filter((entry) => entry.path.endsWith("/messages")).length;
  return state;
}

/** This test's own environment: nothing of the machine's Honcho settings leaks in. */
function cleanEnvironment(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(HONCHO_|CF_ACCESS_|CODEX_|CLAUDE_)/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

async function makeInstall(t, primary, { collect, targets } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-collect-")));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const appHome = path.join(root, "app");
  const dataDir = path.join(appHome, "data");
  const work = path.join(root, "work");
  const team = path.join(work, "team");
  const side = path.join(work, "side");
  for (const directory of [home, appHome, team, side]) await fsp.mkdir(directory, { recursive: true });
  const install = { root, home, appHome, dataDir, work, team, side, configPath: path.join(appHome, "config.json") };
  const config = {
    version: 1,
    user: { peerId: "user_test" },
    honcho: { baseUrl: primary.url, workspaceId: "memory" },
    agents: { codex: true, claude: true },
    ...(collect ? { collect: collect(install) } : {}),
    ...(targets ? { targets: targets(install) } : {}),
    sources: { codex: { root: path.join(home, ".codex", "sessions") } },
    paths: { dataDir },
  };
  await fsp.writeFile(install.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  install.env = cleanEnvironment({
    HONCHO_AGENT_BRIDGE_HOME: appHome,
    HONCHO_AGENT_BRIDGE_USER_HOME: home,
    HOME: home,
    USERPROFILE: home,
    HONCHO_CODEX_NETWORK_MODE: "internal",
  });
  return install;
}

async function cli(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env });
    return { status: 0, text: stdout, body: JSON.parse(stdout) };
  } catch (error) {
    return { status: error.code, text: String(error.stdout || ""), body: error.stdout ? JSON.parse(error.stdout) : null };
  }
}

/** What an agent host does at the end of a turn: run the hook with its input on stdin. */
function hook(provider, transcript, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "hook", provider], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify({ transcript_path: transcript }));
  });
}

async function writeClaude(file, { sessionId, cwd, turns }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const rows = turns.map(([role, text], index) => ({
    uuid: `${sessionId}-${index + 1}`,
    sessionId,
    cwd,
    timestamp: `2026-09-20T10:00:0${index}Z`,
    message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
  }));
  await fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function writeCodex(file, { sessionId, cwd, turns }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const rows = [
    { type: "session_meta", payload: { id: sessionId, source: "cli", originator: "codex_cli_rs", cwd } },
    ...turns.map(([role, text], index) => ({
      type: "response_item",
      timestamp: `2026-09-20T11:00:0${index}Z`,
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    })),
  ];
  await fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

/** One Claude session in `team`, one in `side`, and one Codex session in `team`. */
async function writeSessions(install) {
  const files = {
    inside: path.join(install.home, ".claude", "projects", "team", "inside.jsonl"),
    outside: path.join(install.home, ".claude", "projects", "side", "outside.jsonl"),
    codex: path.join(install.home, ".codex", "sessions", "2026", "09", "20", "rollout-inside.jsonl"),
  };
  await writeClaude(files.inside, { sessionId: "inside", cwd: install.team, turns: [["user", "team question"], ["assistant", "team answer"]] });
  await writeClaude(files.outside, { sessionId: "outside", cwd: install.side, turns: [["user", "side question"], ["assistant", "side answer"]] });
  await writeCodex(files.codex, { sessionId: "codex-inside", cwd: path.join(install.team, "api"), turns: [["user", "codex question"], ["assistant", "codex answer"]] });
  return files;
}

test("the folder choice is read from config, travels in the environment, and never reaches a target", () => {
  assert.equal(collectFolders({}), null, "no choice takes every folder");
  assert.equal(collectFolders({ collect: { take: ["/w/a"], skip: [], rest: "take" } }), null, "skipping nothing takes every folder");
  assert.deepEqual(collectFolders({ collect: { take: ["/w/a", 3], rest: "skip" } }), { take: ["/w/a"], skip: [], rest: "skip" });
  assert.deepEqual(collectFolders({ collect: { skip: ["/w/b"] } }), { take: [], skip: ["/w/b"], rest: "take" }, "the rest is taken unless said");

  const config = { version: 1, user: { peerId: "me" }, honcho: { baseUrl: "http://127.0.0.1:1" }, collect: { skip: ["/w/b"], rest: "take" } };
  const env = configEnvironment(config, "claude");
  assert.deepEqual(JSON.parse(env[COLLECT_FOLDERS_ENV]), { take: [], skip: ["/w/b"], rest: "take" });
  assert.deepEqual(collectFoldersFromEnvironment(env), { take: [], skip: ["/w/b"], rest: "take" });
  assert.equal(COLLECT_FOLDERS_ENV in configEnvironment({ ...config, collect: undefined }, "claude"), false);
  assert.equal(collectFoldersFromEnvironment({}), null);
  assert.deepEqual(collectFoldersFromEnvironment({ [COLLECT_FOLDERS_ENV]: "{not json" }), { take: [], skip: [], rest: "skip" }, "an unreadable choice takes nothing");

  const posix = { platform: "linux", home: "/home/me", resolveLinks: false };
  const only = { take: ["/w/a"], skip: [], rest: "skip" };
  assert.equal(outsideCollectFolders("/w/a/x", only, posix), false);
  assert.equal(outsideCollectFolders("/w/b", only, posix), true);
  assert.equal(outsideCollectFolders(undefined, only, posix), true, "no folder goes by the rest");
  const skipping = { take: [], skip: ["/w/b"], rest: "take" };
  assert.equal(outsideCollectFolders("/w/b/y", skipping, posix), true);
  assert.equal(outsideCollectFolders("/w/new", skipping, posix), false, "a folder made later goes by the rest");
  assert.equal(outsideCollectFolders(undefined, skipping, posix), false);
  // The home folder skipped, a repository inside it taken: the deeper one decides.
  const nested = { take: ["/home/me/dev/app"], skip: ["~"], rest: "take" };
  assert.equal(outsideCollectFolders("/home/me", nested, posix), true, "a session in the home folder itself is skipped");
  assert.equal(outsideCollectFolders("/home/me/dev/app/src", nested, posix), false, "the repository inside it is still taken");
  assert.equal(outsideCollectFolders("/home/me/other", nested, posix), true, "the rest of the home folder is skipped with it");
  assert.equal(outsideCollectFolders("/srv/x", nested, posix), false, "outside every named folder the rest decides");
  assert.equal(outsideCollectFolders("/w/a", { take: ["/w/a"], skip: ["/w/a"], rest: "take" }, posix), true, "a folder both taken and skipped is skipped");
  assert.equal(outsideCollectFolders("/anything", null, posix), false);

  const target = { id: "team", honcho: { baseUrl: "http://127.0.0.1:2" }, folders: ["/w/a"] };
  const targetEnv = targetEnvironment({ ...config, targets: [target] }, target, "claude", env);
  assert.equal(COLLECT_FOLDERS_ENV in targetEnv, false, "a target takes its own folders, not the own server's choice");
});

test("setup takes some folders, skips some, says what the rest does, or takes every folder again", async (t) => {
  const primary = await fakeHoncho();
  t.after(() => primary.server.close());
  const install = await makeInstall(t, primary);

  const only = await cli(["setup", "plan", "--take-folders", `${install.team},~/notes`, "--rest-folders", "skip"], install.env);
  assert.deepEqual(only.body.config.collect, { take: [install.team, path.join(install.home, "notes")], skip: [], rest: "skip" }, only.text);
  assert.ok(only.body.warnings.some((warning) => warning.includes("notes") && warning.includes("does not exist")));

  const skip = await cli(["setup", "plan", "--skip-folders", install.side], install.env);
  assert.deepEqual(skip.body.config.collect, { take: [], skip: [install.side], rest: "take" }, skip.text);

  const nothing = await cli(["setup", "plan", "--rest-folders", "skip"], install.env);
  assert.equal(nothing.body.ok, false, "taking no folder and skipping the rest collects nothing");
  assert.ok(nothing.body.issues.some((issue) => issue.includes("--take-folders")));

  const wrong = await cli(["setup", "plan", "--skip-folders", install.side, "--rest-folders", "maybe"], install.env);
  assert.equal(wrong.body.ok, false);
  const mixed = await cli(["setup", "plan", "--all-folders", "--skip-folders", install.side], install.env);
  assert.equal(mixed.body.ok, false, "every folder and some skipped cannot both be meant");

  const relative = await cli(["setup", "plan", "--take-folders", "work/team", "--rest-folders", "skip"], install.env);
  assert.equal(relative.body.ok, false);
  assert.ok(relative.body.issues.some((issue) => issue.includes("not an absolute folder")));

  const applied = await cli(["setup", "apply", "--skip-folders", install.side], install.env);
  assert.equal(applied.body.ok, true, applied.text);
  assert.deepEqual(JSON.parse(await fsp.readFile(install.configPath, "utf8")).collect, { take: [], skip: [install.side], rest: "take" });

  const kept = await cli(["setup", "plan"], install.env);
  assert.deepEqual(kept.body.config.collect, { take: [], skip: [install.side], rest: "take" }, "a plan without a choice keeps the saved one");
  const all = await cli(["setup", "plan", "--all-folders"], install.env);
  assert.equal(all.body.config.collect, undefined, "every folder again");
});

test("a session outside the chosen folders never reaches the own server, and a target keeps its own folders", async (t) => {
  const primary = await fakeHoncho();
  const target = await fakeHoncho();
  t.after(() => { primary.server.close(); target.server.close(); });
  const install = await makeInstall(t, primary, {
    collect: ({ side }) => ({ take: [side], rest: "skip" }),
    targets: ({ team }) => [{ id: "team", honcho: { baseUrl: target.url, workspaceId: "memory" }, folders: [team], enabled: true }],
  });
  const files = await writeSessions(install);
  for (const [provider, file] of [["claude", files.inside], ["claude", files.outside], ["codex", files.codex]]) {
    const result = await hook(provider, file, install.env);
    assert.equal(result.status, 0, result.stdout);
  }
  assert.deepEqual(primary.sessionIds(), ["claude-outside"], "the own server took only the chosen folder");
  assert.deepEqual(target.sessionIds(), ["claude-inside", "codex-codex-inside"], "the target still takes its folders");
});

test("skipping a folder takes every other one, folders made later included", async (t) => {
  const primary = await fakeHoncho();
  t.after(() => primary.server.close());
  const install = await makeInstall(t, primary, { collect: ({ side }) => ({ skip: [side], rest: "take" }) });
  const files = await writeSessions(install);
  const later = path.join(install.home, ".claude", "projects", "later", "later.jsonl");
  await writeClaude(later, { sessionId: "later", cwd: path.join(install.work, "made-later"), turns: [["user", "new"], ["assistant", "folder"]] });
  for (const [provider, file] of [["claude", files.inside], ["claude", files.outside], ["codex", files.codex], ["claude", later]]) {
    const result = await hook(provider, file, install.env);
    assert.equal(result.status, 0, result.stdout);
  }
  assert.deepEqual(primary.sessionIds(), ["claude-inside", "claude-later", "codex-codex-inside"]);
});

test("backfill sends the past sessions of the chosen folders to the own server, once", async (t) => {
  const primary = await fakeHoncho();
  t.after(() => primary.server.close());
  const install = await makeInstall(t, primary, { collect: ({ team }) => ({ take: [team], rest: "skip" }) });
  await writeSessions(install);

  const before = await cli(["backfill", "status"], install.env);
  assert.equal(before.body.ok, true);
  assert.equal(before.body.lastRun, null);

  const run = await cli(["backfill", "run"], install.env);
  assert.equal(run.body.ok, true, run.text);
  assert.equal(run.body.sent_sessions, 2);
  assert.equal(run.body.outside_folders, 1);
  assert.deepEqual(primary.sessionIds(), ["claude-inside", "codex-codex-inside"]);

  const writes = primary.writes();
  const again = await cli(["backfill", "run"], install.env);
  assert.equal(again.body.considered, 0, "nothing new to look at");
  assert.equal(primary.writes(), writes, "nothing sent twice");

  const after = await cli(["backfill", "status"], install.env);
  assert.equal(after.body.running, null);
  assert.ok(after.body.lastRun.finishedAt);
  assert.equal(after.body.lastRun.considered, 0);

  // A session added later goes in a run started in the background.
  const late = path.join(install.home, ".claude", "projects", "team", "late.jsonl");
  await writeClaude(late, { sessionId: "late", cwd: install.team, turns: [["user", "late question"], ["assistant", "late answer"]] });
  const started = await cli(["backfill", "start"], install.env);
  assert.equal(started.body.ok, true, started.text);
  assert.equal(started.body.started, true);
  const deadline = Date.now() + 20_000;
  while (!primary.sessionIds().includes("claude-late") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(primary.sessionIds().includes("claude-late"), "the background run sent the new session");
});
