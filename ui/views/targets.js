// 내 컴퓨터 → 다른 서버에도 쌓기: other memory servers that also get this
// computer's conversations from chosen projects. Every conversation still goes to
// the user's own server (대화 쌓기). A project is a folder conversations were opened
// in, subfolders included (folderMatches in scripts/targets.mjs), picked from the
// folders this computer's Claude Code and Codex conversations name
// (/api/app/projects). It goes one way: what that server holds does not come back.
import { cli, get, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { pickFolder } from "../lib/folders.js";
import { ago, number } from "../lib/format.js";
import { app, go, loadContext } from "../lib/state.js";
import { button, busy, confirmSheet, errorNotice, notice, pageHead, spinner, tag, toast } from "../lib/ui.js";
import { explainWarning } from "./connect.js";

/** A folder as the screen shows it: the home folder written as ~. */
export function shortPath(folder) {
  return String(folder || "")
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

/** 을 or 를 after a word: by the last syllable when it is Hangul, 를 otherwise. */
function objectParticle(word) {
  const code = String(word).trim().slice(-1).charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? "을" : "를";
}

const baseName = (folder) => shortPath(folder).split(/[\\/]/).filter(Boolean).pop() || shortPath(folder);
const inside = (child, parent) => child !== parent && (child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`));

/** Where 다른 서버에도 쌓기 stands, for the 내 컴퓨터 list. */
export function targetsState() {
  const context = app.context || {};
  const targets = context.targets || [];
  if (!targets.length) return { label: "없음", detail: context.configured ? "" : "대화 쌓기를 켠 뒤에 씁니다" };
  const pending = targets.reduce((sum, target) => sum + (target.pending || 0), 0);
  return {
    label: `${targets.length}곳`,
    kind: "ok",
    detail: [targets.map((target) => target.label || target.id).join(", "), pending ? `기다리는 대화 ${number(pending)}` : null].filter(Boolean).join(" · "),
  };
}

// ── Choosing projects ────────────────────────────────────

let projectsCache = null;
// Rows shown before 더 보기; a search shows every match.
const SHOWN = 40;

/**
 * The projects of this computer's conversations as boxes to tick, `chosen` ticked
 * and on top. A folder that is gone shows when chosen or searched for.
 */
function projectPicker(chosen = []) {
  const picked = new Set(chosen);
  const pinned = [...chosen];
  let projects = [];
  let filter = "";
  let all = false;
  const list = h("div", { class: "project-picks" }, h("div", { class: "picker-empty" }, spinner()));
  const search = h("input", { class: "input", type: "search", placeholder: "프로젝트 찾기", "aria-label": "프로젝트 찾기", hidden: true });
  search.addEventListener("input", () => { filter = search.value.trim().toLowerCase(); draw(); });
  const more = button("다른 폴더 더하기", { kind: "small", iconName: "plus", onClick: async () => {
    const folder = await pickFolder({ title: "쌓을 폴더 고르기" });
    if (!folder) return;
    if (!pinned.includes(folder)) pinned.unshift(folder);
    picked.add(folder);
    draw();
  } });

  const title = (item) => (item.temp ? "임시 폴더" : item.name === "~" ? "홈 폴더" : item.name || baseName(item.path));

  function row(item) {
    const box = h("input", { type: "checkbox", checked: picked.has(item.path) ? true : null });
    box.addEventListener("change", () => { if (box.checked) picked.add(item.path); else picked.delete(item.path); });
    const within = projects.filter((project) => inside(project.path, item.path)).length;
    const notes = [
      item.exists === false ? "지금은 없는 폴더" : null,
      item.folded ? `폴더 ${number(item.folders)}곳 묶음` : null,
      within ? `안의 프로젝트 ${number(within)}개 포함` : null,
    ].filter(Boolean);
    return h("label", { class: "project-pick", title: item.path }, box,
      h("span", { class: "project-main" },
        h("b", {}, title(item)),
        h("small", { class: "mono" }, shortPath(item.path)),
        notes.length ? h("small", { class: "project-notes" }, notes.join(" · ")) : null),
      h("span", { class: "project-meta" },
        item.sessions ? `대화 ${number(item.sessions)}개` : "직접 고른 폴더",
        item.lastAt ? h("small", {}, ago(item.lastAt)) : null),
    );
  }

  function draw() {
    const known = new Map(projects.map((project) => [project.path, project]));
    const items = [
      ...pinned.map((folder) => known.get(folder) || { path: folder, name: baseName(folder) }),
      ...projects.filter((project) => !pinned.includes(project.path)),
    ];
    const matching = filter
      ? items.filter((item) => `${title(item)} ${item.name || ""} ${shortPath(item.path)}`.toLowerCase().includes(filter))
      : items.filter((item) => item.exists !== false || picked.has(item.path));
    const shown = all || filter ? matching : matching.slice(0, SHOWN);
    search.hidden = items.length <= 8;
    clear(list,
      shown.length
        ? shown.map(row)
        : h("div", { class: "picker-empty" }, filter ? "찾는 프로젝트가 없습니다." : "이 컴퓨터의 대화에서 찾은 프로젝트가 없습니다. 다른 폴더 더하기로 고르세요."),
      shown.length < matching.length
        ? h("button", { type: "button", class: "picker-more", onclick: () => { all = true; draw(); } }, `${number(matching.length - shown.length)}개 더 보기`)
        : null,
    );
  }

  (projectsCache || (projectsCache = get("/api/app/projects"))).then((result) => {
    if (result?.ok === false) throw new Error(result.error || "프로젝트를 읽지 못했습니다.");
    projects = result.projects || [];
    draw();
  }).catch((error) => {
    projectsCache = null;
    draw();
    list.prepend(errorNotice(error));
  });

  return {
    root: h("div", { class: "project-box" }, search, list, h("div", { class: "form-actions" }, more)),
    value: () => [...picked],
  };
}

// ── The page ─────────────────────────────────────────────

const STEPS = [
  { key: "server", label: "서버", title: "어느 서버에 쌓을까요?" },
  { key: "projects", label: "프로젝트", title: "어느 프로젝트의 대화를 쌓을까요?" },
  { key: "past", label: "지난 대화", title: "지난 대화도 쌓을까요?" },
  { key: "confirm", label: "확인", title: "이대로 더할까요?" },
];

/** A short id for the server: it names a folder on this computer. */
function targetId(label, taken) {
  const ascii = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const base = /회사/.test(label) ? "company" : ascii || "server";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

function backfillLine(result) {
  return [
    `대화 ${number(result.sent_sessions || 0)}개`,
    `새 메시지 ${number(result.new_messages || 0)}개`,
    result.remaining ? `남은 것 ${number(result.remaining)}개 (다시 누르면 이어서)` : null,
    result.failed ? `실패 ${number(result.failed)}개` : null,
  ].filter(Boolean).join(" · ");
}

function backfillNotice(result) {
  return notice(result.ok ? "ok" : "warn", h("b", {}, result.ok ? "지난 대화를 쌓았습니다." : "지난 대화를 일부만 쌓았습니다."), ` ${backfillLine(result)}`,
    result.stopped ? h("div", {}, "서버가 계속 답하지 않아 멈췄습니다. 서버가 돌아오면 지난 대화 쌓기를 다시 누르세요.") : null,
    result.issues?.length ? h("ul", {}, result.issues.map((issue) => h("li", {}, explainWarning(issue)))) : null);
}

function targetsPage(container) {
  let targets = [];

  async function drawTargets(banner = null) {
    if (!app.context?.configured) {
      clear(container, notice("", "먼저 대화 쌓기를 켜세요."),
        h("div", { class: "form-actions" }, button("대화 쌓기 설정", { kind: "primary", onClick: () => go("computer/collect") })));
      return;
    }
    try {
      targets = (await cli("/api/targets", {})).targets || [];
    } catch (error) {
      clear(container, errorNotice(error));
      return;
    }
    clear(container,
      banner,
      targets.length ? h("div", { class: "rows" }, targets.map(targetRow)) : null,
      targets.length ? h("div", { class: "form-actions" }, button("서버 더하기", { kind: "primary", iconName: "plus", onClick: () => addFlow() })) : addFlow({ inline: true }),
    );
  }
  // The 내 컴퓨터 list counts the servers from the setup it has, so keep that current.
  const refreshContext = () => loadContext().catch(() => {});

  function targetRow(target) {
    const panel = h("div", {});
    const folders = target.folders || [];
    const sent = target.lastSentAt ? `마지막으로 쌓은 때 ${ago(target.lastSentAt)}` : "아직 쌓은 대화 없음";
    const close = () => clear(panel);

    function editProjects() {
      const picker = projectPicker(folders);
      clear(panel, h("div", { class: "panel inline-panel" },
        h("b", {}, "쌓을 프로젝트"),
        picker.root,
        h("div", { class: "form-actions" },
          button("취소", { kind: "quiet", onClick: close }),
          button("저장", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            const chosen = picker.value();
            if (!chosen.length) throw new Error("프로젝트를 하나 이상 고르세요.");
            await cli("/api/targets/set", { id: target.id, folders: chosen });
            await drawTargets();
            refreshContext();
          }, { done: "프로젝트를 바꿨습니다" }) }),
        )));
    }

    function pastConversations() {
      const since = h("input", { class: "input", type: "date", style: { maxWidth: "200px" } });
      const outcome = h("div", {});
      clear(panel, h("div", { class: "panel inline-panel" },
        h("label", { class: "field" }, h("span", {}, "이 날짜부터 (비우면 전부)"), since),
        h("div", { class: "form-actions" },
          button("닫기", { kind: "quiet", onClick: close }),
          button("지난 대화 쌓기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            clear(outcome, h("div", { class: "muted checking" }, spinner(), "지난 대화를 쌓는 중…"));
            const body = { id: target.id };
            if (since.value) body.since = since.value;
            const result = await post("/api/targets/backfill", body);
            clear(outcome, backfillNotice(result));
            refreshContext();
          }) }),
        ),
        outcome));
    }

    return h("div", { class: "target" },
      h("div", { class: "row", style: { alignItems: "flex-start" } },
        h("div", { style: { minWidth: "0" } },
          h("div", { class: "title" }, target.label || target.id, target.enabled ? tag("쌓는 중", "ok") : tag("멈춤"), target.pending ? tag(`기다리는 대화 ${number(target.pending)}`, "warn") : null),
          h("div", { class: "sub mono" }, target.url || ""),
          h("div", { class: "sub", title: folders.join("\n") }, `프로젝트 ${folders.length}개: ${folders.map(baseName).join(", ")}`),
          h("div", { class: "sub" }, [sent, target.hasToken ? "토큰 있음" : null, target.hasAccess ? "Access 서비스 토큰 있음" : null].filter(Boolean).join(" · ")),
        ),
        h("div", { class: "end", style: { flexWrap: "wrap", justifyContent: "flex-end" } },
          button("프로젝트 바꾸기", { kind: "small", onClick: editProjects }),
          button("지난 대화 쌓기", { kind: "small quiet", onClick: pastConversations }),
          button("시험", { kind: "small quiet", onClick: (event) => busy(event.currentTarget, async () => {
            const result = await post("/api/targets/test", { id: target.id });
            clear(panel, result.ok
              ? notice("ok", "서버가 답하고 workspace를 읽을 수 있습니다.")
              : notice("bad", explainWarning(result.health?.error || result.workspace?.error || result.error || "서버가 답하지 않습니다.")));
          }) }),
          button(target.enabled ? "멈추기" : "다시 쌓기", { kind: "small quiet", onClick: (event) => busy(event.currentTarget, async () => {
            await cli("/api/targets/set", { id: target.id, enabled: !target.enabled });
            await drawTargets();
            refreshContext();
          }) }),
          button("", { kind: "small icon-only quiet danger", iconName: "trash", title: "빼기", onClick: async (event) => {
            const name = target.label || target.id;
            const ok = await confirmSheet({ title: `${name}${objectParticle(name)} 뺄까요?`, text: "이제부터 이 서버에 쌓지 않습니다. 이미 쌓인 대화는 그 서버에 그대로 남고, 아직 못 쌓은 대화는 버립니다.", confirm: "빼기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => { await cli("/api/targets/remove", { id: target.id }); await drawTargets(); refreshContext(); }, { done: "뺐습니다" });
          } }),
        ),
      ),
      panel,
    );
  }

  /** Adding a server, one step at a time. Inline when it is the first one. */
  function addFlow({ inline = false } = {}) {
    const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
    const wide = (label, input, hint) => h("label", { class: "field wide" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
    const inputs = {
      label: h("input", { class: "input", placeholder: "예: 회사" }),
      url: h("input", { class: "input", type: "url", required: true, placeholder: "https://…" }),
      apiToken: h("input", { class: "input", type: "password", autocomplete: "off" }),
      workspace: h("input", { class: "input", placeholder: app.context?.workspace || "memory" }),
      userPeer: h("input", { class: "input", placeholder: app.context?.user?.peerId || "" }),
      accessClientId: h("input", { class: "input", type: "password", autocomplete: "off" }),
      accessClientSecret: h("input", { class: "input", type: "password", autocomplete: "off" }),
      since: h("input", { class: "input", type: "date", style: { maxWidth: "200px" } }),
    };
    const serverStep = h("div", { class: "form-grid" },
      field("이름", inputs.label),
      field("서버 주소", inputs.url),
      wide("서버 토큰", inputs.apiToken, "그 서버를 둔 컴퓨터의 다른 컴퓨터 붙이기 → 서버 token 복사로 받습니다. 회사 서버면 관리자에게 받습니다."),
      h("details", { class: "field wide access-fields" },
        h("summary", {}, "그 서버의 workspace·peer 이름, Cloudflare Access 서비스 토큰"),
        h("div", { class: "form-grid" },
          field("workspace", inputs.workspace, "비우면 내 서버와 같게 둡니다."),
          field("peer 이름", inputs.userPeer, "비우면 내 서버와 같게 둡니다."),
          field("Access 서비스 토큰 ID", inputs.accessClientId),
          field("Access 서비스 토큰 비밀", inputs.accessClientSecret),
        ),
      ),
    );
    const picker = projectPicker([]);
    let past = "none";
    const pastCards = {};
    const dateField = field("이 날짜부터 (비우면 전부)", inputs.since);
    const setPast = (value) => {
      past = value;
      dateField.hidden = past !== "since";
      for (const [key, card] of Object.entries(pastCards)) {
        card.classList.toggle("picked", key === past);
        card.setAttribute("aria-pressed", String(key === past));
      }
    };
    const pastCard = (key, title, text) => {
      pastCards[key] = h("button", { type: "button", class: "choice", onclick: () => setPast(key) }, h("b", {}, title), h("span", {}, text));
      return pastCards[key];
    };
    const pastStep = h("div", {},
      h("div", { class: "choices two" },
        pastCard("none", "지금부터만", "더한 뒤 끝나는 대화부터 쌓습니다."),
        pastCard("since", "지난 대화도", "고른 프로젝트의 지난 대화도 쌓습니다. 한 번에 500개까지 쌓고, 남으면 지난 대화 쌓기로 이어서 쌓습니다.")),
      h("div", { style: { marginTop: "12px" } }, dateField));
    setPast("none");

    const panes = { server: serverStep, projects: picker.root, past: pastStep };
    let at = 0;
    const stepper = h("ol", { class: "stepper" });
    const stage = h("div", { class: "stage" });
    const pane = h("div", {});
    const problem = h("div", {});
    const actions = h("div", { class: "form-actions" });
    const flow = h("div", { class: "panel flow" }, stepper, stage, pane, problem, actions);

    const chosenLabel = () => inputs.label.value.trim() || "회사";
    const stepOk = (key) => {
      clear(problem);
      if (key === "server" && !inputs.url.checkValidity()) { inputs.url.reportValidity(); return false; }
      if (key === "projects" && !picker.value().length) { clear(problem, notice("warn", "프로젝트를 하나 이상 고르세요.")); return false; }
      return true;
    };
    const goTo = (index) => { at = index; draw(); };

    function summary() {
      const folders = picker.value();
      return h("dl", { class: "facts chosen" },
        h("dt", {}, "서버"), h("dd", {}, `${chosenLabel()} · `, h("code", { class: "mono" }, inputs.url.value.trim()), button("바꾸기", { kind: "small quiet", onClick: () => goTo(0) })),
        h("dt", {}, "프로젝트"), h("dd", { title: folders.join("\n") }, `${folders.length}개: ${folders.map(baseName).join(", ")}`, button("바꾸기", { kind: "small quiet", onClick: () => goTo(1) })),
        h("dt", {}, "지난 대화"), h("dd", {}, past === "none" ? "쌓지 않음" : inputs.since.value ? `${inputs.since.value}부터 쌓음` : "전부 쌓음", button("바꾸기", { kind: "small quiet", onClick: () => goTo(2) })),
      );
    }

    async function add(control) {
      const label = chosenLabel();
      const id = targetId(label, new Set(targets.map((target) => target.id)));
      const body = { id, label, url: inputs.url.value.trim(), folders: picker.value() };
      for (const key of ["workspace", "userPeer", "apiToken", "accessClientId", "accessClientSecret"]) if (inputs[key].value.trim()) body[key] = inputs[key].value.trim();
      await busy(control, async () => {
        const result = await post("/api/targets/add", body);
        if (!result.ok) {
          clear(problem, notice("bad", h("b", {}, "더하지 못했습니다."), h("ul", {}, (result.issues || [result.error]).filter(Boolean).map((issue) => h("li", {}, explainWarning(issue))))));
          return;
        }
        const warnings = result.warnings?.length ? h("ul", {}, result.warnings.map((warning) => h("li", {}, explainWarning(warning)))) : null;
        let pastOutcome = null;
        if (past === "since") {
          clear(problem, h("div", { class: "muted checking" }, spinner(), "지난 대화를 쌓는 중…"));
          const backfill = await post("/api/targets/backfill", { id, ...(inputs.since.value ? { since: inputs.since.value } : {}) }).catch((error) => ({ ok: false, issues: [error.message] }));
          pastOutcome = backfillNotice(backfill);
        }
        refreshContext();
        await drawTargets(h("div", { style: { marginBottom: "16px" } }, notice("ok", h("b", {}, `${label}에도 쌓습니다.`), warnings), pastOutcome));
      });
    }

    function draw() {
      const step = STEPS[at];
      clear(problem);
      clear(stepper, STEPS.map((item, index) => {
        const inner = [h("span", { class: "n" }, index < at ? "✓" : String(index + 1)), h("span", {}, item.label)];
        return h("li", { class: index < at ? "done" : "", "aria-current": index === at ? "step" : null },
          index < at ? h("button", { type: "button", onclick: () => goTo(index) }, inner) : inner);
      }));
      clear(stage, h("h3", {}, step.title));
      clear(pane, step.key === "confirm" ? summary() : panes[step.key]);
      const addButton = button("더하기", { kind: "primary", onClick: (event) => add(event.currentTarget) });
      clear(actions,
        at > 0 ? button("이전", { onClick: () => goTo(at - 1) }) : inline ? null : button("취소", { kind: "quiet", onClick: () => drawTargets() }),
        step.key === "confirm" ? addButton : button("다음", { kind: "primary", onClick: () => { if (stepOk(step.key)) goTo(at + 1); } }),
      );
      if (step.key === "server") inputs.url.focus({ preventScroll: true });
    }

    draw();
    if (inline) return flow;
    clear(container, flow);
    return flow;
  }

  clear(container, h("div", { class: "empty" }, spinner()));
  return drawTargets();
}

/** The page, under a header with the way back to 내 컴퓨터. */
export async function openTargets(page, head) {
  // Projects found once per visit, so a folder worked in since shows up.
  projectsCache = null;
  const body = h("div", { class: "pad" });
  page.append(pageHead(head), h("div", { class: "page-body" }, body));
  await targetsPage(body);
}
