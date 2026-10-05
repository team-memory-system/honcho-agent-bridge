// agy conversations started by a program, not the person: the history rule in
// providers/agy.mjs and what the collector does with it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  HISTORY_WINDOW_MS,
  classifyAutomation,
  conversationOrigin,
  historyPath,
  isAppTranscript,
  parseHistory,
  parseTranscript,
  readHistory,
} from "../scripts/providers/agy.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");

const LISTED = "aaaaaaaa-0000-4000-8000-000000000001";
const TIMED = "aaaaaaaa-0000-4000-8000-000000000002";
const SCRIPTED = "aaaaaaaa-0000-4000-8000-000000000003";
const APP = "aaaaaaaa-0000-4000-8000-000000000004";
const T0 = Date.parse("2026-07-01T03:00:00Z");

const line = (value) => `${JSON.stringify(value)}\n`;

async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `agy-automation-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(target, content) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
  return target;
}

function historyText() {
  return [
    { display: "a typed question", timestamp: T0 - 3_600_000, workspace: "/tmp/w", conversationId: LISTED },
    // Older agy versions wrote no conversationId.
    { display: "another typed question", timestamp: T0, workspace: "/tmp/w" },
    { display: "/help", timestamp: T0 + 600_000, workspace: "/tmp/w", type: "slash_command" },
    "not json",
  ].map((entry) => (typeof entry === "string" ? `${entry}\n` : line(entry))).join("");
}

function transcript(firstPromptAt, prompt = "write a haiku about tea") {
  return [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: firstPromptAt, content: `<USER_REQUEST>${prompt}</USER_REQUEST>` },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: firstPromptAt, content: "steam over the cup" },
  ].map(line).join("");
}

async function conversation(home, product, id, firstPromptAt) {
  return put(path.join(home, ".gemini", product, "brain", id, ".system_generated", "logs", "transcript.jsonl"), transcript(firstPromptAt));
}

test("the history yields conversation ids and the times of entries without one", () => {
  const history = parseHistory(historyText());
  assert.deepEqual([...history.ids], [LISTED]);
  assert.deepEqual(history.idlessTimes, [T0, T0 + 600_000]);
  assert.deepEqual(parseHistory(""), { ids: new Set(), idlessTimes: [] });
});

test("the history path comes from HONCHO_AGY_HISTORY, else agy CLI's own file", () => {
  assert.equal(historyPath({ HONCHO_AGY_HISTORY: "/x/history.jsonl" }), "/x/history.jsonl");
  assert.equal(historyPath({ HONCHO_AGY_HISTORY: "~/h.jsonl" }), path.join(os.homedir(), "h.jsonl"));
  assert.equal(historyPath({}), path.join(os.homedir(), ".gemini", "antigravity-cli", "history.jsonl"));
});

test("an Antigravity app transcript is told apart from the CLI's by its folder", () => {
  assert.equal(isAppTranscript(`/h/.gemini/antigravity/brain/${APP}/.system_generated/logs/transcript.jsonl`), true);
  assert.equal(isAppTranscript(`/h/.gemini/antigravity-ide/brain/${APP}/.system_generated/logs/transcript.jsonl`), true);
  assert.equal(isAppTranscript(`C:\\Users\\me\\.gemini\\antigravity\\brain\\${APP}\\.system_generated\\logs\\transcript.jsonl`), true);
  assert.equal(isAppTranscript(`/h/.gemini/antigravity-cli/brain/${APP}/.system_generated/logs/transcript.jsonl`), false);
  assert.equal(isAppTranscript(`/drive/agy/2026/07/01/${APP}/transcript.jsonl`), false);
  assert.equal(isAppTranscript(""), false);
});

test("each branch of the rule: listed id, a nearby id-less entry, the app, and the rest", async (t) => {
  const home = await temporaryDirectory(t, "rule");
  const history = parseHistory(historyText());
  const at = (ms) => new Date(ms).toISOString();
  const cases = [
    ["antigravity-cli", LISTED, at(T0 + 86_400_000), "history_id"],
    ["antigravity-cli", TIMED, at(T0 + HISTORY_WINDOW_MS), "history_time"],
    ["antigravity-cli", TIMED, at(T0 - HISTORY_WINDOW_MS), "history_time"],
    ["antigravity-cli", SCRIPTED, at(T0 + HISTORY_WINDOW_MS + 1000), "unlisted"],
    ["antigravity", APP, at(T0 + 86_400_000), "app"],
  ];
  for (const [product, id, firstPromptAt, expected] of cases) {
    const file = await conversation(home, product, id, firstPromptAt);
    const parsed = await parseTranscript(file, {});
    assert.equal(conversationOrigin(parsed, history), expected, `${product} ${id} ${firstPromptAt}`);
  }
  // A conversation id in the history is matched whatever its case.
  const upper = await parseTranscript(await conversation(home, "antigravity-cli", LISTED.toUpperCase(), at(T0 + 86_400_000)), {});
  assert.equal(conversationOrigin(upper, history), "history_id");
  // With no history to read, nothing can be told apart.
  const scripted = await parseTranscript(await conversation(home, "antigravity-cli", SCRIPTED, at(T0 + 86_400_000)), {});
  assert.equal(conversationOrigin(scripted, null), "no_history");
});

test("classifyAutomation sends only unlisted conversations to automation, reading HONCHO_AGY_HISTORY", async (t) => {
  const home = await temporaryDirectory(t, "classify");
  const historyFile = await put(path.join(home, "history.jsonl"), historyText());
  const saved = process.env.HONCHO_AGY_HISTORY;
  process.env.HONCHO_AGY_HISTORY = historyFile;
  t.after(() => {
    if (saved === undefined) delete process.env.HONCHO_AGY_HISTORY;
    else process.env.HONCHO_AGY_HISTORY = saved;
  });
  assert.notEqual(readHistory(historyFile), null);
  const scripted = await parseTranscript(await conversation(home, "antigravity-cli", SCRIPTED, "2026-08-01T00:00:00Z"), {});
  const listed = await parseTranscript(await conversation(home, "antigravity-cli", LISTED, "2026-08-01T00:00:00Z"), {});
  assert.deepEqual(classifyAutomation("write a haiku about tea", scripted.metadata, scripted), [true, "agy_script"]);
  assert.deepEqual(classifyAutomation("write a haiku about tea", listed.metadata, listed), [false, null]);
  // Without the parsed conversation there is nothing to decide by.
  assert.deepEqual(classifyAutomation("write a haiku about tea", scripted.metadata), [false, null]);

  process.env.HONCHO_AGY_HISTORY = path.join(home, "missing.jsonl");
  const fresh = await parseTranscript(scripted.metadata.file_path, {});
  assert.deepEqual(classifyAutomation("write a haiku about tea", fresh.metadata, fresh), [false, null]);
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

test("the collector stores a scripted agy conversation under automation_agy and a listed one as the person's", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const home = await temporaryDirectory(t, "collector");
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${api.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: path.join(home, "state.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(home, "collector.log"),
    HONCHO_AGY_HISTORY: await put(path.join(home, "history.jsonl"), historyText()),
  };
  delete env.HONCHO_AGY_AUTOMATION_PEER;
  delete env.HONCHO_ASSISTANT_NAME;
  delete env.HONCHO_AGY_ASSISTANT_NAME;
  const cases = [
    { id: SCRIPTED, product: "antigravity-cli", userPeer: "automation_agy" },
    { id: LISTED, product: "antigravity-cli", userPeer: "user_test" },
    { id: APP, product: "antigravity", userPeer: "user_test" },
  ];
  for (const { id, product, userPeer } of cases) {
    const file = await conversation(home, product, id, "2026-08-01T00:00:00Z");
    const args = [COLLECTOR, "--provider", "agy", "--transcript", file];

    const dry = JSON.parse((await execFileAsync(process.execPath, [...args, "--dry-run"], { env })).stdout);
    assert.deepEqual(dry.new_messages_by_peer, { [userPeer]: 1, assistant_agy: 1 }, id);

    api.requests.length = 0;
    const result = JSON.parse((await execFileAsync(process.execPath, args, { env })).stdout);
    assert.equal(result.new_messages, 2, id);
    const write = api.requests.find((entry) => entry.url?.endsWith("/messages"));
    assert.deepEqual(write.body.messages.map((message) => message.peer_id), [userPeer, "assistant_agy"], id);
    const [user] = write.body.messages.map((message) => message.metadata);
    const sessionWrites = api.requests.filter((entry) => entry.url === "/v3/workspaces/memory/sessions");
    if (userPeer === "automation_agy") {
      assert.equal(user.direct_user, false);
      assert.equal(user.memory_origin, "agy_automation");
      assert.equal(user.automation_kind, "agy_script");
      assert.deepEqual(sessionWrites.at(-1).body.peers.automation_agy, { observe_me: false, observe_others: false });
    } else {
      assert.equal(user.direct_user, true, id);
      assert.equal(user.memory_origin, "agy_direct_user", id);
      assert.equal(user.automation_kind, undefined, id);
      assert.equal(sessionWrites.at(-1).body.peers.automation_agy, undefined, id);
    }
  }
});
