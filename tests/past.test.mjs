// 지난 대화 (past.mjs): the conversations from before this computer collected go into
// its own memory server in the order they started. What matters: the same
// conversation found in two places goes in once, from the larger copy; one the
// server holds stays out unless a copy here has turns it lacks, and then only those
// go; one older than the server's newest is late and can be left out; new turns
// wait while the run goes and follow it, never sent twice; and a stop, a server that
// stops answering or a file that cannot be read leaves the rest to carry on.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { originalName, outcomeOf, storeSpec } from "../scripts/past.mjs";
import { doneCount, lateLine } from "../ui/lib/past.js";
import { fixtureEntries, makeZip } from "./chatgpt-fixture.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");

/** A Honcho that keeps sessions and messages as the real one does, as far as the collector and past.mjs ask. */
async function fakeHoncho() {
  const state = { requests: [], sessions: new Map(), created: [], fail: null, onWrite: null };
  let nextId = 1;
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(request.url, "http://h");
    state.requests.push({ method: request.method, path: url.pathname, body });
    response.setHeader("content-type", "application/json");
    const send = (value, status = 200) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    // `fail` answers a status for the requests the server should refuse: 503 when it says only that.
    const failed = state.fail?.(url.pathname);
    if (failed) return send({ detail: "refused" }, failed === true ? 503 : failed);
    const page = (items) => {
      const number = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("size") || 50);
      const ordered = url.searchParams.get("reverse") === "true" ? [...items].reverse() : items;
      return { items: ordered.slice((number - 1) * size, number * size), total: items.length, page: number, size };
    };
    const messages = /^\/v3\/workspaces\/[^/]+\/sessions\/([^/]+)\/messages(\/list)?$/.exec(url.pathname);
    if (messages) {
      const id = decodeURIComponent(messages[1]);
      const session = state.sessions.get(id);
      if (messages[2]) return send(page(session?.messages || []));
      if (!session) return send({ detail: "no such session" }, 404);
      const added = body.messages.map((message) => ({
        ...message,
        id: nextId++,
        session_id: id,
        created_at: message.created_at || new Date((clock += 1000)).toISOString(),
      }));
      session.messages.push(...added);
      await state.onWrite?.(id);
      return send(added);
    }
    if (/^\/v3\/workspaces\/[^/]+\/sessions\/list$/.test(url.pathname)) {
      const wanted = body?.filters?.id?.in;
      const listed = [...state.sessions.values()].filter((session) => !wanted || wanted.includes(session.id));
      return send(page(listed.map(({ id, metadata, created_at }) => ({ id, metadata, created_at, is_active: true }))));
    }
    if (/^\/v3\/workspaces\/[^/]+\/sessions$/.test(url.pathname)) {
      const existing = state.sessions.get(body.id);
      // Honcho takes the metadata given in place of what the session had.
      if (existing) existing.metadata = body.metadata || {};
      else {
        state.sessions.set(body.id, { id: body.id, metadata: body.metadata || {}, created_at: new Date((clock += 1000)).toISOString(), messages: [] });
        state.created.push(body.id);
      }
      return send({ id: body.id, metadata: body.metadata || {} });
    }
    return send({ ok: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.server = server;
  state.texts = (id) => (state.sessions.get(id)?.messages || []).map((message) => message.content);
  state.writes = () => state.requests.filter((entry) => /\/messages$/.test(entry.path)).length;
  // The time each session's first message says, in the order the sessions were made.
  state.starts = () => state.created.map((id) => state.sessions.get(id).messages[0]?.created_at).filter(Boolean);
  return state;
}

function cleanEnvironment(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(HONCHO_|CF_ACCESS_|CODEX_|CLAUDE_)/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

async function makeInstall(t, honcho, extra = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-past-")));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const appHome = path.join(root, "app");
  const dataDir = path.join(appHome, "data");
  const team = path.join(root, "work", "team");
  for (const directory of [home, appHome, team]) await fsp.mkdir(directory, { recursive: true });
  const config = {
    version: 1,
    user: { peerId: "user_test" },
    honcho: { baseUrl: honcho.url, workspaceId: "memory" },
    agents: { codex: true, claude: true },
    sources: { codex: { root: path.join(home, ".codex", "sessions") } },
    paths: { dataDir },
    ...extra,
  };
  await fsp.writeFile(path.join(appHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const env = cleanEnvironment({
    HONCHO_AGENT_BRIDGE_HOME: appHome,
    HONCHO_AGENT_BRIDGE_USER_HOME: home,
    HOME: home,
    USERPROFILE: home,
    HONCHO_CODEX_NETWORK_MODE: "internal",
  });
  return { root, home, appHome, dataDir, team, env, past: path.join(dataDir, "past") };
}

async function cli(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env, maxBuffer: 16 * 1024 * 1024 });
    return { status: 0, text: stdout, body: JSON.parse(stdout) };
  } catch (error) {
    return { status: error.code, text: `${error.stdout || ""}${error.stderr || ""}`, body: error.stdout ? JSON.parse(error.stdout) : null };
  }
}

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

async function until(check, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out");
}

/** `count` turns a second apart from `iso`, the user first. */
function turns(text, iso, count = 2) {
  return Array.from({ length: count }, (_, index) => [index % 2 ? "assistant" : "user", `${text} ${index + 1}`, new Date(Date.parse(iso) + index * 1000).toISOString()]);
}

async function writeClaude(file, { sessionId, cwd, turns: rows }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const records = rows.map(([role, text, at], index) => ({
    uuid: `${sessionId}-${index + 1}`,
    sessionId,
    cwd,
    timestamp: at,
    message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
  }));
  await fsp.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function writeCodex(file, { sessionId, cwd, turns: rows }) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const records = [
    { type: "session_meta", timestamp: rows[0][2], payload: { id: sessionId, timestamp: rows[0][2], source: "cli", originator: "codex_cli_rs", cwd } },
    ...rows.map(([role, text, at]) => ({
      type: "response_item",
      timestamp: at,
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    })),
  ];
  await fsp.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const claudeFile = (install, name) => path.join(install.home, ".claude", "projects", "-work-team", `${name}.jsonl`);

/** Reads the places as setup's 지난 대화 step does, and waits until it has. */
async function scan(install, store = null) {
  const asked = await cli(["past", "scan", ...(store ? [`--store=${JSON.stringify(store)}`] : [])], install.env);
  assert.equal(asked.body?.ok, true, asked.text);
  return until(async () => {
    const status = (await cli(["past", "scan-status"], install.env)).body;
    const storeRead = !store || ["done", "error"].includes(status?.store?.state);
    return status && !status.running && status.here?.state === "done" && storeRead ? status : null;
  });
}

async function ledger(install) {
  const text = await fsp.readFile(path.join(install.past, "ledger.jsonl"), "utf8").catch(() => "");
  const entries = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    entries.set(entry.k, entry);
  }
  return entries;
}

test("a store copy keeps its own name, a store is named whole, and a collector's answer says what became of the conversation", () => {
  assert.equal(originalName("/s/대화/claude/2025/01/01/abc.mac-1a2b3c.jsonl"), "abc.jsonl");
  assert.equal(originalName("/s/대화/codex/2025/01/01/rollout-2025-01-01T10-00-00-abc.jsonl"), "rollout-2025-01-01T10-00-00-abc.jsonl");
  assert.deepEqual(storeSpec({ kind: "folder", path: "/Volumes/Backup/" }), { kind: "folder", path: "/Volumes/Backup" });
  assert.equal(storeSpec({ kind: "folder", path: "relative/path" }), null);
  assert.deepEqual(storeSpec({ kind: "cloud", remote: "gdrive", path: "/백업/" }), { kind: "cloud", remote: "gdrive", path: "백업" });
  assert.equal(storeSpec({ kind: "cloud", remote: "gdrive", path: "a/../b" }), null);
  assert.equal(storeSpec({ kind: "cloud", remote: "-x", path: "" }), null, "a remote is never read as an option");

  assert.deepEqual(outcomeOf({ ok: true, new_messages: 4 }), { o: "sent", messages: 4 });
  assert.deepEqual(outcomeOf({ ok: true, skipped: "no conversation" }), { o: "empty" });
  assert.deepEqual(outcomeOf({ ok: true, skipped: "automation" }), { o: "left", r: "automation" });
  assert.equal(outcomeOf({ ok: false, error: "HTTP 503 for /v3/x" }).r, "unreachable");
  assert.equal(outcomeOf({ ok: false, error: "fetch failed" }).r, "unreachable");
  assert.equal(outcomeOf({ ok: false, error: "HTTP 401 for /v3/x" }).r, "refused");
  assert.equal(outcomeOf({ ok: false, error: "HTTP 422 for /v3/x" }).r, "refused");
  assert.equal(outcomeOf({ ok: false, error: "transcript not found: /x" }).r, "unreadable");
});

test("the collector's --serve takes one conversation a line, answers each in order, and keeps no state file", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  const first = claudeFile(install, "one");
  await writeClaude(first, { sessionId: "one", cwd: install.team, turns: turns("one", "2025-02-01T10:00:00Z") });
  const state = path.join(install.dataDir, "state");
  const child = spawn(process.execPath, [COLLECTOR, "--serve"], {
    env: {
      ...install.env,
      HONCHO_BASE_URL: honcho.url,
      HONCHO_WORKSPACE_ID: "memory",
      HONCHO_USER_NAME: "user_test",
      HONCHO_AGENT_LOG_DIR: path.join(install.dataDir, "logs"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const answers = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async (item) => {
    child.stdin.write(`${JSON.stringify(item)}\n`);
    return JSON.parse((await answers.next()).value);
  };
  const sent = await ask({ provider: "claude", transcript: first, metadata: { imported_from: "test" } });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.new_messages, 2);
  assert.equal(honcho.sessions.get("claude-one").metadata.imported_from, "test", "metadata given with the item goes on the session");
  assert.equal(honcho.sessions.get("claude-one").metadata.last_turn_at, "2025-02-01T10:00:01.000Z", "the session says when its last turn was");
  const again = await ask({ provider: "claude", transcript: first });
  assert.equal(again.new_messages, 0, "what the server holds is read back from it, not from a state file");
  const missing = await ask({ provider: "claude", transcript: path.join(install.root, "gone.jsonl") });
  assert.equal(missing.ok, false);
  const wrong = await ask({ provider: "nobody" });
  assert.match(wrong.error, /unsupported provider/);
  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));
  await assert.rejects(fsp.access(path.join(state, "claude.json")), "no state file was written");
  await assert.rejects(fsp.access(path.join(install.home, ".hermes")), "nor one where a hook without a configuration keeps it");
  assert.match(await fsp.readFile(path.join(install.dataDir, "logs", "claude.log"), "utf8"), /claude-one/);
});

test("past conversations go in the order they started, and one found in two places goes in once, from the larger copy", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  await writeClaude(claudeFile(install, "h-old"), { sessionId: "h-old", cwd: install.team, turns: turns("old here", "2024-05-01T10:00:00Z") });
  await writeClaude(claudeFile(install, "shared"), { sessionId: "shared", cwd: install.team, turns: turns("shared", "2025-01-01T10:00:00Z") });
  await writeCodex(path.join(install.home, ".codex", "sessions", "2024", "08", "01", "rollout-2024-08-01T10-00-00-cx.jsonl"), {
    sessionId: "cx", cwd: path.join(install.team, "api"), turns: turns("codex", "2024-08-01T10:00:00Z"),
  });

  // The backup store: the same conversation as another computer kept it, longer and
  // under its device-tagged name; one only there, from a Windows PC; and what the
  // store keeps aside, which is never read.
  const store = path.join(install.root, "backup");
  const day = (agent, date) => path.join(store, "대화", agent, ...date.split("-"));
  await writeClaude(path.join(day("claude", "2025-01-01"), "shared.jsonl"), { sessionId: "shared", cwd: install.team, turns: turns("shared", "2025-01-01T10:00:00Z") });
  await writeClaude(path.join(day("claude", "2025-01-01"), "shared.mac-1a2b3c.jsonl"), { sessionId: "shared", cwd: install.team, turns: turns("shared", "2025-01-01T10:00:00Z", 4) });
  await writeClaude(path.join(day("claude", "2023-03-01"), "s-oldest.jsonl"), { sessionId: "s-oldest", cwd: "C:\\Users\\me\\proj", turns: turns("oldest", "2023-03-01T10:00:00Z") });
  await writeClaude(path.join(store, "대화", "claude", "_아카이브", "2022", "01", "01", "archived.jsonl"), { sessionId: "archived", cwd: install.team, turns: turns("archived", "2022-01-01T10:00:00Z") });
  await fsp.mkdir(path.join(store, "대화", "claude", "_부속자료", "mac-mini"), { recursive: true });

  const spec = { kind: "folder", path: store };
  const read = await scan(install, spec);
  assert.equal(read.here.count, 3);
  assert.equal(read.store.count, 2, "two conversations: the copies of one count once, the archive not at all");
  assert.deepEqual(read.store.devices, ["mac-mini"]);
  assert.equal(new Date(read.store.first).toISOString(), "2023-03-01T10:00:00.000Z");

  // A ChatGPT export: one file per account.
  const zip = path.join(install.root, "chatgpt-export.zip");
  await fsp.writeFile(zip, makeZip(fixtureEntries()));
  const added = await cli(["past", "chatgpt-add", `--file=${zip}`, "--name=chatgpt-export.zip"], install.env);
  assert.equal(added.body.ok, true, added.text);
  assert.equal(added.body.file.account, "someone@example.invalid");
  const id = added.body.file.id;
  assert.ok(added.body.file.conversations >= 4);

  const overview = await cli(["past", "overview", `--store=${JSON.stringify(spec)}`, `--chatgpt=${id}`], install.env);
  assert.equal(overview.body.ok, true, overview.text);
  assert.equal(overview.body.server.reachable, true);
  assert.equal(overview.body.server.total, 0);
  const windows = overview.body.projects.find((project) => project.path === "C:\\Users\\me\\proj");
  assert.equal(windows.storeOnly, true, "a folder only the store knows says so");
  assert.equal(windows.name, "proj");
  assert.equal(windows.display, "C:\\Users\\me\\proj", "another computer's folder keeps its whole path; only this computer's home reads as ~");
  assert.equal(overview.body.projects.reduce((sum, project) => sum + project.dupes, 0), 1);
  assert.equal(overview.body.chatgpt[0].account, "someone@example.invalid");

  const plan = await cli(["past", "plan", `--store=${JSON.stringify(spec)}`, `--chatgpt=${id}`], install.env);
  assert.equal(plan.body.ok, true, plan.text);
  assert.equal(plan.body.dupes, 1);
  assert.equal(plan.body.total, 4 + added.body.file.conversations);
  const run = await cli(["past", "run"], install.env);
  assert.equal(run.body.ok, true, run.text);
  assert.equal(run.body.failed, 0);

  const starts = honcho.starts();
  assert.equal(starts.length, plan.body.total);
  assert.deepEqual(starts, [...starts].sort(), "each conversation went in after every one that started before it");
  assert.equal(honcho.created[0], "claude-s-oldest");
  assert.deepEqual(honcho.texts("claude-shared"), ["shared 1", "shared 2", "shared 3", "shared 4"], "the larger copy, once");
  assert.ok(!honcho.created.includes("claude-archived"));
  const chatgpt = honcho.created.filter((session) => session.startsWith("chatgpt-"));
  assert.ok(chatgpt.length >= 4);
  for (const session of chatgpt) assert.equal(honcho.sessions.get(session).metadata.chatgpt_account, "someone@example.invalid");
  await assert.rejects(fsp.access(path.join(install.dataDir, "state", "claude.json")), "the run kept no state file");

  const status = (await cli(["past", "status"], install.env)).body;
  const byPlace = Object.fromEntries(status.sources.map((row) => [row.kind, row]));
  assert.equal(byPlace.here.conversations, 3);
  assert.equal(byPlace.here.dupes, 1, "the copy here was the same as the store's");
  assert.equal(byPlace.store.stacked, 2);
  assert.equal(byPlace.chatgpt.account, "someone@example.invalid");
  assert.equal(status.order.first, Date.parse("2023-03-01T10:00:00Z"));
  assert.equal(status.holding, false, "the hold went when the run ended");

  // Nothing goes twice: a second plan finds everything put in already.
  const writes = honcho.writes();
  const again = await cli(["past", "plan", `--store=${JSON.stringify(spec)}`, `--chatgpt=${id}`], install.env);
  assert.equal(again.body.total, 0);
  assert.equal((await cli(["past", "run"], install.env)).body.done, 0);
  assert.equal(honcho.writes(), writes);

  // A file once put in stays; the newer export of the same account takes the old one's place.
  const refused = await cli(["past", "chatgpt-drop", `--id=${id}`], install.env);
  assert.equal(refused.body.ok, false);
  await fsp.writeFile(zip, makeZip(fixtureEntries({ continued: true })));
  const newer = await cli(["past", "chatgpt-add", `--file=${zip}`, "--name=chatgpt-export.zip"], install.env);
  assert.equal(newer.body.file.id, id);
  assert.equal(newer.body.file.conversations, added.body.file.conversations + 1);
  const files = (await cli(["past", "scan-status"], install.env)).body.chatgpt;
  assert.equal(files.length, 1);
  assert.equal(files[0].applied, true);
});

test("a conversation starts with its first message, not its first line: one opened with /clear or injected context waits for the one that spoke first, and one with no message at all is not offered", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  const lines = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const claude = (sessionId, at, role, content, extra = {}) => ({ uuid: `${sessionId}-${at}`, sessionId, cwd: install.team, timestamp: at, message: { role, content }, ...extra });
  // Opened at 10:00 with /clear and its caveat; the person speaks at 10:02.
  await fsp.mkdir(path.dirname(claudeFile(install, "a")), { recursive: true });
  await fsp.writeFile(claudeFile(install, "a"), lines([
    claude("a", "2026-09-28T10:00:00.000Z", "user", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    claude("a", "2026-09-28T10:00:00.100Z", "user", "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>", { isMeta: true }),
    claude("a", "2026-09-28T10:02:00.000Z", "user", "a speaks"),
    claude("a", "2026-09-28T10:02:05.000Z", "assistant", [{ type: "text", text: "a answers" }]),
  ]));
  // Opened and spoken in at 10:01.
  await writeClaude(claudeFile(install, "b"), { sessionId: "b", cwd: install.team, turns: turns("b speaks", "2026-09-28T10:01:00Z") });
  // Opened with /clear at 09:30 and left: nothing in it the collector makes a message of.
  await fsp.writeFile(claudeFile(install, "e"), lines([
    claude("e", "2026-09-28T09:30:00.000Z", "user", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    claude("e", "2026-09-28T09:30:00.100Z", "user", "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>", { isMeta: true }),
  ]));
  // A Codex session whose first user item is the context Codex injects (09:00); the person types at 09:10.
  const meta = (id, at) => ({ type: "session_meta", timestamp: at, payload: { id, timestamp: at, source: "cli", originator: "codex_cli_rs", cwd: install.team } });
  const item = (at, role, text) => ({ type: "response_item", timestamp: at, payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  const rollout = (name) => path.join(install.home, ".codex", "sessions", "2026", "09", "28", name);
  await fsp.mkdir(path.dirname(rollout("x")), { recursive: true });
  await fsp.writeFile(rollout("rollout-2026-09-28T09-00-00-c1.jsonl"), lines([
    meta("c1", "2026-09-28T09:00:00.000Z"),
    item("2026-09-28T09:00:00.100Z", "user", "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>"),
    item("2026-09-28T09:10:00.000Z", "user", "c1 speaks"),
    item("2026-09-28T09:10:05.000Z", "assistant", "c1 answers"),
  ]));
  await writeCodex(rollout("rollout-2026-09-28T09-05-00-c2.jsonl"), { sessionId: "c2", cwd: install.team, turns: turns("c2 speaks", "2026-09-28T09:05:00Z") });

  const read = await scan(install);
  assert.equal(read.here.count, 4, "the one with no message is not counted");
  const plan = await cli(["past", "plan"], install.env);
  assert.equal(plan.body.ok, true, plan.text);
  assert.equal(plan.body.total, 4);
  const run = (await cli(["past", "run"], install.env)).body;
  assert.equal(run.failed, 0);
  assert.equal(run.done, 4);
  assert.equal(run.skipped, 0, "the one with no message is not even tried");
  assert.equal(doneCount(run), "4 / 4");
  assert.deepEqual(honcho.created, ["codex-c2", "codex-c1", "claude-b", "claude-a"]);
  const starts = honcho.starts();
  assert.deepEqual(starts, [...starts].sort(), "by the first message, each went in after every one that started before it");
});

test("a finished fill counts only the conversations there were to put in", () => {
  // Written before the run counted them: one had nothing in it to remember.
  assert.equal(doneCount({ total: 117, done: 117, sent: 116, failed: 0 }), "116 / 116");
  assert.equal(doneCount({ total: 26_083, done: 26_083, sent: 26_080, failed: 3, skipped: 0 }), "26,080 / 26,083");
  // Stopped part way: the ones not reached are still to put in.
  assert.equal(doneCount({ total: 100, done: 30, sent: 27, failed: 1, skipped: 2, cancelled: true }), "27 / 98");
});

test("기억 설정 says how many went in out of order and where to put them back", () => {
  // 더 가져오기 put 13 older ones in after the server's newest (the MacBook, 2026-10-10).
  const line = lateLine(13);
  assert.match(line, /^어긋난 대화 13개는 시간순보다 하루 넘게 늦게 들어왔습니다\./);
  assert.match(line, /서버 → 기억 서버에서 처음부터 다시 정리를 누르세요\.$/);
  assert.match(lateLine(26_083), /어긋난 대화 26,083개/);
  // In order, or not counted: nothing is said.
  for (const none of [0, null, undefined, "0"]) assert.equal(lateLine(none), "");
});

test("a store being read stops, rclone and all, when another is picked, and the one picked is read", { skip: process.platform === "win32" }, async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  // An rclone that lists as slowly as a whole cloud drive would: it notes its pid and waits a minute.
  const bin = path.join(os.tmpdir(), `past-slow-rclone-${process.pid}-${Date.now()}`);
  await fsp.mkdir(bin, { recursive: true });
  t.after(() => fsp.rm(bin, { recursive: true, force: true }));
  const pidFile = path.join(bin, "pid");
  await fsp.writeFile(path.join(bin, "rclone"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 });
  const install = await makeInstall(t, honcho);
  install.env.RCLONE_BIN = path.join(bin, "rclone");
  const store = path.join(install.root, "backup");
  await writeClaude(path.join(store, "대화", "claude", "2025", "01", "01", "s1.jsonl"), { sessionId: "s1", cwd: install.team, turns: turns("one", "2025-01-01T10:00:00Z") });

  const started = Date.now();
  assert.equal((await cli(["past", "scan", `--store=${JSON.stringify({ kind: "cloud", remote: "drive", path: "" })}`], install.env)).body?.ok, true);
  const pid = Number(await until(() => fsp.readFile(pidFile, "utf8").catch(() => ""), 15_000));
  const folder = { kind: "folder", path: store };
  const read = await scan(install, folder);
  assert.ok(Date.now() - started < 30_000, "the picked store did not wait for the slow one");
  assert.deepEqual(read.store.spec, folder);
  assert.equal(read.store.state, "done");
  assert.equal(read.store.count, 1);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the slow rclone was stopped");
});

test("a conversation on the server stays out unless a copy here has turns after its last, and a late one can be left out", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  const known = claudeFile(install, "known");
  await writeClaude(known, { sessionId: "known", cwd: install.team, turns: turns("known", "2025-05-01T10:00:00Z") });
  await writeClaude(claudeFile(install, "same"), { sessionId: "same", cwd: install.team, turns: turns("same", "2025-06-01T10:00:00Z") });
  await scan(install);
  assert.equal((await cli(["past", "plan"], install.env)).body.total, 2);
  assert.equal((await cli(["past", "run"], install.env)).body.sent, 2);

  // An older collector's session: it says nothing of its last turn, so the run asks.
  honcho.sessions.set("claude-older", {
    id: "claude-older", metadata: {}, created_at: "2026-10-01T00:00:00Z",
    messages: [{ id: 900, content: "older 2", created_at: "2025-07-01T10:00:01.000Z", metadata: {} }],
  });
  await writeClaude(claudeFile(install, "older"), { sessionId: "older", cwd: install.team, turns: turns("older", "2025-07-01T10:00:00Z") });
  // The server's newest turn is now 2025-07-01. A store holds one from before it, and this computer one from after.
  await writeClaude(known, { sessionId: "known", cwd: install.team, turns: [...turns("known", "2025-05-01T10:00:00Z"), ...turns("known later", "2025-08-01T10:00:00Z")] });
  await writeClaude(claudeFile(install, "fresh"), { sessionId: "fresh", cwd: install.team, turns: turns("fresh", "2025-09-01T10:00:00Z") });
  const store = path.join(install.root, "backup");
  await writeClaude(path.join(store, "대화", "claude", "2025", "03", "01", "lateone.jsonl"), { sessionId: "lateone", cwd: install.team, turns: turns("late", "2025-03-01T10:00:00Z") });
  // Started three hours before the server's newest turn, as conversations held at the same time do: not late.
  await writeClaude(path.join(store, "대화", "claude", "2025", "07", "01", "sameday.jsonl"), { sessionId: "sameday", cwd: install.team, turns: turns("sameday", "2025-07-01T07:00:00Z") });
  const spec = { kind: "folder", path: store };
  await scan(install, spec);

  const overview = (await cli(["past", "overview", `--store=${JSON.stringify(spec)}`, "--fresh"], install.env)).body;
  assert.equal(overview.server.newest, Date.parse("2025-07-01T10:00:01Z"));
  const team = overview.projects.find((project) => project.count >= 5);
  assert.equal(team.late, 1);
  assert.equal(team.newer, 1);

  const plan = (await cli(["past", "plan", `--store=${JSON.stringify(spec)}`, "--late=skip"], install.env)).body;
  assert.equal(plan.ok, true);
  assert.equal(plan.already, 1, "the one that went in before and has nothing new");
  assert.equal(plan.newer, 1);
  assert.equal(plan.late, 1);
  assert.equal(plan.skippedLate, 1);
  assert.equal(plan.checks, 1);
  assert.equal(plan.put, 3);
  const run = (await cli(["past", "run"], install.env)).body;
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(honcho.texts("claude-known"), ["known 1", "known 2", "known later 1", "known later 2"], "only the turns the server lacked");
  assert.equal(honcho.texts("claude-older").length, 1, "the older collector's session was asked, and left as it was");
  assert.ok(honcho.sessions.has("claude-fresh"));
  assert.ok(honcho.sessions.has("claude-sameday"));
  assert.ok(!honcho.sessions.has("claude-lateone"));
  const entries = await ledger(install);
  assert.equal(entries.get("claude:claude-lateone").o, "late");
  assert.equal(entries.get("claude:claude-older").o, "server");

  // Asked again with the late ones in, it goes in after all.
  const included = (await cli(["past", "plan", `--store=${JSON.stringify(spec)}`], install.env)).body;
  assert.equal(included.total, 1);
  assert.equal((await cli(["past", "run"], install.env)).body.sent, 1);
  assert.ok(honcho.sessions.has("claude-lateone"));
});

test("new turns wait while the run goes and follow it, and none is sent twice", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  const live = claudeFile(install, "live");
  // A conversation a hook sent before setup: the hook's state holds it as read back from the server.
  await writeClaude(live, { sessionId: "live", cwd: install.team, turns: turns("live", "2025-03-01T10:00:00Z") });
  assert.equal((await hook("claude", live, install.env)).status, 0);
  assert.deepEqual(honcho.texts("claude-live"), ["live 1", "live 2"]);
  const stateFile = path.join(install.dataDir, "state", "claude.json");
  assert.ok(JSON.parse(await fsp.readFile(stateFile, "utf8")).sessions["claude-live"].reconciled_source_hashes_at);

  // Setup holds new turns from the moment its agents step is applied.
  assert.equal((await cli(["past", "hold"], install.env)).body.held, true);
  await writeClaude(live, { sessionId: "live", cwd: install.team, turns: [...turns("live", "2025-03-01T10:00:00Z"), ...turns("live more", "2025-03-02T10:00:00Z")] });
  await writeClaude(claudeFile(install, "past"), { sessionId: "past", cwd: install.team, turns: turns("past", "2024-01-01T10:00:00Z") });
  await scan(install);
  const plan = (await cli(["past", "plan"], install.env)).body;
  assert.equal(plan.total, 2);
  assert.equal(plan.newer, 1);
  // A turn of the live conversation, and a conversation begun after the plan: both wait.
  const after = claudeFile(install, "after");
  await writeClaude(after, { sessionId: "after", cwd: install.team, turns: turns("after", "2026-10-09T10:00:00Z") });
  assert.equal((await hook("claude", live, install.env)).status, 0);
  assert.equal((await hook("claude", after, install.env)).status, 0);
  assert.ok(!honcho.sessions.has("claude-after"), "held while the past conversations wait to go in");
  assert.equal(honcho.texts("claude-live").length, 2);
  const waiting = (await cli(["past", "status"], install.env)).body;
  assert.equal(waiting.holding, true);
  assert.equal(waiting.held.conversations, 2);

  const run = (await cli(["past", "run"], install.env)).body;
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.held.turns, 2);
  assert.equal(run.held.conversations, 2);
  assert.deepEqual(honcho.texts("claude-live"), ["live 1", "live 2", "live more 1", "live more 2"], "the held turn added nothing the run had sent");
  assert.deepEqual(honcho.created, ["claude-live", "claude-past", "claude-after"], "the held conversation went after the past ones");
  await assert.rejects(fsp.access(path.join(install.dataDir, "spool", "hold.json")), "the hold is gone");
  assert.equal(JSON.parse(await fsp.readFile(stateFile, "utf8")).sessions["claude-live"].reconciled_source_hashes_at !== undefined, true,
    "the hook read the session back from the server before it sent");
});

test("a stop ends the run after the conversation it is sending, and the next run carries on", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  for (const [name, iso] of [["a", "2024-01-01T10:00:00Z"], ["b", "2024-02-01T10:00:00Z"], ["c", "2024-03-01T10:00:00Z"]]) {
    await writeClaude(claudeFile(install, name), { sessionId: name, cwd: install.team, turns: turns(name, iso) });
  }
  await scan(install);
  assert.equal((await cli(["past", "plan"], install.env)).body.total, 3);
  const idle = (await cli(["past", "stop"], install.env)).body;
  assert.equal(idle.stopping, false, "nothing runs, so nothing is asked");

  const stopFile = path.join(install.past, "stop");
  honcho.onWrite = () => fsp.writeFile(stopFile, "{}");
  const stopped = (await cli(["past", "run"], install.env)).body;
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.done, 1);
  await assert.rejects(fsp.access(stopFile), "the run takes its stop away when it ends");
  await assert.rejects(fsp.access(path.join(install.dataDir, "spool", "hold.json")), "a stopped run lets new turns go");
  const status = (await cli(["past", "status"], install.env)).body;
  assert.equal(status.last.cancelled, true);
  assert.equal(status.sources[0].waiting, 2);

  honcho.onWrite = null;
  const rest = (await cli(["past", "run"], install.env)).body;
  assert.equal(rest.done, 2, "the next run takes only what the stopped one left");
  assert.deepEqual(honcho.created, ["claude-a", "claude-b", "claude-c"]);

  // While a run goes, stop leaves the file and the status says it is stopping.
  await fsp.writeFile(path.join(install.past, "status.json"), JSON.stringify({ version: 1, running: { pid: process.pid, total: 3, done: 1 } }));
  const asked = (await cli(["past", "stop"], install.env)).body;
  assert.equal(asked.stopping, true);
  const going = (await cli(["past", "status"], install.env)).body;
  assert.equal(going.running.pid, process.pid);
  assert.equal(going.stopping, true);
});

test("a server that stops answering keeps the turns held until the run carries on, and a failure can be tried again", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  for (const [index, name] of ["a", "b", "c", "d"].entries()) {
    await writeClaude(claudeFile(install, name), { sessionId: name, cwd: install.team, turns: turns(name, `2024-0${index + 1}-01T10:00:00Z`) });
  }
  await scan(install);
  assert.equal((await cli(["past", "plan"], install.env)).body.total, 4);
  // One file goes before its turn comes, the server refuses one conversation, and two it does not take.
  await fsp.rename(claudeFile(install, "a"), path.join(install.root, "a.jsonl"));
  honcho.fail = (pathname) => (/\/messages$/.test(pathname) ? (pathname.includes("claude-b") ? 422 : 503) : null);
  const first = (await cli(["past", "run"], install.env)).body;
  assert.equal(first.stopped, undefined, "two in a row: the server may still answer");
  assert.deepEqual(first.failures, { unreadable: 1, refused: 1, unreachable: 2 });

  // Two more, and now nothing is taken: three in a row and the run stops, keeping the hold for later.
  await writeClaude(claudeFile(install, "e"), { sessionId: "e", cwd: install.team, turns: turns("e", "2024-05-01T10:00:00Z") });
  await writeClaude(claudeFile(install, "f"), { sessionId: "f", cwd: install.team, turns: turns("f", "2024-06-01T10:00:00Z") });
  await scan(install);
  const plan = (await cli(["past", "plan"], install.env)).body;
  assert.equal(plan.total, 5, "b, c and d again (made on the server, but without their turns), e and f; a is gone");
  assert.equal(plan.checks, 3, "each was made on the server without its last turn, so the run asks");
  const gone = (await cli(["past", "status"], install.env)).body;
  assert.equal(gone.failures.unreadable, 0, "the file that went is no failure to try again");
  honcho.fail = (pathname) => /\/messages$/.test(pathname);
  const down = (await cli(["past", "run"], install.env)).body;
  assert.equal(down.stopped, "unreachable");
  assert.equal(down.done, 3);
  const hold = JSON.parse(await fsp.readFile(path.join(install.dataDir, "spool", "hold.json"), "utf8"));
  assert.ok(Array.isArray(hold.resume), "the hold keeps the command that carries the run on");
  assert.equal(hold.pid, null);
  assert.equal((await cli(["past", "status"], install.env)).body.holding, true);

  // Back up: the run carries on with what did not reach the server and what it had not got to.
  honcho.fail = null;
  const resumed = (await cli(["past", "run"], install.env)).body;
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.done, 5);
  assert.deepEqual(honcho.created.filter((id) => !honcho.texts(id).length), [], "every session made has its turns");
  await assert.rejects(fsp.access(path.join(install.dataDir, "spool", "hold.json")));

  // The file is back, and one more the server refuses: 다시 시도 sends it once the server takes it.
  await fsp.rename(path.join(install.root, "a.jsonl"), claudeFile(install, "a"));
  await writeClaude(claudeFile(install, "g"), { sessionId: "g", cwd: install.team, turns: turns("g", "2024-07-01T10:00:00Z") });
  await scan(install);
  assert.equal((await cli(["past", "plan"], install.env)).body.total, 2);
  honcho.fail = (pathname) => (/claude-g\/messages$/.test(pathname) ? 422 : null);
  const refused = (await cli(["past", "run"], install.env)).body;
  assert.equal(refused.sent, 1);
  assert.equal(refused.failures.refused, 1);
  honcho.fail = null;
  assert.equal((await cli(["past", "run"], install.env)).body.done, 0, "a run that is not a retry leaves what the server refused");
  const retried = (await cli(["past", "run", "--retry"], install.env)).body;
  assert.equal(retried.sent, 1);
  assert.equal((await cli(["past", "status"], install.env)).body.failures.total, 0);
  assert.ok(["claude-a", "claude-g"].every((id) => honcho.texts(id).length === 2));
});

test("a run started in the background answers at once and holds new turns from that moment", async (t) => {
  const honcho = await fakeHoncho();
  t.after(() => honcho.server.close());
  const install = await makeInstall(t, honcho);
  await writeClaude(claudeFile(install, "bg"), { sessionId: "bg", cwd: install.team, turns: turns("bg", "2024-01-01T10:00:00Z") });
  await scan(install);
  await cli(["past", "plan"], install.env);
  const started = (await cli(["past", "start"], install.env)).body;
  assert.equal(started.started, true);
  const flow = await until(async () => {
    const status = (await cli(["past", "status"], install.env)).body;
    return !status.running && status.last ? status : null;
  });
  assert.equal(flow.last.sent, 1);
  assert.ok(honcho.sessions.has("claude-bg"));
  assert.equal(flow.holding, false);
});
