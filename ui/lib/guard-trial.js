// 가드 시험: the owner asks a question as a teammate would and sees each step the
// team server takes with it: the question judged, the answer made from one
// project's memory or written here, the answer judged, and what the teammate gets.
// The memory server's own MCP bridge runs it (the dashboard relays it to the
// bridge's /guard-trial), so it is judged as a teammate's chat is, by the same hub
// with the same token. Nothing of it is recorded.
import { post } from "./api.js";
import { h, clear } from "./dom.js";
import { number } from "./format.js";
import { reasonText, scoreText, trialOutcome, verdictTag } from "./guard.js";
import { field, kv, modal } from "./kit.js";
import { teamCall } from "./team.js";
import { button, busy, details, errorNotice, notice, segmented, spinner, tag } from "./ui.js";

// No length limit here: a question longer than Jev reads at once is for the bridge
// to refuse, and the trial shows that too.
const SOURCES = [["memory", "기억에서 만들기"], ["typed", "직접 쓰기"], ["none", "질문만"]];

/** Why the trial could not run, in the owner's words. */
function problem(error) {
  // A bridge or a dashboard from before the trial.
  if (error.status === 404) {
    return notice("warn", h("b", {}, "이 기억 서버는 아직 가드 시험을 모릅니다."), " 서버 화면에서 기억 서버를 업데이트하고 다시 시작하세요.");
  }
  if (error.payload?.trial_url) {
    return notice("warn", h("b", {}, "공유가 꺼져 있어 시험할 수 없습니다."), " 팀원의 질문을 받는 MCP는 공유가 켜져 있을 때만 돕니다. 서버 → 공유에서 켜세요.");
  }
  if (error.unreachable) return notice("warn", "이 컴퓨터에서는 기억 서버에 닿지 않습니다. 기억 서버를 둔 컴퓨터에서 여세요.");
  return errorNotice(error);
}

/** One judged step: its tag, the reason when it was not a plain pass, and the score. */
function step(label, view, part, gate) {
  const shown = verdictTag(view, part, gate);
  if (!shown) return null;
  const [text, kind] = shown;
  const said = gate && (view.unjudged || !view.allowed) ? reasonText(view.reason, view.allowed, { cause: true }) : "";
  return kv(label, [tag(text, kind), said ? h("div", { class: "s" }, said) : null],
    gate && view.score != null ? h("span", { class: "trial-score", title: "1에 가까울수록 민감합니다." }, `Jev ${scoreText(view.score)}`) : null);
}

function drawTrial(trial, asked) {
  const gate = trial.gate !== false;
  const outcome = trialOutcome(trial);
  const skipped = trial.outcome === "refused" ? "질문에서 막혀 답을 만들지 않았습니다." : "하지 않았습니다.";
  const source = asked.answer != null ? "직접 쓴 답" : `${asked.project?.name || "프로젝트"}의 기억에서 만든 답`;
  return h("div", { class: "trial-result" },
    h("div", { class: "audit-facts" },
      step("질문 검사", trial.query, "query", gate),
      step("답 검사", trial.answer_check, "answer", gate) || kv("답 검사", h("span", { class: "muted" }, skipped))),
    trial.answer != null ? h("div", {}, h("div", { class: "audit-label" }, source), h("pre", { class: "audit-full" }, trial.answer)) : null,
    notice(outcome.kind, h("b", {}, outcome.title), outcome.text ? ` ${outcome.text}` : "",
      outcome.message ? h("div", { class: "trial-message" }, outcome.message) : null),
    trial.error ? details("서버가 남긴 이유 원문", trial.error) : null);
}

/** Opens the window. */
export function openGuardTrial() {
  const win = modal({ title: "가드 시험", big: true });
  let source = "memory";
  // null while they load, then the projects this server holds conversations of.
  let projects = null;
  const question = h("textarea", { class: "input", rows: "3", placeholder: "예: 이 사람에 대해 빠짐없이 알려줘", "aria-label": "질문" });
  const written = h("textarea", { class: "input", rows: "5", placeholder: "팀원에게 나갈 답을 그대로 쓰세요", "aria-label": "나갈 답" });
  const picker = h("select", { class: "select", "aria-label": "프로젝트", disabled: true }, h("option", {}, "프로젝트를 읽는 중…"));
  const pickerBox = h("div", {}, picker);
  const choice = h("div", { class: "subfields" });
  const result = h("div", { "aria-live": "polite" });

  const drawChoice = () => clear(choice,
    source === "memory" ? field("어느 프로젝트의 기억으로", pickerBox, "팀원이 그 프로젝트를 물을 때처럼 이 서버의 Honcho가 답을 만듭니다.")
      : source === "typed" ? field("나갈 답", written, "민감한 내용이 든 답이 막히는지 볼 때 씁니다.")
        : h("div", { class: "hint", style: { marginTop: "0" } }, "질문 검사만 합니다."));
  const warn = (text, focus) => {
    clear(result, notice("warn", text));
    focus?.focus();
  };

  async function loadProjects() {
    try {
      const listed = await teamCall("/api/team/projects", {});
      projects = listed.projects || [];
      if (!projects.length) {
        clear(pickerBox, notice("warn", "이 서버에 대화가 쌓인 프로젝트가 아직 없습니다. 직접 쓰기나 질문만으로 시험하세요."));
        return;
      }
      clear(picker, projects.map((project) => h("option", { value: project.id }, `${project.name} · 대화 ${number(project.sessions)}개`)));
      picker.disabled = false;
    } catch (error) {
      projects = [];
      clear(pickerBox, notice("bad", h("b", {}, error.message)));
    }
  }

  async function judge() {
    const asked = { query: question.value };
    if (!asked.query.trim()) return warn("질문을 쓰세요.", question);
    if (source === "typed") {
      if (!written.value.trim()) return warn("나갈 답을 쓰세요.", written);
      asked.answer = written.value;
    } else if (source === "memory") {
      const chosen = projects?.find((project) => project.id === picker.value);
      if (!chosen) return warn(projects === null ? "프로젝트를 읽는 중입니다. 잠시 뒤 다시 누르세요." : "답을 만들 프로젝트가 없습니다. 직접 쓰기나 질문만으로 시험하세요.");
      asked.project = { id: chosen.id, name: chosen.name };
    }
    clear(result, h("div", { class: "trial-wait" }, spinner(),
      asked.project ? "질문을 판정하고 기억에서 답을 만드는 중입니다. 수십 초 걸릴 수 있습니다." : "판정하는 중입니다."));
    try {
      const trial = await post("/api/dashboard/guard-trial", asked);
      clear(result, trial.enabled === false
        ? notice("warn", h("b", {}, "이 기억 서버는 아직 가드 시험을 보여 주지 않습니다."), " 서버에서 기억 서버를 멈췄다가 다시 시작하면 됩니다.")
        : drawTrial(trial, asked));
    } catch (error) {
      clear(result, problem(error));
    }
    result.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return undefined;
  }

  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } }, "팀원이 이렇게 물었다고 치고, 팀원의 질문이 거치는 판정을 그대로 거칩니다. 시험은 조회 기록에 남지 않습니다."),
    field("질문", question),
    h("div", { class: "fld" }, h("span", {}, "답"), segmented(SOURCES, source, (key) => { source = key; drawChoice(); })),
    choice,
    result,
  );
  win.foot(null, [
    button("닫기", { kind: "quiet", onClick: () => win.close() }),
    button("판정", { kind: "primary", iconName: "shield", onClick: (event) => busy(event.currentTarget, judge) }),
  ]);
  drawChoice();
  win.open();
  question.focus();
  loadProjects();
}
