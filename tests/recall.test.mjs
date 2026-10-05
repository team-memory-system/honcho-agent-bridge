import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dedupe,
  earlierSessions,
  formatPrompt,
  formatStart,
  isJudgment,
  nearDuplicate,
  pickDecisions,
  pickRelated,
  substantivePrompt,
} from "../scripts/recall.mjs";

const c = (id, content, created_at = "2026-10-01T00:00:00Z", session_id = "claude-a") => ({ id, content, created_at, session_id });

test("judgments are decisions, preferences and instructions, not questions or plain facts", () => {
  for (const text of [
    "user_a wants personal details excluded.",
    "On 2026-10-02, user_a suggested changing the wording “quick start” to “getting started”.",
    "user_a은 문서 길이를 줄이려고 노력할 필요가 없다고 말했다.",
    "user_a은 보고서를 존댓말로 써 달라고 요청했다.",
    "user_a tries to keep scripts as short as possible.",
  ]) assert.equal(isJudgment(text), true, text);
  for (const text of [
    "On 2026-10-03, user_a asked whether the system should reuse earlier work.",
    "user_a works in a design department.",
    "user_a thinks a cache speeds up builds.",
    "user_a instructed to continue the conversation from where it left off without asking any further questions.",
    "user requested that the resumed conversation continue without asking any further questions.",
    "2026년 7월 14일 15시 01분 24초 기준 user가 제시한 게임은 총 50턴 중 44번째 턴이었다.",
    "2026년 7월 14일 14시 57분 36초 기준으로 user가 진행한 게임은 27번째 턴이었다.",
  ]) assert.equal(isJudgment(text), false, text);
  assert.equal(isJudgment("user_a은 문서에 포함할 내용의 기준이 현재 요청과의 관련성이라고 말했다."), true);
});

test("the same note in two wordings is kept once", () => {
  assert.equal(nearDuplicate("user_a wants personal details excluded.", "user_a wants personal details to be excluded."), true);
  assert.equal(nearDuplicate("user_a wants personal details excluded.", "user_a prefers Korean answers."), false);
  const kept = dedupe([c("1", "user_a wants personal details excluded."), c("2", "user_a wants personal details to be excluded."), c("3", "user_a prefers Korean answers.")]);
  assert.deepEqual(kept.map((item) => item.id), ["1", "3"]);
});

test("session start shows the newest decisions first and skips small talk", () => {
  const picked = pickDecisions([
    c("old", "user_a wants an example that is easier to relate to.", "2026-10-01T00:00:00Z"),
    c("fact", "user_a works in a design department.", "2026-10-03T00:00:00Z"),
    c("new", "user_a은 문서 길이를 줄이려고 노력할 필요가 없다고 말했다.", "2026-10-02T00:00:00Z"),
  ]);
  assert.deepEqual(picked.map((item) => item.id), ["new", "old"]);
  const text = formatStart({ summary: "지난 대화 요약", summaryAt: "2026-10-02T15:00:00Z", decisions: picked });
  assert.match(text, /^\[Honcho 기억 · 세션 시작 때 자동으로 불러온 참고\]/);
  assert.match(text, /지난번 이 폴더 대화 요약 \(10\/03\):\n지난 대화 요약/);
  assert.match(text, /- 10\/02 user_a은 문서 길이를/);
  assert.match(text, /주의: /);
  assert.equal(formatStart({ summary: "", decisions: [] }), "");
});

test("a request brings this folder's judgments first and a few from elsewhere, never repeating what was shown", () => {
  const local = [c("l1", "user_a wants the outline reviewed before writing.", "2026-10-01T00:00:00Z", "claude-here"), c("shown", "user_a wants personal details excluded.", "2026-10-02T00:00:00Z", "claude-here")];
  const global = [
    c("l1", "user_a wants the outline reviewed before writing.", "2026-10-01T00:00:00Z", "claude-here"),
    c("g1", "user_a instructed that answers should be in Korean.", "2026-09-01T00:00:00Z", "codex-x"),
    c("g2", "user_a works at a company.", "2026-09-02T00:00:00Z", "codex-y"),
  ];
  const picked = pickRelated({ local, global }, ["shown"]);
  assert.deepEqual(picked.local.map((item) => item.id), ["l1"]);
  assert.deepEqual(picked.elsewhere.map((item) => item.id), ["g1"]);
  const text = formatPrompt(picked);
  assert.match(text, /이 폴더에서:\n- 10\/01 user_a wants the outline/);
  assert.match(text, /다른 곳에서:\n- 09\/01 · codex user_a instructed/);
  assert.equal(formatPrompt({ local: [], elsewhere: [] }), "");
});

test("only a real request triggers recall", () => {
  assert.equal(substantivePrompt("ㅇㅋ"), "");
  assert.equal(substantivePrompt("/compact"), "");
  assert.equal(substantivePrompt("  메모리 영상 회의판 만들어 줘 "), "메모리 영상 회의판 만들어 줘");
});

test("earlier sessions are the folder's other transcripts, newest first, as Honcho session ids", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-recall-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const names = ["aaaa1111-0000-0000-0000-000000000001", "bbbb2222-0000-0000-0000-000000000002", "cccc3333-0000-0000-0000-000000000003"];
  for (const [index, name] of names.entries()) {
    const file = path.join(dir, `${name}.jsonl`);
    await fsp.writeFile(file, "{}\n");
    const when = new Date(Date.UTC(2026, 9, 1 + index));
    await fsp.utimes(file, when, when);
  }
  await fsp.writeFile(path.join(dir, "notes.txt"), "not a transcript");
  const current = path.join(dir, `${names[2]}.jsonl`);
  assert.deepEqual(await earlierSessions(current, 5), [`claude-${names[1]}`, `claude-${names[0]}`]);
  assert.deepEqual(await earlierSessions("", 5), []);
});
