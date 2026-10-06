// 기억 설정 → MCP 도구: which tools of this computer's memory MCP server (the
// plugin's) Claude Code and Codex see. Two switches cover them, one for the tools
// that read memory and one for those that change or delete it; each tool's own
// switch sits folded below. Teammates are not asked here: the server's teammate
// MCP answers `chat` alone (server/compose.yaml).
import { get, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { number } from "../lib/format.js";
import { TOOL_GROUPS, TOOL_INFO } from "../lib/tools.js";
import { app } from "../lib/state.js";
import { errorNotice, notice, pageHead, spinner, tag, toggle } from "../lib/ui.js";

const ACCESS = {
  read: ["찾기", ""],
  write: ["바꾸기", "warn"],
  danger: ["지우기", "bad"],
  llm: ["모델 사용", "accent"],
};

function toolRows(tools, onToggle) {
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
          h("div", { class: "title" }, h("code", { class: "mono" }, tool.name), tag(label, kind)),
          h("div", { class: "sub", style: { fontSize: "13px", color: "var(--ink-2)" } }, tool.info.description),
        ),
        h("div", { class: "end" }, toggle(tool.enabled, (next) => onToggle(tool.name, next), { label: `${tool.name} 켜기` })),
      );
    })),
  ));
}

async function drawLocal(local) {
  try {
    const result = await get("/api/app/mcp-tools");
    if (!result.configured) {
      clear(local, notice("", "이 컴퓨터는 아직 대화 쌓기를 켜지 않아 MCP 도구가 없습니다.", app.context?.teamMemory?.connected ? " 팀원 기억은 Claude Code와 Codex에 team-로 시작하는 MCP 서버로 따로 연결돼 있습니다." : ""));
      return;
    }
    let tools = result.tools;
    // The single switches stay unfolded across redraws once someone opened them.
    let unfolded = false;
    const set = async (body) => {
      const next = await post("/api/app/mcp-tools", body);
      tools = next.tools;
      redraw();
    };
    const groupRow = (title, members) => {
      const on = members.filter((tool) => tool.enabled).length;
      return h("div", { class: "row" },
        h("div", {}, h("div", { class: "title" }, title), h("div", { class: "sub" }, `${number(members.length)}개 중 ${number(on)}개 켜짐`)),
        // Mixed counts as off: pressing it turns the whole group on.
        h("div", { class: "end" }, toggle(on === members.length, (enabled) => set({ names: members.map((tool) => tool.name), enabled }), { label: `${title} 모두 켜기` })),
      );
    };
    function redraw() {
      const single = h("details", { class: "raw tool-singles", style: { marginTop: "16px" }, open: unfolded || null },
        h("summary", { class: "muted" }, "하나씩 켜고 끄기"),
        toolRows(tools, (name, enabled) => set({ name, enabled })));
      single.addEventListener("toggle", () => { unfolded = single.open; });
      clear(local,
        h("p", { class: "section-note", style: { marginTop: "0" } }, "바꾼 뒤 Claude Code는 /reload-plugins, Codex는 새 세션을 여세요."),
        h("div", { class: "rows" },
          groupRow("찾기 도구", tools.filter((tool) => !tool.write)),
          groupRow("바꾸기·지우기 도구", tools.filter((tool) => tool.write)),
        ),
        single,
      );
    }
    redraw();
  } catch (error) {
    clear(local, errorNotice(error));
  }
}

/** The switches as their own page. */
export async function openTools(page, head) {
  const box = h("div", {}, spinner());
  page.append(
    pageHead(head),
    h("div", { class: "page-body" }, h("div", { class: "pad" }, box)),
  );
  await drawLocal(box);
}
