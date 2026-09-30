// 서버: the memory server on this computer. Install it, start and stop it, check
// it end to end, and see the pieces beside it (the gateway's host services and the
// Ollama embedding model). Building or restarting it is a deployment, so every
// button that does that says so first.
import { cli, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { api, app, go, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, confirmSheet, details, errorNotice, notice, pageHead, section, spinner, tag } from "../lib/ui.js";

const CHECK_NAMES = {
  status: "서버와 컨테이너",
  embedding: "임베딩 모델(Ollama)",
  containerHost: "컨테이너에서 게이트웨이·Ollama로 가는 길",
  honcho: "기억 서버 응답",
  completion: "모델 응답",
};

function statusTag(on, labels = ["실행 중", "멈춤"]) {
  return on ? tag(labels[0], "ok") : tag(labels[1]);
}

function prepareOutcome(result) {
  if (result.nextAction?.kind === "gateway-login") {
    return notice("warn", h("b", {}, "구독 계정 로그인이 필요합니다."),
      h("div", {}, "기억 서버가 생각할 모델을 쓰려면 Codex나 Claude 계정이 있어야 합니다. 모델·계정 화면에서 로그인한 뒤 여기로 돌아와 다시 준비하세요."),
      h("div", { class: "form-actions" }, button("모델·계정으로", { kind: "primary small", onClick: () => go("models") })));
  }
  if (result.issues?.length) return notice("bad", h("b", {}, "준비하지 못했습니다."), h("ul", {}, result.issues.map((issue) => h("li", {}, issue))), result.next ? h("div", {}, result.next) : null);
  if (result.ok && result.ready !== false) return notice("ok", h("b", {}, "준비했습니다."), result.chatModel ? ` 모델은 ${result.chatModel}입니다.` : "", " 이제 시작할 수 있습니다.");
  return notice("warn", h("b", {}, "끝나지 않았습니다."), result.next || result.error || "");
}

export default {
  title: "서버",
  async mount(page) {
    const body = h("div", { class: "pad" });
    const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침" });
    page.append(
      pageHead({ title: "서버", subtitle: "기억을 보관하는 서버와, 그 옆에서 도는 게이트웨이·임베딩을 관리합니다.", actions: [refresh] }),
      h("div", { class: "page-body" }, body),
    );

    const outcome = h("div", {});

    async function draw() {
      clear(body, h("div", { class: "empty" }, spinner()));
      const [status, host] = await Promise.allSettled([
        post("/api/server/status", { profile: "personal" }),
        post("/api/host/status", {}),
      ]);
      const server = status.status === "fulfilled" ? status.value : null;
      const hostStatus = host.status === "fulfilled" ? host.value : null;
      const context = app.context;
      // A server this app did not install still answers: say whose it is instead of "none".
      const answering = await api().get("/queue/status").then(() => true, () => false);
      const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(context?.honcho?.url || "");
      const external = !server?.installed && answering;

      const nodes = [outcome];
      if (!server) {
        nodes.push(errorNotice(status.reason));
      } else if (!server.docker?.installed) {
        nodes.push(notice("warn", h("b", {}, "Docker가 없습니다."), " 이 컴퓨터를 기억 서버로 쓰려면 Docker Desktop을 먼저 설치하세요."));
      } else if (server.installed) {
        nodes.push(serverSection(server), hostSection(hostStatus), verifySection());
      } else {
        nodes.push(section({ title: "기억 서버" },
          external && loopback
            ? notice("", h("b", {}, `이 컴퓨터에서 기억 서버가 돌고 있습니다 (${context.honcho.url}).`), h("div", {}, "이 앱으로 설치한 서버가 아니라 여기서 켜고 끌 수는 없습니다. 직접 띄운 방식(docker compose 등)으로 관리하세요. 기억 보기·묻기·도구 설정은 그대로 됩니다."))
            : external
              ? notice("", h("b", {}, `이 컴퓨터는 ${context?.honcho?.url}의 기억 서버를 씁니다.`), h("div", {}, "그 서버는 다른 컴퓨터에 있어 여기서 켜고 끌 수 없습니다. 서버를 둔 컴퓨터에서 관리하세요."))
              : notice("warn", h("b", {}, "이 컴퓨터에는 기억 서버가 없습니다."), h("div", {}, "내 다른 컴퓨터에 서버가 있으면 연결 화면에서 그 주소를 넣으세요.")),
        ));
        // Installing a second server beside one that already answers would split a person's memories.
        nodes.push(external
          ? h("details", { class: "raw", style: { marginTop: "-8px" } }, h("summary", { class: "muted" }, "그래도 이 컴퓨터에 새 서버를 설치하려면"), h("div", { style: { marginTop: "12px" } }, notice("warn", "한 사람의 기억은 서버 하나에 모아야 합니다. 지금 서버를 옮기려는 게 아니라면 설치하지 마세요."), installSection(server)))
          : installSection(server));
        if (hostStatus?.installed) nodes.push(hostSection(hostStatus));
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
              const ok = await confirmSheet({ title: "기억 서버를 멈출까요?", text: "멈춘 동안에는 대화가 모이지 않고, 끝난 대화는 다시 켤 때 이어서 보냅니다. 에이전트의 기억 검색도 멈춥니다.", confirm: "멈추기", danger: true });
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
          h("div", { class: "end" }, server.dashboardUrl ? h("a", { class: "btn small quiet", href: server.dashboardUrl, target: "_blank", rel: "noreferrer" }, "예전 대시보드") : null),
        ),
        services.map((service) => h("div", { class: "row" },
          h("div", {}, h("div", { class: "title" }, statusTag(service.State === "running"), service.Service || service.Name), h("div", { class: "sub" }, [service.Status, service.Health ? `상태 검사 ${service.Health}` : null].filter(Boolean).join(" · "))),
          h("div", { class: "end" }),
        )),
      ),
      h("p", { class: "muted", style: { fontSize: "12.5px", marginTop: "10px" } }, `설치 위치 ${server.directory}`),
      );
    }

    function hostSection(host) {
      if (!host) return null;
      const ollama = host.ollama || {};
      return section({
        title: "서버 옆에서 도는 것",
        note: "구독 게이트웨이는 스스로 자동 시작합니다. Ollama 임베딩 감시는 컴퓨터를 다시 켠 뒤 여기서 한 번 켜야 다시 돕니다.",
        actions: [
          host.running
            ? button("멈추기", { kind: "small", iconName: "stop", onClick: (event) => busy(event.currentTarget, async () => { await cli("/api/host/stop", {}); await draw(); refreshStatus(); }, { done: "멈췄습니다" }) })
            : button("켜기", { kind: "small primary", iconName: "play", onClick: (event) => busy(event.currentTarget, async () => { await cli("/api/host/start", {}); await draw(); refreshStatus(); }, { done: "켰습니다" }) }),
        ],
      },
      h("div", { class: "rows" },
        h("div", { class: "row" },
          h("div", {}, h("div", { class: "title" }, statusTag(host.gateway?.ok, ["준비됨", host.gateway?.installed ? "문제 있음" : "설치 안 됨"]), "구독 게이트웨이"),
            h("div", { class: "sub" }, host.gateway?.ok ? "계정 관리는 모델·계정 화면에서 합니다." : host.gateway?.error || "")),
          h("div", { class: "end" }, button("모델·계정", { kind: "small quiet", onClick: () => go("models") })),
        ),
        h("div", { class: "row" },
          h("div", {}, h("div", { class: "title" }, statusTag(ollama.healthy && ollama.resident, ["올라가 있음", ollama.healthy ? "모델이 내려가 있음" : "Ollama 꺼짐"]), "임베딩 모델"),
            h("div", { class: "sub" }, [ollama.model, host.supervisor?.processAlive ? "감시 중" : "감시 꺼짐"].filter(Boolean).join(" · "))),
          h("div", { class: "end" }),
        ),
      ));
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

    function installSection(server) {
      const planBox = h("div", {});
      return section({ title: "이 컴퓨터를 기억 서버로 쓰기", note: "기억 서버, 구독 게이트웨이, 임베딩 모델을 이 컴퓨터에 설치합니다. 한 사람에게 서버는 하나면 됩니다. 이미 다른 컴퓨터에 내 서버가 있으면 설치하지 마세요." },
        h("div", { class: "steps" },
          h("div", { class: "step" }, h("span", { class: "step-num" }), h("div", {},
            h("h3", {}, "무엇을 설치할지 보기"),
            h("p", {}, "바꾸는 것을 먼저 확인합니다. 아직 아무것도 설치하지 않습니다."),
            button("살펴보기", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
              const plan = await post("/api/server/plan", { profile: "personal" });
              clear(planBox, plan.ready
                ? notice("", h("b", {}, "준비할 수 있습니다."), h("ul", {}, (plan.operations || []).map((op) => h("li", {}, op.note || op.type.replace(/-/g, " ")))))
                : notice("bad", h("b", {}, "지금은 설치할 수 없습니다."), h("ul", {}, (plan.issues || [plan.error]).filter(Boolean).map((issue) => h("li", {}, issue)))),
              details("자세한 결과", plan));
            }) }),
            planBox,
          )),
          h("div", { class: "step" }, h("span", { class: "step-num" }), h("div", {},
            h("h3", {}, "준비하기"),
            h("p", {}, "소스를 받고 게이트웨이를 설치합니다. 계정 로그인이 필요하면 여기서 멈추고 알려 줍니다. 몇 분 걸립니다."),
            button("준비", { kind: "small primary", onClick: async (event) => {
              const ok = await confirmSheet({ title: "이 컴퓨터에 기억 서버를 준비할까요?", text: "Docker 이미지와 게이트웨이를 설치합니다. 몇 GB의 디스크를 씁니다.", confirm: "준비" });
              if (!ok) return;
              await busy(event.currentTarget, async () => {
                const result = await post("/api/server/prepare", { profile: "personal" });
                clear(outcome, prepareOutcome(result));
                await loadContext();
                await draw();
              });
            } }),
          )),
          h("div", { class: "step" }, h("span", { class: "step-num" }), h("div", {},
            h("h3", {}, "시작하기"),
            h("p", {}, "준비가 끝나면 서버를 켭니다. 처음에는 이미지를 만드느라 오래 걸립니다."),
            button("시작", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
              const result = await post("/api/server/start", { profile: "personal" });
              clear(outcome, result.ok ? notice("ok", h("b", {}, "기억 서버가 켜졌습니다."), " 이제 연결 화면에서 대화 수집을 설정하세요.") : prepareOutcome(result));
              await loadContext();
              await draw();
              refreshStatus();
            }) }),
          )),
        ),
      );
    }

    refresh.addEventListener("click", () => busy(refresh, draw));
    await draw();
  },
};
