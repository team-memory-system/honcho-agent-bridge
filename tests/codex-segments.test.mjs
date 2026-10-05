import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { codexSegmentId, segmentHashesFromStoredMessages, turnHashCandidates } from "../scripts/turn-identity.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR = path.join(ROOT, "scripts", "collector.mjs");

const THREAD = "01a04e36-27c5-7d13-bfaf-a80e5d22cb68";
const SEGMENT = "01a04e6f-b7d9-72d0-8cb1-1d314978da29";
const SESSION = `codex-${THREAD}`;

// The identity every collector so far gave a Codex turn, written out here so a
// change to turn-identity.mjs cannot quietly change it for ordinary files.
function bareLineHash(line, role) {
  const value = { version: 2, session_id: SESSION, line_index: line, step_index: null, role };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A Honcho stand-in that keeps the messages it is sent and lists them back. */
async function startHoncho(t, { stored = [], failList = false } = {}) {
  const honcho = { stored: [...stored], requests: [], failList };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    honcho.requests.push({ method: request.method, url: request.url, body });
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/messages/list")) {
      if (honcho.failList) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      const page = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("size") || 100);
      response.end(JSON.stringify({ items: honcho.stored.slice((page - 1) * size, page * size), total: honcho.stored.length }));
      return;
    }
    if (url.pathname.endsWith("/messages")) honcho.stored.push(...body.messages);
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  honcho.port = server.address().port;
  honcho.writes = () => honcho.requests.filter((entry) => entry.url.endsWith("/messages"));
  honcho.lists = () => honcho.requests.filter((entry) => entry.url.includes("/messages/list"));
  return honcho;
}

const meta = (extra = {}) => ({ type: "session_meta", payload: { id: THREAD, cwd: "/tmp/project", originator: "Codex Desktop", source: "vscode", ...extra } });
const say = (role, text, timestamp) => ({
  timestamp,
  type: "response_item",
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});

async function writeRows(file, rows) {
  await fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

// Parent: user at line 2, assistant at line 3. Segment: user at line 2 and
// assistant at line 3 (same lines and roles, other words), user at line 4.
async function thread(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-codex-segments-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const parent = path.join(directory, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`);
  const segment = path.join(directory, `rollout-2026-01-01T01-00-00-${THREAD}_${SEGMENT}.jsonl`);
  await writeRows(parent, [
    meta(),
    say("user", "parent question", "2026-01-01T00:00:01Z"),
    say("assistant", "parent answer", "2026-01-01T00:00:02Z"),
  ]);
  await writeRows(segment, [
    meta({ history_mode: "paginated" }),
    say("user", "segment question", "2026-01-01T01:00:01Z"),
    say("assistant", "segment answer", "2026-01-01T01:00:02Z"),
    say("user", "segment follow-up", "2026-01-01T01:00:03Z"),
  ]);
  return { directory, parent, segment, state: path.join(directory, "state.json") };
}

function collect(honcho, files, transcript) {
  const env = {
    ...process.env,
    HONCHO_BASE_URL: `http://127.0.0.1:${honcho.port}`,
    HONCHO_WORKSPACE_ID: "memory",
    HONCHO_USER_NAME: "user_test",
    HONCHO_AGENT_HOOK_STATE: files.state,
    HONCHO_AGENT_HOOK_LOG: path.join(files.directory, "collector.log"),
    HONCHO_CODEX_DREAM_EVERY_MESSAGES: "0",
  };
  return execFileAsync(process.execPath, [COLLECTOR, "--provider", "codex", "--transcript", transcript], { env })
    .then((result) => JSON.parse(result.stdout));
}

test("a continuation segment's turn at an earlier file's line and role is sent, and re-runs send nothing", async (t) => {
  const honcho = await startHoncho(t);
  const files = await thread(t);

  assert.equal((await collect(honcho, files, files.parent)).new_messages, 2);
  const segmentRun = await collect(honcho, files, files.segment);
  assert.equal(segmentRun.codex_segment_id, SEGMENT);
  assert.equal(segmentRun.new_messages, 3);
  assert.deepEqual(honcho.stored.map((message) => message.content), [
    "parent question", "parent answer", "segment question", "segment answer", "segment follow-up",
  ]);
  assert.deepEqual(honcho.stored.slice(0, 2).map((message) => message.metadata.source_turn_hash), [
    bareLineHash(2, "user"), bareLineHash(3, "assistant"),
  ], "a file that is not a segment keeps the line identity");
  assert.equal(honcho.stored[0].metadata.codex_segment_id, undefined);
  assert.deepEqual(honcho.stored.slice(2).map((message) => message.metadata.codex_segment_id), [SEGMENT, SEGMENT, SEGMENT]);
  assert.equal(new Set(honcho.stored.map((message) => message.metadata.source_turn_hash)).size, 5);

  const writes = honcho.writes().length;
  const lists = honcho.lists().length;
  assert.equal((await collect(honcho, files, files.parent)).new_messages, 0);
  assert.equal((await collect(honcho, files, files.segment)).new_messages, 0);
  assert.equal(honcho.writes().length, writes);
  assert.equal(honcho.lists().length, lists, "a reconciled segment is not listed again on every hook");

  // The person continues the thread: only the new turn goes.
  await fsp.appendFile(files.segment, `${JSON.stringify(say("assistant", "segment reply", "2026-01-01T01:00:04Z"))}\n`);
  const continued = await collect(honcho, files, files.segment);
  assert.equal(continued.new_messages, 1);
  assert.equal(honcho.stored.at(-1).content, "segment reply");
  assert.equal(honcho.stored.length, 6);
});

// What a collector before the segment identity left behind: the parent's two turns,
// and of the segment only line 4; its lines 2 and 3 looked sent and were skipped.
function storedByEarlierCollector(files) {
  const message = (file, line, role, content) => ({
    peer_id: role === "user" ? "user_test" : "assistant_codex",
    content,
    metadata: { source: "codex", codex_session_id: SESSION, codex_rollout_path: file, codex_line_index: line, codex_role: role, source_turn_hash: bareLineHash(line, role) },
  });
  return [
    message(files.parent, 2, "user", "parent question"),
    message(files.parent, 3, "assistant", "parent answer"),
    message(files.segment, 4, "user", "segment follow-up"),
  ];
}

test("segment turns an earlier collector sent under the line identity are not sent again", async (t) => {
  for (const stateKind of ["earlier collector's state", "no state on this computer"]) {
    const files = await thread(t);
    const honcho = await startHoncho(t, { stored: storedByEarlierCollector(files) });
    if (stateKind === "earlier collector's state") {
      await fsp.writeFile(files.state, JSON.stringify({
        version: 2,
        sessions: {
          [SESSION]: {
            imported_hashes: [bareLineHash(2, "user"), bareLineHash(3, "assistant"), bareLineHash(4, "user")],
            messages_since_dream: 3,
            rollout_path: files.segment,
            reconciled_source_hashes_at: "2026-01-01T00:00:00.000Z",
            synced_from_honcho_message_total: 0,
          },
        },
      }));
    }

    const first = await collect(honcho, files, files.segment);
    assert.equal(first.new_messages, 2, stateKind);
    assert.deepEqual(honcho.stored.slice(3).map((message) => [message.metadata.codex_line_index, message.content]), [
      [2, "segment question"], [3, "segment answer"],
    ], stateKind);
    const saved = JSON.parse(await fsp.readFile(files.state, "utf8")).sessions[SESSION];
    assert.deepEqual(saved.reconciled_segments, [SEGMENT], stateKind);

    const lists = honcho.lists().length;
    assert.equal((await collect(honcho, files, files.segment)).new_messages, 0, stateKind);
    assert.equal((await collect(honcho, files, files.parent)).new_messages, 0, stateKind);
    assert.equal(honcho.lists().length, lists, stateKind);
    assert.equal(honcho.stored.length, 5, stateKind);
  }
});

test("a segment is not sent while Honcho cannot list what it already holds", async (t) => {
  const files = await thread(t);
  const honcho = await startHoncho(t, { stored: storedByEarlierCollector(files), failList: true });
  await fsp.writeFile(files.state, JSON.stringify({
    version: 2,
    sessions: { [SESSION]: { imported_hashes: [bareLineHash(4, "user")], reconciled_source_hashes_at: "2026-01-01T00:00:00.000Z" } },
  }));
  await assert.rejects(collect(honcho, files, files.segment), (error) => String(error.stderr).includes("Cannot safely import segment"));
  assert.equal(honcho.writes().length, 0);

  honcho.failList = false;
  assert.equal((await collect(honcho, files, files.segment)).new_messages, 2);
});

test("a segment is named by its file, for its own thread only", () => {
  const name = `rollout-2026-08-30T01-52-19-${THREAD}_${SEGMENT}.jsonl`;
  assert.equal(codexSegmentId(`/Users/me/.codex/sessions/2026/08/30/${name}`, THREAD), SEGMENT);
  assert.equal(codexSegmentId(`C:\\Users\\me\\.codex\\sessions\\2026\\08\\30\\${name}`, THREAD), SEGMENT);
  assert.equal(codexSegmentId(name), SEGMENT);
  assert.equal(codexSegmentId(name, SEGMENT), null, "a file of another thread is not this thread's segment");
  assert.equal(codexSegmentId(`rollout-2026-08-30T00-49-27-${THREAD}.jsonl`, THREAD), null);
  assert.equal(codexSegmentId("", THREAD), null);

  const turn = { role: "user", line_index: 7, content: "text" };
  assert.equal(turnHashCandidates(SESSION, turn)[0], bareLineHash(7, "user"));
  const segmentCandidates = turnHashCandidates(SESSION, { ...turn, segment_id: SEGMENT });
  assert.equal(segmentCandidates.includes(bareLineHash(7, "user")), false);
  assert.notEqual(segmentCandidates[0], turnHashCandidates(SESSION, { ...turn, segment_id: "01a05372-d41f-7830-a35d-5d1c88fbc9c0" })[0]);
  assert.equal(turnHashCandidates(SESSION, { ...turn, segment_id: SEGMENT, content: "cleaned differently" })[0], segmentCandidates[0],
    "the segment identity holds no text");

  const stored = [
    { metadata: { codex_rollout_path: `/a/${name}`, codex_line_index: 7, codex_role: "user" } },
    { metadata: { codex_rollout_path: `/a/rollout-2026-08-30T00-49-27-${THREAD}.jsonl`, codex_line_index: 8, codex_role: "user" } },
    { metadata: { codex_line_index: 9, codex_role: "assistant" } },
  ];
  assert.deepEqual(segmentHashesFromStoredMessages(SESSION, SEGMENT, stored), [
    segmentCandidates[0],
    turnHashCandidates(SESSION, { role: "assistant", line_index: 9, segment_id: SEGMENT })[0],
  ], "a stored message without a rollout path counts as already sent");
});
