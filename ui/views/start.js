// 시작하기: the first run, as a checklist that reads the real state. First pick
// where the memory server lives: on this computer, or on another of the user's
// computers. Either way this computer's Claude Code and Codex conversations go to
// it. Then each step says whether it is done and opens the screen that does it.
import { get, post } from "../lib/api.js";
import { h, clear, copyText } from "../lib/dom.js";
import { ago } from "../lib/format.js";
import { app, go, loadContext, refreshStatus, savePrefs, workspace } from "../lib/state.js";
import { button, busy, pageHead, spinner, tag, toast } from "../lib/ui.js";

// One of two: the memory server goes on this computer, or it is already on another
// of the user's computers. Each carries the prereqs features it needs; conversations
// from here go to the server either way. Teammate memory is not asked here.
const CHOICES = [
  {
    key: "here",
    title: "이 컴퓨터에 기억 서버 만들기",
    text: "이 컴퓨터에 기억 서버를 설치하고, 이 컴퓨터의 Claude Code·Codex 대화를 모읍니다. 내 다른 컴퓨터의 대화도 나중에 이 서버로 모을 수 있습니다. Codex나 Claude 구독이 필요하고, Docker와 Ollama는 없으면 앱이 설치합니다.",
    features: ["server", "sync"],
  },
  {
    key: "remote",
    title: "다른 컴퓨터의 기억 서버에 연결하기",
    text: "내 기억 서버가 있는 다른 컴퓨터로 이 컴퓨터의 Claude Code·Codex 대화를 보냅니다. 주소와 서버 token은 그 컴퓨터의 앱 서버 → 공유에서 받습니다.",
    features: ["sync"],
  },
];

// Turned on after setup, from the screen that does it, never in the first question.
// An item with a `feature` shows only when the choice carries that feature.
const LATER = [
  { title: "팀원 기억 연결", text: "팀원에게 받은 팀 주소를 넣고, 에이전트가 팀원 기억에 묻게 합니다.", screen: "connect/share" },
  { feature: "server", title: "공유", text: "내 다른 컴퓨터가 이 서버로 대화를 보내고, 팀원이 이 기억에 묻게 엽니다.", screen: "server" },
  { title: "회사 서버에도 보내기", text: "정한 폴더의 대화만 다른 기억 서버에도 보냅니다.", screen: "connect/targets" },
  { title: "ChatGPT 기록 가져오기", text: "ChatGPT에서 내보낸 대화를 내 기억 서버에 넣습니다.", screen: "connect/import" },
];

function chosen() {
  return CHOICES.find((choice) => choice.key === app.prefs.startChoice) || null;
}

const NEEDED = { required: ["꼭 필요", ""], "app-installs": ["없으면 앱이 설치", "accent"], optional: ["있으면 좋음", ""] };

function prereqList(items) {
  if (!items.length) return null;
  return h("div", { class: "rows prereqs" }, items.map((item) => {
    const [label, kind] = NEEDED[item.needed] || NEEDED.optional;
    return h("div", { class: "row" },
      h("div", { style: { minWidth: "0" } },
        h("div", { class: "title" }, item.ok ? tag("있음", "ok") : item.needed === "required" ? tag("없음", "bad") : tag("없음"), item.label, item.version ? h("span", { class: "muted mono", style: { fontSize: "12px" } }, item.version) : null, tag(label, kind)),
        item.detail ? h("div", { class: "sub" }, item.detail) : null,
        !item.ok && item.install?.note ? h("div", { class: "sub" }, item.install.note) : null,
      ),
      h("div", { class: "end", style: { flexWrap: "wrap", justifyContent: "flex-end" } },
        !item.ok && item.install?.command ? button("설치 명령 복사", { kind: "small", title: item.install.command, onClick: async () => { await copyText(item.install.command); toast(`복사했습니다: ${item.install.command}`); } }) : null,
        !item.ok && item.install?.url ? h("a", { class: "btn small quiet", href: item.install.url, target: "_blank", rel: "noreferrer" }, "내려받는 곳") : null,
      ),
    );
  }));
}

export default {
  title: "시작하기",
  async mount(page) {
    const body = h("div", { class: "pad" });
    page.append(
      pageHead({ title: "시작하기", subtitle: "기억 서버를 어디에 둘지 고르고, 차례대로 준비합니다." }),
      h("div", { class: "page-body" }, body),
    );

    function drawChoice() {
      const current = chosen();
      clear(body,
        h("p", { class: "section-note", style: { margin: "0 0 16px" } }, "기억 서버를 어디에 둘지 고르세요. 팀원 기억 연결은 준비를 마친 뒤 연결 화면에서 언제든 할 수 있습니다."),
        h("div", { class: "choices two" }, CHOICES.map((choice) => h("button", {
          class: `choice ${choice === current ? "picked" : ""}`,
          type: "button",
          "aria-pressed": choice === current ? "true" : "false",
          onclick: () => { savePrefs({ startChoice: choice.key }); drawSteps(); },
        }, h("b", {}, choice.title), h("span", {}, choice.text)))),
      );
    }

    async function drawSteps() {
      const choice = chosen();
      if (!choice) { drawChoice(); return; }
      const features = choice.features;
      const list = h("div", { class: "steps" }, h("div", { class: "empty" }, spinner()));
      clear(body,
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px", flexWrap: "wrap" } },
          tag(choice.title, "accent"),
          button("다시 고르기", { kind: "small quiet", onClick: drawChoice }),
        ),
        list,
      );
      await loadContext().catch(() => {});
      await refreshStatus();
      const context = app.context;
      const steps = [];
      const serverHere = features.includes("server");

      // Required software first: what the chosen features need, with how to get it.
      const prereqs = await get(`/api/app/prereqs?${new URLSearchParams({ features: features.join(",") })}`).catch((error) => ({ ok: false, error: error.message, items: [] }));
      const missing = (prereqs.items || []).filter((item) => item.needed === "required" && !item.ok);
      steps.push({
        title: "필요한 프로그램",
        done: Boolean(prereqs.ok),
        text: prereqs.error
          ? `확인하지 못했습니다: ${prereqs.error}`
          : prereqs.ok ? "필요한 프로그램이 모두 있습니다." : `${missing.map((item) => item.label).join(", ")}부터 설치하세요. 설치한 뒤 다시 확인을 누릅니다.`,
        body: prereqList(prereqs.items || []),
        action: prereqs.ok ? null : ["다시 확인", "recheck"],
      });

      if (serverHere) {
        const server = await post("/api/server/status", { profile: "personal" }).catch(() => null);
        const gatewayReady = app.status.gateway.state === "on";
        steps.push(
          { title: "기억 서버 준비", done: Boolean(server?.installed), text: server?.installed ? "이 컴퓨터에 설치돼 있습니다." : server && !server.docker?.installed ? "Docker Desktop과 Ollama부터 이 앱이 받아서 설치합니다." : "서버 소스와 게이트웨이를 설치합니다.", action: ["서버 화면에서 준비", () => go("server")] },
          { title: "구독 계정 로그인", done: gatewayReady, text: gatewayReady ? app.status.gateway.text : "기억 서버가 생각할 모델을 쓰려면 Codex나 Claude 계정이 필요합니다.", action: ["게이트웨이에서 로그인", () => go("models/add/codex")] },
          { title: "기억 서버 시작", done: Boolean(server?.running && server?.health?.ok), text: server?.running ? "답하는 중입니다." : "로그인 뒤 서버 화면에서 준비를 한 번 더 누르고 시작합니다.", action: ["서버 화면으로", () => go("server")] },
        );
      }
      steps.push({
        title: "대화 보내기 설정",
        done: Boolean(context?.configured),
        text: context?.configured ? `${[context.agents.claude && "Claude Code", context.agents.codex && "Codex"].filter(Boolean).join("·") || "에이전트 없음"} → ${context.honcho.url}` : serverHere ? "기억 서버로 이 컴퓨터 서버를 고르고, 보낼 에이전트와 내 이름을 정합니다." : "서버를 둔 컴퓨터의 앱 서버 → 공유에서 주소와 서버 token을 받아 넣고, 모을 에이전트를 고릅니다.",
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

      const firstOpen = steps.findIndex((step) => !step.done);
      clear(list, steps.map((step, index) => h("div", { class: `step ${step.done ? "done" : index === firstOpen ? "current" : ""}` },
        h("span", { class: "step-num" }),
        h("div", {},
          h("h3", {}, step.title),
          h("p", {}, step.text),
          step.body || null,
          step.action ? button(step.action[0], {
            kind: `small ${index === firstOpen ? "primary" : ""}`,
            onClick: (event) => step.action[1] === "recheck" ? busy(event.currentTarget, drawSteps) : step.action[1](),
          }) : null,
        ),
      )));
      if (firstOpen === -1 && steps.length) {
        const later = LATER.filter((item) => !item.feature || features.includes(item.feature));
        list.after(
          h("div", { class: "notice ok", style: { marginTop: "16px" } }, h("div", {}, h("b", {}, "준비가 끝났습니다. "), "이제 대화가 끝날 때마다 기억이 쌓입니다.")),
          later.length ? h("div", { class: "rows", style: { marginTop: "16px" } },
            h("p", { class: "section-note", style: { margin: "0 0 8px" } }, "필요하면 나중에 더 켤 수 있습니다."),
            later.map((item) => h("div", { class: "row" },
              h("div", { style: { minWidth: "0" } }, h("div", { class: "title" }, item.title), h("div", { class: "sub" }, item.text)),
              h("div", { class: "end" }, button("열기", { kind: "small quiet", onClick: () => go(item.screen) })),
            )),
          ) : null,
        );
      }
    }

    drawChoice();
  },
};
