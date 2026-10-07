// 대시보드: how this computer's memory runs, read at a glance. Nothing here is a
// link. The servers its conversations go to are one table: whether each is up to
// date, how many conversations wait here to go, when the last one went, and how
// many the server holds (/api/app/flow, the memory server's own count), asked again
// every 10 seconds; under it, how far Honcho has got putting them in order. Then
// the parts around it, asked every minute: the gateway, backup, and sharing. A team
// login that ended says so on top, with 다시 로그인.
import { get, honcho, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { ago, number } from "../lib/format.js";
import { sameServer } from "../lib/collect.js";
import { app, onChange, workspace } from "../lib/state.js";
import { loginNotice } from "../lib/team.js";
import { pageHead, spinner } from "../lib/ui.js";

const FAST = 10_000;
const SLOW = 60_000;
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
  const backfill = live.flow?.backfill?.running;
  const waiting = Number(collect.pending || 0) + Number(backfill?.remaining || 0);
  const status = !answers ? "답하지 않음"
    : backfill ? `지난 대화 보내는 중 ${number(backfill.examined)}/${number(backfill.considered)}`
      : waiting ? "동기화 중" : "최신";
  return row({
    state: !answers ? "bad" : waiting || backfill ? "warn" : "",
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
  const serving = (report?.servingAccounts || []).length;
  const loggedIn = (report?.accounts || []).filter((account) => account.login?.loggedIn).length;
  return tile({
    title: "구독 게이트웨이",
    state: gateway.pending ? "idle" : serving ? "" : report ? "warn" : "bad",
    value: gateway.pending ? "확인 중" : !report ? "꺼짐" : serving ? `계정 ${number(serving)}개 쓰는 중` : loggedIn ? "연결 필요" : "로그인 필요",
    line: report ? `모델 ${number(report.models?.models?.length || 0)}개` : "서버 → 모델에서 켭니다",
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
          queueCard(live.queue)) : null,
        h("section", { "aria-label": "모델 · 백업 · 공유" },
          h("h2", { class: "sec" }, serverHere() ? "모델 · 백업 · 공유" : "백업 · 팀원 기억"),
          h("div", { class: "tiles" }, tiles)));
    }

    async function loadFlow() {
      live = await fetchFlow();
      draw();
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
