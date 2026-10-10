// 처음 설정: one window over an empty page until this computer is set up, and again
// from the palette (처음 설정 다시 하기). The first choice decides the steps: 팀에
// 들어가기 starts from the team's address, a team link (#/start?team=<address>) from
// the Google login itself, 새 팀 만들기 from a Cloudflare API token, and 혼자 쓰기
// from nothing. In a team the Google login comes first: the hub then says who this
// is (the peer name comes from the email, so nobody types it), whether they already
// have a server, the company server they may also collect into, and the teammates
// whose memory they may ask. Every way ends with 적용; the window then shows each
// thing it does (적용 중) and what is left to do (할 일). Where the conversations go,
// from which agents, from where the past ones come and which folders, are
// lib/collect.js's and lib/past.js's steps, the same ones 기억 설정 → 대화 수집 →
// 수정 opens. The past conversations go in before any new one, in the order they
// were started, and keep going in after the window closes.
import { gateway, get, post } from "../lib/api.js";
import { backendAccounts } from "../lib/accounts.js";
import { h, clear, copyText } from "../lib/dom.js";
import { number } from "../lib/format.js";
import { counter, field, modal, opt, opts, progressList, stepper, todoList } from "../lib/kit.js";
import {
  AGENTS,
  agentTodo,
  agentsStep,
  applySetup,
  collectDraft,
  detectAgents,
  draftServer,
  explainWarning,
  loadProjects,
  NEW_SERVER_SUB,
  projectsStep,
  serverStep,
  setupBody,
} from "../lib/collect.js";
import { backupToStore, dayText, HELD, holdNewTurns, pastStep, pastToPut, periodText, planPast, releaseNewTurns, runLine, startPast, storeOf } from "../lib/past.js";
import { gatewayLogin } from "../lib/login.js";
import { GOOGLE_ADD_ACCOUNT, loginTab, registerWith, sameAccountAgain, sendRequest, switchAccount, teamDirectory, teamHostOf, teamLogin, teamMe } from "../lib/team.js";
import { app, loadContext, refreshStatus, savePrefs } from "../lib/state.js";
import { button, notice, spinner, tag } from "../lib/ui.js";

const TITLE = "팀 메모리 시작하기";
const STARTS = [
  ["join", "팀에 들어가기", "관리자에게 받은 팀 주소로 Google에 로그인합니다.", "들어가기"],
  ["make", "새 팀 만들기", "팀 관리자가 처음 한 번 합니다.", "만들기"],
  ["solo", "혼자 쓰기", "로그인과 팀 없이 내 컴퓨터에서만 씁니다.", "시작"],
];
const LABELS = { team: "팀 주소", make: "팀 만들기", login: "로그인", server: "서버", model: "모델", agents: "에이전트", past: "지난 대화", projects: "프로젝트", mates: "팀원" };
const BACKENDS = [["codex", "ChatGPT"], ["claude", "Claude"]];
const TODO_BELL = { title: "알림", text: "팀원이 승인하면 오른쪽 위 종에 알림이 뜹니다. 그 알림에서 연결을 누르세요." };
// The Cloudflare API token 새 팀 만들기 needs, in the words of Cloudflare's token screen.
const TOKEN_PERMISSIONS = "Account의 Cloudflare Tunnel: Edit, Access: Apps and Policies: Edit, Access: Organizations, Identity Providers, and Groups: Read, Workers: Admin과, 쓸 zone의 DNS: Edit, Zone: Read, Workers Routes: Edit";

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

/** A Google login's id under its name, only when another one has the same name. */
function idpSub(idp, idps) {
  const named = (idp.name || "").trim();
  return named && idps.filter((other) => (other.name || "").trim() === named).length < 2 ? null : h("span", { class: "mono" }, idp.id);
}

/** "alice와 bob", "alice, bob과 carol": names joined the way a sentence reads. */
function joined(names) {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")}와 ${names.at(-1)}`;
}

/**
 * Opens the window. `firstRun` keeps it open until setup is done; `team` is the
 * team's address from a team link. `onDone(screen)` hears which screen to open
 * after it; `onCancel` that it was closed half way.
 */
export function openSetup({ firstRun, onDone, onCancel, team = "" }) {
  // The team link this window follows; a later one replaces it (win.follow).
  let link = team;
  const state = {
    path: link ? "link" : null,
    // zones and idps: what Cloudflare offered when the token sees more than one.
    team: { hub: link, me: null, directory: null, name: "", apiToken: "", email: "", zone: "", hubLabel: "", idp: "", zones: [], idps: [] },
    login: { phase: "idle", error: "", tab: null, reopen: null, logouts: null, switchFrom: null, sameAccount: false },
    draft: collectDraft(app.context),
    models: { chosen: new Set(["codex"]), counts: { codex: 1, claude: 1 } },
    mates: new Set(),
    tasks: [],
    applied: null,
    requested: [],
  };
  let at = 0;
  let steps = [];
  let keys = [];
  // Redraws the stepper and the button when a choice changes the steps that follow.
  let frame = null;
  const issue = h("div", {});
  const win = modal({
    title: TITLE,
    locked: firstRun,
    onClose: (value) => { if (value !== "done") onCancel?.(); },
  });

  const inTeam = () => ["join", "link", "make"].includes(state.path);
  const me = () => state.team.me;
  const myServer = () => me()?.servers?.[0] || null;
  /** The server is the one this computer runs and already shares through the team. */
  const thisComputers = (server) => Boolean(server && app.context?.localServer && server.host === app.context?.team?.localHost);
  /** This computer made the server: the hub keeps the name of the computer that made it. */
  const madeHere = (server) => Boolean(server?.createdOn && app.context?.team?.computer && server.createdOn === app.context.team.computer);
  /** The team's company server, when this person is not its owner. */
  const company = () => (state.team.directory?.servers || []).find((server) => server.company && server.owner !== me()?.email) || null;

  // ── The steps, which follow the first choice and the server chosen ──

  const needsModel = () => state.draft.server === "here" && !app.context?.localServer;
  const stepKeys = () => [
    ...(state.path === "join" ? ["team"] : []),
    ...(state.path === "make" ? ["make"] : []),
    ...(inTeam() ? ["login"] : []),
    "server",
    ...(needsModel() ? ["model"] : []),
    ...(state.draft.server === "none" ? [] : ["agents", "past", "projects"]),
    ...(inTeam() && state.path !== "make" ? ["mates"] : []),
  ];

  function teamStep() {
    const input = h("input", { class: "input mono", autocomplete: "off", spellcheck: "false", placeholder: "team.example.com", value: state.team.hub });
    input.addEventListener("input", () => { state.team.hub = input.value; });
    return {
      body: h("div", {}, h("h3", {}, "팀 주소를 넣으세요"),
        field("팀 주소", input, "관리자가 보낸 팀 주소입니다. 들어가면 브라우저에서 Google 로그인을 합니다.")),
      next: "Google로 로그인",
      check() {
        const host = teamHostOf(state.team.hub);
        if (!host) { input.focus(); return "팀 주소를 team.example.com 이나 https://로 시작하게 넣으세요."; }
        state.team.hub = host;
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
    const name = input("name", { placeholder: "예: 우리 팀", maxlength: "60" });
    const token = input("apiToken", { type: "password", class: "input mono" });
    const email = input("email", { type: "email", class: "input mono", placeholder: "admin@example.com" });
    const { zones, idps } = state.team;
    // Cloudflare had more than one and the token did not say which: one to pick, at the top.
    const choice = (key, text, rows) => notice("warn", h("b", {}, text),
      opts(...rows.map(([value, title, sub]) => opt({
        name: `make-${key}`, value, title, sub, checked: state.team[key] === value,
        onChange: (on) => { if (on) state.team[key] = value; },
      }))));
    return {
      body: h("div", {}, h("h3", {}, "새 팀 만들기"),
        zones.length ? choice("zone", `이 token이 보는 zone이 ${zones.length}개입니다. 팀 주소에 쓸 zone을 고르세요.`,
          zones.map((zone) => [zone, h("span", { class: "mono" }, zone)])) : null,
        idps.length ? choice("idp", `Cloudflare Zero Trust에 Google 로그인이 ${idps.length}개 있습니다. 팀 주소에 로그인할 때 쓸 것을 고르세요.`,
          idps.map((idp) => [idp.id, idp.name || idp.id, idpSub(idp, idps)])) : null,
        field("팀 이름", name),
        field("Cloudflare API token", token, "Cloudflare에서 만든 API token을 여기에만 붙여 넣으세요."),
        field("관리자 Google 이메일", email, "팀 주소로 로그인할 내 Google 계정입니다."),
        h("details", { class: "fold" }, h("summary", {}, "token 권한과 팀 주소"),
          h("p", { class: "hint" }, `token에는 ${TOKEN_PERMISSIONS}만 줍니다.`),
          zones.length ? null : field("zone", input("zone", { class: "input mono", placeholder: "example.com" }), "비워 두면 token이 보는 zone이 하나일 때 그것을 씁니다."),
          field("팀 주소 이름", input("hubLabel", { class: "input mono", placeholder: "team" }), "팀 주소는 <이름>.<zone>이 됩니다."))),
      next: "만들고 로그인",
      check() {
        if (!state.team.name.trim()) { name.focus(); return "팀 이름을 넣으세요."; }
        if (!state.team.apiToken.trim()) { token.focus(); return "Cloudflare API token을 넣으세요."; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.team.email.trim())) { email.focus(); return "관리자 Google 이메일을 넣으세요."; }
        if (zones.length && !zones.includes(state.team.zone)) return "팀 주소에 쓸 zone을 고르세요.";
        if (idps.length && !idps.some((idp) => idp.id === state.team.idp)) return "팀 주소에 로그인할 때 쓸 Google 로그인을 고르세요.";
        return null;
      },
      // Made before the login: the login is to the team this makes.
      async run() {
        const body = { name: state.team.name.trim(), email: state.team.email.trim(), apiToken: state.team.apiToken.trim() };
        if (state.team.zone.trim()) body.zone = state.team.zone.trim();
        if (state.team.hubLabel.trim()) body.hub = state.team.hubLabel.trim();
        if (state.team.idp) body.idp = state.team.idp;
        const made = await post("/api/team/make", body);
        if (!made.ok) {
          // Nothing was made yet: the step comes back with the list to pick from, token kept.
          if (["zone", "idp"].includes(made.choose) && made.choices?.length) {
            state.team[made.choose === "zone" ? "zones" : "idps"] = made.choices;
            throw Object.assign(new Error(""), { choose: true });
          }
          throw new Error(problem(made, "팀을 만들지 못했습니다."));
        }
        // Kept by the CLI on this computer and in the team hub; the window lets go of it.
        state.team.apiToken = "";
        state.team.hub = made.team.host;
      },
    };
  }

  function loginStep() {
    const { login } = state;
    const host = h("span", { class: "mono muted" }, state.team.hub);
    if (login.phase === "denied") {
      return {
        body: h("div", {}, h("h3", {}, "이 이메일은 팀 명단에 없습니다"),
          h("div", { class: "idbox" }, h("span", { class: "mono" }, login.email || "")),
          // Google picks the only account a browser is signed in to without asking.
          login.sameAccount ? notice("warn", "Google이 같은 계정을 다시 골랐습니다. 브라우저에 Google 계정이 하나뿐이면 Google은 묻지 않고 그 계정으로 로그인합니다. ",
            h("a", { href: GOOGLE_ADD_ACCOUNT, target: "_blank", rel: "noreferrer" }, "다른 Google 계정 추가"),
            "에서 쓸 계정을 브라우저에 더한 뒤 다른 계정으로 로그인을 다시 누르세요.") : null,
          h("p", { class: "lead", style: { marginTop: "12px" } }, "이 이메일을 팀 관리자에게 보내고, 등록되면 다시 로그인을 누르세요.")),
        foot: [
          button("다른 계정으로 로그인", { kind: "quiet", onClick: () => {
            // Access forgets the login on both of its domains, then the login starts
            // again in the same tab and Google is asked which account.
            const tab = loginTab("로그아웃하는 중입니다…");
            const logouts = login.logouts?.() || [];
            login.switchFrom = login.email || null;
            login.phase = "leaving";
            login.reopen = null;
            drawStep();
            switchAccount(tab, logouts).then(() => {
              login.phase = "idle";
              login.tab = tab;
              if (keys[at] === "login") drawStep();
            });
          } }),
          button("이메일 복사", { onClick: async () => { await copyText(login.email || ""); } }),
          button("다시 로그인", { kind: "primary", onClick: (event) => recheck(event.currentTarget) }),
        ],
        check: () => "팀 명단에 들어간 뒤 다시 로그인을 누르세요.",
      };
    }
    if (login.phase === "error") {
      return {
        body: h("div", {}, h("h3", {}, "로그인하지 못했습니다"), notice("bad", login.error)),
        foot: [button("다시 로그인", { kind: "primary", onClick: () => {
          login.phase = "idle";
          login.tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
          drawStep();
        } })],
        check: () => login.error,
      };
    }
    if (login.phase === "idle" && !login.tab) {
      // A team link opens this step with no click behind it, and the browser blocks a
      // tab opened without one; the login starts in this button's click instead.
      return {
        body: h("div", {}, h("h3", {}, "Google로 로그인을 누르세요"),
          h("div", { class: "idbox" }, state.team.name ? h("b", {}, state.team.name) : null, host)),
        foot: [button("Google로 로그인", { kind: "primary", onClick: () => {
          login.tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
          drawStep();
        } })],
        check: () => "Google로 로그인을 누르세요.",
      };
    }
    if (login.phase === "idle") startLogin();
    const leaving = login.phase === "leaving";
    return {
      body: h("div", {}, h("h3", {}, "브라우저에서 Google 로그인을 마치세요"),
        h("div", { class: "idbox" }, state.team.name ? h("b", {}, state.team.name) : null, host),
        h("div", { class: "waitline" }, spinner(), leaving ? "이전 계정에서 로그아웃하는 중입니다." : "로그인을 기다리는 중입니다."),
        h("div", { class: "hint" }, "브라우저가 열리지 않았거나 로그인 창이 오류를 보이면 브라우저 다시 열기를 누르세요. 로그인을 새로 시작합니다.")),
      foot: [button("브라우저 다시 열기", { disabled: leaving, onClick: () => login.reopen?.() })],
      check: () => "브라우저에서 로그인을 마치세요.",
    };
  }

  /** The hub login, then who the hub says this is. */
  async function startLogin() {
    const { login } = state;
    login.phase = "waiting";
    const controller = new AbortController();
    login.abort = () => controller.abort();
    try {
      const flow = teamLogin({ kind: "hub", hub: state.team.hub, tab: login.tab, signal: controller.signal });
      login.reopen = flow.reopen;
      login.logouts = flow.logouts;
      await flow.done;
      login.tab = null;
      await admit();
    } catch (error) {
      if (error?.name === "AbortError") return;
      login.phase = "error";
      login.error = error?.message || String(error);
      if (keys[at] === "login") drawStep();
    }
  }

  /** Who the hub says this is: on the list, on to the server step; not, the 명단에 없음 screen. */
  async function admit() {
    const { login } = state;
    const who = await teamMe(state.team.hub);
    login.email = who.email;
    // After 다른 계정으로 로그인: the same email again means Google chose the same account.
    login.sameAccount = !who.member && sameAccountAgain(login.switchFrom, who.email);
    login.switchFrom = null;
    if (!who.member) {
      login.phase = "denied";
      if (keys[at] === "login") drawStep();
      return;
    }
    state.team.me = who;
    state.team.name = who.team?.name || state.team.name;
    state.team.directory = await teamDirectory().catch(() => null);
    // A team's peer name comes from the email; nobody types it.
    state.draft.userPeer = who.peer || state.draft.userPeer;
    // Someone with a server starts from it. This computer's own server is "here", and so
    // is one this computer made that is gone (the app set up again): it is made again
    // here and its address moves to it.
    const own = who.servers?.[0];
    state.draft.server = state.path === "make" || !own || thisComputers(own) || madeHere(own) ? "here" : "found";
    login.phase = "done";
    if (keys[at] === "login") { at += 1; drawStep(); }
  }

  async function recheck(target) {
    target.disabled = true;
    try { await admit(); } catch (error) { state.login.phase = "error"; state.login.error = error.message; drawStep(); }
    finally { target.disabled = false; }
  }

  /** The server step in a team: the server this person has, a new one here, or none; and the company server. */
  function teamServerStep() {
    const draft = state.draft;
    const own = myServer();
    const here = thisComputers(own);
    const local = app.context?.localServer;
    // A server this computer made is never one to connect to from here. Not running
    // here (the app set up again), it is made again and its address moves to it.
    const gone = !here && !local && madeHere(own);
    const mine = here || madeHere(own) ? null : own;
    const choices = state.path === "make" || !mine ? ["here", "none"] : ["found", "here", "none"];
    if (!choices.includes(draft.server)) draft.server = choices[0];
    const pick = (choice) => () => { draft.server = choice; frame?.(); };
    const rows = choices.map((choice) => {
      if (choice === "found") {
        return opt({ name: "server", value: "found", checked: draft.server === "found", onChange: pick("found"),
          title: ["내 서버 ", h("span", { class: "mono muted" }, mine.host)],
          sub: mine.createdOn ? `${mine.createdOn}에서 만든 서버` : null,
          end: tag("찾음", "ok") });
      }
      if (choice === "here") {
        return local
          ? opt({ name: "server", value: "here", checked: draft.server === "here", onChange: pick("here"),
            title: ["이 컴퓨터 서버 ", h("span", { class: "mono muted" }, local.apiUrl.replace(/^https?:\/\//, ""))],
            sub: here ? own.host : own ? "내 서버 주소를 이 컴퓨터 서버로 옮깁니다." : null,
            end: here ? tag("지금 쌓는 중", "ok") : tag("이 컴퓨터에 있음") })
          : opt({ name: "server", value: "here", checked: draft.server === "here", onChange: pick("here"),
            title: "이 컴퓨터에 새로 만들기", sub: own ? `${NEW_SERVER_SUB} 내 서버 주소를 이 컴퓨터 서버로 옮깁니다.` : NEW_SERVER_SUB });
      }
      return opt({ name: "server", value: "none", checked: draft.server === "none", onChange: pick("none"), title: "쌓지 않기" });
    });
    const other = state.path === "make" ? null : company();
    if (other && !draft.company) draft.company = { on: false, host: other.host, label: "회사 서버", owner: other.owner, folders: new Set() };
    return {
      body: h("div", {},
        h("h3", {}, "어디에 쌓을까요?"),
        own ? h("div", { class: "label" }, "내 기억 서버") : h("p", { class: "lead" }, `${me()?.email || ""} 계정에는 아직 기억 서버가 없습니다.`),
        opts(...rows),
        gone ? h("div", { class: "hint" }, `내 서버 ${own.host}는 이 컴퓨터에서 만든 서버인데, 지금 이 컴퓨터에 없습니다. 새로 만들면 이 주소가 새 서버로 옮겨집니다.`) : null,
        other ? [h("div", { class: "label" }, "함께 쌓을 서버"), opts(opt({
          type: "checkbox",
          name: "company",
          value: other.host,
          checked: draft.company.on,
          title: ["회사 ", h("span", { class: "mono muted" }, other.host)],
          end: tag("승인 요청", "warn"),
          onChange: (on) => { draft.company.on = on; },
        }))] : null),
      check: () => (draft.server === "none" && draft.company?.on ? "회사 서버에 쌓으려면 내 기억 서버를 먼저 고르세요." : null),
    };
  }

  function modelStep() {
    const { chosen, counts } = state.models;
    const row = ([backend, title]) => {
      // The number of accounts belongs to a subscription that is ticked; kept in place
      // but not shown otherwise, so an unticked row does not read as one account.
      const accounts = h("span", { class: "cnt-g" }, h("span", { class: "cnt-l" }, "계정"), counter(counts[backend], {
        min: 1, max: 5, label: `${title} 계정 수`,
        onChange: (count) => { counts[backend] = count; },
      }));
      const shown = (on) => { accounts.style.visibility = on ? "" : "hidden"; };
      shown(chosen.has(backend));
      return opt({
        type: "checkbox",
        name: "models",
        value: backend,
        checked: chosen.has(backend),
        title: `${title} 구독`,
        end: accounts,
        onChange: (on) => { if (on) chosen.add(backend); else chosen.delete(backend); shown(on); },
      });
    };
    return {
      body: h("div", {},
        h("h3", {}, "기억 서버가 쓸 구독을 고르세요"),
        h("p", { class: "lead" }, "적용할 때 고른 계정마다 브라우저에서 로그인합니다. 이 컴퓨터에 이미 로그인된 계정이 있으면 그 계정을 씁니다."),
        opts(...BACKENDS.map(row)),
        h("div", { class: "hint" }, "하나 이상 고르세요. 계정이 여럿이면 +를 누르세요.")),
      check: () => (chosen.size ? null : "구독을 하나 이상 고르세요."),
    };
  }

  /** The teammates who have a server: whose memory this computer's agents may ask, once they approve. */
  function matesStep() {
    const people = (state.team.directory?.people || []).filter((person) => person.email !== me()?.email);
    const servers = new Map((state.team.directory?.servers || []).map((server) => [server.owner, server]));
    if (!state.matesSeeded) {
      for (const person of people) if (servers.has(person.email)) state.mates.add(person.email);
      state.matesSeeded = true;
    }
    const rows = people.map((person) => {
      const server = servers.get(person.email);
      const name = person.peer || person.email.split("@")[0];
      return opt({
        type: "checkbox",
        name: "mates",
        value: person.email,
        checked: Boolean(server) && state.mates.has(person.email),
        disabled: !server,
        title: server ? [name, " ", h("span", { class: "mono muted" }, server.host)] : name,
        sub: server ? null : "서버 없음",
        onChange: (on) => { if (on) state.mates.add(person.email); else state.mates.delete(person.email); },
      });
    });
    return {
      body: h("div", {}, h("h3", {}, "어느 팀원의 기억에 물을까요?"),
        h("p", { class: "lead" }, "고른 팀원에게 chat을 요청합니다. 승인되면 이 컴퓨터의 Claude Code와 Codex에 도구로 넣습니다."),
        rows.length ? opts(...rows) : h("div", { class: "opts" }, h("div", { class: "list-empty" }, "아직 서버를 연 팀원이 없습니다."))),
      check: () => (state.draft.server === "none" && !state.mates.size ? "내 대화를 쌓지 않으면 팀원을 하나 이상 고르세요." : null),
    };
  }

  /** The server the projects step counts against: none yet for one this setup makes, a team's by its address. */
  const overviewServer = () => draftServer(state.draft, app.context, {
    newServer: needsModel(),
    url: state.draft.server === "found" ? `https://${myServer().host}` : null,
  });

  function buildStep(key) {
    const context = app.context;
    if (key === "team") return teamStep();
    if (key === "make") return makeStep();
    if (key === "login") return loginStep();
    if (key === "model") return modelStep();
    if (key === "mates") return matesStep();
    if (key === "agents") return agentsStep(state.draft);
    if (key === "past") return pastStep(state.draft, context, { newServer: needsModel() });
    if (key === "projects") return projectsStep(state.draft, context, { server: overviewServer() });
    if (inTeam()) return teamServerStep();
    return serverStep(state.draft, context, { choices: ["here", "remote"], onPick: () => frame?.() });
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
          if (key === "solo" && !["here", "remote"].includes(state.draft.server)) state.draft.server = "here";
          if (key !== "solo" && state.draft.server === "remote") state.draft.server = "here";
          at = 0;
          drawStep();
        } })))));
    win.foot(firstRun ? null : button("취소", { kind: "quiet", onClick: () => win.close() }), null);
  }

  /** What the step says under its fields, scrolled to so it shows above the buttons. */
  function say(node) {
    clear(issue, node);
    issue.scrollIntoView({ block: "nearest" });
  }

  function drawStep() {
    keys = stepKeys();
    at = Math.min(at, keys.length - 1);
    steps = keys.map((key, index) => (index === at ? buildStep(key) : null));
    const step = steps[at];
    clear(issue);
    win.steps(stepper(keys.map((key) => LABELS[key]), at));
    win.body(step.body, issue);
    const back = button(keys[at] === "login" ? "취소" : "이전", { kind: "quiet", onClick: () => {
      state.login.abort?.();
      if (keys[at] === "login") state.login.phase = "idle";
      if (at === 0 || (state.path === "link" && keys[at] === "login")) { state.path = link ? "link" : null; drawStart(); return; }
      at -= 1;
      drawStep();
    } });
    frame = null;
    if (step.foot) {
      win.foot(back, step.foot);
      return;
    }
    const last = () => at === stepKeys().length - 1;
    const label = () => step.next || (last() ? "적용" : "다음");
    // A step still reading (지난 대화) keeps 다음 until it is done, and says so beside it.
    const waiting = h("span", { class: "foot-hint" });
    const primary = button(label(), { kind: "primary", onClick: async (event) => {
      const problemText = step.check();
      if (problemText) { say(notice("warn", problemText)); return; }
      keys = stepKeys();
      if (last()) { apply(); return; }
      // The login opens a tab: opened now, in the click, so the browser lets it.
      if (keys[at + 1] === "login") state.login.tab = loginTab(step.run ? "팀을 만드는 중입니다. 다 되면 Google 로그인으로 넘어갑니다…" : "Google 로그인으로 넘어가는 중입니다…");
      if (step.run) {
        const target = event.currentTarget;
        target.disabled = true;
        say(h("div", { class: "waitline" }, spinner(), "팀을 만드는 중입니다. 1~2분 걸립니다."));
        try {
          await step.run();
        } catch (error) {
          state.login.tab?.close();
          state.login.tab = null;
          target.disabled = false;
          // A choice to make first: the step is drawn again with it at the top.
          if (error.choose) { drawStep(); return; }
          say(notice("bad", error.message));
          return;
        }
      }
      state.login.phase = "idle";
      at += 1;
      drawStep();
    } });
    frame = () => {
      keys = stepKeys();
      win.steps(stepper(keys.map((key) => LABELS[key]), at));
      primary.querySelector("span").textContent = label();
    };
    step.watch?.(({ blocked, hint }) => {
      primary.disabled = blocked;
      waiting.textContent = hint || "";
    });
    win.foot(back, [waiting, primary]);
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
          tasks.push({ title: `${name} 계정 로그인${count > 1 ? ` ${index}/${count}` : ""}`, sub: "브라우저에서 로그인을 마치세요.", run: (task) => login(task, backend, index) });
        }
      }
      tasks.push({ title: "기억 서버 준비", sub: "서버 설정을 쓰고 임베딩 모델을 받습니다. 처음에는 오래 걸립니다.", run: prepareAgain });
      tasks.push({ title: "기억 서버 켜기", run: start });
    } else if (draft.server === "found") {
      tasks.push({ title: "내 서버 연결", sub: myServer()?.host || "", run: connectFound });
    } else if (draft.server !== "none") {
      const host = draft.server === "remote" ? draft.remoteUrl.trim() : app.context?.localServer?.apiUrl || "";
      tasks.push({ title: draft.server === "remote" ? "내 서버 연결" : "이 컴퓨터 서버 연결", sub: host.replace(/^https?:\/\//, ""), run: check });
    }
    if (inTeam() && draft.server === "here" && !thisComputers(myServer())) tasks.push({ title: "팀에 내 서버 열기", sub: "팀원이 승인을 받아 물을 수 있는 내 서버 주소를 만듭니다.", run: shareTeam });
    if (draft.company?.on) tasks.push({ title: "회사 서버에 승인 요청", sub: draft.company.host, run: requestCompany });
    if (draft.server !== "none") {
      tasks.push({ label: "에이전트" });
      const agents = Object.keys(AGENTS).filter((name) => draft.agents?.has(name));
      const held = pastToPut(draft) ? HELD : null;
      agents.forEach((name, index) => tasks.push({ title: `${AGENTS[name]}에 플러그인 설치`, sub: held, run: index ? afterApply : applyNow }));
      tasks.push({ label: "지난 대화" });
      if (storeOf(draft.past) && draft.past.backup) tasks.push({ title: "백업 켜기", run: backupOn });
      tasks.push({ title: "시작한 시각순으로 줄 세우기", run: linePast });
      if (draft.past.totals?.dupes) tasks.push({ title: "겹치는 대화 빼기", run: dupesOut });
      if (!install) tasks.push({ title: "서버에 있는 대화 빼기", run: serverOut });
      tasks.push({ title: "시간순으로 쌓기 시작", run: startFill });
    }
    const mates = matesChosen();
    if (mates.length) {
      tasks.push({ label: "팀원" });
      tasks.push({ title: `${joined(mates.map((mate) => mate.name))}에게 chat 요청`, run: requestMates });
    }
    return tasks.map((task) => (task.label ? task : { state: "wait", ...task }));
  }

  /** The teammates ticked in the 팀원 step, with their servers. */
  function matesChosen() {
    if (!inTeam() || state.path === "make") return [];
    const servers = new Map((state.team.directory?.servers || []).map((server) => [server.owner, server]));
    return (state.team.directory?.people || [])
      .filter((person) => state.mates.has(person.email) && servers.has(person.email))
      .map((person) => ({ email: person.email, name: person.peer || person.email.split("@")[0], host: servers.get(person.email).host }));
  }

  async function prepare(task) {
    const result = await post("/api/server/prepare", { profile: "personal" });
    if (result.nextAction?.kind === "gateway-login") return;
    if (result.ok && result.ready !== false) return;
    const action = NEXT_ACTIONS[result.nextAction?.kind];
    task.retry = "다시 시도";
    throw new Error(action || problem(result, "설치하지 못했습니다."));
  }

  async function login(task, backend, index) {
    // The gateway may hold this backend's accounts already (the app set up again on
    // this computer): as many logged in as were asked for are used as they are, and
    // a slot whose login never finished is logged in before another is added.
    if (!task.accountId) {
      const status = await gateway.status().catch(() => null);
      const { loggedIn, empty } = backendAccounts(status?.accounts, backend);
      if (index <= loggedIn.length) {
        task.sub = `이미 로그인된 계정 ${loggedIn[index - 1].login?.account || loggedIn[index - 1].id}`;
        return;
      }
      task.accountId = empty[index - loggedIn.length - 1] || null;
    }
    const panel = gatewayLogin({ backend, accountId: task.accountId || null, label: `${task.title}을 기다리는 중` });
    task.extra = panel.root;
    draw();
    const ok = await panel.done;
    task.accountId = panel.account();
    task.extra = null;
    // The panel goes with the reason it showed, so the reason stays on the task's line.
    if (!ok) throw new Error(`${panel.reason() || "로그인하지 못했습니다."} 다시 시도를 누르면 새로 로그인합니다.`);
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

  /** My server on another computer: this computer registers with its gate, then setup sends there. */
  async function connectFound(task) {
    const host = myServer().host;
    await registerWith(host);
    task.sub = host;
  }

  /** The address the team makes for this computer's server, and sharing on through it. */
  async function shareTeam(task) {
    const result = await post("/api/team/share", myServer() ? { replace: true } : {});
    if (!result.ok) throw new Error(problem(result, "팀에 내 서버를 열지 못했습니다."));
    task.sub = result.server?.host || result.host || "";
  }

  /** Asks the company server's owner; the server is written to only after they approve. */
  async function requestCompany(task) {
    const { company: chosen } = state.draft;
    const folders = (state.draft.projects || []).filter((project) => chosen.folders.has(project.path)).map((project) => project.name);
    await sendRequest({ kind: "collect", server: chosen.host, folders });
    chosen.requested = true;
    task.sub = `${chosen.host} · 승인 기다리는 중`;
  }

  async function applyNow() {
    // From here new turns wait, so none goes in before the past ones (lib/past.js).
    if (pastToPut(state.draft)) await holdNewTurns();
    const body = setupBody(state.draft, app.context);
    if (state.draft.server === "found") body.honchoUrl = `https://${myServer().host}`;
    const outcome = await applySetup(body);
    if (!outcome.ok) throw new Error(problem(outcome.result, "설정하지 못했습니다."));
    state.applied = outcome.result;
    // The company server takes nothing until its owner approves: kept, switched off.
    if (state.draft.company?.requested) {
      await post("/api/targets/add", {
        id: "company",
        label: "회사",
        url: `https://${state.draft.company.host}`,
        folders: [...state.draft.company.folders],
        team: true,
      }).catch(() => null);
    }
  }

  async function afterApply() {
    if (!state.applied) throw new Error("앞 단계를 먼저 마쳐야 합니다.");
  }

  // ── 지난 대화: the backup, the order, what is left out, and the start ──

  async function backupOn(task) {
    task.sub = await backupToStore(state.draft);
  }

  async function linePast(task) {
    state.plan = await planPast(state.draft);
    const { considered = 0, total = 0, first, last } = state.plan;
    task.sub = `${number(considered)}개${total ? ` · ${periodText(first, last)}` : ""}`;
  }

  async function dupesOut(task) {
    task.sub = `두 곳에 있는 같은 대화 ${number(state.plan?.dupes || 0)}개는 한 번만 넣습니다.`;
  }

  async function serverOut(task) {
    const there = Number(state.plan?.onServer || 0) + Number(state.plan?.already || 0);
    task.sub = there ? `${number(there)}개는 내 서버에 이미 있습니다.` : "내 서버에 이미 있는 대화가 없습니다.";
  }

  async function startFill(task) {
    const plan = state.plan;
    if (!plan?.total) {
      // Nothing to put in: the new turns held for them go now.
      await releaseNewTurns();
      task.sub = "새로 넣을 대화가 없습니다.";
      return;
    }
    await startPast();
    state.filling = true;
    // An empty server takes them all from the oldest; one with conversations, what it lacks.
    task.sub = !(Number(plan.onServer || 0) + Number(plan.already || 0))
      ? `${dayText(plan.first)} 대화부터`
      : `${number(plan.total)}개${plan.late && !plan.skippedLate ? ` · 오래된 ${number(plan.late)}개 포함` : ""}`;
  }

  async function requestMates(task) {
    const failed = [];
    for (const mate of matesChosen()) {
      if (state.requested.includes(mate.email)) continue;
      try {
        await sendRequest({ kind: "chat", server: mate.host });
        state.requested.push(mate.email);
      } catch (error) {
        failed.push(`${mate.name}: ${error.message}`);
      }
    }
    if (failed.length) throw new Error(failed.join(" "));
    task.sub = "승인 기다리는 중";
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

  // ── 할 일: what is left to do in the agents, and the bell ──

  function finish() {
    savePrefs({ mode: state.path === "link" ? "join" : state.path });
    refreshStatus();
    const items = state.applied ? agentTodo(state.applied, state.draft.agents) : [];
    if (state.requested.length) items.push(TODO_BELL);
    if (state.path === "make") items.push({ title: "관리자 탭", text: "팀원 더하기로 팀원 이메일을 넣고, 팀 주소를 보내세요." });
    const agentsOnly = items.every((item) => Object.values(AGENTS).includes(item.title));
    const chatOnly = state.draft.server === "none";
    // Waiting only when this setup asked someone: the admin who made a team asked nobody.
    const waiting = chatOnly && state.requested.length > 0;
    const next = state.path === "make" ? ["관리자 탭 열기", "admin"]
      : chatOnly ? ["팀 화면 열기", "team"]
        : ["대시보드 열기", "dashboard"];
    const names = matesChosen().filter((mate) => state.requested.includes(mate.email)).map((mate) => mate.name);
    win.body(
      h("h3", {}, waiting ? "승인 기다리는 중" : items.length ? `${agentsOnly ? "에이전트에서 할 일" : "할 일"} ${items.length}개` : "다 됐습니다"),
      chatOnly && names.length ? h("p", { class: "lead" }, `${joined(names)}에게 chat 요청을 보냈습니다.`) : null,
      items.length ? todoList(items) : h("p", { class: "lead" }, "이제 대화가 끝날 때마다 기억 서버에 쌓입니다."),
      state.filling ? fillJob() : null);
    win.foot(null, button(next[0], { kind: "primary", onClick: () => { win.close("done"); onDone?.(next[1]); } }));
  }

  /** 지난 대화 쌓는 중: how far the run got, asked again while the window shows it. */
  function fillJob() {
    const count = h("span", { class: "muted" });
    const bar = h("span", { style: { width: "0%" } });
    const line = h("div", { class: "s" }, "창을 닫아도 계속 쌓습니다.");
    const head = h("div", { class: "job-h" }, spinner(), h("b", {}, "지난 대화 쌓는 중"), h("span", { class: "sp" }), count);
    const box = h("div", { class: "job" }, head, h("div", { class: "bar run" }, bar), line);
    const look = async () => {
      if (!box.isConnected && box.dataset.shown) return;
      box.dataset.shown = "1";
      const past = (await get("/api/app/flow").catch(() => null))?.past || null;
      const running = past?.running;
      if (running) {
        const percent = running.total ? Math.max(1, Math.floor((running.done / running.total) * 100)) : 0;
        count.textContent = running.total !== null && running.total !== undefined ? `${number(running.done || 0)} / ${number(running.total)}` : "";
        bar.style.width = `${percent}%`;
        line.textContent = `${running.month ? `${runLine({ month: running.month })} 쌓음 · ` : ""}창을 닫아도 계속 쌓습니다.`;
      } else if (past?.last?.finishedAt) {
        clear(head, h("span", { class: "ic ok" }, "✓"), h("b", {}, "지난 대화를 다 쌓았습니다"), h("span", { class: "sp" }), h("span", { class: "muted" }, `${number(past.last.sent || 0)} / ${number(past.last.total || 0)}`));
        bar.style.width = "100%";
        bar.parentElement.classList.remove("run");
        line.textContent = past.last.held?.conversations ? `그동안 생긴 새 대화 ${number(past.last.held.conversations)}개도 쌓았습니다.` : "";
        return;
      }
      setTimeout(look, 2000);
    };
    setTimeout(look, 300);
    return box;
  }

  /**
   * A team link opened while the window is up (#/start?team= again): the window
   * starts over from it, at the login, unless setup is already applying.
   */
  win.follow = (team) => {
    if (!team || state.tasks.length || (state.path === "link" && state.team.hub === team)) return;
    state.login.abort?.();
    state.login.tab?.close();
    Object.assign(state.login, { phase: "idle", error: "", tab: null, reopen: null, abort: null });
    link = team;
    state.path = "link";
    state.team.hub = team;
    at = 0;
    drawStep();
  };

  detectAgents({ fresh: true });
  loadProjects({ fresh: true });
  if (link) {
    // A team link starts at the login, whose button opens the tab.
    at = 0;
    drawStep();
  } else {
    drawStart();
  }
  win.open();
  return win;
}

