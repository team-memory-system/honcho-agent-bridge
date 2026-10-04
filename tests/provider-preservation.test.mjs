import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTranscript as parseCodex } from "../scripts/providers/codex.mjs";
import { parseTranscript as parseClaude } from "../scripts/providers/claude.mjs";
import { normalizeText } from "../scripts/providers/shared.mjs";

async function fixture(t, rows) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-preservation-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  await fsp.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

const codexRow = (role, text) => ({
  type: "response_item", timestamp: "2026-01-01T00:00:00Z",
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const claudeRow = (uuid, content, extra = {}) => ({
  type: "user", uuid, sessionId: "session-1", timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content }, ...extra,
});
const queuedRow = (uuid, prompt, extra = {}) => ({
  type: "attachment", uuid, sessionId: "session-1", timestamp: "2026-01-01T00:00:08Z",
  attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt }, ...extra,
});

test("request markers in ordinary or quoted dialogue never truncate either speaker", async (t) => {
  const texts = [
    "앞 문장. My request for Codex: 이 문구를 설명해 줘. 뒷 문장.",
    "설명을 보존해.\n## My request for Codex:\n이것도 인용문이야.",
    "## My request for Codex:\n이 제목으로 문서를 작성해 줘.",
    "예시:\n```text\n# Files mentioned by the user:\n\n## a.txt: /tmp/a.txt\n\n## My request for Codex:\nexample\n```\n설명 끝.",
    "# Files mentioned by the user:\n사용자가 직접 쓴 설명.\n## My request for Codex:\n이 설명도 남겨.",
  ];
  for (const text of texts) assert.equal(normalizeText(text), text);
  const rows = texts.flatMap((text) => [codexRow("user", text), codexRow("assistant", text)]);
  const parsed = await parseCodex(await fixture(t, rows));
  assert.deepEqual(parsed.turns.map((turn) => turn.content), texts.flatMap((text) => [text, text]));
  const claude = await parseClaude(await fixture(t, texts.flatMap((text, i) => [
    claudeRow(`u-${i}`, text), claudeRow(`a-${i}`, "", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
  ])));
  assert.deepEqual(claude.turns.map((turn) => turn.content), texts.flatMap((text) => [text, text]));
});

test("only Codex user file-mention envelopes unwrap, preserving every later marker", async (t) => {
  const body = "앞 문장\n## My request for Codex:\n가운데 문장 My request for Codex: 뒷 문장";
  const wrapper = `# Files mentioned by the user:\n\n## a.txt: /tmp/a.txt\n\n## b.txt: C:\\tmp\\b.txt\n\n## My request for Codex:\n${body}`;
  const parsed = await parseCodex(await fixture(t, [codexRow("user", wrapper), codexRow("assistant", wrapper)]));
  assert.deepEqual(parsed.turns.map((turn) => turn.content), [body, wrapper]);
  assert.equal(normalizeText(wrapper), wrapper, "shared/Claude parsing must not interpret Codex UI markup");
});

test("policy removal requires the complete app envelope and a user source", async (t) => {
  const oldPolicy = "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nGlobal Agent Policy\n</INSTRUCTIONS>\n<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>";
  const policy = oldPolicy.replace("instructions\n", "instructions for /tmp\n");
  const keep = [
    "# AGENTS.md instructions 이 제목이 무슨 뜻이야?",
    "# AGENTS.md instructions for my app\n본문을 만들어 줘.",
    `${oldPolicy}\n\n이 지침에서 Global Agent Policy를 바꿔 줘.`,
    `${oldPolicy}\n\n이후의 직접 요청을 보존해.\n<INSTRUCTIONS>다른 인용문</INSTRUCTIONS>`,
    "이 지침을 설명해 줘:\n# AGENTS.md instructions\n\n<INSTRUCTIONS>policy</INSTRUCTIONS>",
    "## Node.js Package Manager\n이 섹션의 내용을 수정해 줘.",
    "Global Agent Policy라는 이름은 유지하자.",
    "<permissions instructions>이런 태그를 어떻게 쓰는지 알려 줘.",
    "<app-context>인용문</app-context>\n이 내용을 바꿔 줘.",
  ];
  const parsed = await parseCodex(await fixture(t, [
    codexRow("user", oldPolicy), codexRow("user", policy),
    ...keep.map((text) => codexRow("user", text)),
    codexRow("assistant", oldPolicy), codexRow("assistant", "<app-context>설명</app-context>"),
  ]));
  assert.deepEqual(parsed.turns.map((turn) => turn.content), [...keep, oldPolicy, "<app-context>설명</app-context>"]);
  const claude = await parseClaude(await fixture(t, keep.map((text, i) => claudeRow(`u-${i}`, text))));
  assert.deepEqual(claude.turns.map((turn) => turn.content), keep);
});

test("meta flags and goal command wrappers do not erase the person's goal", async (t) => {
  const goal = "<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>앱 완성까지 달리자</command-args>";
  const texts = [goal, "<system-reminder>Current goal: 앱 완성까지 달리자</system-reminder>", "/goal 앱 완성까지 달리자"];
  const parsed = await parseClaude(await fixture(t, texts.map((text, i) => claudeRow(`u-${i}`, text, { isMeta: true }))));
  assert.deepEqual(parsed.turns.map((turn) => turn.content), texts);
  const codex = await parseCodex(await fixture(t, texts.map((text) => codexRow("user", text))));
  assert.deepEqual(codex.turns.map((turn) => turn.content), texts);
});

test("empty command UI records still stay out of the dialogue", async (t) => {
  const empty = "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args> </command-args>";
  const claude = await parseClaude(await fixture(t, [claudeRow("empty-command", empty), claudeRow("real", "계속해")]));
  assert.deepEqual(claude.turns.map((turn) => turn.content), ["계속해"]);
  const codex = await parseCodex(await fixture(t, [codexRow("user", empty), codexRow("user", "계속해")]));
  assert.deepEqual(codex.turns.map((turn) => turn.content), ["계속해"]);
});

test("nearby identical human inputs with different record IDs both survive", async (t) => {
  // Observed in real 2.1.277/2.1.287 logs: typed row, then queued_command 8/18s
  // later. source_uuid links to queue-operation.commandUuid, not the typed UUID.
  const queued = queuedRow("wrapper-2", "한 번 더", { timestamp: "2026-01-01T00:00:08.490Z" });
  Object.assign(queued.attachment, { source_uuid: "command-2", delivery_id: "delivery-2", humanTurn: true });
  const file = await fixture(t, [
    claudeRow("typed-1", "한 번 더"),
    { type: "queue-operation", operation: "remove", commandUuid: "command-2", deliveryId: "delivery-2" },
    queued,
    queuedRow("wrapper-3", "한 번 더", { timestamp: undefined }),
  ]);
  const parsed = await parseClaude(file);
  assert.deepEqual(parsed.turns.map((turn) => turn.content), ["한 번 더", "한 번 더", "한 번 더"]);
  assert.deepEqual(parsed.turns.map((turn) => turn.source_message_id), ["typed-1", "wrapper-2", "wrapper-3"]);
  assert.deepEqual(parsed.turns.map((turn) => turn.line_index), [1, 3, 4]);
  assert.equal(parsed.turns[1].created_at, "2026-01-01T00:00:08.490Z");
});

test("only an identical record ID and content is a proven queued replay", async (t) => {
  const parsed = await parseClaude(await fixture(t, [
    claudeRow("same-record", "한 번"),
    queuedRow("same-record", "한 번"),
    queuedRow("different-record", "한 번"),
    queuedRow("same-record", "다른 내용은 보존"),
  ]));
  assert.deepEqual(parsed.turns.map((turn) => [turn.source_message_id, turn.content]), [
    ["same-record", "한 번"], ["different-record", "한 번"], ["same-record", "다른 내용은 보존"],
  ]);
});
