// The app shell: navigation, the "this computer" status in the rail, the theme,
// the quick-jump palette, and handing the page to one screen at a time.
import { get } from "./lib/api.js";
import { h, clear, svg, $ } from "./lib/dom.js";
import { TABS } from "./lib/hub.js";
import { icon } from "./lib/icons.js";
import { app, go, loadContext, me, onChange, refreshStatus, workspace } from "./lib/state.js";
import { button, errorNotice, light, pageHead, toast } from "./lib/ui.js";

import memory from "./views/memory.js";
import ask from "./views/ask.js";
import computer from "./views/computer.js";
import team from "./views/team.js";
import server from "./views/server.js";
import models from "./views/models.js";
import start from "./views/start.js";
import backup from "./views/backup.js";

const VIEWS = { memory, ask, computer, team, server, models, start, backup };
// 기억 and 서버 also hold a second screen each (묻기, 구독 게이트웨이), one tab away.
const NAV = [
  ["memory", "기억", "memory"],
  ["computer", "내 컴퓨터", "connect"],
  ["team", "팀", "person"],
  ["server", "서버", "server"],
  ["backup", "백업", "backup"],
];
const START = ["start", "시작하기", "start"];

// Where an address from before the menus were regrouped (0.4.5) goes now.
const MOVED = {
  connect: "computer",
  "connect/collect": "computer/collect",
  "connect/import": "computer/import",
  "connect/share": "team/memories",
  "connect/targets": "team/targets",
  tools: "computer/tools",
  "tools/shared": "team/tools",
  "tools/audit": "team/audit",
  audit: "team/audit",
};

// Two glyphs only the shell draws, in the same hand as lib/icons.js.
const SHELL_ICONS = {
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
  backup: '<rect x="2.5" y="9.5" width="11" height="4" rx="1"/><path d="M8 2.5v5.5M5.5 5.5L8 8l2.5-2.5"/><path d="M5 11.5h.01"/>',
};
function glyph(name) {
  const body = SHELL_ICONS[name];
  return body
    ? svg(`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)
    : icon(name);
}

let current = { name: "", gate: null, frame: null, cleanup: null, update: null };

function route() {
  const [name = "", ...rest] = decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/");
  return { name: VIEWS[name] ? name : "", params: rest };
}

function movedTo() {
  const [name = "", page = ""] = decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/");
  if (VIEWS[name]) return null;
  return MOVED[`${name}/${page}`] || MOVED[name] || null;
}

/** The menu item a screen sits under: its tab group's first screen, or itself. */
function menuOf(name) {
  return Object.values(TABS).find((screens) => screens.some(([screen]) => screen === name))?.[0][0] || name;
}

// ── What this computer has, and what it can use yet ─────

/** A memory server answers here: one set up for 대화 쌓기, one installed here, or one that was already running. */
function memoryAnswers() {
  return app.status.honcho.state === "on";
}

/** Claude Code or Codex here has a teammate's memory as a team-* MCP server. */
function teamConnected() {
  return Boolean(app.context?.teamMemory?.connected);
}

function setupDone() {
  const context = app.context;
  return Boolean(context?.configured || teamConnected() || context?.localServer || memoryAnswers());
}

/** 시작하기 stays until setup is done, or, once a choice is made there, until its steps all are. */
function startOpen() {
  return !setupDone() || (Boolean(app.prefs.startChoice) && !app.prefs.startDone);
}

/** A server here, one about to be installed here, or a gateway answering here. */
function serverHere() {
  const picked = app.prefs.startChoice === "here";
  return Boolean(app.context?.localServer || picked || app.status.gateway.report);
}

/** Screens that mean nothing on this computer are left out of the menu. */
function visible(name) {
  if (name === "start") return startOpen();
  if (name === "server" || name === "models") return serverHere();
  return true;
}

/**
 * Why a screen cannot work yet, and where that gets fixed; null when it can.
 * Shown greyed in the menu, and as a notice when the screen is opened by URL.
 */
function gate(name) {
  const context = app.context;
  if (!context) return null;
  // Until the first check answers, whether a memory server is here is unknown.
  if (!setupDone() && !app.status.honcho.pending && ["memory", "ask"].includes(name)) {
    return {
      reason: "시작하기에서 설정을 마치면 열립니다",
      detail: "이 컴퓨터가 어느 기억 서버를 쓸지 아직 정하지 않았습니다.",
      fix: ["시작하기로", "start"],
    };
  }
  if (name !== "memory" && name !== "ask") return null;
  const gateway = app.status.gateway;
  if (context.localServer && !gateway.pending && gateway.state !== "on") {
    const loggedIn = (gateway.report?.accounts || []).some((account) => account.login?.loggedIn);
    return {
      reason: !gateway.report ? "구독 게이트웨이가 꺼져 있습니다. 켜고 계정을 로그인하세요"
        : loggedIn ? "구독 게이트웨이에서 로그인한 계정을 연결하세요"
          : "구독 게이트웨이에 계정을 먼저 로그인하세요",
      detail: "이 컴퓨터의 기억 서버는 구독 계정의 모델로 대화를 정리하고 질문에 답합니다.",
      fix: ["구독 게이트웨이로", "models"],
    };
  }
  if (!context.localServer && teamConnected() && !context.configured && !memoryAnswers()) {
    return {
      reason: "대화 쌓기를 켜면 열립니다",
      detail: "이 컴퓨터는 팀원 기억에만 연결돼 있습니다. 기억과 묻기는 내 기억 서버를 봅니다.",
      fix: ["대화 쌓기 설정", "computer/collect"],
    };
  }
  return null;
}

function navItems() {
  return [START, ...NAV].filter(([name]) => visible(name));
}

function renderNav() {
  const nav = $("#nav");
  if (!app.context) { clear(nav); return; }
  const active = menuOf(route().name || defaultView());
  clear(nav, navItems().map(([name, label, symbol]) => {
    const blocked = gate(name);
    const onPage = name === active ? "page" : null;
    if (!blocked) return h("a", { href: `#/${name}`, "aria-current": onPage }, glyph(symbol), h("span", {}, label));
    const explain = (event) => {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toast(blocked.reason);
    };
    return h("a", {
      class: "gated",
      role: "link",
      tabindex: "0",
      "aria-disabled": "true",
      "aria-current": onPage,
      title: blocked.reason,
      onclick: explain,
      onkeydown: explain,
    }, glyph(symbol), h("span", {}, label), glyph("lock"));
  }));
}

function renderMachine() {
  const context = app.context;
  const { honcho, gateway, collector } = app.status;
  const lines = [];
  if (context) {
    const here = serverHere();
    if (here || context.configured) {
      lines.push(h("a", { href: here ? "#/server" : "#/computer/collect" }, light(honcho.state), h("span", {}, "기억 서버"), h("small", {}, honcho.text)));
    }
    if (here) lines.push(h("a", { href: "#/models" }, light(gateway.state), h("span", {}, "구독 게이트웨이"), h("small", {}, gateway.text)));
    if (context.configured || !teamConnected()) {
      lines.push(h("a", { href: "#/computer/collect" }, light(collector.state), h("span", {}, "대화 쌓기"), h("small", {}, collector.text)));
    }
    if (teamConnected()) {
      lines.push(h("a", { href: "#/team/memories" }, light("on"), h("span", {}, "팀원 기억"), h("small", {}, `${context.teamMemory.connected}곳 연결`)));
    }
  }
  clear($("#machine"), lines);
  $("#who-name").textContent = me() || "이름 미설정";
  $("#who-space").textContent = `작업공간 ${workspace()}`;
}

function renderTheme() {
  const button = $("#theme");
  const dark = document.documentElement.dataset.theme === "dark"
    || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  clear(button, icon(dark ? "sun" : "moon"));
  button.title = dark ? "밝은 화면" : "어두운 화면";
  button.onclick = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("tm.theme", next); } catch {}
    renderTheme();
  };
}

function defaultView() {
  if (!app.context) return "memory";
  if (startOpen()) return "start";
  // Joined a teammate's memory only: there is no memory of one's own to open.
  if (!app.context.localServer && !app.context.configured && !memoryAnswers()) return "team";
  return "memory";
}

/** What a locked screen shows when it is opened by URL. */
function gatedPage(frame, name, blocked) {
  const label = [START, ...NAV].find(([key]) => key === menuOf(name))?.[1] || VIEWS[name].title;
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

async function show({ force = false } = {}) {
  const moved = movedTo();
  if (moved) {
    history.replaceState(null, "", `#/${moved}`);
    return show();
  }
  const { name, params } = route();
  if (!name) {
    history.replaceState(null, "", `#/${defaultView()}`);
    return show();
  }
  renderNav();
  $("#rail").classList.remove("open");
  const blocked = gate(name);
  if (!force && !blocked && !current.gate && current.name === name && typeof current.update === "function") {
    current.update(params);
    return;
  }
  const page = $("#page");
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

/** A change in setup or status can lock or unlock the screen on view. */
function regate() {
  if (!current.name) return;
  const { name } = route();
  if (name !== current.name) return;
  if ((gate(name)?.reason || "") !== (current.gate?.reason || "")) show({ force: true });
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
  // 팀 lists 조회 기록 once the log is known to answer here.
  const { name, params } = route();
  if (app.auditAnswers && name === "team" && !params[0]) show({ force: true });
}

function palette() {
  const entries = [
    ...navItems().map(([name, label]) => ({ label, hint: "화면", screen: name, run: () => go(name) })),
    { label: "기억에서 찾기", hint: "기억", screen: "memory", run: () => { go("memory"); setTimeout(() => $("#memory-search")?.focus(), 50); } },
    { label: "내 기억에 묻기", hint: "기억", screen: "ask", run: () => go("ask") },
    { label: "구독 계정 추가", hint: "서버", screen: "models", run: () => go("models") },
    // Every page 내 컴퓨터 and 팀 list here, found by its title or what it does.
    ...[["computer", computer], ["team", team]].flatMap(([name, view]) => view.available().map((page) => (
      { label: page.title, hint: view.title, words: page.why, screen: name, run: () => go(`${name}/${page.key}`) }))),
    { label: "서버 점검", hint: "서버", screen: "server", run: () => go("server") },
    { label: "대화 원본 백업", hint: "백업", screen: "backup", run: () => go("backup") },
    { label: "처음 설정 다시 보기", hint: "시작하기", screen: "", run: () => go("start") },
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!document.querySelector("dialog.palette")) palette();
    }
  });
  onChange(() => { renderMachine(); renderNav(); regate(); });
  renderMachine();
  try {
    await loadContext();
  } catch (error) {
    clear($("#page"), pageHead({ title: "팀 메모리" }), h("div", { class: "pad" }, errorNotice(error)));
    return;
  }
  window.addEventListener("hashchange", () => show());
  const firstStatus = refreshStatus();
  // Whether 기억 and 묻기 open depends on the first check (a memory server answering,
  // the gateway on a server computer), so give it a moment rather than open a screen
  // and then lock it.
  await Promise.race([firstStatus, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await show();
  probeAudit();
  setInterval(refreshStatus, 60_000);
}

boot();
