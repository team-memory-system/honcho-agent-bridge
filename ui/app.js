// The app shell: the menu, the bell, the theme, the quick-jump palette, and handing
// the page to one screen at a time. Until this computer is set up, the page stays
// empty under the first setup window (views/setup.js); what this computer runs, and
// how each part stands, is the 대시보드 screen.
import { get } from "./lib/api.js";
import { h, clear, svg, $ } from "./lib/dom.js";
import { mountBell, refreshBell } from "./lib/bell.js";
import { requestsLoginRefused, watchRequests } from "./lib/requests.js";
import { joinedTeam, watchTeamLogin } from "./lib/team.js";
import { TABS } from "./lib/tabs.js";
import { icon } from "./lib/icons.js";
import { app, go, loadContext, me, onChange, refreshStatus, workspace } from "./lib/state.js";
import { button, errorNotice, pageHead, toast } from "./lib/ui.js";
import { openSetup } from "./views/setup.js";

import dashboard from "./views/dashboard.js";
import memory from "./views/memory.js";
import ask from "./views/ask.js";
import settings from "./views/settings.js";
import team from "./views/team.js";
import audit from "./views/audit.js";
import server from "./views/server.js";
import models from "./views/models.js";
import share from "./views/share.js";
import backup from "./views/backup.js";
import admin from "./views/admin.js";

// `computer` is 기억 설정's address from before it was renamed; links and the setup
// skill still open it by that name.
const VIEWS = { dashboard, memory, ask, computer: settings, team, audit, server, models, share, backup, admin };
// 기억 also holds 묻기, and 서버 holds 모델 and 공유, each one tab away. 관리자 sits
// apart, under a line.
const NAV = [
  ["dashboard", "대시보드", "gauge"],
  ["memory", "기억", "memory"],
  ["computer", "기억 설정", "sliders"],
  ["team", "팀", "person"],
  ["audit", "조회 기록", "log"],
  ["server", "서버", "server"],
  ["backup", "백업", "backup"],
  ["admin", "관리자", "shield"],
];
const APART = new Set(["admin"]);
// What the quick-jump palette also finds a menu item by.
const NAV_WORDS = { audit: "로그 누가 내 기억에 물었나" };

// Where an address from before the menus were regrouped (0.4.5), a page that moved
// to another menu since (0.4.7, 0.4.8), or a page that became a window on its menu's
// one page (0.5) goes now. `computer/collect`, `/tools` and `/import` stay: they open
// 기억 설정 with that window open.
const MOVED = {
  "computer/share": "share",
  connect: "computer",
  "connect/collect": "computer/collect",
  "connect/import": "computer/import",
  "connect/share": "team",
  "connect/targets": "computer/collect",
  "computer/targets": "computer/collect",
  "team/targets": "computer/collect",
  tools: "computer/tools",
  "tools/shared": "team",
  "tools/audit": "audit",
  "team/audit": "audit",
  "team/memories": "team",
  "team/share": "admin",
};

// Two glyphs only the shell draws, in the same hand as lib/icons.js.
const SHELL_ICONS = {
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
  backup: '<path d="M8 2.5v7M5 7l3 3 3-3"/><path d="M2.5 10.5v3h11v-3"/>',
  log: '<rect x="3" y="2.5" width="10" height="11" rx="1"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>',
};
function glyph(name) {
  const body = SHELL_ICONS[name];
  return body
    ? svg(`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)
    : icon(name);
}

let current = { name: "", gate: null, frame: null, cleanup: null, update: null };
let setupWindow = null;

/** The hash as a path and its query: #/start?team=team.example.com is a team link. */
function hashParts() {
  const [path = "", query = ""] = decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("?");
  return { path, query: new URLSearchParams(query) };
}

function route() {
  const { path, query } = hashParts();
  const [name = "", ...rest] = path.split("/");
  return { name: VIEWS[name] || name === "start" ? name : "", params: rest, query };
}

function movedTo() {
  const [name = "", page = ""] = hashParts().path.split("/");
  if (MOVED[`${name}/${page}`]) return MOVED[`${name}/${page}`];
  if (VIEWS[name] || name === "start") return null;
  return MOVED[name] || null;
}

/** The menu item a screen sits under: its tab group's first screen, or itself. */
function menuOf(name) {
  return Object.values(TABS).find((screens) => screens.some(([screen]) => screen === name))?.[0][0] || name;
}

// ── What this computer has, and what it can use yet ─────

/** A memory server answers here: one set up for collection, one installed here, or one already running. */
function memoryAnswers() {
  return app.status.honcho.state === "on";
}

/** Claude Code or Codex here has a teammate's memory as a team-* MCP server. */
function teamConnected() {
  return Boolean(app.context?.teamMemory?.connected);
}

/** Logged in to a team (or its login ended, to be done again), and first setup ran to its end on this computer. */
function teamJoined() {
  return joinedTeam(app.context?.team, app.prefs.mode);
}

function setupDone() {
  const context = app.context;
  return Boolean(context?.configured || teamConnected() || teamJoined() || context?.localServer || memoryAnswers());
}

/** Stores nothing and only asks teammates' memories: 기억 and 서버 mean nothing here. */
function chatOnly() {
  const context = app.context;
  return Boolean(context && !context.configured && !context.localServer && (teamConnected() || teamJoined()) && !memoryAnswers());
}

/** A server here, one about to be installed here, or a gateway answering here. */
function serverHere() {
  return Boolean(app.context?.localServer || app.status.gateway.report);
}

/** Someone who chose 혼자 쓰기 has no team, unless they made or joined one since. */
function teamHere() {
  return Boolean(app.context?.team?.admin || app.context?.team?.hub || teamConnected() || app.prefs.mode !== "solo");
}

/** Screens that mean nothing on this computer are left out of the menu. */
function visible(name) {
  if (name === "memory" || name === "ask") return !chatOnly();
  if (name === "team") return teamHere();
  if (name === "audit") return teamHere() && (Boolean(app.context?.localServer) || app.auditAnswers);
  if (name === "server" || name === "models" || name === "share") return serverHere();
  if (name === "admin") return Boolean(app.context?.team?.admin);
  return true;
}

/**
 * Why a screen cannot work yet, and where that gets fixed; null when it can.
 * Shown greyed in the menu, and as a notice when the screen is opened by URL.
 */
function gate(name) {
  const context = app.context;
  if (!context || (name !== "memory" && name !== "ask")) return null;
  const gateway = app.status.gateway;
  if (context.localServer && !gateway.pending && gateway.state !== "on") {
    const loggedIn = (gateway.report?.accounts || []).some((account) => account.login?.loggedIn);
    return {
      reason: !gateway.report ? "구독 게이트웨이가 꺼져 있습니다. 켜고 계정을 로그인하세요"
        : loggedIn ? "구독 게이트웨이에서 로그인한 계정을 연결하세요"
          : "구독 게이트웨이에 계정을 먼저 로그인하세요",
      detail: "이 컴퓨터의 기억 서버는 구독 계정의 모델로 대화를 정리하고 질문에 답합니다.",
      fix: ["서버 → 모델로", "models"],
    };
  }
  return null;
}

function navItems() {
  return NAV.filter(([name]) => visible(name));
}

function renderNav() {
  const nav = $("#nav");
  if (!app.context) { clear(nav); return; }
  const blank = !setupDone();
  nav.classList.toggle("off", blank);
  const active = blank ? "" : menuOf(route().name || "dashboard");
  const links = [];
  for (const [name, label, symbol] of navItems()) {
    if (APART.has(name)) links.push(h("div", { class: "sep", role: "presentation" }));
    const blocked = blank ? null : gate(name);
    const onPage = name === active ? "page" : null;
    if (!blocked) {
      links.push(h("a", { href: `#/${name}`, "aria-current": onPage, tabindex: blank ? "-1" : null }, glyph(symbol), h("span", {}, label)));
      continue;
    }
    const explain = (event) => {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toast(blocked.reason);
    };
    links.push(h("a", {
      class: "gated",
      role: "link",
      tabindex: "0",
      "aria-disabled": "true",
      "aria-current": onPage,
      title: blocked.reason,
      onclick: explain,
      onkeydown: explain,
    }, glyph(symbol), h("span", {}, label), glyph("lock")));
  }
  clear(nav, links);
}

function renderWho() {
  $("#who-name").textContent = me() || "이름 미설정";
  $("#who-space").textContent = `workspace ${workspace()}`;
}

function renderTheme() {
  const control = $("#theme");
  const dark = document.documentElement.dataset.theme === "dark"
    || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  clear(control, icon(dark ? "sun" : "moon"));
  control.title = dark ? "밝은 화면" : "어두운 화면";
  control.onclick = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("tm.theme", next); } catch {}
    renderTheme();
  };
}

/** What a locked screen shows when it is opened by URL. */
function gatedPage(frame, name, blocked) {
  const label = NAV.find(([key]) => key === menuOf(name))?.[1] || VIEWS[name].title;
  frame.append(
    pageHead({ title: label }),
    h("div", { class: "page-body" }, h("div", { class: "pad" },
      h("div", { class: "gate-card" },
        h("span", { class: "gate-mark" }, glyph("lock")),
        h("div", {},
          h("b", {}, blocked.reason),
          h("p", {}, blocked.detail),
          button(blocked.fix[0], { kind: "primary", onClick: () => go(blocked.fix[1]) }),
        ),
      ),
    )),
  );
}

/** First setup, or setup again from the palette: one window, over whatever is on the page. */
function showSetup({ firstRun, team = "" }) {
  // A team link opened while the window is up goes to that window.
  if (setupWindow) {
    if (team) setupWindow.follow?.(team);
    return;
  }
  setupWindow = openSetup({
    firstRun,
    team,
    onDone: async (next = "dashboard") => {
      // The address first: a context change on the way must not find #/start and open setup again.
      history.replaceState(null, "", `#/${next}`);
      setupWindow = null;
      await loadContext().catch(() => {});
      await refreshStatus().catch(() => {});
      show({ force: true });
    },
    onCancel: () => { setupWindow = null; },
  });
}

async function show({ force = false } = {}) {
  const moved = movedTo();
  if (moved) {
    history.replaceState(null, "", `#/${moved}`);
    return show();
  }
  const page = $("#page");
  if (!setupDone()) {
    // Nothing opens before setup: the page stays empty under the setup window.
    renderNav();
    try { current.cleanup?.(); } catch {}
    current = { name: "", gate: null, frame: null, cleanup: null, update: null };
    clear(page);
    showSetup({ firstRun: true, team: route().query.get("team") || "" });
    return;
  }
  let { name, params, query } = route();
  if (name === "start") {
    history.replaceState(null, "", `#/${current.name || "dashboard"}`);
    showSetup({ firstRun: false, team: query.get("team") || "" });
    if (current.name) return;
    ({ name, params } = route());
  }
  if (!name || !visible(name)) {
    history.replaceState(null, "", "#/dashboard");
    return show();
  }
  renderNav();
  $("#rail").classList.remove("open");
  const blocked = gate(name);
  if (!force && !blocked && !current.gate && current.name === name && typeof current.update === "function") {
    current.update(params);
    return;
  }
  try { current.cleanup?.(); } catch {}
  // Each screen gets its own frame, so one still loading cannot draw into the next.
  const frame = h("div", { class: "view-frame" });
  clear(page, frame);
  current = { name, gate: blocked, frame, cleanup: null, update: null };
  if (blocked) {
    gatedPage(frame, name, blocked);
    return;
  }
  const view = VIEWS[name];
  try {
    const mounted = await view.mount(frame, params);
    if (current.frame !== frame) return;
    current.cleanup = mounted?.cleanup || null;
    current.update = mounted?.update || null;
  } catch (error) {
    console.error(error);
    clear(frame, pageHead({ title: view.title || "오류" }), h("div", { class: "pad" }, errorNotice(error)));
  }
}

/** A change in setup or status can lock, unlock or hide the screen on view. */
function regate() {
  if (!current.name) {
    if (setupDone() && !setupWindow) show({ force: true });
    return;
  }
  const { name } = route();
  if (name !== current.name) return;
  if (!visible(name) || (gate(name)?.reason || "") !== (current.gate?.reason || "")) show({ force: true });
}

async function probeAudit() {
  if (app.context?.localServer) return;
  try {
    await get("/api/dashboard/audit?limit=1&hours=1");
    app.auditAnswers = true;
  } catch (error) {
    // The dashboard answering with its own error still means it is here.
    app.auditAnswers = !error.unreachable && Boolean(error.status) && error.status !== 404;
  }
}

function palette() {
  const entries = [
    ...navItems().map(([name, label]) => ({ label, hint: "화면", words: NAV_WORDS[name], screen: name, run: () => go(name) })),
    { label: "기억에서 찾기", hint: "기억", screen: "memory", run: () => { go("memory"); setTimeout(() => $("#memory-search")?.focus(), 50); } },
    { label: "내 기억에 묻기", hint: "기억", screen: "ask", run: () => go("ask") },
    { label: "대화 수집 수정", hint: "기억 설정", words: "서버 에이전트 프로젝트 폴더 회사 서버", screen: "computer", run: () => go("computer/collect") },
    { label: "MCP 도구", hint: "기억 설정", screen: "computer", run: () => go("computer/tools") },
    { label: "ChatGPT 기록 가져오기", hint: "기억 설정", screen: "computer", run: () => go("computer/import") },
    { label: "구독 계정 더하기", hint: "서버", screen: "models", run: () => go("models") },
    { label: "공유", hint: "서버", words: "다른 컴퓨터 붙이기 서버 token 팀 만들기 초대 코드", screen: "share", run: () => go("share") },
    { label: "대화 원본 백업", hint: "백업", screen: "backup", run: () => go("backup") },
    { label: "처음 설정 다시 하기", hint: "시작하기", screen: "", run: () => go("start") },
  ].filter((entry) => !entry.screen || visible(entry.screen))
    .map((entry) => (entry.screen && gate(entry.screen) ? { ...entry, hint: `${entry.hint} · 잠김` } : entry));
  let selected = 0;
  const input = h("input", { class: "input", placeholder: "이동하거나 기능 찾기", "aria-label": "빠른 이동" });
  const list = h("ul", { role: "listbox" });
  const dialog = h("dialog", { class: "sheet palette" }, input, list);
  const matches = () => entries.filter((entry) => `${entry.label} ${entry.hint} ${entry.words || ""}`.toLowerCase().includes(input.value.trim().toLowerCase()));
  const draw = () => {
    const found = matches();
    selected = Math.min(selected, Math.max(0, found.length - 1));
    clear(list, found.map((entry, index) => h("li", {}, h("button", {
      type: "button",
      "aria-selected": String(index === selected),
      onclick: () => { dialog.close(); entry.run(); },
    }, h("span", {}, entry.label), h("small", {}, entry.hint)))));
  };
  input.addEventListener("input", () => { selected = 0; draw(); });
  input.addEventListener("keydown", (event) => {
    const found = matches();
    if (event.key === "ArrowDown") { selected = Math.min(found.length - 1, selected + 1); draw(); event.preventDefault(); }
    if (event.key === "ArrowUp") { selected = Math.max(0, selected - 1); draw(); event.preventDefault(); }
    if (event.key === "Enter" && found[selected]) { dialog.close(); found[selected].run(); }
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  draw();
  dialog.showModal();
  input.focus();
}

async function boot() {
  renderTheme();
  $("#menu").addEventListener("click", () => $("#rail").classList.toggle("open"));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && setupDone()) {
      event.preventDefault();
      if (!document.querySelector("dialog.palette")) palette();
    }
  });
  onChange(() => { renderWho(); renderNav(); regate(); });
  renderWho();
  try {
    await loadContext();
  } catch (error) {
    clear($("#page"), pageHead({ title: "팀 메모리" }), h("div", { class: "pad" }, errorNotice(error)));
    return;
  }
  mountBell($(".main"));
  // The team's requests, and a team login that ended, go to the bell once this
  // computer is in a team.
  const watchTeam = () => {
    if (!app.context?.team?.hub) return;
    watchRequests();
    watchTeamLogin({ onDone: () => show({ force: true }), refused: requestsLoginRefused });
  };
  watchTeam();
  onChange(watchTeam);
  window.addEventListener("hashchange", () => show());
  const firstStatus = refreshStatus();
  // Whether this computer is set up, and whether 기억 opens, depend on the first
  // check (a memory server answering, the gateway on a server computer), so give it
  // a moment rather than open a screen and then lock or hide it.
  await Promise.race([firstStatus, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await probeAudit();
  await show();
  setInterval(() => { refreshStatus(); refreshBell(); }, 60_000);
}

boot();
