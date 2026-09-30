// The app shell: navigation, the "this computer" status in the rail, the theme,
// the quick-jump palette, and handing the page to one screen at a time.
import { h, clear, $ } from "./lib/dom.js";
import { icon } from "./lib/icons.js";
import { app, go, loadContext, me, onChange, refreshStatus, workspace } from "./lib/state.js";
import { errorNotice, light, pageHead } from "./lib/ui.js";

import memory from "./views/memory.js";
import ask from "./views/ask.js";
import models from "./views/models.js";
import connect from "./views/connect.js";
import server from "./views/server.js";
import tools from "./views/tools.js";
import start from "./views/start.js";

const VIEWS = { memory, ask, models, connect, server, tools, start };
const NAV = [
  ["memory", "기억", "memory"],
  ["ask", "묻기", "ask"],
  ["models", "모델·계정", "models"],
  ["connect", "연결", "connect"],
  ["server", "서버", "server"],
  ["tools", "도구·기록", "tools"],
];

let current = { name: "", cleanup: null };

function route() {
  const [name = "", ...rest] = decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/");
  return { name: VIEWS[name] ? name : "", params: rest };
}

function renderNav() {
  const nav = $("#nav");
  const needsSetup = app.context && !app.context.configured && !app.context.sharedBridge?.connected;
  const items = needsSetup ? [["start", "시작하기", "start"], ...NAV] : NAV;
  const active = route().name || defaultView();
  clear(nav, items.map(([name, label, glyph]) => h("a", {
    href: `#/${name}`,
    "aria-current": name === active ? "page" : null,
  }, icon(glyph), h("span", {}, label))));
}

function renderMachine() {
  const { honcho, gateway, collector } = app.status;
  clear($("#machine"),
    h("a", { href: "#/server" }, light(honcho.state), h("span", {}, "기억 서버"), h("small", {}, honcho.text)),
    h("a", { href: "#/models" }, light(gateway.state), h("span", {}, "구독 게이트웨이"), h("small", {}, gateway.text)),
    h("a", { href: "#/connect" }, light(collector.state), h("span", {}, "대화 수집"), h("small", {}, collector.text)),
  );
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
  if (!app.context.configured && !app.context.sharedBridge?.connected) return "start";
  return "memory";
}

async function show() {
  const { name, params } = route();
  if (!name) {
    history.replaceState(null, "", `#/${defaultView()}`);
    return show();
  }
  renderNav();
  $("#rail").classList.remove("open");
  const view = VIEWS[name];
  const page = $("#page");
  if (current.name === name && typeof current.update === "function") {
    current.update(params);
    return;
  }
  try { current.cleanup?.(); } catch {}
  clear(page);
  current = { name, cleanup: null, update: null };
  try {
    const mounted = await view.mount(page, params);
    current.cleanup = mounted?.cleanup || null;
    current.update = mounted?.update || null;
  } catch (error) {
    console.error(error);
    clear(page, pageHead({ title: view.title || "오류" }), h("div", { class: "pad" }, errorNotice(error)));
  }
}

function palette() {
  const entries = [
    ...NAV.map(([name, label]) => ({ label, hint: "화면", run: () => go(name) })),
    { label: "기억에서 찾기", hint: "기억", run: () => { go("memory"); setTimeout(() => $("#memory-search")?.focus(), 50); } },
    { label: "내 기억에 묻기", hint: "묻기", run: () => go("ask") },
    { label: "구독 계정 추가", hint: "모델·계정", run: () => go("models") },
    { label: "에이전트 대화 수집 설정", hint: "연결", run: () => go("connect/collect") },
    { label: "ChatGPT 기록 가져오기", hint: "연결", run: () => go("connect/import") },
    { label: "서버 점검", hint: "서버", run: () => go("server") },
    { label: "MCP 도구 켜고 끄기", hint: "도구·기록", run: () => go("tools") },
    { label: "조회 기록", hint: "도구·기록", run: () => go("tools/audit") },
    { label: "처음 설정 다시 보기", hint: "시작하기", run: () => go("start") },
  ];
  let selected = 0;
  const input = h("input", { class: "input", placeholder: "이동하거나 기능 찾기", "aria-label": "빠른 이동" });
  const list = h("ul", { role: "listbox" });
  const dialog = h("dialog", { class: "sheet palette" }, input, list);
  const matches = () => entries.filter((entry) => `${entry.label} ${entry.hint}`.toLowerCase().includes(input.value.trim().toLowerCase()));
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
  onChange(() => { renderMachine(); renderNav(); });
  renderMachine();
  try {
    await loadContext();
  } catch (error) {
    clear($("#page"), pageHead({ title: "팀 메모리" }), h("div", { class: "pad" }, errorNotice(error)));
    return;
  }
  window.addEventListener("hashchange", show);
  await show();
  refreshStatus();
  setInterval(refreshStatus, 60_000);
}

boot();
