// Grok CLI: its chat_history.jsonl parser, how a Stop hook payload finds that
// file, and the hook's run through main.mjs, the queue and the collector.
// Every session, path and message here is made up.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { parseTranscript, resolveTranscriptPath } from "../scripts/providers/grok.mjs";
import { turnHashCandidates } from "../scripts/turn-identity.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(ROOT, "scripts", "main.mjs");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");
const SESSION = "01a1b2c3-d4e5-7f60-8a1b-2c3d4e5f6a7b";
const CWD = "/tmp/grok-fixture-project";

const userQuery = (text, promptIndex) => ({ type: "user", prompt_index: promptIndex, content: [{ type: "text", text: `<user_query>\n${text}\n</user_query>` }] });

// The line shapes Grok CLI writes today (chat_format_version 1).
const HISTORY = [
  { type: "system", content: "You are Grok, a coding agent." },
  { type: "user", content: [{ type: "text", text: "<user_info>\nOS Version: macos\n</user_info>" }] },
  { type: "user", synthetic_reason: "system_reminder", content: [{ type: "text", text: "<system-reminder>\nskills list\n</system-reminder>" }] },
  userQuery("rename the config loader", 0),
  { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque", status: "completed" },
  { type: "assistant", content: "Looking at the loader first.", tool_calls: [{ id: "call_1", name: "read_file" }], model_id: "grok-fixture", reasoning_effort: "high" },
  { type: "tool_result", tool_call_id: "call_1", content: "file body" },
  { type: "assistant", content: "", tool_calls: [{ id: "call_2", name: "edit_file" }], model_id: "grok-fixture" },
  { type: "tool_result", tool_call_id: "call_2", content: "ok" },
  { type: "assistant", content: "Renamed it to loadSettings.", tool_calls: [], model_id: "grok-fixture" },
  { type: "user", synthetic_reason: "todo_reminder", content: [{ type: "text", text: "Remember the open todos." }] },
  userQuery("thanks", 1),
  { type: "assistant", content: "You're welcome.", model_id: "grok-fixture" },
];

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `grok-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A GROK_HOME with one session laid out the way Grok CLI stores it. */
async function grokHome(t, { rows = HISTORY, cwd = CWD, group = encodeURIComponent(cwd) } = {}) {
  const home = await temporaryDirectory(t, "home");
  const sessionDir = path.join(home, "sessions", group, SESSION);
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(path.join(sessionDir, "chat_history.jsonl"), jsonl(rows));
  await fsp.writeFile(path.join(sessionDir, "updates.jsonl"), jsonl([{ timestamp: 1790000000, method: "_x.ai/session/update", params: { sessionId: SESSION, update: { sessionUpdate: "hook_execution" } } }]));
  await fsp.writeFile(path.join(sessionDir, "summary.json"), JSON.stringify({ info: { id: SESSION, cwd }, created_at: "2026-09-20T01:02:03.000Z", chat_format_version: 1 }));
  return { home, sessionDir, transcript: path.join(sessionDir, "chat_history.jsonl") };
}

function withGrokHome(t, home) {
  const before = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = before;
  });
}

test("Grok parser keeps typed prompts and replies, and drops Grok's own lines", async (t) => {
  const { transcript } = await grokHome(t);
  const result = await parseTranscript(transcript, { sessionId: SESSION, cwd: CWD });
  assert.equal(result.session_id, `grok-${SESSION}`);
  assert.equal(result.metadata.original_session_id, SESSION);
  assert.equal(result.metadata.cwd, path.resolve(CWD));
  assert.equal(result.metadata.model_id, "grok-fixture");
  assert.deepEqual(result.turns.map(({ role, content, line_index }) => [role, content, line_index]), [
    ["user", "rename the config loader", 4],
    ["assistant", "Looking at the loader first.", 6],
    ["assistant", "Renamed it to loadSettings.", 10],
    ["user", "thanks", 12],
    ["assistant", "You're welcome.", 13],
  ]);
});

test("without a hook payload the parser takes the session from its folder and the cwd from summary.json", async (t) => {
  const { transcript } = await grokHome(t);
  const result = await parseTranscript(transcript, {});
  assert.equal(result.session_id, `grok-${SESSION}`);
  assert.equal(result.metadata.cwd, path.resolve(CWD));
});

test("a Grok turn keeps the line identity the first Grok messages in Honcho were stored under", async (t) => {
  const { transcript } = await grokHome(t);
  const { session_id: sessionId, turns } = await parseTranscript(transcript, {});
  // Those messages carry grok_line_index and grok_role and no source message id.
  const stored = turnHashCandidates(sessionId, { line_index: 4, role: "user", content: "" })[0];
  assert.ok(turnHashCandidates(sessionId, turns[0]).includes(stored));
});

test("a Stop payload's updates.jsonl leads to chat_history.jsonl beside it", async (t) => {
  const { home, sessionDir, transcript } = await grokHome(t);
  withGrokHome(t, home);
  assert.equal(resolveTranscriptPath({ transcriptPath: path.join(sessionDir, "updates.jsonl") }), transcript);
  assert.equal(resolveTranscriptPath({ transcript_path: transcript }), transcript);
});

test("a payload with only the session id and cwd finds the session, also under a slugged folder", async (t) => {
  const encoded = await grokHome(t);
  withGrokHome(t, encoded.home);
  assert.equal(resolveTranscriptPath({ sessionId: SESSION, cwd: CWD }), encoded.transcript);
  assert.equal(resolveTranscriptPath({ session_id: SESSION, workspaceRoot: CWD }), encoded.transcript);

  // Grok stores a working directory whose encoded name is too long under a slug and hash.
  const slugged = await grokHome(t, { group: "very-long-project-1a2b3c4d" });
  process.env.GROK_HOME = slugged.home;
  assert.equal(resolveTranscriptPath({ sessionId: SESSION, cwd: CWD }), slugged.transcript);
});

test("a session with no chat_history.jsonl on disk resolves to nothing", async (t) => {
  const { home, sessionDir } = await grokHome(t);
  withGrokHome(t, home);
  await fsp.rm(path.join(sessionDir, "chat_history.jsonl"));
  assert.equal(resolveTranscriptPath({ transcriptPath: path.join(sessionDir, "updates.jsonl"), sessionId: SESSION, cwd: CWD }), "");
  assert.equal(resolveTranscriptPath({ sessionId: "../escape", cwd: CWD }), "");
  assert.equal(resolveTranscriptPath({}), "");
});

function startApi() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url.includes("/messages/list")) response.end(JSON.stringify({ items: [], total: 0 }));
    else response.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

/** A home for main.mjs: its spool, state and logs land here, never in the real ~/.hermes. */
async function hookEnvironment(t, grok, port) {
  const home = await temporaryDirectory(t, "user");
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HONCHO_AGENT_BRIDGE_HOME: path.join(home, "app"),
    GROK_HOME: grok,
    HONCHO_BASE_URL: `http://127.0.0.1:${port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_CODEX_NETWORK_MODE: "internal",
    HONCHO_AGENT_GATE_QUIET: "1",
    HOOK_HOME: home,
  };
}

const runMain = (args, env, payload) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [MAIN, ...args], { env }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
  child.stdin.end(JSON.stringify(payload));
});

test("the Grok Stop hook sends the session's turns once, as grok messages", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const { home, sessionDir } = await grokHome(t);
  const env = await hookEnvironment(t, home, api.port);
  const payload = { hookEventName: "stop", hook_event_name: "Stop", sessionId: SESSION, cwd: CWD, transcriptPath: path.join(sessionDir, "updates.jsonl"), reason: "end_turn" };

  await runMain(["--provider", "grok"], env, payload);
  const writes = api.requests.filter((entry) => entry.url === `/v3/workspaces/memory/sessions/grok-${SESSION}/messages`);
  assert.equal(writes.length, 1);
  const messages = writes[0].body.messages;
  assert.deepEqual(messages.map((message) => [message.peer_id, message.content]), [
    ["user_test", "rename the config loader"],
    ["assistant_grok", "Looking at the loader first."],
    ["assistant_grok", "Renamed it to loadSettings."],
    ["user_test", "thanks"],
    ["assistant_grok", "You're welcome."],
  ]);
  const metadata = messages[0].metadata;
  assert.equal(metadata.agent_provider, "grok");
  assert.equal(metadata.grok_session_id, `grok-${SESSION}`);
  assert.equal(metadata.grok_role, "user");
  assert.equal(metadata.grok_line_index, 4);
  assert.equal(metadata.transcript_path, path.join(sessionDir, "chat_history.jsonl"));
  const session = api.requests.find((entry) => entry.url === "/v3/workspaces/memory/sessions");
  assert.equal(session.body.id, `grok-${SESSION}`);
  assert.equal(session.body.metadata.cwd, path.resolve(CWD));

  // The session-end Stop that follows sends nothing again.
  await runMain(["--provider", "grok"], env, { ...payload, reason: "shutdown" });
  assert.equal(api.requests.filter((entry) => entry.url?.endsWith("/messages")).length, 1);
});

test("a Grok Stop for a session without chat_history.jsonl queues nothing", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const { home } = await grokHome(t);
  const env = await hookEnvironment(t, home, api.port);
  await runMain(["--provider", "grok"], env, { sessionId: "01a1b2c3-0000-7000-8000-000000000000", cwd: CWD });
  assert.equal(api.requests.length, 0);
  const spool = path.join(env.HOOK_HOME, ".hermes", "spool", "agent-honcho", "grok", "pending");
  assert.deepEqual(await fsp.readdir(spool).catch(() => []), []);
});

test("the Claude hook Grok also runs never queues a Grok session as a Claude transcript", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const { home, sessionDir } = await grokHome(t);
  const env = await hookEnvironment(t, home, api.port);
  await runMain(["--provider", "claude"], env, { hook_event_name: "Stop", session_id: SESSION, transcript_path: path.join(sessionDir, "updates.jsonl") });
  assert.equal(api.requests.length, 0);
  await assert.rejects(fsp.access(path.join(env.HOOK_HOME, ".hermes", "spool", "agent-honcho", "claude")));
});

test("the collector run by hand on a session folder's updates.jsonl reads chat_history.jsonl", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const { home, sessionDir } = await grokHome(t);
  const env = await hookEnvironment(t, home, api.port);
  const state = path.join(env.HOOK_HOME, "state.json");
  const run = async () => JSON.parse((await execFileAsync(process.execPath, [COLLECTOR, "--provider", "grok", "--transcript", path.join(sessionDir, "updates.jsonl")], {
    env: { ...env, HONCHO_AGENT_HOOK_STATE: state, HONCHO_AGENT_HOOK_LOG: path.join(env.HOOK_HOME, "grok.log") },
  })).stdout);
  const first = await run();
  assert.equal(first.transcript_path, path.join(sessionDir, "chat_history.jsonl"));
  assert.equal(first.new_messages, 5);
  const second = await run();
  assert.equal(second.new_messages, 0);
});
