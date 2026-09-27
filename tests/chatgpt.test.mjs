import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { activeBranch, parseConversation, parseExport } from "../scripts/providers/chatgpt.mjs";

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
