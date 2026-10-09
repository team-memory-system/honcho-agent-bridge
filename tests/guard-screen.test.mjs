// The Jev guard in the owner's words: the reasons the bridge records, the scores
// of a call, and what a trial (가드 시험) comes to for the teammate.
import assert from "node:assert/strict";
import test from "node:test";

import { callReason, callScores, reasonText, trialOutcome, verdictTag } from "../ui/lib/guard.js";

test("each reason the bridge records reads as a few words, by how the call went", () => {
  const denied = (error) => callReason({ status: "denied", error });
  const passed = (error) => callReason({ status: "ok", error });

  assert.equal(denied("out of scope"), "사적인 질문으로 판정");
  assert.equal(denied("That project is not open to you on this MCP server"), "열지 않은 프로젝트");
  assert.equal(denied("query too long to judge"), "너무 길어 판정하지 않고 거부");
  assert.equal(denied("answer withheld: it discloses private matters"), "답에 민감한 내용이 있어 막음");
  assert.equal(denied("answer too long to judge"), "답이 너무 길어 판정하지 않고 막음");
  // A Jev that did not answer stops or lets through by the server's fail mode.
  assert.equal(denied("jev unavailable: team guard: HTTP 502 jev_failed"), "Jev가 답하지 않아 거부");
  assert.equal(passed("jev unavailable: team guard: ConnectError"), "판정 없이 통과 · Jev가 답하지 않음");
  assert.equal(denied("jev unavailable for the answer: team guard: HTTP 429 rate_limited"), "Jev가 답을 판정하지 못해 막음");
  assert.equal(passed("jev unavailable for the answer: team guard: ReadTimeout"), "답 판정 없이 통과 · Jev가 답하지 않음");
  assert.equal(passed("not judged: the team hub has no Jev key"), "판정 없이 통과 · 팀에 Jev 키 없음");
  assert.equal(passed("answer not judged: the team hub does not judge answers"), "답 판정 없이 통과 · 허브가 답 검사를 하지 않음");

  // A call let through can carry the question's reason and the answer's.
  assert.equal(
    passed("jev unavailable: team guard: ConnectError; answer not judged: the team hub does not judge answers"),
    "판정 없이 통과 · Jev가 답하지 않음 · 답 판정 없이 통과 · 허브가 답 검사를 하지 않음",
  );
  assert.equal(passed("not judged: the team hub has no Jev key; not judged: the team hub has no Jev key"), "판정 없이 통과 · 팀에 Jev 키 없음");

  // A plain pass says nothing; an error and an unknown reason stay as they came.
  assert.equal(passed(null), null);
  assert.equal(passed(""), null);
  assert.equal(callReason({ status: "error", error: "Honcho API 500 for /v3/x: boom\ntrace" }), "Honcho API 500 for /v3/x: boom");
  assert.equal(denied("something new"), "something new");
  assert.equal(reasonText(undefined, true), "");
});

test("beside a tag that says what happened, a reason gives only why", () => {
  const cause = (reason, allowed) => reasonText(reason, allowed, { cause: true });
  assert.equal(cause("answer not judged: the team hub does not judge answers", true), "허브가 답 검사를 하지 않음");
  assert.equal(cause("not judged: the team hub has no Jev key", true), "팀에 Jev 키 없음");
  assert.equal(cause("jev unavailable: team guard: ConnectError", true), "Jev가 답하지 않음");
  assert.equal(cause("jev unavailable for the answer: team guard: ReadTimeout", false), "Jev가 답하지 않음");
  assert.equal(cause("answer withheld: it discloses private matters", false), "민감한 내용이 든 답으로 판정");
  assert.equal(cause("query too long to judge", false), "너무 길어 판정하지 않음");
  assert.equal(cause("out of scope", false), "사적인 질문으로 판정");
});

test("a call shows the question's score, then the answer's", () => {
  assert.equal(callScores({ jev_score: 0.0412, answer_score: 0.02 }), "Jev 0.04 · 답 0.02");
  assert.equal(callScores({ jev_score: 0.9, answer_score: null }), "Jev 0.90");
  assert.equal(callScores({ jev_score: null, answer_score: 0.97 }), "답 0.97");
  assert.equal(callScores({ jev_score: 0, answer_score: undefined }), "Jev 0.00");
  assert.equal(callScores({}), "");
});

test("a trial's steps are tagged as the teammate would meet them", () => {
  const pass = { allowed: true, score: 0.03, reason: "in scope", unjudged: false };
  assert.deepEqual(verdictTag(pass, "query"), ["통과", "ok"]);
  assert.deepEqual(verdictTag({ ...pass, allowed: false }, "query"), ["거부", "bad"]);
  assert.deepEqual(verdictTag({ ...pass, allowed: false }, "answer"), ["막음", "bad"]);
  assert.deepEqual(verdictTag({ ...pass, score: null, unjudged: true }, "answer"), ["판정 없이 통과", "warn"]);
  assert.deepEqual(verdictTag(pass, "query", false), ["판정 꺼짐", "warn"]);
  assert.equal(verdictTag(null, "answer"), null, "a step not taken");
});

test("a trial says what the teammate gets: the answer, or only the refusal", () => {
  const message = "This query was refused: it asks for information outside the shared work scope of this memory.";
  const judged = { allowed: true, score: 0.02, reason: "answer in scope", unjudged: false };

  const refused = trialOutcome({ gate: true, outcome: "refused", message, answer: null });
  assert.deepEqual([refused.kind, refused.title, refused.message], ["bad", "질문에서 막힙니다.", message]);

  const withheld = trialOutcome({ gate: true, outcome: "withheld", message, answer: "x", answer_check: { ...judged, allowed: false } });
  assert.deepEqual([withheld.kind, withheld.title, withheld.message], ["bad", "답에서 막힙니다.", message]);
  assert.match(withheld.text, /같은 문구/, "a withheld answer looks like a refused question");

  const passed = trialOutcome({ gate: true, outcome: "passed", message, answer: "배포는 금요일", answer_check: judged });
  assert.deepEqual([passed.kind, passed.title, passed.message], ["ok", "팀원에게 이 답이 그대로 나갑니다.", undefined]);
  assert.equal(trialOutcome({ gate: true, outcome: "passed", answer: "x", answer_check: { ...judged, score: null, unjudged: true } }).kind, "warn");
  assert.equal(trialOutcome({ gate: false, outcome: "passed", answer: "x", answer_check: judged }).kind, "warn");

  const queryOnly = trialOutcome({ gate: true, outcome: "passed", answer: null, answer_check: null });
  assert.deepEqual([queryOnly.kind, queryOnly.title], ["ok", "질문은 통과합니다."]);
  assert.equal(trialOutcome({ gate: false, outcome: "passed", answer: null }).kind, "warn");

  assert.equal(trialOutcome({ gate: true, outcome: "no_answer", error: "Honcho API 404" }).kind, "warn");
  assert.equal(trialOutcome({ outcome: "later" }).title, "알 수 없는 결과입니다.");
});
