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
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");

function startApi(existingMessages = []) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.endsWith("/messages/list")) {
      const page = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("size") || 50);
      response.end(JSON.stringify({ items: existingMessages.slice((page - 1) * size, page * size), total: existingMessages.length }));
    } else response.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

test("Claude collector maps peers, stores source IDs, and remains idempotent", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-collector-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "claude.jsonl");
  const state = path.join(directory, "state.json");
  const log = path.join(directory, "collector.log");
  await fsp.writeFile(
    transcript,
    [
      { uuid: "user-message-1", sessionId: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/project", message: { role: "user", content: "remember this" } },
      { uuid: "assistant-message-1", sessionId: "session-1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "remembered" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${api.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: state,
    HONCHO_AGENT_HOOK_LOG: log,
    HONCHO_AGENT_STATE_HASH_LIMIT: "1",
  };
  const args = [COLLECTOR, "--provider", "claude", "--transcript", transcript];

  const first = JSON.parse((await execFileAsync(process.execPath, args, { env })).stdout);
  assert.equal(first.new_turns, 2);
  assert.equal(first.new_messages, 2);

  const sessionCreate = api.requests.find((entry) => entry.url === "/v3/workspaces/memory/sessions");
  assert.deepEqual(sessionCreate.body.peers, {
    user_test: { observe_me: true, observe_others: false },
    assistant_claude: { observe_me: false, observe_others: false },
  });
  const messageWrite = api.requests.find((entry) => entry.url?.endsWith("/messages"));
  assert.deepEqual(messageWrite.body.messages.map((message) => message.peer_id), ["user_test", "assistant_claude"]);
  assert.deepEqual(messageWrite.body.messages.map((message) => message.metadata.source_message_id), ["user-message-1", "assistant-message-1"]);
  assert.equal(messageWrite.body.messages.every((message) => typeof message.metadata.source_turn_hash === "string"), true);
  const stateAfterFirstRun = JSON.parse(await fsp.readFile(state, "utf8"));
  assert.equal(stateAfterFirstRun.sessions["claude-session-1"].imported_hashes.length, 2, "legacy hash caps must be ignored");

  const writesBefore = api.requests.filter((entry) => entry.url?.endsWith("/messages")).length;
  const listsBefore = api.requests.filter((entry) => entry.url?.includes("/messages/list")).length;
  const second = JSON.parse((await execFileAsync(process.execPath, args, { env })).stdout);
  assert.equal(second.new_turns, 0);
  assert.equal(second.new_messages, 0);
  assert.equal(api.requests.filter((entry) => entry.url?.endsWith("/messages")).length, writesBefore);
  assert.equal(
    api.requests.filter((entry) => entry.url?.includes("/messages/list")).length,
    listsBefore,
    "healthy sessions must not rescan their full Honcho history on every Stop hook",
  );

  await fsp.rm(state, { force: true });
  api.requests.length = 0;
  const concurrent = await Promise.all([
    execFileAsync(process.execPath, args, { env }),
    execFileAsync(process.execPath, args, { env }),
  ]);
  assert.deepEqual(
    concurrent.map((result) => JSON.parse(result.stdout).new_messages).sort((left, right) => left - right),
    [0, 2],
  );
  assert.equal(api.requests.filter((entry) => entry.url?.endsWith("/messages")).length, 1);
});

test("collector fails closed when initial state reconciliation cannot reach Honcho messages", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {}
    requests.push(request.url);
    response.setHeader("Content-Type", "application/json");
    if (request.url.includes("/messages/list")) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "temporarily unavailable" }));
    } else response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-fail-closed-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "claude.jsonl");
  await fsp.writeFile(
    transcript,
    `${JSON.stringify({ uuid: "u1", sessionId: "session-1", message: { role: "user", content: "do not duplicate me" } })}\n`,
  );
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: path.join(directory, "state.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(directory, "collector.log"),
  };

  await assert.rejects(
    execFileAsync(process.execPath, [COLLECTOR, "--provider", "claude", "--transcript", transcript], { env }),
    (error) => String(error.stderr || "").includes("Cannot safely retry"),
  );
  assert.equal(requests.some((url) => url.endsWith("/messages")), false);
});

test("collector reconciles a partially committed batch before retrying", async (t) => {
  const storedMessages = [];
  let messageWriteCount = 0;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/messages/list")) {
      const page = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("size") || 100);
      response.end(JSON.stringify({
        items: storedMessages.slice((page - 1) * size, page * size),
        total: storedMessages.length,
      }));
      return;
    }
    if (url.pathname.endsWith("/messages")) {
      messageWriteCount += 1;
      if (messageWriteCount === 2) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "simulated second-batch failure" }));
        return;
      }
      storedMessages.push(...body.messages);
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-partial-retry-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "claude.jsonl");
  const state = path.join(directory, "state.json");
  const rows = [
    ...Array.from({ length: 99 }, (_, index) => ({
      uuid: `message-${index + 1}`,
      sessionId: "session-1",
      message: { role: "user", content: `m${String(index + 1).padStart(3, "0")}` },
    })),
    { uuid: "message-100", sessionId: "session-1", message: { role: "user", content: "abcdefghijklmno" } },
    { uuid: "message-101", sessionId: "session-1", message: { role: "user", content: "last" } },
  ];
  await fsp.writeFile(
    transcript,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: state,
    HONCHO_AGENT_HOOK_LOG: path.join(directory, "collector.log"),
    HONCHO_AGENT_MESSAGE_CHAR_LIMIT: "10",
  };
  const args = [COLLECTOR, "--provider", "claude", "--transcript", transcript];

  await assert.rejects(execFileAsync(process.execPath, args, { env }));
  assert.equal(storedMessages.length, 99, "a split turn must not be divided across API batches");
  const interruptedState = JSON.parse(await fsp.readFile(state, "utf8"));
  assert.ok(interruptedState.sessions["claude-session-1"].write_in_progress);

  const retried = JSON.parse((await execFileAsync(process.execPath, args, { env })).stdout);
  assert.equal(retried.state_synced_turns, 99);
  assert.equal(retried.new_messages, 3);
  assert.equal(storedMessages.length, 102);
  assert.equal(new Set(storedMessages.map((message) => message.metadata.source_turn_hash)).size, 101);
  const completedState = JSON.parse(await fsp.readFile(state, "utf8"));
  assert.equal(completedState.sessions["claude-session-1"].write_in_progress, undefined);
});

test("collector recovery compares stored source metadata instead of guessing from message count", async (t) => {
  const storedMessages = [
    { id: "m1", content: "remember this", metadata: { claude_session_id: "claude-session-1", claude_line_index: 1, claude_role: "user" } },
    { id: "m2", content: "remembered", metadata: { claude_session_id: "claude-session-1", claude_line_index: 2, claude_role: "assistant" } },
  ];
  const api = await startApi(storedMessages);
  t.after(() => api.server.close());
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-recovery-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "claude.jsonl");
  const state = path.join(directory, "state.json");
  await fsp.writeFile(
    transcript,
    [
      { uuid: "u1", sessionId: "session-1", message: { role: "user", content: "remember this" } },
      { uuid: "a1", sessionId: "session-1", message: { role: "assistant", content: "remembered" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${api.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: state,
    HONCHO_AGENT_HOOK_LOG: path.join(directory, "collector.log"),
  };

  const result = JSON.parse(
    (await execFileAsync(process.execPath, [COLLECTOR, "--provider", "claude", "--transcript", transcript], { env })).stdout,
  );
  assert.equal(result.honcho_message_total, 2);
  assert.equal(result.state_synced_turns, 2);
  assert.equal(result.new_messages, 0);
  assert.equal(api.requests.some((entry) => entry.url?.endsWith("/messages")), false);
  const saved = JSON.parse(await fsp.readFile(state, "utf8"));
  assert.equal(saved.version, 2);
  assert.ok(saved.sessions["claude-session-1"].reconciled_source_hashes_at);
});

test("Codex subagent prompts are left out by default and, with 자동 실행 대화도 수집 on, stored as automation rather than direct user memory", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-subagent-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "codex.jsonl");
  await fsp.writeFile(
    transcript,
    [
      { type: "session_meta", payload: { id: "child", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } }, originator: "codex_cli_rs", cwd: "/tmp/project" } },
      { type: "session_meta", payload: { id: "parent", source: "cli", originator: "codex_cli_rs", cwd: "/tmp/project" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "delegated task" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "delegated result" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${api.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: path.join(directory, "state.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(directory, "collector.log"),
  };
  delete env.HONCHO_AGENT_COLLECT_AUTOMATION;
  const run = async () => JSON.parse(
    (await execFileAsync(process.execPath, [COLLECTOR, "--provider", "codex", "--transcript", transcript], { env })).stdout,
  );

  const left = await run();
  assert.equal(left.skipped, "automation");
  assert.equal(api.requests.length, 0, "nothing reaches the server");

  env.HONCHO_AGENT_COLLECT_AUTOMATION = "1";
  const result = await run();
  assert.equal(result.session_id, "codex-child");
  const sessionCreate = api.requests.find((entry) => entry.url === "/v3/workspaces/memory/sessions");
  assert.equal(sessionCreate.body.metadata.parent_session_id, "parent");
  const messageWrite = api.requests.find((entry) => entry.url?.endsWith("/messages"));
  assert.deepEqual(messageWrite.body.messages.map((message) => message.peer_id), ["automation_codex", "assistant_codex"]);
  assert.equal(messageWrite.body.messages[0].metadata.direct_user, false);
  assert.equal(messageWrite.body.messages[0].metadata.automation_kind, "codex_subagent");
});

test("Claude Agent SDK sessions are left out by default and, with 자동 실행 대화도 수집 on, stored as automation; interactive and unmarked sessions stay the person's", async (t) => {
  const api = await startApi();
  t.after(() => api.server.close());
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-claude-sdk-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${api.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: path.join(directory, "state.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(directory, "collector.log"),
  };
  delete env.HONCHO_CLAUDE_AUTOMATION_PEER;
  delete env.HONCHO_AGENT_COLLECT_AUTOMATION;
  const off = path.join(directory, "off.jsonl");
  await fsp.writeFile(
    off,
    [
      { uuid: "off-user", sessionId: "session-off", entrypoint: "sdk-cli", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/project", type: "user", message: { role: "user", content: "Current position (X black, O white, . empty):" } },
      { uuid: "off-assistant", sessionId: "session-off", entrypoint: "sdk-cli", timestamp: "2026-01-01T00:00:01Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "e5" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const left = JSON.parse((await execFileAsync(process.execPath, [COLLECTOR, "--provider", "claude", "--transcript", off], { env })).stdout);
  assert.equal(left.skipped, "automation");
  assert.equal(api.requests.length, 0, "nothing reaches the server");

  env.HONCHO_AGENT_COLLECT_AUTOMATION = "1";
  const cases = [
    { name: "sdk-cli", entrypoint: "sdk-cli", userPeer: "automation_claude" },
    { name: "sdk-ts", entrypoint: "sdk-ts", userPeer: "automation_claude" },
    { name: "cli", entrypoint: "cli", userPeer: "user_test" },
    { name: "none", entrypoint: undefined, userPeer: "user_test" },
  ];
  for (const { name, entrypoint, userPeer } of cases) {
    const transcript = path.join(directory, `${name}.jsonl`);
    const sessionId = `session-${name}`;
    await fsp.writeFile(
      transcript,
      [
        { type: "queue-operation", operation: "enqueue", sessionId },
        { uuid: `${name}-user`, sessionId, entrypoint, timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/project", type: "user", message: { role: "user", content: "Current position (X black, O white, . empty):" } },
        { uuid: `${name}-assistant`, sessionId, entrypoint, timestamp: "2026-01-01T00:00:01Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "e5" }] } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    api.requests.length = 0;
    const result = JSON.parse(
      (await execFileAsync(process.execPath, [COLLECTOR, "--provider", "claude", "--transcript", transcript], { env })).stdout,
    );
    assert.equal(result.new_messages, 2, name);
    const messageWrite = api.requests.find((entry) => entry.url?.endsWith("/messages"));
    assert.deepEqual(messageWrite.body.messages.map((message) => message.peer_id), [userPeer, "assistant_claude"], name);
    const [user, assistant] = messageWrite.body.messages.map((message) => message.metadata);
    assert.equal(assistant.direct_user, false, name);
    assert.equal(assistant.automation_kind, undefined, name);
    const sessionWrites = api.requests.filter((entry) => entry.url === "/v3/workspaces/memory/sessions");
    const lastSessionWrite = sessionWrites.at(-1);
    // The session's peers are written before its messages.
    assert.ok(api.requests.indexOf(lastSessionWrite) < api.requests.indexOf(messageWrite), name);
    if (userPeer === "automation_claude") {
      assert.equal(user.direct_user, false, name);
      assert.equal(user.memory_origin, "claude_automation", name);
      assert.equal(user.automation_kind, "claude_sdk", name);
      assert.equal(lastSessionWrite.body.metadata.entrypoint, entrypoint, name);
      assert.deepEqual(lastSessionWrite.body.peers.automation_claude, { observe_me: false, observe_others: false }, name);
    } else {
      assert.equal(user.direct_user, true, name);
      assert.equal(user.memory_origin, "claude_direct_user", name);
      assert.equal(user.automation_kind, undefined, name);
      assert.equal(sessionWrites.length, 1, name);
      assert.equal(lastSessionWrite.body.peers.automation_claude, undefined, name);
    }
  }
});
