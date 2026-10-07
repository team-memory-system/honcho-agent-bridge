// Requests between team members, as the bell and the 팀 page show them.
//
// A member asks another for chat (to ask their memory) or, for the company server,
// to collect into it. The hub keeps each request and its answer; the owner's app
// opens its server first (the gate's access.json, team-app.mjs) and only then
// answers, so "approved" always means it works. What waits for this person goes to
// the bell: a request to answer, an approved chat to connect, a refusal to read.
// An approved collect request needs nothing from anyone: this app registers with
// the company server, turns its column on and sends the chosen folders' past
// conversations, as soon as it sees the answer.
import { get, post } from "./api.js";
import { bellSource, refreshBell } from "./bell.js";
import { h, clear } from "./dom.js";
import { folderTable, listItem, modal } from "./kit.js";
import { ago, clientOutcome, connectTeammate, mateName, registerWith, teamCall, teamDirectory, teamRequests, teamStatus } from "./team.js";
import { app, loadContext, refreshStatus } from "./state.js";
import { shortPath } from "./collect.js";
import { button, busy, notice, spinner, tag, toast } from "./ui.js";

let latest = null;
let loading = null;
const starting = new Set();

/** The hub's requests with this server's own grants and computers, asked at most once at a time. */
export function loadRequests({ fresh = false } = {}) {
  if (!app.context?.team?.hub || !app.context?.team?.signedIn) return Promise.resolve(null);
  if (!loading || fresh) {
    loading = teamRequests().then((value) => { latest = value; return value; }).catch(() => latest).finally(() => {
      setTimeout(() => { loading = null; }, 5_000);
    });
  }
  return loading;
}

export function requestsSeen() {
  return latest;
}

function personName(request, field = "from") {
  return field === "from" ? request.fromPeer || request.from?.split("@")[0] || "" : request.ownerPeer || request.owner?.split("@")[0] || "";
}

/** This server's projects, to open to a teammate: one row per scope, newest first. */
async function scopedProjects() {
  const result = await get("/api/app/projects").catch(() => null);
  const seen = new Set();
  return (result?.projects || []).filter((project) => project.scope && !seen.has(project.scope) && seen.add(project.scope))
    .map((project) => ({ path: project.path, name: project.name, count: project.sessions, display: shortPath(project.path), scope: project.scope }));
}

/**
 * The projects window: which projects a teammate's chat answers from. Used to
 * approve a request (T2) and to change what is open later (T4). Resolves the
 * chosen [{ id, name }], or null when closed.
 */
export function chooseProjects({ title, lead, chosen = [], confirm = "승인", extra = null }) {
  return new Promise((resolve) => {
    const win = modal({ title, big: true, small: true, onClose: (value) => resolve(value === "ok" ? picked() : null) });
    const box = h("div", {}, spinner());
    const problem = h("div", {});
    let projects = [];
    const checked = new Set();
    const picked = () => {
      const seen = new Set();
      return projects.filter((project) => checked.has(project.path) && !seen.has(project.scope) && seen.add(project.scope))
        .map((project) => ({ id: project.scope, name: project.name }));
    };
    win.body(h("p", { class: "lead", style: { marginTop: "4px" } }, lead), box, problem);
    win.foot(extra, [
      button("취소", { kind: "quiet", onClick: () => win.close() }),
      button(confirm, { kind: "primary", onClick: () => {
        if (!picked().length) { clear(problem, notice("warn", "프로젝트를 하나 이상 고르세요.")); return; }
        win.close("ok");
      } }),
    ]);
    win.open();
    scopedProjects().then((list) => {
      projects = list;
      const open = new Set(chosen.map((item) => item.id));
      for (const project of projects) if (open.has(project.scope)) checked.add(project.path);
      clear(box, projects.length
        ? folderTable(projects, checked, { scroll: true, heading: "프로젝트" })
        : notice("warn", "이 컴퓨터에 대화가 있는 프로젝트가 아직 없습니다."));
    });
  });
}

/** 승인 on a chat request: the projects first, then the server opens and the hub hears. */
export async function approveChat(request) {
  const who = personName(request);
  const projects = await chooseProjects({
    title: `${who}에게 내 기억 열기`,
    lead: `${who}가 chat으로 물을 때 답에 쓸 프로젝트를 고르세요.`,
  });
  if (!projects) return false;
  await teamCall("/api/team/decide", { id: request.id, approve: true, kind: "chat", email: request.from, peer: request.fromPeer, projects });
  // The chosen projects' past conversations go into their scopes in the background.
  post("/api/team/scopes", {}).catch(() => {});
  toast(`${who}에게 프로젝트 ${projects.length}개를 열었습니다.`, "ok");
  return true;
}

export async function approveCollect(request) {
  await teamCall("/api/team/decide", { id: request.id, approve: true, kind: "collect", email: request.from, peer: request.fromPeer });
  toast(`${personName(request)}의 ${request.device || "컴퓨터"}가 이 서버에 쌓습니다.`, "ok");
  return true;
}

export async function decline(request) {
  await teamCall("/api/team/decide", { id: request.id, approve: false });
  return true;
}

/** After a teammate's memory went in: each agent logs in to it once, and how. */
export function openConnected(mate) {
  const entry = mate.entry || `team-${mate.name}`;
  const win = modal({ title: `${mate.name}의 기억 연결`, big: true, small: true });
  const codexState = tag("로그인 필요", "warn");
  const codexNote = h("div", { class: "s" }, "Codex 로그인을 누르고, 브라우저가 열리면 팀 Google 계정으로 로그인하세요.");
  const codexLogin = button("Codex 로그인", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
    const login = await post("/api/teammates/codex-login", { name: mate.name });
    if (!login.ok) throw new Error(login.error || "Codex 로그인을 시작하지 못했습니다.");
    if (login.state === "done") {
      clear(codexState, "로그인됨");
      codexState.className = "tag ok";
      return;
    }
    clear(codexNote, "브라우저에서 로그인을 마치세요. 창이 열리지 않았으면 ",
      login.loginUrl ? h("a", { href: login.loginUrl, target: "_blank", rel: "noreferrer" }, "로그인 주소") : "로그인 주소",
      "를 여세요. 10분 안에 마치지 않으면 다시 누릅니다.");
  }) });
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } },
      `${mate.name}의 기억을 이 컴퓨터의 Claude Code와 Codex에 도구로 넣었습니다. ${mate.name}의 서버는 팀 Google 계정으로만 열려서, 에이전트마다 한 번 로그인하면 끝납니다.`),
    h("div", { class: "opts" },
      h("div", { class: "agent" }, h("span", { class: "src claude" }, "C"),
        h("div", { class: "ab" }, h("div", { class: "t" }, "Claude Code ", tag("로그인 필요", "warn")),
          h("div", { class: "s" }, "열린 세션에서 ", h("span", { class: "mono" }, "/mcp"), " 를 열고 ", h("span", { class: "mono" }, entry), " 을 골라 Authenticate를 누르고, 브라우저가 열리면 팀 Google 계정으로 로그인하세요."))),
      h("div", { class: "agent" }, h("span", { class: "src codex" }, "X"),
        h("div", { class: "ab" }, h("div", { class: "t" }, "Codex ", codexState), codexNote),
        codexLogin)));
  win.foot(null, button("닫기", { onClick: () => win.close() }));
  win.open();
}

/** 연결 on an approved chat request: the teammate's memory into Claude Code and Codex. */
export async function connectApproved(request) {
  const name = mateName({ peer: request.ownerPeer, email: request.owner });
  const result = await connectTeammate({ name, host: request.server });
  if (!result.ok) throw new Error(result.error || clientOutcome(result).join(" · ") || "연결하지 못했습니다.");
  // The request stays, with its projects, for the 팀 page; the bell stops showing it
  // because Claude Code or Codex now has that server.
  await loadContext();
  refreshStatus();
  openConnected({ name, entry: result.entry });
  return true;
}

/**
 * An approved collect request: this computer registers with the company server and
 * the server's column goes on, with the chosen folders' past conversations. Quietly
 * when the team's servers login is there; otherwise the bell asks for one press.
 */
export async function startCollect(request, { tab = null } = {}) {
  const target = (app.context?.targets || []).find((item) => item.team && String(item.url || "").replace(/^https:\/\//, "") === request.server);
  await registerWith(request.server, { tab });
  if (target && !target.enabled) {
    const set = await post("/api/targets/set", { id: target.id, enabled: true });
    if (set.ok === false) throw new Error(set.error || "회사 서버 쌓기를 켜지 못했습니다.");
    post("/api/targets/backfill", { id: target.id }).catch(() => {});
  }
  await teamCall("/api/team/dismiss", { id: request.id }).catch(() => null);
  await loadContext();
  toast("회사 서버에도 쌓기 시작했습니다.", "ok");
  return true;
}

async function tryStart(request) {
  if (starting.has(request.id)) return;
  starting.add(request.id);
  const status = await teamStatus().catch(() => null);
  if (!status?.serversLogin?.signedIn) return;
  try { await startCollect(request); refreshBell(); }
  catch { starting.delete(request.id); }
}

/** The bell's rows: everything a person has to press. */
async function bellRows() {
  const requests = await loadRequests({ fresh: true });
  if (!requests) return [];
  // Names as the team shows them: each member's peer, which also names team-<peer>.
  const directory = await teamDirectory().catch(() => null);
  const peers = new Map((directory?.people || []).map((person) => [person.email, person.peer]));
  for (const request of [...(requests.incoming || []), ...(requests.outgoing || [])]) {
    request.ownerPeer = request.ownerPeer || peers.get(request.owner) || null;
    request.fromPeer = request.fromPeer || peers.get(request.from) || null;
  }
  const rows = [];
  const act = (label, kind, run) => button(label, { kind, onClick: (event) => busy(event.currentTarget, async () => {
    if (await run()) { await loadRequests({ fresh: true }); refreshBell(); }
  }) });
  // A server opens on the computer that runs it (its gate's access.json is there), so
  // only that computer answers; the owner's others see the request and where to go.
  const here = app.context?.team?.localHost || null;
  for (const request of requests.incoming || []) {
    const chat = request.kind === "chat";
    const what = chat ? "내 기억에 chat으로 물으려 합니다" : `${(request.folders || []).join(" · ") || "고른"} 폴더의 대화를 쌓으려 합니다`;
    rows.push(listItem({
      title: chat ? personName(request) : `${personName(request)}의 ${request.device || "컴퓨터"}`,
      sub: request.server === here ? `${what} · ${ago(request.createdAt)}` : `${what} · 서버를 둔 컴퓨터에서 승인합니다`,
      end: request.server === here
        ? [act("승인", "primary small", () => (chat ? approveChat(request) : approveCollect(request))), act("거절", "small danger", () => decline(request))]
        : null,
    }));
  }
  const connected = new Set(app.context?.teamMemory?.hosts || []);
  for (const request of requests.outgoing || []) {
    const owner = personName(request, "owner");
    if (request.status === "approved" && request.kind === "chat" && connected.has(request.server)) continue;
    if (request.status === "approved" && request.kind === "chat") {
      rows.push(listItem({
        title: owner,
        sub: `chat 요청을 승인했습니다 · 열린 프로젝트 ${(request.projects || []).length}개 · ${ago(request.decidedAt)}`,
        end: act("연결", "primary small", () => connectApproved(request)),
      }));
    } else if (request.status === "approved" && request.kind === "collect") {
      tryStart(request);
      rows.push(listItem({
        title: "회사 서버",
        sub: `대화 쌓기를 승인했습니다 · ${ago(request.decidedAt)}`,
        end: act("시작", "primary small", () => startCollect(request)),
      }));
    } else if (request.status === "declined" || request.status === "revoked") {
      rows.push(listItem({
        title: request.kind === "chat" ? owner : "회사 서버",
        sub: `${request.kind === "chat" ? "chat" : "대화 쌓기"} 요청을 ${request.status === "declined" ? "거절했습니다" : "닫았습니다"} · ${ago(request.decidedAt || request.revokedAt)}`,
        end: act("확인", "small", async () => { await teamCall("/api/team/dismiss", { id: request.id }); return true; }),
      }));
    }
  }
  return rows;
}

/** Puts the team's requests on the bell, once. */
let registered = false;
export function watchRequests() {
  if (registered) return;
  registered = true;
  bellSource(bellRows);
}
