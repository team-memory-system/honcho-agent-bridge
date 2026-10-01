// 기록: every call that reached the memory server's MCP bridge, newest first, with
// what was asked. The dashboard reads at most 1000 rows at a time and has no
// cursor, so "더 보기" asks again with a larger limit up to that cap.
import { get } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { fullDate, number } from "../lib/format.js";
import { TOOL_INFO } from "../lib/tools.js";
import { button, busy, details, empty, errorNotice, notice, pageHead, spinner, tag } from "../lib/ui.js";

const STEP = 200;
const CAP = 1000;
const PERIODS = [["1", "1시간"], ["24", "24시간"], ["168", "7일"], ["720", "30일"], ["", "전체 기간"]];
const RESULTS = [["", "모든 결과"], ["ok", "통과"], ["denied", "거부"], ["error", "오류"]];
const STATUS = { ok: ["통과", "ok"], denied: ["거부", "bad"], error: ["오류", "warn"] };

const clock = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
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

function rowKey(row) {
  return row.id != null ? String(row.id) : `${row.at}|${row.tool}|${row.caller}`;
}

export default {
  title: "기록",
  async mount(page) {
    const filters = { hours: "24", status: "", tool: "", caller: "" };
    let limit = STEP;
    let rows = [];
    let summary = {};
    let request = 0;
    const expanded = new Set();
    let bridgeTools = [];

    const select = (options, value, label, onChange) => {
      const control = h("select", { class: "select", "aria-label": label },
        options.map(([key, text]) => h("option", { value: key, selected: key === value ? true : null }, text)));
      control.addEventListener("change", () => onChange(control.value));
      return control;
    };
    const period = select(PERIODS, filters.hours, "기간", (value) => { filters.hours = value; load(); });
    const result = select(RESULTS, filters.status, "결과", (value) => { filters.status = value; load(); });
    const tool = select([["", "모든 도구"]], "", "도구", (value) => { filters.tool = value; load(); });
    const callers = h("datalist", { id: "audit-callers" });
    const caller = h("input", { class: "input", type: "search", list: "audit-callers", placeholder: "호출자 (정확히)", "aria-label": "호출자", autocomplete: "off" });
    caller.addEventListener("change", () => {
      if (caller.value.trim() === filters.caller) return;
      filters.caller = caller.value.trim();
      load();
    });

    const refresh = button("새로 고침", { kind: "quiet", iconName: "refresh", onClick: (event) => busy(event.currentTarget, () => load({ keepLimit: true })) });
    const stats = h("div", { class: "audit-stats" });
    const list = h("div", {}, h("div", { class: "empty" }, spinner()));
    const more = h("div", { class: "audit-more" });

    page.append(
      pageHead({ title: "기록", subtitle: "기억 서버의 MCP 브리지로 들어온 호출을 물은 말 그대로 남깁니다. 거부된 호출도 보입니다.", actions: [refresh] }),
      h("div", { class: "audit-filters" }, period, result, tool, caller, callers),
      h("div", { class: "page-body" }, h("div", { class: "pad wide" }, stats, list, more)),
    );

    function toolOptions() {
      const names = new Set([...(bridgeTools.length ? bridgeTools : Object.keys(TOOL_INFO)), ...rows.map((row) => row.tool).filter(Boolean)]);
      if (filters.tool) names.add(filters.tool);
      clear(tool, h("option", { value: "" }, "모든 도구"),
        [...names].sort().map((name) => h("option", { value: name, selected: name === filters.tool ? true : null }, name)));
    }

    function drawStats() {
      const counts = { ok: summary.ok || 0, denied: summary.denied || 0, error: summary.error || 0 };
      const total = counts.ok + counts.denied + counts.error;
      const span = PERIODS.find(([key]) => key === filters.hours)?.[1] || "";
      const stat = (key, label, value, kind = "") => h("button", {
        type: "button",
        class: `stat ${kind}`,
        "aria-pressed": String(filters.status === key),
        title: key ? `${label}만 보기` : "모든 결과 보기",
        onclick: () => { filters.status = key; result.value = key; load(); },
      }, h("small", {}, label), h("b", { class: "num" }, number(value)));
      clear(stats,
        stat("", `${span} 전체`, total),
        stat("ok", "통과", counts.ok, "ok"),
        stat("denied", "거부", counts.denied, "bad"),
        stat("error", "오류", counts.error, "warn"),
      );
    }

    function entry(row) {
      const [label, kind] = STATUS[row.status] || [row.status || "?", ""];
      const key = rowKey(row);
      const line = h("tr", {
        class: `entry ${row.status || ""}`,
        tabindex: "0",
        "aria-expanded": String(expanded.has(key)),
        title: "눌러서 펼치기",
      },
        h("td", { class: "t-when num", title: fullDate(row.at) }, clock.format(new Date(row.at))),
        h("td", { class: "t-status" }, tag(label, kind)),
        h("td", { class: "t-who" }, row.caller || h("span", { class: "muted" }, "알 수 없음")),
        h("td", { class: "t-tool" }, h("code", { class: "mono" }, row.tool || "")),
        h("td", { class: "t-q" }, row.query_text || h("span", { class: "muted" }, "원문 없음"),
          row.error ? h("div", { class: "err" }, row.error) : null),
      );
      const toggle = (event) => {
        if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
        if (event.type === "click" && window.getSelection()?.toString()) return;
        event.preventDefault();
        if (expanded.has(key)) {
          expanded.delete(key);
          if (line.nextElementSibling?.classList.contains("detail")) line.nextElementSibling.remove();
        } else {
          expanded.add(key);
          line.after(detail(row));
        }
        line.setAttribute("aria-expanded", String(expanded.has(key)));
      };
      line.addEventListener("click", toggle);
      line.addEventListener("keydown", toggle);
      return expanded.has(key) ? [line, detail(row)] : [line];
    }

    function detail(row) {
      const facts = [
        ["언제", `${longDay.format(new Date(row.at))} ${clock.format(new Date(row.at))}`],
        ["누가", [row.caller, row.caller_source ? `(${row.caller_source})` : ""].filter(Boolean).join(" ")],
        ["브리지", row.bridge],
        ["작업공간", row.workspace_id],
        ["걸린 시간", row.duration_ms != null ? `${number(row.duration_ms)}ms` : ""],
        ["판정 점수", row.jev_score != null ? String(row.jev_score) : ""],
      ].filter(([, value]) => value);
      return h("tr", { class: "detail" }, h("td", { colspan: "5" },
        h("div", { class: "audit-detail" },
          h("div", {}, h("div", { class: "k" }, "물은 것"), h("pre", { class: "full" }, row.query_text || "원문 없음")),
          row.error ? h("div", {}, h("div", { class: "k" }, "오류"), h("pre", { class: "full err" }, row.error)) : null,
          h("dl", { class: "facts" }, facts.map(([name, value]) => [h("dt", {}, name), h("dd", {}, value)])),
          row.arguments ? details("보낸 인자 전체", row.arguments) : null,
        ),
      ));
    }

    function drawRows() {
      if (!rows.length) {
        clear(list, empty("조건에 맞는 호출이 없습니다", "기간을 넓히거나 조건을 풀어 보세요."));
        return;
      }
      const body = [];
      let day = "";
      for (const row of rows) {
        const key = dayKey(row.at);
        if (key !== day) {
          day = key;
          body.push(h("tr", { class: "day" }, h("th", { colspan: "5", scope: "rowgroup" }, dayLabel(row.at))));
        }
        body.push(...entry(row));
      }
      clear(list, h("table", { class: "log-table" },
        h("colgroup", {}, h("col", { class: "c-when" }), h("col", { class: "c-status" }), h("col", { class: "c-who" }), h("col", { class: "c-tool" }), h("col", {})),
        h("thead", {}, h("tr", {}, ["시각", "결과", "누가", "도구", "물은 것"].map((label) => h("th", { scope: "col" }, label)))),
        h("tbody", {}, body),
      ));
    }

    function drawMore() {
      if (!rows.length) { clear(more); return; }
      const shown = h("span", { class: "muted" }, `최근 ${number(rows.length)}건`);
      if (rows.length < limit) {
        clear(more, h("span", { class: "muted" }, `조건에 맞는 ${number(rows.length)}건을 모두 보였습니다.`));
      } else if (limit < CAP) {
        clear(more, shown, button(`더 보기 (+${Math.min(STEP, CAP - limit)})`, {
          onClick: (event) => busy(event.currentTarget, async () => {
            limit = Math.min(CAP, limit + STEP);
            await load({ keepLimit: true });
          }),
        }));
      } else {
        clear(more, notice("", h("b", {}, `한 번에 ${number(CAP)}건까지 봅니다.`), " 더 오래된 호출은 기간을 좁히거나 결과·도구·호출자로 걸러서 보세요."));
      }
    }

    function drawUnavailable(node) {
      clear(stats);
      clear(more);
      clear(list, node);
    }

    async function load({ keepLimit = false } = {}) {
      const id = ++request;
      if (!keepLimit) {
        limit = STEP;
        clear(list, h("div", { class: "empty" }, spinner()));
        clear(more);
      }
      const query = new URLSearchParams({ limit: String(limit) });
      for (const name of ["hours", "status", "tool", "caller"]) if (filters[name]) query.set(name, filters[name]);
      try {
        const data = await get(`/api/dashboard/audit?${query}`);
        if (id !== request) return;
        if (data.enabled === false) {
          drawUnavailable(notice("", "조회 기록이 켜져 있지 않습니다. 기억 서버의 브리지에 HONCHO_AUDIT_DSN을 설정하면 남기 시작합니다."));
          return;
        }
        rows = data.rows || [];
        summary = data.summary || {};
        drawStats();
        drawRows();
        drawMore();
        toolOptions();
        clear(callers, [...new Set(rows.map((row) => row.caller).filter(Boolean))].sort().map((name) => h("option", { value: name })));
      } catch (error) {
        if (id !== request) return;
        drawUnavailable(error.unreachable
          ? notice("", "이 컴퓨터에서는 조회 기록에 닿지 않습니다. 기억 서버를 둔 컴퓨터에서 여세요.")
          : errorNotice(error));
      }
    }

    toolOptions();
    get("/api/dashboard/mcp/tools").then((data) => {
      bridgeTools = (data.tools || []).map((item) => item.name).filter(Boolean);
      toolOptions();
    }).catch(() => {});
    await load();
  },
};
