// The parts of the 묻기 screen that are only data: where a link points the
// screen, the words it uses for whoever the question is about, and what an
// answer was built from. No DOM here, so the tests can load it.
import { isAssistant, speakerLabel } from "./format.js";

/** Honcho's own term and values; the screen does not rename them. */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "max"];
export const REASONING_HINT = "Honcho가 답을 찾을 때 몇 번까지 검색할지(max_tool_iterations)와 모델 설정(effort/thinking)을 이 단계별로 정합니다.";

/** What each conclusion level means, for a tooltip next to the term itself. */
export const LEVEL_NOTES = {
  explicit: "대화에 나온 사실",
  deductive: "사실에서 추론한 것",
  inductive: "패턴에서 짐작한 것",
  contradiction: "서로 어긋나는 기억",
};

/**
 * `#/ask/session/<id>`, `#/ask/peer/<id>` and `#/ask/model/<id>`. The router
 * splits the decoded hash on "/", so a model id that holds one is put back.
 */
export function askRoute(params = []) {
  const [kind, ...rest] = params;
  const value = rest.join("/");
  if (!value) return {};
  if (kind === "session") return { mode: "memory", session: value };
  if (kind === "peer") return { mode: "memory", about: value };
  if (kind === "model") return { mode: "model", model: value };
  return {};
}

/** Who or what the next question is aimed at; the screen's words follow it. */
export function askTarget({ mode, about, me, session }) {
  if (mode === "model") return "model";
  if (session) return "session";
  if (about && about === me) return "me";
  if (isAssistant(about)) return "agent";
  return "person";
}

const MEMORY_TEXT = "Honcho가 모인 대화와 정리된 기억을 찾아 읽고 답합니다. reasoning_level을 올리면 더 오래 찾습니다.";

/** The empty screen's title, its starters and the editor's placeholder. */
export function askCopy({ mode, about, me, session, model }) {
  const kind = askTarget({ mode, about, me, session });
  const name = speakerLabel(about, me) || "고른 사람";
  if (kind === "model") {
    return {
      kind,
      title: model ? `${model}에게 바로 물어보세요` : "모델에게 바로 물어보세요",
      text: "기억을 거치지 않고 구독 계정의 모델이 바로 답합니다. 이 화면을 닫으면 대화는 남지 않습니다.",
      placeholder: model ? `${model}에게 바로 물어보세요` : "모델에게 바로 물어보세요",
      starters: ["이 문장을 더 짧게 다듬어 줘: ", "다음 코드가 무슨 일을 하는지 설명해 줘:\n"],
    };
  }
  if (kind === "session") {
    return {
      kind,
      title: "이 대화에 대해 물어보세요",
      text: "Honcho가 이 대화 안에서만 찾아 읽고 답합니다.",
      placeholder: "이 대화에 대해 물어보세요",
      starters: ["이 대화에서 정한 결정을 정리해 줘", "이 대화에서 아직 남은 할 일이 뭐야?", "이 대화를 세 줄로 요약해 줘"],
    };
  }
  if (kind === "me") {
    return {
      kind,
      title: "나에 대해 Honcho가 아는 것을 물어보세요",
      text: MEMORY_TEXT,
      placeholder: "나에 대해 물어보세요",
      starters: ["지난주에 내가 무슨 작업을 했는지 정리해 줘", "내가 요즘 가장 신경 쓰는 문제가 뭐야?", "최근에 정한 결정과 그 이유를 알려 줘"],
    };
  }
  if (kind === "agent") {
    return {
      kind,
      title: `${name}의 작업에 대해 물어보세요`,
      text: "Honcho가 이 에이전트가 남긴 대화와 정리된 기억을 찾아 읽고 답합니다. reasoning_level을 올리면 더 오래 찾습니다.",
      placeholder: `${name}의 작업에 대해 물어보세요`,
      starters: [`최근 ${name} 작업에서 찾아낸 것을 정리해 줘`, `최근 ${name} 작업에서 정한 결정과 그 이유를 알려 줘`, `${name} 작업 중 끝내지 못하고 남은 일이 뭐야?`],
    };
  }
  return {
    kind,
    title: `${name}에 대해 Honcho가 아는 것을 물어보세요`,
    text: MEMORY_TEXT,
    placeholder: `${name}에 대해 물어보세요`,
    starters: [`${name}의 요즘 관심사와 하는 일을 정리해 줘`, `${name}의 최근 결정과 그 이유를 알려 줘`, `${name}의 선호와 일하는 방식을 알려 줘`],
  };
}

/**
 * The evidence of one or more chat calls as one list, each conclusion and
 * message once. Null when no call carried evidence: a server that ignores
 * `include_evidence` says nothing about what it read, and neither does the page.
 */
export function mergeEvidence(list = []) {
  const present = list.filter((evidence) => evidence && typeof evidence === "object");
  if (!present.length) return null;
  const conclusions = new Map();
  const messages = new Map();
  let toolCalls = 0;
  for (const evidence of present) {
    for (const item of evidence.conclusions || []) if (item?.id && !conclusions.has(item.id)) conclusions.set(item.id, item);
    for (const item of evidence.messages || []) if (item?.id && item.session_id && !messages.has(item.id)) messages.set(item.id, item);
    toolCalls += (evidence.tool_calls || []).length;
  }
  return { conclusions: [...conclusions.values()], messages: [...messages.values()], toolCalls };
}

/**
 * A few messages worth fetching text for: one from each conversation in turn,
 * the conversations the agent read most first, so a long grep in one of them
 * does not crowd the others out.
 */
export function pickMessages(messages = [], limit = 6) {
  const bySession = new Map();
  for (const message of messages) {
    if (!bySession.has(message.session_id)) bySession.set(message.session_id, []);
    bySession.get(message.session_id).push(message);
  }
  const queues = [...bySession.values()].sort((a, b) => b.length - a.length);
  const picked = [];
  for (let round = 0; picked.length < limit && queues.some((queue) => queue.length > round); round += 1) {
    for (const queue of queues) {
      if (picked.length >= limit) break;
      if (queue[round]) picked.push(queue[round]);
    }
  }
  return picked;
}

export function sessionCount(messages = []) {
  return new Set(messages.map((message) => message.session_id)).size;
}

/** Markdown marks read as noise in a one-line preview. */
export function oneLine(text, length = 140) {
  const line = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*|__|`|^#+\s*|\|?\s*:?-{3,}:?\s*/gm, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

// The same rule the app server uses for a conversation's title in the list:
// the person's first line, skipping the instructions a tool pastes in first.
const PREAMBLE = /^\s*(<[a-z_-]+[\s>]|#\s*AGENTS|#\s*CLAUDE|\[Request interrupted|Caveat:)/i;

export function sessionTitle(messages = []) {
  const opening = messages.find((message) => message.metadata?.direct_user && !PREAMBLE.test(message.content || ""))
    || messages.find((message) => !PREAMBLE.test(message.content || ""));
  if (!opening) return "";
  const line = String(opening.content || "").split(/\r?\n/).map((part) => part.trim()).find((part) => part && !part.startsWith("```"));
  if (!line) return "";
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}
