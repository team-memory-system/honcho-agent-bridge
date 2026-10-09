// 서버 → 모델: the models the memory server on this computer uses. The subscription
// gateway turns ChatGPT (its codex backend) and Claude accounts into chat models:
// the accounts are a list to log in, order and take out, 계정 더하기 opens a window
// that logs one in (lib/login.js), and the model the memory server sorts and answers
// with is chosen in its own window. The Ollama embedding model kept resident by the
// host supervisor sits below; the gateway's own programs and models are folded away.
// Everything about accounts is the gateway's own API.
import { cli, gateway, post } from "../lib/api.js";
import { accountGroups, modelGroups, sharedGroups } from "../lib/accounts.js";
import { h, clear, copyText } from "../lib/dom.js";
import { ago, number } from "../lib/format.js";
import { block, confirmWindow, kv, list, listItem, modal, opt, opts } from "../lib/kit.js";
import { gatewayLogin } from "../lib/login.js";
import { screenTabs } from "../lib/tabs.js";
import { app, go, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, errorNotice, notice, pageHead, segmented, spinner, statusTag, tag, toast } from "../lib/ui.js";

// What a person subscribes to, by the gateway's backend.
const SUBSCRIPTION = { codex: "ChatGPT", claude: "Claude" };
const subscription = (backend) => SUBSCRIPTION[backend] || backend || "기타";

function planLabel(plan) {
  return plan ? String(plan).replace(/^\w/, (letter) => letter.toUpperCase()) : "";
}

/** 계정 더하기: which subscription, then that account's login, in one window. */
function openAddAccount(onDone, backend = null) {
  let panel = null;
  // Closed any way while the login waits, the login stops and its account goes.
  const win = modal({ title: "구독 계정 더하기", big: true, small: true, onClose: () => panel?.cancel() });
  let chosen = backend || "codex";
  const start = () => {
    panel = gatewayLogin({ backend: chosen, label: `${subscription(chosen)} 로그인을 기다리는 중` });
    win.body(h("p", { class: "lead", style: { marginTop: "4px" } }, `${subscription(chosen)} 구독 계정으로 로그인합니다. 브라우저에 로그인 창이 열립니다.`), panel.root);
    win.foot(null, button("닫기", { onClick: () => { panel.cancel(); win.close(); } }));
    panel.done.then((ok) => {
      if (!ok) return;
      win.close("ok");
      onDone();
      refreshStatus();
      toast(`${subscription(chosen)} 계정을 연결했습니다.`, "ok");
    });
  };
  if (backend) {
    win.open();
    start();
    return;
  }
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } }, "기억 서버가 모델을 부를 때 쓸 구독 계정을 더합니다."),
    opts(...["codex", "claude"].map((key) => opt({
      name: "subscription", value: key, checked: key === chosen,
      title: `${subscription(key)} 구독`,
      sub: key === "codex" ? "ChatGPT 계정으로 로그인합니다." : "Claude 계정으로 로그인합니다.",
      onChange: () => { chosen = key; },
    }))));
  win.foot(null, [button("취소", { kind: "quiet", onClick: () => win.close() }), button("로그인", { kind: "primary", onClick: start })]);
  win.open();
}

/** 기억 서버가 쓰는 모델: one of the gateway's models, tried before it is chosen. */
function openServerModel(report, onDone) {
  const current = app.context?.localServer?.chatModel || "";
  const groups = modelGroups(report?.models?.models, report?.accounts);
  let chosen = current || groups[0]?.models[0] || "";
  const tried = h("span", { class: "muted", style: { fontSize: "12.5px" } });
  const win = modal({ title: "기억 서버가 쓰는 모델", big: true, small: true });
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } }, "구독 게이트웨이에 로그인한 계정의 모델입니다."),
    groups.length
      ? h("div", { class: "opts pt-scroll" }, groups.flatMap((group) => group.models.map((id) => opt({
        name: "server-model", value: id, checked: id === chosen,
        title: h("span", { class: "mono" }, id),
        sub: subscription(group.backend),
        end: id === current ? tag("지금 씀") : null,
        onChange: () => { chosen = id; clear(tried); },
      }))))
      : notice("warn", "고를 수 있는 모델이 없습니다. 구독 계정을 로그인하고 연결하세요."),
    groups.length ? h("div", { class: "row2" }, button("써 보기", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
      clear(tried, "묻는 중…");
      const result = await post("/api/gw/api/chat", { model: chosen, prompt: "한 문장으로 인사해 주세요." });
      clear(tried, result.ok ? `${chosen} · 답함 · ${(Number(result.elapsedMs || 0) / 1000).toFixed(1)}초` : `${chosen} · 답하지 않음 ${result.error || ""}`);
    }) }), tried) : null,
    h("p", { class: "hint" }, "적용하면 기억 서버 설정을 고치고 다시 시작합니다. 1~2분 동안 기억을 쓰거나 찾을 수 없습니다."));
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("적용", { kind: "primary", disabled: !groups.length, onClick: (event) => busy(event.currentTarget, async () => {
      if (chosen === current) { win.close(); return; }
      await cli("/api/server/start", { profile: "personal", model: chosen });
      win.close("ok");
      await loadContext();
      onDone();
      refreshStatus();
      toast(`${chosen}로 바꿨습니다.`, "ok");
    }) }),
  ]);
  win.open();
}

export default {
  title: "모델",
  async mount(page, params) {
    const body = h("div", { class: "pad stack" });
    page.append(
      pageHead({ title: "서버", subtitle: "기억 서버가 쓰는 모델, 구독 게이트웨이, 임베딩 모델을 관리합니다.", subnav: screenTabs("models") }),
      h("div", { class: "page-body" }, body),
    );
    let report = null;
    let host = null;
    let advancedOpen = false;

    async function load() {
      const [gatewayResult, hostResult] = await Promise.allSettled([gateway.status(), post("/api/host/status", {})]);
      host = hostResult.status === "fulfilled" ? hostResult.value : null;
      if (gatewayResult.status === "rejected") { report = null; return gatewayResult.reason; }
      report = gatewayResult.value;
      app.status.gateway.report = report;
      return null;
    }

    async function draw() {
      const error = await load();
      if (!report) { drawDown(error); return; }
      const accounts = report.accounts || [];
      const serving = new Set(report.servingAccounts || []);
      clear(body, accountsList(accounts, serving), modeBlock(), serverModelBlock(), embeddingBlock(), advanced());
    }

    function drawDown(error) {
      const local = Boolean(app.context?.localServer);
      clear(body,
        notice("warn", h("b", {}, "구독 게이트웨이가 꺼져 있거나 설치되지 않았습니다."),
          h("div", {}, local ? "이 컴퓨터의 기억 서버와 함께 설치돼 있으면 켤 수 있습니다." : "게이트웨이는 기억 서버를 두는 컴퓨터에 설치됩니다.")),
        h("div", { class: "form-actions" },
          button("게이트웨이 켜기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            await cli(local ? "/api/host/start" : "/api/gateway/open", {});
            await draw();
            refreshStatus();
          }, { done: "게이트웨이를 켰습니다" }) }),
          button("기억 서버로", { onClick: () => go("server") })),
        error && !error.unreachable ? errorNotice(error) : null,
        embeddingBlock());
    }

    function accountRow(entry, group, serving) {
      const { account } = entry;
      const login = account.login || {};
      const routing = account.routing || {};
      const coolingUntil = routing.cooldown_until && new Date(routing.cooldown_until) > new Date() ? routing.cooldown_until : null;
      const state = !login.cliAvailable ? `${subscription(account.backend)} 명령 없음`
        : !login.loggedIn ? "로그인 안 됨"
          : coolingUntil ? `사용 한도 · ${new Date(coolingUntil).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}에 풀림`
            : serving.has(account.id) ? "쓰는 중" : "연결 안 됨";
      const facts = [state, planLabel(login.plan) || null, routing.last_used_at ? `마지막 사용 ${ago(routing.last_used_at)}` : null].filter(Boolean);
      const name = login.account || account.id;
      return listItem({
        title: [h("span", { class: `src ${account.backend}` }, account.backend === "codex" ? "X" : "C"), `${subscription(account.backend)} `, h("span", { class: "mono muted" }, name)],
        tags: group.ordered && report.mode !== "balance" ? [" ", tag(`${entry.position}번째`)] : [],
        sub: facts.join(" · "),
        end: [
          group.ordered ? button("", { kind: "small icon-only quiet", iconName: "up", title: `${name} 위로`, disabled: !entry.canMoveUp, onClick: (event) => move(event.currentTarget, account.id, "up") }) : null,
          group.ordered ? button("", { kind: "small icon-only quiet", iconName: "down", title: `${name} 아래로`, disabled: !entry.canMoveDown, onClick: (event) => move(event.currentTarget, account.id, "down") }) : null,
          login.loggedIn
            ? button("로그아웃", { kind: "small quiet", onClick: (event) => busy(event.currentTarget, async () => {
              const result = await gateway.post("/logout", { account: account.id });
              if (result.ok === false) throw new Error(result.error);
              await draw();
            }, { done: "로그아웃했습니다" }) })
            : login.cliAvailable ? button("로그인", { kind: "small primary", onClick: () => {
              const panel = gatewayLogin({ backend: account.backend, accountId: account.id });
              const win = modal({ title: `${subscription(account.backend)} 로그인`, big: true, small: true, onClose: () => panel.cancel() });
              win.body(panel.root);
              win.foot(null, button("닫기", { onClick: () => { panel.cancel(); win.close(); } }));
              win.open();
              panel.done.then((ok) => { if (ok) { win.close("ok"); draw(); refreshStatus(); } });
            } }) : null,
          button("", { kind: "small icon-only quiet danger", iconName: "trash", title: "계정 빼기", onClick: async (event) => {
            const ok = await confirmWindow({ title: `${subscription(account.backend)} 계정을 뺄까요?`, text: `${name} 계정의 로그인과 이 계정을 돌리던 프로그램을 정리합니다. 구독 자체는 그대로입니다.`, confirm: "빼기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => {
              const result = await gateway.post("/accounts/remove", { account: account.id });
              if (result.ok === false) throw new Error(result.error);
              await draw();
              refreshStatus();
            }, { done: "계정을 뺐습니다" });
          } }),
        ],
      });
    }

    // The gateway swaps an account only with its neighbour of the same backend.
    async function move(control, id, direction) {
      await busy(control, async () => {
        const result = await gateway.post("/accounts/move", { account: id, direction });
        if (result?.ok === false) throw new Error(result.error || "순서를 바꾸지 못했습니다.");
        // Order is priority, and the router reads it when it starts.
        if (report.ready) await gateway.post("/connect", {});
        await draw();
      });
    }

    function accountsList(accounts, serving) {
      const loggedIn = accounts.filter((account) => account.login?.loggedIn);
      const unconnected = loggedIn.some((account) => !serving.has(account.id)) || (!report.ready && loggedIn.length);
      const rows = accountGroups(accounts).flatMap((group) => group.accounts.map((entry) => accountRow(entry, group, serving)));
      return list({
        title: `구독 계정 ${number(accounts.length)}개`,
        actions: [
          unconnected ? button("지금 연결", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            const result = await gateway.post("/connect", {});
            if (!result.ok) throw new Error(result.error || "연결하지 못했습니다.");
            await draw();
            refreshStatus();
          }, { done: "계정을 연결했습니다" }) }) : null,
          button("계정 더하기", { kind: "small", onClick: () => openAddAccount(draw) }),
        ],
        empty: "아직 구독 계정이 없습니다. 계정 더하기로 ChatGPT나 Claude 구독 계정에 로그인하세요.",
      }, rows);
    }

    /** With two accounts of one subscription: use the first to its limit, or spread the load. */
    function modeBlock() {
      const shared = sharedGroups(accountGroups(report.accounts || []));
      if (!shared.length) return null;
      return block({ title: "계정을 나눠 쓰는 방식" },
        kv("방식", h("div", {},
          segmented([["drain", "순서대로"], ["balance", "고르게"]], report.mode, async (mode) => {
            try {
              await gateway.post("/mode", { mode });
              if (report.ready) await gateway.post("/connect", {});
              toast(mode === "balance" ? "요청을 계정마다 고르게 나눕니다" : "위 계정부터 순서대로 씁니다");
              draw();
            } catch (error) { toast(error.message, "bad"); }
          }),
          h("div", { class: "s" }, "순서대로: 위 계정을 한도까지 쓰고 다음 계정으로. 고르게: 요청을 계정마다 나눕니다."))));
    }

    function serverModelBlock() {
      if (!app.context?.localServer) return null;
      const current = app.context.localServer.chatModel || "";
      const owner = modelGroups(report?.models?.models, report?.accounts).find((group) => group.models.includes(current));
      return block({ title: "기억 서버가 쓰는 모델", actions: [button("수정", { onClick: () => openServerModel(report, draw) })] },
        kv("정리·묻기 모델", current ? [h("span", { class: "mono" }, current), owner ? ` · ${subscription(owner.backend)}` : h("span", { class: "muted" }, " · 게이트웨이에 없음")] : "정해지지 않음"));
    }

    // The Ollama embedding model. The supervisor keeping it resident starts at login
    // by itself; 켜기 is for when it was stopped or failed.
    function embeddingBlock() {
      if (!host?.installed) return null;
      const ollama = host.ollama || {};
      const up = Boolean(ollama.healthy && ollama.resident);
      const watching = Boolean(host.supervisor?.processAlive);
      return block({
        title: "임베딩 모델",
        actions: up && watching ? [] : [button("켜기", { kind: "small primary", iconName: "play", onClick: (event) => busy(event.currentTarget, async () => {
          await cli("/api/host/start", {});
          await draw();
          refreshStatus();
        }, { done: "켰습니다" }) })],
      }, kv("모델", [ollama.model ? h("span", { class: "mono" }, ollama.model) : "Ollama", " · ", up ? "Ollama에 올라가 있음" : ollama.healthy ? "모델이 내려가 있음" : "Ollama 꺼짐",
        watching ? null : h("div", { class: "s" }, "감시가 꺼져 있습니다. 켜기를 누르세요.")]));
    }

    function advanced() {
      const groups = modelGroups(report.models?.models, report.accounts);
      const fold = h("details", { class: "fold", open: advancedOpen || null },
        h("summary", {}, "고급 · 게이트웨이의 모델과 프로그램"),
        report.endpoint ? h("div", { class: "row2" }, "API 주소 ", h("span", { class: "mono" }, report.endpoint),
          button("", { kind: "small icon-only quiet", iconName: "copy", title: "주소 복사", onClick: async () => { await copyText(report.endpoint); toast("주소를 복사했습니다"); } }),
          app.context?.gatewayUiUrl ? h("a", { class: "btn quiet small", href: app.context.gatewayUiUrl, target: "_blank", rel: "noreferrer" }, "게이트웨이 화면") : null) : null,
        groups.map((group) => [h("div", { class: "label" }, `${subscription(group.backend)} 모델 ${number(group.models.length)}개`),
          h("div", { class: "opts" }, group.models.map((id) => h("div", { class: "swrow" },
            h("div", { class: "ab" }, h("div", { class: "t mono" }, id)),
            button("써 보기", { kind: "small quiet", onClick: () => go(`ask/model/${encodeURIComponent(id)}`) }))))]),
        h("div", { class: "label" }, "게이트웨이 안의 프로그램"),
        h("div", { class: "opts" }, (report.services || []).map((service) => h("div", { class: "swrow" },
          h("div", { class: "ab" }, h("div", { class: "t" }, service.label || service.name, " ", statusTag(service.running, ["실행 중", "멈춤"])), h("div", { class: "s mono" }, service.url || "")),
          service.running
            ? button("멈추기", { kind: "small", iconName: "stop", onClick: (event) => busy(event.currentTarget, async () => { const result = await gateway.post("/stop", { service: service.name }); if (result.ok === false) throw new Error(result.error); await draw(); refreshStatus(); }) })
            : button("시작", { kind: "small", iconName: "play", onClick: (event) => busy(event.currentTarget, async () => { const result = await gateway.post("/start", { service: service.name }); if (result.ok === false) throw new Error(result.error); await draw(); refreshStatus(); }) })))));
      fold.addEventListener("toggle", () => { advancedOpen = fold.open; });
      return fold;
    }

    clear(body, spinner());
    await draw();
    // Another screen's "log in" button lands here as #/models/add/<backend>.
    if (params[0] === "add" && ["codex", "claude"].includes(params[1])) {
      history.replaceState(null, "", "#/models");
      if (report) openAddAccount(draw, params[1]);
    }
    return null;
  },
};
