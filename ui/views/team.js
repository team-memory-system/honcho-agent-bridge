// 팀: what this memory gives teammates and what this computer takes from theirs.
// With the server here: who may ask it (내 기억 공유) and what they asked. On any
// computer: teammates' memories in this computer's agents. Teammates get `chat`
// alone, fixed in the server's settings, so there are no tool switches here.
import { hub } from "../lib/hub.js";
import { app } from "../lib/state.js";
import audit from "./audit.js";
import { TASKS, openTask, taskState } from "./connect.js";
import { openShare, shareState } from "./share.js";

const task = (key) => TASKS.find((item) => item.key === key);
const serverHere = () => Boolean(app.context?.localServer);

export default hub({
  name: "team",
  title: "팀",
  subtitle: "팀원과 기억을 주고받습니다.",
  pages: [
    {
      key: "share",
      title: "내 기억 공유",
      why: "팀원이 Google로 로그인해 이 기억에 chat으로 묻게 합니다. 팀원 명단과 팀 주소도 여기 있습니다.",
      available: serverHere,
      refine: shareState,
      open: (page, head) => openShare(page, head, "team"),
    },
    {
      key: "audit",
      title: "조회 기록",
      why: "기억 서버의 MCP 브리지로 들어온 호출을 물은 말 그대로 남깁니다. 거부된 호출도 보입니다.",
      available: () => serverHere() || app.auditAnswers,
      open: (page, head) => audit.mount(page, head),
    },
    // The 연결 task is "share"; here it is the other way round from 내 기억 공유.
    { ...task("share"), key: "memories", state: () => taskState("share"), open: (page, head) => openTask(page, "share", head) },
  ],
});
