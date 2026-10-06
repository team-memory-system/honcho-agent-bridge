// 내 컴퓨터: what this computer does with its own conversations and agents. It
// sends the conversations to a memory server, chooses the memory tools its agents
// see, lets the owner's other computers in when the server is here, and takes in
// a ChatGPT export.
import { hub } from "../lib/hub.js";
import { app } from "../lib/state.js";
import { TASKS, chatgptCount, openTask, taskState } from "./connect.js";
import { openShare, shareState } from "./share.js";
import { openTools } from "./tools.js";

const task = (key) => TASKS.find((item) => item.key === key);

export default hub({
  name: "computer",
  title: "내 컴퓨터",
  subtitle: "이 컴퓨터의 대화를 어디에 쌓고, 에이전트가 무엇을 쓸지 정합니다.",
  pages: [
    { ...task("collect"), state: () => taskState("collect"), open: (page, head) => openTask(page, "collect", head) },
    {
      key: "tools",
      title: "에이전트 도구",
      why: "이 컴퓨터의 Claude Code·Codex가 쓸 MCP 기억 도구를 켜고 끕니다.",
      open: (page, head) => openTools(page, head, "local"),
    },
    {
      key: "share",
      title: "다른 컴퓨터 붙이기",
      why: "내 다른 컴퓨터의 대화도 이 컴퓨터의 기억 서버에 쌓이게 엽니다.",
      available: () => Boolean(app.context?.localServer),
      refine: shareState,
      open: (page, head) => openShare(page, head, "computer"),
    },
    { ...task("import"), state: () => taskState("import"), refine: chatgptCount, open: (page, head) => openTask(page, "import", head) },
  ],
});
