// 기억 설정: what this computer does with its own conversations and agents, as three
// blocks on one page. Each block's button opens a window: 대화 수집's 수정 is first
// setup's own steps (lib/collect.js), MCP 도구 and ChatGPT 기록 open their own. An
// address can name a window to open with the page (computer/collect, computer/tools,
// computer/import), which is how links and the setup skill open them. Letting the
// owner's other computers in is 서버 → 공유 (share.js).
import { get, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { ago, number } from "../lib/format.js";
import { block, kv, modal, stepper } from "../lib/kit.js";
import {
  AGENTS,
  agentsStep,
  applySetup,
  applyTargets,
  collectDraft,
  detectAgents,
  loadProjects,
  planProblems,
  projectsStep,
  sameServer,
  serverStep,
  setupBody,
  shortPath,
} from "../lib/collect.js";
import { TOOL_GROUPS, TOOL_INFO } from "../lib/tools.js";
import { app, loadContext, refreshStatus, savePrefs, workspace } from "../lib/state.js";
import { button, busy, errorNotice, notice, pageHead, spinner, tag, toast, toggle } from "../lib/ui.js";

const STEPS = ["서버", "에이전트", "프로젝트"];

// ── 대화 수집 ────────────────────────────────────────────

function folderSummary(collect) {
  const names = (folders) => {
    const shown = folders.slice(0, 6).map((folder) => shortPath(folder).split(/[\\/]/).pop() || shortPath(folder));
    return shown.join(" · ") + (folders.length > shown.length ? ` 외 ${folders.length - shown.length}개` : "");
  };
  if (!collect) return ["모든 폴더", h("div", { class: "s" }, "새로 생기는 폴더도 수집")];
  if (collect.rest === "skip") return [collect.take.length ? names(collect.take) : "없음", h("div", { class: "s" }, "고른 폴더만 수집")];
  return [collect.skip.length ? `빼는 폴더 ${names(collect.skip)}` : "모든 폴더", h("div", { class: "s" }, "새로 생기는 폴더도 수집")];
}

function serverLine(context) {
  const local = sameServer(context.honcho?.url, context.localServer?.apiUrl);
  const own = local
    ? ["이 컴퓨터 서버 ", h("span", { class: "mono muted" }, context.honcho.url.replace(/^https?:\/\//, ""))]
    : ["내 서버 ", h("span", { class: "mono muted" }, context.honcho?.url || "")];
  const targets = (context.targets || []).map((target) => h("div", { style: { marginTop: "6px" } },
    `${target.label || target.id} `, h("span", { class: "mono muted" }, String(target.url || "").replace(/^https?:\/\//, "")),
    target.enabled === false ? [" ", tag("꺼 둠")] : null));
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
  const past = h("span", { class: "muted" }, "확인 중");
  get("/api/backfill/status").then((status) => {
    if (status?.running) {
      const { examined = 0, considered = 0 } = status.running;
      clear(past, `보내는 중 · ${number(examined)}/${number(considered)}`);
    } else if (status?.lastRun?.finishedAt) {
      clear(past, `${ago(status.lastRun.finishedAt)}에 다 보냄`, status.lastRun.failed ? [" ", tag(`${number(status.lastRun.failed)}개 실패`, "warn")] : null);
    } else {
      clear(past, "새 대화만 수집 중");
    }
  }).catch(() => clear(past));
  return block({ title: "대화 수집", tag: tag("켜짐", "ok"), actions: [button("수정", { onClick: openCollect })] },
    kv("서버", serverLine(context)),
    kv("peer 이름", [h("span", { class: "mono" }, context.user?.peerId || ""), context.workspace && context.workspace !== "memory" ? h("span", { class: "muted" }, ` · workspace ${context.workspace}`) : null]),
    kv("에이전트", agents),
    kv("프로젝트 폴더", folderSummary(context.collect)),
    kv("지난 대화", past));
}

/** 대화 수집 → 수정: first setup's steps for this computer, any step one press away. */
function openCollectWindow(onApplied) {
  const context = app.context || {};
  const draft = collectDraft(context);
  let at = 0;
  let steps = [];
  const problem = h("div", {});
  const win = modal({ title: "대화 수집 설정" });

  const build = () => [
    serverStep(draft, context, { peer: !context.configured || !context.user?.peerId, others: Boolean(context.configured) }),
    agentsStep(draft, context),
    projectsStep(draft, context, { edit: context.configured }),
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
    // What was already there is skipped, so this only sends what the new choice adds.
    await post("/api/backfill/start", {}).catch(() => {});
    const failed = await applyTargets(draft);
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
    win.foot(button("취소", { kind: "quiet", onClick: () => win.close() }), [
      at > 0 ? button("이전", { kind: "quiet", onClick: () => goTo(at - 1) }) : null,
      at < steps.length - 1
        ? button("다음", { kind: "primary", onClick: next })
        : button("적용", { kind: "primary", onClick: (event) => apply(event.currentTarget) }),
    ]);
  }
  detectAgents({ fresh: true });
  loadProjects({ fresh: true });
  draw();
  win.open();
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

// ── ChatGPT 기록 ─────────────────────────────────────────

function chatgptBlock(openImport) {
  const held = h("span", { class: "muted" }, "확인 중");
  get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1", source: "chatgpt" })}`)
    .then((result) => {
      const last = app.prefs.chatgptImport?.at;
      clear(held, result?.total ? `${number(result.total)}개` : "없음", last ? ` · ${ago(last)} 가져옴` : "");
    })
    .catch(() => clear(held, "기억 서버에 닿지 않습니다"));
  return block({ title: "ChatGPT 기록", actions: [button("가져오기", { onClick: openImport })] },
    kv("기억에 있는 대화", held));
}

/** A ChatGPT export, read and put into this computer's memory server. */
export function openImportWindow(onApplied) {
  const win = modal({ title: "ChatGPT 기록 가져오기", big: true, small: true });
  const file = h("input", { type: "file", hidden: true, accept: ".zip,.json,application/zip,application/json" });
  const shown = h("span", { class: "muted", style: { fontSize: "12.5px" } }, "고른 파일 없음");
  const result = h("div", {});
  const start = button("가져오기", { kind: "primary", disabled: true });
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    start.disabled = !chosen;
    clear(shown, chosen ? [h("span", { class: "mono" }, chosen.name), ` · ${(chosen.size / 1024 / 1024).toFixed(1)}MB`] : "고른 파일 없음");
    clear(result);
  });
  start.addEventListener("click", () => busy(start, async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    clear(result, h("div", { class: "waitline" }, spinner(), "올리고 읽는 중입니다. 대화가 많으면 몇 분 걸립니다."));
    const response = await fetch("/api/import/chatgpt", { method: "POST", headers: { "content-type": "application/json" }, body: chosen });
    const payload = await response.json().catch(() => ({ ok: false, error: "결과를 읽지 못했습니다." }));
    if (!payload.ok) {
      clear(result, notice("bad", h("b", {}, "가져오지 못했습니다."), ` ${payload.error || ""}`));
      return;
    }
    savePrefs({ chatgptImport: { at: new Date().toISOString(), conversations: payload.conversations ?? 0, newMessages: payload.new_messages ?? 0 } });
    win.close("ok");
    onApplied?.();
    toast(payload.new_messages
      ? `대화 ${number(payload.imported_sessions ?? 0)}개를 가져왔습니다.`
      : "이미 들어 있는 기록이었습니다.", "ok");
  }));
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } }, "ChatGPT의 설정 → 데이터 제어 → 데이터 내보내기로 받은 zip 파일을 고르세요."),
    h("div", { class: "file" }, button("파일 고르기", { kind: "small", onClick: () => file.click() }), shown, file),
    h("p", { class: "hint" }, "zip을 풀지 말고 그대로 고릅니다. 같은 파일을 다시 가져와도 겹쳐 쌓이지 않습니다."),
    result);
  win.foot(null, [button("취소", { kind: "quiet", onClick: () => win.close() }), start]);
  win.open();
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
      tools: () => openToolsWindow(draw),
      import: () => openImportWindow(draw),
    };
    async function draw() {
      const configured = Boolean(app.context?.configured);
      clear(body,
        collectBlock(windows.collect),
        configured ? await toolsBlock(windows.tools) : null,
        configured ? chatgptBlock(windows.import) : null);
    }
    await draw();
    const open = windows[params[0]];
    if (params[0]) history.replaceState(null, "", "#/computer");
    if (open && (params[0] === "collect" || app.context?.configured)) open();
    return null;
  },
};
