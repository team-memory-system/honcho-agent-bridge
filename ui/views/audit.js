// 조회 기록, a menu of its own: every call that reached the memory server's MCP
// bridge, newest first, with what was asked. It is built from the parts the other
// screens use: chips for the result with the period's counts, a list a day as on
// 팀, and a window with all there is about one call. The dashboard reads at most
// 1000 rows at a time and has no cursor, so "더 보기" asks again with a larger limit
// up to that cap.
import { get } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { fullDate, number } from "../lib/format.js";
import { kv, list, listItem, modal } from "../lib/kit.js";
import { button, busy, details, empty, errorNotice, notice, pageHead, spinner, tag } from "../lib/ui.js";

const STEP = 200;
const CAP = 1000;
const PERIODS = [["1", "1시간"], ["24", "24시간"], ["168", "7일"], ["720", "30일"], ["", "전체 기간"]];
const RESULTS = [["", "전체"], ["ok", "통과"], ["denied", "거부"], ["error", "오류"]];
const STATUS = { ok: ["통과", "ok"], denied: ["거부", "bad"], error: ["오류", "warn"] };

const clock = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const seconds = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dayName = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" });
const longDay = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

function dayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return "오늘";
  if (dayKey(date) === dayKey(yesterday)) return "어제";
  const label = dayName.format(date);
  return date.getFullYear() === today.getFullYear() ? label : `${date.getFullYear()}년 ${label}`;
}

/**
 * Why a call was refused, failed or went through without a judgment, in a few
 * words; null for a plain pass. The bridge's own words stay in the call's window.
 */
function reasonOf(row) {
  const error = String(row.error || "").split("\n")[0].trim();
  if (!error) return null;
  if (row.status === "error") return error;
  if (row.status === "denied") {
    if (error === "out of scope") return "사적인 질문으로 판정";
    if (error.startsWith("That project is not open")) return "열지 않은 프로젝트";
    if (error.startsWith("jev unavailable")) return "Jev가 답하지 않아 거부";
    return error;
  }
  if (error.startsWith("not judged")) return "판정 없이 통과 · 팀에 Jev 키 없음";
  if (error.startsWith("jev unavailable")) return "판정 없이 통과 · Jev가 답하지 않음";
  return error;
}

/** The project a teammate asked about: the one named, else the ones open to them. */
function projectOf(row) {
  const args = row.arguments || {};
  if (typeof args.project === "string" && args.project) return args.project;
  return (Array.isArray(args.projects) ? args.projects : []).map((item) => item?.name || item?.id).filter(Boolean).join(", ");
}

function scoreOf(row) {
  return row.jev_score == null ? "" : Number(row.jev_score).toFixed(2);
}

/** Everything the log holds about one call. */
function openCall(row) {
  const [label, kind] = STATUS[row.status] || [row.status || "?", ""];
  const reason = reasonOf(row);
  const project = projectOf(row);
  const at = new Date(row.at);
  const win = modal({ title: "조회 한 건", big: true, small: true });
  win.body(
    h("div", { class: "audit-label" }, "물은 것"),
    h("pre", { class: "audit-full" }, row.query_text || "원문 없음"),
    h("div", { class: "audit-facts" },
      kv("결과", [tag(label, kind), reason ? h("div", { class: "s" }, reason) : null]),
      kv("누가", [row.caller || "알 수 없음", row.caller_source ? h("div", { class: "s" }, row.caller_source) : null]),
      kv("언제", `${longDay.format(at)} ${seconds.format(at)}`),
      project ? kv("프로젝트", project) : null,
      row.jev_score != null ? kv("Jev 점수", [scoreOf(row), h("div", { class: "s" }, "1에 가까울수록 사적인 질문입니다.")]) : null,
      kv("도구", h("span", { class: "mono" }, row.tool || "")),
      row.duration_ms != null ? kv("걸린 시간", `${number(row.duration_ms)}ms`) : null),
    row.error ? details("서버가 남긴 이유 원문", row.error) : null,
    row.arguments ? details("보낸 인자 전체", row.arguments) : null,
  );
  win.foot(null, button("닫기", { kind: "quiet", onClick: () => win.close() }));
  win.open();
}

export default {
  title: "조회 기록",
  async mount(page) {
    const filters = { hours: "24", status: "", tool: "", caller: "" };
    let limit = STEP;
    let rows = [];
    let summary = {};
    let request = 0;
    // Who asked and with which tool, kept across loads, so a filter can be undone.
    const callers = new Set();
    const tools = new Set();

    const select = (label, onChange) => {
      const control = h("select", { class: "select", "aria-label": label });
      control.addEventListener("change", () => onChange(control.value));
      return control;
    };
    const options = (control, choices, value) => clear(control,
      choices.map(([key, text]) => h("option", { value: key, selected: key === value ? true : null }, text)));
    const period = select("기간", (value) => { filters.hours = value; load(); });
    const caller = select("누가", (value) => { filters.caller = value; load(); });
    const tool = select("도구", (value) => { filters.tool = value; load(); });
    options(period, PERIODS, filters.hours);

    const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침", onClick: (event) => busy(event.currentTarget, () => load({ keepLimit: true })) });
    const chips = h("div", { class: "chips" });
    const pickers = h("div", { class: "audit-pickers" });
    const bar = h("div", { class: "audit-bar", hidden: true }, chips, pickers);
    const days = h("div", { class: "audit-days" }, h("div", { class: "empty" }, spinner()));
    const more = h("div", { class: "audit-more" });

    page.append(
      pageHead({ title: "조회 기록", subtitle: "누가 내 기억에 무엇을 물었는지, 거부된 것까지 그대로 남깁니다.", actions: [refresh] }),
      h("div", { class: "page-body" }, h("div", { class: "pad stack" }, bar, days, more)),
    );

    function drawControls() {
      // The period's counts do not follow the person chosen, so they are left off then.
      const counted = !filters.caller;
      const counts = { ok: summary.ok || 0, denied: summary.denied || 0, error: summary.error || 0 };
      counts[""] = counts.ok + counts.denied + counts.error;
      clear(chips, RESULTS.map(([key, label]) => h("button", {
        class: "chip",
        type: "button",
        "aria-pressed": String(filters.status === key),
        onclick: () => { if (filters.status !== key) { filters.status = key; load(); } },
      }, label, counted ? h("span", { class: `chip-n ${key === "denied" && counts.denied ? "bad" : ""}` }, number(counts[key])) : null)));

      options(caller, [["", "모든 사람"], ...[...callers].sort().map((name) => [name, name])], filters.caller);
      options(tool, [["", "모든 도구"], ...[...tools].sort().map((name) => [name, name])], filters.tool);
      // The team server answers `chat` alone; a choice of one tool is no choice.
      clear(pickers, period, callers.size ? caller : null, tools.size > 1 || filters.tool ? tool : null);
      bar.hidden = false;
    }

    function entry(row) {
      const [label, kind] = STATUS[row.status] || [row.status || "?", ""];
      const sub = [row.caller || "알 수 없음", projectOf(row), reasonOf(row), row.jev_score != null ? `Jev ${scoreOf(row)}` : ""].filter(Boolean).join(" · ");
      const item = listItem({
        title: [tag(label, kind), h("span", { class: "audit-q" }, row.query_text || "원문 없음")],
        sub,
        end: h("span", { class: "audit-time", title: fullDate(row.at) }, clock.format(new Date(row.at))),
      });
      item.classList.add("audit-row");
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `${label}: ${row.query_text || "원문 없음"}`);
      item.addEventListener("click", () => { if (!window.getSelection()?.toString()) openCall(row); });
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openCall(row);
      });
      return item;
    }

    function drawRows() {
      if (!rows.length) {
        clear(days, empty("조건에 맞는 호출이 없습니다", "기간을 넓히거나 조건을 풀어 보세요."));
        return;
      }
      const groups = [];
      for (const row of rows) {
        const key = dayKey(row.at);
        if (groups.at(-1)?.key !== key) groups.push({ key, label: dayLabel(row.at), rows: [] });
        groups.at(-1).rows.push(row);
      }
      clear(days, groups.map((group) => list({ title: group.label }, group.rows.map(entry))));
    }

    function drawMore() {
      if (!rows.length) { clear(more); return; }
      if (rows.length < limit) {
        clear(more, h("span", { class: "muted" }, `조건에 맞는 ${number(rows.length)}건을 모두 보였습니다.`));
      } else if (limit < CAP) {
        clear(more, h("span", { class: "muted" }, `최근 ${number(rows.length)}건`), button(`더 보기 (+${Math.min(STEP, CAP - limit)})`, {
          kind: "small",
          onClick: (event) => busy(event.currentTarget, async () => {
            limit = Math.min(CAP, limit + STEP);
            await load({ keepLimit: true });
          }),
        }));
      } else {
        clear(more, notice("", h("b", {}, `한 번에 ${number(CAP)}건까지 봅니다.`), " 더 오래된 호출은 기간을 좁히거나 결과·사람으로 걸러서 보세요."));
      }
    }

    function drawUnavailable(node) {
      // With nothing to filter, the notice takes the bar's place.
      bar.hidden = true;
      clear(more);
      clear(days, node);
    }

    async function load({ keepLimit = false } = {}) {
      const id = ++request;
      if (!keepLimit) {
        limit = STEP;
        clear(days, h("div", { class: "empty" }, spinner()));
        clear(more);
      }
      const query = new URLSearchParams({ limit: String(limit) });
      for (const name of ["hours", "status", "tool", "caller"]) if (filters[name]) query.set(name, filters[name]);
      try {
        const data = await get(`/api/dashboard/audit?${query}`);
        if (id !== request) return;
        if (data.enabled === false) {
          drawUnavailable(notice("", h("b", {}, "이 기억 서버는 아직 조회 기록을 보여 주지 않습니다."), " 서버에서 기억 서버를 멈췄다가 다시 시작하면 보입니다."));
          return;
        }
        rows = data.rows || [];
        summary = data.summary || {};
        for (const row of rows) {
          if (row.caller) callers.add(row.caller);
          if (row.tool) tools.add(row.tool);
        }
        drawControls();
        drawRows();
        drawMore();
      } catch (error) {
        if (id !== request) return;
        // The dashboard names the address it could not reach (audit_url) when the team
        // MCP bridge, which reads the log, is not running: almost always, sharing is off.
        drawUnavailable(error.unreachable
          ? notice("", "이 컴퓨터에서는 조회 기록에 닿지 않습니다. 기억 서버를 둔 컴퓨터에서 여세요.")
          : error.payload?.audit_url
            ? notice("", h("b", {}, "공유가 꺼져 있어 조회 기록을 볼 수 없습니다."), " 서버 → 공유에서 켜면 그동안 남은 기록이 다시 보입니다. 공유가 켜져 있는데도 이렇게 보이면 기억 서버를 다시 시작하세요.")
            : errorNotice(error));
      }
    }

    await load();
  },
};
