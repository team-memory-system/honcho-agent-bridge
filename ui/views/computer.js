// 기억 설정: what this computer does with its own conversations and agents. It
// piles the conversations up in a memory server, and those of chosen projects in
// other servers too, chooses the MCP tools its agents see, and takes in a ChatGPT
// export. Letting the owner's other computers in is 서버 → 공유 (share.js).
import { hub } from "../lib/hub.js";
import { TASKS, chatgptCount, openTask, taskState } from "./connect.js";
import { openTargets, targetsState } from "./targets.js";
import { openTools } from "./tools.js";

const task = (key) => TASKS.find((item) => item.key === key);

export default hub({
  name: "computer",
  title: "기억 설정",
  subtitle: "이 컴퓨터의 대화를 어디에 쌓고, 에이전트가 무엇을 쓸지 정합니다.",
  pages: [
    { ...task("collect"), state: () => taskState("collect"), open: (page, head) => openTask(page, "collect", head) },
    {
      key: "targets",
      title: "다른 서버에도 쌓기",
      why: "고른 프로젝트의 대화를 다른 기억 서버에도 쌓습니다. 회사 서버나 내 다른 서버를 더합니다.",
      state: targetsState,
      open: (page, head) => openTargets(page, head),
    },
    {
      key: "tools",
      title: "MCP 도구",
      why: "이 컴퓨터의 Claude Code·Codex가 쓸 기억 MCP 도구를 켜고 끕니다.",
      open: (page, head) => openTools(page, head),
    },
    { ...task("import"), state: () => taskState("import"), refine: chatgptCount, open: (page, head) => openTask(page, "import", head) },
  ],
});
