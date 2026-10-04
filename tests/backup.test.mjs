import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { backupCommand, defaultDeviceId, hashLocal, runBackup, validDeviceId } from "../scripts/backup.mjs";
import { claudeSessionStart, codexSessionMeta, discoverSources, kstDateFolder } from "../scripts/backup-sources.mjs";
import { folderStore, parseCloudDestination, rcloneMessage, rcloneStore } from "../scripts/backup-store.mjs";
import {
  BACKUP_LAUNCHD_LABEL,
  backupScheduleSpec,
  installBackupSchedule,
  removeBackupSchedule,
  scheduleMinute,
} from "../scripts/backup-schedule.mjs";
import { backupSetInvocation } from "../scripts/ui.mjs";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_FALLBACK_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_MAIN = "rollout-2026-09-02T01-30-00-01a0aaaa-0000-7000-8000-000000000001.jsonl";
const CODEX_SUB = "rollout-2026-09-02T01-31-00-01a0aaaa-0000-7000-8000-000000000002.jsonl";
const CODEX_LEGACY = "rollout-2025-09-05T23-31-25-4bb054bf-b75b-4218-8588-595383055fed.jsonl";
const CODEX_ARCHIVED = "rollout-2026-08-10T12-00-00-01a0bbbb-0000-7000-8000-000000000003.jsonl";
const CODEX_ARCHIVED_SUB = "rollout-2026-08-10T12-05-00-01a0bbbb-0000-7000-8000-000000000004.jsonl";
const PROJECT = "-Users-me-dev-app";

const line = (value) => `${JSON.stringify(value)}\n`;
const md5 = (bytes) => crypto.createHash("md5").update(bytes).digest("hex");

async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `backup-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(target, content) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

function codexMeta(timestamp, source = "vscode") {
  return line({ timestamp, type: "session_meta", payload: { id: "x", timestamp, source, cwd: "/w" } });
}

/** A home folder with one of every kind of file the apps keep. */
async function makeHome(t) {
  const home = await temporaryDirectory(t, "home");
  const claude = path.join(home, ".claude");
  const codex = path.join(home, ".codex");
  const projectDir = path.join(claude, "projects", PROJECT);
  await put(path.join(projectDir, `${CLAUDE_ID}.jsonl`),
    line({ type: "last-prompt", sessionId: CLAUDE_ID, leafUuid: "a" })
    + line({ type: "user", sessionId: "33333333-3333-4333-8333-333333333333", timestamp: "2026-03-19T10:00:00.000Z" })
    + line({ type: "user", sessionId: CLAUDE_ID, timestamp: "2026-03-19T15:10:00.000Z", message: { content: "안녕" } }));
  await put(path.join(projectDir, `${CLAUDE_FALLBACK_ID}.jsonl`),
    line({ type: "summary", summary: "x" })
    + line({ type: "user", sessionId: "44444444-4444-4444-8444-444444444444", timestamp: "2026-05-01T14:59:59.000Z" }));
  await put(path.join(projectDir, CLAUDE_ID, "subagents", "agent-a1.jsonl"), line({ type: "user", isSidechain: true }));
  await put(path.join(projectDir, CLAUDE_ID, "subagents", "agent-a1.meta.json"), "{}");
  await put(path.join(projectDir, CLAUDE_ID, "tool-results", "b1.txt"), "tool output");
  await put(path.join(projectDir, "agent-0ld.jsonl"), line({ type: "user", isSidechain: true }));
  // A session that never got a message: Claude leaves a one-line stub without a timestamp.
  await put(path.join(projectDir, "55555555-5555-4555-8555-555555555555.jsonl"), line({ type: "bridge-session", sessionId: "55555555-5555-4555-8555-555555555555" }));
  await put(path.join(projectDir, "memory", "MEMORY.md"), "- [note](note.md)\n");
  await put(path.join(projectDir, "memory", "note.md"), "---\nname: note\n---\nbody\n");
  await put(path.join(projectDir, "memory", "image.png"), "not a note");
  await put(path.join(claude, "history.jsonl"), line({ display: "claude prompt" }));
  await put(path.join(claude, "sessions", "123.json"), "{}");
  await put(path.join(claude, "settings.json"), "{}");

  await put(path.join(codex, "sessions", "2026", "09", "01", CODEX_MAIN), codexMeta("2026-09-01T16:30:00.000Z") + line({ type: "event_msg" }));
  await put(path.join(codex, "sessions", "2026", "09", "01", CODEX_SUB), codexMeta("2026-09-01T16:31:00.000Z", { subagent: { thread_spawn: { parent_thread_id: "p", depth: 1 } } }));
  await put(path.join(codex, "sessions", "2025", "09", "05", CODEX_LEGACY), line({ id: "4bb054bf", timestamp: "2025-09-05T23:31:25.580Z", instructions: null }) + line({ record_type: "state" }));
  await put(path.join(codex, "archived_sessions", CODEX_ARCHIVED), codexMeta("2026-08-10T03:00:00.000Z") + line({ type: "event_msg", n: 1 }));
  await put(path.join(codex, "archived_sessions", CODEX_ARCHIVED_SUB), codexMeta("2026-08-10T03:05:00.000Z", { subagent: "review" }));
  // A stale copy of the archived session left in sessions/ (found by its id, whatever its name says).
  await put(path.join(codex, "sessions", "2026", "08", "10", "rollout-2026-08-10T11-59-59-01a0bbbb-0000-7000-8000-000000000003.jsonl"), codexMeta("2026-08-10T03:00:00.000Z"));
  await put(path.join(codex, "history.jsonl"), line({ text: "codex prompt" }));
  await put(path.join(codex, "auth.json"), "{\"secret\":true}");
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

async function backupTo(home, folder, { device = "studio", dataDir, ...rest } = {}) {
  return runBackup({ destination: { kind: "folder", path: folder }, homeDir: home, dataDir, device, ...rest });
}

// ------------------------------------------------------------- dates (KST)

test("the start day is the day in Korea, whatever the UTC date", () => {
  assert.equal(kstDateFolder("2026-10-04T14:27:19.645Z"), "2026/10/04");
  assert.equal(kstDateFolder("2026-10-04T14:59:59.999Z"), "2026/10/04");
  assert.equal(kstDateFolder("2026-10-04T15:00:00.000Z"), "2026/10/05");
  assert.equal(kstDateFolder("2026-12-31T15:30:00.000Z"), "2027/01/01");
  assert.equal(kstDateFolder("2026-03-01T00:00:00+09:00"), "2026/03/01");
  assert.equal(kstDateFolder("not a date"), null);
  assert.equal(kstDateFolder(undefined), null);
});

test("a Claude session starts at its own first record; another session's record is only the fallback", async (t) => {
  const home = await makeHome(t);
  const projectDir = path.join(home, ".claude", "projects", PROJECT);
  const own = await claudeSessionStart(path.join(projectDir, `${CLAUDE_ID}.jsonl`));
  assert.deepEqual(own, { startedAt: "2026-03-19T15:10:00.000Z", basis: "own-record" });
  assert.equal(kstDateFolder(own.startedAt), "2026/03/20");
  const fallback = await claudeSessionStart(path.join(projectDir, `${CLAUDE_FALLBACK_ID}.jsonl`));
  assert.deepEqual(fallback, { startedAt: "2026-05-01T14:59:59.000Z", basis: "first-record" });
  assert.equal(kstDateFolder(fallback.startedAt), "2026/05/01");
});

test("a Codex session starts at session_meta's timestamp, or the 2025 header's", async (t) => {
  const home = await makeHome(t);
  const sessions = path.join(home, ".codex", "sessions");
  const main = await codexSessionMeta(path.join(sessions, "2026", "09", "01", CODEX_MAIN));
  assert.equal(main.subagent, false);
  assert.equal(kstDateFolder(main.startedAt), "2026/09/02");
  const legacy = await codexSessionMeta(path.join(sessions, "2025", "09", "05", CODEX_LEGACY));
  assert.equal(legacy.basis, "header");
  assert.equal(kstDateFolder(legacy.startedAt), "2025/09/06");
  const sub = await codexSessionMeta(path.join(sessions, "2026", "09", "01", CODEX_SUB));
  assert.equal(sub.subagent, true);
});

test("each transcript lands in the folder of its KST start day, and stays there as it grows", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const dataDir = await temporaryDirectory(t, "data");
  await backupTo(home, dest, { dataDir });
  const root = path.join(dest, "대화");
  const files = await listTree(root);
  assert.ok(files.includes(`claude/2026/03/20/${CLAUDE_ID}.jsonl`));
  assert.ok(files.includes(`claude/2026/05/01/${CLAUDE_FALLBACK_ID}.jsonl`));
  assert.ok(files.includes(`codex/2026/09/02/${CODEX_MAIN}`));
  assert.ok(files.includes(`codex/2025/09/06/${CODEX_LEGACY}`));
  // A day later the conversation goes on; its file does not move.
  await fsp.appendFile(path.join(home, ".claude", "projects", PROJECT, `${CLAUDE_ID}.jsonl`),
    line({ type: "user", sessionId: CLAUDE_ID, timestamp: "2026-03-21T02:00:00.000Z" }));
  const again = await backupTo(home, dest, { dataDir });
  assert.equal(again.counts["prefix-replace"], 1);
  assert.deepEqual(await listTree(root), files);
});

// ------------------------------------------------------------- selection

test("only main transcripts, history.jsonl and Claude memory notes are copied, byte for byte", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const result = await backupTo(home, dest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const root = path.join(dest, "대화");
  assert.deepEqual(await listTree(root), [
    `claude/2026/03/20/${CLAUDE_ID}.jsonl`,
    `claude/2026/05/01/${CLAUDE_FALLBACK_ID}.jsonl`,
    `claude/_부속자료/projects/${PROJECT}/memory/MEMORY.md`,
    `claude/_부속자료/projects/${PROJECT}/memory/note.md`,
    "claude/_부속자료/studio/history.jsonl",
    `codex/2025/09/06/${CODEX_LEGACY}`,
    `codex/2026/09/02/${CODEX_MAIN}`,
    "codex/_부속자료/studio/history.jsonl",
    `codex/_아카이브/2026/08/10/${CODEX_ARCHIVED}`,
  ].sort());
  assert.deepEqual(result.excluded, {
    "claude/subagent": 3,
    "claude/tool-result": 1,
    "claude/no-records-yet": 1,
    "codex/duplicate-of-archived": 1,
    "codex/subagent": 1,
    "codex/archived-subagent": 1,
  });
  assert.equal(result.counts.new, 9);
  for (const [from, to] of [
    [`.claude/projects/${PROJECT}/${CLAUDE_ID}.jsonl`, `claude/2026/03/20/${CLAUDE_ID}.jsonl`],
    [".codex/history.jsonl", "codex/_부속자료/studio/history.jsonl"],
    [`.claude/projects/${PROJECT}/memory/note.md`, `claude/_부속자료/projects/${PROJECT}/memory/note.md`],
  ]) {
    assert.deepEqual(await fsp.readFile(path.join(root, to)), await fsp.readFile(path.join(home, from)), `${to} is not byte-exact`);
  }
});

test("discovery reads no content and sorts kinds by where the files sit", async (t) => {
  const home = await makeHome(t);
  const { items, excluded } = await discoverSources({ homeDir: home });
  const kinds = items.map((item) => `${item.agent}/${item.kind}/${item.name}`).sort();
  assert.deepEqual(kinds, [
    `claude/history/history.jsonl`,
    `claude/main/${CLAUDE_FALLBACK_ID}.jsonl`,
    `claude/main/${CLAUDE_ID}.jsonl`,
    "claude/main/55555555-5555-4555-8555-555555555555.jsonl",
    "claude/memory/MEMORY.md",
    "claude/memory/note.md",
    `codex/archived/${CODEX_ARCHIVED}`,
    `codex/archived/${CODEX_ARCHIVED_SUB}`,
    "codex/history/history.jsonl",
    `codex/main/${CODEX_LEGACY}`,
    `codex/main/${CODEX_MAIN}`,
    `codex/main/${CODEX_SUB}`,
  ].sort());
  assert.deepEqual(excluded, { "claude/subagent": 3, "claude/tool-result": 1, "codex/duplicate-of-archived": 1 });
});

// ------------------------------------------------------------- archive

test("an archived Codex session goes under _아카이브, and its copy in the normal folder moves there", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const local = await fsp.readFile(path.join(home, ".codex", "archived_sessions", CODEX_ARCHIVED));
  const normal = path.join(dest, "대화", "codex", "2026", "08", "10", CODEX_ARCHIVED);
  // Backed up before it was archived, when it was shorter.
  await put(normal, local.subarray(0, 40));
  const result = await backupTo(home, dest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.counts["archive-moves"], 1);
  assert.equal(result.counts["prefix-replace"], 1);
  assert.deepEqual(result.examples["archive-moves"]["codex/archived"][0].to, `codex/_아카이브/2026/08/10/${CODEX_ARCHIVED}`);
  await assert.rejects(fsp.access(normal), "the normal-folder copy is still there");
  assert.deepEqual(await fsp.readFile(path.join(dest, "대화", "codex", "_아카이브", "2026", "08", "10", CODEX_ARCHIVED)), local);
});

test("an archived session already in _아카이브 and a different copy in the normal folder: both kept, in _아카이브 only", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const local = await fsp.readFile(path.join(home, ".codex", "archived_sessions", CODEX_ARCHIVED));
  const archiveDir = path.join(dest, "대화", "codex", "_아카이브", "2026", "08", "10");
  const normal = path.join(dest, "대화", "codex", "2026", "08", "10", CODEX_ARCHIVED);
  await put(path.join(archiveDir, CODEX_ARCHIVED), local);
  const other = Buffer.from("someone else's different bytes\n");
  await put(normal, other);
  const result = await backupTo(home, dest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.counts["archive-moves"], 1);
  await assert.rejects(fsp.access(normal));
  const moved = path.join(archiveDir, CODEX_ARCHIVED.replace(/\.jsonl$/, ".pre-archive.jsonl"));
  assert.deepEqual(await fsp.readFile(moved), other);
  assert.deepEqual(await fsp.readFile(path.join(archiveDir, CODEX_ARCHIVED)), local);

  // A second differing copy turns up later: .pre-archive is taken, so its md5 goes in the name.
  const another = Buffer.from("a third version\n");
  await put(normal, another);
  const again = await backupTo(home, dest, { full: true });
  assert.equal(again.counts["archive-moves"], 1);
  assert.deepEqual(await fsp.readFile(path.join(archiveDir, CODEX_ARCHIVED.replace(/\.jsonl$/, `.pre-archive.${md5(another).slice(0, 8)}.jsonl`))), another);
  assert.deepEqual(await fsp.readFile(moved), other);
});

test("a copy from before Codex rewrote the session at archiving is kept as .pre-archive, and the archived file takes the name", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const local = await fsp.readFile(path.join(home, ".codex", "archived_sessions", CODEX_ARCHIVED));
  const normal = path.join(dest, "대화", "codex", "2026", "08", "10", CODEX_ARCHIVED);
  // The pre-archive format: no `ordinal`, so not a byte prefix of the archived file.
  const before = Buffer.from(line({ timestamp: "2026-08-10T03:00:00.000Z", type: "session_meta", payload: { id: "x" } }));
  await put(normal, before);
  const result = await backupTo(home, dest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.counts["archive-moves"], 1);
  assert.equal(result.counts["keep-both"], 0);
  const archiveDir = path.join(dest, "대화", "codex", "_아카이브", "2026", "08", "10");
  assert.deepEqual(await listTree(archiveDir), [CODEX_ARCHIVED, CODEX_ARCHIVED.replace(/\.jsonl$/, ".pre-archive.jsonl")].sort());
  assert.deepEqual(await fsp.readFile(path.join(archiveDir, CODEX_ARCHIVED)), local);
  assert.deepEqual(await fsp.readFile(path.join(archiveDir, CODEX_ARCHIVED.replace(/\.jsonl$/, ".pre-archive.jsonl"))), before);
  await assert.rejects(fsp.access(normal));
});

test("an identical copy in the normal folder collapses into the one in _아카이브", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const local = await fsp.readFile(path.join(home, ".codex", "archived_sessions", CODEX_ARCHIVED));
  const archived = path.join(dest, "대화", "codex", "_아카이브", "2026", "08", "10", CODEX_ARCHIVED);
  const normal = path.join(dest, "대화", "codex", "2026", "08", "10", CODEX_ARCHIVED);
  await put(archived, local);
  await put(normal, local);
  const result = await backupTo(home, dest);
  assert.equal(result.counts["archive-moves"], 1);
  assert.equal(result.counts.new, 8);
  await assert.rejects(fsp.access(normal));
  assert.deepEqual(await fsp.readFile(archived), local);
  assert.deepEqual((await listTree(path.dirname(archived))), [CODEX_ARCHIVED]);
});

// ------------------------------------------------------------- conflicts

test("a destination file that is a byte prefix is replaced, even when its mtime is newer", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const source = path.join(home, ".codex", "sessions", "2026", "09", "01", CODEX_MAIN);
  const target = path.join(dest, "대화", "codex", "2026", "09", "02", CODEX_MAIN);
  const local = await fsp.readFile(source);
  await put(target, local.subarray(0, local.length - 5));
  const future = new Date(Date.now() + 86_400_000);
  await fsp.utimes(target, future, future);
  const result = await backupTo(home, dest);
  assert.equal(result.counts["prefix-replace"], 1);
  assert.equal(result.examples["prefix-replace"]["codex/main"][0].replacedSize, local.length - 5);
  assert.deepEqual(await fsp.readFile(target), local);
});

test("a different destination file is kept, and this computer's goes beside it under a device-tagged name, even when it is older", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const dataDir = await temporaryDirectory(t, "data");
  const source = path.join(home, ".claude", "projects", PROJECT, `${CLAUDE_ID}.jsonl`);
  const dayDir = path.join(dest, "대화", "claude", "2026", "03", "20");
  const theirs = Buffer.from(line({ type: "user", sessionId: CLAUDE_ID, timestamp: "2026-03-19T15:10:00.000Z", from: "another computer" }));
  await put(path.join(dayDir, `${CLAUDE_ID}.jsonl`), theirs);
  const past = new Date("2020-01-01T00:00:00Z");
  await fsp.utimes(path.join(dayDir, `${CLAUDE_ID}.jsonl`), past, past);
  const first = await backupTo(home, dest, { dataDir });
  assert.equal(first.counts["keep-both"], 1);
  assert.equal(first.examples["keep-both"]["claude/main"][0].to, `claude/2026/03/20/${CLAUDE_ID}.studio.jsonl`);
  assert.deepEqual(await fsp.readFile(path.join(dayDir, `${CLAUDE_ID}.jsonl`)), theirs);
  assert.deepEqual(await fsp.readFile(path.join(dayDir, `${CLAUDE_ID}.studio.jsonl`)), await fsp.readFile(source));

  // Nothing changed: the ledger skips everything.
  const second = await backupTo(home, dest, { dataDir });
  assert.equal(second.counts.new + second.counts["prefix-replace"] + second.counts["keep-both"], 0);
  assert.equal(second.skippedByLedger, 9);

  // It grows: the tagged copy is this computer's, so it is extended; theirs is left alone.
  await fsp.appendFile(source, line({ type: "assistant", sessionId: CLAUDE_ID, timestamp: "2026-03-19T15:11:00.000Z" }));
  const third = await backupTo(home, dest, { dataDir });
  assert.equal(third.counts["prefix-replace"], 1);
  assert.equal(third.counts["keep-both"], 0);
  assert.deepEqual(await fsp.readFile(path.join(dayDir, `${CLAUDE_ID}.studio.jsonl`)), await fsp.readFile(source));
  assert.deepEqual(await fsp.readFile(path.join(dayDir, `${CLAUDE_ID}.jsonl`)), theirs);
  assert.deepEqual(await listTree(dayDir), [`${CLAUDE_ID}.jsonl`, `${CLAUDE_ID}.studio.jsonl`]);
});

test("a rewritten file whose tagged copy also differs gets a name with its md5, so no version is lost", async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const note = path.join(home, ".claude", "projects", PROJECT, "memory", "note.md");
  const memoryDir = path.join(dest, "대화", "claude", "_부속자료", "projects", PROJECT, "memory");
  await backupTo(home, dest);
  const v1 = await fsp.readFile(note);
  await fsp.writeFile(note, "---\nname: note\n---\nedited\n");
  await backupTo(home, dest);
  const v2 = await fsp.readFile(note);
  await fsp.writeFile(note, "---\nname: note\n---\nedited again\n");
  const third = await backupTo(home, dest);
  const v3 = await fsp.readFile(note);
  assert.equal(third.counts["keep-both"], 1);
  assert.deepEqual(await fsp.readFile(path.join(memoryDir, "note.md")), v1);
  assert.deepEqual(await fsp.readFile(path.join(memoryDir, "note.studio.md")), v2);
  assert.deepEqual(await fsp.readFile(path.join(memoryDir, `note.studio.${md5(v3).slice(0, 8)}.md`)), v3);
  // Run again without a ledger: it finds the same names and changes nothing.
  const fourth = await backupTo(home, dest);
  assert.equal(fourth.counts.unchanged, 9);
  assert.equal(fourth.counts.new + fourth.counts["keep-both"] + fourth.counts["prefix-replace"], 0);
});

test("hashing reads only the size first seen and gives every prefix asked for", async (t) => {
  const directory = await temporaryDirectory(t, "hash");
  const file = path.join(directory, "f");
  const bytes = crypto.randomBytes(700_000);
  await fsp.writeFile(file, bytes);
  const result = await hashLocal(file, 600_000, [1, 65_536, 300_001, 599_999, 700_000]);
  assert.equal(result.md5, md5(bytes.subarray(0, 600_000)));
  for (const cut of [1, 65_536, 300_001, 599_999]) assert.equal(result.prefixes.get(cut), md5(bytes.subarray(0, cut)), `prefix ${cut}`);
  assert.equal(result.prefixes.has(700_000), false);
});

// ------------------------------------------------------------- devices

test("files every computer has under the same name go to device-specific names", async (t) => {
  const studio = await makeHome(t);
  const laptop = await makeHome(t);
  await fsp.writeFile(path.join(laptop, ".claude", "history.jsonl"), line({ display: "laptop prompt" }));
  await fsp.writeFile(path.join(laptop, ".claude", "projects", PROJECT, "memory", "MEMORY.md"), "- laptop index\n");
  const dest = await temporaryDirectory(t, "dest");
  await backupTo(studio, dest, { device: "studio" });
  const result = await backupTo(laptop, dest, { device: "laptop" });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const support = path.join(dest, "대화", "claude", "_부속자료");
  assert.deepEqual(await fsp.readFile(path.join(support, "studio", "history.jsonl")), await fsp.readFile(path.join(studio, ".claude", "history.jsonl")));
  assert.deepEqual(await fsp.readFile(path.join(support, "laptop", "history.jsonl")), await fsp.readFile(path.join(laptop, ".claude", "history.jsonl")));
  const memory = path.join(support, "projects", PROJECT, "memory");
  assert.equal(await fsp.readFile(path.join(memory, "MEMORY.md"), "utf8"), "- [note](note.md)\n");
  assert.equal(await fsp.readFile(path.join(memory, "MEMORY.laptop.md"), "utf8"), "- laptop index\n");
});

test("a device id comes from the host name and gives each computer its own minute", () => {
  assert.equal(defaultDeviceId("gim-alam-ui-MacStudio.local"), "gim-alam-ui-macstudio");
  assert.equal(defaultDeviceId("DESKTOP-AB12CD"), "desktop-ab12cd");
  assert.equal(defaultDeviceId("김아람의 MacBook Pro"), "macbook-pro");
  assert.equal(defaultDeviceId("…"), "device");
  assert.equal(validDeviceId("studio"), true);
  assert.equal(validDeviceId("Studio"), false);
  assert.equal(validDeviceId("-x"), false);
  for (const device of ["studio", "laptop", "amd"]) {
    const minute = scheduleMinute(device);
    assert.ok(Number.isInteger(minute) && minute >= 0 && minute < 60);
    assert.equal(scheduleMinute(device), minute);
  }
  assert.notEqual(scheduleMinute("studio"), scheduleMinute("laptop"));
});

// ------------------------------------------------------------- unreachable

test("a folder that is not there means 연결 대기, and nothing is written anywhere", async (t) => {
  const home = await makeHome(t);
  const scratch = await temporaryDirectory(t, "scratch");
  const dataDir = path.join(scratch, "data");
  const missing = path.join(scratch, "Volumes", "NAS", "backup");
  await backupCommand("set", [], { dataDir, folder: scratch, device: "studio" });
  // Point the saved destination at a drive that is gone.
  const settingsPath = path.join(dataDir, "backup", "settings.json");
  const settings = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  settings.destination = { kind: "folder", path: missing, volumeRoot: path.join(scratch, "Volumes", "NAS") };
  await fsp.writeFile(settingsPath, JSON.stringify(settings));
  const result = await backupCommand("run", [], { dataDir, homeDir: home });
  assert.equal(result.ok, false);
  assert.equal(result.waiting, true);
  await assert.rejects(fsp.access(path.join(scratch, "Volumes")), "the missing drive's path was created");
  assert.deepEqual((await fsp.readdir(path.join(dataDir, "backup"))).sort(), ["settings.json", "status.json"]);
  const status = await backupCommand("status", [], { dataDir });
  assert.equal(status.state, "waiting");
  assert.equal(status.lastRun.waiting, true);
  assert.equal(status.lastRun.reason, "not-mounted");
});

test("an empty folder left where a drive was mounted is not the drive", async (t) => {
  const home = await makeHome(t);
  const scratch = await temporaryDirectory(t, "scratch");
  const mountPoint = path.join(scratch, "NAS");
  await fsp.mkdir(path.join(mountPoint, "backup"), { recursive: true });
  const store = folderStore({ folder: path.join(mountPoint, "backup"), volumeRoot: mountPoint });
  assert.deepEqual(await store.probe(), { ok: false, reason: "not-mounted" });
  const result = await runBackup({ destination: { kind: "folder", path: path.join(mountPoint, "backup") }, store, homeDir: home, device: "studio" });
  assert.equal(result.waiting, true);
  assert.deepEqual(await listTree(mountPoint), []);
});

/** A stand-in for rclone over a local folder, recording every call. */
function fakeRclone(remoteRoot, { reachable = true } = {}) {
  const calls = [];
  const local = (spec) => path.join(remoteRoot, ...spec.replace(/^fake:/, "").split("/").filter(Boolean));
  async function listing(dir, recursive) {
    const rows = [];
    async function walk(directory, prefix) {
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (recursive) { rows.push({ Path: rel, Name: entry.name, Size: -1, IsDir: true }); await walk(path.join(directory, entry.name), rel); }
        } else {
          const bytes = await fsp.readFile(path.join(directory, entry.name));
          rows.push({ Path: rel, Name: entry.name, Size: bytes.length, IsDir: false, Hashes: { md5: md5(bytes) } });
        }
      }
    }
    await walk(dir, "");
    return rows;
  }
  const run = async (args) => {
    calls.push(args);
    const [command, ...rest] = args;
    if (command === "listremotes") return { code: 0, stdout: "fake:\nother:\n", stderr: "" };
    if (command === "lsf") return reachable ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "2026/10/05 03:00:00 ERROR : couldn't fetch token: invalid_grant access_token=ya29.SECRET\n" };
    if (command === "lsjson") {
      const target = rest.find((arg) => arg.startsWith("fake:"));
      try { await fsp.access(local(target)); } catch { return { code: 3, stdout: "", stderr: "directory not found" }; }
      return { code: 0, stdout: JSON.stringify(await listing(local(target), rest.includes("-R"))), stderr: "" };
    }
    if (command === "mkdir") { await fsp.mkdir(local(rest[0]), { recursive: true }); return { code: 0, stdout: "", stderr: "" }; }
    if (command === "copyto") {
      await fsp.mkdir(path.dirname(local(rest[1])), { recursive: true });
      await fsp.copyFile(rest[0], local(rest[1]));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "moveto") {
      await fsp.mkdir(path.dirname(local(rest[1])), { recursive: true });
      await fsp.rename(local(rest[0]), local(rest[1]));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${command}` };
  };
  return { run, calls };
}

test("a cloud that does not answer means 연결 대기: no copy, move or mkdir, and no token in the message", async (t) => {
  const home = await makeHome(t);
  const remoteRoot = await temporaryDirectory(t, "remote");
  const fake = fakeRclone(remoteRoot, { reachable: false });
  const result = await runBackup({ destination: { kind: "cloud", remote: "fake", path: "" }, rcloneRun: fake.run, homeDir: home, device: "studio" });
  assert.equal(result.waiting, true);
  assert.equal(result.reason, "unauthorized-or-offline");
  assert.doesNotMatch(result.detail, /ya29|SECRET/);
  assert.deepEqual(fake.calls.map((args) => args[0]).filter((command) => ["copyto", "moveto", "mkdir", "lsjson"].includes(command)), []);
  assert.deepEqual(await listTree(remoteRoot), []);
});

test("a cloud backup copies with rclone copyto, never by mtime, and makes new folders one at a time first", async (t) => {
  const home = await makeHome(t);
  const remoteRoot = await temporaryDirectory(t, "remote");
  const local = await fsp.readFile(path.join(home, ".codex", "archived_sessions", CODEX_ARCHIVED));
  await put(path.join(remoteRoot, "대화", "codex", "2026", "08", "10", CODEX_ARCHIVED), local.subarray(0, 30));
  const fake = fakeRclone(remoteRoot);
  const destination = { kind: "cloud", remote: "fake", path: "" };
  const dry = await runBackup({ destination, rcloneRun: fake.run, homeDir: home, device: "studio", dryRun: true });
  assert.deepEqual({ ...dry.counts }, { new: 8, unchanged: 0, "prefix-replace": 1, "keep-both": 0, "archive-moves": 1, errors: 0 });
  assert.deepEqual(fake.calls.map((args) => args[0]).filter((command) => ["copyto", "moveto", "mkdir"].includes(command)), [], "a dry run wrote");

  fake.calls.length = 0;
  const result = await runBackup({ destination, rcloneRun: fake.run, homeDir: home, device: "studio" });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const commands = fake.calls.map((args) => args[0]);
  const firstCopy = commands.indexOf("copyto");
  assert.ok(commands.lastIndexOf("mkdir") < firstCopy, "a folder was made while uploads ran");
  assert.ok(commands.indexOf("moveto") < firstCopy);
  for (const args of fake.calls) {
    assert.ok(!args.includes("--update") && !args.includes("sync") && !args.includes("delete") && !args.includes("purge"), args.join(" "));
    if (args[0] === "copyto") assert.ok(args.includes("--ignore-times") && args.includes("--local-no-check-updated"), args.join(" "));
    if (args[0] === "moveto") assert.ok(args.includes("--checksum"));
    if (args[0] !== "listremotes") assert.ok(args.includes("--tpslimit"));
  }
  assert.deepEqual(await fsp.readFile(path.join(remoteRoot, "대화", "codex", "_아카이브", "2026", "08", "10", CODEX_ARCHIVED)), local);
  await assert.rejects(fsp.access(path.join(remoteRoot, "대화", "codex", "2026", "08", "10", CODEX_ARCHIVED)));

  const again = await runBackup({ destination, rcloneRun: fake.run, homeDir: home, device: "studio" });
  assert.equal(again.counts.unchanged, 9);
});

test("a new file whose bytes already sit under _원본버전 is reported as such, and _원본버전 is left alone", async (t) => {
  const home = await makeHome(t);
  const remoteRoot = await temporaryDirectory(t, "remote");
  const local = await fsp.readFile(path.join(home, ".codex", "sessions", "2026", "09", "01", CODEX_MAIN));
  const version = path.join(remoteRoot, "대화", "codex", "2026", "09", "02", "_원본버전", "01a0aaaa", "0123456789abcdef", CODEX_MAIN);
  await put(version, local);
  const fake = fakeRclone(remoteRoot);
  const result = await runBackup({ destination: { kind: "cloud", remote: "fake", path: "" }, rcloneRun: fake.run, homeDir: home, device: "studio", dryRun: true, wholeTrees: true });
  assert.equal(result.counts.new, 9);
  assert.deepEqual(result.newSameAsOriginalVersion, { files: 1, bytes: local.length });
  const example = result.examples.new["codex/main"].find((item) => item.to.endsWith(CODEX_MAIN));
  assert.equal(example.sameBytesAt, `codex/2026/09/02/_원본버전/01a0aaaa/0123456789abcdef/${CODEX_MAIN}`);
  assert.ok(fake.calls.some((args) => args[0] === "lsjson" && args.includes("-R")));
});

test("rclone's messages lose anything that looks like a credential", () => {
  const text = rcloneMessage({ code: 1, stderr: "2026/10/05 03:00:00 ERROR : Failed: token = {\"access_token\":\"ya29.abc\"} refresh_token: 1//xyz\n" });
  assert.doesNotMatch(text, /ya29|1\/\/xyz/);
  assert.match(text, /Failed/);
});

test("a cloud destination is an rclone remote and an optional folder", () => {
  assert.deepEqual(parseCloudDestination("gdrive_dev:"), { remote: "gdrive_dev", path: "" });
  assert.deepEqual(parseCloudDestination("gdrive_dev:/백업/대화들/"), { remote: "gdrive_dev", path: "백업/대화들" });
  assert.equal(parseCloudDestination("gdrive_dev"), null);
  assert.equal(parseCloudDestination("gdrive_dev:a/../b"), null);
  assert.equal(parseCloudDestination(":local"), null);
  assert.equal(rcloneStore({ remote: "x", run: async () => ({ code: 0 }) }).label, "x:대화");
});

// ------------------------------------------------------------- schedule

test("the schedule is a clock job on each OS, at the device's own minute, and installs through the injected runner", async (t) => {
  const home = await temporaryDirectory(t, "schedule");
  const base = { env: {}, homeDir: home, uid: 501 };
  const paths = { nodePath: "/usr/local/bin/node", cliPath: "/app/cli.mjs", logPath: "/app/logs/backup.log", workingDirectory: "/app", stateDir: "/app/state", hour: 3, minute: 17 };
  const mac = backupScheduleSpec({ ...base, platform: "darwin" }, paths);
  assert.equal(mac.kind, "launchd");
  assert.equal(mac.label, BACKUP_LAUNCHD_LABEL);
  assert.equal(mac.data.RunAtLoad, false);
  assert.equal(Object.hasOwn(mac.data, "KeepAlive"), false);
  assert.deepEqual(mac.data.StartCalendarInterval, { Hour: 3, Minute: 17 });
  assert.deepEqual(mac.data.ProgramArguments, ["/usr/local/bin/node", "/app/cli.mjs", "backup", "run"]);
  assert.match(mac.text, /<key>StartCalendarInterval<\/key>/);

  const linux = backupScheduleSpec({ ...base, platform: "linux" }, paths);
  assert.match(linux.timerText, /^OnCalendar=\*-\*-\* 03:17:00$/m);
  assert.match(linux.timerText, /^Persistent=true$/m);
  assert.match(linux.serviceText, /^Type=oneshot$/m);

  const windows = backupScheduleSpec({ ...base, platform: "win32", env: { SystemRoot: "C:\\Windows" } }, { ...paths, stateDir: "C:\\app\\state" });
  assert.match(windows.xml, /<StartBoundary>2026-01-01T03:17:00<\/StartBoundary>/);
  assert.match(windows.xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(windows.vbs, /backup run/);

  const calls = [];
  const ctx = { ...base, platform: "darwin", sleep: async () => {}, run: async (command, args) => { calls.push([command, ...args]); return { code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "" }; } };
  const spec = backupScheduleSpec(ctx, paths);
  await installBackupSchedule(ctx, spec);
  assert.match(await fsp.readFile(spec.plistPath, "utf8"), /team-memory-system\.backup/);
  assert.ok(calls.some((call) => call[1] === "bootstrap"));
  await removeBackupSchedule(ctx, spec);
  await assert.rejects(fsp.access(spec.plistPath));
});

test("the screen's destination choice reaches the CLI as --name=value only", () => {
  assert.deepEqual(backupSetInvocation({ kind: "folder", path: " /Volumes/NAS/백업 " }), ["backup", "set", "--folder=/Volumes/NAS/백업"]);
  assert.deepEqual(backupSetInvocation({ kind: "cloud", remote: "gdrive_dev", path: "/x/" }), ["backup", "set", "--cloud=gdrive_dev:x"]);
  assert.deepEqual(backupSetInvocation({ kind: "off" }), ["backup", "set", "--off"]);
  assert.equal(backupSetInvocation({ kind: "cloud", remote: "--config=/etc/x" }), null);
  assert.equal(backupSetInvocation({ kind: "folder", path: "" }), null);
  assert.equal(backupSetInvocation({ kind: "folder", path: "/a\n--off" }), null);
  assert.equal(backupSetInvocation({}), null);
});
