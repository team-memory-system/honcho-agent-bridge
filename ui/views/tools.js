// 도구·기록: which memory tools agents may call, and a record of what they asked.
// Two sets of switches: this computer's plugin (what this computer's agents see),
// and the server's bridge (what a teammate on the shared window sees).
import { get, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { fullDate, number, relativeDay } from "../lib/format.js";
import { TOOL_GROUPS, TOOL_INFO } from "../lib/tools.js";
import { app } from "../lib/state.js";
import { button, busy, empty, errorNotice, notice, pageHead, section, spinner, tag, toggle } from "../lib/ui.js";

const ACCESS = {
  read: ["찾기", ""],
  write: ["바꾸기", "warn"],
  danger: ["지우기", "bad"],
  llm: ["모델 사용", "accent"],
};

function toolRows(tools, onToggle, { locked = () => false } = {}) {
  const byGroup = new Map(TOOL_GROUPS.map((group) => [group, []]));
  for (const tool of tools) {
    const info = TOOL_INFO[tool.name] || { group: "기타", access: tool.write ? "write" : "read", description: "" };
    if (!byGroup.has(info.group)) byGroup.set(info.group, []);
    byGroup.get(info.group).push({ ...tool, info });
  }
  return [...byGroup].filter(([, items]) => items.length).map(([group, items]) => h("div", { class: "tool-group" },
    h("div", { class: "group-label", style: { padding: "14px 2px 6px" } }, group, h("small", {}, `${items.filter((tool) => tool.enabled).length}/${items.length} 켜짐`)),
    h("div", { class: "rows", style: { borderTop: "0" } }, items.map((tool) => {
      const [label, kind] = ACCESS[tool.info.access] || ACCESS.read;
      return h("div", { class: "row" },
        h("div", {},
          h("div", { class: "title" }, h("code", { class: "mono" }, tool.name), tag(label, kind), tool.pinned ? tag("설정 파일에서 꺼 둠") : null),
          h("div", { class: "sub", style: { fontSize: "13px", color: "var(--ink-2)" } }, tool.info.description),
          tool.info.offImpact ? h("div", { class: "sub" }, `끄면: ${tool.info.offImpact}`) : null,
        ),
        h("div", { class: "end" }, toggle(tool.enabled, (next) => onToggle(tool.name, next), { label: `${tool.name} 켜기`, disabled: locked(tool) })),
      );
    })),
  ));
}

export default {
  title: "도구·기록",
  async mount(page, params) {
    const body = h("div", { class: "pad" });
    page.append(
      pageHead({ title: "도구·기록", subtitle: "에이전트가 쓸 수 있는 기억 도구를 켜고 끄고, 누가 무엇을 물었는지 봅니다." }),
      h("div", { class: "page-body" }, body),
    );
    const local = h("div", {}, spinner());
    const shared = h("div", {}, spinner());
    const audit = h("div", {});
    clear(body,
      section({ id: "local", title: "이 컴퓨터의 에이전트", note: "이 컴퓨터의 Claude Code·Codex가 보는 도구입니다. 기억을 바꾸거나 지우는 도구는 처음에 꺼져 있습니다. 바꾸면 에이전트가 다음에 도구 목록을 물을 때 반영됩니다." }, local),
      section({ id: "shared", title: "기억 서버의 브리지", note: "기억 서버에 붙은 MCP 브리지가 내주는 도구입니다. 팀원에게 공유 창구를 열었다면 보통 chat 하나만 켜 둡니다." }, shared),
      section({ id: "audit", title: "조회 기록", note: "브리지로 들어온 모든 호출을 질의 원문과 함께 남깁니다. 거부된 호출도 여기서 보입니다." }, audit),
    );
    if (params[0]) setTimeout(() => document.getElementById(params[0])?.scrollIntoView({ block: "start" }), 50);

    async function drawLocal() {
      try {
        const result = await get("/api/app/mcp-tools");
        if (!result.configured) {
          clear(local, notice("", "이 컴퓨터는 아직 대화 수집을 설정하지 않아 플러그인 도구를 쓰지 않습니다.", app.context?.sharedBridge?.connected ? " 공유 창구에 연결돼 있어 그 창구의 도구를 씁니다." : ""));
          return;
        }
        let tools = result.tools;
        const redraw = () => clear(local,
          h("p", { class: "muted", style: { fontSize: "12.5px", margin: "0 0 4px" } }, `${number(tools.filter((tool) => tool.enabled).length)}/${tools.length}개 켜짐 · ${result.path}`),
          toolRows(tools, async (name, enabled) => {
            const next = await post("/api/app/mcp-tools", { name, enabled });
            tools = next.tools;
          }, { locked: (tool) => tool.pinned }),
        );
        redraw();
      } catch (error) {
        clear(local, errorNotice(error));
      }
    }

    async function drawShared() {
      try {
        const result = await get("/api/dashboard/mcp/tools");
        if (typeof result !== "object" || !result) throw new Error("기억 서버의 관리 기능이 도구 목록을 내주지 않았습니다.");
        let tools = result.tools || [];
        clear(shared,
          result.bridge_running === false ? notice("warn", "브리지가 멈춰 있습니다. 바꾼 설정은 브리지가 다시 켜질 때 적용됩니다.") : null,
          h("p", { class: "muted", style: { fontSize: "12.5px", margin: "8px 0 4px" } }, `${number(result.enabled_count ?? tools.filter((tool) => tool.enabled).length)}/${number(result.total_count ?? tools.length)}개 켜짐`),
          toolRows(tools, async (name, enabled) => {
            const next = await post("/api/dashboard/mcp/tools", { name, enabled });
            tools = next.tools || tools;
          }),
        );
      } catch (error) {
        clear(shared, error.unreachable
          ? notice("", "이 컴퓨터에서는 기억 서버의 관리 기능에 닿지 않습니다. 서버를 둔 컴퓨터에서 여세요.")
          : errorNotice(error));
      }
    }

    function drawAudit() {
      const filters = { hours: "24", status: "", tool: "", caller: "" };
      const list = h("div", {});
      const hours = h("select", { class: "select", style: { width: "auto" }, "aria-label": "기간" },
        [["1", "1시간"], ["24", "24시간"], ["168", "7일"], ["720", "30일"]].map(([value, label]) => h("option", { value, selected: value === filters.hours ? true : null }, label)));
      const status = h("select", { class: "select", style: { width: "auto" }, "aria-label": "결과" },
        [["", "모든 결과"], ["ok", "통과"], ["denied", "거부"], ["error", "오류"]].map(([value, label]) => h("option", { value }, label)));
      const caller = h("input", { class: "input", placeholder: "누가 (호출자)", style: { width: "160px" } });
      const run = async () => {
        clear(list, h("div", { class: "empty" }, spinner()));
        const query = new URLSearchParams({ limit: "200", hours: hours.value });
        if (status.value) query.set("status", status.value);
        if (caller.value.trim()) query.set("caller", caller.value.trim());
        try {
          const data = await get(`/api/dashboard/audit?${query}`);
          if (typeof data !== "object" || !data) { clear(list, notice("", "이 기억 서버의 관리 기능은 예전 판이라 조회 기록을 내주지 않습니다. 서버를 다시 준비하면 생깁니다.")); return; }
          if (data.enabled === false) { clear(list, notice("", "조회 기록이 켜져 있지 않습니다. 기억 서버의 브리지에 HONCHO_AUDIT_DSN을 설정하면 남기 시작합니다.")); return; }
          const rows = data.rows || [];
          const summary = data.summary || {};
          clear(list,
            h("p", { class: "muted", style: { fontSize: "12.5px" } }, `통과 ${number(summary.ok || 0)} · 거부 ${number(summary.denied || 0)} · 오류 ${number(summary.error || 0)}`),
            rows.length ? h("table", { class: "grid" },
              h("thead", {}, h("tr", {}, ["언제", "결과", "누가", "도구", "물은 것"].map((label) => h("th", {}, label)))),
              h("tbody", {}, rows.map((row) => h("tr", {},
                h("td", { title: fullDate(row.at), class: "num" }, relativeDay(row.at)),
                h("td", {}, row.status === "ok" ? tag("통과", "ok") : row.status === "denied" ? tag("거부", "bad") : tag("오류", "warn")),
                h("td", {}, row.caller || "", row.bridge ? h("div", { class: "muted", style: { fontSize: "12px" } }, row.bridge) : null),
                h("td", {}, h("code", { class: "mono" }, row.tool || "")),
                h("td", { class: "clip", title: row.query_text || "" }, row.query_text || h("span", { class: "muted" }, "원문 없음"), row.error ? h("div", { class: "muted", style: { fontSize: "12px" } }, row.error) : null),
              ))),
            ) : empty("조건에 맞는 호출이 없습니다"),
          );
        } catch (error) {
          clear(list, error.unreachable ? notice("", "이 컴퓨터에서는 조회 기록에 닿지 않습니다. 기억 서버를 둔 컴퓨터에서 여세요.") : errorNotice(error));
        }
      };
      for (const control of [hours, status]) control.addEventListener("change", run);
      caller.addEventListener("keydown", (event) => { if (event.key === "Enter") run(); });
      clear(audit, h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" } }, hours, status, caller, button("보기", { kind: "small", onClick: run })), list);
      run();
    }

    drawAudit();
    await Promise.all([drawLocal(), drawShared()]);
  },
};
