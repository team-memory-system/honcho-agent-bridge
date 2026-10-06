// 서버: the memory server on this computer. Install it, start and stop it, choose
// the gateway model it thinks with, check it end to end, and see the pieces beside
// it (the gateway's host services and the Ollama embedding model). Building or
// restarting it is a deployment, so every button that does that says so first.
import { cli, gateway, post } from "../lib/api.js";
import { modelGroups } from "../lib/accounts.js";
import { h, clear, copyText } from "../lib/dom.js";
import { api, app, go, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, confirmSheet, details, errorNotice, notice, pageHead, section, spinner, tag, toast } from "../lib/ui.js";

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
      result.share?.profileDropped ? h("div", {}, "예전 판에서 켠 공유는 꺼 두었습니다. 아래 공유에서 다시 켜세요.") : null);
  }
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
    let planCache = null;
    // The install steps stay open across redraws once someone opened them.
    let installOpen = false;

    async function draw() {
      clear(body, h("div", { class: "empty" }, spinner()));
      const [status, host, gatewayStatus] = await Promise.allSettled([
        post("/api/server/status", { profile: "personal" }),
        post("/api/host/status", {}),
        gateway.status(),
      ]);
      const gatewayReport = gatewayStatus.status === "fulfilled" ? gatewayStatus.value : null;
      const server = status.status === "fulfilled" ? status.value : null;
      const hostStatus = host.status === "fulfilled" ? host.value : null;
      planCache = !server?.installed ? await post("/api/server/plan", { profile: "personal" }).catch(() => null) : null;
      const context = app.context;
      // A memory server on another computer: this one must not get a second one.
      const answering = await api().get("/queue/status").then(() => true, () => false);
      const external = !server?.installed && answering;

      const nodes = [outcome];
      if (!server) {
        nodes.push(errorNotice(status.reason));
      } else if (server.installed) {
        nodes.push(serverSection(server), modelSection(gatewayReport), shareSection(), hostSection(hostStatus), verifySection());
      } else {
        nodes.push(section({ title: "기억 서버" },
          external
            ? notice("", h("b", {}, `이 컴퓨터는 ${context?.honcho?.url}의 기억 서버로 대화를 보냅니다.`), h("div", {}, "그 서버는 다른 컴퓨터에 있어 여기서 켜고 끌 수 없습니다. 서버를 둔 컴퓨터에서 이 앱을 여세요."))
            : notice("warn", h("b", {}, "이 컴퓨터에는 기억 서버가 없습니다."), h("div", {}, "다른 컴퓨터에 서버가 있으면 연결 화면에서 그 주소를 넣으세요.")),
        ));
        // Installing a second server beside one that already answers would split a person's memories.
        nodes.push(external
          ? h("details", { class: "raw", style: { marginTop: "-8px" }, open: installOpen ? true : null, ontoggle: (event) => { installOpen = event.currentTarget.open; } }, h("summary", { class: "muted" }, "그래도 이 컴퓨터에 새 서버를 설치하려면"), h("div", { style: { marginTop: "12px" } }, notice("warn", "한 사람의 기억은 서버 하나에 모아야 합니다. 지금 서버를 옮기려는 게 아니라면 설치하지 마세요."), installSection(server, gatewayReport)))
          : installSection(server, gatewayReport));
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

    // 기억 서버가 쓰는 모델: the gateway model the server sorts conversations and
    // answers with. Only a server this app installed on this computer can be
    // changed here; changing it rewrites the server's settings and restarts it.
    function modelSection(gatewayReport) {
      const local = app.context?.localServer;
      if (!local) return null;
      const current = local.chatModel || "";
      const groups = modelGroups(gatewayReport?.models?.models, gatewayReport?.accounts);
      const known = groups.some((group) => group.models.includes(current));
      const note = "대화를 정리하고, 묻기에 답할 때 쓰는 모델입니다. 바꾸면 기억 서버를 다시 시작합니다.";
      const now = h("div", {}, h("div", { class: "title" }, current ? h("code", { class: "mono" }, current) : "정해지지 않음"), h("div", { class: "sub" }, "지금 설정"));
      if (!groups.length) {
        return section({ id: "server-model", title: "기억 서버가 쓰는 모델", note },
          h("div", { class: "rows" }, h("div", { class: "row" }, now, h("div", { class: "end" }))),
          h("div", { style: { marginTop: "12px" } }, notice("warn",
            h("b", {}, "고를 수 있는 모델이 없습니다."),
            h("div", {}, gatewayReport ? "게이트웨이에 연결된 계정이 없습니다. 게이트웨이 화면에서 계정을 로그인하고 연결하세요." : "구독 게이트웨이가 답하지 않습니다. 게이트웨이를 켜면 모델 목록이 보입니다."),
            h("div", { class: "form-actions", style: { marginTop: "8px" } }, button("게이트웨이 화면으로", { kind: "small", onClick: () => go("models") })),
          )),
        );
      }
      const choice = h("select", { class: "select", style: { width: "auto", minWidth: "220px" }, "aria-label": "기억 서버 모델" },
        current && !known ? h("option", { value: current, selected: true }, `${current} (게이트웨이에 없음)`) : null,
        groups.map((group) => h("optgroup", { label: group.label },
          group.models.map((id) => h("option", { value: id, selected: id === current ? true : null }, id)))),
      );
      return section({ id: "server-model", title: "기억 서버가 쓰는 모델", note },
        h("div", { class: "rows" }, h("div", { class: "row" },
          now,
          h("div", { class: "end" }, choice, button("바꾸기", { kind: "small", onClick: async (event) => {
            if (choice.value === current) return toast("이미 이 모델을 씁니다");
            const ok = await confirmSheet({ title: `${choice.value}로 바꿀까요?`, text: "기억 서버 설정을 고치고 다시 시작합니다. 1~2분 동안 기억을 쓰거나 찾을 수 없습니다.", confirm: "바꾸고 다시 시작" });
            if (!ok) return;
            await busy(event.currentTarget, async () => {
              await cli("/api/server/start", { profile: "personal", model: choice.value });
              await loadContext();
              await draw();
              refreshStatus();
            }, { done: "모델을 바꿨습니다" });
          } })),
        )),
      );
    }

    // 공유: this server reachable through a Cloudflare tunnel. The gate lets the
    // owner's other computers in with the server token and teammates' Claude Code and
    // Codex in at /mcp after a Google login (Cloudflare Access). Off, the simple ways
    // in come first (the owner with a Cloudflare API token, a teammate with an
    // invite); a tunnel made by hand is folded away. On, the owner also keeps the
    // team here: who may log in, whose servers are shared, and the 팀 주소.
    function shareSection() {
      const box = h("div", {}, h("div", { class: "empty" }, spinner()));
      const drawShare = async (check = false) => {
        let share;
        try {
          share = await cli("/api/server/share/status", { check });
        } catch (error) {
          clear(box, errorNotice(error));
          return;
        }
        const tunnelOn = share.tunnel?.enabled ?? share.enabled;
        clear(box, tunnelOn ? shareOn(share, drawShare) : shareOff(share, drawShare));
      };
      drawShare(false);
      return section({ id: "share", title: "공유", note: "팀원과 내 다른 컴퓨터가 이 서버에 닿게 합니다. Cloudflare 통로로만 열고, 팀원은 Google 로그인(Cloudflare Access)으로, 내 다른 컴퓨터는 서버 token으로 들어옵니다." }, box);
    }

    const PUBLIC_STATES = {
      ok: ["ok", "밖에서 닿습니다", "다른 컴퓨터에서 이 주소와 서버 token으로 연결하면 됩니다."],
      access: ["ok", "Cloudflare Access가 지키고 있습니다", "이 컴퓨터는 Access를 통과하지 못해 안쪽까지는 확인하지 못했습니다. 팀원은 Google로 로그인해 들어옵니다."],
      token: ["bad", "서버 token이 맞지 않습니다", "통로는 열렸지만 문지기가 token을 받지 않았습니다. 서버를 다시 시작해 보세요."],
      unreachable: ["bad", "밖에서 닿지 않습니다", "Cloudflare 통로가 아직 붙지 않았거나 주소가 다릅니다. 잠시 뒤 다시 확인하세요."],
      error: ["bad", "확인하지 못했습니다", ""],
    };

    function mcpRow(share) {
      const mcp = share.mcp || {};
      const state = mcp.configured ? statusTag(mcp.running, ["준비됨", "멈춤"]) : tag("꺼짐");
      return h("div", { class: "row" },
        h("div", { style: { minWidth: "0" } },
          h("div", { class: "title" }, state, "팀원 MCP (/mcp)"),
          h("div", { class: "sub" }, mcp.configured
            ? "팀원의 Claude Code·Codex가 Google 로그인 뒤 이 기억에 chat으로 묻습니다."
            : ["직접 만든 통로로 켜면 /mcp는 열리지 않습니다. Cloudflare나 초대 코드로 켜면 열립니다.", mcp.missing?.length ? ` 빠진 설정: ${mcp.missing.join(", ")}` : ""].join("")),
        ),
        h("div", { class: "end" }),
      );
    }

    function shareOn(share, redraw) {
      const check = share.publicCheck;
      const state = check ? PUBLIC_STATES[check.state] || PUBLIC_STATES.error : null;
      const cloudflare = share.cloudflare || {};
      return h("div", {},
        (share.issues || []).length ? h("div", { style: { marginBottom: "12px" } }, notice("warn", h("ul", {}, share.issues.map((issue) => h("li", {}, issue))))) : null,
        h("div", { class: "rows" },
          h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, statusTag(share.tunnel?.running, ["열림", "통로 멈춤"]), "공개 주소"), h("div", { class: "sub mono" }, share.publicUrl || "")),
            h("div", { class: "end" },
              button("", { kind: "small icon-only", iconName: "copy", title: "주소 복사", onClick: async () => { await copyText(share.publicUrl); toast("주소를 복사했습니다"); } }),
              button("밖에서 확인", { kind: "small", onClick: (event) => busy(event.currentTarget, () => redraw(true)) }),
            ),
          ),
          h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, statusTag(share.tunnel?.running, ["도는 중", "멈춤"]), "Cloudflare 통로"), h("div", { class: "sub" }, cloudflare.joined ? "팀을 연 사람이 만든 통로를 이 컴퓨터에서 돌립니다." : cloudflare.managed ? "이 앱이 내 Cloudflare 계정에 만든 통로입니다." : "Cloudflare 대시보드에서 직접 만든 통로입니다.")),
            h("div", { class: "end" }),
          ),
          mcpRow(share),
          h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, statusTag(share.gate?.running, ["지키는 중", "멈춤"]), "문지기"), h("div", { class: "sub" }, "내 다른 컴퓨터는 서버 token이 있어야 기억 서버로 넘어갑니다.", share.gate?.localUrl ? ` ${share.gate.localUrl}` : "")),
            h("div", { class: "end" },
              button("서버 token 복사", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
                const result = await cli("/api/server/share/token", {});
                await copyText(result.token);
                toast("서버 token을 복사했습니다. 내 다른 컴퓨터의 연결 화면에 붙여 넣으세요.");
              }) }),
            ),
          ),
        ),
        state ? h("div", { style: { marginTop: "12px" } }, notice(state[0], h("b", {}, state[1]), state[2] ? ` ${state[2]}` : "", check.error ? h("div", { class: "muted" }, check.error) : null)) : null,
        cloudflare.managed ? teamBlock() : null,
        cloudflare.joined ? h("div", { style: { marginTop: "12px" } }, notice("", h("b", {}, "팀에 들어가 있습니다."), " 팀원들이 Google로 로그인해 이 기억에 묻습니다. 팀원들의 기억을 내 Claude Code·Codex에 붙이려면 연결 화면에서 합니다.",
          h("div", { class: "form-actions", style: { marginTop: "8px" } }, button("팀원 기억 연결", { kind: "small", onClick: () => go("connect/share") })))) : null,
        h("div", { class: "form-actions" },
          button("서버 token 바꾸기", { kind: "small quiet", onClick: async (event) => {
            const ok = await confirmSheet({ title: "서버 token을 바꿀까요?", text: "지금 token을 쓰는 내 다른 컴퓨터는 모두 끊깁니다. 각 컴퓨터의 연결 화면에 새 token을 넣어야 다시 모입니다. 끊긴 동안의 대화는 다시 연결하면 이어서 보냅니다. 팀원의 Google 로그인은 그대로입니다.", confirm: "바꾸기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => { await cli("/api/server/share/rotate", {}); await redraw(false); }, { done: "새 서버 token을 만들었습니다" });
          } }),
          button("공유 끄기", { kind: "small quiet danger", onClick: async (event) => {
            const ok = await confirmSheet({ title: "공유를 끌까요?", text: "통로, 문지기, 팀원 MCP를 이 컴퓨터에서 멈춥니다. 내 다른 컴퓨터의 대화는 다시 켤 때까지 그 컴퓨터에 쌓였다가 이어서 옵니다. Cloudflare 쪽 설정과 token은 그대로 두니, 다시 켜면 팀원도 그대로 들어옵니다.", confirm: "끄기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => { await cli("/api/server/share/disable", {}); await redraw(false); }, { done: "공유를 껐습니다" });
          } }),
        ),
      );
    }

    // 팀원: who may log in to the team's servers, the teammates' shared servers, and
    // the 팀 주소. All through the owner's saved Cloudflare API token.
    function teamBlock() {
      const box = h("div", {}, h("div", { class: "empty" }, spinner()));
      const drawTeam = async (banner = null) => {
        let team;
        try {
          team = await cli("/api/teammates", {});
        } catch (error) {
          clear(box, errorNotice(error));
          return;
        }
        const sharedBy = new Map((team.shared || []).map((item) => [item.name, item]));
        clear(box,
          banner,
          h("div", { class: "rows" }, (team.people || []).map((email) => h("div", { class: "row" },
            h("div", { style: { minWidth: "0" } }, h("div", { class: "title" }, email, email === team.owner ? tag("나") : null),
              h("div", { class: "sub" }, email === team.owner ? "팀을 연 사람" : [...sharedBy.values()].some((item) => item.email === email) ? "로그인할 수 있음 · 자기 기억도 공유" : "로그인할 수 있음")),
            h("div", { class: "end" }, email === team.owner ? null : button("", { kind: "small icon-only quiet danger", iconName: "trash", title: "팀에서 빼기", onClick: async (event) => {
              const ok = await confirmSheet({ title: `${email}를 팀에서 뺄까요?`, text: "이 사람은 이제 팀의 어느 기억에도 로그인하지 못합니다. 이 사람이 공유하던 서버는 그대로 남으니, 그것도 멈추려면 아래 서버 목록에서 공유를 뺍니다.", confirm: "빼기", danger: true });
              if (!ok) return;
              await busy(event.currentTarget, async () => {
                const result = await cli("/api/teammates/remove", { email });
                await drawTeam(notice("ok", h("b", {}, `${email}를 뺐습니다.`), result.stillShared?.length ? ` 공유 중인 서버(${result.stillShared.join(", ")})는 아직 남아 있습니다.` : ""));
              });
            } })),
          ))),
          h("h3", { class: "sub-title" }, "팀의 기억 서버"),
          h("div", { class: "rows" }, (team.servers || []).map((server) => h("div", { class: "row" },
            h("div", { style: { minWidth: "0" } }, h("div", { class: "title" }, server.name, sharedBy.has(server.name) ? null : tag("이 서버")), h("div", { class: "sub mono" }, server.host),
              sharedBy.get(server.name)?.email ? h("div", { class: "sub" }, sharedBy.get(server.name).email) : null),
            h("div", { class: "end" }, sharedBy.has(server.name) ? button("공유 빼기", { kind: "small quiet danger", onClick: async (event) => {
              const ok = await confirmSheet({ title: `${server.name} 서버의 공유를 뺄까요?`, text: `Cloudflare에서 ${server.host}의 통로, 주소, Access 설정을 지웁니다. 그 사람의 초대 코드는 더 이상 쓸 수 없고, 팀원은 그 기억에 묻지 못합니다.`, confirm: "공유 빼기", danger: true });
              if (!ok) return;
              await busy(event.currentTarget, async () => {
                await cli("/api/teammates/unshare", { name: server.name });
                await drawTeam(notice("ok", h("b", {}, `${server.name} 서버의 공유를 뺐습니다.`), " 그 사람 컴퓨터에서도 공유를 끄라고 알려 주세요."));
              });
            } }) : null),
          ))),
          addTeammate(drawTeam),
          h("h3", { class: "sub-title" }, "팀 주소"),
          h("p", { class: "section-note", style: { margin: "0 0 8px" } }, "질문만 하는 팀원에게 보냅니다. 비밀이 없는 주소라서 어디에 올려도 됩니다. 받은 사람은 연결 화면 → 팀원 기억 연결에 붙여 넣습니다."),
          h("pre", { class: "log" }, team.addressText || ""),
          h("div", { class: "form-actions" }, button("팀 주소 복사", { kind: "small", iconName: "copy", onClick: async () => { await copyText(team.addressText || ""); toast("팀 주소를 복사했습니다"); } })),
        );
      };
      drawTeam();
      return h("div", { class: "team-block" }, h("h3", { class: "sub-title" }, "팀원"), box);
    }

    function addTeammate(drawTeam) {
      const email = h("input", { class: "input", type: "email", autocomplete: "off", placeholder: "teammate@example.com" });
      const sharing = h("input", { type: "checkbox" });
      const name = h("input", { class: "input", autocomplete: "off", pattern: "[a-z0-9][a-z0-9-]{0,30}[a-z0-9]?", placeholder: "예: alice" });
      const nameField = h("label", { class: "field" }, h("span", {}, "그 사람 서버 이름"), name, h("small", {}, "영문 소문자·숫자·-만 씁니다. 주소는 memory-<이름>.<zone>이 됩니다."));
      nameField.hidden = true;
      sharing.addEventListener("change", () => { nameField.hidden = !sharing.checked; });
      return h("div", {},
        h("h3", { class: "sub-title" }, "팀원 더하기"),
        h("div", { class: "panel" },
          notice("warn", "지금은 등록한 사람이 내 기억 전체에 chat으로 물을 수 있습니다 (프로젝트별 제한은 아직 없음)."),
          h("div", { class: "form-grid", style: { marginTop: "12px" } },
            h("label", { class: "field" }, h("span", {}, "이메일"), email, h("small", {}, "그 사람이 Google에 로그인하는 주소입니다.")),
            h("label", { class: "field wide", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, sharing, h("span", {}, "이 사람도 자기 기억을 공유")),
            nameField,
          ),
          h("div", { class: "form-actions" }, button("더하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            const body = { email: email.value.trim(), share: sharing.checked };
            if (!body.email) throw new Error("이메일을 넣으세요.");
            if (sharing.checked) {
              body.name = name.value.trim().toLowerCase();
              if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(body.name)) throw new Error("서버 이름은 영문 소문자·숫자·-로 32자까지 씁니다.");
            }
            const result = await cli("/api/teammates/add", body);
            email.value = "";
            name.value = "";
            sharing.checked = false;
            nameField.hidden = true;
            await drawTeam(result.invite ? inviteOnce(result) : notice("ok", h("b", {}, `${result.email}를 더했습니다.`), " 이제 이 사람이 Google로 로그인해 팀의 기억에 묻습니다. 팀 주소를 보내 주세요."));
          }) })),
        ),
      );
    }

    // The invite holds the teammate's tunnel token: shown here once, never kept by the page.
    function inviteOnce(result) {
      let code = result.invite;
      const box = h("pre", { class: "log", style: { userSelect: "all" } }, code);
      const panel = notice("warn",
        h("b", {}, `${result.share?.name || ""} 서버의 초대 코드 — 지금 한 번만 보입니다`),
        h("ul", {},
          h("li", {}, "이 코드에는 비밀(그 서버의 통로 token)이 들어 있습니다."),
          h("li", {}, "이 화면을 떠나면 다시 볼 수 없습니다. 잃어버리면 같은 이메일과 이름으로 다시 더해 새로 받습니다."),
          h("li", {}, "개인 대화로만 보내세요. 단체방이나 여러 사람이 보는 곳에 올리지 않습니다."),
          h("li", {}, "이 코드를 가진 사람은 누구나 그 서버 자리에 대신 설 수 있습니다."),
        ),
        box,
        h("div", { class: "form-actions" },
          button("초대 코드 복사", { kind: "small primary", iconName: "copy", onClick: async () => { await copyText(code); toast("초대 코드를 복사했습니다. 개인 대화로만 보내세요."); } }),
          button("보냈습니다", { kind: "small quiet", onClick: () => { code = ""; panel.remove(); } }),
        ),
        h("div", { class: "muted" }, `받은 사람은 자기 앱의 서버 → 공유 → 초대 코드로 공유 켜기에 붙여 넣습니다. 주소는 ${result.share?.publicUrl || ""}입니다.`),
      );
      return panel;
    }

    function shareOff(share, redraw) {
      const saved = share.cloudflare?.apiTokenSaved;
      const body = h("div", {});
      const cards = {};
      const pick = (key) => {
        for (const [name, card] of Object.entries(cards)) {
          card.classList.toggle("picked", name === key);
          card.setAttribute("aria-pressed", String(name === key));
        }
        clear(body, key === "cloudflare" ? cloudflareForm(share, redraw) : inviteForm(redraw));
      };
      const card = (key, title, text) => {
        cards[key] = h("button", { type: "button", class: "choice", "aria-pressed": "false", onclick: () => pick(key) }, h("b", {}, title), h("span", {}, text));
        return cards[key];
      };
      const node = h("div", {},
        (share.issues || []).length ? h("div", { style: { marginBottom: "12px" } }, notice("warn", h("ul", {}, share.issues.map((issue) => h("li", {}, issue))))) : null,
        h("div", { class: "choices two" },
          card("cloudflare", "Cloudflare로 공유 켜기", "팀을 처음 여는 사람이 씁니다. 내 Cloudflare 계정에 통로, 주소, Google 로그인(Access)을 이 앱이 만듭니다."),
          card("invite", "초대 코드로 공유 켜기", "팀을 연 사람에게 받은 초대 코드를 넣습니다. Cloudflare 계정은 필요 없습니다."),
        ),
        body,
        h("details", { class: "raw", style: { marginTop: "16px" } }, h("summary", { class: "muted" }, "직접 만든 통로로 켜기"), h("div", { style: { marginTop: "12px" } }, manualForm(share, redraw))),
      );
      if (saved || share.cloudflare?.managed) pick("cloudflare");
      else if (share.cloudflare?.joined) pick("invite");
      return node;
    }

    function cloudflareForm(share, redraw) {
      const saved = share.cloudflare?.apiTokenSaved;
      const apiToken = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: saved ? "저장된 token을 그대로 씁니다" : "Cloudflare에서 만든 API token" });
      const email = h("input", { class: "input", type: "email", autocomplete: "off", placeholder: "me@example.com" });
      const zone = h("input", { class: "input", autocomplete: "off", placeholder: "example.com" });
      const name = h("input", { class: "input", autocomplete: "off", value: "memory", placeholder: "memory" });
      return h("div", {},
        h("div", { class: "form-grid" },
          h("label", { class: "field wide" }, h("span", {}, "Cloudflare API token"), apiToken,
            h("small", {}, "Cloudflare 대시보드 → My Profile → API Tokens에서 만듭니다. 이 컴퓨터에만 저장되고 화면이나 기록에 다시 나오지 않습니다.")),
          h("label", { class: "field wide" }, h("span", {}, "내 이메일"), email, h("small", {}, "팀 기억에 로그인할 때 쓰는 Google 계정입니다. 처음 한 번만 넣으면 됩니다.")),
          h("details", { class: "field wide access-fields" },
            h("summary", {}, "token 권한과 주소"),
            h("p", { class: "muted" }, "token에는 Account의 Cloudflare Tunnel: Edit, Access: Apps and Policies: Edit, Access: Organizations, Identity Providers, and Groups: Read와, 쓸 zone의 DNS: Edit, Zone: Read만 줍니다."),
            h("div", { class: "form-grid" },
              h("label", { class: "field" }, h("span", {}, "zone"), zone, h("small", {}, "비워 두면 token이 보는 zone이 하나일 때 그것을 씁니다.")),
              h("label", { class: "field" }, h("span", {}, "이름"), name, h("small", {}, "주소는 <이름>.<zone>이 됩니다.")),
            ),
          ),
        ),
        h("div", { class: "form-actions" }, button("Cloudflare로 공유 켜기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
          const body = { cloudflare: true, name: name.value.trim() || "memory" };
          if (apiToken.value.trim()) body.apiToken = apiToken.value.trim();
          else if (!saved) throw new Error("Cloudflare API token을 넣으세요.");
          if (email.value.trim()) body.email = email.value.trim();
          if (zone.value.trim()) body.zone = zone.value.trim();
          try {
            await cli("/api/server/share/enable", body);
          } finally {
            apiToken.value = "";
          }
          await redraw(true);
        }, { done: "공유를 켰습니다" }) })),
      );
    }

    function inviteForm(redraw) {
      const invite = h("input", { class: "input mono", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "tm1.…" });
      return h("div", {},
        h("div", { class: "form-grid" },
          h("label", { class: "field wide" }, h("span", {}, "초대 코드"), invite,
            h("small", {}, "팀을 연 사람이 개인 대화로 보낸 tm1.로 시작하는 코드입니다. 이 컴퓨터에만 저장되고 화면이나 기록에 다시 나오지 않습니다.")),
        ),
        h("div", { class: "form-actions" }, button("초대 코드로 공유 켜기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
          if (!invite.value.trim()) throw new Error("초대 코드를 붙여 넣으세요.");
          try {
            await cli("/api/server/share/join", { invite: invite.value.trim() });
          } finally {
            invite.value = "";
          }
          await redraw(true);
        }, { done: "공유를 켰습니다" }) })),
      );
    }

    function manualForm(share, redraw) {
      const address = h("input", { class: "input", type: "url", placeholder: "https://memory.example.com", value: share.publicUrl || "" });
      const token = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: share.tunnel?.tokenSaved ? "저장된 통로 token을 그대로 씁니다" : "Cloudflare에서 복사한 통로 token" });
      const port = share.gate?.port || 8010;
      return h("div", {},
        h("div", { class: "notice share-guide" }, h("div", {},
          h("b", {}, "Cloudflare 대시보드에서 통로를 직접 만든 경우입니다."),
          h("ol", {},
            h("li", {}, "Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared를 고르고 이름을 붙입니다."),
            h("li", {}, "설치 명령이 나오면 명령은 실행하지 말고, 그 안의 긴 token만 복사해 아래에 붙여 넣습니다."),
            h("li", {}, `Public hostname에 쓸 주소를 정하고, Service는 HTTP, URL은 gate:8010으로 둡니다. (이 컴퓨터의 문지기는 localhost:${port}에서도 답합니다.)`),
          ),
          h("p", { class: "muted", style: { margin: "8px 0 0" } }, "이렇게 켜면 내 다른 컴퓨터만 서버 token으로 들어오고, 팀원 MCP(/mcp)는 열리지 않습니다."),
        )),
        h("div", { class: "form-grid", style: { marginTop: "14px" } },
          h("label", { class: "field wide" }, h("span", {}, "공개 주소"), address, h("small", {}, "Cloudflare에서 정한 Public hostname을 https://와 함께 넣습니다.")),
          h("label", { class: "field wide" }, h("span", {}, "통로 token"), token, h("small", {}, "이 컴퓨터에만 저장되고, 화면이나 기록에 다시 나오지 않습니다.")),
        ),
        h("div", { class: "form-actions" },
          button("열기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            const publicUrl = address.value.trim();
            if (!/^https:\/\/[^/?#]+\/?$/.test(publicUrl)) throw new Error("공개 주소는 https://로 시작하는 주소만 넣습니다. 뒤에 경로는 붙이지 않습니다.");
            if (!token.value.trim() && !share.tunnel?.tokenSaved) throw new Error("Cloudflare에서 복사한 통로 token을 넣으세요.");
            const body = { publicUrl: publicUrl.replace(/\/$/, "") };
            if (token.value.trim()) body.tunnelToken = token.value.trim();
            await cli("/api/server/share/enable", body);
            token.value = "";
            await redraw(true);
          }, { done: "열었습니다" }) }),
        ),
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
            h("div", { class: "sub" }, host.gateway?.ok ? "계정·모델·나눠 쓰는 방식은 게이트웨이 화면에서 정합니다." : host.gateway?.error || "")),
          h("div", { class: "end" }, button("게이트웨이 설정", { kind: "small quiet", onClick: () => go("models") })),
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
