// The 묻기 screen's data rules: where a link lands, which words follow the
// person or agent the question is about, and how an answer's evidence is shown.
import assert from "node:assert/strict";
import test from "node:test";

import { REASONING_LEVELS, askCopy, askRoute, askTarget, mergeEvidence, pickMessages, sessionCount, sessionTitle } from "../ui/lib/ask.js";

test("ask links pick a mode and keep a model id that holds a slash", () => {
  assert.deepEqual(askRoute(["session", "claude-abc"]), { mode: "memory", session: "claude-abc" });
  assert.deepEqual(askRoute(["peer", "user_minji"]), { mode: "memory", about: "user_minji" });
  assert.deepEqual(askRoute(["model", "claude-opus-5-5"]), { mode: "model", model: "claude-opus-5-5" });
  assert.deepEqual(askRoute(["model", "openai", "gpt-5.5"]), { mode: "model", model: "openai/gpt-5.5" });
  assert.deepEqual(askRoute(["model"]), {});
  assert.deepEqual(askRoute([]), {});
  assert.deepEqual(askRoute(["elsewhere", "x"]), {});
});

test("reasoning_level keeps Honcho's own values", () => {
  assert.deepEqual(REASONING_LEVELS, ["minimal", "low", "medium", "high", "max"]);
});

test("the screen's words follow who the question is about", () => {
  const me = "user_chen";
  assert.equal(askTarget({ mode: "model", about: me, me }), "model");
  assert.equal(askTarget({ mode: "memory", about: me, me, session: "s1" }), "session");
  assert.equal(askTarget({ mode: "memory", about: me, me }), "me");
  assert.equal(askTarget({ mode: "memory", about: "assistant_codex", me }), "agent");
  assert.equal(askTarget({ mode: "memory", about: "user_minji", me }), "person");

  const mine = askCopy({ mode: "memory", about: me, me });
  assert.match(mine.title, /^나에 대해/);
  assert.equal(mine.placeholder, "나에 대해 물어보세요");

  const person = askCopy({ mode: "memory", about: "user_minji", me });
  assert.ok(person.starters.every((line) => line.includes("user_minji")));
  assert.equal(person.placeholder, "user_minji에 대해 물어보세요");

  const agent = askCopy({ mode: "memory", about: "assistant_codex", me });
  assert.ok(agent.starters.every((line) => line.includes("Codex")));
  assert.ok(agent.starters.some((line) => line.includes("남은 일")));

  const scoped = askCopy({ mode: "memory", about: me, me, session: "s1" });
  assert.ok(scoped.starters.some((line) => line.includes("결정")));
  assert.ok(scoped.starters.some((line) => line.includes("할 일")));
  assert.equal(scoped.placeholder, "이 대화에 대해 물어보세요");

  const model = askCopy({ mode: "model", about: me, me, model: "claude-opus-5-5" });
  assert.equal(model.placeholder, "claude-opus-5-5에게 바로 물어보세요");
  assert.equal(askCopy({ mode: "model", me }).title, "모델에게 바로 물어보세요");
});

test("a server that ignores include_evidence shows nothing, and views merge without repeats", () => {
  assert.equal(mergeEvidence([undefined, null]), null);
  assert.equal(mergeEvidence([]), null);

  const first = {
    conclusions: [{ id: "c1", level: "explicit", content: "a" }, { id: "c2", level: "deductive", content: "b" }],
    messages: [{ id: "m1", session_id: "s1" }, { id: "m2", session_id: "s1" }],
    tool_calls: [{ tool_name: "search_memory" }],
  };
  const second = {
    conclusions: [{ id: "c2", level: "deductive", content: "b" }, { id: "c3", level: "inductive", content: "c" }],
    messages: [{ id: "m2", session_id: "s1" }, { id: "m3", session_id: "s2" }, { id: "broken" }],
    tool_calls: [],
  };
  const merged = mergeEvidence([first, undefined, second]);
  assert.deepEqual(merged.conclusions.map((item) => item.id), ["c1", "c2", "c3"]);
  assert.deepEqual(merged.messages.map((item) => item.id), ["m1", "m2", "m3"]);
  assert.equal(merged.toolCalls, 1);
  assert.equal(sessionCount(merged.messages), 2);

  const empty = mergeEvidence([{ conclusions: [], messages: [] }]);
  assert.deepEqual(empty, { conclusions: [], messages: [], toolCalls: 0 });
});

test("snippets come from each conversation in turn, the most-read first", () => {
  const messages = [
    { id: "a1", session_id: "A" },
    { id: "b1", session_id: "B" }, { id: "b2", session_id: "B" }, { id: "b3", session_id: "B" },
    { id: "a2", session_id: "A" },
    { id: "c1", session_id: "C" },
  ];
  assert.deepEqual(pickMessages(messages, 4).map((item) => item.id), ["b1", "a1", "c1", "b2"]);
  assert.deepEqual(pickMessages(messages, 10).map((item) => item.id), ["b1", "a1", "c1", "b2", "a2", "b3"]);
  assert.deepEqual(pickMessages([], 6), []);
});

test("a conversation's title is the person's first line, not a pasted preamble", () => {
  const messages = [
    { content: "<system-reminder>instructions</system-reminder>", metadata: { direct_user: true } },
    { content: "# AGENTS.md\nrules", metadata: {} },
    { content: "\n\n인풋창을 고쳐 줘\n자세히는…", metadata: { direct_user: true } },
  ];
  assert.equal(sessionTitle(messages), "인풋창을 고쳐 줘");
  assert.equal(sessionTitle([{ content: "assistant reply", metadata: {} }]), "assistant reply");
  assert.equal(sessionTitle([]), "");
  assert.equal(sessionTitle([{ content: "x".repeat(120), metadata: { direct_user: true } }]).length, 90);
});
