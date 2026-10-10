// 기억 설정: what this computer does with its own conversations and agents, as three
// blocks on one page. 대화 수집's 수정 is first setup's own steps (lib/collect.js,
// lib/past.js); 지난 대화 shows where the past conversations came from and how far
// they went in, and its 더 가져오기 opens the same steps at 지난 대화; MCP 도구
// opens its own window. An address can name a window to open with the page
// (computer/collect, computer/past, computer/tools), which is how links and the
// setup skill open them. Letting the owner's other computers in is 서버 → 공유
// (share.js).
import { get, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { number } from "../lib/format.js";
import { block, kv, modal, stepper } from "../lib/kit.js";
import {
  AGENTS,
  agentsStep,
  applySetup,
  applyTargets,
  collectDraft,
  detectAgents,
  draftServer,
  folderSummary,
  loadProjects,
  planProblems,
  projectsStep,
  sameServer,
  serverStep,
  setupBody,
} from "../lib/collect.js";
import { backupToStore, lateLine, monthText, pastStep, periodText, planPast, shortDay, startPast } from "../lib/past.js";
import { sendRequest, teamDirectory } from "../lib/team.js";
import { TOOL_GROUPS, TOOL_INFO } from "../lib/tools.js";
import { app, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, errorNotice, notice, pageHead, spinner, tag, toast, toggle } from "../lib/ui.js";

const STEPS = ["서버", "에이전트", "지난 대화", "프로젝트"];
const PAST_STEP = 2;

// ── 대화 수집 ────────────────────────────────────────────

function folderLine(collect, automation) {
  const [folders, rest] = folderSummary(collect, automation);
  return [folders, h("div", { class: "s" }, rest)];
}

function serverLine(context) {
  const local = sameServer(context.honcho?.url, context.localServer?.apiUrl);
  const own = local
    ? ["이 컴퓨터 서버 ", h("span", { class: "mono muted" }, context.honcho.url.replace(/^https?:\/\//, ""))]
    : ["내 서버 ", h("span", { class: "mono muted" }, context.honcho?.url || "")];
  const targets = (context.targets || []).map((target) => h("div", { style: { marginTop: "6px" } },
    `${target.label || target.id} `, h("span", { class: "mono muted" }, String(target.url || "").replace(/^https?:\/\//, "")),
    target.enabled === false ? [" ", target.team ? tag("승인 기다리는 중", "warn") : tag("꺼 둠")] : null));
  return [own, targets];
}

function collectBlock(openCollect) {
  const context = app.context || {};
  if (!context.configured) {
    return block({ title: "대화 수집", tag: tag("꺼짐"), actions: [button("켜기", { onClick: openCollect })] },
      kv("서버", "쌓지 않음"),
      kv("에이전트", "없음"));
  }
  const agents = Object.keys(AGENTS).filter((name) => context.agents?.[name]).map((name) => AGENTS[name]).join(" · ") || "없음";
  return block({ title: "대화 수집", tag: tag("켜짐", "ok"), actions: [button("수정", { onClick: openCollect })] },
    kv("서버", serverLine(context)),
    kv("peer 이름", [h("span", { class: "mono" }, context.user?.peerId || ""),
      // In a team the peer name comes from the Google email.
      context.team?.email ? h("span", { class: "muted" }, ` · ${context.team.email}에서`) : null,
      context.workspace && context.workspace !== "memory" ? h("span", { class: "muted" }, ` · workspace ${context.workspace}`) : null]),
    kv("에이전트", agents),
    kv("프로젝트 폴더", folderLine(context.collect, context.collectAutomation)));
}

/**
 * 대화 수집 → 수정: first setup's steps for this computer, any step one press away;
 * 더 가져오기 opens it at 지난 대화 (`at`).
 */
function openCollectWindow(onApplied, { at: startAt = 0 } = {}) {
  const context = app.context || {};
  const draft = collectDraft(context);
  const edit = Boolean(context.configured);
  let at = startAt;
  let steps = [];
  let company = null;
  const problem = h("div", {});
  const win = modal({ title: "대화 수집 설정" });

  const newServer = () => draft.server === "here" && !context.localServer;
  const build = () => [
    serverStep(draft, context, { peer: !context.configured || !context.user?.peerId, others: Boolean(context.configured), company }),
    agentsStep(draft),
    pastStep(draft, context, { edit, newServer: newServer() }),
    projectsStep(draft, context, { edit, server: draftServer(draft, context, { newServer: newServer() }) }),
  ];
  const goTo = (index) => {
    // Every step's choice lives in the draft, so a step can be left half done.
    at = index;
    draw();
  };
  const next = () => {
    const issue = steps[at].check();
    if (issue) { clear(problem, notice("warn", issue)); return; }
    goTo(at + 1);
  };
  const apply = (control) => busy(control, async () => {
    for (const [index, step] of steps.entries()) {
      const issue = step.check();
      if (issue) { goTo(index); clear(problem, notice("warn", issue)); return; }
    }
    const outcome = await applySetup(setupBody(draft, context));
    if (!outcome.ok) { clear(problem, planProblems(outcome.result) || notice("bad", "적용하지 못했습니다.")); return; }
    // The past conversations the new choice adds, in the order they were started:
    // what the server holds already is left out.
    try {
      await backupToStore(draft);
      const plan = await planPast(draft);
      if (plan.total) await startPast();
    } catch (error) {
      await loadContext();
      clear(problem, notice("bad", h("b", {}, "대화 수집은 적용했지만 지난 대화는 쌓지 못했습니다."), h("div", {}, error.message)));
      return;
    }
    const failed = await applyTargets(draft);
    // The company server: its owner is asked, and it stays off until they approve.
    if (draft.company?.on) {
      try {
        const folders = (draft.projects || []).filter((project) => draft.company.folders.has(project.path)).map((project) => project.name);
        await sendRequest({ kind: "collect", server: draft.company.host, folders });
        const added = await post("/api/targets/add", { id: "company", label: "회사", url: `https://${draft.company.host}`, folders: [...draft.company.folders], team: true });
        if (added.ok === false) failed.push(`회사: ${added.error || (added.issues || []).join(" ")}`);
      } catch (error) {
        failed.push(`회사: ${error.message}`);
      }
    }
    if (failed.length) {
      await loadContext();
      clear(problem, notice("bad", h("b", {}, "내 서버에는 적용했지만 다른 서버는 다 바꾸지 못했습니다."), h("ul", {}, failed.map((line) => h("li", {}, line)))));
      return;
    }
    win.close("ok");
    await loadContext();
    refreshStatus();
    onApplied?.();
    toast("적용했습니다.", "ok");
  });
  function draw() {
    steps = build();
    clear(problem);
    win.steps(stepper(STEPS, at, { onPick: goTo }));
    win.body(steps[at].body, problem);
    // A step still reading (지난 대화) keeps 다음 until it is done, and says so beside it.
    const waiting = h("span", { class: "foot-hint" });
    const primary = at < steps.length - 1
      ? button("다음", { kind: "primary", onClick: next })
      : button("적용", { kind: "primary", onClick: (event) => apply(event.currentTarget) });
    steps[at].watch?.(({ blocked, hint }) => {
      primary.disabled = blocked;
      waiting.textContent = hint || "";
    });
    win.foot(button("취소", { kind: "quiet", onClick: () => win.close() }), [
      waiting,
      at > 0 ? button("이전", { kind: "quiet", onClick: () => goTo(at - 1) }) : null,
      primary,
    ]);
  }
  detectAgents({ fresh: true });
  loadProjects({ fresh: true });
  draw();
  win.open();
  // In a team, the company server the hub names can be asked for from the server step.
  if (context.team?.hub && context.team?.signedIn) {
    teamDirectory().then((directory) => {
      company = (directory.servers || []).find((server) => server.company && server.owner !== context.team.email) || null;
      if (company && at === 0) draw();
    }).catch(() => {});
  }
}

// ── MCP 도구 ─────────────────────────────────────────────

async function toolsBlock(openTools) {
  const rows = h("div", {}, kv("찾기 도구", spinner()), kv("바꾸기·지우기 도구", ""));
  const section = block({ title: "MCP 도구", actions: [button("수정", { onClick: openTools })] }, rows);
  get("/api/app/mcp-tools").then((result) => {
    if (!result.configured) {
      clear(rows, kv("도구", "대화 수집을 켜면 생깁니다"));
      return;
    }
    const count = (tools) => `${number(tools.length)}개 중 ${number(tools.filter((tool) => tool.enabled).length)}개 켜짐`;
    clear(rows,
      kv("찾기 도구", count(result.tools.filter((tool) => !tool.write))),
      kv("바꾸기·지우기 도구", count(result.tools.filter((tool) => tool.write))));
  }).catch((error) => clear(rows, errorNotice(error)));
  return section;
}

/** The tools Claude Code and Codex see from this computer's memory: two groups, or one at a time. */
async function openToolsWindow(onApplied) {
  const win = modal({ title: "MCP 도구", big: true, small: true });
  win.body(spinner()).open();
  let result;
  try {
    result = await get("/api/app/mcp-tools");
  } catch (error) {
    win.body(errorNotice(error));
    return;
  }
  if (!result.configured) {
    win.body(notice("", "이 컴퓨터는 아직 대화 수집을 켜지 않아 MCP 도구가 없습니다."));
    win.foot(null, button("닫기", { onClick: () => win.close() }));
    return;
  }
  // Changes wait for 적용; until then the switches only change this copy.
  const wanted = new Map(result.tools.map((tool) => [tool.name, tool.enabled]));
  const groups = { read: result.tools.filter((tool) => !tool.write), write: result.tools.filter((tool) => tool.write) };
  let unfolded = false;
  const draw = () => {
    const groupRow = (key, title, sub, warning) => {
      const members = groups[key];
      const on = members.every((tool) => wanted.get(tool.name));
      return h("div", { class: "swrow" },
        h("div", { class: "ab" }, h("div", { class: "t" }, title), h("div", { class: "s" }, sub), warning ? h("div", { class: "s", style: { color: "var(--warn)" } }, warning) : null),
        toggle(on, async (next) => { for (const tool of members) wanted.set(tool.name, next); draw(); }, { label: `${title} 모두 켜기` }));
    };
    const singles = h("details", { class: "fold", open: unfolded || null },
      h("summary", {}, "하나씩 켜고 끄기"),
      TOOL_GROUPS.map((group) => {
        const members = result.tools.filter((tool) => (TOOL_INFO[tool.name]?.group || "기타") === group);
        if (!members.length) return null;
        return [h("div", { class: "label" }, group), h("div", { class: "opts" }, members.map((tool) => h("div", { class: "swrow" },
          h("div", { class: "ab" }, h("div", { class: "t mono" }, tool.name), h("div", { class: "s" }, TOOL_INFO[tool.name]?.description || "")),
          toggle(wanted.get(tool.name), async (next) => { wanted.set(tool.name, next); draw(); }, { label: `${tool.name} 켜기` }))))];
      }));
    singles.addEventListener("toggle", () => { unfolded = singles.open; });
    win.body(
      h("div", { class: "opts" },
        groupRow("read", "찾기 도구", `기억을 읽기만 하는 도구 ${number(groups.read.length)}개`),
        groupRow("write", "바꾸기·지우기 도구", `기억을 바꾸거나 지우는 도구 ${number(groups.write.length)}개`, "켜면 에이전트가 기억을 바꾸거나 지울 수 있습니다.")),
      singles,
      h("div", { class: "hint", style: { marginTop: "12px" } }, "적용한 뒤 Claude Code는 ", h("span", { class: "mono" }, "/reload-plugins"), " 를 입력하고, Codex는 새 세션을 여세요."));
  };
  draw();
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("적용", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      const turn = (enabled) => result.tools.filter((tool) => tool.enabled !== enabled && wanted.get(tool.name) === enabled).map((tool) => tool.name);
      for (const enabled of [true, false]) {
        const names = turn(enabled);
        if (names.length) await post("/api/app/mcp-tools", { names, enabled });
      }
      win.close("ok");
      onApplied?.();
      toast("적용했습니다.", "ok");
    }) }),
  ]);
}

// ── 지난 대화 ────────────────────────────────────────────

const FAILURES = [["unreadable", "파일을 읽지 못함"], ["refused", "서버가 거절"], ["unreachable", "서버에 닿지 않음"]];
const dash = (value) => (value ? number(value) : "–");

/** A place past conversations came from, as the table names it. */
function sourceName(row) {
  if (row.kind === "here") return "이 컴퓨터";
  if (row.kind === "store") return ["백업 저장소 ", h("span", { class: "mono muted" }, row.label || "")];
  return ["ChatGPT ", h("span", { class: "mono muted" }, row.account || row.name || "")];
}

function moment(iso) {
  const date = new Date(iso);
  return `${shortDay(date.getTime())} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 지난 대화: each place the past conversations came from, how many went in, how
 * many were the same as another place's and how many failed; the order they went
 * in; and while they go, how far and 멈추기. 더 가져오기 opens 수정 at 지난 대화.
 */
function pastBlock(openMore) {
  const head = h("span", {});
  const rows = h("div", {}, kv("가져온 곳", spinner()));
  const section = block({ title: "지난 대화", tag: head, actions: [button("더 가져오기", { onClick: openMore })] }, rows);
  const act = (label, path, { kind = "small" } = {}) => button(label, { kind, onClick: (event) => busy(event.currentTarget, async () => {
    const result = await post(path, {});
    if (result?.ok === false) throw new Error(result.error || "하지 못했습니다.");
    await refresh();
  }) });
  // How many of the server's conversations are out of time order, as 서버 → 기억 서버
  // counts them (only a server on this computer can): asked once, when nothing runs.
  let late = null;
  let shown = null;
  async function refresh() {
    let status;
    try {
      status = await get("/api/past/status");
    } catch (error) {
      clear(rows, errorNotice(error));
      return;
    }
    if (!section.isConnected && section.dataset.shown) return;
    section.dataset.shown = "1";
    draw(status);
    if (status?.running) setTimeout(() => { if (section.isConnected) refresh(); }, 3000);
    else if (late === null) readLate();
  }
  async function readLate() {
    late = 0;
    const order = (await post("/api/rederive/status", { order: true }).catch(() => null))?.order;
    if (!order?.late) return;
    late = order.late;
    draw(shown);
  }
  function draw(status) {
    shown = status;
    const { running, last, failures = {}, order = {}, held = {} } = status || {};
    const sources = (status?.sources || []).filter((row) => row.conversations);
    clear(head, running ? tag(status.stopping ? "멈추는 중" : "쌓는 중", "warn")
      : last?.stopped === "unreachable" ? tag("서버 기다리는 중", "warn")
        : last?.cancelled ? tag("멈춤")
          : last?.finishedAt ? tag("다 쌓음", "ok") : null);
    if (!sources.length && !running) {
      clear(rows, kv("가져온 곳", "아직 없음"));
      return;
    }
    const table = h("table", { class: "mt" },
      h("thead", {}, h("tr", {}, h("th", {}, "가져온 곳"), ["대화", "쌓음", "겹쳐서 뺌", "실패"].map((label) => h("th", { class: "num" }, label)))),
      h("tbody", {}, sources.map((row) => h("tr", {},
        h("td", {}, sourceName(row)),
        h("td", { class: "num" }, number(row.conversations)),
        h("td", { class: "num" }, number(row.stacked)),
        h("td", { class: "num" }, dash(row.dupes)),
        h("td", { class: "num" }, dash(row.failed))))));
    const from = running ? sources.find((row) => row.id === running.from) : null;
    clear(rows,
      h("div", { class: "mt-wrap" }, table),
      running ? kv("쌓는 중", [
        `${number(running.done || 0)} / ${number(running.total ?? 0)}`,
        from ? [" · ", sourceName(from)] : "",
        running.month ? ` · ${monthText(running.month)} 대화까지` : "",
        held.conversations ? h("div", { class: "s" }, `새 대화 ${number(held.conversations)}개는 ${from?.kind === "chatgpt" ? "이 파일" : "지난 대화"} 다음에 쌓입니다.`) : null,
      ], status.stopping ? null : act("멈추기", "/api/past/stop", { kind: "small quiet" })) : null,
      !running && last?.cancelled ? kv("멈춤", [`${moment(last.finishedAt)}에 멈춤 · ${number(last.done || 0)} / ${number(last.total || 0)}`,
        h("div", { class: "s" }, "이어서 쌓으면 멈춘 곳부터 시간순으로 쌓습니다.")], act("이어서 쌓기", "/api/past/start")) : null,
      !running && last?.stopped === "unreachable" ? kv("멈춤", ["서버에 닿지 않아 멈췄습니다.",
        h("div", { class: "s" }, "새 대화는 기다리게 해 두었습니다. 서버가 다시 답하면 저절로 이어서 쌓습니다.")]) : null,
      order.first ? kv("쌓은 순서", [`시작한 시각순 · ${periodText(order.first, order.last)}`,
        late && !running ? h("div", { class: "s warn" }, lateLine(late)) : null,
        !running && last?.finishedAt && !last.cancelled && !last.stopped ? h("div", { class: "s" }, `${moment(last.finishedAt)}에 다 쌓음`) : null]) : null,
      failures.total ? kv("실패", [`${number(failures.total)}개 `,
        h("span", { class: "muted" }, FAILURES.filter(([key]) => failures[key]).map(([key, label]) => `· ${label} ${number(failures[key])}`).join(" "))],
      running ? null : act("다시 시도", "/api/past/retry")) : null);
  }
  refresh();
  return section;
}

// ── The page ─────────────────────────────────────────────

export default {
  title: "기억 설정",
  async mount(frame, params) {
    const body = h("div", { class: "pad stack" });
    frame.append(
      pageHead({ title: "기억 설정", subtitle: "이 컴퓨터의 대화를 어디에 쌓고, 에이전트가 무엇을 쓸지 정합니다." }),
      h("div", { class: "page-body" }, body));
    const windows = {
      collect: () => openCollectWindow(draw),
      past: () => openCollectWindow(draw, { at: PAST_STEP }),
      tools: () => openToolsWindow(draw),
    };
    async function draw() {
      const configured = Boolean(app.context?.configured);
      clear(body,
        collectBlock(windows.collect),
        configured ? pastBlock(windows.past) : null,
        configured ? await toolsBlock(windows.tools) : null);
    }
    await draw();
    const open = windows[params[0]];
    if (params[0]) history.replaceState(null, "", "#/computer");
    if (open && (params[0] === "collect" || app.context?.configured)) open();
    return null;
  },
};
