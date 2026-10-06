// 서버 → 기억 서버: the memory server on this computer. Install it, start and stop
// it, and check it end to end. The models it uses, the subscription gateway and the
// Ollama embedding model, are the 모델 tab (models.js). Building or restarting it
// is a deployment, so every button that does that says so first. Sharing it lives
// under 내 컴퓨터 and 팀 (share.js).
import { cli, gateway, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { screenTabs } from "../lib/hub.js";
import { api, app, go, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, confirmSheet, details, errorNotice, notice, pageHead, section, spinner, statusTag, tag } from "../lib/ui.js";

const CHECK_NAMES = {
  status: "서버와 컨테이너",
  embedding: "임베딩 모델(Ollama)",
  containerHost: "컨테이너에서 게이트웨이·Ollama로 가는 길",
  honcho: "기억 서버 응답",
  completion: "모델 응답",
};

// What `server plan` lists, in the words of this screen. The CLI's notes are English.
function planStep(op) {
  const size = /qwen3-embedding:(\w+)/.exec(op.note || "")?.[1];
  switch (op.type) {
    case "install-docker-desktop": return "Docker Desktop 받아서 설치하기 (약 600MB). 처음 켤 때 Docker 창에서 약관 동의와 암호 입력이 한 번 필요함";
    case "install-ollama": return "Ollama 받기 (이 앱이 따로 관리, 관리자 권한 필요 없음)";
    case "start-docker-desktop": return "Docker Desktop을 켜고 엔진이 뜰 때까지 기다리기";
    case "fetch-honcho-source": return `Honcho 소스 받기 (${op.repo}, ${String(op.ref || "").slice(0, 7)})`;
    case "fetch-gateway-source": return `구독 게이트웨이 받기 (${op.repo}, ${String(op.ref || "").slice(0, 7)})`;
    case "update-gateway-source": return `구독 게이트웨이를 고정된 버전으로 바꾸기 (${String(op.ref || "").slice(0, 7)})`;
    case "gateway-install": return "게이트웨이 설치: 필요한 패키지, 로그인할 때 자동 시작, 게이트웨이 화면";
    case "gateway-connect": return "게이트웨이에 라우터 주소와 키 묻기. Codex나 Claude 계정이 로그인돼 있지 않으면 여기서 멈춤";
    case "write-environment": return "서버 설정(.env)에 라우터 주소·키·대화 정리 모델 쓰기. 임베딩은 이 컴퓨터의 Ollama가 맡음";
    case "install-bundle": return `서버 파일 놓기 (${op.destination})`;
    case "prepare-ollama": return `임베딩 모델 받기: Qwen3-Embedding${size ? ` ${size.toUpperCase()}` : ""}, 한 번에 8192 토큰까지 읽도록 설정`;
    default: return op.note || op.type.replace(/-/g, " ");
  }
}

const WARNING_WORDS = [
  [/^Port (\d+) is already used by another program; the (Honcho API|dashboard) will use (\d+)$/, (m) => `${m[1]}번 포트를 다른 프로그램이 쓰고 있어 ${m[2] === "dashboard" ? "대시보드" : "Honcho API"}는 ${m[3]}번을 씁니다.`],
  [/^Honcho source will be downloaded from (\S+)/, (m) => `Honcho 소스를 ${m[1]}에서 받습니다.`],
  [/^Subscription gateway source will be (replaced from|downloaded from) (\S+)/, (m) => `구독 게이트웨이를 ${m[2]}에서 ${m[1].startsWith("replaced") ? "다시 받습니다" : "받습니다"}.`],
  [/^Docker Desktop is not running/, () => "Docker Desktop이 꺼져 있어 준비할 때 켭니다."],
  [/^Docker Desktop is not installed; server prepare downloads it from (\S+)/, (m) => `Docker Desktop이 없어서 준비할 때 받아 설치합니다 (${m[1]}). 설치 뒤 Docker 창이 뜨면 약관에 동의하고 권장 설정을 고르세요. macOS가 암호를 묻습니다.`],
  [/^Ollama is not installed; server prepare downloads it from (\S+) into (.+?) and checks it against/, (m) => `Ollama가 없어서 준비할 때 받습니다 (${m[1]}). ${m[2]}에 두고, 받은 파일이 맞는지 공개된 체크섬으로 확인합니다.`],
  [/^Docker Desktop is free for/, () => "Docker Desktop은 개인, 교육, 비영리 오픈소스, 작은 회사(직원 250명 미만이고 연 매출 1천만 달러 미만)에서는 무료입니다. 그보다 큰 회사나 정부 기관에서는 유료 구독이 필요합니다."],
  [/was not fetched by this installer/, () => "게이트웨이 폴더를 이 설치기가 받은 것이 아니라서 바꾸지 않고 그대로 씁니다."],
];

function planWords(text) {
  for (const [pattern, words] of WARNING_WORDS) {
    const match = pattern.exec(text);
    if (match) return words(match);
  }
  return text;
}

function planView(plan) {
  if (!plan.ready) {
    return notice("bad", h("b", {}, "지금은 설치할 수 없습니다."), h("ul", {}, (plan.issues || [plan.error]).filter(Boolean).map((issue) => h("li", {}, planWords(issue)))));
  }
  return notice("", h("b", {}, "이 순서로 준비합니다."),
    h("ol", {}, (plan.operations || []).map((op) => h("li", {}, planStep(op)))),
    plan.warnings?.length ? h("ul", { class: "muted" }, plan.warnings.map((warning) => h("li", {}, planWords(warning)))) : null,
    plan.apiUrl ? h("div", { class: "muted" }, `서버 주소는 ${plan.apiUrl}가 됩니다.`) : null,
  );
}

const NEXT_ACTIONS = {
  "docker-first-run": ["Docker Desktop 창에서 처음 설정을 마쳐 주세요.", navigator.platform?.startsWith("Mac")
    ? "화면에 뜬 Docker Desktop 창에서 약관에 동의하고 권장 설정을 고르세요. macOS가 암호를 묻습니다. Docker가 엔진이 켜졌다고 하면 아래에서 이어서 준비를 누르세요."
    : "화면에 뜬 Docker Desktop 창에서 약관에 동의하고 처음 설정을 마치세요. 엔진이 켜졌다고 하면 아래에서 이어서 준비를 누르세요."],
  "restart-required": ["Windows를 다시 시작해야 합니다.", "Docker Desktop이 쓰는 WSL 2를 마저 설치하려면 다시 시작이 필요합니다. 다시 켠 뒤 이 앱을 열고 이어서 준비를 누르세요."],
  "docker-install-approval": ["관리자 허락이 필요합니다.", "Docker Desktop을 설치하려면 Windows가 묻는 창에서 예를 눌러야 합니다. 이어서 준비를 다시 누르세요."],
};

function prepareOutcome(result) {
  const action = NEXT_ACTIONS[result.nextAction?.kind];
  if (action) return notice("warn", h("b", {}, action[0]), h("div", {}, action[1]));
  if (result.nextAction?.kind === "gateway-login") {
    return notice("warn", h("b", {}, "구독 계정 로그인이 필요합니다."),
      h("div", {}, "기억 서버가 생각할 모델을 쓰려면 Codex나 Claude 계정이 있어야 합니다. 아래 “게이트웨이에 구독 계정 로그인” 단계에서 로그인한 뒤 “기억 서버 준비”를 누르세요."),
      h("div", { class: "form-actions" }, button("게이트웨이에서 로그인", { kind: "primary small", onClick: () => go("models") })));
  }
  if (result.issues?.length) return notice("bad", h("b", {}, "준비하지 못했습니다."), h("ul", {}, result.issues.map((issue) => h("li", {}, issue))), result.next ? h("div", {}, result.next) : null);
  if (result.ok && result.ready !== false) {
    return notice(result.share?.profileDropped ? "warn" : "ok", h("b", {}, "준비했습니다."), result.chatModel ? ` 모델은 ${result.chatModel}입니다.` : "", " 이제 시작할 수 있습니다.",
      result.share?.profileDropped ? h("div", {}, "예전 판에서 켠 공유는 꺼 두었습니다. 팀 → 내 기억 공유에서 다시 켜세요.") : null);
  }
  return notice("warn", h("b", {}, "끝나지 않았습니다."), result.next || result.error || "");
}

export default {
  title: "서버",
  async mount(page) {
    const body = h("div", { class: "pad" });
    const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침" });
    page.append(
      pageHead({ title: "서버", subtitle: "기억을 보관하는 서버를 켜고 끄고, 끝에서 끝까지 점검합니다.", actions: [refresh], subnav: screenTabs("server") }),
      h("div", { class: "page-body" }, body),
    );

    const outcome = h("div", {});
    let planCache = null;
    // The install steps stay open across redraws once someone opened them.
    let installOpen = false;

    async function draw() {
      clear(body, h("div", { class: "empty" }, spinner()));
      const [status, gatewayStatus] = await Promise.allSettled([
        post("/api/server/status", { profile: "personal" }),
        gateway.status(),
      ]);
      const gatewayReport = gatewayStatus.status === "fulfilled" ? gatewayStatus.value : null;
      const server = status.status === "fulfilled" ? status.value : null;
      planCache = !server?.installed ? await post("/api/server/plan", { profile: "personal" }).catch(() => null) : null;
      const context = app.context;
      // A memory server on another computer: this one must not get a second one.
      const answering = await api().get("/queue/status").then(() => true, () => false);
      const external = !server?.installed && answering;

      const nodes = [outcome];
      if (!server) {
        nodes.push(errorNotice(status.reason));
      } else if (server.installed) {
        nodes.push(serverSection(server), verifySection());
      } else {
        nodes.push(section({ title: "기억 서버" },
          external
            ? notice("", h("b", {}, `이 컴퓨터의 대화는 ${context?.honcho?.url}의 기억 서버에 쌓입니다.`), h("div", {}, "그 서버는 다른 컴퓨터에 있어 여기서 켜고 끌 수 없습니다. 서버를 둔 컴퓨터에서 이 앱을 여세요."))
            : notice("warn", h("b", {}, "이 컴퓨터에는 기억 서버가 없습니다."), h("div", {}, "다른 컴퓨터에 서버가 있으면 내 컴퓨터 → 대화 쌓기에서 그 주소를 넣으세요.")),
        ));
        // Installing a second server beside one that already answers would split a person's memories.
        nodes.push(external
          ? h("details", { class: "raw", style: { marginTop: "-8px" }, open: installOpen ? true : null, ontoggle: (event) => { installOpen = event.currentTarget.open; } }, h("summary", { class: "muted" }, "그래도 이 컴퓨터에 새 서버를 설치하려면"), h("div", { style: { marginTop: "12px" } }, notice("warn", "한 사람의 기억은 서버 하나에 모아야 합니다. 지금 서버를 옮기려는 게 아니라면 설치하지 마세요."), installSection(server, gatewayReport)))
          : installSection(server, gatewayReport));
      }
      clear(body, nodes);
    }

    function serverSection(server) {
      const services = server.services || [];
      const running = server.running;
      return section({
        title: "기억 서버",
        actions: [
          running
            ? button("멈추기", { kind: "small", iconName: "stop", onClick: async (event) => {
              const ok = await confirmSheet({ title: "기억 서버를 멈출까요?", text: "멈춘 동안에는 대화가 모이지 않고, 끝난 대화는 다시 켤 때 이어서 쌓입니다. 에이전트의 기억 검색도 멈춥니다.", confirm: "멈추기", danger: true });
              if (!ok) return;
              await busy(event.currentTarget, async () => { await cli("/api/server/stop", { profile: "personal" }); await draw(); refreshStatus(); }, { done: "기억 서버를 멈췄습니다" });
            } })
            : button("시작", { kind: "small primary", iconName: "play", onClick: (event) => busy(event.currentTarget, async () => {
              const result = await post("/api/server/start", { profile: "personal" });
              clear(outcome, result.ok ? null : prepareOutcome(result));
              await draw();
              refreshStatus();
            }, { done: "기억 서버를 시작했습니다" }) }),
          button("다시 준비", { kind: "small", title: "설정을 다시 쓰고 이미지를 새로 만듭니다", onClick: async (event) => {
            const ok = await confirmSheet({ title: "기억 서버를 다시 준비할까요?", text: "게이트웨이 주소와 모델 설정을 다시 쓰고, 필요하면 서버 소스를 새로 받습니다. 몇 분 걸릴 수 있고, 끝나면 다시 시작해야 반영됩니다.", confirm: "다시 준비" });
            if (!ok) return;
            await busy(event.currentTarget, async () => {
              const result = await post("/api/server/prepare", { profile: "personal" });
              clear(outcome, prepareOutcome(result));
              await loadContext();
              await draw();
            });
          } }),
        ],
      },
      h("div", { class: "rows" },
        h("div", { class: "row" },
          h("div", {}, h("div", { class: "title" }, statusTag(running && server.health?.ok, ["답하는 중", running ? "답하지 않음" : "멈춤"]), "API"), h("div", { class: "sub mono" }, server.apiUrl || "")),
          h("div", { class: "end" }),
        ),
        services.map((service) => h("div", { class: "row" },
          h("div", {}, h("div", { class: "title" }, statusTag(service.State === "running"), service.Service || service.Name), h("div", { class: "sub" }, [service.Status, service.Health ? `상태 검사 ${service.Health}` : null].filter(Boolean).join(" · "))),
          h("div", { class: "end" }),
        )),
      ),
      h("p", { class: "muted", style: { fontSize: "12.5px", marginTop: "10px" } }, `설치 위치 ${server.directory}`),
      );
    }

    function verifySection() {
      const box = h("div", {});
      return section({
        title: "끝에서 끝까지 점검",
        note: "서버, 컨테이너, 임베딩, 게이트웨이를 차례로 두드려 봅니다. 모델에 실제 질문 하나를 보내는 데까지 30초쯤 걸립니다.",
        actions: [button("점검", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
          clear(box, h("div", { class: "muted", style: { display: "flex", gap: "8px", alignItems: "center" } }, spinner(), "점검하는 중…"));
          const result = await post("/api/server/verify", { profile: "personal" });
          const checks = Object.entries(result.checks || {});
          clear(box,
            h("div", { class: "rows" }, checks.map(([name, check]) => h("div", { class: "row" },
              h("div", {}, h("div", { class: "title" }, check.ok ? tag("통과", "ok") : check.skipped ? tag("건너뜀") : tag("실패", "bad"), CHECK_NAMES[name] || name),
                h("div", { class: "sub" }, check.error || check.reason || check.detail || "")),
              h("div", { class: "end" }),
            ))),
            details("자세한 결과", result),
          );
        }) })],
      }, box);
    }

    function installSection(server, gatewayReport) {
      const planBox = h("div", {});
      const gatewayUp = Boolean(gatewayReport);
      const serving = (gatewayReport?.servingAccounts || []).length;
      const loggedIn = (gatewayReport?.accounts || []).filter((account) => account.login?.loggedIn).length;
      const prepare = (confirmText) => async (event) => {
        const ok = await confirmSheet(confirmText);
        if (!ok) return;
        await busy(event.currentTarget, async () => {
          const result = await post("/api/server/prepare", { profile: "personal" });
          clear(outcome, prepareOutcome(result));
          await loadContext();
          await draw();
          refreshStatus();
        });
      };
      // The plan knows what is missing: it lists an install for Docker Desktop and Ollama only when they are.
      const ops = new Set((planCache?.operations || []).map((op) => op.type));
      const dockerReady = Boolean(server.docker?.installed && server.docker?.running);
      const ollamaReady = planCache ? !ops.has("install-ollama") : false;
      const steps = [
        {
          title: "무엇을 설치할지 보기",
          text: "설치할 것을 미리 봅니다. 아무것도 바꾸지 않습니다.",
          done: false,
          body: [button("살펴보기", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            const plan = await post("/api/server/plan", { profile: "personal" });
            clear(planBox, planView(plan), details("자세한 결과", plan));
          }) }), planBox],
        },
        {
          title: "Docker와 Ollama 준비",
          text: dockerReady && ollamaReady
            ? "둘 다 있습니다."
            : !server.docker?.installed
              ? "받아서 설치를 누르세요. Docker 창이 뜨면 약관에 동의하고 권장 설정을 고른 뒤, 암호를 물으면 넣으세요."
              : "이어서 준비를 누르세요.",
          done: dockerReady && ollamaReady,
          body: dockerReady && ollamaReady ? [] : [button(server.docker?.installed ? "이어서 준비" : "받아서 설치", { kind: "small primary", onClick: prepare({ title: "Docker와 Ollama를 설치할까요?", text: "Docker Desktop(약 600MB)과 Ollama를 받아 설치합니다. Docker Desktop 창이 뜨면 약관에 동의하고 권장 설정을 고르세요.", confirm: "설치" }) })],
        },
        {
          title: "구독 게이트웨이 설치",
          text: gatewayUp
            ? "설치돼 있습니다."
            : dockerReady ? "설치를 누르세요. 몇 분 걸립니다." : "Docker와 Ollama 준비 다음에 합니다.",
          done: gatewayUp,
          body: gatewayUp || !dockerReady ? [] : [button("설치", { kind: "small primary", onClick: prepare({ title: "구독 게이트웨이를 설치할까요?", text: "Honcho 소스와 게이트웨이를 받고 게이트웨이를 설치합니다. 계정 로그인이 필요해지면 거기서 멈춥니다.", confirm: "설치" }) })],
        },
        {
          title: "게이트웨이에 구독 계정 로그인",
          text: serving
            ? `계정 ${serving}개가 연결돼 있습니다.`
            : loggedIn
              ? "게이트웨이 설정에서 지금 연결을 누르세요."
              : gatewayUp
                ? "Codex로 로그인이나 Claude로 로그인을 누르고 브라우저에서 로그인을 마치세요."
                : "게이트웨이 설치 다음에 합니다.",
          done: serving > 0,
          body: !gatewayUp ? [] : serving
            ? [button("게이트웨이 설정", { kind: "small quiet", onClick: () => go("models") })]
            : [
              button("Codex로 로그인", { kind: "small primary", onClick: () => go("models/add/codex") }),
              button("Claude로 로그인", { kind: "small", onClick: () => go("models/add/claude") }),
              loggedIn ? button("게이트웨이 설정", { kind: "small quiet", onClick: () => go("models") }) : null,
            ],
        },
        {
          title: "기억 서버 준비",
          text: serving ? "준비를 누르세요. 처음에는 임베딩 모델(몇 GB)을 받느라 오래 걸립니다." : "로그인 다음에 합니다.",
          done: false,
          body: serving ? [button("준비", { kind: "small primary", onClick: prepare({ title: "기억 서버를 준비할까요?", text: "서버 설정과 파일을 쓰고 임베딩 모델을 받습니다. 몇 분에서 수십 분 걸릴 수 있습니다.", confirm: "준비" }) })] : [],
        },
        {
          title: "시작",
          text: "준비가 끝나면 이 화면에 나타나는 기억 서버에서 시작을 누르세요. 처음에는 오래 걸립니다.",
          done: false,
          body: [],
        },
      ];
      // Looking at the plan is optional; the next thing to do is the first unfinished step after it.
      const current = steps.findIndex((step, index) => index > 0 && !step.done);
      return section({ title: "서버 설치", note: "위에서부터 차례로 진행하세요." },
        h("div", { class: "steps" }, steps.map((step, index) => h("div", { class: `step ${step.done ? "done" : index === current ? "current" : ""}` },
          h("span", { class: "step-num" }),
          h("div", {},
            h("h3", {}, step.title),
            h("p", {}, step.text),
            step.body.filter(Boolean).length ? h("div", { class: "step-actions" }, step.body.filter((node) => node && node.tagName === "BUTTON")) : null,
            step.body.filter((node) => node && node.tagName !== "BUTTON"),
          ),
        ))),
      );
    }

    refresh.addEventListener("click", () => busy(refresh, draw));
    await draw();
  },
};
