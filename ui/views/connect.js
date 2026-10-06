// 연결: what this computer is connected to, as four tasks. #/connect lists them
// with where each stands; each opens its own page (#/connect/<task>). 대화 보내기
// is a few steps over the one setup form in index.html, sent whole at the end, so
// the fields the CLI reads stay the ones the tests check. 팀원 기억 연결 puts a
// teammate's server into Claude Code and Codex as a remote MCP server (team-<name>);
// each client then logs in by itself, so no token passes through this page. Each
// action is the same CLI command a terminal would run.
import { cli, get, post } from "../lib/api.js";
import { h, clear, $ } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { ago, number } from "../lib/format.js";
import { app, go, loadContext, me, refreshStatus, savePrefs, workspace } from "../lib/state.js";
import { button, busy, confirmSheet, details, errorNotice, notice, pageHead, spinner, tag, toast } from "../lib/ui.js";

const OPERATIONS = {
  "install-runtime": () => "수집 프로그램을 이 컴퓨터에 설치합니다.",
  "merge-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에 대화가 끝날 때마다 모으는 훅을 넣습니다.`,
  "use-plugin-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}는 플러그인에 든 훅을 씁니다.`,
  "remove-legacy-managed-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에 예전 방식으로 넣었던 훅을 뺍니다.`,
  "remove-managed-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에서는 대화를 모으지 않으니 넣어 둔 수집 훅이 있으면 뺍니다.`,
  "remove-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에서 수집 훅을 뺍니다.`,
  "write-config": () => "이 컴퓨터의 수집 설정을 저장합니다.",
  "write-mcp-tool-defaults": (op) => `기억을 바꾸는 MCP 도구 ${op.disabled?.length || 0}개를 꺼 둔 채로 시작합니다.`,
  "install-plugin": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에 팀 메모리 플러그인을 설치합니다.`,
};

const WARNINGS = [
  [/(\w+) collection is enabled, but the Honcho Agent Bridge plugin is not installed in \w+ and the \w+ command was not found; install it by running (.+), then (.+)$/, (m) => `${m[1] === "codex" ? "Codex" : "Claude Code"}: 터미널에서 차례로 실행하세요. ${m[2]} → ${m[3]}`],
  [/(\w+) collection is enabled, but the Honcho Agent Bridge plugin was not detected as enabled in (\w+)/, (m) => `${m[2] === "codex" ? "Codex" : "Claude Code"}에 팀 메모리 플러그인이 켜져 있지 않습니다. 플러그인을 켜야 대화가 모입니다.`],
  [/A Honcho server answers at (\S+), but it is not the server this plugin installed/, (m) => `${m[1]}에 기억 서버가 있지만 이 앱이 설치한 서버는 아닙니다. 내 서버가 맞는지 확인하세요.`],
  [/requires an API token/, () => "이 서버는 토큰이 필요합니다. 서버 토큰 칸을 채우세요."],
  [/is behind Cloudflare Access and refused this computer/, () => "Cloudflare Access가 이 컴퓨터를 막았습니다. Cloudflare Access 서비스 토큰을 열고 그 서버의 서비스 토큰 ID와 비밀을 넣으세요."],
  [/Cloudflare Access (?:client id|service token).*(?:both|together)/i, () => "Access 서비스 토큰은 ID와 비밀을 함께 넣어야 합니다."],
  [/rejected the API token/, () => "서버가 이 토큰을 받지 않습니다. 서버를 둔 컴퓨터의 토큰이 맞는지 확인하세요."],
  [/at least one detected agent must be selected/, () => "대화를 보낼 에이전트를 하나 이상 고르세요. 이 컴퓨터에 설치된 Claude Code나 Codex만 고를 수 있습니다."],
  [/The API token saved for (\S+) is not carried to (\S+)/, (m) => `${m[1]}에 쓰던 토큰은 ${m[2]}로 옮기지 않습니다. 새 서버의 토큰을 넣으세요.`],
  [/This computer has a Honcho server installed at (\S+), but collection goes to (\S+)\./, (m) => `이 컴퓨터에 ${m[1]} 기억 서버가 설치돼 있는데, 대화는 ${m[2]}로 보내게 돼 있습니다. 이 컴퓨터 서버로 모으려면 첫 단계에서 이 컴퓨터 서버를 고르세요.`],
  [/Honcho URL is invalid/, () => "기억 서버 주소가 올바르지 않습니다."],
  [/Honcho URL must not contain credentials/, () => "기억 서버 주소에 아이디·비밀번호·물음표 뒤 값을 넣지 마세요. 토큰은 서버 토큰 칸에 넣습니다."],
];

function explainWarning(text) {
  for (const [pattern, render] of WARNINGS) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

function formBody(form) {
  const data = new FormData(form);
  const body = {};
  for (const [key, value] of data.entries()) {
    if (key === "agents") continue;
    if (String(value).trim()) body[key] = String(value).trim();
  }
  body.agents = data.getAll("agents").join(",") || "none";
  return body;
}

const AGENTS = { claude: "Claude Code", codex: "Codex" };
const agentNames = (agents) => ["claude", "codex"].filter((name) => agents?.[name]).map((name) => AGENTS[name]).join("·");

/** Two addresses for the same server, whichever way the loopback is written. */
function sameServer(a, b) {
  if (!a || !b) return false;
  try {
    const origin = (value) => new URL(value).origin.replace("//localhost", "//127.0.0.1");
    return origin(a) === origin(b);
  } catch {
    return false;
  }
}

const TASKS = [
  { key: "collect", title: "대화 보내기", why: "이 컴퓨터의 Claude Code·Codex 대화를 내 기억 서버로 모으고, 에이전트가 내 기억을 꺼내 쓰게 합니다." },
  { key: "targets", title: "회사 서버에도 보내기", why: "정한 폴더에서 한 대화만 회사 서버 같은 다른 기억 서버에도 보냅니다. 내 서버에는 그대로 모두 갑니다." },
  { key: "share", title: "팀원 기억 연결", why: "팀원이 공유한 기억을 Claude Code와 Codex에 원격 MCP 서버로 연결합니다. 에이전트는 원문을 보지 않고 chat으로 답만 받습니다." },
  { key: "import", title: "ChatGPT 기록 가져오기", why: "ChatGPT에서 내보낸 대화를 내 기억 서버에 넣습니다. 한 번 해 두면 됩니다." },
];

// ── The landing: four tasks and where each stands ─────────

function taskState(key) {
  const context = app.context || {};
  if (key === "collect") {
    return context.configured
      ? {
        label: "켜짐",
        kind: "ok",
        detail: [sameServer(context.honcho?.url, context.localServer?.apiUrl) ? "이 컴퓨터 서버" : context.honcho?.url, agentNames(context.agents) || "에이전트 없음"].filter(Boolean).join(" · "),
      }
      : { label: "꺼짐", detail: "아직 설정하지 않았습니다" };
  }
  if (key === "targets") {
    const targets = context.targets || [];
    if (!targets.length) return { label: "없음", detail: context.configured ? "" : "대화 보내기를 켠 뒤에 씁니다" };
    const pending = targets.reduce((sum, target) => sum + (target.pending || 0), 0);
    return {
      label: `${targets.length}개`,
      kind: "ok",
      detail: [targets.map((target) => target.label || target.id).join(", "), pending ? `기다리는 대화 ${number(pending)}` : null].filter(Boolean).join(" · "),
    };
  }
  if (key === "share") {
    const connected = Number(context.teamMemory?.connected || 0);
    return connected
      ? { label: `${connected}곳`, kind: "ok", detail: "Claude Code·Codex에 연결됨" }
      : { label: "안 됨", detail: context.oldBridge ? "예전 방식 연결이 남아 있습니다" : "" };
  }
  const last = app.prefs.chatgptImport;
  return last?.at
    ? { label: "가져옴", detail: `${ago(last.at)} · 새 메시지 ${number(last.newMessages || 0)}개` }
    : { label: "", detail: "이 앱에서 가져온 적 없음" };
}

function landing(page) {
  const stateOf = new Map();
  const rows = TASKS.map((task) => {
    const state = taskState(task.key);
    const detail = h("small", {}, state.detail);
    stateOf.set(task.key, { detail, state });
    return h("a", { class: "task", href: `#/connect/${task.key}` },
      h("div", { class: "task-main" }, h("b", {}, task.title), h("span", { class: "why" }, task.why)),
      h("div", { class: "task-state" }, state.label ? tag(state.label, state.kind || "") : null, detail),
      icon("arrow"),
    );
  });
  page.append(
    pageHead({ title: "연결", subtitle: "이 컴퓨터가 무엇과 이어질지 정합니다. 필요한 것만 켜면 됩니다." }),
    h("div", { class: "page-body" }, h("div", { class: "pad" }, h("nav", { class: "tasks", "aria-label": "연결 작업" }, rows))),
  );
  // Not imported from this browser: say how many ChatGPT conversations the memory holds.
  const chatgpt = stateOf.get("import");
  if (!app.prefs.chatgptImport?.at && app.context?.configured) {
    get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1", source: "chatgpt" })}`)
      .then((result) => { if (result?.total) chatgpt.detail.textContent = `기억에 ChatGPT 대화 ${number(result.total)}개`; })
      .catch(() => {});
  }
}

function subHead(task) {
  return h("header", { class: "page-head" },
    h("div", {},
      h("a", { class: "back-link", href: "#/connect" }, icon("back"), h("span", {}, "연결")),
      h("h1", {}, task.title),
      h("p", {}, task.why),
    ),
  );
}

// ── 대화 보내기 ───────────────────────────────────────────

function checkText(check) {
  const agent = (name) => (name === "codex" ? "Codex" : "Claude Code");
  const plugin = /^(codex|claude)-plugin$/.exec(check.name);
  if (plugin) return check.installed
    ? `${agent(plugin[1])}에 팀 메모리 플러그인이 설치돼 있지만 꺼져 있습니다. 켜야 대화가 모입니다.`
    : `${agent(plugin[1])}에 팀 메모리 플러그인이 없습니다. 플러그인을 설치하고 켜세요.`;
  if (check.name === "claude-hook") return "Claude Code는 플러그인에 든 훅으로 모읍니다. 플러그인을 켜면 함께 켜집니다.";
  const hook = /^(codex|claude)-hook$/.exec(check.name);
  if (hook) return `${agent(hook[1])}에 대화 수집 훅이 없거나 예전 것입니다. 설정을 다시 적용하세요.`;
  if (check.name === "configuration") return "수집 설정이 없습니다.";
  if (check.name === "runtime") return `수집 프로그램이 ${check.actualVersion ? `예전 판(${check.actualVersion})` : "설치돼 있지 않습니다"}. 설정을 다시 적용하면 새로 설치합니다.`;
  if (check.name === "honcho-health" && check.code === "cloudflare-access") return "Cloudflare Access가 이 컴퓨터를 막았습니다. 그 서버의 Access 서비스 토큰을 넣으세요.";
  if (check.name === "honcho-health" && check.status === 401) return "기억 서버가 토큰을 받지 않습니다. 서버를 둔 컴퓨터에서 서버 토큰을 다시 복사해 넣으세요.";
  if (check.name === "honcho-health") return "기억 서버가 답하지 않습니다.";
  if (check.name === "honcho-workspaces") return "기억 서버에 닿았지만 workspace를 읽지 못했습니다. 토큰이 맞는지 확인하세요.";
  if (check.name === "mcp") return "에이전트용 기억 도구(MCP)가 시작되지 않습니다.";
  return `${check.name}: ${check.error || check.state || "문제 있음"}`;
}

function planView(plan) {
  const issues = plan.issues || (plan.error ? [plan.error] : []);
  return h("div", { class: "plan" },
    issues.length ? notice("bad", h("b", {}, "이대로는 설정할 수 없습니다."), h("ul", {}, issues.map((issue) => h("li", {}, explainWarning(issue))))) : null,
    (plan.warnings || []).length ? notice("warn", h("b", {}, "확인할 것"), h("ul", {}, plan.warnings.map((warning) => h("li", {}, explainWarning(warning))))) : null,
    plan.operations?.length ? notice("", h("b", {}, "하게 될 일"), h("ul", {}, plan.operations.map((op) => h("li", {}, (OPERATIONS[op.type] || (() => op.type))(op))))) : null,
    details("자세한 결과", plan),
  );
}

function collectPage(body) {
  if (app.context?.configured) return collectSummary(body);
  return collectFlow(body);
}

async function collectSummary(body, banner = null) {
  clear(body, banner ? h("div", { class: "banner" }, banner) : null, h("div", { class: "empty" }, spinner()));
  const [status, claude, codex] = await Promise.allSettled([
    get("/api/status"),
    get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1", source: "claude" })}`),
    get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1", source: "codex" })}`),
  ]);
  const detect = status.status === "fulfilled" ? status.value.detect : null;
  const doctor = status.status === "fulfilled" ? status.value.doctor : null;
  const context = app.context;
  const latest = { claude: claude.value?.items?.[0], codex: codex.value?.items?.[0] };
  const local = sameServer(context.honcho.url, context.localServer?.apiUrl);

  const agentRow = (name) => {
    const label = AGENTS[name];
    const found = detect?.agents?.[name];
    const collecting = Boolean(context?.agents?.[name]);
    const plugin = found?.plugin || {};
    const last = latest[name];
    const state = !found?.detected ? tag("설치 안 됨")
      : collecting && plugin.enabled ? tag("보내는 중", "ok")
        : collecting ? tag("플러그인 꺼짐", "warn")
          : tag("보내지 않음");
    return h("div", { class: "row" },
      h("div", {},
        h("div", { class: "title" }, h("span", { class: `src ${name}` }, name === "codex" ? "X" : "C"), label, state),
        h("div", { class: "sub" }, last ? `마지막으로 모인 ${label} 대화 ${ago(last.createdAt)} · ${last.title || "제목 없음"}` : `이 서버에 모인 ${label} 대화가 아직 없습니다.`),
      ),
      h("div", { class: "end" }, collecting && !plugin.enabled && found?.detected
        ? h("span", { class: "muted", style: { fontSize: "12.5px" } }, name === "codex" ? "Codex에서 플러그인을 켜고 새 세션을 여세요" : "Claude Code에서 /plugin 으로 켜세요")
        : null),
    );
  };
  const checks = (doctor?.checks || []).filter((check) => !check.ok);
  const auth = [context.honcho.hasToken ? "서버 토큰 있음" : local ? "필요 없음" : "서버 토큰 없음", context.honcho.hasAccess ? "Access 서비스 토큰 있음" : null].filter(Boolean).join(" · ");

  clear(body,
    banner ? h("div", { class: "banner" }, banner) : null,
    h("div", { class: "panel summary" },
      h("div", { class: "summary-head" },
        tag("켜짐", "ok"),
        h("b", {}, "이렇게 보내고 있습니다"),
        button("바꾸기", { kind: "small", onClick: () => collectFlow(body) }),
      ),
      h("dl", { class: "facts" },
        h("dt", {}, "기억 서버"), h("dd", {}, local ? "이 컴퓨터 서버 · " : "", h("code", { class: "mono" }, context.honcho.url)),
        h("dt", {}, "인증"), h("dd", {}, auth),
        h("dt", {}, "내 peer 이름"), h("dd", {}, h("code", { class: "mono" }, context.user.peerId || "")),
        h("dt", {}, "workspace"), h("dd", {}, h("code", { class: "mono" }, context.workspace || "")),
      ),
    ),
    h("h2", { class: "sub-title" }, "보내는 에이전트"),
    h("div", { class: "rows" }, agentRow("claude"), agentRow("codex")),
    checks.length ? h("div", { style: { marginTop: "12px" } }, notice("warn", h("b", {}, "점검에서 걸린 것"), h("ul", {}, checks.map((check) => h("li", {}, checkText(check)))))) : null,
  );
}

const STEP_INFO = {
  server: { label: "기억 서버", title: "어느 기억 서버로 보낼까요?" },
  agents: { label: "보낼 에이전트", title: "어느 에이전트의 대화를 보낼까요?" },
  name: { label: "내 이름", title: "기억에서 나를 가리킬 이름", note: "내 모든 컴퓨터에서 같은 이름을 쓰세요." },
  confirm: { label: "확인", title: "이대로 설정할까요?", note: "적용을 누르면 아래 일을 합니다." },
};

function collectFlow(body) {
  const context = app.context || {};
  const configured = Boolean(context.configured);
  const form = $("#tpl-setup-form").content.cloneNode(true).querySelector("form");
  const fields = form.elements;
  const groups = Object.fromEntries([...form.querySelectorAll("[data-step]")].map((group) => [group.dataset.step, group]));
  const remoteFields = form.querySelector("[data-remote]");

  // The same starting values the single form had.
  fields.userPeer.value = context.user?.peerId || me() || "";
  fields.workspace.value = context.workspace || workspace();
  if (configured) {
    for (const box of form.querySelectorAll('input[name="agents"]')) box.checked = Boolean(context.agents?.[box.value]);
  }
  if (context.honcho?.hasToken) fields.apiToken.placeholder = "저장된 토큰을 그대로 씁니다";
  if (context.honcho?.hasAccess) {
    fields.accessClientId.placeholder = "저장된 값을 그대로 씁니다";
    fields.accessClientSecret.placeholder = "저장된 값을 그대로 씁니다";
  }

  // 이 컴퓨터 서버 sends its address and no token; 다른 컴퓨터 서버 asks for both.
  const localUrl = context.localServer?.apiUrl || "";
  const usingLocal = configured && sameServer(context.honcho?.url, localUrl);
  let remoteUrl = configured && !usingLocal ? context.honcho?.url || "" : "";
  let mode = localUrl && (!configured || usingLocal) ? "local" : "remote";
  const cards = {};
  const setMode = (next) => {
    if (mode === "remote") remoteUrl = fields.honchoUrl.value;
    mode = next;
    const local = mode === "local";
    remoteFields.hidden = local;
    fields.honchoUrl.value = local ? localUrl : remoteUrl;
    fields.honchoUrl.required = !local;
    for (const name of ["apiToken", "accessClientId", "accessClientSecret"]) fields[name].disabled = local;
    for (const [key, card] of Object.entries(cards)) {
      card.classList.toggle("picked", key === mode);
      card.setAttribute("aria-pressed", String(key === mode));
    }
  };
  const card = (key, title, text, extra) => {
    cards[key] = h("button", { type: "button", class: "choice", onclick: () => setMode(key) }, h("b", {}, title), h("span", {}, text), extra || null);
    return cards[key];
  };
  if (localUrl) {
    form.querySelector("[data-slot=\"server-choice\"]").append(h("div", { class: "choices two" },
      card("local", "이 컴퓨터 서버", "주소와 token 없이 바로 보냅니다.", h("code", { class: "mono" }, localUrl)),
      card("remote", "다른 컴퓨터 서버", "그 컴퓨터의 서버 → 공유에서 주소와 서버 token을 받아 넣습니다.")));
  }
  setMode(mode);

  // Which agents this computer has; until known the boxes keep their values.
  let touched = false;
  for (const box of form.querySelectorAll('input[name="agents"]')) box.addEventListener("change", () => { touched = true; });
  for (const hint of form.querySelectorAll("[data-detect]")) clear(hint, spinner());
  get("/api/status").then((status) => {
    const detect = status?.detect;
    for (const hint of form.querySelectorAll("[data-detect]")) {
      const found = detect?.agents?.[hint.dataset.detect];
      hint.textContent = !found?.detected ? "이 컴퓨터에서 찾지 못함" : found.plugin?.enabled ? "이 컴퓨터에 있음" : "이 컴퓨터에 있음 · 플러그인 꺼짐";
    }
    if (!configured && !touched && detect) {
      for (const box of form.querySelectorAll('input[name="agents"]')) box.checked = Boolean(detect.agents?.[box.value]?.detected);
    }
  }).catch(() => { for (const hint of form.querySelectorAll("[data-detect]")) clear(hint); });

  const steps = ["server", "agents", ...(context.user?.peerId ? [] : ["name"]), "confirm"];
  let at = 0;
  let planRun = 0;
  const stepper = h("ol", { class: "stepper" });
  const stage = h("div", { class: "stage" });
  const problem = h("div", {});
  const extra = h("div", {});
  const actions = h("div", { class: "form-actions" });
  const apply = button("적용", { kind: "primary", onClick: (event) => applySetup(event.currentTarget) });

  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT" && event.target.type !== "checkbox") {
      event.preventDefault();
      next();
    }
  });

  function stepOk(key) {
    clear(problem);
    const group = groups[key];
    if (!group) return true;
    for (const input of group.querySelectorAll("input")) {
      if (input.disabled || input.closest("[hidden]") || input.checkValidity()) continue;
      input.closest("details")?.setAttribute("open", "");
      input.reportValidity();
      return false;
    }
    if (key === "agents" && !form.querySelector('input[name="agents"]:checked')) {
      clear(problem, notice("warn", "대화를 보낼 에이전트를 하나 이상 고르세요."));
      return false;
    }
    return true;
  }

  function goTo(index) {
    at = index;
    draw({ focus: true });
  }

  function next() {
    if (steps[at] === "confirm") return;
    if (!stepOk(steps[at])) return;
    goTo(at + 1);
  }

  function changeName() {
    if (!steps.includes("name")) steps.splice(steps.length - 1, 0, "name");
    goTo(steps.indexOf("name"));
  }

  function draw({ focus = false } = {}) {
    const key = steps[at];
    const info = STEP_INFO[key];
    clear(problem);
    clear(stepper, steps.map((step, index) => {
      const inner = [h("span", { class: "n" }, index < at ? "✓" : String(index + 1)), h("span", {}, STEP_INFO[step].label)];
      return h("li", { class: index < at ? "done" : "", "aria-current": index === at ? "step" : null },
        index < at ? h("button", { type: "button", onclick: () => goTo(index) }, inner) : inner);
    }));
    clear(stage, h("h3", {}, info.title), info.note ? h("p", {}, info.note) : null);
    for (const [step, group] of Object.entries(groups)) group.hidden = step !== key;
    form.hidden = key === "confirm";
    clear(extra);
    clear(actions,
      at > 0 ? button("이전", { onClick: () => goTo(at - 1) }) : configured ? button("취소", { kind: "quiet", onClick: () => collectSummary(body) }) : null,
      key === "confirm" ? apply : button("다음", { kind: "primary", onClick: next }),
    );
    if (key === "confirm") drawConfirm();
    else if (focus) form.querySelector(`[data-step="${key}"] input:not([disabled])`)?.focus({ preventScroll: true });
  }

  function chosenSummary() {
    const data = formBody(form);
    const agents = new FormData(form).getAll("agents").map((name) => AGENTS[name]).join("·") || "없음";
    const token = mode === "local" ? "필요 없음"
      : data.apiToken ? "새로 넣음"
        : context.honcho?.hasToken && sameServer(context.honcho.url, data.honchoUrl) ? "저장된 토큰" : "없음";
    const edit = (label, step) => button(label, { kind: "small quiet", onClick: () => (step === "name" ? changeName() : goTo(steps.indexOf(step))) });
    return h("dl", { class: "facts chosen" },
      h("dt", {}, "기억 서버"), h("dd", {}, mode === "local" ? "이 컴퓨터 서버 · " : "", h("code", { class: "mono" }, data.honchoUrl || ""), edit("바꾸기", "server")),
      h("dt", {}, "서버 토큰"), h("dd", {}, token, data.accessClientId ? " · Access 서비스 토큰 새로 넣음" : ""),
      h("dt", {}, "에이전트"), h("dd", {}, agents, edit("바꾸기", "agents")),
      h("dt", {}, "내 peer 이름"), h("dd", {}, h("code", { class: "mono" }, data.userPeer || ""), ` · workspace ${data.workspace || "memory"}`, edit("바꾸기", "name")),
    );
  }

  async function drawConfirm() {
    const run = ++planRun;
    apply.disabled = true;
    clear(extra, chosenSummary(), h("div", { class: "muted checking" }, spinner(), "설정을 미리 확인하는 중…"));
    let plan;
    try {
      plan = await post("/api/setup/plan", formBody(form));
    } catch (error) {
      plan = { ok: false, error: error.message };
    }
    if (run !== planRun || steps[at] !== "confirm") return;
    clear(extra, chosenSummary(), planView(plan));
    apply.disabled = !plan.ready;
  }

  async function applySetup(control) {
    // A field from a skipped step can still be wrong; send the person back to it.
    const invalid = [...form.querySelectorAll("input")].find((input) => !input.disabled && !input.checkValidity());
    if (invalid) {
      const step = invalid.closest("[data-step]")?.dataset.step;
      if (step === "name" && !steps.includes("name")) steps.splice(steps.length - 1, 0, "name");
      goTo(steps.indexOf(step));
      invalid.closest("details")?.setAttribute("open", "");
      invalid.reportValidity();
      return;
    }
    const chosen = new FormData(form).getAll("agents");
    await busy(control, async () => {
      const done = await post("/api/setup/apply", formBody(form));
      if (!done.ok) { clear(extra, chosenSummary(), planView(done)); throw new Error("설정하지 못했습니다."); }
      await loadContext();
      refreshStatus();
      // A plugin setup could not install: that agent's line is the commands to run.
      const agentLine = (name, text) => {
        const manual = (done.nextSteps || []).find((step) => step.agent === name && step.action === "install-plugin");
        return manual?.commands?.length
          ? h("li", {}, `${AGENTS[name]}: 터미널에서 차례로 실행하세요. `, manual.commands.map((command, index) => [index ? " → " : "", h("code", { class: "mono" }, command)]))
          : h("li", {}, text);
      };
      await collectSummary(body, notice("ok", h("b", {}, "설정했습니다."),
        h("ul", {},
          chosen.includes("codex") ? agentLine("codex", "Codex: 새 세션에서 “Syncing codex conversation to personal memory” 훅을 승인하세요.") : null,
          chosen.includes("claude") ? agentLine("claude", "Claude Code: 열려 있는 세션에서 /reload-plugins 를 실행하거나 새로 여세요.") : null,
        )));
    });
  }

  clear(body, h("div", { class: "panel flow" }, stepper, stage, form, problem, extra, actions));
  draw();
}

// ── 회사 서버에도 보내기 ──────────────────────────────────

function targetsPage(container) {
  async function drawTargets(banner = null) {
    let list;
    try {
      list = await cli("/api/targets", {});
    } catch (error) {
      clear(container, errorNotice(error));
      return;
    }
    const items = list.targets || [];
    if (!app.context?.configured) {
      clear(container, notice("", "먼저 대화 보내기를 켜세요. 그다음에 다른 서버를 더할 수 있습니다."),
        h("div", { class: "form-actions" }, button("대화 보내기 설정", { kind: "primary", onClick: () => go("connect/collect") })));
      return;
    }
    clear(container,
      banner,
      items.length ? h("div", { class: "rows" }, items.map(targetRow)) : null,
      addTargetForm(items.length === 0),
    );
  }
  // The 연결 list counts the servers from the setup it has, so keep that current.
  const refreshContext = () => loadContext().catch(() => {});

  function targetRow(target) {
    const status = h("div", {});
    const sent = target.lastSentAt ? `마지막으로 보낸 때 ${new Date(target.lastSentAt).toLocaleString("ko-KR")}` : "아직 보낸 대화 없음";
    return h("div", { class: "row", style: { alignItems: "flex-start" } },
      h("div", { style: { minWidth: "0" } },
        h("div", { class: "title" }, target.enabled ? tag("보내는 중", "ok") : tag("멈춤"), target.label || target.id, target.pending ? tag(`기다리는 대화 ${target.pending}`, "warn") : null),
        h("div", { class: "sub mono" }, target.url || ""),
        h("div", { class: "sub" }, `폴더: ${(target.folders || []).join(", ")}`),
        h("div", { class: "sub" }, [`workspace ${target.workspace}`, `peer ${target.userPeerId}`, target.hasToken ? "토큰 있음" : null, target.hasAccess ? "Access 서비스 토큰 있음" : null, sent].filter(Boolean).join(" · ")),
        status,
      ),
      h("div", { class: "end", style: { flexWrap: "wrap", justifyContent: "flex-end" } },
        button("시험", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
          const result = await post("/api/targets/test", { id: target.id });
          clear(status, result.ok
            ? notice("ok", "서버가 답하고 workspace를 읽을 수 있습니다.")
            : notice("bad", explainWarning(result.health?.error || result.workspace?.error || result.error || "서버가 답하지 않습니다.")));
        }) }),
        button("폴더 바꾸기", { kind: "small quiet", onClick: async () => {
          const next = window.prompt("보낼 폴더를 쉼표로 나눠 적으세요.", (target.folders || []).join(", "));
          if (next === null) return;
          try { await cli("/api/targets/set", { id: target.id, folders: next.split(",").map((item) => item.trim()).filter(Boolean) }); toast("폴더를 바꿨습니다"); drawTargets(); refreshContext(); } catch (error) { toast(error.message, "bad"); }
        } }),
        button(target.enabled ? "멈추기" : "다시 보내기", { kind: "small quiet", onClick: (event) => busy(event.currentTarget, async () => { await cli("/api/targets/set", { id: target.id, enabled: !target.enabled }); await drawTargets(); refreshContext(); }) }),
        button("지난 대화 보내기", { kind: "small quiet", onClick: async (event) => {
          const since = window.prompt("언제부터의 대화를 보낼까요? (예: 2026-09-01) 비워 두면 그 폴더의 모든 지난 대화를 보냅니다.", "");
          if (since === null) return;
          if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since.trim())) { toast("날짜는 2026-09-01처럼 적습니다.", "bad"); return; }
          const ok = await confirmSheet({ title: `${target.label || target.id}에 지난 대화를 보낼까요?`, text: `${(target.folders || []).join(", ")} 폴더에서 한 대화${since ? `(${since.trim()} 이후)` : ""}를 보냅니다. 이미 보낸 것은 다시 보내지 않습니다. 한 번에 500개까지 보내고, 남으면 다시 누르면 이어서 보냅니다.`, confirm: "보내기" });
          if (!ok) return;
          await busy(event.currentTarget, async () => {
            const body = { id: target.id };
            if (since.trim()) body.since = since.trim();
            const result = await post("/api/targets/backfill", body);
            const counts = [`대화 ${number(result.sent_sessions || 0)}개`, `새 메시지 ${number(result.new_messages || 0)}개`, result.remaining ? `남은 것 ${number(result.remaining)}개 (다시 누르면 이어서)` : null, result.failed ? `실패 ${number(result.failed)}개` : null].filter(Boolean).join(" · ");
            clear(status, notice(result.ok ? "ok" : "warn", h("b", {}, result.ok ? "보냈습니다." : "일부만 보냈습니다."), ` ${counts}`, result.stopped ? h("div", {}, "서버가 계속 답하지 않아 멈췄습니다. 서버가 돌아오면 다시 누르세요.") : null));
            await loadContext();
          });
        } }),
        button("", { kind: "small icon-only quiet danger", iconName: "trash", title: "빼기", onClick: async (event) => {
          const ok = await confirmSheet({ title: `${target.label || target.id}를 뺄까요?`, text: "이제부터 이 서버로 보내지 않습니다. 이미 보낸 대화는 그 서버에 그대로 남습니다. 아직 못 보낸 대화는 버립니다.", confirm: "빼기", danger: true });
          if (!ok) return;
          await busy(event.currentTarget, async () => { await cli("/api/targets/remove", { id: target.id }); await drawTargets(); refreshContext(); }, { done: "뺐습니다" });
        } }),
      ),
    );
  }

  function addTargetForm(open) {
    const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
    const wide = (label, input, hint) => h("label", { class: "field wide" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
    const inputs = {
      label: h("input", { class: "input", placeholder: "예: 회사" }),
      url: h("input", { class: "input", type: "url", placeholder: "https://memory.company.com" }),
      folders: h("textarea", { class: "input", rows: "2", placeholder: "/Users/me/work, /Users/me/dev/company-app" }),
      apiToken: h("input", { class: "input", type: "password", autocomplete: "off" }),
      workspace: h("input", { class: "input", placeholder: app.context?.workspace || "memory" }),
      userPeer: h("input", { class: "input", placeholder: app.context?.user?.peerId || "" }),
      accessClientId: h("input", { class: "input", type: "password", autocomplete: "off" }),
      accessClientSecret: h("input", { class: "input", type: "password", autocomplete: "off" }),
    };
    const outcome = h("div", {});
    const form = h("div", { class: "panel" },
      h("div", { class: "form-grid" },
        field("이름", inputs.label, "화면에 보일 이름입니다."),
        field("서버 주소", inputs.url),
        wide("보낼 폴더", inputs.folders, "이 폴더 안에서 연 에이전트 대화만 보냅니다. 쉼표나 줄바꿈으로 여러 개를 적습니다."),
        wide("서버 토큰", inputs.apiToken, "그 서버 관리자에게 받습니다."),
        field("그 서버의 workspace", inputs.workspace, "비우면 내 서버와 같게 둡니다."),
        field("그 서버에서 쓸 peer 이름", inputs.userPeer, "비우면 내 서버와 같게 둡니다."),
        h("details", { class: "field wide access-fields" },
          h("summary", {}, "Cloudflare Access 서비스 토큰"),
          h("div", { class: "form-grid" }, field("Access 서비스 토큰 ID", inputs.accessClientId), field("Access 서비스 토큰 비밀", inputs.accessClientSecret)),
        ),
      ),
      h("div", { class: "form-actions" },
        button("더하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
          const label = inputs.label.value.trim() || "회사";
          const body = {
            id: slug(label),
            label,
            url: inputs.url.value.trim(),
            folders: inputs.folders.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
          };
          for (const key of ["workspace", "userPeer", "apiToken", "accessClientId", "accessClientSecret"]) if (inputs[key].value.trim()) body[key] = inputs[key].value.trim();
          const result = await post("/api/targets/add", body);
          if (!result.ok) {
            clear(outcome, notice("bad", h("b", {}, "더하지 못했습니다."), h("ul", {}, (result.issues || [result.error]).filter(Boolean).map((issue) => h("li", {}, explainWarning(issue))))));
            return;
          }
          refreshContext();
          await drawTargets(notice("ok", h("b", {}, `${label}에도 보냅니다.`), " 지금부터 끝나는 대화가 갑니다. 지난 대화도 보내려면 지난 대화 보내기를 누르세요.",
            result.warnings?.length ? h("ul", {}, result.warnings.map((warning) => h("li", {}, explainWarning(warning)))) : null));
        }) }),
      ),
      outcome,
    );
    return open ? form : h("details", { class: "raw", style: { marginTop: "12px" } }, h("summary", {}, "다른 서버 더하기"), h("div", { style: { marginTop: "10px" } }, form));
  }

  function slug(text) {
    if (/회사/.test(text)) return "company";
    const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return ascii || `server-${Date.now().toString(36).slice(-4)}`;
  }

  clear(container, h("div", { class: "empty" }, spinner()));
  return drawTargets();
}

// ── 팀원 기억 연결 ───────────────────────────────────────

const CLIENTS = { claude: "Claude Code", codex: "Codex" };
const CLIENT_ACTIONS = {
  added: "넣었습니다",
  replaced: "새 주소로 바꿔 넣었습니다",
  unchanged: "이미 들어 있습니다",
  removed: "뺐습니다",
  absent: "들어 있지 않았습니다",
};
const SOURCES = { invite: "초대 코드의 팀 목록", team: "내가 연 팀", pasted: "붙여 넣은 주소" };
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** The 팀 주소 text: `<name> <address>` or just `<address>` per line. The server checks each again. */
function parseTeamAddresses(text) {
  const found = [];
  const bad = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length || words[0].startsWith("#")) continue;
    const raw = words.length > 1 ? words[1] : words[0];
    let host = "";
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol === "https:" && ["/", "/mcp", "/mcp/"].includes(url.pathname) && !url.search && !url.hash && !url.port && !url.username) host = url.hostname.toLowerCase();
    } catch {}
    const label = host.split(".")[0] || "";
    const name = (words.length > 1 ? words[0] : label.replace(/^memory-(?=.)/, "")).toLowerCase().replace(/^team-/, "");
    if (!host.includes(".") || !NAME.test(name) || words.length > 2) { bad.push(line.trim()); continue; }
    if (!found.some((item) => item.name === name)) found.push({ name, host, url: `https://${host}/mcp`, sources: ["pasted"] });
  }
  return { found, bad };
}

function clientLines(result) {
  return Object.entries(CLIENTS).map(([key, label]) => {
    const item = result?.clients?.[key];
    if (!item) return null;
    const text = item.ok ? CLIENT_ACTIONS[item.action] || "됐습니다"
      : item.missing ? "이 컴퓨터에 없어 건너뛰었습니다"
        : `하지 못했습니다: ${item.error || "알 수 없는 오류"}`;
    return h("li", {}, `${label}: ${text}`);
  });
}

function loginNotes(entry) {
  return h("ul", {},
    h("li", {}, "Claude Code: 세션에서 ", h("code", { class: "mono" }, "/mcp"), " 를 열고 ", h("code", { class: "mono" }, entry), " 를 골라 Authenticate를 누릅니다."),
    h("li", {}, "Codex: 아래 목록에서 그 서버의 Codex 로그인을 누릅니다."),
    h("li", {}, "브라우저가 열리면 팀에 등록된 Google 계정으로 로그인합니다. Cloudflare Access를 거친 OAuth라서 이 앱은 token을 받지도 저장하지도 않습니다."),
  );
}

function sharePage(share) {
  // Pasted addresses stay listed until this page is left; connected ones come back from the clients' own files.
  const pasted = new Map();
  const pasteBox = h("textarea", { class: "input mono", rows: "3", spellcheck: "false", placeholder: "memory https://memory.example.com/mcp\nalice https://memory-alice.example.com/mcp" });

  async function connectOne(server) {
    const result = await post("/api/teammates/connect", { name: server.name, address: server.host || server.url });
    return { server, result };
  }

  function outcome(results) {
    const good = results.filter(({ result }) => result.ok);
    return h("div", {}, ...results.map(({ server, result }) => notice(result.ok ? "ok" : "bad",
      h("b", {}, result.ok ? `${server.name} 연결` : `${server.name} 연결 못 함`),
      result.ok || result.clients ? h("ul", {}, clientLines(result)) : ` ${result.error || ""}`,
    )), good.length ? notice("", h("b", {}, "이제 한 번 로그인합니다."), loginNotes(good[0].result.entry)) : null);
  }

  function serverRow(server, clients) {
    const registered = ["claude", "codex"].filter((key) => server[key]?.registered);
    const moved = registered.some((key) => server[key].same === false);
    const complete = registered.length === Object.keys(CLIENTS).filter((key) => clients[key]?.found !== false).length && !moved;
    const sources = (server.sources || []).map((key) => SOURCES[key]).filter(Boolean).join(" · ");
    return h("div", { class: "row", style: { alignItems: "flex-start" } },
      h("div", { style: { minWidth: "0" } },
        h("div", { class: "title" },
          server.name,
          registered.length ? registered.map((key) => tag(`${CLIENTS[key]} 연결됨`, "ok")) : tag("연결 안 됨"),
          moved ? tag("주소가 바뀜", "warn") : null),
        h("div", { class: "sub mono" }, server.url || server.host || ""),
        sources ? h("div", { class: "sub" }, sources) : null,
      ),
      h("div", { class: "end", style: { flexWrap: "wrap", justifyContent: "flex-end" } },
        !complete ? button("연결", { kind: "small primary", onClick: (event) => busy(event.currentTarget, async () => {
          const done = await connectOne(server);
          await loadContext();
          refreshStatus();
          await drawShare(outcome([done]));
        }) }) : null,
        server.codex?.registered ? button("Codex 로그인", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
          const login = await post("/api/teammates/codex-login", { name: server.name });
          if (!login.ok) throw new Error(login.error || "Codex 로그인을 시작하지 못했습니다.");
          if (login.state === "done") { toast(`Codex에서 ${login.entry} 로그인을 마쳤습니다`); return; }
          await drawShare(notice("", h("b", {}, "브라우저에서 Codex 로그인을 마치세요."),
            h("div", {}, "창이 열리지 않았으면 이 주소를 여세요. 10분 안에 마치지 않으면 다시 누릅니다."),
            login.loginUrl ? h("div", {}, h("a", { href: login.loginUrl, target: "_blank", rel: "noreferrer" }, "로그인 주소 열기")) : null));
        }) }) : null,
        registered.length ? button("끊기", { kind: "small quiet danger", onClick: async (event) => {
          const ok = await confirmSheet({ title: `${server.name} 연결을 끊을까요?`, text: `Claude Code와 Codex에서 ${server.entry || `team-${server.name}`} 를 뺍니다. 그 기억 서버는 그대로이고, 다시 연결하면 또 로그인합니다.`, confirm: "끊기", danger: true });
          if (!ok) return;
          await busy(event.currentTarget, async () => {
            const result = await post("/api/teammates/disconnect", { name: server.name });
            await loadContext();
            refreshStatus();
            await drawShare(notice(result.ok ? "ok" : "bad", h("b", {}, result.ok ? `${server.name} 연결을 끊었습니다.` : `${server.name} 연결을 다 끊지 못했습니다.`), h("ul", {}, clientLines(result))));
          });
        } }) : null,
      ),
    );
  }

  function oldBridgeNotice() {
    if (!app.context?.oldBridge) return null;
    return notice("warn",
      h("b", {}, "예전 방식의 팀원 기억 연결이 남아 있습니다."),
      h("div", {}, "공유 창구 주소와 token을 저장해 두던 방식은 이제 쓰지 않습니다. 저장된 token을 이 컴퓨터에서 지우세요."),
      h("div", { class: "form-actions", style: { marginTop: "8px" } }, button("예전 연결 지우기", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
        await cli("/api/bridge/disconnect", {});
        await loadContext();
        refreshStatus();
        await drawShare();
      }, { done: "예전 연결을 지웠습니다" }) })),
    );
  }

  async function drawShare(banner = null) {
    let status;
    try { status = await cli("/api/teammates/connected", {}); } catch (error) { clear(share, errorNotice(error)); return; }
    const clients = status.clients || {};
    const servers = [...(status.servers || [])];
    for (const item of pasted.values()) {
      if (!servers.some((server) => server.name === item.name)) servers.push({ ...item, entry: `team-${item.name}`, claude: { registered: false }, codex: { registered: false } });
    }
    const missing = Object.entries(CLIENTS).filter(([key]) => clients[key]?.found === false).map(([, label]) => label);
    const anyConnected = servers.some((server) => server.claude?.registered || server.codex?.registered);
    const pasteResult = h("div", {});
    clear(share,
      oldBridgeNotice(),
      banner,
      missing.length ? notice("warn", `${missing.join(", ")}가 이 컴퓨터에 없어 그쪽에는 넣지 않습니다.`) : null,
      servers.length
        ? h("div", { class: "rows" }, servers.map((server) => serverRow(server, clients)))
        : notice("", "이 컴퓨터가 아는 팀원 기억이 아직 없습니다. 팀원에게 받은 팀 주소를 아래에 붙여 넣으세요."),
      h("h2", { class: "sub-title" }, "팀 주소 붙여 넣기"),
      h("div", { class: "panel" },
        h("label", { class: "field wide" },
          h("span", {}, "팀 주소"),
          pasteBox,
          h("small", {}, "팀을 연 사람의 앱에서 서버 → 공유 → 팀 주소를 복사해 받습니다. 주소 하나(memory-alice.example.com)만 넣어도 됩니다. 비밀이 아닌 주소라서 token은 없습니다."),
        ),
        h("div", { class: "form-actions" }, button("Claude Code·Codex에 연결", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
          const { found, bad } = parseTeamAddresses(pasteBox.value);
          if (!found.length) { clear(pasteResult, notice("warn", "알아볼 수 있는 주소가 없습니다. https://로 시작하는 주소나 memory-이름.도메인 형태로 넣으세요.")); return; }
          for (const item of found) pasted.set(item.name, item);
          const results = [];
          for (const item of found) results.push(await connectOne(item));
          pasteBox.value = "";
          await loadContext();
          refreshStatus();
          await drawShare(h("div", {}, outcome(results), bad.length ? notice("warn", h("b", {}, "알아보지 못한 줄"), h("ul", {}, bad.map((line) => h("li", { class: "mono" }, line)))) : null));
        }) })),
        pasteResult,
      ),
      anyConnected ? h("h2", { class: "sub-title" }, "로그인") : null,
      anyConnected ? h("div", { class: "panel" }, loginNotes("team-<이름>"), h("p", { class: "muted", style: { margin: "8px 0 0", fontSize: "13px" } }, "로그인한 뒤에는 에이전트가 그 기억의 chat 도구로 묻습니다. 팀을 연 사람이 내 이메일을 팀원으로 넣어 두어야 로그인이 됩니다.")) : null,
      h("details", { class: "raw", style: { marginTop: "16px" } },
        h("summary", { class: "muted" }, "어떻게 연결되나요"),
        h("ul", { class: "muted", style: { fontSize: "13px" } },
          h("li", {}, "팀원 서버 하나는 Claude Code와 Codex에 team-<이름> 이라는 원격 MCP 서버(https://<서버>/mcp)로 들어갑니다. Claude Code는 user 범위에 넣습니다."),
          h("li", {}, "같은 이름이 같은 주소로 있으면 그대로 두고, 다른 주소로 있으면 새 주소로 바꿉니다."),
          h("li", {}, "로그인은 Cloudflare Access를 거친 OAuth입니다. token은 이 앱을 거치지 않고 각 프로그램이 따로 보관합니다."),
          h("li", {}, "지금은 연결한 기억 전체에 chat으로 묻습니다. 프로젝트별로 나누는 기능은 아직 없습니다."),
        ),
      ),
    );
  }

  clear(share, h("div", { class: "empty" }, spinner()));
  return drawShare();
}

// ── ChatGPT 기록 가져오기 ────────────────────────────────

function importPage(importer) {
  const file = h("input", { type: "file", accept: ".zip,.json,application/zip,application/json", class: "input", style: { paddingTop: "4px" } });
  const result = h("div", {});
  const upload = button("올리기", { kind: "primary", iconName: "upload", disabled: true });
  file.addEventListener("change", () => {
    upload.disabled = !file.files?.length;
    clear(result, file.files?.[0] ? h("p", { class: "muted", style: { fontSize: "13px" } }, `${file.files[0].name} · ${(file.files[0].size / 1024 / 1024).toFixed(1)}MB`) : null);
  });
  upload.addEventListener("click", () => busy(upload, async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    clear(result, h("div", { class: "muted", style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" } }, spinner(), "올리고 읽는 중… 대화가 많으면 몇 분 걸립니다."));
    const response = await fetch("/api/import/chatgpt", { method: "POST", headers: { "content-type": "application/json" }, body: chosen });
    const payload = await response.json().catch(() => ({ ok: false, error: "결과를 읽지 못했습니다." }));
    if (!payload.ok) {
      clear(result, notice("bad", h("b", {}, "가져오지 못했습니다."), ` ${payload.error || ""}`), details("자세한 결과", payload));
      return;
    }
    savePrefs({ chatgptImport: { at: new Date().toISOString(), conversations: payload.conversations ?? 0, newMessages: payload.new_messages ?? 0 } });
    clear(result, notice("ok", h("b", {}, "가져왔습니다."),
      ` 대화 ${number(payload.conversations ?? 0)}개를 읽어 ${number(payload.imported_sessions ?? 0)}개를 넣었고, 새 메시지는 ${number(payload.new_messages ?? 0)}개입니다.`,
      payload.new_messages === 0 ? " 이미 들어 있는 기록이었습니다." : ""), details("자세한 결과", payload));
    file.value = "";
    upload.disabled = true;
  }));
  const context = app.context || {};
  const last = app.prefs.chatgptImport;
  clear(importer,
    h("ol", { class: "how" },
      h("li", {}, "ChatGPT 설정 → 데이터 제어 → 데이터 내보내기를 누르면 메일로 파일이 옵니다."),
      h("li", {}, "받은 zip 파일을 풀지 말고 그대로 아래에 올립니다. 대화가 많으면 zip 안에 conversations-000.json, conversations-001.json처럼 여러 파일로 나뉘어 있는데, zip을 올리면 전부 읽습니다."),
      h("li", {}, "같은 파일을 다시 올려도 겹쳐 쌓이지 않습니다."),
    ),
    context.configured
      ? h("p", { class: "muted dest" }, "넣을 곳: ", sameServer(context.honcho?.url, context.localServer?.apiUrl) ? "이 컴퓨터 서버 · " : "", h("code", { class: "mono" }, context.honcho?.url || ""), ` · workspace ${context.workspace || "memory"}`)
      : notice("warn", "대화 보내기를 아직 켜지 않았습니다. 먼저 켜면 내 기억 서버로 들어갑니다.", " ", h("a", { href: "#/connect/collect" }, "대화 보내기 설정")),
    h("div", { class: "panel", style: { marginTop: "12px" } }, h("div", { class: "upload-line" }, file, upload), result),
    last?.at ? h("p", { class: "muted dest" }, `이 앱에서 마지막으로 가져온 때 ${ago(last.at)} · 대화 ${number(last.conversations || 0)}개 · 새 메시지 ${number(last.newMessages || 0)}개`) : null,
  );
}

const PAGES = { collect: collectPage, targets: targetsPage, share: sharePage, import: importPage };

export default {
  title: "연결",
  async mount(page, params) {
    const render = (next = []) => {
      const task = TASKS.find((item) => item.key === next[0]);
      if (next[0] && !task) history.replaceState(null, "", "#/connect");
      clear(page);
      if (!task) return landing(page);
      const body = h("div", { class: "pad" });
      page.append(subHead(task), h("div", { class: "page-body" }, body));
      return PAGES[task.key](body);
    };
    await render(params);
    return { update: (next) => { render(next); } };
  },
};
