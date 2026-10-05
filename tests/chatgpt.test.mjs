import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { jsonArrayItems } from "../scripts/providers/chatgpt-archive.mjs";
import { activeBranch, cleanAnswerMarkup, loadExport, parseConversation, parseExport } from "../scripts/providers/chatgpt.mjs";
import { fixtureConversations, fixtureEntries, fixtureZip, makeZip, startFakeHoncho } from "./chatgpt-fixture.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");

function node(id, parent, message) {
  return { id, parent, children: [], message };
}

function message(id, role, text, createTime, extra = {}) {
  return {
    id,
    author: { role },
    create_time: createTime,
    content: { content_type: "text", parts: [text] },
    ...extra,
  };
}

// A conversation whose answer was regenerated: two assistant siblings, only one of
// which the reader ever saw.
function branchedConversation() {
  const mapping = {
    root: node("root", null, null),
    u1: node("u1", "root", message("u1", "user", "첫 질문", 1_700_000_000)),
    a1: node("a1", "u1", message("a1", "assistant", "버려진 답", 1_700_000_001)),
    a2: node("a2", "u1", message("a2", "assistant", "채택된 답", 1_700_000_002)),
    u2: node("u2", "a2", message("u2", "user", "두 번째 질문", 1_700_000_003)),
  };
  return {
    conversation_id: "conv-branched",
    title: "분기된 대화",
    create_time: 1_700_000_000,
    update_time: 1_700_000_003,
    current_node: "u2",
    mapping,
  };
}

async function writeExport(t, payload, name = "conversations.json") {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "chatgpt-export-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  await fsp.writeFile(file, JSON.stringify(payload));
  return { directory, file };
}

function startApi() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : null });
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.endsWith("/messages/list")) response.end(JSON.stringify({ items: [], total: 0 }));
    else response.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

test("only the branch the reader saw becomes memory", () => {
  const chain = activeBranch(branchedConversation()).map((entry) => entry.id);
  assert.deepEqual(chain, ["root", "u1", "a2", "u2"], "the regenerated sibling a1 is not on the path");

  const parsed = parseConversation(branchedConversation());
  assert.deepEqual(
    parsed.turns.map(({ role, content }) => [role, content]),
    [["user", "첫 질문"], ["assistant", "채택된 답"], ["user", "두 번째 질문"]],
  );
  assert.equal(parsed.session_id, "chatgpt-conv-branched");
  assert.equal(parsed.metadata.title, "분기된 대화");
  assert.equal(parsed.metadata.created_at, new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(parsed.turns[0].source_message_id, "u1");
});

test("system turns, hidden injections and non-text content are left out", () => {
  const mapping = {
    root: node("root", null, null),
    s1: node("s1", "root", message("s1", "system", "you are helpful", 1)),
    h1: node("h1", "s1", message("h1", "user", "custom instructions", 2, { metadata: { is_user_system_message: true } })),
    v1: node("v1", "h1", message("v1", "assistant", "hidden tool note", 3, { metadata: { is_visually_hidden_from_conversation: true } })),
    t1: node("t1", "v1", { id: "t1", author: { role: "tool" }, create_time: 4, content: { content_type: "text", parts: ["tool output"] } }),
    c1: node("c1", "t1", { id: "c1", author: { role: "assistant" }, create_time: 5, content: { content_type: "code", language: "python", text: "print(1)" } }),
    u1: node("u1", "c1", message("u1", "user", "진짜 질문", 6)),
  };
  const parsed = parseConversation({ conversation_id: "conv-noise", current_node: "u1", mapping });
  assert.deepEqual(parsed.turns.map((turn) => turn.content), ["진짜 질문"]);
});

test("multimodal turns keep their text and drop the attachment pointers", () => {
  const mapping = {
    root: node("root", null, null),
    u1: node("u1", "root", {
      id: "u1",
      author: { role: "user" },
      create_time: 10,
      content: {
        content_type: "multimodal_text",
        parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://x" }, "이 이미지 설명해줘"],
      },
    }),
  };
  const parsed = parseConversation({ conversation_id: "conv-mm", current_node: "u1", mapping });
  assert.deepEqual(parsed.turns.map((turn) => turn.content), ["이 이미지 설명해줘"]);
});

test("a conversation without current_node falls back to its newest message", () => {
  const mapping = {
    root: node("root", null, null),
    u1: node("u1", "root", message("u1", "user", "질문", 100)),
    a1: node("a1", "u1", message("a1", "assistant", "답", 200)),
  };
  const parsed = parseConversation({ conversation_id: "conv-noleaf", mapping });
  assert.deepEqual(parsed.turns.map((turn) => turn.content), ["질문", "답"]);
});

test("an export is read whether it is an array, an object, or a directory", async (t) => {
  const one = branchedConversation();
  const { file } = await writeExport(t, [one]);
  assert.equal((await parseExport(file)).length, 1);

  const wrapped = await writeExport(t, { conversations: [one] }, "wrapped.json");
  assert.equal((await parseExport(wrapped.file)).length, 1);

  const asDirectory = await writeExport(t, [one]);
  assert.equal((await parseExport(asDirectory.directory)).length, 1, "a directory is read as conversations.json");
});

test("an export with no conversations is an error, not an empty success", async (t) => {
  const { file } = await writeExport(t, []);
  await assert.rejects(() => parseExport(file), /no conversations found/);
  const broken = await writeExport(t, "not json at all", "broken.json");
  await fsp.writeFile(broken.file, "{oops");
  await assert.rejects(() => parseExport(broken.file), /invalid JSON/);
});

test("the collector imports every conversation in one export and sends the Access token", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const second = {
    conversation_id: "conv-second",
    title: "두 번째",
    create_time: 1_700_100_000,
    current_node: "u1",
    mapping: {
      root: node("root", null, null),
      u1: node("u1", "root", message("u1", "user", "또 다른 질문", 1_700_100_000)),
    },
  };
  const { file } = await writeExport(t, [branchedConversation(), second]);
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "chatgpt-collector-"));
  t.after(() => fsp.rm(workdir, { recursive: true, force: true }));

  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${api.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: path.join(workdir, "state.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(workdir, "collector.log"),
    HONCHO_API_BEARER_TOKEN: "honcho-token",
    CF_ACCESS_CLIENT_ID: "client.access",
    CF_ACCESS_CLIENT_SECRET: "client-secret",
  };
  const args = [COLLECTOR, "--provider", "chatgpt", "--export", file];

  const first = JSON.parse((await execFileAsync(process.execPath, args, { env })).stdout);
  assert.equal(first.ok, true);
  assert.equal(first.conversations, 2);
  assert.equal(first.imported_sessions, 2);
  assert.equal(first.failed_sessions, 0);
  assert.equal(first.new_messages, 4, "3 turns from the branched conversation plus 1 from the second");
  assert.deepEqual(first.sessions.map((session) => session.session_id).sort(), ["chatgpt-conv-branched", "chatgpt-conv-second"]);

  const write = api.requests.find((entry) => entry.url?.endsWith("/messages"));
  assert.deepEqual(write.body.messages.map((entry) => entry.peer_id), ["user_test", "assistant_chatgpt", "user_test"]);
  assert.equal(write.headers["cf-access-client-id"], "client.access");
  assert.equal(write.headers["cf-access-client-secret"], "client-secret");
  assert.equal(write.headers.authorization, "Bearer honcho-token");

  // Re-importing the same export must add nothing.
  const writesBefore = api.requests.filter((entry) => entry.url?.endsWith("/messages")).length;
  const again = JSON.parse((await execFileAsync(process.execPath, args, { env })).stdout);
  assert.equal(again.new_messages, 0);
  assert.equal(api.requests.filter((entry) => entry.url?.endsWith("/messages")).length, writesBefore);
});

test("the Access headers are omitted when no service token is configured", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const { file } = await writeExport(t, [branchedConversation()]);
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "chatgpt-collector-noaccess-"));
  t.after(() => fsp.rm(workdir, { recursive: true, force: true }));

  const env = { ...process.env, HONCHO_BASE_URL: `http://127.0.0.1:${api.port}`, HONCHO_WORKSPACE_ID: "memory", HONCHO_USER_NAME: "user_test", HONCHO_AGENT_HOOK_STATE: path.join(workdir, "state.json"), HONCHO_AGENT_HOOK_LOG: path.join(workdir, "collector.log") };
  delete env.CF_ACCESS_CLIENT_ID;
  delete env.CF_ACCESS_CLIENT_SECRET;
  delete env.HONCHO_API_BEARER_TOKEN;

  await execFileAsync(process.execPath, [COLLECTOR, "--provider", "chatgpt", "--export", file], { env });
  const write = api.requests.find((entry) => entry.url?.endsWith("/messages"));
  assert.equal("cf-access-client-id" in write.headers, false);
  assert.equal("authorization" in write.headers, false);
});

// ── The 2026 export: a zip of numbered shards, read as it arrives ──────────────

test("the JSON reader takes an array apart one item at a time, across any chunk boundary", async () => {
  const items = [{ a: "x]}\\\"[{," }, [1, 2], "s,]", 3, null, { k: "한글 ✓", nested: { deep: [{}] } }];
  const raw = Buffer.from(`﻿ [ ${items.map((item) => JSON.stringify(item)).join(" ,\n")} ] \n`);
  const oneByteChunks = (async function* () {
    for (const byte of raw) yield Buffer.from([byte]);
  })();
  const read = [];
  for await (const item of jsonArrayItems(oneByteChunks, "probe")) read.push(item);
  assert.deepEqual(read, items);

  const truncated = (async function* () {
    yield Buffer.from(`[${JSON.stringify(items[0])}, {"cut": "of`);
  })();
  await assert.rejects(async () => {
    for await (const item of jsonArrayItems(truncated, "cut.json")) void item;
  }, /invalid JSON\): cut\.json: the file ends before its closing \]/);
});

test("only what the reader saw is kept: tool calls, tool output, reasoning and hidden turns are left out", () => {
  const { a, b } = fixtureConversations();
  const branched = parseConversation(a);
  assert.deepEqual(branched.turns.map(({ role, content }) => [role, content]), [
    ["user", "How do I keep a sourdough starter alive?"],
    ["assistant", "Feed it flour and water every day."],
    ["user", "Which flour works best?"],
    ["assistant", "Use whole wheat. Example Mills sells it."],
  ], "the regenerated answer and the edited-away question are off the branch; citation markup is gone");
  assert.equal(branched.stats.off_branch_messages, 3);
  assert.deepEqual(branched.stats.skipped, { "role:system": 1, hidden: 1, "content:thoughts": 1, "content:reasoning_recap": 1 });
  assert.equal(branched.turns[2].created_at, branched.turns[1].created_at, "a message with no time takes the time before it");
  assert.equal(branched.turns[1].created_at, "2024-01-10T09:00:20.250Z", "fractional seconds survive");
  assert.equal(branched.stats.time_filled, 1);
  assert.equal(branched.metadata.default_model_slug, "gpt-4o");

  const tools = parseConversation(b);
  assert.deepEqual(tools.turns.map(({ role, content }) => [role, content]), [
    ["user", "What plant is this?"],
    ["assistant", "It looks like a monstera."],
    ["assistant", "Noted."],
    ["user", "Remind me to water it"],
    ["assistant", "Sure, once a week."],
  ]);
  assert.deepEqual(tools.stats.skipped, { custom_instructions: 1, tool_call: 3, "role:tool": 5, no_text: 1 });
  assert.deepEqual(tools.stats.dropped_parts, { image_asset_pointer: 2, audio_asset_pointer: 2 });
});

test("answer markup keeps the words the app showed", () => {
  assert.equal(cleanAnswerMarkup("Seoul is large citeturn0search1.\nNext"), "Seoul is large.\nNext");
  assert.equal(cleanAnswerMarkup("Ask entity[\"people\",\"Someone Madeup\"] about it"), "Ask Someone Madeup about it");
  assert.equal(cleanAnswerMarkup("Quoted words 【7:2†notes.pdf】"), "Quoted words");
  assert.equal(cleanAnswerMarkup("image_group{\"query\":[\"made up\"]}\nText"), "Text");
});

async function sessionsOf(input) {
  const loaded = await loadExport(input);
  return {
    loaded,
    shape: loaded.sessions.map((parsed) => [parsed.session_id, parsed.turns.map((turn) => [turn.role, turn.content, turn.created_at])]),
  };
}

test("the export is read the same from the zip, its folder, a nested archive, ZIP64, or a zip saved as conversations.json", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "chatgpt-layouts-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const zipFile = path.join(directory, "export.zip");
  await fsp.writeFile(zipFile, fixtureZip());
  const expected = await sessionsOf(zipFile);
  assert.deepEqual(expected.shape.map(([id]) => id), [
    "chatgpt-conv-c-0000-4000-8000-000000000003",
    "chatgpt-conv-g-0000-4000-8000-000000000007",
    "chatgpt-conv-a-0000-4000-8000-000000000001",
    "chatgpt-conv-b-0000-4000-8000-000000000002",
    "chatgpt-conv-d-0000-4000-8000-000000000004",
  ], "oldest conversation first, whatever order the shards hold them in; the empty one is left out");
  assert.deepEqual(expected.loaded.files.map((file) => path.basename(file.source)), ["export.zip#conversations-000.json", "export.zip#conversations-001.json"]);
  assert.equal(expected.loaded.summary.duplicate_conversations, 1, "the older copy of a conversation is dropped");
  assert.equal(expected.shape[2][1].length, 4, "the newer copy of the duplicated conversation is the one kept");

  const folder = path.join(directory, "unzipped");
  for (const entry of fixtureEntries()) {
    await fsp.mkdir(path.dirname(path.join(folder, entry.name)), { recursive: true });
    await fsp.writeFile(path.join(folder, entry.name), entry.data);
  }
  assert.deepEqual((await sessionsOf(folder)).shape, expected.shape, "the unpacked folder");

  const portal = path.join(directory, "portal.zip");
  await fsp.writeFile(portal, makeZip([
    { name: "report.html", data: "<html>made up</html>" },
    { name: "User Online Activity/Conversations_madeup-chatgpt-0001.zip", data: fixtureZip(), method: 0 },
    { name: "User Online Activity/Files_madeup-files-0001.zip", data: makeZip([{ name: "file-x.dat", data: "made up" }]), method: 8 },
  ]));
  const nested = await sessionsOf(portal);
  assert.deepEqual(nested.shape, expected.shape, "an inner zip stored in an outer one");
  assert.deepEqual(nested.loaded.skipped_archives.map((entry) => entry.reason), ["attachments only, not conversations"]);

  const deflatedInner = path.join(directory, "deflated.zip");
  await fsp.writeFile(deflatedInner, makeZip([{ name: "Conversations_madeup-chatgpt-0001-part-0001.zip", data: fixtureZip(), method: 8 }]));
  assert.deepEqual((await sessionsOf(deflatedInner)).shape, expected.shape, "an inner zip that was compressed again");

  const zip64 = path.join(directory, "zip64.zip");
  await fsp.writeFile(zip64, fixtureZip({ zip64: true }));
  assert.deepEqual((await sessionsOf(zip64)).shape, expected.shape, "ZIP64 records");

  const spooled = path.join(directory, "spool", "conversations.json");
  await fsp.mkdir(path.dirname(spooled));
  await fsp.writeFile(spooled, fixtureZip());
  assert.deepEqual((await sessionsOf(spooled)).shape, expected.shape, "the UI spools an upload as conversations.json; a zip is still a zip");

  const unrelated = path.join(directory, "unrelated.zip");
  await fsp.writeFile(unrelated, makeZip([{ name: "notes.txt", data: "made up" }]));
  await assert.rejects(() => loadExport(unrelated), /no conversations found/);
});

function collectorEnv(api, workdir, extra = {}) {
  const env = {
    ...process.env,
    HONCHO_BASE_URL: api.url,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "chenjing",
    HONCHO_AGENT_HOOK_STATE: path.join(workdir, "state.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(workdir, "collector.log"),
    ...extra,
  };
  for (const name of ["HONCHO_ASSISTANT_NAME", "HONCHO_CHATGPT_ASSISTANT_NAME", "HONCHO_API_BEARER_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "HONCHO_CF_ACCESS_CLIENT_ID", "HONCHO_CF_ACCESS_CLIENT_SECRET", "HONCHO_AGENT_TARGET_FOLDERS", "HONCHO_AGENT_DRY_RUN"]) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

async function runImport(env, ...args) {
  const { stdout } = await execFileAsync(process.execPath, [COLLECTOR, "--provider", "chatgpt", ...args], { env, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

test("a zipped export imports end to end into the chosen workspace and peer, once", async (t) => {
  const api = await startFakeHoncho();
  t.after(() => api.server.close());
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "chatgpt-e2e-"));
  t.after(() => fsp.rm(workdir, { recursive: true, force: true }));
  const zipFile = path.join(workdir, "export.zip");
  await fsp.writeFile(zipFile, fixtureZip());
  const env = collectorEnv(api, workdir);

  const dry = await runImport(env, "--export", zipFile, "--workspace", "rebuilt", "--dry-run");
  assert.equal(api.requests.length, 0, "a dry run sends nothing");
  assert.equal(dry.new_messages, 16);
  assert.deepEqual(dry.new_messages_by_peer, { chenjing: 7, assistant_chatgpt: 9 });

  const first = await runImport(env, "--export", zipFile, "--workspace", "rebuilt");
  assert.equal(first.ok, true, JSON.stringify(first.sessions.filter((session) => session.error)));
  assert.equal(first.workspace, "rebuilt", "--workspace wins over HONCHO_WORKSPACE_ID");
  assert.equal(first.user_peer, "chenjing");
  assert.equal(first.assistant_peer, "assistant_chatgpt");
  assert.equal(first.conversations, 7);
  assert.equal(first.imported_sessions, 5);
  assert.equal(first.new_messages, 16, "15 turns, the long answer split in two");
  assert.deepEqual(first.new_messages_by_peer, { chenjing: 7, assistant_chatgpt: 9 });
  assert.deepEqual(first.summary.turns_by_role, { user: 7, assistant: 8 });
  assert.equal(first.summary.do_not_remember_conversations, 1);
  assert.ok(api.requests.every((entry) => entry.url.startsWith("/v3/workspaces/rebuilt/")), "nothing goes to another workspace");

  const sent = api.store.get("rebuilt/chatgpt-conv-a-0000-4000-8000-000000000001");
  assert.deepEqual(sent.map((message) => [message.peer_id, message.created_at]), [
    ["chenjing", "2024-01-10T09:00:00.000Z"],
    ["assistant_chatgpt", "2024-01-10T09:00:20.250Z"],
    ["chenjing", "2024-01-10T09:00:20.250Z"],
    ["assistant_chatgpt", "2024-01-10T09:00:43.000Z"],
  ]);
  assert.ok(sent.every((message) => message.metadata.source === "chatgpt" && message.metadata.source_message_id));
  const sessionWrites = api.requests.filter((entry) => /\/sessions$/.test(entry.url));
  const created = sessionWrites.find((entry) => entry.body.id === "chatgpt-conv-d-0000-4000-8000-000000000004");
  assert.equal(created.body.metadata.is_do_not_remember, true);
  assert.equal(created.body.metadata.default_model_slug, "gpt-5-thinking");
  assert.deepEqual(created.body.configuration, {}, "summaries follow the workspace's configuration");
  assert.deepEqual(created.body.peers.assistant_chatgpt, { observe_me: false, observe_others: false });
  const order = [...new Set(api.requests.filter((entry) => entry.url.endsWith("/messages")).map((entry) => entry.url.split("/")[5]))];
  assert.deepEqual(order, first.sessions.map((session) => session.session_id), "conversations are sent oldest first");

  const writes = () => api.requests.filter((entry) => entry.url.endsWith("/messages")).length;
  const before = writes();
  const again = await runImport(env, "--export", zipFile, "--workspace", "rebuilt");
  assert.equal(again.new_messages, 0, "the same export again adds nothing");
  assert.equal(writes(), before);

  await fsp.rm(path.join(workdir, "state.json"));
  const withoutState = await runImport(env, "--export", zipFile, "--workspace", "rebuilt");
  assert.equal(withoutState.new_messages, 0, "with the local state gone, what the workspace holds still counts");
  assert.equal(writes(), before);

  const newer = path.join(workdir, "newer.zip");
  await fsp.writeFile(newer, fixtureZip({ continued: true }));
  const update = await runImport(env, "--export", newer, "--workspace", "rebuilt");
  assert.equal(update.new_messages, 4, "two new turns in an old conversation and one new conversation");
  assert.deepEqual(api.store.get("rebuilt/chatgpt-conv-a-0000-4000-8000-000000000001").slice(-2).map((message) => message.content), ["And how warm should it be?", "Around room temperature."]);

  const elsewhere = await runImport(env, "--export", zipFile, "--workspace", "scratch");
  assert.equal(elsewhere.new_messages, 16, "the state kept for one workspace does not hold back another");
  assert.equal(api.store.get("rebuilt/chatgpt-conv-a-0000-4000-8000-000000000001").length, 6, "and the first workspace is untouched");
});
