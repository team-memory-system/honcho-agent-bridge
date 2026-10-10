// 기억 다시 정리 (scripts/rederive.mjs), the way 서버 → 기억 서버 and the dashboard say it.
import { number } from "./format.js";
import { etaText, monthText, shortDay } from "./past.js";

/** "10월 13일 03:40". */
export function moment(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  const date = new Date(ms);
  return `${shortDay(ms)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "15:40", or "10월 14일 15:40" on another day. */
function clock(value) {
  const ms = Date.parse(value);
  const date = new Date(ms);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return new Date().toDateString() === date.toDateString() ? time : `${shortDay(ms)} ${time}`;
}

/** "약 4만 번", "약 3,200번". */
export function callsText(calls) {
  const value = Number(calls || 0);
  if (value >= 10_000) return `약 ${number(Math.round(value / 10_000))}만 번`;
  return `약 ${number(Math.max(1, Math.round(value / 100) * 100))}번`;
}

/** "약 12GB", "약 1.4GB", "약 300MB". */
export function bytesText(bytes, { about = true } = {}) {
  const value = Number(bytes || 0);
  const gb = value / 1024 ** 3;
  const text = gb >= 10 ? `${number(Math.round(gb))}GB` : gb >= 1 ? `${gb.toFixed(1)}GB` : `${number(Math.max(1, Math.round(value / 1024 ** 2)))}MB`;
  return about ? `약 ${text}` : text;
}

/** How far the job has got, out of 100: the new deriver's frontier among the messages. */
export function rebuildPercent(job) {
  const derive = job?.derive;
  if (!derive?.total) return 0;
  return Math.min(100, Math.floor((Number(derive.done || 0) / derive.total) * 100));
}

/**
 * The job in one line: what it is doing and how far it has got. 되돌리기 and 다시
 * 바꾸기 go the same way as a rebuild, over what came in since the last switch: they
 * copy it into the memory they switch to, wait for its deriver, then switch.
 */
export function rebuildLine(job) {
  if (!job) return "";
  const undo = job.kind === "undo";
  if (job.phase === "start") return undo ? "바꿀 준비하는 중" : "새 기억을 만들 준비하는 중";
  // A switch back copies only what the other memory lacks: its count would read as all of them.
  if (job.phase === "copy") return undo ? "그동안 들어온 대화를 옮기는 중" : `대화를 옮기는 중 · ${number(job.copied?.conversations || 0)} / ${number(job.totals?.conversations || 0)}`;
  if (job.phase === "derive") {
    const derive = job.derive;
    // Every message is through; what the deriver still does with them is the end of it.
    if (derive?.total && Number(derive.done || 0) >= derive.total) return "마무리하는 중";
    const parts = [];
    if (undo) parts.push("옮긴 대화를 정리하는 중");
    else if (derive?.at) parts.push(`${monthText(derive.at)} 대화까지`);
    if (derive?.total) parts.push(`${rebuildPercent(job)}%`);
    // Resting on a limit, the note under it says when it carries on.
    if (derive?.etaSec && !derive.paused?.until) parts.push(`${etaText(derive.etaSec)} 남음`);
    return parts.join(" · ") || "새 기억을 만드는 중";
  }
  if (job.phase === "scopes") return "마무리하는 중";
  if (!undo) return "새 기억으로 바꾸는 중";
  return job.toRebuilt ? "새 기억으로 다시 바꾸는 중" : "이전 기억으로 바꾸는 중";
}

/** What the job's line says under it. */
export function rebuildNote(job) {
  if (!job) return "";
  if (job.error) return "멈췄습니다. 다시 시도를 누르면 멈춘 곳부터 이어서 합니다.";
  if (job.stopping) return "그만두는 중입니다. 하던 일까지 하고 멈춥니다.";
  if (job.derive?.paused?.until) return `모델 사용 한도에 걸려 쉬는 중입니다. ${clock(job.derive.paused.until)}에 이어서 합니다.`;
  if (job.phase === "swap") return "서버를 다시 켜는 동안 1분쯤 기억 검색이 멈춥니다.";
  if (job.kind === "undo") return `다 옮기면 ${job.toRebuilt ? "새 기억으로 다시 바꿉니다" : "이전 기억으로 되돌립니다"}. 그때까지 지금 기억을 씁니다.`;
  return "다 만들면 새 기억으로 바꿉니다. 그때까지 지금 기억을 씁니다.";
}

/** The last job, once it ended: "10월 13일 03:40에 새 기억으로 바꿈". */
export function lastLine(last) {
  if (!last) return "";
  if (last.cancelled) return `${moment(last.finishedAt)}에 그만둠`;
  return `${moment(last.swappedAt)}에 ${lastTag(last)}`;
}

/** The last switch in a tag: "새 기억으로 바꿈", "이전 기억으로 되돌림", "새 기억으로 다시 바꿈". */
export function lastTag(last) {
  if (last?.kind !== "undo") return "새 기억으로 바꿈";
  return last.toRebuilt ? "새 기억으로 다시 바꿈" : "이전 기억으로 되돌림";
}

/**
 * What the memory kept after a switch is called: the one before the rebuild (이전
 * 기억), or, after going back from it, the one the rebuild made (새 기억), as the
 * rebuild's own window calls them.
 */
export function keptName(previous) {
  return previous?.rebuilt ? "새 기억" : "이전 기억";
}

/** What the memory kept is, under its name. */
export function keptWhat(previous) {
  return previous?.rebuilt ? "다시 정리해 만든 기억입니다." : "다시 정리하기 전의 기억입니다.";
}

/** The dashboard's note under a switch: until when the memory left is kept, and how to switch to it. */
export function keptNote(previous) {
  if (!previous) return null;
  return previous.rebuilt
    ? `새 기억은 ${keepLine(previous)}. 다시 바꾸려면 서버 → 기억 서버에서 새 기억으로 다시 바꾸기를 누르세요.`
    : `이전 기억은 ${keepLine(previous)}. 되돌리려면 서버 → 기억 서버에서 되돌리기를 누르세요.`;
}

/** "대화 26,640개 · 22시간 걸림 · 모델 호출 약 4만 번". */
export function lastDetail(last) {
  if (!last || last.cancelled || last.kind === "undo") return "";
  const hours = Number(last.hours || 0);
  const took = hours >= 1 ? `${number(Math.round(hours))}시간` : `${number(Math.max(1, Math.round(hours * 60)))}분`;
  const parts = [`대화 ${number(last.conversations || 0)}개`, `${took} 걸림`];
  if (last.calls) parts.push(`모델 호출 ${callsText(last.calls)}`);
  return parts.join(" · ");
}

/** "10월 20일까지 둡니다". */
export function keepLine(previous) {
  return previous?.keepUntil ? `${shortDay(Date.parse(previous.keepUntil))}까지 둡니다` : "";
}
