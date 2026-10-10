// 대시보드: how this computer's memory runs, read at a glance. Nothing here is a
// link. The servers its conversations go to are one table: whether each is up to
// date, how many conversations wait here to go, when the last one went, and how
// many the server holds (/api/app/flow, the memory server's own count), asked again
// every 10 seconds; under it, how far the past conversations have gone in (지난
// 대화 쌓기, lib/past.js) and how far Honcho has got putting them in order. Then
// the parts around it, asked every minute: the gateway, backup, and sharing. A team
// login that ended says so on top, with 다시 로그인.
import { get, honcho, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { servingState } from "../lib/accounts.js";
import { ago, dayTime, number } from "../lib/format.js";
import { sameServer } from "../lib/collect.js";
import { HELD, doneCount, runLine } from "../lib/past.js";
import { keptNote, lastLine, rebuildLine, rebuildNote, rebuildPercent, stopCause } from "../lib/rederive.js";
import { app, onChange, savePrefs, workspace } from "../lib/state.js";
import { loginNotice } from "../lib/team.js";
import { pageHead, spinner, toast } from "../lib/ui.js";

const FAST = 10_000;
const SLOW = 60_000;
// A finished run's card stays a day, or until its failures are tried again.
const DONE_SHOWN_MS = 24 * 3_600_000;
const pad = (value) => String(value).padStart(2, "0");

function settled(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
}

/** A server here, or a gateway answering here (as the menu decides). */
function serverHere() {
  return Boolean(app.context?.localServer || app.status.gateway.report);
}

async function fetchFlow() {
  const context = app.context || {};
  if (!context.configured && !context.localServer) return { flow: null, queue: null, sessions: null };
  const [flow, queue, sessions] = await Promise.allSettled([
    get("/api/app/flow"),
    honcho(workspace()).get("/queue/status"),
    get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1" })}`),
  ]);
  return { flow: settled(flow), queue: settled(queue), sessions: settled(sessions) };
}

async function fetchAround() {
  const context = app.context || {};
  const [backup, share] = await Promise.allSettled([
    get("/api/backup/status"),
    context.localServer ? post("/api/server/share/status", {}) : Promise.resolve(null),
  ]);
  return { backup: settled(backup), share: settled(share) };
}

// ── 동기화 현황 ──────────────────────────────────────────

function row({ state, name, addr, status, pending, last, total }) {
  return h("tr", {},
    h("td", {}, h("div", { class: "nm" }, h("span", { class: `dot ${state}` }), name), addr ? h("div", { class: "addr" }, addr) : null),
    h("td", {}, status),
    h("td", { class: "num" }, pending),
    h("td", {}, last),
    h("td", { class: "num" }, total));
}

function ownRow(live) {
  const context = app.context || {};
  const local = sameServer(context.honcho?.url, context.localServer?.apiUrl) || (!context.configured && context.localServer);
  const name = local ? "이 컴퓨터 서버" : "내 서버";
  const addr = hostOf(context.configured ? context.honcho?.url : context.localServer?.apiUrl);
  if (!context.configured) return row({ state: "idle", name, addr, status: "수집 꺼짐", pending: "-", last: "-", total: live.sessions ? `${number(live.sessions.total || 0)}개` : "-" });
  const answers = Boolean(live.queue || live.sessions);
  const collect = live.flow?.collect || {};
  const filling = live.flow?.past?.running;
  // The past conversations not in yet wait like the new ones held behind them.
  const left = filling?.total ? Math.max(0, filling.total - Number(filling.done || 0)) : 0;
  const waiting = Number(collect.pending || 0) + left;
  const status = !answers ? "답하지 않음"
    : filling ? "지난 대화 쌓는 중"
      : waiting ? "동기화 중" : "최신";
  return row({
    state: !answers ? "bad" : waiting || filling ? "warn" : "",
    name,
    addr,
    status,
    pending: `${number(waiting)}개`,
    last: collect.lastSentAt ? ago(collect.lastSentAt) : "아직 없음",
    total: typeof live.sessions?.total === "number" ? `${number(live.sessions.total)}개` : "-",
  });
}

function targetRows(live) {
  const targets = live.flow?.targets || app.context?.targets || [];
  return targets.map((target) => row({
    state: !target.enabled ? (target.team ? "warn" : "idle") : target.pending ? "warn" : "",
    name: target.label || target.id,
    addr: hostOf(target.url),
    // A team's server kept off is one whose owner has not approved yet.
    status: !target.enabled ? (target.team ? "승인 기다리는 중" : "꺼 둠") : target.pending ? "동기화 중" : "최신",
    pending: `${number(target.pending || 0)}개`,
    last: target.lastSentAt ? ago(target.lastSentAt) : "아직 없음",
    total: "-",
  }));
}

/**
 * 지난 대화 쌓기: while the run goes, which month it reached, how many of how many
 * and how long is left, and that new turns wait behind it; once done, for a day,
 * how many went in, and for as long as some failed, where to try them again.
 */
function pastCard(past) {
  if (!past) return null;
  const { running, last } = past;
  const card = (right, percent, note, { run = false, dot = "warn" } = {}) => h("div", { class: "card queue" },
    h("div", { class: "queue-head" }, h("b", {}, "지난 대화 쌓기"), h("span", {}, right)),
    h("div", { class: run ? "bar run" : "bar", role: "progressbar", "aria-label": `지난 대화 쌓기 ${percent}%`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) },
      h("span", { style: { width: `${percent}%` } })),
    note ? h("div", { class: "qnote" }, h("span", { class: `dot ${dot}` }), note) : null);
  if (running) {
    const percent = running.total ? Math.floor((Number(running.done || 0) / running.total) * 100) : 0;
    const held = Number(past.held?.conversations || 0);
    return card(runLine(running) || "줄 세우는 중", percent, past.stopping ? "멈추는 중입니다. 지금 쌓는 대화까지 쌓고 멈춥니다." : held ? `새 대화 ${number(held)}개는 지난 대화 다음에 쌓입니다.` : HELD, { run: true });
  }
  if (!last?.finishedAt) return null;
  const counted = doneCount(last);
  if (last.stopped === "unreachable") return card(`멈춤 · ${counted}`, last.total ? Math.floor((last.done / last.total) * 100) : 0, "서버에 닿지 않아 멈췄습니다. 서버가 다시 답하면 저절로 이어서 쌓습니다.");
  if (last.cancelled) return card(`멈춤 · ${counted}`, last.total ? Math.floor((last.done / last.total) * 100) : 0, "이어서 쌓으려면 기억 설정 → 지난 대화에서 이어서 쌓기를 누르세요.", { dot: "idle" });
  const failed = Number(past.failed || 0);
  if (!failed && Date.now() - Date.parse(last.finishedAt) > DONE_SHOWN_MS) return null;
  return card(`다 쌓음 · ${counted}`, 100, failed ? `실패 ${number(failed)}개 · 기억 설정 → 지난 대화에서 다시 시도를 누르세요.` : null, { dot: "bad" });
}

/**
 * 기억 다시 정리 on the server here: while it goes, which month it reached, how far
 * and how long is left; for a day after the switch, when it switched and until when
 * the memory before is kept.
 */
function rederiveCard(rederive) {
  if (!rederive) return null;
  const { job, last, previous } = rederive;
  const undo = job ? job.kind === "undo" && !job.toRebuilt : last?.kind === "undo" && !last.toRebuilt;
  const title = undo ? "기억 되돌리기" : "기억 다시 정리";
  const card = (right, percent, note, { run = false, dot = "warn" } = {}) => h("div", { class: "card queue" },
    h("div", { class: "queue-head" }, h("b", {}, title), h("span", {}, right)),
    h("div", { class: run ? "bar run" : "bar", role: "progressbar", "aria-label": `${title} ${percent}%`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) },
      h("span", { style: { width: `${percent}%` } })),
    note ? h("div", { class: "qnote" }, h("span", { class: `dot ${dot}` }), note) : null);
  if (job) {
    const { text, first } = stopCause(job.error);
    const note = job.error ? `${text || "멈췄습니다."} ${first ? `${first} ` : ""}서버 → 기억 서버에서 다시 시도를 누르세요.` : rebuildNote(job);
    return card(rebuildLine(job), rebuildPercent(job), note, { run: !job.error, dot: job.error ? "bad" : "warn" });
  }
  if (!last?.swappedAt || last.cancelled || Date.now() - Date.parse(last.swappedAt) > DONE_SHOWN_MS) return null;
  return card(lastLine(last), 100, keptNote(previous), { dot: "idle" });
}

/** Once, when a run has just finished: how many went in, and the new ones that waited for them. */
function pastToast(past) {
  const last = past?.running ? null : past?.last;
  if (!last?.finishedAt || last.cancelled || last.stopped || app.prefs.pastToast === last.finishedAt) return;
  savePrefs({ pastToast: last.finishedAt });
  if (Date.now() - Date.parse(last.finishedAt) > DONE_SHOWN_MS || !last.sent) return;
  const held = Number(last.held?.conversations || 0);
  toast(held ? `지난 대화 ${number(last.sent)}개와 그동안 생긴 새 대화 ${number(held)}개를 쌓았습니다.` : `지난 대화 ${number(last.sent)}개를 쌓았습니다.`, "ok");
}

function queueCard(queue) {
  if (!queue) return null;
  const working = queue.in_progress_work_units || 0;
  const left = (queue.pending_work_units || 0) + working;
  const done = queue.completed_work_units || 0;
  const percent = left ? Math.floor((done / (done + left)) * 100) : 100;
  return h("div", { class: "card queue" },
    h("div", { class: "queue-head" }, h("b", {}, "Honcho 처리"),
      h("span", {}, left ? `${percent}% · 남은 일 ${number(left)}개 · 지금 ${number(working)}개` : "다 정리됨")),
    h("div", { class: "bar", role: "progressbar", "aria-label": `Honcho 처리 ${percent}%`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) },
      h("span", { style: { width: `${percent}%` } })));
}

// ── 모델 · 백업 · 공유 ────────────────────────────────────

function tile({ title, state = "idle", value, line }) {
  return h("div", { class: "card tile" },
    h("div", { class: "tile-head" }, h("span", { class: `dot ${state}` }), title),
    h("b", {}, value),
    line ? h("small", {}, line) : null);
}

function gatewayTile() {
  const { gateway } = app.status;
  const report = gateway.report;
  // A connected account resting on its usage limit answers nothing until it comes back.
  const { serving, resting, until } = servingState(report);
  const loggedIn = (report?.accounts || []).filter((account) => account.login?.loggedIn).length;
  const models = `모델 ${number(report?.models?.models?.length || 0)}개`;
  return tile({
    title: "구독 게이트웨이",
    state: gateway.pending ? "idle" : until ? "warn" : serving ? "" : report ? "warn" : "bad",
    value: gateway.pending ? "확인 중" : !report ? "꺼짐" : until ? "사용 한도" : serving ? `계정 ${number(serving - resting)}개 쓰는 중` : loggedIn ? "연결 필요" : "로그인 필요",
    line: !report ? "서버 → 모델에서 켭니다" : until ? `${dayTime(until)}에 풀림` : resting ? `${models} · 계정 ${number(resting)}개는 사용 한도` : models,
  });
}

function backupTile(backup) {
  if (!backup || backup.ok === false) return tile({ title: "백업", value: "확인 못 함" });
  const run = backup.lastRun;
  const schedule = backup.schedule || {};
  const when = schedule.registered ? `매일 ${pad(schedule.hour ?? 3)}:${pad(schedule.minute ?? 0)}` : "자동 백업 꺼짐";
  if (!backup.destination) return tile({ title: "백업", state: "warn", value: "백업할 곳 없음", line: "백업에서 고릅니다" });
  const where = `${when} · ${backup.destination.label || ""}`;
  if (backup.state === "running") return tile({ title: "백업", value: "백업 중", line: where });
  if (backup.alert?.problem || (run && !run.ok)) return tile({ title: "백업", state: "bad", value: "실패", line: run?.finishedAt ? `마지막 시도 ${ago(run.finishedAt)}` : where });
  return tile({ title: "백업", state: run?.finishedAt ? "" : "warn", value: run?.finishedAt ? ago(run.finishedAt) : "아직 없음", line: where });
}

function shareTile(share) {
  if (!share || share.ok === false) return tile({ title: "공유", value: "확인 못 함" });
  const on = share.tunnel?.enabled ?? share.enabled;
  return tile({ title: "공유", state: on ? (share.issues?.length ? "warn" : "") : "idle", value: on ? "켜짐" : "꺼짐", line: on ? hostOf(share.publicUrl) : "서버 → 공유에서 켭니다" });
}

function teamTile() {
  const connected = Number(app.context?.teamMemory?.connected || 0);
  return tile({ title: "팀원 기억", state: connected ? "" : "idle", value: connected ? `${number(connected)}곳 연결` : "연결 없음", line: connected ? "Claude Code·Codex에서 chat으로 묻습니다" : "팀에서 연결합니다" });
}

export default {
  title: "대시보드",
  async mount(page) {
    const body = h("div", { class: "pad stack" });
    page.append(
      pageHead({ title: "대시보드", subtitle: "이 컴퓨터의 기억이 지금 어떻게 돌고 있는지 봅니다." }),
      h("div", { class: "page-body" }, body),
    );
    let live = null;
    let around = null;
    // Kept across redraws while the same login stays ended, so 다시 로그인 is not redrawn mid-login.
    let ended = null;

    function draw() {
      if (!live || !around) { clear(body, spinner()); return; }
      const context = app.context || {};
      const gone = context.team?.hub && !context.team.signedIn ? context.team.loginEnded : null;
      if (!gone) ended = null;
      else if (ended?.at !== gone.at) ended = { at: gone.at, node: loginNotice({ kind: "hub", email: gone.email || "", host: gone.host || "", onDone: draw }) };
      const shown = context.configured || context.localServer;
      const tiles = [
        serverHere() ? gatewayTile() : null,
        backupTile(around.backup),
        context.localServer ? shareTile(around.share) : teamTile(),
      ].filter(Boolean);
      clear(body,
        ended?.node || null,
        shown ? h("section", { "aria-label": "동기화 현황" },
          h("h2", { class: "sec" }, "동기화 현황"),
          h("div", { class: "card" }, h("table", { class: "sync" },
            h("thead", {}, h("tr", {}, ["서버", "상태", "남은 대화", "마지막 동기화", "서버의 대화"].map((label, index) => h("th", { scope: "col", class: index === 2 || index === 4 ? "num" : null }, label)))),
            h("tbody", {}, ownRow(live), targetRows(live)))),
          pastCard(live.flow?.past),
          rederiveCard(live.flow?.rederive),
          queueCard(live.queue)) : null,
        h("section", { "aria-label": "모델 · 백업 · 공유" },
          h("h2", { class: "sec" }, serverHere() ? "모델 · 백업 · 공유" : "백업 · 팀원 기억"),
          h("div", { class: "tiles" }, tiles)));
    }

    async function loadFlow() {
      live = await fetchFlow();
      draw();
      pastToast(live.flow?.past);
    }
    async function loadAround() {
      around = await fetchAround();
      draw();
    }

    const stop = onChange(() => draw());
    const fast = setInterval(loadFlow, FAST);
    const slow = setInterval(loadAround, SLOW);
    draw();
    await Promise.all([loadFlow(), loadAround()]);
    return { cleanup: () => { stop(); clearInterval(fast); clearInterval(slow); } };
  },
};
