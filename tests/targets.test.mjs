// Some folders' conversations also go to a second server (a "target"). What
// matters: the owner's own server still gets everything, a target gets only the
// sessions whose working directory is inside its folders, a target that is down
// neither holds up the primary nor loses its copy, nobody gets anything twice,
// and a target's secrets never ride a command line or come back in any output.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appContext } from "../scripts/app-api.mjs";
import { folderMatches, normalizeFolder, targetEnvironment } from "../scripts/targets.mjs";
import { createUiServer, targetInvocation } from "../scripts/ui.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");

const TARGET_TOKEN = "target-api-token-7f3e91c2";
const ACCESS_ID = "target-access-id-2b8d.access";
const ACCESS_SECRET = "target-access-secret-e4a15c90";

/** A Honcho that keeps what it is sent, so the collector's reconciliation sees it. */
async function fakeHoncho() {
  const state = { requests: [], sessions: new Map(), down: false };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(request.url, "http://h");
    state.requests.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (state.down) {
      response.statusCode = 503;
      return response.end(JSON.stringify({ detail: "down for maintenance" }));
    }
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
  state.messages = () => [...state.sessions.values()].flat();
  state.sessionIds = () => [...state.sessions.keys()].sort();
  state.touched = (sessionId) => state.requests.some((entry) => entry.path.includes(`/sessions/${sessionId}`)
    || entry.body?.id === sessionId);
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

async function makeInstall(t, primary, { agents = { codex: true, claude: true } } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-targets-")));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const appHome = path.join(root, "app");
  const dataDir = path.join(appHome, "data");
  const work = path.join(root, "work");
  const team = path.join(work, "team");
  const teammate = path.join(work, "teammate");
  for (const directory of [home, appHome, team, teammate]) await fsp.mkdir(directory, { recursive: true });
  const config = {
    version: 1,
    user: { peerId: "user_test" },
    honcho: { baseUrl: primary.url, workspaceId: "memory" },
    agents,
    sources: { codex: { root: path.join(home, ".codex", "sessions") } },
    paths: { dataDir },
  };
  await fsp.writeFile(path.join(appHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const env = cleanEnvironment({
    HONCHO_AGENT_BRIDGE_HOME: appHome,
    HONCHO_AGENT_BRIDGE_USER_HOME: home,
    HOME: home,
    USERPROFILE: home,
    HONCHO_CODEX_NETWORK_MODE: "internal",
  });
  return { root, home, appHome, dataDir, work, team, teammate, env, configPath: path.join(appHome, "config.json") };
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

async function addTarget(install, target, extraArgs = [], extraEnv = {}) {
  return cli(["target", "add", "team", "--url", target.url, "--folders", install.team, ...extraArgs], {
    ...install.env,
    HONCHO_TARGET_API_TOKEN: TARGET_TOKEN,
    ...extraEnv,
  });
}

function pendingFiles(directory) {
  return fsp.readdir(directory).then((names) => names.filter((name) => name.endsWith(".json"))).catch(() => []);
}

test("a folder is matched by its path, never by a prefix of its name", () => {
  const posix = { platform: "linux", home: "/home/me", resolveLinks: false };
  assert.equal(folderMatches("/a/b", ["/a/b"], posix), true);
  assert.equal(folderMatches("/a/b/c/d", ["/a/b"], posix), true);
  assert.equal(folderMatches("/a/bc", ["/a/b"], posix), false, "/a/bc is not inside /a/b");
  assert.equal(folderMatches("/a", ["/a/b"], posix), false, "a parent is not inside its child");
  assert.equal(folderMatches("/a/b/", ["/a/b"], posix), true, "trailing slash on the cwd");
  assert.equal(folderMatches("/a/b", ["/a/b/"], posix), true, "trailing slash on the folder");
  assert.equal(folderMatches("/a/b/../b/c", ["/a//b"], posix), true, "dots and doubled separators");
  assert.equal(folderMatches("/home/me/work/x", ["~/work"], posix), true, "~ is the home folder");
  assert.equal(folderMatches("/home/me/work", ["~"], posix), true);
  assert.equal(folderMatches("/home/me/workshop", ["~/work"], posix), false);
  assert.equal(folderMatches("/anything/at/all", ["/"], posix), true, "the root holds everything");
  assert.equal(folderMatches("/A/B", ["/a/b"], posix), false, "Linux paths are case-sensitive");
  assert.equal(folderMatches("", ["/a"], posix), false, "no working directory never matches");
  assert.equal(folderMatches(undefined, ["/a"], posix), false);
  assert.equal(folderMatches("/a/b", [], posix), false);
  assert.equal(folderMatches("/a/b", ["a/b"], posix), false, "a relative folder matches nothing");

  const mac = { platform: "darwin", home: "/Users/Me", resolveLinks: false };
  assert.equal(folderMatches("/users/me/Work/App", ["/Users/Me/work"], mac), true, "the default macOS file system ignores case");
  assert.equal(folderMatches("/Users/Me/WorkApp", ["/Users/Me/work"], mac), false);

  const windows = { platform: "win32", home: "C:\\Users\\Me", resolveLinks: false };
  assert.equal(folderMatches("c:/work/proj/sub", ["C:\\Work\\Proj"], windows), true, "Windows ignores case and slash direction");
  assert.equal(folderMatches("C:\\Work\\Project", ["C:\\Work\\Proj"], windows), false);
  assert.equal(folderMatches("C:\\Work\\Proj\\", ["c:\\work\\proj"], windows), true);
  assert.equal(folderMatches("C:\\Users\\Me\\dev\\x", ["~\\dev"], windows), true);
  assert.equal(folderMatches("D:\\Work\\Proj", ["C:\\Work\\Proj"], windows), false, "another drive is another folder");

  assert.equal(normalizeFolder("/a/b/", { platform: "linux" }), "/a/b");
  assert.equal(normalizeFolder("relative/path", { platform: "linux" }), "");
});

test("a Codex and a Claude session inside a folder reach both servers; one outside reaches only the primary", async (t) => {
  const primary = await fakeHoncho();
  const target = await fakeHoncho();
  t.after(() => { primary.server.close(); target.server.close(); });
  const install = await makeInstall(t, primary);

  const added = await addTarget(install, target, ["--label", "Company", "--workspace", "company"]);
  assert.equal(added.body.ok, true, added.text);
  assert.equal(added.text.includes(TARGET_TOKEN), false);
  assert.match(added.body.note, /target backfill team/, "past conversations are offered, not sent");
  assert.equal(target.requests.some((entry) => entry.path.endsWith("/messages")), false, "adding sends no conversation");

  const codexFile = path.join(install.home, ".codex", "sessions", "2026", "09", "20", "rollout-inside.jsonl");
  await writeCodex(codexFile, { sessionId: "codex-inside", cwd: path.join(install.team, "api"), turns: [["user", "codex question"], ["assistant", "codex answer"]] });
  const claudeFile = path.join(install.home, ".claude", "projects", "team", "inside.jsonl");
  await writeClaude(claudeFile, { sessionId: "claude-inside", cwd: install.team, turns: [["user", "claude question"], ["assistant", "claude answer"]] });
  const outsideFile = path.join(install.home, ".claude", "projects", "teammate", "outside.jsonl");
  await writeClaude(outsideFile, { sessionId: "claude-outside", cwd: install.teammate, turns: [["user", "private question"], ["assistant", "private answer"]] });

  for (const [provider, file] of [["codex", codexFile], ["claude", claudeFile], ["claude", outsideFile]]) {
    const result = await hook(provider, file, install.env);
    assert.equal(result.status, 0, result.stdout);
  }

  assert.deepEqual(primary.sessionIds(), ["claude-claude-inside", "claude-claude-outside", "codex-codex-inside"]);
  assert.deepEqual(target.sessionIds(), ["claude-claude-inside", "codex-codex-inside"]);
  assert.equal(target.touched("claude-claude-outside"), false, "nothing at all about the outside session reached the target");
  assert.equal(target.messages().some((message) => /private/.test(message.content)), false);

  // The target's copy is the primary's: same peers, content and metadata.
  for (const sessionId of target.sessionIds()) {
    assert.deepEqual(target.sessions.get(sessionId), primary.sessions.get(sessionId), sessionId);
  }
  const targetWrites = target.requests.filter((entry) => entry.path.endsWith("/messages"));
  assert.ok(targetWrites.every((entry) => entry.path.startsWith("/v3/workspaces/company/")), "the target's own workspace");
  assert.ok(target.requests.filter((entry) => entry.path !== "/health").every((entry) => entry.headers.authorization === `Bearer ${TARGET_TOKEN}`));
  assert.ok(primary.requests.every((entry) => entry.headers.authorization === undefined), "the target's token never goes to the primary");

  const context = await appContext({ config: JSON.parse(await fsp.readFile(install.configPath, "utf8")), ports: { installed: false }, env: {} });
  assert.equal(context.targets.length, 1);
  const [summary] = context.targets;
  assert.equal(summary.id, "team");
  assert.equal(summary.label, "Company");
  assert.equal(summary.hasToken, true);
  assert.equal(summary.hasAccess, false);
  assert.equal(summary.pending, 0);
  assert.ok(summary.lastSentAt);
  assert.deepEqual(summary.folders, [install.team]);
  assert.equal(JSON.stringify(context).includes(TARGET_TOKEN), false);
});

test("a target that is down never holds up the primary, gets its copy on the next drain, and nobody gets anything twice", async (t) => {
  const primary = await fakeHoncho();
  const target = await fakeHoncho();
  t.after(() => { primary.server.close(); target.server.close(); });
  const install = await makeInstall(t, primary);
  assert.equal((await addTarget(install, target)).body.ok, true);
  const transcript = path.join(install.home, ".claude", "projects", "team", "down.jsonl");
  await writeClaude(transcript, { sessionId: "down", cwd: install.team, turns: [["user", "first"], ["assistant", "first answer"]] });

  target.down = true;
  const first = await hook("claude", transcript, install.env);
  assert.equal(first.status, 0, "the hook succeeds: the primary took the turn");
  assert.equal(primary.messages().length, 2);
  assert.equal(target.messages().length, 0);
  const spool = path.join(install.dataDir, "targets", "team", "spool", "claude", "pending");
  assert.equal((await pendingFiles(spool)).length, 1, "the target's copy waits in its own spool");
  assert.equal((await pendingFiles(path.join(install.dataDir, "spool", "claude", "pending"))).length, 0, "the primary's spool is empty");

  target.down = false;
  await writeClaude(transcript, { sessionId: "down", cwd: install.team, turns: [["user", "first"], ["assistant", "first answer"], ["user", "second"]] });
  assert.equal((await hook("claude", transcript, install.env)).status, 0);
  assert.equal(primary.messages().length, 3);
  assert.equal(target.messages().length, 3, "the target caught up on the next drain");
  assert.equal((await pendingFiles(spool)).length, 0);

  for (let run = 0; run < 3; run += 1) assert.equal((await hook("claude", transcript, install.env)).status, 0);
  for (const server of [primary, target]) {
    const hashes = server.messages().map((message) => message.metadata.source_turn_hash);
    assert.equal(hashes.length, 3);
    assert.equal(new Set(hashes).size, 3, "no duplicates");
  }

  // The target's own dedupe state, apart from the primary's.
  const targetState = JSON.parse(await fsp.readFile(path.join(install.dataDir, "targets", "team", "state", "claude.json"), "utf8"));
  assert.equal(targetState.sessions["claude-down"].imported_hashes.length, 3);
  const primaryState = JSON.parse(await fsp.readFile(path.join(install.dataDir, "state", "claude.json"), "utf8"));
  assert.equal(primaryState.sessions["claude-down"].imported_hashes.length, 3);
});

test("a target's secrets are refused on the command line and never printed", async (t) => {
  const primary = await fakeHoncho();
  const target = await fakeHoncho();
  t.after(() => { primary.server.close(); target.server.close(); });
  const install = await makeInstall(t, primary);

  for (const flag of ["--api-token", "--token", "--access-client-id", "--access-client-secret", "--token=inline-value-on-argv"]) {
    const args = ["target", "add", "team", "--url", target.url, "--folders", install.team, flag];
    if (!flag.includes("=")) args.push("value-on-the-command-line");
    const result = await cli(args, install.env);
    assert.equal(result.body.ok, false, flag);
    assert.match(result.body.issues.join(" "), /HONCHO_TARGET_API_TOKEN/, flag);
    assert.equal(result.text.includes("value-on-the-command-line") || result.text.includes("inline-value-on-argv"), false, flag);
  }
  assert.equal(JSON.parse(await fsp.readFile(install.configPath, "utf8")).targets, undefined, "nothing was saved");

  const half = await addTarget(install, target, [], { HONCHO_TARGET_CF_ACCESS_CLIENT_ID: ACCESS_ID });
  assert.equal(half.body.ok, false, "half an Access service token is refused");

  const added = await addTarget(install, target, [], {
    HONCHO_TARGET_CF_ACCESS_CLIENT_ID: ACCESS_ID,
    HONCHO_TARGET_CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
  });
  assert.equal(added.body.ok, true, added.text);
  const health = target.requests.find((entry) => entry.path === "/health");
  assert.equal(health.headers["cf-access-client-id"], ACCESS_ID, "the service token is sent to the target");

  const saved = JSON.parse(await fsp.readFile(install.configPath, "utf8"));
  assert.equal(saved.targets[0].honcho.apiToken, TARGET_TOKEN);
  assert.deepEqual(saved.targets[0].honcho.access, { clientId: ACCESS_ID, clientSecret: ACCESS_SECRET });
  if (process.platform !== "win32") assert.equal((await fsp.stat(install.configPath)).mode & 0o077, 0);

  const set = await cli(["target", "set", "team", "--api-token", "value-on-the-command-line"], install.env);
  assert.equal(set.body.ok, false);

  const outputs = [
    added,
    await cli(["target", "list"], install.env),
    await cli(["target", "test", "team"], install.env),
    await cli(["target", "set", "team", "--label", "Company"], install.env),
    await cli(["setup", "plan"], install.env),
    await cli(["doctor"], install.env),
  ];
  for (const output of outputs) {
    for (const secret of [TARGET_TOKEN, ACCESS_ID, ACCESS_SECRET]) assert.equal(output.text.includes(secret), false, output.text);
  }
  const [listed] = outputs[1].body.targets;
  assert.equal(listed.hasToken, true);
  assert.equal(listed.hasAccess, true);
  assert.equal(outputs[2].body.ok, true, "target test reads the target's workspace");
  const doctorCheck = outputs[5].body.checks.find((check) => check.name === "target-team");
  assert.equal(doctorCheck.ok, true);

  // setup rebuilds config.json and must keep the target.
  const reapplied = await cli(["setup", "plan"], install.env);
  assert.equal(reapplied.body.config.targets[0].id, "team");

  const removed = await cli(["target", "remove", "team"], install.env);
  assert.equal(removed.body.ok, true);
  assert.deepEqual(JSON.parse(await fsp.readFile(install.configPath, "utf8")).targets, []);
});

test("a target that refuses the token, or is not answering, is not saved", async (t) => {
  const primary = await fakeHoncho();
  t.after(() => primary.server.close());
  const locked = http.createServer((request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ detail: "unauthorized" }));
  });
  await new Promise((resolve) => locked.listen(0, "127.0.0.1", resolve));
  t.after(() => locked.close());
  const install = await makeInstall(t, primary);

  const refused = await addTarget(install, { url: `http://127.0.0.1:${locked.address().port}` });
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.issues[0], /rejected the API token/);
  const unreachable = await addTarget(install, { url: "http://127.0.0.1:9" });
  assert.equal(unreachable.body.ok, false);
  const insecure = await addTarget(install, { url: "http://memory.example.com" });
  assert.match(insecure.body.issues.join(" "), /https/);
  const missing = await cli(["target", "add", "team", "--url", primary.url.replace("127.0.0.1", "localhost"), "--folders", path.join(install.work, "not-there")], install.env);
  assert.equal(missing.body.ok, true, missing.text);
  assert.match(missing.body.warnings.join(" "), /does not exist/, "a folder that does not exist yet is a warning");
  const relative = await cli(["target", "add", "other", "--url", primary.url, "--folders", "relative/dir"], install.env);
  assert.equal(relative.body.ok, false);
  assert.equal(JSON.parse(await fsp.readFile(install.configPath, "utf8")).targets.length, 1);
});

test("a ChatGPT import never reaches a target", async (t) => {
  const target = await fakeHoncho();
  t.after(() => target.server.close());
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-target-chatgpt-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const exportFile = path.join(directory, "conversations.json");
  await fsp.writeFile(exportFile, JSON.stringify([{
    conversation_id: "conv-1",
    title: "web chat",
    create_time: 1_700_000_000,
    current_node: "a1",
    mapping: {
      root: { id: "root", parent: null, children: [], message: null },
      u1: { id: "u1", parent: "root", children: [], message: { id: "u1", author: { role: "user" }, create_time: 1_700_000_000, content: { content_type: "text", parts: ["web question"] } } },
      a1: { id: "a1", parent: "u1", children: [], message: { id: "a1", author: { role: "assistant" }, create_time: 1_700_000_001, content: { content_type: "text", parts: ["web answer"] } } },
    },
  }]));
  const config = { version: 1, user: { peerId: "user_test" }, honcho: { baseUrl: "http://127.0.0.1:9", workspaceId: "memory" }, agents: { codex: true, claude: true }, paths: { dataDir: directory } };
  const targetConfig = { id: "team", honcho: { baseUrl: target.url, workspaceId: "memory" }, folders: ["/"], enabled: true };
  const env = targetEnvironment(config, targetConfig, "chatgpt", cleanEnvironment());
  const { stdout } = await execFileAsync(process.execPath, [COLLECTOR, "--provider", "chatgpt", "--export", exportFile], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.match(result.skipped, /never go to another server/);
  assert.equal(target.requests.length, 0, "not even a folder of / lets a ChatGPT conversation through");
});

test("backfill sends only in-folder sessions since the date, in resumable runs, and sends nothing twice", async (t) => {
  const primary = await fakeHoncho();
  const target = await fakeHoncho();
  t.after(() => { primary.server.close(); target.server.close(); });
  const install = await makeInstall(t, primary);
  assert.equal((await addTarget(install, target)).body.ok, true);

  const sessions = path.join(install.home, ".codex", "sessions", "2026");
  const projects = path.join(install.home, ".claude", "projects");
  const files = {
    old: [path.join(sessions, "08", "01", "rollout-old.jsonl"), "codex", "old-inside", install.team, "2026-08-01T12:00:00"],
    outside: [path.join(sessions, "09", "10", "rollout-outside.jsonl"), "codex", "new-outside", install.teammate, "2026-09-10T12:00:00"],
    codex: [path.join(sessions, "09", "15", "rollout-inside.jsonl"), "codex", "new-inside", path.join(install.team, "web"), "2026-09-15T12:00:00"],
    claude: [path.join(projects, "team", "inside.jsonl"), "claude", "claude-new", install.team, "2026-09-20T12:00:00"],
    subagent: [path.join(projects, "team", "claude-new", "subagents", "agent-1.jsonl"), "claude", "subagent", install.team, "2026-09-21T12:00:00"],
  };
  for (const [file, provider, sessionId, cwd, when] of Object.values(files)) {
    const write = provider === "codex" ? writeCodex : writeClaude;
    await write(file, { sessionId, cwd, turns: [["user", `${sessionId} question`], ["assistant", `${sessionId} answer`]] });
    const stamp = new Date(when);
    await fsp.utimes(file, stamp, stamp);
  }

  const bad = await cli(["target", "backfill", "team", "--since", "2026-02-30"], install.env);
  assert.equal(bad.body.ok, false);

  const firstRun = await cli(["target", "backfill", "team", "--since", "2026-09-01", "--limit", "2"], install.env);
  assert.equal(firstRun.body.ok, true, firstRun.text);
  assert.equal(firstRun.body.considered, 3, "the old session and the subagent transcript are not candidates");
  assert.equal(firstRun.body.examined, 2);
  assert.equal(firstRun.body.remaining, 1);
  assert.equal(firstRun.body.outside_folders, 1);
  assert.equal(firstRun.body.sent_sessions, 1);
  assert.deepEqual(target.sessionIds(), ["codex-new-inside"]);

  const secondRun = await cli(["target", "backfill", "team", "--since", "2026-09-01"], install.env);
  assert.equal(secondRun.body.considered, 1, "the run carries on where the last one stopped");
  assert.equal(secondRun.body.sent_sessions, 1);
  assert.deepEqual(target.sessionIds(), ["claude-claude-new", "codex-new-inside"]);
  assert.equal(target.touched("codex-new-outside"), false);
  assert.equal(target.touched("codex-old-inside"), false);
  assert.equal(primary.requests.some((entry) => entry.path.endsWith("/messages")), false, "backfill is for the target only");

  const writes = target.requests.filter((entry) => entry.path.endsWith("/messages")).length;
  const again = await cli(["target", "backfill", "team", "--since", "2026-09-01"], install.env);
  assert.equal(again.body.considered, 0);
  assert.equal(again.body.new_messages, 0);
  // Even with its progress file gone, the importer's own state sends nothing twice.
  await fsp.rm(path.join(install.dataDir, "targets", "team", "backfill.json"));
  const fresh = await cli(["target", "backfill", "team", "--since", "2026-09-01"], install.env);
  assert.equal(fresh.body.new_messages, 0);
  assert.equal(target.requests.filter((entry) => entry.path.endsWith("/messages")).length, writes);
  assert.equal(target.messages().length, 4);
});

test("the app's target routes pass secrets through the environment, never the arguments", async (t) => {
  const invocation = targetInvocation("add", {
    id: "team",
    url: " https://memory.example.com ",
    folders: ["/work/team", "--not-an-option"],
    label: "Company",
    agents: { claude: true, codex: false },
    apiToken: ` ${TARGET_TOKEN} `,
    accessClientId: ACCESS_ID,
    accessClientSecret: ACCESS_SECRET,
  });
  assert.deepEqual(invocation.args, [
    "target", "add", "team",
    "--url=https://memory.example.com",
    "--folders=/work/team,--not-an-option",
    "--label=Company",
    "--agents=claude",
  ]);
  for (const secret of [TARGET_TOKEN, ACCESS_ID, ACCESS_SECRET]) assert.equal(JSON.stringify(invocation.args).includes(secret), false);
  assert.equal(invocation.env.HONCHO_TARGET_API_TOKEN, TARGET_TOKEN);
  assert.equal(invocation.env.HONCHO_TARGET_CF_ACCESS_CLIENT_ID, ACCESS_ID);
  assert.equal(invocation.env.HONCHO_TARGET_CF_ACCESS_CLIENT_SECRET, ACCESS_SECRET);
  assert.equal(targetInvocation("add", { id: "--evil" }), null, "an id that is not a slug never reaches the command line");
  assert.deepEqual(targetInvocation("set", { id: "team", enabled: false, folders: "/a,/b" }).args, ["target", "set", "team", "--folders=/a,/b", "--enabled=false"]);
  assert.deepEqual(targetInvocation("backfill", { id: "team", since: "2026-09-01; rm -rf /", limit: 5 }).args, ["target", "backfill", "team", "--limit=5"]);

  // End to end through the app: the token typed into the form reaches the target.
  const primary = await fakeHoncho();
  const target = await fakeHoncho();
  t.after(() => { primary.server.close(); target.server.close(); });
  const install = await makeInstall(t, primary);
  const saved = {};
  for (const name of ["HONCHO_AGENT_BRIDGE_HOME", "HONCHO_AGENT_BRIDGE_USER_HOME", "HONCHO_AGENT_BRIDGE_CONFIG", "HONCHO_TARGET_API_TOKEN"]) saved[name] = process.env[name];
  delete process.env.HONCHO_AGENT_BRIDGE_CONFIG;
  process.env.HONCHO_AGENT_BRIDGE_HOME = install.appHome;
  process.env.HONCHO_AGENT_BRIDGE_USER_HOME = install.home;
  process.env.HONCHO_TARGET_API_TOKEN = "inherited-token-must-not-be-used";
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const ui = createUiServer();
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => ui.close(() => resolve())));
  const port = ui.address().port;
  const send = (pathname, method = "GET", body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: { host: `127.0.0.1:${port}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text, body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject);
    request.end(payload);
  });

  assert.equal((await send("/api/targets/add")).status, 405, "changes are POST only");
  const added = await send("/api/targets/add", "POST", { id: "team", url: target.url, folders: [install.team], apiToken: TARGET_TOKEN });
  assert.equal(added.body.ok, true, added.text);
  assert.equal(added.text.includes(TARGET_TOKEN), false);
  assert.equal(target.requests.find((entry) => entry.path === "/health").headers.authorization, `Bearer ${TARGET_TOKEN}`);
  const listed = await send("/api/targets");
  assert.equal(listed.body.targets[0].hasToken, true);
  assert.equal(listed.text.includes(TARGET_TOKEN), false);
  const turnedOff = await send("/api/targets/set", "POST", { id: "team", enabled: false });
  assert.equal(turnedOff.body.target.enabled, false);
  const config = JSON.parse(await fsp.readFile(install.configPath, "utf8"));
  assert.equal(config.targets[0].honcho.apiToken, TARGET_TOKEN, "set kept the token and took no inherited one");
});
