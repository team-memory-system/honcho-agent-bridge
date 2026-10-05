// The full-rebuild driver (scripts/rebuild-import.mjs). Every conversation here is
// made up.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  collectorEnv,
  compareSession,
  expectedSessions,
  fillTimes,
  formatInZone,
  guardServer,
  interpolateTimes,
  ledgerPathFor,
  mergeByRoleAndText,
  parseCli,
  pinnedRevision,
  plan,
  postDirect,
  run,
  sortEntries,
  splitChatGptExport,
  splitGrokDocument,
  uuidsInName,
  verify,
  zonedInstant,
} from "../scripts/rebuild-import.mjs";
import { loadExport } from "../scripts/providers/chatgpt.mjs";
import { fixtureZip } from "./chatgpt-fixture.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const quiet = () => {};

async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `rebuild-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(target, content) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
  return target;
}

async function readLines(filePath) {
  const text = await fsp.readFile(filePath, "utf8");
  return text.split("\n").filter(Boolean).map((item) => JSON.parse(item));
}

const U = {
  claude: "11111111-1111-4111-8111-111111111111",
  sdk: "22222222-2222-4222-8222-222222222222",
  renamed: "33333333-3333-4333-8333-333333333333",
  late: "66666666-6666-4666-8666-666666666666",
  codexMain: "01a00000-0000-7000-8000-000000000001",
  codexSub: "01a00000-0000-7000-8000-000000000002",
  codexArchived: "01a00000-0000-7000-8000-000000000004",
  agyCli: "aaaaaaaa-0000-4000-8000-000000000001",
  agyApp: "aaaaaaaa-0000-4000-8000-000000000002",
  agyScript: "aaaaaaaa-0000-4000-8000-000000000003",
};

function claudeRows(id, turns, { entrypoint = "cli" } = {}) {
  return turns
    .map(([uuid, role, text, timestamp]) =>
      line({
        type: role,
        entrypoint,
        sessionId: id,
        uuid,
        timestamp,
        message: { role, content: role === "user" ? text : [{ type: "text", text }] },
      }),
    )
    .join("");
}

function codexRollout(id, turns, { source = "vscode", threadSource = "user" } = {}) {
  const rows = [{ timestamp: turns[0]?.[2] || "2026-09-03T02:00:00.000Z", type: "session_meta", payload: { id, cwd: "/Users/me/dev/app", originator: "Codex Desktop", source, thread_source: threadSource } }];
  for (const [role, text, timestamp] of turns) {
    rows.push({ timestamp, type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  }
  return rows.map(line).join("");
}

function agyTranscript(prompt, at) {
  return [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at, content: `<USER_REQUEST>${prompt}</USER_REQUEST>` },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at, content: "a made-up answer" },
  ].map(line).join("");
}

// A Drive-shaped tree: dated folders, _원본버전 copies, and the folders a backup keeps beside them.
async function driveFixture(t) {
  const dir = await temporaryDirectory(t, "plan");
  const drive = path.join(dir, "drive");
  const claude = path.join(drive, "claude");
  await put(
    path.join(claude, "2026", "09", "02", `${U.claude}.jsonl`),
    claudeRows(U.claude, [
      ["c-u1", "user", "plan a picnic", "2026-09-02T01:00:00.000Z"],
      ["c-a1", "assistant", "bring sandwiches", "2026-09-02T01:00:05.000Z"],
    ]),
  );
  // An older copy that also holds a turn the main file lost, and a repeated uuid with other text.
  await put(
    path.join(claude, "2026", "09", "02", "_원본버전", U.claude, "abc123", `${U.claude}.jsonl`),
    claudeRows(U.claude, [
      ["c-u1", "user", "plan a picnic (older wording)", "2026-09-02T01:00:00.000Z"],
      ["c-u0", "user", "a turn only the older copy kept", "2026-09-02T00:59:00.000Z"],
    ]),
  );
  await put(path.join(claude, "2026", "09", "03", `${U.sdk}.jsonl`), claudeRows(U.sdk, [["s-u1", "user", "Current position:", "2026-09-03T00:00:00.000Z"], ["s-a1", "assistant", "e5", "2026-09-03T00:00:01.000Z"]], { entrypoint: "sdk-cli" }));
  // A file whose name carries no uuid; its parsed session id is on the archived list.
  await put(path.join(claude, "2026", "09", "04", "renamed-copy.jsonl"), claudeRows(U.renamed, [["r-u1", "user", "archived thoughts", "2026-09-04T00:00:00.000Z"]]));
  await put(path.join(claude, "2026", "10", "06", `${U.late}.jsonl`), claudeRows(U.late, [["l-u1", "user", "too late", "2026-10-06T00:00:00.000Z"]]));
  await put(path.join(claude, "_부속자료", "studio", "history.jsonl"), line({ display: "not a transcript" }));

  const codex = path.join(drive, "codex");
  const mainName = `rollout-2026-09-03T11-00-00-${U.codexMain}.jsonl`;
  await put(
    path.join(codex, "2026", "09", "03", mainName),
    codexRollout(U.codexMain, [["user", "please refactor", "2026-09-03T02:00:00.000Z"], ["assistant", "done", "2026-09-03T02:00:09.000Z"]]),
  );
  await put(
    path.join(codex, "2026", "09", "03", "_원본버전", U.codexMain, "f00d", mainName),
    codexRollout(U.codexMain, [["user", "please  refactor", "2026-09-03T02:00:00.000Z"], ["user", "a turn only the version has", "2026-09-03T01:59:00.000Z"]]),
  );
  await put(path.join(codex, "2026", "09", "03", `rollout-2026-09-03T12-00-00-${U.codexSub}.jsonl`), codexRollout(U.codexSub, [["user", "sub task", "2026-09-03T03:00:00.000Z"]], { threadSource: "subagent" }));
  await put(path.join(codex, "2026", "09", "04", `rollout-2026-09-04T11-00-00-${U.codexArchived}.jsonl`), codexRollout(U.codexArchived, [["user", "old", "2026-09-04T02:00:00.000Z"]]));
  await put(path.join(codex, "_아카이브", "2026", "09", "05", `rollout-x-${U.codexMain}.jsonl`), codexRollout(U.codexMain, [["user", "never read", "2026-09-05T00:00:00.000Z"]]));

  const agy = path.join(drive, "agy");
  await put(path.join(agy, "2026", "09", "05", U.agyCli, "transcript_full.jsonl"), agyTranscript("a typed question", "2026-09-05T01:00:00Z"));
  await put(path.join(agy, "2026", "09", "05", U.agyCli, "transcript.jsonl"), agyTranscript("a typed question", "2026-09-05T01:00:00Z"));
  await put(path.join(agy, "2026", "09", "05", U.agyApp, "transcript.jsonl"), agyTranscript("asked in the app", "2026-09-05T02:00:00Z"));
  await put(path.join(agy, "2026", "09", "05", U.agyScript, "transcript.jsonl"), agyTranscript("Reply with exactly: OK", "2026-09-05T03:00:00Z"));
  const agyHistory = await put(path.join(dir, "history.jsonl"), line({ display: "a typed question", timestamp: Date.parse("2026-09-05T01:00:00Z"), workspace: "/tmp", conversationId: U.agyCli }));
  const agyAppIds = await put(path.join(dir, "agy-app-ids.txt"), `${U.agyApp}\n`);
  const excludeIds = await put(path.join(dir, "archived.txt"), `${U.codexArchived}\n${U.renamed}\n`);

  const cursor = await put(path.join(drive, "cursor", "2025", "08", "20", "2025-08-20_1524_c0ffee00.json"), JSON.stringify({ composerId: "c0ffee00-0000-4000-8000-000000000001", createdAt: Date.parse("2025-08-20T06:24:00Z"), turns: [{ role: "user", text: "fix the button" }, { role: "assistant", text: "fixed" }] }));
  return { dir, drive, out: path.join(dir, "run", "manifest.jsonl"), agyHistory, agyAppIds, excludeIds, cursor };
}

function planOptions(f, extra = {}) {
  return {
    tz: "Asia/Seoul",
    to: "2026-10-01",
    roots: [`claude:drive:${path.join(f.drive, "claude")}`, `codex:drive:${path.join(f.drive, "codex")}`, `agy:drive:${path.join(f.drive, "agy")}`],
    excludeIds: f.excludeIds,
    agyHistory: f.agyHistory,
    agyAppIds: f.agyAppIds,
    cursor: path.join(f.drive, "cursor"),
    out: f.out,
    userPeer: "me",
    ...extra,
  };
}

test("KST edges and local times convert to instants and back", () => {
  assert.equal(new Date(zonedInstant("2026-09-01", "Asia/Seoul")).toISOString(), "2026-08-31T15:00:00.000Z");
  assert.equal(new Date(zonedInstant("2026-05-10T13:56:33.046314", "Asia/Seoul")).toISOString(), "2026-05-10T04:56:33.046Z");
  assert.equal(formatInZone(Date.parse("2026-08-31T15:00:00.000Z"), "Asia/Seoul"), "2026-09-01T00:00:00.000+09:00");
  assert.throws(() => zonedInstant("September", "Asia/Seoul"), /not a local date/);
  assert.deepEqual(uuidsInName(`rollout-t-${U.codexMain}_${U.codexSub}.jsonl`), [U.codexMain, U.codexSub]);
});

test("turns without times are spread by min(60 s, span / n), or 1 s apart without an end", () => {
  const start = Date.parse("2026-04-14T00:00:00Z");
  assert.deepEqual(interpolateTimes(3, start, start + 30_000), [start, start + 10_000, start + 20_000]);
  assert.deepEqual(interpolateTimes(3, start, start + 3_600_000), [start, start + 60_000, start + 120_000]);
  assert.deepEqual(interpolateTimes(3, start, null), [start, start + 1000, start + 2000]);
  assert.deepEqual(interpolateTimes(2, start, start - 5), [start, start]);
  // A message without a time among timed ones takes the time before it.
  assert.deepEqual(fillTimes([{ timeMs: 5 }, {}, { timeMs: 9 }], 0, null), [
    { ms: 5, source: "original" },
    { ms: 5, source: "interpolated" },
    { ms: 9, source: "original" },
  ]);
});

test("plan: Claude versions join their session in order, a repeated uuid counted once, archived by parsed id, upper bound only", async (t) => {
  const f = await driveFixture(t);
  const { entries, exclusions } = await plan(planOptions(f), { log: quiet });
  const claude = entries.find((entry) => entry.session_id === `claude-${U.claude}`);
  assert.deepEqual(claude.files.map((file) => [path.basename(path.dirname(file.staged)), file.role, file.adds_turns]), [
    ["base", "base", 2],
    ["v1", "version", 1],
  ]);
  assert.equal(path.basename(claude.files[0].staged), `${U.claude}.jsonl`);
  // c-u1 appears in both files: the main file's text is the one counted.
  assert.equal(claude.turns, 3);
  assert.equal(claude.user, 2);
  assert.equal(claude.start, "2026-09-02T00:59:00.000Z");
  assert.deepEqual(claude.peers, { me: 2, assistant_claude: 1 });
  // Claude SDK sessions are no longer excluded; their prompts go to automation_claude.
  const sdk = entries.find((entry) => entry.session_id === `claude-${U.sdk}`);
  assert.deepEqual(sdk.peers, { automation_claude: 1, assistant_claude: 1 });
  const reasons = Object.fromEntries(exclusions.map((item) => [path.basename(item.file), item.reason]));
  assert.equal(reasons["renamed-copy.jsonl"], "archived");
  assert.equal(reasons[`${U.late}.jsonl`], "after-to");
  assert.equal(reasons[`rollout-2026-09-03T12-00-00-${U.codexSub}.jsonl`], "codex-subagent");
  assert.equal(reasons[`rollout-2026-09-04T11-00-00-${U.codexArchived}.jsonl`], "archived");
  assert.equal(exclusions.some((item) => item.file.includes("_아카이브") || item.file.includes("_부속자료")), false);
  assert.equal(exclusions.some((item) => item.reason === "claude-sdk"), false);
});

test("plan: Codex turns found only in a version become a codex-extra entry right after the main file", async (t) => {
  const f = await driveFixture(t);
  const { entries, summary } = await plan(planOptions(f), { log: quiet });
  const mainIndex = entries.findIndex((entry) => entry.kind === "codex" && entry.session_id === `codex-${U.codexMain}`);
  const extra = entries[mainIndex + 1];
  assert.equal(extra.kind, "codex-extra");
  assert.equal(extra.session_id, `codex-${U.codexMain}`);
  assert.equal(extra.files, undefined, "an extra is a direct post, never a collector file");
  const payload = JSON.parse(await fsp.readFile(extra.payload, "utf8"));
  // "please  refactor" differs from the main file's only in spacing, so it is not an extra.
  assert.deepEqual(payload.messages.map((message) => [message.peer_id, message.content]), [["me", "a turn only the version has"]]);
  assert.match(payload.messages[0].metadata.source_turn_hash, /^codex-extra:/);
  assert.deepEqual(summary.codex_versions, { versions_compared: 1, version_only_ids: 0, mains_with_extras: 1, extra_turns: 1, extra_messages: 1 });
  // The main file keeps its original basename when staged.
  const main = entries[mainIndex];
  assert.equal(path.basename(main.files[0].staged), `rollout-2026-09-03T11-00-00-${U.codexMain}.jsonl`);
});

test("plan: agy is staged as brain/<id>/.system_generated/logs so the provider reads the conversation id, and the history rule sorts the peers", async (t) => {
  const f = await driveFixture(t);
  const { entries, summary } = await plan(planOptions(f), { log: quiet });
  const agy = Object.fromEntries(entries.filter((entry) => entry.kind === "agy").map((entry) => [entry.session_id, entry]));
  assert.deepEqual(Object.keys(agy).sort(), [`agy-${U.agyCli}`, `agy-${U.agyApp}`, `agy-${U.agyScript}`].sort());
  const cli = agy[`agy-${U.agyCli}`];
  assert.equal(path.basename(cli.files[0].staged), "transcript_full.jsonl");
  assert.match(cli.files[0].staged, new RegExp(`antigravity-cli/brain/${U.agyCli}/\\.system_generated/logs/transcript_full\\.jsonl$`));
  assert.match(agy[`agy-${U.agyApp}`].files[0].staged, new RegExp(`/antigravity/brain/${U.agyApp}/`));
  assert.deepEqual([cli.agy_origin, agy[`agy-${U.agyApp}`].agy_origin, agy[`agy-${U.agyScript}`].agy_origin], ["history_id", "app", "unlisted"]);
  assert.deepEqual(agy[`agy-${U.agyScript}`].peers, { automation_agy: 1, assistant_agy: 1 });
  assert.deepEqual(cli.peers, { me: 1, assistant_agy: 1 });
  assert.deepEqual(summary.agy_origins, { history_id: 1, app: 1, unlisted: 1 });
});

test("plan: Cursor turns without times are 1 s apart and marked interpolated; the manifest is ordered by first turn", async (t) => {
  const f = await driveFixture(t);
  const { entries } = await plan(planOptions(f), { log: quiet });
  const cursor = entries.find((entry) => entry.kind === "cursor");
  const payload = JSON.parse(await fsp.readFile(cursor.payload, "utf8"));
  assert.deepEqual(payload.messages.map((message) => [message.peer_id, message.created_at, message.metadata.created_at_source]), [
    ["me", "2025-08-20T06:24:00.000Z", "interpolated"],
    ["assistant_cursor", "2025-08-20T06:24:01.000Z", "interpolated"],
  ]);
  assert.deepEqual(payload.session.peers, { assistant_cursor: { observe_me: false, observe_others: false }, me: { observe_me: true, observe_others: false } });
  assert.deepEqual(entries.map((entry) => entry.seq), entries.map((_, index) => index + 1));
  const starts = entries.map((entry) => Date.parse(entry.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  const manifest = await readLines(f.out);
  assert.equal(manifest.length, entries.length);
});

test("plan makes no HTTP request", async (t) => {
  const f = await driveFixture(t);
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalHttp = http.request;
  const originalHttps = https.request;
  globalThis.fetch = async (...args) => {
    calls.push(["fetch", String(args[0])]);
    throw new Error("plan must not fetch");
  };
  http.request = (...args) => {
    calls.push(["http", args[0]]);
    throw new Error("plan must not use http");
  };
  https.request = (...args) => {
    calls.push(["https", args[0]]);
    throw new Error("plan must not use https");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    http.request = originalHttp;
    https.request = originalHttps;
  });
  await plan(planOptions(f), { log: quiet });
  assert.deepEqual(calls, []);
});

test("the ChatGPT split gives each conversation its own file that loadExport reads exactly as the whole export", async (t) => {
  const dir = await temporaryDirectory(t, "chatgpt");
  const exportPath = await put(path.join(dir, "export.zip"), fixtureZip());
  const whole = await loadExport(exportPath);
  const split = await splitChatGptExport(exportPath, path.join(dir, "split"));
  const fromSplit = [];
  for (const { file } of split.files) fromSplit.push(...(await loadExport(file)).sessions);
  const strip = (session) => ({ ...session, metadata: { ...session.metadata, file_path: undefined } });
  const byId = (list) => Object.fromEntries(list.map((session) => [session.session_id, strip(session)]));
  assert.deepEqual(byId(fromSplit), byId(whole.sessions));
  // The older copy of a conversation found twice is not split out.
  assert.equal(split.files.length, whole.summary.conversations_read - whole.summary.duplicate_conversations);
});

function hermesDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
  const t0 = Date.parse("2026-05-01T00:00:00Z") / 1000;
  const session = db.prepare("INSERT INTO sessions (id, source, parent_session_id, started_at, end_reason) VALUES (?, ?, ?, ?, ?)");
  const message = db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
  session.run("20260501_090000_aaaaaa", "discord", null, t0, "compression");
  message.run("20260501_090000_aaaaaa", "session_meta", null, t0);
  message.run("20260501_090000_aaaaaa", "user", "find me a bike light", t0 + 1);
  message.run("20260501_090000_aaaaaa", "assistant", null, t0 + 2);
  message.run("20260501_090000_aaaaaa", "tool", "{\"result\": 1}", t0 + 3);
  message.run("20260501_090000_aaaaaa", "assistant", "here are three", t0 + 4);
  session.run("20260501_100000_bbbbbb", "discord", "20260501_090000_aaaaaa", t0 + 3600, null);
  message.run("20260501_100000_bbbbbb", "user", "find me a bike light", t0 + 3601);
  message.run("20260501_100000_bbbbbb", "user", "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted", t0 + 3602);
  message.run("20260501_100000_bbbbbb", "user", "which one is brightest?", t0 + 3603);
  message.run("20260501_100000_bbbbbb", "assistant", "the second", t0 + 3604);
  session.run("cron_abc_20260502_000000", "cron", null, t0 + 86400, "cron_complete");
  message.run("cron_abc_20260502_000000", "user", "run the daily report", t0 + 86401);
  message.run("cron_abc_20260502_000000", "assistant", "report done", t0 + 86402);
  db.close();
}

test("plan: Hermes keeps user and assistant rows, drops its own handoff text and copies from the parent, and sends cron to automation_hermes", async (t) => {
  const dir = await temporaryDirectory(t, "hermes");
  const hermes = path.join(dir, "hermes");
  const dbPath = path.join(hermes, "_부속자료", "sqlite", "_원본버전", "0123", "state.db");
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  hermesDb(dbPath);
  // JSON-only sessions: a persona prompt, the person's own chat the same day, and a later one without times.
  await put(path.join(hermes, "2026", "04", "13", "session_20260413_120000_cccccc.json"), JSON.stringify({ session_id: "20260413_120000_cccccc", platform: "cli", session_start: "2026-04-13T12:00:00.000000", last_updated: "2026-04-13T12:00:30.000000", messages: [{ role: "user", content: '{\n  "persona": { "slot_id": "made-up-slot" } }' }, { role: "assistant", content: "ok" }, { role: "tool", content: "x" }] }));
  await put(path.join(hermes, "2026", "04", "13", "session_20260413_130000_eeeeee.json"), JSON.stringify({ session_id: "20260413_130000_eeeeee", platform: "discord", session_start: "2026-04-13T13:00:00.000000", last_updated: "2026-04-13T13:00:30.000000", messages: [{ role: "user", content: "why is my browser stuck?" }, { role: "assistant", content: "try a restart" }] }));
  await put(path.join(hermes, "2026", "06", "01", "session_20260601_120000_dddddd.json"), JSON.stringify({ session_id: "20260601_120000_dddddd", platform: "discord", session_start: "2026-06-01T12:00:00.000000", last_updated: "2026-06-01T12:00:30.000000", messages: [{ role: "user", content: "a real question" }, { role: "assistant", content: "a real answer" }, { role: "user", content: "and then?" }] }));
  // An older copy of the same session holding a message the main copy lost.
  await put(path.join(hermes, "2026", "06", "01", "_원본버전", "20260601_120000_dddddd", "77", "session_20260601_120000_dddddd.json"), JSON.stringify({ session_id: "20260601_120000_dddddd", platform: "discord", session_start: "2026-06-01T12:00:00.000000", last_updated: "2026-06-01T12:00:10.000000", messages: [{ role: "user", content: "a real question" }, { role: "user", content: "an aside only the copy kept" }] }));
  const out = path.join(dir, "run", "manifest.jsonl");
  const { entries, summary } = await plan({ tz: "Asia/Seoul", hermes, out, userPeer: "me" }, { log: quiet });
  const byId = Object.fromEntries(entries.map((entry) => [entry.session_id, entry]));
  const messagesOf = async (id) => JSON.parse(await fsp.readFile(byId[id].payload, "utf8")).messages;

  assert.deepEqual((await messagesOf("hermes-20260501_090000_aaaaaa")).map((m) => [m.peer_id, m.content]), [["me", "find me a bike light"], ["assistant_hermes", "here are three"]]);
  const child = await messagesOf("hermes-20260501_100000_bbbbbb");
  assert.deepEqual(child.map((m) => [m.peer_id, m.content]), [["me", "which one is brightest?"], ["assistant_hermes", "the second"]]);
  assert.equal(child[0].created_at, "2026-05-01T01:00:03.000Z");
  assert.equal(child[0].metadata.created_at_source, "original");
  assert.deepEqual((await messagesOf("hermes-cron_abc_20260502_000000")).map((m) => [m.peer_id, m.metadata.automation_kind || null]), [["automation_hermes", "hermes_cron"], ["assistant_hermes", null]]);

  const persona = await messagesOf("hermes-20260413_120000_cccccc");
  assert.deepEqual(persona.map((m) => [m.peer_id, m.metadata.automation_kind || null]), [["automation_hermes", "hermes_persona_burst"], ["assistant_hermes", null]]);
  const sameDay = await messagesOf("hermes-20260413_130000_eeeeee");
  assert.deepEqual(sameDay.map((m) => [m.peer_id, m.metadata.automation_kind || null]), [["me", null], ["assistant_hermes", null]]);
  const merged = await messagesOf("hermes-20260601_120000_dddddd");
  assert.deepEqual(merged.map((m) => m.content), ["a real question", "an aside only the copy kept", "a real answer", "and then?"]);
  // 4 turns over 30 s: 7.5 s apart, from session_start read as KST.
  assert.deepEqual(merged.map((m) => [m.created_at, m.metadata.created_at_source]), [
    ["2026-06-01T03:00:00.000Z", "interpolated"],
    ["2026-06-01T03:00:07.500Z", "interpolated"],
    ["2026-06-01T03:00:15.000Z", "interpolated"],
    ["2026-06-01T03:00:22.500Z", "interpolated"],
  ]);
  assert.equal(summary.hermes.state_db_rows.own_text, 1);
  assert.equal(summary.hermes.state_db_rows.copied_from_parent, 1);
  assert.equal(summary.hermes.persona_burst, 1);
  assert.deepEqual(mergeByRoleAndText([{ role: "user", content: "a" }], [[{ role: "user", content: "b" }, { role: "user", content: "a" }]]).map((m) => m.content), ["b", "a"]);
});

test("plan: rows only the Mac DB holds keep their times and ids, the person's peer renamed, and stop at --to", async (t) => {
  const dir = await temporaryDirectory(t, "old-db");
  const rows = [
    { public_id: "row1", session_name: "local-notes-1", peer_name: "person_live", content: "remember the blue notebook", created_at: "2026-05-01T00:00:00+00:00", metadata: { source: "local_memory", note_kind: "seed" } },
    { public_id: "row2", session_name: "local-notes-1", peer_name: "assistant_codex", content: "noted", created_at: "2026-05-01T00:00:05+00:00", metadata: { source: "local_memory" } },
    // Another source's row in the same live session keeps its own source.
    { public_id: "row4", session_name: "local-notes-1", peer_name: "person_live", content: "and the red pen", created_at: "2026-05-02T00:00:00+00:00", metadata: { source: "hermes" } },
    { public_id: "row3", session_name: "local-notes-2", peer_name: "person_live", content: "written after the cut", created_at: "2026-10-05T11:00:00+00:00", metadata: { source: "local_memory" } },
  ];
  const file = await put(path.join(dir, "extract.jsonl"), rows.map(line).join(""));
  const { entries, exclusions, summary } = await plan({ tz: "Asia/Seoul", to: "2026-10-05 19:00", oldDb: [file], out: path.join(dir, "run", "manifest.jsonl"), userPeer: "me" }, { log: quiet });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.session_id, entry.messages]), [["old-db", "local-notes-1", 3]]);
  assert.deepEqual(exclusions.map((item) => [item.session_id, item.reason]), [["local-notes-2", "after-to"]]);
  const payload = JSON.parse(await fsp.readFile(entries[0].payload, "utf8"));
  assert.deepEqual(payload.messages.map((message) => [message.peer_id, message.created_at, message.metadata.source_turn_hash, message.metadata.original_public_id]), [
    ["me", "2026-05-01T00:00:00.000Z", "old-db:row1", "row1"],
    ["assistant_codex", "2026-05-01T00:00:05.000Z", "old-db:row2", "row2"],
    ["me", "2026-05-02T00:00:00.000Z", "old-db:row4", "row4"],
  ]);
  assert.deepEqual(payload.messages.map((message) => [message.metadata.source, message.metadata.memory_origin]), [
    ["local_memory", "local_memory_direct_user"],
    ["local_memory", "local_memory_assistant"],
    ["hermes", "hermes_direct_user"],
  ]);
  assert.equal(payload.messages[0].metadata.note_kind, "seed");
  assert.deepEqual(summary.mac_db_only, { rows: 4, sessions: 1, by_source: { local_memory: 2, hermes: 1 } });
});

test("a Grok index document splits into the log's number of prompts and one reply, without the trailing tool list", () => {
  const document = "first question\n\nsecond question\n\nLooking into it.\nFound it.\n\nHere is the answer.\n\nread_file\nuse_tool\nWeb search:";
  assert.deepEqual(splitGrokDocument(document, 2), {
    prompts: ["first question", "second question"],
    reply: "Looking into it.\nFound it.\n\nHere is the answer.",
    boundary_confident: true,
  });
  assert.equal(splitGrokDocument("only one paragraph", 1), null);
});

// ---------------------------------------------------------------------------
// run / verify
// ---------------------------------------------------------------------------

function fakeHoncho({ workspaces = {}, sessions = {} } = {}) {
  const calls = [];
  const request = async (method, apiPath, payload) => {
    calls.push({ method, apiPath, payload });
    if (method === "POST" && apiPath.startsWith("/v3/workspaces/list")) {
      const items = Object.entries(workspaces).map(([id, value]) => ({ id, ...value }));
      return { items, total: items.length, page: 1, size: 100, pages: 1 };
    }
    if (method === "POST" && apiPath === "/v3/workspaces") {
      workspaces[payload.id] ??= { metadata: payload.metadata, configuration: payload.configuration };
      return { id: payload.id, ...workspaces[payload.id] };
    }
    if (method === "PUT" && /^\/v3\/workspaces\/[^/]+$/.test(apiPath)) {
      const id = decodeURIComponent(apiPath.split("/").pop());
      workspaces[id].configuration = { ...workspaces[id].configuration, ...payload.configuration };
      return { id, ...workspaces[id] };
    }
    const sessionMatch = apiPath.match(/^\/v3\/workspaces\/[^/]+\/sessions(?:\/([^/]+)\/messages(\/list)?)?/);
    if (sessionMatch && method === "POST") {
      const [, sessionId, list] = sessionMatch;
      if (!sessionId) {
        sessions[payload.id] ??= [];
        return { id: payload.id };
      }
      const id = decodeURIComponent(sessionId);
      if (list) {
        if (!sessions[id]) {
          const error = new Error("not found");
          error.status = 404;
          throw error;
        }
        return { items: sessions[id], total: sessions[id].length };
      }
      sessions[id].push(...payload.messages);
      return payload.messages;
    }
    throw new Error(`unexpected request ${method} ${apiPath}`);
  };
  return { request, calls, workspaces, sessions };
}

const OWN = { metadata: { rebuild_run: "full-test" }, configuration: { summary: { enabled: false }, dream: { enabled: false } } };

test("the guard refuses another workspace on the server and an unmarked target, and accepts its own marker", async () => {
  const other = fakeHoncho({ workspaces: { memory: OWN, "neuromem-real-month": { metadata: {}, configuration: {} } } });
  await assert.rejects(guardServer(other.request, { workspace: "memory", runId: "full-test" }, { log: quiet }), /other workspaces \(neuromem-real-month\)/);
  const unmarked = fakeHoncho({ workspaces: { memory: { metadata: {}, configuration: OWN.configuration } } });
  await assert.rejects(guardServer(unmarked.request, { workspace: "memory", runId: "full-test" }, { log: quiet }), /without this run's marker/);
  const otherRun = fakeHoncho({ workspaces: { memory: { ...OWN, metadata: { rebuild_run: "pilot" } } } });
  await assert.rejects(guardServer(otherRun.request, { workspace: "memory", runId: "full-test" }, { log: quiet }), /without this run's marker/);
  for (const honcho of [other, unmarked, otherRun]) assert.equal(honcho.calls.some((call) => call.apiPath === "/v3/workspaces"), false, "never created");

  const own = fakeHoncho({ workspaces: { memory: OWN } });
  assert.equal((await guardServer(own.request, { workspace: "memory", runId: "full-test" }, { log: quiet })).created, false);
  // Summaries on are accepted only after this run turned them on itself.
  const summaryOn = fakeHoncho({ workspaces: { memory: { ...OWN, configuration: { ...OWN.configuration, summary: { enabled: true } } } } });
  await assert.rejects(guardServer(summaryOn.request, { workspace: "memory", runId: "full-test" }, { log: quiet }), /not one this run set/);
  assert.equal((await guardServer(summaryOn.request, { workspace: "memory", runId: "full-test", summaryEnabled: true }, { log: quiet })).created, false);

  const empty = fakeHoncho();
  assert.equal((await guardServer(empty.request, { workspace: "memory", runId: "full-test" }, { log: quiet })).created, true);
  assert.deepEqual(empty.calls.at(-1), {
    method: "POST",
    apiPath: "/v3/workspaces",
    payload: { id: "memory", metadata: { rebuild_run: "full-test" }, configuration: { summary: { enabled: false }, dream: { enabled: false } } },
  });
});

async function runFixture(t, { entries = 4, fail = "" } = {}) {
  const dir = await temporaryDirectory(t, "run");
  const manifest = path.join(dir, "manifest.jsonl");
  const items = [];
  for (let index = 1; index <= entries; index += 1) {
    const provider = index % 2 ? "claude" : "codex";
    const staged = path.join(dir, "stage", `${index}.jsonl`);
    await put(staged, "{}\n");
    items.push({ seq: index, kind: provider, provider, machine: "drive", file: staged, files: [{ source: staged, staged, role: "main" }], session_id: `${provider}-${index}`, start: `2026-09-0${index}T00:00:00.000Z`, end: `2026-09-0${index}T00:01:00.000Z`, messages: 2, peers: { me: 1, [`assistant_${provider}`]: 1 } });
  }
  const payload = path.join(dir, "stage", "direct", "hermes-x.json");
  await put(payload, JSON.stringify({
    kind: "hermes",
    session: { id: "hermes-x", metadata: { source: "hermes" }, peers: { me: { observe_me: true, observe_others: false }, assistant_hermes: { observe_me: false, observe_others: false } } },
    messages: [
      { peer_id: "me", content: "q", created_at: "2026-09-09T00:00:00.000Z", metadata: { source: "hermes", source_turn_hash: "hermes:x:1" } },
      { peer_id: "assistant_hermes", content: "a", created_at: "2026-09-09T00:00:01.000Z", metadata: { source: "hermes", source_turn_hash: "hermes:x:2" } },
    ],
  }));
  items.push({ seq: entries + 1, kind: "hermes", provider: "hermes", machine: "state.db", file: "state.db", payload, session_id: "hermes-x", start: "2026-09-09T00:00:00.000Z", end: "2026-09-09T00:00:01.000Z", first_turn: "2026-09-09T00:00:00.000Z", messages: 2, peers: { me: 1, assistant_hermes: 1 } });
  await put(manifest, items.map(line).join(""));
  await put(manifest.replace(/\.jsonl$/, ".summary.json"), JSON.stringify({ char_limit: 24000, tz: "Asia/Seoul", gates: [], inputs: { agy_history: "/x/history.jsonl" } }));
  const record = path.join(dir, "collector-calls.jsonl");
  const collector = await put(
    path.join(dir, "fake-collector.mjs"),
    `import fs from "node:fs";
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("HONCHO_")));
fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, env }) + "\\n");
const transcript = argv[argv.indexOf("--transcript") + 1] || "";
const failing = (process.env.FAKE_FAIL || "").split(",").filter(Boolean);
if (failing.some((name) => transcript.endsWith("/" + name + ".jsonl"))) {
  console.error(JSON.stringify({ ok: false, error: "HTTP 500 for test" }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, new_messages: 2 }));
`,
  );
  const env = {
    PATH: process.env.PATH,
    FAKE_RECORD: record,
    FAKE_FAIL: fail,
    HONCHO_AGENT_TARGET_FOLDERS: '["/somewhere"]',
    HONCHO_TARGET_API_TOKEN: "secret",
    HONCHO_AGENT_DRY_RUN: "1",
    HONCHO_USER_NAME: "someone_live",
    HONCHO_ASSISTANT_NAME: "someone",
    HONCHO_CLAUDE_ASSISTANT_NAME: "someone_else",
    HONCHO_AGY_AUTOMATION_PEER: "elsewhere",
    HONCHO_API_BEARER_TOKEN: "kept",
  };
  const runDir = path.join(dir, "run");
  const options = { manifest, workspace: "memory", runId: "full-test", userPeer: "me", baseUrl: "http://127.0.0.1:9", runDir, collector, tag: "rebuild-test", allowUnpinned: true };
  return { dir, manifest, record, collector, env, runDir, items, options };
}

test("run refuses to start from an unpinned copy, against a crowded server, or with open plan gates", async (t) => {
  const r = await runFixture(t);
  const honcho = fakeHoncho();
  await assert.rejects(run({ ...r.options, allowUnpinned: false }, { log: quiet, env: r.env, request: honcho.request }), /pinned copy/);
  // The person's peer has no default.
  await assert.rejects(run({ ...r.options, userPeer: undefined }, { log: quiet, env: r.env, request: honcho.request }), /run needs --user-peer/);
  assert.throws(() => collectorEnv({}, { provider: "claude", runDir: "/r", workspace: "w", tag: "t", baseUrl: "http://h" }), /needs --user-peer/);
  assert.deepEqual(honcho.calls, []);
  const crowded = fakeHoncho({ workspaces: { other: { metadata: {}, configuration: {} } } });
  await assert.rejects(run(r.options, { log: quiet, env: r.env, request: crowded.request }), /other workspaces/);
  await assert.rejects(fsp.access(r.record));
  await put(r.manifest.replace(/\.jsonl$/, ".summary.json"), JSON.stringify({ gates: ["no ChatGPT export"] }));
  await assert.rejects(run(r.options, { log: quiet, env: r.env, request: fakeHoncho().request }), /open gates/);
  // A run under another name than the plan's would split the person across two peers.
  await put(r.manifest.replace(/\.jsonl$/, ".summary.json"), JSON.stringify({ gates: [], user_peer: "someone_else" }));
  await assert.rejects(run(r.options, { log: quiet, env: r.env, request: fakeHoncho().request }), /differs from the plan's "someone_else"/);

  const runDir = path.join(r.dir, "pinned");
  await put(path.join(runDir, "bridge-rev.txt"), "abc1234\n");
  assert.equal(pinnedRevision(runDir, path.join(runDir, "bridge", "scripts", "rebuild-import.mjs")), "abc1234");
  assert.equal(pinnedRevision(runDir, "/Users/me/dev/honcho-agent-bridge/scripts/rebuild-import.mjs"), null);
});

test("run gives the collector the rebuild environment and posts direct entries itself", async (t) => {
  const r = await runFixture(t, { entries: 2 });
  const honcho = fakeHoncho();
  const result = await run(r.options, { log: quiet, env: r.env, request: honcho.request });
  assert.deepEqual([result.ok, result.failed, result.stopped], [3, 0, false]);
  const calls = await readLines(r.record);
  assert.equal(calls.length, 2, "the collector runs only for collector kinds");
  assert.deepEqual(calls[0].argv, ["--provider", "claude", "--transcript", r.items[0].files[0].staged, "--workspace", "memory"]);
  assert.deepEqual(calls[0].env, {
    HONCHO_API_BEARER_TOKEN: "kept",
    HONCHO_BASE_URL: "http://127.0.0.1:9",
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_AGENT_PROVIDER: "claude",
    HONCHO_USER_NAME: "me",
    HONCHO_AGENT_HOOK_STATE: path.join(r.runDir, "state", "claude.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(r.runDir, "logs", "claude.log"),
    HONCHO_AGENT_IMPORT_TRIGGER: "rebuild-test",
    HONCHO_CODEX_DREAM_EVERY_MESSAGES: "0",
    HONCHO_AGENT_HTTP_TIMEOUT_SECONDS: "60",
    HONCHO_AGENT_MESSAGE_CHAR_LIMIT: "24000",
    HONCHO_AGY_HISTORY: "/x/history.jsonl",
  });
  const posted = honcho.sessions["hermes-x"];
  assert.deepEqual(posted.map((message) => [message.peer_id, message.metadata.memory_trigger]), [["me", "rebuild-test"], ["assistant_hermes", "rebuild-test"]]);
  const sessionCreate = honcho.calls.find((call) => call.apiPath === "/v3/workspaces/memory/sessions");
  assert.deepEqual(sessionCreate.payload.peers.assistant_hermes, { observe_me: false, observe_others: false });
  assert.equal(collectorEnv({ HONCHO_GROK_ASSISTANT_NAME: "x" }, { provider: "agy", runDir: "/r", workspace: "w", tag: "t", baseUrl: "http://h", userPeer: "me" }).HONCHO_AGY_HISTORY, path.join("/r", "state", "no-agy-history.jsonl"));
});

test("a Codex extra is posted directly after its main file, never through the collector", async (t) => {
  const f = await driveFixture(t);
  const { entries } = await plan(planOptions(f, { roots: [`codex:drive:${path.join(f.drive, "codex")}`], cursor: undefined }), { log: quiet });
  assert.deepEqual(entries.map((entry) => entry.kind), ["codex", "codex-extra"]);
  await put(f.out.replace(/\.jsonl$/, ".summary.json"), JSON.stringify({ ...JSON.parse(await fsp.readFile(f.out.replace(/\.jsonl$/, ".summary.json"), "utf8")), gates: [] }));
  const record = path.join(f.dir, "calls.jsonl");
  const collector = await put(path.join(f.dir, "collector.mjs"), `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log(JSON.stringify({ ok: true, new_messages: 2 }));\n`);
  const honcho = fakeHoncho();
  await run({ manifest: f.out, workspace: "memory", runId: "full-test", userPeer: "me", baseUrl: "http://h", runDir: path.join(f.dir, "run"), collector, allowUnpinned: true }, { log: quiet, env: { PATH: process.env.PATH }, request: honcho.request });
  const collectorCalls = await readLines(record);
  assert.equal(collectorCalls.length, 1);
  assert.match(collectorCalls[0][3], /rollout-2026-09-03T11-00-00-/);
  assert.deepEqual(honcho.sessions[`codex-${U.codexMain}`].map((message) => message.content), ["a turn only the version has"]);
});

test("summaries switch on once, before the first entry starting on or after --summaries-from, and a resume accepts it", async (t) => {
  const r = await runFixture(t, { entries: 4 });
  const honcho = fakeHoncho();
  await run({ ...r.options, summariesFrom: "2026-09-03T09:00", limit: 2 }, { log: quiet, env: r.env, request: honcho.request });
  assert.equal(honcho.calls.filter((call) => call.method === "PUT").length, 0, "entries 1 and 2 start before 2026-09-03 KST 09:00");
  await run({ ...r.options, summariesFrom: "2026-09-03T09:00" }, { log: quiet, env: r.env, request: honcho.request });
  const puts = honcho.calls.filter((call) => call.method === "PUT");
  assert.deepEqual(puts.map((call) => call.payload), [{ configuration: { summary: { enabled: true } } }]);
  const putIndex = honcho.calls.indexOf(puts[0]);
  const collectorRuns = await readLines(r.record);
  assert.equal(collectorRuns.length, 4);
  assert.equal(honcho.workspaces.memory.configuration.summary.enabled, true);
  assert.equal(honcho.workspaces.memory.configuration.dream.enabled, false);
  const state = JSON.parse(await fsp.readFile(path.join(r.runDir, "state", "driver.json"), "utf8"));
  assert.equal(state.summary_enabled_before_seq, 3);
  assert.ok(putIndex > 0);
  // Resuming against the switched workspace is accepted, and nothing is switched again.
  const again = await run({ ...r.options, summariesFrom: "2026-09-03T09:00" }, { log: quiet, env: r.env, request: honcho.request });
  assert.deepEqual([again.ok, again.failed], [0, 0]);
  assert.equal(honcho.calls.filter((call) => call.method === "PUT").length, 1);
});

test("run resumes from the ledger, stops after three failures in a row, and a direct post resumed after a crash sends only what is missing", async (t) => {
  const r = await runFixture(t, { entries: 6, fail: "3,4,5" });
  const honcho = fakeHoncho();
  const first = await run({ ...r.options, limit: 1 }, { log: quiet, env: r.env, request: honcho.request });
  assert.equal(first.ok, 1);
  const second = await run(r.options, { log: quiet, env: r.env, request: honcho.request });
  assert.deepEqual([second.ok, second.failed, second.stopped], [1, 3, true]);
  const third = await run(r.options, { log: quiet, env: { ...r.env, FAKE_FAIL: "" }, request: honcho.request });
  assert.deepEqual([third.ok, third.failed, third.stopped], [5, 0, false]);
  const sent = (await readLines(r.record)).map((call) => path.basename(call.argv[3]));
  assert.deepEqual(sent, ["1.jsonl", "2.jsonl", "3.jsonl", "4.jsonl", "5.jsonl", "3.jsonl", "4.jsonl", "5.jsonl", "6.jsonl"]);
  const ledger = await readLines(ledgerPathFor(r.runDir, r.manifest));
  assert.equal(ledger.filter((entry) => entry.status === "ok").length, 7);
  assert.equal(ledger[0].status, "started");

  // A direct entry whose first post landed before a crash: the retry lists the session and skips it.
  const payload = JSON.parse(await fsp.readFile(r.items.at(-1).payload, "utf8"));
  const crashed = fakeHoncho({ sessions: { "hermes-x": [{ ...payload.messages[0] }] } });
  const resumed = await postDirect(crashed.request, "memory", payload, { tag: "t", reconcile: true });
  assert.deepEqual(resumed, { posted: 1, skipped: 1 });
  assert.deepEqual(crashed.sessions["hermes-x"].map((message) => message.content), ["q", "a"]);
});

test("catch-up plans only turns the run state lacks, sorted by the first new turn, within the mtime window", async (t) => {
  const f = await driveFixture(t);
  const options = planOptions(f, { roots: [`claude:drive:${path.join(f.drive, "claude")}`], cursor: undefined, to: undefined });
  const { entries } = await plan(options, { log: quiet });
  const claude = entries.find((entry) => entry.session_id === `claude-${U.claude}`);
  // The run state already holds the main file's two turns.
  const { turnHashCandidates } = await import("../scripts/turn-identity.mjs");
  const stateDir = path.join(f.dir, "run", "state");
  const imported = [
    turnHashCandidates(claude.session_id, { role: "user", source_message_id: "c-u1", content: "plan a picnic" })[0],
    turnHashCandidates(claude.session_id, { role: "assistant", source_message_id: "c-a1", content: "bring sandwiches" })[0],
  ];
  const sdkState = turnHashCandidates(`claude-${U.sdk}`, { role: "user", source_message_id: "s-u1", content: "Current position:" })[0];
  const sdkState2 = turnHashCandidates(`claude-${U.sdk}`, { role: "assistant", source_message_id: "s-a1", content: "e5" })[0];
  await put(path.join(stateDir, "claude.json"), JSON.stringify({ version: 2, sessions: { [claude.session_id]: { imported_hashes: imported }, [`claude-${U.sdk}`]: { imported_hashes: [sdkState, sdkState2] } } }));
  const catchUpOut = path.join(f.dir, "run", "catchup-a.jsonl");
  const result = await plan({ ...options, catchUp: true, stateDir, out: catchUpOut }, { log: quiet });
  const ids = result.entries.map((entry) => entry.session_id);
  assert.equal(ids.includes(`claude-${U.sdk}`), false, "nothing new in it");
  const again = result.entries.find((entry) => entry.session_id === claude.session_id);
  assert.equal(again.turns, 1);
  assert.equal(again.first_new, "2026-09-02T00:59:00.000Z");
  assert.ok(result.exclusions.some((item) => item.session_id === `claude-${U.sdk}` && item.reason === "no-new-turns"));
  assert.match(again.files[0].staged, /stage\/catchup-a\//, "a catch-up stages beside the full run, not over it");

  // --mtime-before leaves out files changed at or after the switch.
  const past = new Date(Date.now() - 3_600_000);
  const formatted = formatInZone(past.getTime(), "Asia/Seoul").slice(0, 19);
  const none = await plan({ ...options, catchUp: true, stateDir, out: path.join(f.dir, "run", "catchup-b.jsonl"), mtimeBefore: formatted }, { log: quiet });
  assert.deepEqual(none.entries, []);
  await assert.rejects(plan({ ...options, userPeer: undefined }, { log: quiet }), /^Error: plan needs --user-peer/);
  await assert.rejects(plan({ ...options, userPeer: " ", catchUp: true, stateDir, out: path.join(f.dir, "run", "catchup-c.jsonl") }, { log: quiet }), /plan --catch-up needs --user-peer/);
  assert.throws(() => parseCli(["plan", "--nope"]), /unknown option/);
  assert.deepEqual(parseCli(["verify", "--manifest", "a.jsonl", "--manifest", "b.jsonl"]).options.manifest, ["a.jsonl", "b.jsonl"]);
});

test("verify adds up entries that share a session and compares counts, first and last times and peers", async (t) => {
  const entries = [
    { seq: 1, session_id: "codex-a", provider: "codex", start: "2026-09-01T00:00:00.000Z", end: "2026-09-01T00:05:00.000Z", messages: 2, peers: { me: 1, assistant_codex: 1 } },
    { seq: 2, kind: "codex-extra", session_id: "codex-a", provider: "codex", start: "2026-09-01T00:00:00.000Z", first_turn: "2026-08-31T23:59:00.000Z", end: "2026-08-31T23:59:00.000Z", messages: 1, peers: { me: 1 } },
  ];
  const expected = expectedSessions(entries).get("codex-a");
  assert.deepEqual([expected.messages, new Date(expected.firstMs).toISOString(), new Date(expected.lastMs).toISOString()], [3, "2026-08-31T23:59:00.000Z", "2026-09-01T00:05:00.000Z"]);
  const stored = [
    { peer_id: "me", created_at: "2026-08-31T23:59:00+00:00", metadata: { source: "codex" } },
    { peer_id: "me", created_at: "2026-09-01T00:00:00Z", metadata: { source: "codex" } },
    { peer_id: "assistant_codex", created_at: "2026-09-01T00:05:00.000000Z", metadata: { source: "codex" } },
  ];
  assert.deepEqual(compareSession(expected, stored), []);
  assert.deepEqual(compareSession(expected, stored.slice(0, 2)), ["messages 2 != manifest 3", "last created_at 2026-09-01T00:00:00.000Z != manifest 2026-09-01T00:05:00.000Z", "peer assistant_codex 0 != manifest 1"]);

  const dir = await temporaryDirectory(t, "verify");
  const manifest = await put(path.join(dir, "manifest.jsonl"), [...entries, { seq: 3, session_id: "claude-gone", provider: "claude", start: "2026-09-02T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z", messages: 1, peers: {} }].map(line).join(""));
  const honcho = fakeHoncho({ sessions: { "codex-a": stored } });
  const report = await verify({ manifest: [manifest], workspace: "memory", baseUrl: "http://h" }, { log: quiet, request: honcho.request });
  assert.deepEqual([report.checked, report.matched, report.missing], [2, 1, 1]);
  assert.deepEqual(report.by_source_peer["codex\tme"], { expected: 2, actual: 2 });
  assert.equal(new Set(honcho.calls.map((call) => call.method)).size, 1, "list requests only");
});

test("sortEntries keeps a dependent entry right after the one it follows", () => {
  const sorted = sortEntries([
    { kind: "codex-extra", provider: "codex", machine: "drive", file: "/m", after_file: "/m", session_id: "codex-a", start: "2026-09-01T00:00:00.000Z" },
    { kind: "codex", provider: "codex", machine: "drive", file: "/m", session_id: "codex-a", start: "2026-09-01T00:00:00.000Z" },
    { kind: "claude", provider: "claude", machine: "drive", file: "/c", session_id: "claude-b", start: "2026-08-31T00:00:00.000Z" },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.kind), ["claude", "codex", "codex-extra"]);
});
