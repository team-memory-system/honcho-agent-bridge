// The steps that decide what this computer collects, shared by both windows that
// ask: first setup (views/setup.js) walks them in a row, and 기억 설정 → 대화 수집 →
// 수정 (views/settings.js) opens the same steps again. Where the conversations go
// (the server), from which agents, from where the past ones come (lib/past.js) and
// from which project folders are gathered in one draft and sent whole to `setup
// plan|apply` at the end, so a token typed here reaches those routes, and the count
// of what the server already holds (`past overview`), and nothing else.
import { get, post } from "./api.js";
import { h, clear } from "./dom.js";
import { number } from "./format.js";
import { folderTreeTable, openAtFirst, treeRows } from "./folder-tree.js";
import { field, opt, opts } from "./kit.js";
import { loadOverview, overviewTotals, pastDraft, pastSummary } from "./past.js";
import { details, notice, spinner, tag } from "./ui.js";

export const AGENTS = { claude: "Claude Code", codex: "Codex" };
const AGENT_FOLDERS = { claude: "~/.claude", codex: "~/.codex" };
const AGENT_LETTERS = { claude: "C", codex: "X" };
export const NEW_SERVER_SUB = "ChatGPT나 Claude 구독이 필요합니다.";
const PEER = /^[A-Za-z0-9_-]+$/;

/** Two addresses for the same server, whichever way the loopback is written. */
export function sameServer(a, b) {
  if (!a || !b) return false;
  try {
    const origin = (value) => new URL(value).origin.replace("//localhost", "//127.0.0.1");
    return origin(a) === origin(b);
  } catch {
    return false;
  }
}

/** A folder as a person reads it: the home folder as ~. */
export function shortPath(folder) {
  return String(folder || "").replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

// What detect found and which folders hold conversations: asked once per window.
let detecting = null;
let projecting = null;
export function detectAgents({ fresh = false } = {}) {
  if (!detecting || fresh) detecting = get("/api/status").then((status) => status?.detect || null).catch(() => null);
  return detecting;
}
/** The folder list as /api/app/projects answers it, or null when it cannot be read. */
function projectList({ fresh = false } = {}) {
  if (!projecting || fresh) projecting = get("/api/app/projects").catch(() => null);
  return projecting;
}
export function loadProjects(options) {
  return projectList(options).then((result) => result?.projects || []);
}

/**
 * Where a setup starts from: this computer's saved choices, or for a new one, its
 * own server and every folder.
 */
export function collectDraft(context) {
  const configured = Boolean(context?.configured);
  const localUrl = context?.localServer?.apiUrl || "";
  const usingLocal = configured && sameServer(context.honcho?.url, localUrl);
  const collect = context?.collect || null;
  return {
    server: configured && !usingLocal ? "remote" : "here",
    remoteUrl: configured && !usingLocal ? context.honcho?.url || "" : "",
    apiToken: "",
    accessClientId: "",
    accessClientSecret: "",
    userPeer: context?.user?.peerId || "",
    workspace: context?.workspace || "memory",
    agents: configured ? new Set(Object.keys(AGENTS).filter((name) => context.agents?.[name])) : null,
    // 지난 대화: the backup store and ChatGPT files chosen, and how far their reading got (lib/past.js).
    past: pastDraft(),
    // Folders: those ticked, those not, and whether folders made later are taken.
    take: new Set(collect?.take || []),
    skip: new Set(collect?.skip || []),
    rest: collect?.rest || "take",
    // 자동 실행 대화도 수집: conversations no person took part in.
    automation: Boolean(context?.collectAutomation),
    checked: null,
    projects: null,
    // The folders shown open in the projects step's tree (lib/folder-tree.js).
    open: null,
    // Other servers that also take chosen folders (targets): each kept with its folders,
    // and one more to add when `extra.on`.
    targets: (context?.targets || []).map((target) => ({
      id: target.id,
      label: target.label || target.id,
      url: target.url || "",
      team: Boolean(target.team),
      enabled: target.enabled !== false,
      wasEnabled: target.enabled !== false,
      folders: new Set(target.folders || []),
      was: new Set(target.folders || []),
    })),
    extra: { on: false, label: "", url: "", apiToken: "", accessClientId: "", accessClientSecret: "", folders: new Set() },
    // The team's company server, once this person asks to collect into it: { on, host, folders }.
    company: null,
  };
}

/** The other servers this setup sends to: those kept on, and the one being added. */
export function activeTargets(draft) {
  return [
    ...draft.targets.filter((target) => target.enabled),
    ...(draft.extra.on ? [{ id: null, label: draft.extra.label.trim() || "새 서버", url: draft.extra.url, folders: draft.extra.folders, extra: true }] : []),
    ...(draft.company?.on ? [{ id: "company", label: "회사 서버", url: `https://${draft.company.host}`, folders: draft.company.folders, company: true }] : []),
  ];
}

// ── 서버 ─────────────────────────────────────────────────

/**
 * Where to collect. `choices` lists what this window offers: "here" (this computer's
 * server, made now when there is none), "remote" (my server on another computer)
 * and "none" (store nothing, for someone who only asks teammates). `onPick(choice)`
 * hears each choice, for a window whose later steps follow it.
 */
export function serverStep(draft, context, { choices = ["here", "remote"], peer = true, lead, others = false, company = null, onPick } = {}) {
  const localUrl = context?.localServer?.apiUrl || "";
  const current = context?.configured ? (sameServer(context.honcho?.url, localUrl) ? "here" : "remote") : "";
  if (!choices.includes(draft.server)) draft.server = choices[0];
  const urlInput = h("input", { class: "input mono", type: "url", placeholder: "https://memory-me.example.com", value: draft.remoteUrl, oninput: (event) => { draft.remoteUrl = event.target.value; } });
  const tokenInput = h("input", { class: "input mono", type: "password", autocomplete: "off", value: draft.apiToken, oninput: (event) => { draft.apiToken = event.target.value; } });
  const accessId = h("input", { class: "input mono", type: "password", autocomplete: "off", value: draft.accessClientId, oninput: (event) => { draft.accessClientId = event.target.value; } });
  const accessSecret = h("input", { class: "input mono", type: "password", autocomplete: "off", value: draft.accessClientSecret, oninput: (event) => { draft.accessClientSecret = event.target.value; } });
  if (context?.honcho?.hasToken && current === "remote") tokenInput.placeholder = "저장된 token을 그대로 씁니다";
  if (context?.honcho?.hasAccess && current === "remote") { accessId.placeholder = "저장된 값을 그대로 씁니다"; accessSecret.placeholder = accessId.placeholder; }
  const remoteFields = h("div", { class: "subfields", hidden: draft.server !== "remote" },
    field("서버 주소", urlInput, "그 컴퓨터의 서버 → 공유에서 복사합니다."),
    field("서버 token", tokenInput, "그 서버가 token을 요구할 때만 넣습니다. 채팅에 붙여 넣지 말고 여기에만 넣으세요."),
    h("details", { class: "fold" }, h("summary", {}, "Access 서비스 토큰"),
      h("p", { class: "hint" }, "직접 만든 Cloudflare Access 뒤의 서버일 때만 넣습니다."),
      field("서비스 토큰 ID", accessId),
      field("서비스 토큰 비밀", accessSecret)));
  const pick = (choice) => () => {
    draft.server = choice;
    remoteFields.hidden = choice !== "remote";
    if (choice === "remote") urlInput.focus();
    onPick?.(choice);
  };
  const rows = choices.map((choice) => {
    if (choice === "here") {
      return localUrl
        ? opt({ name: "server", value: "here", checked: draft.server === "here", onChange: pick("here"),
          title: ["이 컴퓨터 서버 ", h("span", { class: "mono muted" }, localUrl.replace(/^https?:\/\//, ""))],
          end: current === "here" ? tag("지금 쌓는 중", "ok") : tag("이 컴퓨터에 있음") })
        : opt({ name: "server", value: "here", checked: draft.server === "here", onChange: pick("here"), title: "이 컴퓨터에 새로 만들기", sub: NEW_SERVER_SUB });
    }
    if (choice === "remote") {
      return opt({ name: "server", value: "remote", checked: draft.server === "remote", onChange: pick("remote"),
        title: "다른 컴퓨터의 내 서버", sub: "그 컴퓨터에서 만든 서버의 주소를 넣습니다.",
        end: current === "remote" ? tag("지금 쌓는 중", "ok") : null, extra: remoteFields });
    }
    return opt({ name: "server", value: "none", checked: draft.server === "none", onChange: pick("none"),
      title: "쌓지 않기", sub: "내 대화는 어디에도 쌓지 않고, 팀원 기억에 묻기만 합니다." });
  });
  const peerInput = h("input", { class: "input mono", value: draft.userPeer, placeholder: "예: minji", pattern: "[A-Za-z0-9_\\-]+", oninput: (event) => { draft.userPeer = event.target.value; } });
  const extra = others ? otherServers(draft, company) : null;
  const body = h("div", {},
    h("h3", {}, "어디에 쌓을까요?"),
    lead ? h("p", { class: "lead" }, lead) : null,
    h("div", { class: "label" }, "내 기억 서버"),
    opts(...rows),
    peer ? field("내 peer 이름", peerInput, "영문·숫자·밑줄(_)·하이픈(-)만 씁니다. 내 모든 컴퓨터에서 같은 이름을 쓰세요.") : null,
    extra?.body || null);
  return {
    body,
    check() {
      if (draft.server === "remote") {
        try {
          const url = new URL(draft.remoteUrl.trim());
          if (!/^https?:$/.test(url.protocol)) throw new Error();
        } catch {
          urlInput.focus();
          return "다른 컴퓨터 서버의 주소를 http:// 나 https:// 로 시작하게 넣으세요.";
        }
        if (Boolean(draft.accessClientId.trim()) !== Boolean(draft.accessClientSecret.trim())) return "Access 서비스 토큰은 ID와 비밀을 함께 넣어야 합니다.";
      }
      if (peer && draft.server !== "none" && !PEER.test(draft.userPeer.trim())) {
        peerInput.focus();
        return "peer 이름을 영문·숫자·밑줄(_)·하이픈(-)으로 넣으세요.";
      }
      return extra ? extra.check() : null;
    },
  };
}

/**
 * 함께 쌓을 서버: other servers that also take the folders chosen for them. In a team,
 * the company server (`company`, from the team hub) is one tick away: asking its
 * owner first, then taking the folders chosen for it once approved.
 */
function otherServers(draft, company) {
  const input = (key, attributes = {}) => h("input", { class: "input mono", autocomplete: "off", spellcheck: "false", value: draft.extra[key], oninput: (event) => { draft.extra[key] = event.target.value; }, ...attributes });
  const url = input("url", { type: "url", placeholder: "https://memory.company.example" });
  const fields = h("div", { class: "subfields", hidden: !draft.extra.on },
    field("이름", input("label", { class: "input", placeholder: "예: 회사" })),
    field("서버 주소", url),
    field("서버 token", input("apiToken", { type: "password" }), "그 서버를 둔 컴퓨터의 서버 → 공유에서 복사합니다. 회사 서버면 관리자에게 받습니다."),
    h("details", { class: "fold" }, h("summary", {}, "Access 서비스 토큰"),
      field("서비스 토큰 ID", input("accessClientId", { type: "password" })),
      field("서비스 토큰 비밀", input("accessClientSecret", { type: "password" }))));
  const rows = draft.targets.map((target) => (target.team && !target.wasEnabled
    // Asked, not approved yet: nothing to tick until its owner answers.
    ? opt({
      type: "checkbox",
      name: "targets",
      value: target.id,
      checked: false,
      disabled: true,
      title: [target.label, " ", h("span", { class: "mono muted" }, String(target.url).replace(/^https?:\/\//, ""))],
      end: tag("승인 기다리는 중", "warn"),
    })
    : opt({
      type: "checkbox",
      name: "targets",
      value: target.id,
      checked: target.enabled,
      title: [target.label, " ", h("span", { class: "mono muted" }, String(target.url).replace(/^https?:\/\//, ""))],
      sub: `폴더 ${number(target.folders.size)}개를 이 서버에도 쌓습니다`,
      onChange: (on) => { target.enabled = on; },
    })));
  const asked = company && draft.targets.some((target) => target.team && String(target.url).replace(/^https?:\/\//, "") === company.host);
  if (company && !asked) {
    if (!draft.company) draft.company = { on: false, host: company.host, folders: new Set() };
    rows.unshift(opt({
      type: "checkbox",
      name: "company",
      value: company.host,
      checked: draft.company.on,
      title: ["회사 ", h("span", { class: "mono muted" }, company.host)],
      end: tag("승인 요청", "warn"),
      onChange: (on) => { draft.company.on = on; },
    }));
  }
  rows.push(opt({
    type: "checkbox",
    name: "targets",
    value: "",
    checked: draft.extra.on,
    title: "다른 서버 더하기",
    sub: "고른 폴더의 대화만 그 서버에도 쌓습니다.",
    extra: fields,
    onChange: (on) => { draft.extra.on = on; fields.hidden = !on; if (on) url.focus(); },
  }));
  return {
    body: [h("div", { class: "label" }, "함께 쌓을 서버"), opts(...rows)],
    check() {
      if (!draft.extra.on) return null;
      try {
        if (new URL(draft.extra.url.trim()).protocol !== "https:" && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(draft.extra.url.trim())) throw new Error();
      } catch {
        url.focus();
        return "더할 서버의 주소를 https:// 로 시작하게 넣으세요.";
      }
      if (Boolean(draft.extra.accessClientId.trim()) !== Boolean(draft.extra.accessClientSecret.trim())) return "Access 서비스 토큰은 ID와 비밀을 함께 넣어야 합니다.";
      return null;
    },
  };
}

// ── 에이전트 ─────────────────────────────────────────────

/** The agents found on this computer, ticked to collect. */
export function agentsStep(draft) {
  const list = h("div", {}, h("div", { class: "opts" }, h("div", { class: "opt" }, spinner(), h("span", { class: "muted" }, "이 컴퓨터의 에이전트를 찾는 중…"))));
  let found = null;
  detectAgents().then((detect) => {
    found = Object.keys(AGENTS).filter((name) => detect?.agents?.[name]?.detected);
    if (!draft.agents) draft.agents = new Set(found);
    if (!found.length) {
      clear(list, notice("warn", "이 컴퓨터에서 Claude Code나 Codex를 찾지 못했습니다. 설치한 뒤 이 창을 다시 여세요."));
      return;
    }
    clear(list, opts(...found.map((name) => opt({
      type: "checkbox",
      name: "agents",
      value: name,
      checked: draft.agents.has(name),
      title: [h("span", { class: `src ${name}` }, AGENT_LETTERS[name]), AGENTS[name]],
      sub: h("span", { class: "mono" }, AGENT_FOLDERS[name]),
      end: detect.agents[name].plugin && !detect.agents[name].plugin.enabled && detect.agents[name].plugin.installed ? tag("플러그인 꺼짐", "warn") : null,
      onChange: (on) => { if (on) draft.agents.add(name); else draft.agents.delete(name); },
    }))));
  });
  return {
    body: h("div", {},
      h("h3", {}, "어느 에이전트의 대화를 수집할까요?"),
      h("p", { class: "lead" }, "이 컴퓨터에서 찾은 에이전트입니다."),
      list),
    check() {
      if (found && !found.length) return "Claude Code나 Codex를 설치한 뒤 다시 여세요.";
      if (!draft.agents?.size) return "대화를 수집할 에이전트를 하나 이상 고르세요.";
      return null;
    },
  };
}

// ── 프로젝트 ─────────────────────────────────────────────

/** The folders that hold the chosen agents' conversations, with how many each holds. */
function chosenProjects(projects, agents) {
  return projects
    .map((project) => ({ ...project, count: [...agents].reduce((sum, name) => sum + Number(project.agents?.[name] || 0), 0) }))
    .filter((project) => project.count > 0)
    .map((project) => ({ path: project.path, name: project.name, count: project.count, display: shortPath(project.path), temp: Boolean(project.temp) }));
}

/**
 * The folders the chosen places' conversations ran in (`past overview`): those of
 * this computer, and those only the backup store holds, from other computers.
 */
function overviewProjects(projects) {
  return projects.map((project) => ({
    path: project.path,
    name: project.name,
    count: project.count,
    display: project.display || shortPath(project.path),
    temp: Boolean(project.temp),
    tag: project.storeOnly ? "백업 저장소에만" : null,
  }));
}

/**
 * The folders ticked when the projects step opens: what the saved choice takes, a
 * folder it never named going by its rest. A computer that never chose collects
 * every folder, at first setup too: the person clears what they leave out.
 */
export function tickedFolders(projects, saved) {
  const take = new Set(saved?.take || []);
  const skip = new Set(saved?.skip || []);
  return new Set(projects.filter((project) => {
    if (!saved) return true;
    if (skip.has(project.path)) return false;
    if (take.has(project.path)) return true;
    return saved.rest !== "skip";
  }).map((project) => project.path));
}

/**
 * The server the projects step counts against: the one being chosen, with what was
 * typed for it; `newServer` for one this setup makes, which holds nothing yet, and
 * `url` for one the setup reaches by another address (a team's server).
 */
export function draftServer(draft, context, { newServer = false, url = null } = {}) {
  if (newServer) return { newServer: true };
  const body = setupBody(draft, context);
  const server = { honchoUrl: url || body.honchoUrl };
  for (const key of ["apiToken", "accessClientId", "accessClientSecret", "workspace"]) if (body[key]) server[key] = body[key];
  return server;
}

/**
 * The 프로젝트 폴더 line in 설정 as [the folders collected, what happens to new ones]:
 * the folders taken by name, never the ones left out, which can run to hundreds.
 * With `automation`, the second part says 자동 실행 대화도 수집 too.
 */
export function folderSummary(collect, automation = false) {
  const [folders, rest] = foldersAndRest(collect);
  return [folders, automation ? `${rest} · 자동 실행 대화도 수집` : rest];
}

function foldersAndRest(collect) {
  const names = (folders) => {
    if (!folders?.length) return "없음";
    const base = (folder) => shortPath(folder).split(/[\\/]/).pop() || shortPath(folder);
    const named = new Map();
    for (const folder of folders) named.set(base(folder), (named.get(base(folder)) || 0) + 1);
    // Two folders of one name (~/dev/jarvis and another computer's C:\dev\jarvis) show their paths.
    const shown = folders.slice(0, 6).map((folder) => (named.get(base(folder)) > 1 ? shortPath(folder) : base(folder)));
    return shown.join(" · ") + (folders.length > shown.length ? ` 외 ${folders.length - shown.length}개` : "");
  };
  if (!collect) return ["모든 폴더", "새로 생기는 폴더도 수집"];
  if (collect.rest === "skip") return [names(collect.take), "고른 폴더만 수집"];
  return [collect.skip?.length ? names(collect.take) : "모든 폴더", "새로 생기는 폴더도 수집"];
}

/**
 * Which project folders' conversations to collect. A folder ticked or not is kept
 * as taken or skipped; 새로 생기는 프로젝트 폴더도 수집 is what happens to the rest,
 * and 자동 실행 대화도 수집 whether conversations no person took part in go too.
 * The folders are those the chosen places' conversations ran in, and under them
 * what would go into the server (lib/past.js). `server` is the one to count against
 * (draftServer).
 */
export function projectsStep(draft, context, { edit = false, server = null } = {}) {
  const box = h("div", {}, h("div", { class: "pt" }, h("div", { class: "pr" }, spinner(), h("span", { class: "muted" }, "대화가 있는 폴더를 찾는 중…"))));
  const summary = h("div", {});
  const restBox = h("input", { type: "checkbox", checked: draft.rest === "take" });
  const autoBox = h("input", { type: "checkbox", checked: Boolean(draft.automation) });
  const autoCount = h("span", { class: "muted" });
  let overview = null;
  // The places chosen could not be read: nothing goes on until they are.
  let unread = null;
  const drawSummary = () => {
    if (!overview || !draft.checked) { clear(summary); return; }
    const totals = overviewTotals(overview, { checked: draft.checked, automation: draft.automation, rest: draft.rest });
    clear(summary, pastSummary(draft, overview, totals, { edit, here: draft.server === "here" }));
  };
  restBox.addEventListener("change", () => { draft.rest = restBox.checked ? "take" : "skip"; drawSummary(); });
  autoBox.addEventListener("change", () => { draft.automation = autoBox.checked; drawSummary(); });
  const servers = activeTargets(draft);
  const agents = draft.agents || new Set(Object.keys(AGENTS));
  const draw = (projects, automation) => {
    draft.projects = projects;
    autoCount.textContent = automation ? `${number(automation)}개` : "";
    if (!draft.checked) draft.checked = tickedFolders(draft.projects, context?.collect || null);
    if (!draft.open) draft.open = openAtFirst(draft.projects);
    if (!draft.projects.length) {
      draft.rest = "take";
      restBox.checked = true;
      clear(box, h("div", { class: "pt" }, h("div", { class: "list-empty" }, "아직 대화가 있는 폴더가 없습니다. 앞으로 생기는 폴더의 대화를 수집합니다.")));
    } else if (servers.length) {
      clear(box, matrix(draft, servers, { autoBox, autoCount, restBox }, drawSummary));
    } else {
      clear(box, folderTreeTable(draft.projects, draft.checked, { open: draft.open, onChange: drawSummary }));
    }
    drawSummary();
  };
  loadOverview(draft, server || draftServer(draft, context)).then(async (result) => {
    if (result && result.ok !== false) {
      overview = result;
      draw(overviewProjects(result.projects || []), Number(result.automation?.count || 0));
      return;
    }
    // The folders this computer holds, without the counts, when the places cannot be read.
    if (result?.notRead) unread = result.error;
    const list = await projectList();
    draw(chosenProjects(list?.projects || [], agents), [...agents].reduce((sum, name) => sum + Number(list?.automation?.[name] || 0), 0));
    clear(summary, notice("warn", result?.notRead ? `${result.error} 지난 대화 단계에서 확인하세요.` : "쌓을 대화를 세지 못했습니다. 적용하면 고른 폴더의 지난 대화를 시작한 시각순으로 쌓습니다."));
  });
  return {
    body: h("div", {},
      h("h3", {}, "어느 프로젝트 폴더의 대화를 수집할까요?"),
      h("p", { class: "lead" }, servers.length ? "서버마다 쌓을 폴더를 고르세요. 고른 서버마다 칸이 하나씩 생깁니다." : "고른 곳의 대화가 있는 폴더입니다."),
      box,
      servers.length ? null : h("label", { class: "row2" }, restBox, "새로 생기는 프로젝트 폴더도 수집"),
      servers.length ? null : h("label", { class: "row2" }, autoBox, "자동 실행 대화도 수집", autoCount),
      summary),
    check() {
      if (!draft.projects) return "폴더를 찾는 중입니다. 잠시 뒤 다시 누르세요.";
      if (unread) return `${unread} 지난 대화 단계에서 확인하세요.`;
      if (!edit && draft.projects.length && !draft.checked.size) return "수집할 폴더를 하나 이상 고르세요.";
      if (draft.rest === "skip" && !draft.checked.size) return "수집할 폴더를 하나 이상 고르거나, 새로 생기는 프로젝트 폴더도 수집을 켜세요.";
      const empty = servers.find((target) => !target.folders.size);
      if (empty) return `${empty.label}에 쌓을 폴더를 하나 이상 고르거나, 서버 단계에서 그 서버를 끄세요.`;
      return null;
    },
  };
}

/**
 * The folders as a tree with a column for each server that takes them: the own
 * server's column is what this computer collects, each other server's the folders it
 * also gets. 새로 생기는 폴더 and 자동 실행 대화 are the own server's alone: another
 * server takes only the folders named for it, and only the person's conversations.
 */
function matrix(draft, servers, { restBox, autoBox, autoCount }, onChange) {
  const columns = [{ label: "내 서버", folders: draft.checked, own: true }, ...servers];
  const template = { gridTemplateColumns: `minmax(0, 1fr) 70px ${columns.map(() => "96px").join(" ")}` };
  const rows = treeRows(draft.projects, columns, { open: draft.open, template, onChange });
  return h("div", { class: "pt" },
    h("div", { class: "pr m g", style: template }, h("span", {}), h("span", {}), h("span", { class: "gl" }, "쌓을 곳")),
    h("div", { class: "pr m h", style: template }, h("span", {}, "폴더"), h("span", { class: "c" }, "대화"),
      columns.map((column) => h("span", { class: "ch" }, column.label, column.company ? [h("br"), tag("승인 요청", "warn")] : null))),
    rows.element,
    ownRow(template, columns, "새로 생기는 폴더", restBox),
    ownRow(template, columns, "자동 실행 대화", autoBox, autoCount));
}

/** A row of the server table only the own server's column takes. */
function ownRow(template, columns, label, box, hint = null) {
  return h("div", { class: "pr m", style: template }, h("span", { class: "pn" }, h("b", {}, label), hint ? [" ", hint] : null), h("span", {}),
    columns.map((column) => h("span", { class: "pr-c" }, column.own ? box : h("input", { type: "checkbox", disabled: true, "aria-label": `${label} → ${column.label}` }))));
}

/** A short id for a server being added: it names a folder on this computer. */
function targetId(label, taken) {
  const ascii = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const base = /회사/.test(label) ? "company" : ascii || "server";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * The other servers as chosen: turned on or off, their folders changed, one added.
 * Each server that got folders it did not have is sent their past conversations.
 * Resolves the problems, none when all went.
 */
export async function applyTargets(draft) {
  const problems = [];
  const backfill = [];
  const same = (left, right) => left.size === right.size && [...left].every((item) => right.has(item));
  for (const target of draft.targets) {
    const changes = {};
    if (target.enabled !== target.wasEnabled) changes.enabled = target.enabled;
    if (target.enabled && !same(target.folders, target.was)) changes.folders = [...target.folders];
    if (!Object.keys(changes).length) continue;
    const result = await post("/api/targets/set", { id: target.id, ...changes }).catch((error) => ({ ok: false, error: error.message }));
    if (result.ok === false) { problems.push(`${target.label}: ${[...(result.issues || []), result.error].filter(Boolean).map(explainWarning).join(" ")}`); continue; }
    if ([...target.folders].some((folder) => !target.was.has(folder))) backfill.push(target.id);
  }
  if (draft.extra.on) {
    const label = draft.extra.label.trim() || "회사";
    const id = targetId(label, new Set(draft.targets.map((target) => target.id)));
    const body = { id, label, url: draft.extra.url.trim(), folders: [...draft.extra.folders] };
    for (const key of ["apiToken", "accessClientId", "accessClientSecret"]) if (draft.extra[key].trim()) body[key] = draft.extra[key].trim();
    const result = await post("/api/targets/add", body).catch((error) => ({ ok: false, error: error.message }));
    if (result.ok) backfill.push(id);
    else problems.push(`${label}: ${[...(result.issues || []), result.error].filter(Boolean).map(explainWarning).join(" ")}`);
  }
  // Each runs in the CLI on its own; the window need not wait for them.
  for (const id of backfill) post("/api/targets/backfill", { id }).catch(() => {});
  return problems;
}

/** The folder choice as `setup` options: what is ticked, what is not, the rest, and 자동 실행 대화. */
export function folderOptions(draft) {
  if (!draft.projects) return {};
  const take = draft.projects.filter((project) => draft.checked.has(project.path)).map((project) => project.path);
  const skip = draft.projects.filter((project) => !draft.checked.has(project.path)).map((project) => project.path);
  const automation = draft.automation ? "take" : "skip";
  if (!skip.length && draft.rest === "take") return { allFolders: true, automation };
  return {
    ...(take.length ? { takeFolders: take.join(",") } : {}),
    ...(skip.length ? { skipFolders: skip.join(",") } : {}),
    restFolders: draft.rest,
    automation,
  };
}

/**
 * The draft as the setup routes read it. `localUrl` is this computer's server,
 * which first setup knows only once it has made it.
 */
export function setupBody(draft, context, localUrl = context?.localServer?.apiUrl || "http://127.0.0.1:8001") {
  const body = { honchoUrl: draft.server === "remote" ? draft.remoteUrl.trim() : localUrl };
  if (draft.server === "remote") {
    for (const name of ["apiToken", "accessClientId", "accessClientSecret"]) {
      if (draft[name].trim()) body[name] = draft[name].trim();
    }
  }
  if (draft.userPeer.trim()) body.userPeer = draft.userPeer.trim();
  if (draft.workspace && draft.workspace !== "memory") body.workspace = draft.workspace;
  body.agents = [...(draft.agents || [])].join(",") || "none";
  return { ...body, ...folderOptions(draft) };
}

// ── What setup said, in the words the screens use ────────

const WARNINGS = [
  [/(\w+) collection is enabled, but the Honcho Agent Bridge plugin is not installed in \w+ and the \w+ command was not found; install it by running (.+), then (.+)$/, (m) => `${m[1] === "codex" ? "Codex" : "Claude Code"}: 터미널에서 차례로 실행하세요. ${m[2]} → ${m[3]}`],
  [/(\w+) collection is enabled, but the Honcho Agent Bridge plugin was not detected as enabled in (\w+)/, (m) => `${m[2] === "codex" ? "Codex" : "Claude Code"}에 팀 메모리 플러그인이 켜져 있지 않습니다. 플러그인을 켜야 대화가 모입니다.`],
  [/A Honcho server answers at (\S+), but it is not the server this plugin installed/, (m) => `${m[1]}에 기억 서버가 있지만 이 앱이 설치한 서버는 아닙니다. 내 서버가 맞는지 확인하세요.`],
  [/requires an API token/, () => "이 서버는 token이 필요합니다. 서버 token 칸을 채우세요."],
  [/is behind Cloudflare Access and refused this computer/, () => "Cloudflare Access가 이 컴퓨터를 막았습니다. Access 서비스 토큰을 열고 그 서버의 서비스 토큰 ID와 비밀을 넣으세요."],
  [/Cloudflare Access (?:client id|service token).*(?:both|together)/i, () => "Access 서비스 토큰은 ID와 비밀을 함께 넣어야 합니다."],
  [/rejected the API token/, () => "서버가 이 token을 받지 않습니다. 서버를 둔 컴퓨터의 token이 맞는지 확인하세요."],
  [/at least one detected agent must be selected/, () => "대화를 수집할 에이전트를 하나 이상 고르세요. 이 컴퓨터에 설치된 Claude Code나 Codex만 고를 수 있습니다."],
  [/The API token saved for (\S+) is not carried to (\S+)/, (m) => `${m[1]}에 쓰던 token은 ${m[2]}로 옮기지 않습니다. 새 서버의 token을 넣으세요.`],
  [/This computer has a Honcho server installed at (\S+), but collection goes to (\S+)\./, (m) => `이 컴퓨터에 ${m[1]} 기억 서버가 설치돼 있는데, 대화는 ${m[2]}에 쌓이게 돼 있습니다.`],
  [/Honcho URL is invalid/, () => "기억 서버 주소가 올바르지 않습니다."],
  [/Honcho URL must not contain credentials/, () => "기억 서버 주소에 아이디·비밀번호·물음표 뒤 값을 넣지 마세요. token은 서버 token 칸에 넣습니다."],
  [/(\S+) does not exist on this computer; conversations there are sent once it does/, (m) => `${shortPath(m[1])} 폴더가 지금은 없습니다. 생기면 그때부터 수집합니다.`],
  [/user peer id is required/, () => "peer 이름을 넣으세요."],
  // 새 팀 만들기 (team make): what Cloudflare refused, in the words of its token screen.
  [/The Cloudflare API token is needed/, () => "Cloudflare API token을 넣으세요."],
  [/The API token cannot see any zone/, () => "이 Cloudflare API token이 보는 zone이 없습니다. token에 쓸 zone의 Zone: Read와 DNS: Edit 권한을 주세요."],
  [/The API token cannot see a zone named (\S+);/, (m) => `이 Cloudflare API token은 ${m[1]} zone을 보지 못합니다. zone 이름과 token의 Zone: Read 권한을 확인하세요.`],
  [/Zero Trust has no Google login yet/, () => "Cloudflare Zero Trust에 Google 로그인이 없습니다. Zero Trust의 Settings → Authentication → Login methods에서 Google을 더한 뒤 다시 누르세요."],
  [/\(the API token needs (.+)\)$/, (m) => `Cloudflare API token에 ${m[1].replace(/,? and /g, ", ").replace(/ on the zone$/, "")} 권한이 없습니다. Cloudflare에서 token에 이 권한을 더한 뒤 다시 누르세요.`],
];

export function explainWarning(text) {
  for (const [pattern, render] of WARNINGS) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

/** What a plan or an apply refused or warned about, as notices; null when nothing. */
export function planProblems(result) {
  const issues = result?.issues || (result?.error ? [result.error] : []);
  const warnings = result?.warnings || [];
  if (!issues.length && !warnings.length) return null;
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" } },
    issues.length ? notice("bad", h("b", {}, "이대로는 설정할 수 없습니다."), h("ul", {}, issues.map((issue) => h("li", {}, explainWarning(issue))))) : null,
    warnings.length ? notice("warn", h("b", {}, "확인할 것"), h("ul", {}, warnings.map((warning) => h("li", {}, explainWarning(warning))))) : null,
    details("자세한 결과", result));
}

/** Plans first, so what setup refuses is shown before anything changes; then applies. */
export async function applySetup(body) {
  const plan = await post("/api/setup/plan", body);
  if (!plan.ready) return { ok: false, stage: "plan", result: plan };
  const done = await post("/api/setup/apply", body);
  return { ok: Boolean(done.ok), stage: "apply", result: done };
}

/**
 * What to do in each agent once setup has applied: approve the Codex hook, reload
 * Claude Code's plugins, or run the plugin install by hand when it could not.
 */
export function agentTodo(done, agents) {
  const manual = (name) => (done?.nextSteps || []).find((step) => step.agent === name && step.action === "install-plugin");
  const items = [];
  for (const name of Object.keys(AGENTS)) {
    if (!agents.has(name)) continue;
    const commands = manual(name)?.commands || [];
    if (commands.length) {
      items.push({ title: AGENTS[name], text: ["터미널에서 차례로 실행하세요. ", commands.map((command, index) => [index ? " → " : "", h("span", { class: "mono" }, command)])] });
    } else if (name === "claude") {
      items.push({ title: "Claude Code", text: ["열린 세션에 ", h("span", { class: "mono" }, "/reload-plugins"), " 를 입력하세요."] });
    } else {
      items.push({ title: "Codex", text: "새 세션을 열고 훅을 승인하세요." });
    }
  }
  return items;
}
