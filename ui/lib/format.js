// Names and dates the way a person reads them.

const SOURCES = {
  claude: "Claude Code",
  codex: "Codex",
  chatgpt: "ChatGPT",
  agy: "agy",
  hermes: "Hermes",
};

export function sourceLabel(source) {
  return SOURCES[source] || source || "기타";
}

export const SOURCE_FILTERS = [
  ["", "전체"],
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["chatgpt", "ChatGPT"],
  ["agy", "agy"],
];

/** `user_chen` is the person; `assistant_codex` is Codex speaking. */
export function speakerLabel(peerId, me) {
  if (!peerId) return "";
  if (me && peerId === me) return "나";
  const assistant = /^assistant_(.+)$/.exec(peerId);
  if (assistant) return sourceLabel(assistant[1]);
  const automation = /^automation_(.+)$/.exec(peerId);
  if (automation) return `자동 작업 · ${automation[1].replace(/_/g, " ")}`;
  return peerId;
}

export function isAssistant(peerId) {
  return /^assistant_/.test(peerId || "");
}

/** Cron jobs, subagents and SDK calls write as peers too; they are not people. */
export function isAutomation(peerId) {
  return /^automation_/.test(peerId || "");
}

export function peerKind(peerId, me) {
  if (peerId === me) return "me";
  if (isAutomation(peerId)) return "automation";
  if (isAssistant(peerId)) return "agent";
  return "person";
}

const CARD_KINDS = {
  IDENTITY: "신원",
  ATTRIBUTE: "특징",
  PREFERENCE: "선호",
  TRAIT: "성향",
  INSTRUCTION: "지시",
  RELATIONSHIP: "관계",
  GOAL: "목표",
  INTEREST: "관심",
  SKILL: "기술",
};

/** A peer card line is "KIND: text"; show the kind as a label, not a shout. */
export function cardLine(line) {
  const match = /^([A-Z_]{3,20}):\s*(.*)$/.exec(String(line || ""));
  if (!match) return { kind: "", text: String(line || "") };
  return { kind: CARD_KINDS[match[1]] || match[1].toLowerCase(), text: match[2] };
}

const dayFormat = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });
const fullFormat = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });

export function relativeDay(value) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000);
  if (diffDays <= 0) return timeFormat.format(date);
  if (diffDays === 1) return "어제";
  if (diffDays < 7) return `${diffDays}일 전`;
  if (date.getFullYear() === now.getFullYear()) return dayFormat.format(date);
  return `${date.getFullYear()}. ${dayFormat.format(date)}`;
}

export function fullDate(value) {
  return value ? fullFormat.format(new Date(value)) : "";
}

export function time(value) {
  return value ? timeFormat.format(new Date(value)) : "";
}

/** "오후 3:40" today, "10월 14일 오후 3:40" on another day. */
export function dayTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const day = date.toDateString() === new Date().toDateString() ? "" : `${date.getMonth() + 1}월 ${date.getDate()}일 `;
  return `${day}${timeFormat.format(date)}`;
}

export function number(value) {
  return new Intl.NumberFormat("ko-KR").format(value ?? 0);
}

export function ago(value) {
  if (!value) return "";
  const seconds = Math.round((Date.now() - new Date(value)) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}시간 전`;
  return relativeDay(value);
}
