// 시작하기: the first run, as a checklist that reads the real state. First pick
// how this computer takes part, then each step says whether it is done and opens
// the screen that does it.
import { get, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { ago } from "../lib/format.js";
import { app, go, loadContext, refreshStatus, savePrefs, workspace } from "../lib/state.js";
import { button, busy, pageHead, spinner, tag } from "../lib/ui.js";

const PATHS = [
  {
    key: "server",
    title: "서버로 구축하기",
    text: "이 컴퓨터에 내 기억 서버를 만듭니다. 내 대화가 이 컴퓨터에 쌓입니다. 디스크 몇 GB와 Codex나 Claude 구독이 필요합니다. Docker Desktop과 Ollama는 없으면 이 앱이 설치합니다.",
  },
  {
    key: "remote",
    title: "다른 서버와 동기화만 진행",
    text: "이 컴퓨터에는 서버를 두지 않고, 대화를 이미 있는 내 서버로 보냅니다. Docker는 필요 없습니다. 그 서버의 주소와 서버 토큰, 그리고 Cloudflare WARP가 필요합니다.",
  },
  {
    key: "ask-only",
    title: "다른 서버 기억 물어오기",
    text: "내 대화는 모으지 않고, 팀원이 열어 준 창구에 질문만 합니다. 팀원에게 받은 네 값이 필요합니다.",
  },
];

export default {
  title: "시작하기",
  async mount(page) {
    const body = h("div", { class: "pad" });
    page.append(
      pageHead({ title: "시작하기", subtitle: "이 컴퓨터가 팀 메모리에 어떻게 참여할지 고르고, 차례대로 준비합니다." }),
      h("div", { class: "page-body" }, body),
    );

    function drawChoice() {
      clear(body,
        h("p", { class: "section-note", style: { margin: "0 0 16px" } }, "나중에 바꾸려면 기억을 옮겨야 하니 먼저 정합니다. 한 사람에게 기억 서버는 하나면 됩니다."),
        h("div", { class: "choices" }, PATHS.map((path) => h("button", {
          class: `choice ${app.prefs.startPath === path.key ? "picked" : ""}`,
          type: "button",
          onclick: () => { savePrefs({ startPath: path.key }); drawSteps(); },
        }, h("b", {}, path.title), h("span", {}, path.text)))),
      );
      if (app.prefs.startPath) drawSteps();
    }

    async function drawSteps() {
      const choice = PATHS.find((path) => path.key === app.prefs.startPath);
      const list = h("div", { class: "steps" }, h("div", { class: "empty" }, spinner()));
      clear(body,
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" } },
          tag(choice.title, "accent"),
          button("다르게 고르기", { kind: "small quiet", onClick: () => { savePrefs({ startPath: "" }); drawChoice(); } }),
        ),
        list,
      );
      await loadContext().catch(() => {});
      await refreshStatus();
      const context = app.context;
      const steps = [];

      if (choice.key === "server") {
        const server = await post("/api/server/status", { profile: "personal" }).catch(() => null);
        const gatewayReady = app.status.gateway.state === "on";
        steps.push(
          { title: "기억 서버 준비", done: Boolean(server?.installed), text: server?.installed ? "이 컴퓨터에 설치돼 있습니다." : server && !server.docker?.installed ? "Docker Desktop과 Ollama부터 이 앱이 받아서 설치합니다." : "서버 소스와 게이트웨이를 설치합니다.", action: ["서버 화면에서 준비", () => go("server")] },
          { title: "구독 계정 로그인", done: gatewayReady, text: gatewayReady ? app.status.gateway.text : "기억 서버가 생각할 모델을 쓰려면 Codex나 Claude 계정이 필요합니다.", action: ["게이트웨이에서 로그인", () => go("models/add/codex")] },
          { title: "기억 서버 시작", done: Boolean(server?.running && server?.health?.ok), text: server?.running ? "답하는 중입니다." : "로그인 뒤 서버 화면에서 준비를 한 번 더 누르고 시작합니다.", action: ["서버 화면으로", () => go("server")] },
          { title: "다른 컴퓨터에서 쓰게 열기 (선택)", done: Boolean(server?.share?.enabled), text: server?.share?.enabled ? `${server.share.publicUrl}로 열려 있습니다.` : "회사 맥북 같은 다른 컴퓨터의 대화도 여기로 모으려면 Cloudflare 통로를 엽니다. 이 컴퓨터 하나만 쓰면 건너뜁니다.", action: ["서버 화면에서 열기", () => go("server")], optional: true },
        );
      }
      if (choice.key === "server" || choice.key === "remote") {
        steps.push({
          title: "에이전트 대화 수집",
          done: Boolean(context?.configured),
          text: context?.configured ? `${[context.agents.claude && "Claude Code", context.agents.codex && "Codex"].filter(Boolean).join("·") || "에이전트 없음"} → ${context.honcho.url}` : choice.key === "remote" ? "서버 컴퓨터의 서버 → 다른 컴퓨터에서 쓰기에서 주소와 서버 토큰을 받아 넣고, 모을 에이전트를 고릅니다. 이 컴퓨터에서 Cloudflare WARP를 팀 계정으로 켜 두세요." : "내 이름과 모을 에이전트를 고릅니다.",
          action: ["연결 화면에서 설정", () => go("connect/collect")],
        });
        // Only a conversation from an agent this computer collects, after setup, proves it works.
        let latest = null;
        if (context?.configured) {
          const since = context.installedAt ? new Date(context.installedAt) : null;
          const sources = ["claude", "codex"].filter((name) => context.agents[name]);
          const recent = await Promise.all(sources.map((source) => get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1", source })}`).catch(() => null)));
          latest = recent.map((page) => page?.items?.[0]).filter((item) => item && (!since || new Date(item.createdAt) > since))
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
        }
        const fresh = Boolean(latest);
        steps.push({
          title: "첫 기억 확인",
          done: Boolean(fresh),
          text: fresh ? `${ago(latest.createdAt)}에 모인 대화: ${latest.title || "제목 없음"}` : "에이전트를 다시 시작하고 아무 말이나 한 번 주고받은 뒤 확인하세요. Codex는 새 세션에서 훅 승인을 묻습니다.",
          action: fresh ? ["기억 보기", () => go("memory")] : ["다시 확인", "recheck"],
        });
      }
      if (choice.key === "ask-only") {
        const connected = Boolean(context?.sharedBridge?.connected);
        steps.push(
          { title: "공유 창구에 연결", done: connected, text: connected ? context.sharedBridge.url : "창구 주소, 창구 토큰, Cloudflare 서비스 토큰 ID와 비밀을 넣습니다.", action: ["연결 화면에서 넣기", () => go("connect/share")] },
          { title: "에이전트 다시 시작", done: false, text: "Claude Code는 /reload-plugins, Codex는 새 세션을 엽니다. 그러면 에이전트가 창구의 chat 도구로 물어볼 수 있습니다.", action: null },
        );
      }

      const firstOpen = steps.findIndex((step) => !step.done && !step.optional);
      clear(list, steps.map((step, index) => h("div", { class: `step ${step.done ? "done" : index === firstOpen ? "current" : ""}` },
        h("span", { class: "step-num" }),
        h("div", {},
          h("h3", {}, step.title),
          h("p", {}, step.text),
          step.action ? button(step.action[0], {
            kind: `small ${index === firstOpen ? "primary" : ""}`,
            onClick: (event) => step.action[1] === "recheck" ? busy(event.currentTarget, drawSteps) : step.action[1](),
          }) : null,
        ),
      )));
      if (firstOpen === -1 && steps.length) {
        list.after(h("div", { class: "notice ok", style: { marginTop: "16px" } }, h("div", {}, h("b", {}, "준비가 끝났습니다. "), "이제 대화가 끝날 때마다 기억이 쌓입니다.")));
      }
    }

    drawChoice();
  },
};
