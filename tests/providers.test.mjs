import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTranscript as parseAgy } from "../scripts/providers/agy.mjs";
import { classifyAutomation as classifyClaudeAutomation, parseTranscript as parseClaude } from "../scripts/providers/claude.mjs";
import { classifyAutomation as classifyCodexAutomation, parseTranscript as parseCodex } from "../scripts/providers/codex.mjs";
import { automationOnly, automationRecord } from "../scripts/providers/automation.mjs";

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
    { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<permissions instructions>hidden</permissions instructions>" }] } },
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

test("Claude transcript parser skips text Claude Code wrote in the user role", async (t) => {
  const file = await fixture(t, "claude-machine.jsonl", [
    { uuid: "u1", sessionId: "session-1", type: "user", message: { role: "user", content: "real question" } },
    { uuid: "u2", sessionId: "session-1", type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } },
    { uuid: "u4", sessionId: "session-1", type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    { uuid: "u5", sessionId: "session-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ]);
  const result = await parseClaude(file);
  assert.deepEqual(result.turns.map(({ role, content }) => [role, content]), [["user", "real question"], ["assistant", "answer"]]);
});

test("Claude transcript parser keeps messages typed while Claude was working", async (t) => {
  const queued = (uuid, timestamp, prompt, extra = {}) => ({
    uuid,
    sessionId: "session-1",
    timestamp,
    type: "attachment",
    attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" }, humanTurn: true, ...extra },
  });
  const file = await fixture(t, "claude-queued.jsonl", [
    { uuid: "u1", sessionId: "session-1", timestamp: "2026-01-01T00:00:00Z", type: "user", message: { role: "user", content: "make the video" } },
    { uuid: "u2", sessionId: "session-1", timestamp: "2026-01-01T00:00:05Z", type: "queue-operation", operation: "enqueue", content: "rename it" },
    queued("u3", "2026-01-01T00:00:05Z", "rename it"),
    queued("u4", "2026-01-01T00:00:06Z", "<task-notification>done</task-notification>", { commandMode: "task-notification", origin: { kind: "task-notification" }, humanTurn: undefined }),
    queued("u5", "2026-01-01T00:00:07Z", "message from another session", { origin: { kind: "peer" }, humanTurn: undefined }),
    { uuid: "u6", sessionId: "session-1", timestamp: "2026-01-01T00:00:09Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "renamed" }] } },
    { uuid: "u7", sessionId: "session-1", timestamp: "2026-01-01T00:01:00Z", type: "user", message: { role: "user", content: "show it on screen" } },
    queued("u8", "2026-01-01T00:01:08Z", "show it on screen"),
    { uuid: "u9", sessionId: "session-1", timestamp: "2026-01-01T00:02:00Z", type: "user", message: { role: "user", content: "ok" } },
    queued("u10", "2026-01-01T01:30:00Z", [{ type: "text", text: "ok" }]),
  ]);
  const result = await parseClaude(file);
  assert.deepEqual(result.turns.map(({ role, content }) => [role, content]), [
    ["user", "make the video"],
    ["user", "rename it"],
    ["assistant", "renamed"],
    ["user", "show it on screen"],
    ["user", "show it on screen"],
    ["user", "ok"],
    ["user", "ok"],
  ]);
  assert.equal(result.turns[1].source_message_id, "u3");
  assert.equal(result.turns[1].created_at, "2026-01-01T00:00:05Z");
});

test("Claude transcript parser drops bare slash commands and synthetic API error rows", async (t) => {
  const file = await fixture(t, "claude-noise.jsonl", [
    { uuid: "u1", sessionId: "session-1", timestamp: "2026-01-01T00:00:00Z", type: "user", message: { role: "user", content: "/compact" } },
    { uuid: "u2", sessionId: "session-1", timestamp: "2026-01-01T00:00:01Z", type: "user", message: { role: "user", content: "/ㄷ턋" } },
    { uuid: "u3", sessionId: "session-1", timestamp: "2026-01-01T00:00:02Z", type: "user", message: { role: "user", content: "/compact 하고 이어서 해" } },
    { uuid: "u4", sessionId: "session-1", timestamp: "2026-01-01T00:00:03Z", type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] } },
    { uuid: "u5", sessionId: "session-1", timestamp: "2026-01-01T00:00:04Z", type: "attachment", attachment: { type: "queued_command", prompt: "/compact", commandMode: "prompt", origin: { kind: "human" } } },
    { uuid: "u6", sessionId: "session-1", timestamp: "2026-01-01T00:00:05Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ]);
  const result = await parseClaude(file);
  assert.deepEqual(result.turns.map(({ role, content }) => [role, content]), [
    ["user", "/compact 하고 이어서 해"],
    ["assistant", "done"],
  ]);
});

test("Codex transcript parser drops app-injected context", async (t) => {
  const user = (text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const file = await fixture(t, "codex-machine.jsonl", [
    { type: "session_meta", payload: { id: "session-2", cwd: "/tmp/project" } },
    user("<recommended_plugins>\n- Notion\n</recommended_plugins>\n\n# AGENTS.md instructions\n\n<INSTRUCTIONS>policy</INSTRUCTIONS>"),
    user("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"),
    user('<hook_prompt hook_run_id="stop-1">keep going</hook_prompt>'),
    user('<skill>\n---\nname: "imagegen"\n---\n</skill>'),
    user('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
    user("<codex_delegation>\n<input>report the current state</input>\n</codex_delegation>"),
    user("real question"),
  ]);
  const result = await parseCodex(file);
  assert.deepEqual(result.turns.map(({ role, content }) => [role, content]), [["user", "real question"]]);
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

test("Claude transcript parser takes the entrypoint from the first record that has one", async (t) => {
  const file = await fixture(t, "claude-sdk.jsonl", [
    { type: "queue-operation", operation: "enqueue", sessionId: "session-1" },
    { type: "attachment", entrypoint: "sdk-cli", sessionId: "session-1", attachment: { type: "skill_listing" } },
    { uuid: "u1", sessionId: "session-1", entrypoint: "sdk-cli", type: "user", message: { role: "user", content: "Current position (X black, O white, . empty):" } },
    { uuid: "u2", sessionId: "session-1", entrypoint: "cli", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "e5" }] } },
  ]);
  const result = await parseClaude(file);
  assert.equal(result.metadata.entrypoint, "sdk-cli");
  assert.deepEqual(classifyClaudeAutomation("Current position", result.metadata), [true, "claude_sdk"]);
});

test("Claude automation classifier treats only sdk-* entrypoints as automation", () => {
  assert.deepEqual(classifyClaudeAutomation("x", { entrypoint: "sdk-cli" }), [true, "claude_sdk"]);
  assert.deepEqual(classifyClaudeAutomation("x", { entrypoint: "sdk-ts" }), [true, "claude_sdk"]);
  assert.deepEqual(classifyClaudeAutomation("x", { entrypoint: "sdk-py" }), [true, "claude_sdk"]);
  for (const entrypoint of ["cli", "claude-vscode", "claude-desktop", "", undefined]) {
    assert.deepEqual(classifyClaudeAutomation("x", { entrypoint }), [false, null], String(entrypoint));
  }
  assert.deepEqual(classifyClaudeAutomation("x", {}), [false, null]);
});

test("a conversation is a program's only when every prompt in it is; the person typing once makes it theirs", () => {
  const parsed = (metadata, ...prompts) => ({ metadata, turns: prompts.flatMap((content) => [{ role: "user", content }, { role: "assistant", content: "ok" }]) });
  const cli = { originator: "codex_cli_rs", source_app: "cli", cwd: "/w" };
  assert.equal(automationOnly("codex", parsed(cli, "Automation: check the build", "Automation: check it again")), true);
  assert.equal(automationOnly("codex", parsed(cli, "Automation: check the build", "why did it fail?")), false, "the person answered in it");
  assert.equal(automationOnly("codex", parsed(cli, "hello")), false);
  assert.equal(automationOnly("codex", parsed({ ...cli, source_app: "exec" }, "run the tests")), true);
  assert.equal(automationOnly("claude", parsed({ entrypoint: "sdk-cli" }, "x")), true);
  assert.equal(automationOnly("claude", parsed({ entrypoint: "cli" }, "x")), false);
  assert.equal(automationOnly("codex", { metadata: cli, turns: [] }), false, "a conversation with nothing said is decided elsewhere");
  assert.equal(automationOnly("chatgpt", parsed({}, "x")), false, "a ChatGPT conversation is the person's");

  // The line the folder list reads: Codex's session_meta, or Claude Code's first record with a folder.
  const meta = (payload) => ({ type: "session_meta", payload: { cwd: "/w", originator: "codex_cli_rs", source: "cli", ...payload } });
  assert.equal(automationRecord("codex", meta({ thread_source: "automation" })), true);
  assert.equal(automationRecord("codex", meta({ thread_source: "user" })), false);
  assert.equal(automationRecord("codex", meta({ cwd: "/" })), true);
  assert.equal(automationRecord("codex", meta({ source: { subagent: { thread_spawn: {} } } })), true);
  assert.equal(automationRecord("claude", { cwd: "/w", entrypoint: "sdk-ts" }), true);
  assert.equal(automationRecord("claude", { cwd: "/w", entrypoint: "cli" }), false);
  assert.equal(automationRecord("agy", { cwd: "/w" }), false);
});
