// 내 컴퓨터 → MCP 도구: which tools of this computer's memory MCP server (the
// plugin's) Claude Code and Codex see, as switches. Teammates are not asked here:
// the server's teammate MCP answers `chat` alone (server/compose.yaml).
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
          tool.info.offImpact ? h("div", { class: "sub" }, `끄면: ${tool.info.offImpact}`) : null,
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
    const redraw = () => clear(local,
      h("p", { class: "section-note", style: { marginTop: "0" } }, "기억을 바꾸거나 지우는 도구는 처음에 꺼져 있습니다. 바꾸면 에이전트가 다음에 도구 목록을 물을 때 반영됩니다."),
      h("p", { class: "muted", style: { fontSize: "12.5px", margin: "0 0 4px" } }, `${number(tools.filter((tool) => tool.enabled).length)}/${tools.length}개 켜짐 · ${result.path}`),
      toolRows(tools, async (name, enabled) => {
        const next = await post("/api/app/mcp-tools", { name, enabled });
        tools = next.tools;
      }),
    );
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
