// The backup of agy (Antigravity) and Grok CLI conversations: only their main
// transcripts and agy's prompt history, each conversation in its own folder under
// the KST day it started, because every conversation's files have the same names.
// Every id, path and line here is made up.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBackup } from "../scripts/backup.mjs";
import { agySessionStart, discoverSources, grokSessionStart, kstDateFolder } from "../scripts/backup-sources.mjs";

const AGY_CLI = "aaaaaaaa-1111-4111-8111-111111111111";
const AGY_APP = "bbbbbbbb-2222-4222-8222-222222222222";
const AGY_ONLY_OLD = "cccccccc-3333-4333-8333-333333333333";
const GROK = "01a10000-0000-7000-8000-000000000001";
const GROK_NO_SUMMARY = "01a1f2d3-c000-7000-8000-000000000002";
const GROK_EMPTY = "01a10000-0000-7000-8000-000000000003";
const GROK_GROUP = encodeURIComponent("/tmp/grok-fixture-project");

const line = (value) => `${JSON.stringify(value)}\n`;

async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `backup-agy-grok-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(target, content) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

const agyStep = (createdAt, stepIndex) => line({ step_index: stepIndex, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: createdAt, content: "<USER_REQUEST>hello</USER_REQUEST>" });

async function makeHome(t) {
  const home = await temporaryDirectory(t, "home");
  const cliLogs = path.join(home, ".gemini", "antigravity-cli", "brain", AGY_CLI, ".system_generated", "logs");
  // 2026-09-26 16:30 UTC is 2026-09-27 in Korea.
  await put(path.join(cliLogs, "transcript_full.jsonl"), agyStep("2026-09-26T16:30:00Z", 0) + agyStep("2026-09-26T16:31:00Z", 1));
  await put(path.join(cliLogs, "transcript.jsonl"), agyStep("2026-09-26T16:30:00Z", 0));
  await put(path.join(cliLogs, "overview.txt"), "not a transcript");
  await put(path.join(home, ".gemini", "antigravity-cli", "brain", AGY_CLI, "task.md"), "an artifact");
  await put(path.join(home, ".gemini", "antigravity-cli", "brain", AGY_CLI, "screenshot.png"), "image bytes");
  await put(path.join(home, ".gemini", "antigravity", "brain", AGY_APP, ".system_generated", "logs", "transcript.jsonl"), agyStep("2026-05-20T01:00:00Z", 0));
  await put(path.join(home, ".gemini", "antigravity-cli", "brain", AGY_ONLY_OLD, ".system_generated", "logs", "transcript.jsonl"), agyStep("2026-06-01T10:00:00Z", 0));
  await put(path.join(home, ".gemini", "antigravity-cli", "history.jsonl"), line({ display: "hello", timestamp: 1, workspace: "/w", conversationId: AGY_CLI }));
  await put(path.join(home, ".gemini", "antigravity-cli", "conversations", `${AGY_CLI}.db`), "app state");
  await put(path.join(home, ".gemini", "settings.json"), "{}");

  const sessions = path.join(home, ".grok", "sessions", GROK_GROUP);
  await put(path.join(sessions, GROK, "chat_history.jsonl"), line({ type: "system", content: "x" }) + line({ type: "user", prompt_index: 0, content: [{ type: "text", text: "<user_query>hi</user_query>" }] }));
  await put(path.join(sessions, GROK, "updates.jsonl"), line({ timestamp: 1790000000, method: "_x.ai/session/update" }));
  await put(path.join(sessions, GROK, "summary.json"), JSON.stringify({ info: { id: GROK, cwd: "/tmp/grok-fixture-project" }, created_at: "2026-09-05T03:45:31.105200Z" }));
  await put(path.join(sessions, GROK, "system_prompt.txt"), "prompt");
  await put(path.join(sessions, GROK, "events.jsonl"), line({ type: "mcp_init" }));
  await put(path.join(sessions, GROK_NO_SUMMARY, "chat_history.jsonl"), line({ type: "system", content: "x" }));
  await put(path.join(sessions, GROK_EMPTY, "summary.json"), JSON.stringify({ created_at: "2026-09-05T01:30:14Z", num_messages: 0 }));
  await put(path.join(home, ".grok", "sessions", "session_search.sqlite"), "index");
  await put(path.join(home, ".grok", "auth.json"), "{\"secret\":true}");
  return home;
}

async function listTree(root) {
  const found = [];
  async function walk(directory, prefix) {
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), rel);
      else found.push(rel);
    }
  }
  await walk(root, "");
  return found.sort();
}

test("an agy conversation starts at its transcript's first created_at", async (t) => {
  const home = await makeHome(t);
  const start = await agySessionStart(path.join(home, ".gemini", "antigravity-cli", "brain", AGY_CLI, ".system_generated", "logs", "transcript_full.jsonl"));
  assert.deepEqual(start, { startedAt: "2026-09-26T16:30:00Z", basis: "first-record" });
  assert.equal(kstDateFolder(start.startedAt), "2026/09/27");
});

test("a Grok session starts at summary.json's created_at, else at the time in its UUIDv7 id", async (t) => {
  const home = await makeHome(t);
  const sessions = path.join(home, ".grok", "sessions", GROK_GROUP);
  assert.deepEqual(await grokSessionStart(path.join(sessions, GROK, "chat_history.jsonl")), { startedAt: "2026-09-05T03:45:31.105200Z", basis: "summary" });
  const fromId = await grokSessionStart(path.join(sessions, GROK_NO_SUMMARY, "chat_history.jsonl"));
  assert.equal(fromId.basis, "session-id");
  assert.equal(fromId.startedAt, new Date(0x01a1f2d3c000).toISOString());
});

test("discovery takes agy and Grok main transcripts and agy's history, and only counts the rest", async (t) => {
  const home = await makeHome(t);
  const { items, excluded } = await discoverSources({ homeDir: home, agents: ["agy", "grok"] });
  assert.deepEqual(items.map((item) => `${item.agent}/${item.kind}/${item.session || "-"}/${item.name}`).sort(), [
    `agy/history/-/history.jsonl`,
    `agy/main/${AGY_APP}/transcript.jsonl`,
    `agy/main/${AGY_CLI}/transcript.jsonl`,
    `agy/main/${AGY_CLI}/transcript_full.jsonl`,
    `agy/main/${AGY_ONLY_OLD}/transcript.jsonl`,
    `grok/main/${GROK}/chat_history.jsonl`,
    `grok/main/${GROK}/updates.jsonl`,
    `grok/main/${GROK_NO_SUMMARY}/chat_history.jsonl`,
  ].sort());
  assert.deepEqual(excluded, { "agy/other": 3, "grok/other": 4, "grok/search-index": 1 });
});

test("each agy and Grok conversation gets its own folder under its KST start day, byte for byte", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const dataDir = await temporaryDirectory(t, "data");
  const result = await runBackup({ destination: { kind: "folder", path: dest }, homeDir: home, dataDir, device: "studio" });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const root = path.join(dest, "대화");
  const grokDay = kstDateFolder(new Date(0x01a1f2d3c000).toISOString());
  assert.deepEqual(await listTree(root), [
    "agy/2026/05/20/" + AGY_APP + "/transcript.jsonl",
    "agy/2026/06/01/" + AGY_ONLY_OLD + "/transcript.jsonl",
    "agy/2026/09/27/" + AGY_CLI + "/transcript.jsonl",
    "agy/2026/09/27/" + AGY_CLI + "/transcript_full.jsonl",
    "agy/_부속자료/studio/history.jsonl",
    "grok/2026/09/05/" + GROK + "/chat_history.jsonl",
    "grok/2026/09/05/" + GROK + "/updates.jsonl",
    `grok/${grokDay}/${GROK_NO_SUMMARY}/chat_history.jsonl`,
  ].sort());
  assert.equal(result.counts.new, 8);
  const local = path.join(home, ".gemini", "antigravity-cli", "brain", AGY_CLI, ".system_generated", "logs", "transcript_full.jsonl");
  const copied = path.join(root, "agy", "2026", "09", "27", AGY_CLI, "transcript_full.jsonl");
  assert.deepEqual(await fsp.readFile(copied), await fsp.readFile(local));

  // The conversation goes on the next day; its files stay where they are and grow there.
  await fsp.appendFile(local, agyStep("2026-09-28T02:00:00Z", 2));
  const again = await runBackup({ destination: { kind: "folder", path: dest }, homeDir: home, dataDir, device: "studio" });
  assert.equal(again.counts["prefix-replace"], 1);
  assert.equal(again.counts.new, 0);
  assert.deepEqual(await fsp.readFile(copied), await fsp.readFile(local));
});
