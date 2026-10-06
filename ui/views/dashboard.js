// 대시보드: where this computer's memory stands, read at a glance. Nothing here is
// a link; a line that needs a hand says where to press. On top, one line: all is
// well, or what needs a hand. Then the flow of conversations into memory: what
// waits on this computer to go (/api/app/flow), what the memory server holds, and
// how far it has got putting them in order (Honcho's queue), asked again every 10
// seconds while the screen is open; the other servers that also get copies hang
// off the first step. Last, the parts around it, asked every minute: the gateway,
// the embedding model and the model that orders and answers, then backup, sharing
// and teammates' memory.
import { get, honcho, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { ago, number, time } from "../lib/format.js";
import { app, onChange, workspace } from "../lib/state.js";
import { button, busy, light, pageHead, spinner } from "../lib/ui.js";

const FAST = 10_000;
const SLOW = 60_000;
const pad = (value) => String(value).padStart(2, "0");

/** A server here, one about to be installed here, or a gateway answering here (as the menu decides). */
function serverHere() {
  return Boolean(app.context?.localServer || app.prefs.startChoice === "here" || app.status.gateway.report);
}

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

/** Whether there is a memory server to show the flow into: one here, or the one this computer collects into. */
function flowShown() {
  return serverHere() || Boolean(app.context?.configured);
}

/** The flow, asked often: each part may be missing, and a step then says so. */
async function fetchFlow() {
  if (!flowShown()) return { flow: null, queue: null, sessions: null, at: new Date().toISOString() };
  const [flow, queue, sessions] = await Promise.allSettled([
    get("/api/app/flow"),
    honcho(workspace()).get("/queue/status"),
    get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1" })}`),
  ]);
  return { flow: settled(flow), queue: settled(queue), sessions: settled(sessions), at: new Date().toISOString() };
}

/** The parts around it, asked every minute. */
async function fetchAround() {
  const context = app.context || {};
  const [backup, host, share] = await Promise.allSettled([
    get("/api/backup/status"),
    serverHere() ? post("/api/host/status", {}) : Promise.resolve(null),
    context.localServer ? post("/api/server/share/status", {}) : Promise.resolve(null),
  ]);
  return { backup: settled(backup), host: settled(host), share: settled(share) };
}

/** Whether the memory server answered: the last asking here, else the shell's minute check. */
function serverAnswers(live) {
  return live ? Boolean(live.queue || live.sessions) : app.status.honcho.state === "on";
}

function embedding(host) {
  if (!host?.installed) return null;
  const ollama = host.ollama || {};
  return Boolean(ollama.healthy && ollama.resident);
}

// ── The flow ─────────────────────────────────────────────

function step({ title, state, value, bar = null, lines = [] }) {
  return h("div", { class: `flow-step ${state}` },
    h("div", { class: "dash-head" }, light(state), h("span", {}, title)),
    h("b", { class: "dash-value" }, value),
    bar === null ? null : h("div", { class: "flow-bar", role: "progressbar", "aria-label": `${title} ${bar}%`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(bar) },
      h("span", { style: { width: `${bar}%` } })),
    lines.filter(Boolean).map((line) => h("small", {}, line)),
  );
}

const arrow = () => h("div", { class: "flow-arrow", "aria-hidden": "true" }, "→");

function computerStep(live) {
  const context = app.context || {};
  if (!context.configured) return step({ title: "이 컴퓨터", state: "idle", value: "대화 쌓기 꺼짐" });
  const collect = live?.flow?.collect;
  const agents = app.status.collector.text;
  if (!collect) return step({ title: "이 컴퓨터", state: "idle", value: "확인 못 함", lines: [agents] });
  return step({
    title: "이 컴퓨터",
    state: "on",
    value: collect.pending ? `기다리는 대화 ${number(collect.pending)}개` : "다 보냄",
    lines: [
      agents,
      collect.lastSentAt ? `마지막으로 보낸 때 ${ago(collect.lastSentAt)}` : "아직 보낸 대화 없음",
      collect.sessions ? `보낸 대화 ${number(collect.sessions)}개` : null,
    ],
  });
}

function serverStep(live) {
  const context = app.context || {};
  const where = context.localServer ? "이 컴퓨터" : hostOf(context.honcho?.url);
  if (!serverAnswers(live)) return step({ title: "기억 서버", state: "bad", value: "답하지 않음", lines: [where] });
  const total = live?.sessions?.total;
  const newest = live?.sessions?.items?.[0];
  return step({
    title: "기억 서버",
    state: "on",
    value: typeof total === "number" ? `대화 ${number(total)}개` : "답함",
    lines: [where, newest?.createdAt ? `최근 대화 ${ago(newest.createdAt)}` : null],
  });
}

function orderStep(live) {
  const queue = live?.queue;
  if (!queue) return step({ title: "정리", state: "idle", value: "알 수 없음" });
  const working = queue.in_progress_work_units || 0;
  const left = (queue.pending_work_units || 0) + working;
  const done = queue.completed_work_units || 0;
  const percent = left ? Math.floor((done / (done + left)) * 100) : 100;
  return step({
    title: "정리",
    state: "on",
    value: left ? `남은 일 ${number(left)}개` : "다 정리됨",
    bar: percent,
    lines: [left ? `${percent}% · 지금 ${number(working)}개 하는 중` : done ? `끝난 일 ${number(done)}개` : null],
  });
}

/** The other servers that also get copies, as they stand now. */
function branch(live) {
  const targets = live?.flow?.targets || app.context?.targets || [];
  if (!targets.length) return null;
  return h("div", { class: "flow-branch" },
    h("span", { class: "flow-branch-label" }, "다른 서버에도"),
    targets.map((target) => h("span", { class: "flow-target" },
      light(!target.enabled ? "idle" : target.pending ? "warn" : "on"),
      h("b", {}, target.label || target.id),
      h("span", {}, [
        target.enabled ? null : "멈춤",
        target.pending ? `기다리는 대화 ${number(target.pending)}개` : target.enabled ? "다 보냄" : null,
        target.lastSentAt ? `마지막 ${ago(target.lastSentAt)}` : "아직 보낸 대화 없음",
      ].filter(Boolean).join(" · ")),
    )),
  );
}

// ── The parts around it ──────────────────────────────────

function tile({ title, state = "idle", value, lines = [] }) {
  return h("div", { class: `dash-card ${state}` },
    h("div", { class: "dash-head" }, light(state), h("span", {}, title)),
    h("b", { class: "dash-value" }, value),
    lines.filter(Boolean).map((line) => h("small", {}, line)),
  );
}

function modelTiles(around) {
  if (!serverHere()) return [];
  const { gateway } = app.status;
  const report = gateway.report;
  const serving = (report?.servingAccounts || []).length;
  const loggedIn = (report?.accounts || []).filter((account) => account.login?.loggedIn).length;
  const embedded = embedding(around?.host);
  const ollama = around?.host?.ollama || {};
  const model = app.context?.localServer?.chatModel;
  return [
    tile({
      title: "구독 게이트웨이",
      state: gateway.pending ? "idle" : serving ? "on" : gateway.state === "idle" || gateway.state === "off" ? "bad" : "warn",
      value: gateway.pending ? "확인 중" : !report ? "꺼짐" : serving ? `계정 ${number(serving)}개 일하는 중` : loggedIn ? "일하는 계정 없음" : "로그인 필요",
      lines: [report ? `모델 ${number(report.models?.models?.length || 0)}개` : null],
    }),
    embedded === null ? null : tile({
      title: "임베딩 모델",
      state: embedded ? "on" : "bad",
      value: embedded ? "올라가 있음" : ollama.healthy ? "내려가 있음" : "Ollama 꺼짐",
      lines: [ollama.model || null],
    }),
    model ? tile({ title: "정리·묻기 모델", state: "on", value: model }) : null,
  ].filter(Boolean);
}

function backupTile(backup) {
  if (!backup || backup.ok === false) return tile({ title: "백업", value: "확인 못 함" });
  const run = backup.lastRun;
  const schedule = backup.schedule || {};
  const when = schedule.registered ? `매일 ${pad(schedule.hour ?? 3)}:${pad(schedule.minute ?? 0)}` : "자동 백업 꺼짐";
  if (!backup.destination) return tile({ title: "백업", state: "warn", value: "백업할 곳 없음" });
  if (backup.state === "running") return tile({ title: "백업", state: "on", value: "백업 중", lines: [when] });
  if (backup.alert?.problem || (run && !run.ok)) {
    return tile({ title: "백업", state: "bad", value: "실패", lines: [run?.finishedAt ? `마지막 시도 ${ago(run.finishedAt)}` : null, when] });
  }
  if (backup.state === "waiting") return tile({ title: "백업", state: "warn", value: "연결 대기", lines: [when] });
  return tile({ title: "백업", state: "on", value: run?.finishedAt ? `${ago(run.finishedAt)} 백업` : "아직 백업 없음", lines: [when, backup.destination.label] });
}

function keepTiles(around) {
  const context = app.context || {};
  const teamConnected = Number(context.teamMemory?.connected || 0);
  const share = around?.share;
  return [
    backupTile(around?.backup),
    context.localServer ? tile({
      title: "공유",
      state: share?.enabled ? (share.issues?.length ? "warn" : "on") : "idle",
      value: !share || share.ok === false ? "확인 못 함" : share.enabled ? "켜짐" : "꺼짐",
      lines: [share?.enabled ? share.publicUrl : null],
    }) : null,
    tile({ title: "팀원 기억", state: teamConnected ? "on" : "idle", value: teamConnected ? `${number(teamConnected)}곳 연결` : "연결 없음" }),
  ].filter(Boolean);
}

// ── What needs a hand ────────────────────────────────────

/** Each as { level, text }; the text says where to press. */
function attention(live, around) {
  const context = app.context || {};
  const here = serverHere();
  const items = [];
  if (flowShown() && live && !serverAnswers(live)) {
    items.push({ level: "bad", text: context.localServer
      ? "기억 서버가 답하지 않습니다. 서버 → 기억 서버에서 시작을 누르세요."
      : "기억 서버가 답하지 않습니다. 서버를 둔 컴퓨터가 켜져 있는지 확인하세요." });
  }
  if (!context.configured && !context.teamMemory?.connected) {
    items.push({ level: "warn", text: "대화 쌓기가 꺼져 있습니다. 기억 설정 → 대화 쌓기에서 켜세요." });
  }
  const gateway = app.status.gateway;
  if (here && !gateway.pending) {
    if (!gateway.report) items.push({ level: "bad", text: "구독 게이트웨이가 꺼져 있습니다. 서버 → 모델에서 게이트웨이 켜기를 누르세요." });
    else if (!(gateway.report.servingAccounts || []).length) items.push({ level: "warn", text: "구독 게이트웨이에 일하는 계정이 없습니다. 서버 → 모델에서 계정을 로그인하세요." });
  }
  if (embedding(around?.host) === false) items.push({ level: "bad", text: "임베딩 모델이 꺼져 있습니다. 서버 → 모델에서 켜기를 누르세요." });
  const backup = around?.backup;
  if (backup && backup.ok !== false) {
    if (!backup.destination) items.push({ level: "warn", text: "백업할 곳이 없습니다. 백업에서 폴더나 클라우드를 고르세요." });
    else if (backup.alert?.problem || (backup.lastRun && !backup.lastRun.ok)) items.push({ level: "bad", text: "백업이 실패했습니다. 백업에서 지금 백업을 누르세요." });
  }
  return items;
}

function summary(items, checkedAt) {
  const at = checkedAt ? h("small", {}, `${time(checkedAt)} 확인`) : null;
  if (!items.length) return h("div", { class: "dash-summary on" }, h("div", { class: "dash-summary-head" }, light("on"), h("b", {}, "모두 잘 돌고 있습니다"), at));
  const level = items.some((item) => item.level === "bad") ? "bad" : "warn";
  return h("div", { class: `dash-summary ${level}`, role: "status" },
    h("div", { class: "dash-summary-head" }, light(level), h("b", {}, `확인할 것 ${items.length}개`), at),
    h("ul", {}, items.map((item) => h("li", {}, item.text))),
  );
}

export default {
  title: "대시보드",
  async mount(page) {
    const body = h("div", { class: "pad" });
    const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침" });
    page.append(
      pageHead({ title: "대시보드", subtitle: "이 컴퓨터의 기억이 지금 어떻게 돌고 있는지 봅니다.", actions: [refresh] }),
      h("div", { class: "page-body" }, body),
    );
    let live = null;
    let around = null;

    function draw() {
      if (!live || !around) { clear(body, h("div", { class: "empty" }, spinner())); return; }
      const models = modelTiles(around);
      clear(body,
        summary(attention(live, around), live.at),
        flowShown() ? h("section", { class: "dash-section", "aria-label": "기억에 들어가는 흐름" },
          h("h2", {}, "기억에 들어가는 흐름"),
          h("div", { class: "flow-steps" }, computerStep(live), arrow(), serverStep(live), arrow(), orderStep(live)),
          branch(live),
        ) : null,
        models.length ? h("section", { class: "dash-section", "aria-label": "모델" }, h("h2", {}, "모델"), h("div", { class: "dash-grid" }, models)) : null,
        h("section", { class: "dash-section", "aria-label": "백업·공유" }, h("h2", {}, "백업·공유"), h("div", { class: "dash-grid" }, keepTiles(around))),
      );
    }

    async function loadFlow() {
      live = await fetchFlow();
      draw();
    }
    async function loadAll() {
      [live, around] = await Promise.all([fetchFlow(), fetchAround()]);
      draw();
    }

    refresh.addEventListener("click", () => busy(refresh, loadAll));
    const stop = onChange(() => draw());
    const fast = setInterval(loadFlow, FAST);
    const slow = setInterval(async () => { around = await fetchAround(); draw(); }, SLOW);
    draw();
    await loadAll();
    return { cleanup: () => { stop(); clearInterval(fast); clearInterval(slow); } };
  },
};
