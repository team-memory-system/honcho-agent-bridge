import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTranscript as parseAgy } from "../scripts/providers/agy.mjs";
import { parseTranscript as parseClaude } from "../scripts/providers/claude.mjs";
import { classifyAutomation as classifyCodexAutomation, parseTranscript as parseCodex } from "../scripts/providers/codex.mjs";

async function fixture(t, name, rows) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-sync-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  await fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

test("Codex transcript parser keeps dialogue and removes injected policy text", async (t) => {
  const file = await fixture(t, "codex.jsonl", [
    { type: "session_meta", payload: { id: "session-1", cwd: "/tmp/project" } },
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<permissions instructions>hidden" }] } },
    { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
  ]);
  const result = await parseCodex(file);
  assert.equal(result.session_id, "codex-session-1");
  assert.deepEqual(result.turns.map(({ role, content }) => [role, content]), [["user", "hello"], ["assistant", "hi"]]);
});

test("Codex transcript parser keeps the current child id and records the following parent session_meta", async (t) => {
  const file = await fixture(t, "codex-fork.jsonl", [
    { type: "session_meta", payload: { id: "current-child", cwd: "/tmp/child", source: { subagent: { thread_spawn: { parent_thread_id: "parent-session" } } } } },
    { type: "session_meta", payload: { id: "parent-session", cwd: "/tmp/parent" } },
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello from fork" }] } },
  ]);
  const result = await parseCodex(file);
  assert.equal(result.session_id, "codex-current-child");
  assert.equal(result.metadata.original_session_id, "current-child");
  assert.equal(result.metadata.parent_session_id, "parent-session");
  assert.equal(result.metadata.cwd, "/tmp/child");
  assert.deepEqual(classifyCodexAutomation("delegated task", result.metadata), [true, "codex_subagent"]);
});

test("Claude transcript parser ignores sidechains and tool-result carrier rows", async (t) => {
  const file = await fixture(t, "claude.jsonl", [
    { uuid: "u1", sessionId: "session-1", timestamp: "2026-01-01T00:00:00Z", type: "user", message: { role: "user", content: "hello" } },
    { uuid: "u2", sessionId: "session-1", timestamp: "2026-01-01T00:00:01Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    { uuid: "u3", sessionId: "session-1", type: "user", message: { role: "user", content: [{ type: "tool_result", content: "noise" }] } },
    { uuid: "u4", sessionId: "session-1", isSidechain: true, type: "assistant", message: { role: "assistant", content: "sidechain" } },
  ]);
  const result = await parseClaude(file);
  assert.deepEqual(result.turns.map(({ role, content }) => [role, content]), [["user", "hello"], ["assistant", "hi"]]);
});

test("Agy transcript parser preserves user text that resembles instructions", async (t) => {
  const file = await fixture(t, "transcript_full.jsonl", [
    { status: "DONE", source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST># AGENTS.md instructions for my app</USER_REQUEST>" },
    { status: "DONE", source: "MODEL", type: "PLANNER_RESPONSE", content: "understood" },
    { status: "PENDING", source: "MODEL", type: "PLANNER_RESPONSE", content: "unfinished" },
  ]);
  const result = await parseAgy(file, { conversationId: "conversation-1" });
  assert.equal(result.session_id, "agy-conversation-1");
  assert.deepEqual(result.turns.map(({ role, content }) => [role, content]), [["user", "# AGENTS.md instructions for my app"], ["assistant", "understood"]]);
});
