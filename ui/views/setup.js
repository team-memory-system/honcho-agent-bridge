// 처음 설정: one window over an empty page until this computer is set up, and again
// from the palette (처음 설정 다시 하기). The first choice decides the steps: 팀에
// 들어가기 starts from the 팀 주소 the admin copied, 새 팀 만들기 from a Cloudflare API
// token, and 혼자 쓰기 from nothing. Every way ends with 적용; the window then shows
// each thing it does (적용 중) and what is left to do in the agents (할 일). Where
// the conversations go, from which agents and which folders, are lib/collect.js's
// steps, the same ones 기억 설정 → 대화 수집 → 수정 opens.
import { cli, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { number } from "../lib/format.js";
import { counter, field, modal, opt, opts, progressList, stepper, todoList } from "../lib/kit.js";
import {
  AGENTS,
  agentTodo,
  agentsStep,
  applySetup,
  collectDraft,
  detectAgents,
  explainWarning,
  loadProjects,
  projectsStep,
  serverStep,
  setupBody,
} from "../lib/collect.js";
import { gatewayLogin } from "../lib/login.js";
import { clientOutcome, connectTeammate, parseTeamAddresses } from "../lib/team.js";
import { app, loadContext, refreshStatus, savePrefs } from "../lib/state.js";
import { button, notice } from "../lib/ui.js";

const TITLE = "팀 메모리 시작하기";
const STARTS = [
  ["join", "팀에 들어가기", "관리자에게 받은 팀 주소로 들어갑니다.", "들어가기"],
  ["make", "새 팀 만들기", "팀 관리자가 처음 한 번 합니다.", "만들기"],
  ["solo", "혼자 쓰기", "팀 없이 내 컴퓨터에서만 씁니다.", "시작"],
];
const LABELS = { team: "팀 주소", make: "팀 만들기", server: "서버", model: "모델", agents: "에이전트", projects: "프로젝트", mates: "팀원" };
const BACKENDS = [["codex", "ChatGPT"], ["claude", "Claude"]];

// Where `server prepare` stopped for the person to do something, in this window's words.
const NEXT_ACTIONS = {
  "docker-first-run": "Docker Desktop 창에서 약관에 동의하고 처음 설정을 마치세요. 엔진이 켜졌다고 하면 다시 시도를 누르세요.",
  "restart-required": "Docker Desktop이 쓰는 WSL 2를 마저 설치하려면 Windows를 다시 시작해야 합니다. 다시 켠 뒤 이 앱을 열면 이어서 합니다.",
  "docker-install-approval": "Docker Desktop을 설치하려면 Windows가 묻는 창에서 예를 눌러야 합니다. 누른 뒤 다시 시도를 누르세요.",
};

/** What a CLI answer that did not succeed says, in one line. */
function problem(result, fallback) {
  const lines = [...(result?.issues || []), result?.error, result?.next].filter(Boolean).map(explainWarning);
  return lines.join(" ") || fallback;
}

/**
 * Opens the window. `firstRun` keeps it open until setup is done. `onDone(screen)`
 * hears which screen to open after it; `onCancel` that it was closed half way.
 */
export function openSetup({ firstRun, onDone, onCancel }) {
  const state = {
    path: null,
    team: { address: "", found: [], apiToken: "", email: "", zone: "", name: "memory" },
    draft: collectDraft(app.context),
    models: { chosen: new Set(["codex"]), counts: { codex: 1, claude: 1 } },
    mates: new Set(),
    tasks: [],
    applied: null,
    connected: [],
  };
  let at = 0;
  let steps = [];
  const issue = h("div", {});
  const win = modal({
    title: TITLE,
    locked: firstRun,
    onClose: (value) => { if (value !== "done") onCancel?.(); },
  });

  // ── The steps, which follow the first choice and the server chosen ──

  const needsModel = () => state.draft.server === "here" && !app.context?.localServer;
  const stepKeys = () => [
    ...(state.path === "join" ? ["team"] : []),
    ...(state.path === "make" ? ["make"] : []),
    "server",
    ...(needsModel() ? ["model"] : []),
    ...(state.draft.server === "none" ? [] : ["agents", "projects"]),
    ...(state.path === "join" ? ["mates"] : []),
  ];

  function teamStep() {
    const box = h("textarea", { class: "input mono", rows: "4", spellcheck: "false", placeholder: "memory https://memory.example.com/mcp\nalice https://memory-alice.example.com/mcp" });
    box.value = state.team.address;
    box.addEventListener("input", () => { state.team.address = box.value; });
    return {
      body: h("div", {}, h("h3", {}, "팀 주소를 넣으세요"),
        field("팀 주소", box, "관리자가 관리자 탭에서 복사해 보낸 팀 주소를 그대로 붙여 넣습니다. 주소 하나만 넣어도 됩니다.")),
      check() {
        const { found } = parseTeamAddresses(state.team.address);
        if (!found.length) { box.focus(); return "알아볼 수 있는 주소가 없습니다. https://로 시작하는 주소나 memory-이름.도메인 꼴로 넣으세요."; }
        // Everyone listed is offered in the 팀원 step; a teammate found again stays as chosen.
        if (state.team.found.map((item) => item.name).join() !== found.map((item) => item.name).join()) state.mates = new Set(found.map((item) => item.name));
        state.team.found = found;
        return null;
      },
    };
  }

  function makeStep() {
    const input = (key, attributes) => {
      const element = h("input", { class: "input", autocomplete: "off", spellcheck: "false", value: state.team[key], ...attributes });
      element.addEventListener("input", () => { state.team[key] = element.value; });
      return element;
    };
    const token = input("apiToken", { type: "password", class: "input mono" });
    const email = input("email", { type: "email", class: "input mono", placeholder: "admin@example.com" });
    return {
      body: h("div", {}, h("h3", {}, "새 팀 만들기"),
        field("Cloudflare API token", token, "Cloudflare에서 만든 API token을 여기에만 붙여 넣으세요. 이 컴퓨터에만 저장됩니다."),
        field("관리자 Google 이메일", email, "팀 주소로 로그인할 때 쓰는 내 Google 계정입니다."),
        h("details", { class: "fold" }, h("summary", {}, "token 권한과 팀 주소"),
          h("p", { class: "hint" }, "token에는 Account의 Cloudflare Tunnel: Edit, Access: Apps and Policies: Edit, Access: Organizations, Identity Providers, and Groups: Read와, 쓸 zone의 DNS: Edit, Zone: Read만 줍니다."),
          field("zone", input("zone", { class: "input mono", placeholder: "example.com" }), "비워 두면 token이 보는 zone이 하나일 때 그것을 씁니다."),
          field("서버 이름", input("name", { class: "input mono", placeholder: "memory" }), "내 서버 주소는 <이름>.<zone>이 됩니다."))),
      check() {
        if (!state.team.apiToken.trim()) { token.focus(); return "Cloudflare API token을 넣으세요."; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.team.email.trim())) { email.focus(); return "관리자 Google 이메일을 넣으세요."; }
        return null;
      },
    };
  }

  function modelStep() {
    const { chosen, counts } = state.models;
    const row = ([backend, title]) => {
      const box = opt({
        type: "checkbox",
        name: "models",
        value: backend,
        checked: chosen.has(backend),
        title: `${title} 구독`,
        end: [h("span", { class: "cnt-l" }, "계정"), counter(counts[backend], {
          min: 1, max: 5, label: `${title} 계정 수`,
          onChange: (count) => { counts[backend] = count; chosen.add(backend); box.input.checked = true; },
        })],
        onChange: (on) => { if (on) chosen.add(backend); else chosen.delete(backend); },
      });
      return box;
    };
    return {
      body: h("div", {},
        h("h3", {}, "기억 서버가 쓸 구독을 고르세요"),
        h("p", { class: "lead" }, "적용할 때 고른 계정마다 브라우저에서 로그인합니다."),
        opts(...BACKENDS.map(row)),
        h("div", { class: "hint" }, "하나 이상 고르세요. 계정이 여럿이면 +를 누르세요.")),
      check: () => (chosen.size ? null : "구독을 하나 이상 고르세요."),
    };
  }

  function matesStep() {
    const rows = state.team.found.map((mate) => opt({
      type: "checkbox",
      name: "mates",
      value: mate.name,
      checked: state.mates.has(mate.name),
      title: [mate.name, " ", h("span", { class: "mono muted" }, mate.host)],
      onChange: (on) => { if (on) state.mates.add(mate.name); else state.mates.delete(mate.name); },
    }));
    return {
      body: h("div", {}, h("h3", {}, "어느 팀원의 기억에 물을까요?"),
        h("p", { class: "lead" }, "고른 팀원의 기억을 이 컴퓨터의 Claude Code와 Codex에 도구로 넣습니다."),
        opts(...rows)),
      check: () => (state.draft.server === "none" && !state.mates.size ? "내 대화를 쌓지 않으면 팀원을 하나 이상 고르세요." : null),
    };
  }

  function buildStep(key) {
    const context = app.context;
    if (key === "team") return teamStep();
    if (key === "make") return makeStep();
    if (key === "model") return modelStep();
    if (key === "mates") return matesStep();
    if (key === "agents") return agentsStep(state.draft, context, { chatgpt: true });
    if (key === "projects") return projectsStep(state.draft, context);
    const choices = state.path === "join" ? ["here", "remote", "none"] : state.path === "make" ? ["here"] : ["here", "remote"];
    return serverStep(state.draft, context, {
      choices,
      lead: state.path === "make" ? "새 팀은 이 컴퓨터의 기억 서버로 엽니다." : null,
    });
  }

  // ── The window, one screen at a time ──

  function drawStart() {
    win.steps(null);
    win.body(
      h("h3", {}, "어떻게 시작할까요?"),
      h("div", { class: "cards" }, STARTS.map(([key, title, text, label]) => h("div", { class: "cardopt" },
        h("b", {}, title), h("p", {}, text),
        button(label, { kind: key === state.path ? "primary" : "", onClick: () => {
          state.path = key;
          // A server choice another way allowed is not one this way offers.
          if (key === "make" || (key === "solo" && state.draft.server === "none")) state.draft.server = "here";
          at = 0;
          drawStep();
        } })))));
    win.foot(firstRun ? null : button("취소", { kind: "quiet", onClick: () => win.close() }), null);
  }

  function drawStep() {
    const keys = stepKeys();
    at = Math.min(at, keys.length - 1);
    steps = keys.map(buildStep);
    clear(issue);
    win.steps(stepper(keys.map((key) => LABELS[key]), at));
    win.body(steps[at].body, issue);
    const last = at === keys.length - 1;
    win.foot(button("이전", { kind: "quiet", onClick: () => { if (at === 0) drawStart(); else { at -= 1; drawStep(); } } }),
      button(last ? "적용" : "다음", { kind: "primary", onClick: () => {
        const problemText = steps[at].check();
        if (problemText) { clear(issue, notice("warn", problemText)); return; }
        if (last) { apply(); return; }
        at += 1;
        drawStep();
      } }));
  }

  // ── 적용 중: each thing the setup does, one row each ──

  function buildTasks() {
    const { draft } = state;
    const tasks = [];
    const install = needsModel();
    if (draft.server !== "none") tasks.push({ label: "기억 서버" });
    if (install) {
      tasks.push({ title: "기억 서버 설치", sub: "Docker와 Ollama, Honcho, 구독 게이트웨이를 받아 설치합니다. 처음에는 몇 분 걸립니다.", run: prepare });
      for (const [backend, name] of BACKENDS) {
        if (!state.models.chosen.has(backend)) continue;
        const count = state.models.counts[backend];
        for (let index = 1; index <= count; index += 1) {
          tasks.push({ title: `${name} 계정 로그인${count > 1 ? ` ${index}/${count}` : ""}`, sub: "브라우저에서 로그인을 마치세요.", run: (task) => login(task, backend) });
        }
      }
      tasks.push({ title: "기억 서버 준비", sub: "서버 설정을 쓰고 임베딩 모델을 받습니다. 처음에는 오래 걸립니다.", run: prepareAgain });
      tasks.push({ title: "기억 서버 켜기", run: start });
    } else if (draft.server !== "none") {
      const host = draft.server === "remote" ? draft.remoteUrl.trim() : app.context?.localServer?.apiUrl || "";
      tasks.push({ title: draft.server === "remote" ? "내 서버 연결" : "이 컴퓨터 서버 연결", sub: host.replace(/^https?:\/\//, ""), run: check });
    }
    if (state.path === "make") tasks.push({ title: "새 팀 만들기", sub: "Cloudflare에 내 서버 주소와 팀 로그인을 만듭니다.", run: makeTeam });
    if (draft.server !== "none") {
      tasks.push({ label: "에이전트" });
      const agents = Object.keys(AGENTS).filter((name) => draft.agents?.has(name));
      agents.forEach((name, index) => tasks.push({ title: `${AGENTS[name]}에 플러그인 설치`, run: index ? afterApply : applyNow }));
      if (draft.chatgpt) tasks.push({ title: "ChatGPT 기록 가져오기", sub: `${draft.chatgpt.name} · ${(draft.chatgpt.size / 1024 / 1024).toFixed(1)}MB`, run: importChatgpt });
      tasks.push({ title: "지난 대화 수집 시작", run: backfill });
    }
    if (state.path === "join" && state.mates.size) {
      tasks.push({ label: "팀원" });
      tasks.push({ title: `${[...state.mates].join("와 ")} 기억 연결`, run: connectMates });
    }
    return tasks.map((task) => (task.label ? task : { state: "wait", ...task }));
  }

  async function prepare(task) {
    const result = await post("/api/server/prepare", { profile: "personal" });
    if (result.nextAction?.kind === "gateway-login") return;
    if (result.ok && result.ready !== false) return;
    const action = NEXT_ACTIONS[result.nextAction?.kind];
    task.retry = "다시 시도";
    throw new Error(action || problem(result, "설치하지 못했습니다."));
  }

  async function login(task, backend) {
    const panel = gatewayLogin({ backend, accountId: task.accountId || null, label: `${task.title}을 기다리는 중` });
    task.extra = panel.root;
    draw();
    const ok = await panel.done;
    task.accountId = panel.account();
    task.extra = null;
    if (!ok) throw new Error("로그인하지 못했습니다. 다시 시도를 누르면 새로 로그인합니다.");
  }

  async function prepareAgain() {
    const result = await post("/api/server/prepare", { profile: "personal" });
    if (result.nextAction?.kind === "gateway-login") throw new Error("구독 계정이 아직 연결되지 않았습니다. 위의 로그인을 마친 뒤 다시 시도를 누르세요.");
    if (!(result.ok && result.ready !== false)) throw new Error(NEXT_ACTIONS[result.nextAction?.kind] || problem(result, "준비하지 못했습니다."));
  }

  async function start(task) {
    const started = await post("/api/server/start", { profile: "personal" });
    if (!started.ok) throw new Error(problem(started, "기억 서버를 켜지 못했습니다."));
    await post("/api/host/start", {}).catch(() => {});
    await loadContext();
    task.sub = app.context?.localServer?.apiUrl?.replace(/^https?:\/\//, "") || "";
  }

  async function check() {
    const plan = await post("/api/setup/plan", setupBody(state.draft, app.context));
    if (!plan.ready) throw new Error(problem(plan, "이 서버에 쌓을 수 없습니다."));
  }

  async function makeTeam() {
    const body = { cloudflare: true, name: state.team.name.trim() || "memory", email: state.team.email.trim(), apiToken: state.team.apiToken.trim() };
    if (state.team.zone.trim()) body.zone = state.team.zone.trim();
    await cli("/api/server/share/enable", body);
    // Saved on this computer by the CLI; the window does not keep it any longer.
    state.team.apiToken = "";
    await loadContext();
  }

  async function applyNow() {
    const outcome = await applySetup(setupBody(state.draft, app.context));
    if (!outcome.ok) throw new Error(problem(outcome.result, "설정하지 못했습니다."));
    state.applied = outcome.result;
  }

  async function afterApply() {
    if (!state.applied) throw new Error("앞 단계를 먼저 마쳐야 합니다.");
  }

  async function importChatgpt(task) {
    const response = await fetch("/api/import/chatgpt", { method: "POST", headers: { "content-type": "application/json" }, body: state.draft.chatgpt });
    const payload = await response.json().catch(() => ({ ok: false, error: "결과를 읽지 못했습니다." }));
    if (!payload.ok) throw new Error(payload.error || "가져오지 못했습니다.");
    savePrefs({ chatgptImport: { at: new Date().toISOString(), conversations: payload.conversations ?? 0, newMessages: payload.new_messages ?? 0 } });
    task.sub = `대화 ${number(payload.imported_sessions ?? 0)}개를 넣었습니다.`;
  }

  async function backfill(task) {
    await cli("/api/backfill/start", {});
    task.sub = "뒤에서 오래된 대화부터 보냅니다. 대시보드에서 남은 수를 봅니다.";
  }

  async function connectMates(task) {
    const chosen = state.team.found.filter((mate) => state.mates.has(mate.name) && !state.connected.includes(mate.name));
    const failed = [];
    for (const mate of chosen) {
      const result = await connectTeammate(mate).catch((error) => ({ ok: false, error: error.message }));
      if (result.ok) state.connected.push(mate.name);
      else failed.push(`${mate.name}: ${result.error || clientOutcome(result).join(" · ") || "연결하지 못했습니다."}`);
    }
    if (failed.length) throw new Error(failed.join(" "));
    task.sub = "Claude Code와 Codex에 넣었습니다.";
  }

  function draw() {
    const running = state.tasks.find((task) => task.state === "run");
    const failed = state.tasks.find((task) => task.state === "bad");
    win.body(
      h("h3", {}, "설정하는 중입니다"),
      progressList(state.tasks.map((task) => (task.label ? task : {
        state: task.state,
        title: task.title,
        sub: task.state === "bad" ? task.error : task.sub,
      }))),
      running?.extra || null);
    win.foot(failed ? button("설정으로 돌아가기", { kind: "quiet", onClick: () => { state.tasks = []; drawStep(); } }) : null,
      failed ? button(failed.retry || "다시 시도", { kind: "primary", onClick: () => run() }) : null);
  }

  async function run() {
    for (const task of state.tasks) {
      if (task.label || task.state === "ok") continue;
      task.state = "run";
      task.error = null;
      draw();
      try {
        await task.run(task);
        task.state = "ok";
      } catch (error) {
        task.state = "bad";
        task.error = error?.message || String(error);
        draw();
        return;
      }
    }
    draw();
    finish();
  }

  function apply() {
    win.steps(stepper(stepKeys().map((key) => LABELS[key]), "done"));
    state.tasks = buildTasks();
    run();
  }

  // ── 할 일: what is left to do in the agents ──

  function finish() {
    savePrefs({ mode: state.path });
    refreshStatus();
    const items = state.applied ? agentTodo(state.applied, state.draft.agents) : [];
    if (state.connected.length) {
      items.push({ title: "팀원 기억", text: ["Claude Code는 열린 세션에서 ", h("span", { class: "mono" }, "/mcp"), ` 를 열고 team-${state.connected[0]} 을 골라 Authenticate를 누르세요. Codex는 팀 화면에서 Codex 로그인을 누르세요. 브라우저가 열리면 팀 Google 계정으로 로그인합니다.`] });
    }
    if (state.path === "make") items.push({ title: "관리자 탭", text: "팀원 더하기로 팀원 이메일을 넣고, 팀 주소를 보내세요." });
    const agentsOnly = items.every((item) => Object.values(AGENTS).includes(item.title));
    const next = state.path === "make" ? ["관리자 탭 열기", "admin"]
      : state.draft.server === "none" ? ["팀 화면 열기", "team"]
        : ["대시보드 열기", "dashboard"];
    win.body(
      h("h3", {}, items.length ? `${agentsOnly ? "에이전트에서 할 일" : "할 일"} ${items.length}개` : "다 됐습니다"),
      items.length ? todoList(items) : h("p", { class: "lead" }, "이제 대화가 끝날 때마다 기억 서버에 쌓입니다."));
    win.foot(null, button(next[0], { kind: "primary", onClick: () => { win.close("done"); onDone?.(next[1]); } }));
  }

  detectAgents({ fresh: true });
  loadProjects({ fresh: true });
  drawStart();
  win.open();
  return win;
}
