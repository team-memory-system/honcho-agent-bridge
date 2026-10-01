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

    // 다른 컴퓨터에서 쓰기: a token gate in front of the API, reached one of two ways.
    // With a domain, a Cloudflare tunnel to a public hostname: the owner makes the
    // tunnel in the Cloudflare dashboard and pastes its token. Without one, Cloudflare
    // Mesh: devices of the same Cloudflare One account reach this computer's WARP
    // address, once the account allows it. Either way other computers get an address
    // and this server's token.
    function shareSection() {
      const box = h("div", {}, h("div", { class: "empty" }, spinner()));
      // Which way the owner picked while neither is on yet; kept across redraws.
      let way = null;
      const drawShare = async (check = false) => {
        let share;
        try {
          share = await cli("/api/server/share/status", { check });
        } catch (error) {
          clear(box, errorNotice(error));
          return;
        }
        const tunnelOn = share.tunnel?.enabled ?? share.enabled;
        const meshOn = share.mesh?.enabled === true;
        if (tunnelOn || meshOn) {
          clear(box, tunnelOn ? shareOn(share, drawShare) : null, meshOn ? meshPanelOn(share, drawShare) : null);
          return;
        }
        const pick = (next) => { way = next; drawChoice(); };
        const drawChoice = () => clear(box,
          shareWays(way, pick),
          way === "public" ? shareOff(share, drawShare) : null,
          way === "mesh" ? meshPanelOff(share, drawShare) : null,
        );
        drawChoice();
      };
      drawShare(false);
      return section({ id: "share", title: "다른 컴퓨터에서 쓰기", note: "다른 컴퓨터가 대화를 이 서버로 보내게 합니다. Cloudflare를 거쳐서만 열고, 서버 토큰이 없는 요청은 받지 않습니다." }, box);
    }

    function shareWays(way, pick) {
      const ways = [
        ["public", "도메인이 있음 (공개 주소)", "내 도메인의 주소 하나로 엽니다. Cloudflare 통로와 Access가 지킵니다."],
        ["mesh", "도메인이 없음 (Mesh: 같은 Cloudflare 계정의 기기만)", "같은 Cloudflare 계정의 WARP를 켠 기기끼리만 이 컴퓨터의 WARP 주소로 닿습니다."],
      ];
      return h("div", { class: "choices", style: { gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginBottom: "14px" } }, ways.map(([key, title, text]) => h("button", {
        class: `choice ${way === key ? "picked" : ""}`,
        type: "button",
        "aria-pressed": way === key ? "true" : "false",
        onclick: () => pick(key),
      }, h("b", {}, title), h("span", {}, text))));
    }

    // What the share status's mesh.problems codes mean, in the words of this screen.
    function meshProblemText(code, mesh) {
      switch (code) {
        case "warp-missing": return "이 컴퓨터에 Cloudflare WARP가 없습니다. 시작 화면에서 WARP를 설치하세요.";
        case "warp-not-team": return "이 컴퓨터의 WARP가 팀(Cloudflare One)에 등록되어 있지 않습니다. 같은 계정의 팀에 등록해야 다른 컴퓨터와 이어집니다.";
        case "warp-disconnected": return "이 컴퓨터의 WARP가 꺼져 있습니다. WARP를 켜면 Mesh 주소가 생깁니다.";
        case "no-mesh-ip": return "WARP는 켜져 있지만 Mesh 주소(100.96.x.x)가 없습니다. 계정의 기기 설정에서 가상 IP(use_zt_virtual_ip)를 켜야 합니다.";
        case "split-tunnel-include": return "이 컴퓨터의 WARP Split Tunnels가 Include 모드인데 100.96.0.0/12가 빠져 있습니다. 계정 주인이 기기 프로필의 Include 목록에 넣어야 합니다.";
        case "split-tunnel-exclude": return `이 컴퓨터의 WARP Split Tunnels가 Mesh 주소 범위를 빼고 있습니다${mesh?.splitTunnel?.blocking ? ` (${mesh.splitTunnel.blocking})` : ""}. 계정 주인이 기기 프로필의 Exclude 목록에서 그 항목을 빼야 합니다.`;
        case "firewall-missing": return mesh?.firewall?.cancelled
          ? "관리자 승인을 하지 않아 Windows 방화벽이 다른 컴퓨터의 접속을 막고 있습니다. '방화벽 허용'을 누르면 다시 묻습니다."
          : "Windows 방화벽이 다른 컴퓨터의 접속을 막고 있습니다. '방화벽 허용'을 누르면 관리자 승인 창이 한 번 뜹니다.";
        case "forwarder-down": return "Mesh 중계가 아직 돌지 않습니다. 몇 초 뒤 다시 확인하세요.";
        case "port-taken": return `다른 프로그램이 ${mesh?.port || "Mesh"} 포트를 쓰고 있어 Mesh 중계가 뜨지 못합니다. 그 프로그램을 끄거나, 에이전트에게 다른 포트로 다시 켜 달라고 하세요(주소가 바뀝니다).`;
        case "host-down": return "Mesh 중계를 돌리는 감시 프로그램이 꺼져 있습니다. 아래 '서버 옆에서 도는 것'에서 켜세요.";
        case "host-config-old": return "서버 옆 프로그램의 설정이 Mesh보다 오래되었습니다. 기억 서버를 한 번 다시 시작하세요.";
        case "address-changed": return `이 컴퓨터의 Mesh 주소가 바뀌었습니다${mesh?.addressChanged?.from ? ` (이전: ${mesh.addressChanged.from})` : ""}. 다른 컴퓨터의 연결 화면에 새 주소를 넣으세요.`;
        default: return "";
      }
    }

    // Done once, by whoever owns the Cloudflare account. The dashboard toggle has no
    // API; the rest an agent with the Cloudflare plugin can do.
    function meshAccountChecklist() {
      return h("div", { class: "notice share-guide" }, h("div", {},
        h("b", {}, "Cloudflare 계정에서 한 번만 해 둘 일 (계정 주인)"),
        h("ol", {},
          h("li", {}, "Cloudflare One 대시보드 → Networking → Mesh에서 'Allow all Cloudflare One traffic to reach enrolled devices'를 켭니다. 이것은 대시보드에서만 바꿀 수 있습니다."),
          h("li", {}, "기기 설정에서 가상 IP(use_zt_virtual_ip)와 Gateway 프록시(TCP, UDP)를 켭니다."),
          h("li", {}, "기기 프로필의 Split Tunnels가 100.96.0.0/12를 WARP로 보내게 합니다. Include 모드면 목록에 넣고, Exclude 모드면 그 범위를 덮는 항목(기본 목록의 100.64.0.0/10 등)을 뺍니다."),
          h("li", {}, "이 서버로 보낼 다른 컴퓨터도 같은 계정의 팀으로 WARP에 연결해 둡니다."),
        ),
        h("p", { class: "muted", style: { margin: "8px 0 0" } }, "2번과 3번은 Cloudflare 플러그인이 있는 에이전트에게 맡길 수 있습니다. 1번만 대시보드에서 직접 켭니다."),
      ));
    }

    function warpRow(mesh) {
      const warp = mesh?.warp || {};
      const split = mesh?.splitTunnelOk === true ? "Split Tunnels: Mesh 주소가 WARP로 감" : mesh?.splitTunnelOk === false ? "Split Tunnels: Mesh 주소가 WARP로 가지 않음" : "";
      const detail = !warp.installed ? "설치되어 있지 않습니다."
        : !warp.team ? "팀에 등록되어 있지 않습니다."
        : [`팀 ${warp.team}`, warp.connected ? null : "꺼져 있음", split].filter(Boolean).join(" · ");
      return h("div", { class: "row" },
        h("div", {}, h("div", { class: "title" }, statusTag(warp.connected && mesh?.splitTunnelOk !== false, ["준비됨", warp.connected ? "확인 필요" : "연결 안 됨"]), "이 컴퓨터의 WARP"), h("div", { class: "sub" }, detail)),
        h("div", { class: "end" }),
      );
    }

    function meshProblems(mesh, redraw) {
      const codes = (mesh?.problems || []).filter((code) => meshProblemText(code, mesh));
      if (!codes.length) return null;
      const firewall = codes.includes("firewall-missing");
      return h("div", { style: { marginTop: "12px" } }, notice(codes.some((code) => code !== "forwarder-down") ? "warn" : "",
        h("ul", { style: { margin: 0 } }, codes.map((code) => h("li", {}, meshProblemText(code, mesh)))),
        firewall ? h("div", { class: "form-actions", style: { marginTop: "8px" } }, button("방화벽 허용", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
          await cli("/api/server/share/mesh/enable", {});
          await redraw(false);
        }) })) : null,
      ));
    }

    function meshPanelOff(share, redraw) {
      const mesh = share.mesh || {};
      // Before it is on the CLI reports no problems; what this computer's WARP lacks is shown here.
      const ready = mesh.warp?.connected && mesh.splitTunnelOk !== false;
      return h("div", {},
        meshAccountChecklist(),
        h("div", { class: "rows", style: { marginTop: "14px" } }, warpRow(mesh)),
        ready ? null : h("p", { class: "muted", style: { fontSize: "12.5px", marginTop: "8px" } }, "WARP가 준비되지 않아도 켤 수는 있습니다. 켠 뒤에 무엇이 빠졌는지 알려 드립니다."),
        h("p", { class: "muted", style: { fontSize: "12.5px", marginTop: "8px" } }, "Windows에서는 켤 때 방화벽 허용을 위한 관리자 승인 창이 한 번 뜹니다."),
        h("div", { class: "form-actions" },
          button("켜기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            await cli("/api/server/share/mesh/enable", {});
            await redraw(false);
          }, { done: "Mesh로 열었습니다" }) }),
        ),
      );
    }

    const MESH_CHECK_STATES = {
      ok: ["ok", "이 컴퓨터 안의 길은 열려 있습니다", "Mesh 주소로 들어온 요청이 문지기를 거쳐 기억 서버까지 갑니다."],
      token: ["bad", "서버 토큰이 맞지 않습니다", "길은 열렸지만 문지기가 토큰을 받지 않았습니다. 서버를 다시 시작해 보세요."],
      unreachable: ["bad", "이 컴퓨터의 Mesh 주소로 닿지 않습니다", "WARP가 켜져 있는지, Mesh 중계가 도는지 확인하세요."],
      "local-only": ["ok", "이 컴퓨터의 중계와 문지기는 돌고 있습니다", "다만 이 컴퓨터가 자기 Mesh 주소로 보낸 요청은 돌아오지 않았습니다. WARP가 그 요청을 Cloudflare로 보내기 때문에, 계정의 Mesh 설정이 켜져 있어야 돌아옵니다. 다른 컴퓨터에서 연결해 보세요."],
      "no-address": ["warn", "Mesh 주소가 없습니다", "WARP를 켠 뒤 다시 확인하세요."],
      error: ["bad", "확인하지 못했습니다", ""],
    };

    function meshPanelOn(share, redraw) {
      const mesh = share.mesh || {};
      const check = mesh.check;
      const state = check ? MESH_CHECK_STATES[check.state] || MESH_CHECK_STATES.error : null;
      const open = Boolean(mesh.forwarder?.running && mesh.address);
      const tunnelOn = share.tunnel?.enabled === true;
      return h("div", { style: tunnelOn ? { marginTop: "18px" } : {} },
        h("div", { class: "rows" },
          h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, statusTag(open, ["열림", "닫힘"]), "Mesh 주소"), h("div", { class: "sub mono" }, mesh.address || "WARP를 켜면 주소가 생깁니다")),
            h("div", { class: "end" },
              mesh.address ? button("", { kind: "small icon-only", iconName: "copy", title: "주소 복사", onClick: async () => { await copyText(mesh.address); toast("주소를 복사했습니다. 다른 컴퓨터의 연결 화면에 넣으세요."); } }) : null,
              button("확인", { kind: "small", onClick: (event) => busy(event.currentTarget, () => redraw(true)) }),
            ),
          ),
          tunnelOn ? null : h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, statusTag(share.gate?.running, ["지키는 중", "멈춤"]), "문지기"), h("div", { class: "sub" }, "서버 토큰이 있는 요청만 기억 서버로 넘깁니다.")),
            h("div", { class: "end" },
              button("서버 토큰 복사", { kind: "small primary", onClick: (event) => busy(event.currentTarget, async () => {
                const result = await cli("/api/server/share/token", {});
                await copyText(result.token);
                toast("서버 토큰을 복사했습니다. 다른 컴퓨터의 연결 화면에 붙여 넣으세요.");
              }) }),
            ),
          ),
          warpRow(mesh),
        ),
        meshProblems(mesh, redraw),
        state ? h("div", { style: { marginTop: "12px" } }, notice(state[0], h("b", {}, state[1]), state[2] ? ` ${state[2]}` : "", check.error ? h("div", { class: "muted" }, check.error) : null)) : null,
        h("p", { class: "muted", style: { fontSize: "12.5px", marginTop: "10px" } }, "'확인'은 이 컴퓨터 안의 길만 봅니다. 다른 컴퓨터에서 닿으려면 계정의 Mesh 설정도 켜져 있어야 합니다."),
        h("details", { class: "raw", style: { marginTop: "6px" } }, h("summary", { class: "muted" }, "Cloudflare 계정에서 해 둘 일 다시 보기"), h("div", { style: { marginTop: "10px" } }, meshAccountChecklist())),
        h("div", { class: "form-actions" },
          tunnelOn ? null : button("서버 토큰 바꾸기", { kind: "small quiet", onClick: async (event) => {
            const ok = await confirmSheet({ title: "서버 토큰을 바꿀까요?", text: "지금 토큰을 쓰는 다른 컴퓨터는 모두 끊깁니다. 각 컴퓨터의 연결 화면에 새 토큰을 넣어야 다시 모입니다. 끊긴 동안의 대화는 다시 연결하면 이어서 보냅니다.", confirm: "바꾸기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => { await cli("/api/server/share/rotate", {}); await redraw(false); }, { done: "새 서버 토큰을 만들었습니다" });
          } }),
          button("끄기", { kind: "small quiet danger", onClick: async (event) => {
            const ok = await confirmSheet({
              title: "Mesh로 여는 길을 끌까요?",
              text: tunnelOn
                ? "Mesh 중계만 멈춥니다. 공개 주소와 문지기는 그대로 둡니다."
                : "Mesh 중계와 문지기를 멈춥니다. 다른 컴퓨터의 대화는 다시 켤 때까지 그 컴퓨터에 쌓여 있다가 이어서 옵니다. 토큰과 주소의 포트는 그대로 두니 다시 켜면 설정을 바꿀 필요가 없습니다.",
              confirm: "끄기",
              danger: true,
            });
            if (!ok) return;
            await busy(event.currentTarget, async () => { await cli("/api/server/share/mesh/disable", {}); await redraw(false); }, { done: "껐습니다" });
          } }),
        ),
      );
    }

    const PUBLIC_STATES = {
      ok: ["ok", "밖에서 닿습니다", "다른 컴퓨터에서 이 주소와 서버 토큰으로 연결하면 됩니다."],
      access: ["ok", "Cloudflare Access가 지키고 있습니다", "이 컴퓨터는 Access를 통과하지 못해 안쪽까지는 확인하지 못했습니다. WARP를 켠 다른 컴퓨터에서 연결해 보세요."],
      token: ["bad", "서버 토큰이 맞지 않습니다", "통로는 열렸지만 문지기가 토큰을 받지 않았습니다. 서버를 다시 시작해 보세요."],
      unreachable: ["bad", "밖에서 닿지 않습니다", "Cloudflare 대시보드에서 통로의 공개 주소가 이 주소이고, 서비스가 http://localhost:게이트 포트인지 확인하세요."],
      error: ["bad", "확인하지 못했습니다", ""],
    };

    function shareOn(share, redraw) {
      const check = share.publicCheck;
      const state = check ? PUBLIC_STATES[check.state] || PUBLIC_STATES.error : null;
      return h("div", {},
        h("div", { class: "rows" },
          h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, statusTag(share.tunnel?.running, ["열림", "통로 꺼짐"]), "공개 주소"), h("div", { class: "sub mono" }, share.publicUrl || "")),
            h("div", { class: "end" },
              button("", { kind: "small icon-only", iconName: "copy", title: "주소 복사", onClick: async () => { await copyText(share.publicUrl); toast("주소를 복사했습니다"); } }),
              button("밖에서 확인", { kind: "small", onClick: (event) => busy(event.currentTarget, () => redraw(true)) }),
            ),
          ),
          h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, statusTag(share.gate?.running, ["지키는 중", "멈춤"]), "문지기"), h("div", { class: "sub" }, "서버 토큰이 있는 요청만 기억 서버로 넘깁니다.", share.gate?.localUrl ? ` ${share.gate.localUrl}` : "")),
            h("div", { class: "end" },
              button("서버 토큰 복사", { kind: "small primary", onClick: (event) => busy(event.currentTarget, async () => {
                const result = await cli("/api/server/share/token", {});
                await copyText(result.token);
                toast("서버 토큰을 복사했습니다. 다른 컴퓨터의 연결 화면에 붙여 넣으세요.");
              }) }),
            ),
          ),
        ),
        state ? h("div", { style: { marginTop: "12px" } }, notice(state[0], h("b", {}, state[1]), state[2] ? ` ${state[2]}` : "", check.error ? h("div", { class: "muted" }, check.error) : null)) : null,
        h("div", { class: "form-actions" },
          button("서버 토큰 바꾸기", { kind: "small quiet", onClick: async (event) => {
            const ok = await confirmSheet({ title: "서버 토큰을 바꿀까요?", text: "지금 토큰을 쓰는 다른 컴퓨터는 모두 끊깁니다. 각 컴퓨터의 연결 화면에 새 토큰을 넣어야 다시 모입니다. 끊긴 동안의 대화는 다시 연결하면 이어서 보냅니다.", confirm: "바꾸기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => { await cli("/api/server/share/rotate", {}); await redraw(false); }, { done: "새 서버 토큰을 만들었습니다" });
          } }),
          button("닫기", { kind: "small quiet danger", onClick: async (event) => {
            const meshOn = share.mesh?.enabled === true;
            const ok = await confirmSheet({
              title: "다른 컴퓨터에서 쓰지 않게 닫을까요?",
              text: meshOn
                ? "공개 주소로 여는 통로만 멈춥니다. Mesh로 여는 길과 문지기는 그대로 둡니다."
                : "통로와 문지기를 멈춥니다. 다른 컴퓨터의 대화는 다시 열 때까지 그 컴퓨터에 쌓여 있다가 이어서 옵니다. 토큰은 그대로 두니 다시 열면 설정을 바꿀 필요가 없습니다.",
              confirm: "닫기",
              danger: true,
            });
            if (!ok) return;
            // Only the tunnel: with Mesh off as well, the CLI closes the gate too, as before.
            await busy(event.currentTarget, async () => { await cli("/api/server/share/disable", { mode: "tunnel" }); await redraw(false); }, { done: "닫았습니다" });
          } }),
        ),
      );
    }

    function shareOff(share, redraw) {
      const address = h("input", { class: "input", type: "url", placeholder: "https://memory.example.com", value: share.publicUrl || "" });
      const token = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: share.tunnel?.tokenSaved ? "저장된 통로 토큰을 그대로 씁니다" : "Cloudflare에서 복사한 통로 토큰" });
      const port = share.gate?.port || 8010;
      return h("div", {},
        h("div", { class: "notice share-guide" }, h("div", {},
          h("b", {}, "먼저 Cloudflare에서 통로를 만듭니다."),
          h("ol", {},
            h("li", {}, "Cloudflare Zero Trust 대시보드 → Networks → Tunnels → Create a tunnel → Cloudflared를 고르고 이름을 붙입니다."),
            h("li", {}, "설치 명령이 나오면 명령은 실행하지 말고, 그 안의 긴 토큰만 복사해 아래에 붙여 넣습니다."),
            h("li", {}, `Public hostname에 쓸 주소(예: memory.내도메인)를 정하고, Service는 HTTP, URL은 localhost:${port}로 둡니다.`),
            h("li", {}, "Access → Applications에서 그 주소를 등록하고, 내 팀 WARP 사용자만 들어오게 정책을 겁니다. WARP를 못 켜는 컴퓨터가 있으면 서비스 토큰도 하나 만듭니다."),
          ),
          h("p", { class: "muted", style: { margin: "8px 0 0" } }, "팀원이라면 관리자에게 통로 토큰과 주소를 받아 넣기만 하면 됩니다."),
        )),
        h("div", { class: "form-grid", style: { marginTop: "14px" } },
          h("label", { class: "field wide" }, h("span", {}, "공개 주소"), address, h("small", {}, "Cloudflare에서 정한 Public hostname을 https://와 함께 넣습니다.")),
          h("label", { class: "field wide" }, h("span", {}, "통로 토큰"), token, h("small", {}, "이 컴퓨터에만 저장되고, 화면이나 기록에 다시 나오지 않습니다.")),
        ),
        h("div", { class: "form-actions" },
          button("열기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            const publicUrl = address.value.trim();
            if (!/^https:\/\/[^/?#]+\/?$/.test(publicUrl)) throw new Error("공개 주소는 https://로 시작하는 주소만 넣습니다. 뒤에 경로는 붙이지 않습니다.");
            if (!token.value.trim() && !share.tunnel?.tokenSaved) throw new Error("Cloudflare에서 복사한 통로 토큰을 넣으세요.");
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
          text: "바꾸는 것을 먼저 확인합니다. 아직 아무것도 설치하지 않습니다.",
          done: false,
          body: [button("살펴보기", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            const plan = await post("/api/server/plan", { profile: "personal" });
            clear(planBox, planView(plan), details("자세한 결과", plan));
          }) }), planBox],
        },
        {
          title: "Docker와 Ollama 준비",
          text: dockerReady && ollamaReady
            ? "둘 다 이 컴퓨터에 있습니다."
            : `${[!server.docker?.installed ? "Docker Desktop" : null, !ollamaReady ? "Ollama" : null].filter(Boolean).join("과 ") || "Docker Desktop"}을 이 앱이 받아서 설치합니다.${!server.docker?.installed ? " Docker는 처음 켤 때 약관 동의와 암호 입력이 한 번 필요합니다." : server.docker?.running ? "" : " Docker Desktop이 꺼져 있으면 켭니다."}`,
          done: dockerReady && ollamaReady,
          body: dockerReady && ollamaReady ? [] : [button(server.docker?.installed ? "이어서 준비" : "받아서 설치", { kind: "small primary", onClick: prepare({ title: "Docker와 Ollama를 설치할까요?", text: "Docker Desktop(약 600MB)과 Ollama를 받아 설치합니다. Docker Desktop 창이 뜨면 약관에 동의하고 권장 설정을 고르세요.", confirm: "설치" }) })],
        },
        {
          title: "구독 게이트웨이 설치",
          text: gatewayUp
            ? `설치돼 있고 ${gatewayReport.endpoint || "라우터"}에서 답합니다.`
            : "Honcho 소스와 게이트웨이를 받고, 게이트웨이를 이 컴퓨터에 설치해 자동 시작하게 합니다. 몇 분 걸립니다.",
          done: gatewayUp,
          body: gatewayUp || !dockerReady ? [] : [button("설치", { kind: "small primary", onClick: prepare({ title: "구독 게이트웨이를 설치할까요?", text: "Honcho 소스와 게이트웨이를 받고 게이트웨이를 설치합니다. 계정 로그인이 필요해지면 거기서 멈춥니다.", confirm: "설치" }) })],
        },
        {
          title: "게이트웨이에 구독 계정 로그인",
          text: serving
            ? `계정 ${serving}개가 연결돼 있습니다. 기억 서버는 이 계정의 모델로 대화를 정리합니다.`
            : loggedIn
              ? "로그인한 계정이 아직 라우터에 연결되지 않았습니다. 게이트웨이 화면에서 연결하세요."
              : "기억 서버가 대화를 정리할 모델입니다. Codex나 Claude 구독 계정 하나면 됩니다. 브라우저에 로그인 창이 열립니다.",
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
          text: "게이트웨이 주소·키·모델을 서버 설정에 쓰고, 서버 파일을 놓고, 임베딩 모델을 받습니다. 임베딩 모델은 처음 한 번 몇 GB를 받습니다.",
          done: false,
          body: serving ? [button("준비", { kind: "small primary", onClick: prepare({ title: "기억 서버를 준비할까요?", text: "서버 설정과 파일을 쓰고 임베딩 모델을 받습니다. 몇 분에서 수십 분 걸릴 수 있습니다.", confirm: "준비" }) })] : [],
        },
        {
          title: "시작",
          text: "준비가 끝나면 이 화면에 기억 서버가 나타나고, 거기서 시작을 누릅니다. 처음에는 이미지를 만드느라 오래 걸립니다.",
          done: false,
          body: [],
        },
      ];
      // Looking at the plan is optional; the next thing to do is the first unfinished step after it.
      const current = steps.findIndex((step, index) => index > 0 && !step.done);
      return section({ title: "서버 설치", note: "기억 서버, 구독 게이트웨이, 임베딩 모델을 이 컴퓨터에 설치합니다." },
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
