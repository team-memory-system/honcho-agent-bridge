// 모델·계정: the subscription gateway, seen from here. Log Codex and Claude
// accounts in, choose how they share the load, try a model, and choose the one
// the memory server thinks with. Everything is the gateway's own API; this page
// only puts it in one place.
import { cli, gateway } from "../lib/api.js";
import { h, clear, copyText } from "../lib/dom.js";
import { ago, number } from "../lib/format.js";
import { app, go, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, confirmSheet, empty, errorNotice, notice, pageHead, section, segmented, spinner, tag, toast } from "../lib/ui.js";

const LOGIN_WAIT_MS = 5 * 60_000;

function backendName(backend) {
  return backend === "codex" ? "Codex" : backend === "claude" ? "Claude" : backend;
}

function planLabel(plan) {
  return plan ? String(plan).replace(/^\w/, (letter) => letter.toUpperCase()) : "";
}

export default {
  title: "모델·계정",
  async mount(page) {
    const body = h("div", { class: "pad" });
    const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침" });
    page.append(
      pageHead({
        title: "모델·계정",
        subtitle: "Codex·Claude 구독 계정을 API처럼 씁니다. 기억 서버도 여기 계정으로 생각합니다.",
        actions: [
          app.context?.gatewayUiUrl ? h("a", { class: "btn quiet", href: app.context.gatewayUiUrl, target: "_blank", rel: "noreferrer" }, "게이트웨이 화면") : null,
          refresh,
        ].filter(Boolean),
      }),
      h("div", { class: "page-body" }, body),
    );

    let report = null;
    let waiting = null;
    let timer = null;

    async function load() {
      try {
        report = await gateway.status();
        app.status.gateway.report = report;
        return null;
      } catch (error) {
        report = null;
        return error;
      }
    }

    async function draw() {
      const error = await load();
      if (!report) return drawDown(error);
      const accounts = report.accounts || [];
      const serving = new Set(report.servingAccounts || []);
      const models = report.models?.models || [];
      clear(body,
        waiting ? loginPanel() : null,
        overview(accounts, serving),
        accountsSection(accounts, serving),
        modelsSection(models, accounts),
        serverModelSection(models),
        servicesSection(report.services || []),
      );
    }

    function drawDown(error) {
      const local = Boolean(app.context?.localServer);
      clear(body,
        notice("warn",
          h("b", {}, "구독 게이트웨이가 꺼져 있거나 설치되지 않았습니다."),
          h("div", {}, local
            ? "이 컴퓨터의 기억 서버와 함께 설치돼 있으면 켤 수 있습니다."
            : "게이트웨이는 기억 서버를 두는 컴퓨터에 설치됩니다. 이 컴퓨터를 서버로 쓰려면 서버 화면에서 준비하세요."),
        ),
        h("div", { class: "form-actions" },
          button("게이트웨이 켜기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            await cli(local ? "/api/host/start" : "/api/gateway/open", {});
            await draw();
            refreshStatus();
          }, { done: "게이트웨이를 켰습니다" }) }),
          button("서버 화면으로", { onClick: () => go("server") }),
        ),
        error && !error.unreachable ? h("div", { style: { marginTop: "12px" } }, errorNotice(error)) : null,
      );
    }

    function overview(accounts, serving) {
      const loggedIn = accounts.filter((account) => account.login?.loggedIn).length;
      const unconnected = accounts.filter((account) => account.login?.loggedIn && !serving.has(account.id));
      return section({ title: "연결 상태" },
        h("div", { class: "rows" },
          h("div", { class: "row" },
            h("div", {},
              h("div", { class: "title" }, report.ready && serving.size ? tag("쓸 수 있음", "ok") : tag(loggedIn ? "연결 필요" : "로그인 필요", "warn"),
                `계정 ${number(serving.size)}개가 일하는 중`),
              h("div", { class: "sub" }, loggedIn ? `로그인한 계정 ${number(loggedIn)}개 · 모델 ${number(report.models?.models?.length || 0)}개` : "아래에서 Codex나 Claude 계정을 추가하세요."),
            ),
            h("div", { class: "end" },
              unconnected.length || (!report.ready && loggedIn) ? button("지금 연결", { kind: "primary small", onClick: (event) => connectNow(event.currentTarget) }) : null,
            ),
          ),
          report.endpoint ? h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, "API 주소"), h("div", { class: "sub" }, "다른 앱에서 OpenAI 호환 API로 부를 때 이 주소를 씁니다. 키는 게이트웨이 화면에서 확인합니다.")),
            h("div", { class: "end" }, h("code", { class: "mono" }, report.endpoint), button("", { kind: "small icon-only", iconName: "copy", title: "주소 복사", onClick: async () => { await copyText(report.endpoint); toast("주소를 복사했습니다"); } })),
          ) : null,
          h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, "계정을 나눠 쓰는 방식"),
              h("div", { class: "sub" }, report.mode === "balance" ? "요청을 계정마다 고르게 나눕니다." : "위 계정부터 쓰고, 한도에 걸리면 다음 계정으로 넘어갑니다.")),
            h("div", { class: "end" }, segmented([["drain", "순서대로"], ["balance", "고르게"]], report.mode, async (mode) => {
              try {
                await gateway.post("/mode", { mode });
                // The router reads the mode when it starts; connecting restarts it.
                if (report.ready) await gateway.post("/connect", {});
                toast(mode === "balance" ? "계정을 고르게 나눠 씁니다" : "순서대로 씁니다");
                draw();
              } catch (error) { toast(error.message, "bad"); }
            })),
          ),
        ),
      );
    }

    async function connectNow(control) {
      await busy(control, async () => {
        const result = await gateway.post("/connect", {});
        if (!result.ok) throw new Error(result.error || "연결하지 못했습니다.");
        await draw();
        refreshStatus();
      }, { done: "계정을 연결했습니다" });
    }

    function accountRow(account, index, list, serving) {
      const login = account.login || {};
      const routing = account.routing || {};
      const coolingUntil = routing.cooldown_until && new Date(routing.cooldown_until) > new Date() ? routing.cooldown_until : null;
      const state = !login.cliAvailable ? tag(`${backendName(account.backend)} 명령 없음`, "bad")
        : !login.loggedIn ? tag("로그인 안 됨", "warn")
          : coolingUntil ? tag("한도 회복 중", "warn")
            : serving.has(account.id) ? tag("일하는 중", "ok")
              : tag("연결 안 됨", "warn");
      const facts = [
        login.account || null,
        planLabel(login.plan) || null,
        routing.requests_in_window ? `최근 요청 ${number(routing.requests_in_window)}회` : null,
        routing.last_used_at ? `마지막 사용 ${ago(routing.last_used_at)}` : null,
        coolingUntil ? `${new Date(coolingUntil).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}까지 쉬는 중` : null,
        routing.last_limit_reason && coolingUntil ? routing.last_limit_reason : null,
      ].filter(Boolean);
      return h("div", { class: "row" },
        h("div", {},
          h("div", { class: "title" }, h("span", { class: `src ${account.backend}` }, account.backend === "codex" ? "X" : "C"), backendName(account.backend), h("span", { class: "muted mono" }, account.id), state),
          h("div", { class: "sub" }, facts.join(" · ") || (login.error || "")),
        ),
        h("div", { class: "end" },
          button("", { kind: "small icon-only quiet", iconName: "up", title: "위로", disabled: index === 0, onClick: () => move(account.id, "up") }),
          button("", { kind: "small icon-only quiet", iconName: "down", title: "아래로", disabled: index === list.length - 1, onClick: () => move(account.id, "down") }),
          login.loggedIn
            ? button("로그아웃", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
              const result = await gateway.post("/logout", { account: account.id });
              if (result.ok === false) throw new Error(result.error);
              await draw();
            }, { done: "로그아웃했습니다" }) })
            : login.cliAvailable ? button("로그인", { kind: "small primary", onClick: (event) => busy(event.currentTarget, async () => {
              const result = await gateway.post("/login", { account: account.id });
              if (result.ok === false) throw new Error(result.error);
              startWaiting(account.id, account.backend);
            }) }) : null,
          button("", { kind: "small icon-only quiet danger", iconName: "trash", title: "계정 빼기", onClick: async (event) => {
            const ok = await confirmSheet({
              title: `${backendName(account.backend)} 계정을 뺄까요?`,
              text: `${login.account || account.id} 계정의 로그인과 이 계정을 돌리던 프로그램을 정리합니다. 구독 자체는 그대로입니다.`,
              confirm: "빼기",
              danger: true,
            });
            if (!ok) return;
            await busy(event.currentTarget, async () => {
              const result = await gateway.post("/accounts/remove", { account: account.id });
              if (result.ok === false) throw new Error(result.error);
              await draw();
              refreshStatus();
            }, { done: "계정을 뺐습니다" });
          } }),
        ),
      );
    }

    async function move(id, direction) {
      try {
        await gateway.post("/accounts/move", { account: id, direction });
        // Order is priority, and the router reads it when it starts.
        if (report.ready) await gateway.post("/connect", {});
        draw();
      } catch (error) { toast(error.message, "bad"); }
    }

    function accountsSection(accounts, serving) {
      const add = (backend) => async (event) => {
        await busy(event.currentTarget, async () => {
          const result = await gateway.post("/accounts/add", { backend });
          if (!result.ok) throw new Error(result.error || "계정을 추가하지 못했습니다.");
          startWaiting(result.account.id, backend);
        });
      };
      return section({
        title: "구독 계정",
        note: "순서대로 쓰기에서는 위에 있는 계정을 먼저 씁니다. 같은 구독을 여러 번 넣으면 한도에 걸릴 때 다음 계정으로 넘어갑니다.",
        actions: [button("Codex 추가", { kind: "small", iconName: "plus", onClick: add("codex") }), button("Claude 추가", { kind: "small", iconName: "plus", onClick: add("claude") })],
      },
      accounts.length
        ? h("div", { class: "rows" }, accounts.map((account, index) => accountRow(account, index, accounts, serving)))
        : empty("아직 계정이 없습니다", "Codex나 Claude 계정을 추가하면 브라우저에서 로그인 창이 열립니다. 로그인을 마치면 여기로 돌아와 자동으로 연결됩니다."),
      );
    }

    function startWaiting(accountId, backend) {
      waiting = { accountId, backend, since: Date.now() };
      draw();
      clearInterval(timer);
      timer = setInterval(async () => {
        if (!waiting) return clearInterval(timer);
        if (Date.now() - waiting.since > LOGIN_WAIT_MS) {
          waiting = null;
          clearInterval(timer);
          toast("로그인을 5분 동안 기다렸지만 끝나지 않았습니다. 다시 시도하세요.", "bad");
          draw();
          return;
        }
        try {
          const next = await gateway.status();
          const account = (next.accounts || []).find((item) => item.id === waiting.accountId);
          if (account?.login?.loggedIn) {
            waiting = null;
            clearInterval(timer);
            const result = await gateway.post("/connect", {}).catch((error) => ({ ok: false, error: error.message }));
            toast(result.ok ? `${backendName(backend)} 계정을 연결했습니다` : `로그인은 됐지만 연결하지 못했습니다: ${result.error}`, result.ok ? "" : "bad");
            draw();
            refreshStatus();
          }
        } catch {}
      }, 3000);
    }

    function loginPanel() {
      return h("div", { class: "panel", style: { marginBottom: "24px", display: "flex", gap: "12px", alignItems: "center" } },
        spinner(),
        h("div", { style: { flex: "1" } },
          h("b", {}, `${backendName(waiting.backend)} 로그인을 기다리는 중`),
          h("div", { class: "muted", style: { fontSize: "13px" } }, "브라우저에 열린 로그인 창에서 계정을 고르고 허용하세요. 끝나면 이 화면이 알아서 연결합니다."),
        ),
        button("그만 기다리기", { kind: "small quiet", onClick: () => { waiting = null; clearInterval(timer); draw(); } }),
      );
    }

    function modelsSection(models, accounts) {
      const owners = new Map(accounts.map((account) => [account.id, account]));
      const groups = new Map();
      for (const model of models) {
        const owner = owners.get(model.ownedBy);
        const key = owner ? backendName(owner.backend) : model.ownedBy || "기타";
        if (!groups.has(key)) groups.set(key, new Map());
        groups.get(key).set(model.id, model);
      }
      const tester = h("div", {});
      return section({ title: "모델", note: "계정이 제공하는 모델입니다. 하나를 골라 바로 시험해 볼 수 있습니다." },
        models.length ? h("div", { class: "rows" }, [...groups].map(([group, entries]) => h("div", { class: "row", style: { alignItems: "flex-start" } },
          h("div", {}, h("div", { class: "title" }, group), h("div", { class: "chips", style: { marginTop: "8px" } },
            [...entries.values()].map((model) => h("button", { class: "chip mono", type: "button", onclick: () => openTester(tester, model.id) }, model.id)))),
          h("div", { class: "end" }, h("span", { class: "muted" }, `${entries.size}개`)),
        ))) : empty("쓸 수 있는 모델이 없습니다", "계정을 로그인하고 연결하면 모델이 보입니다."),
        tester,
      );
    }

    function openTester(container, model) {
      const prompt = h("input", { class: "input", value: "한 문장으로 자기소개 해 줘.", "aria-label": "시험 문장" });
      const answer = h("div", {});
      const run = button("보내기", { kind: "primary small", iconName: "send", onClick: (event) => busy(event.currentTarget, async () => {
        clear(answer, h("div", { class: "muted", style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "10px" } }, spinner(), "답을 기다리는 중…"));
        const result = await gateway.post("/chat", { model, prompt: prompt.value });
        if (!result.ok) { clear(answer, errorNotice(new Error(result.error))); return; }
        clear(answer, h("div", { class: "panel sunk", style: { marginTop: "10px" } }, h("div", { class: "prose" }, result.reply), h("div", { class: "muted", style: { fontSize: "12px", marginTop: "8px" } }, `${result.model} · ${(result.elapsedMs / 1000).toFixed(1)}초`)));
      }) });
      prompt.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) run.click(); });
      clear(container, h("div", { class: "panel", style: { marginTop: "12px" } },
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" } }, h("b", {}, "시험"), h("code", { class: "mono" }, model), h("span", { style: { flex: "1" } }), button("", { kind: "small quiet icon-only", iconName: "close", title: "닫기", onClick: () => clear(container) })),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: "8px" } }, prompt, run),
        answer,
      ));
      prompt.focus();
    }

    function serverModelSection(models) {
      const local = app.context?.localServer;
      if (!local) {
        return section({ title: "기억 서버가 쓰는 모델", note: "기억 서버가 대화를 정리하고 질문에 답할 때 쓰는 모델입니다." },
          notice("", "이 컴퓨터에는 이 앱으로 설치한 기억 서버가 없어 여기서 바꿀 수 없습니다. 서버를 둔 컴퓨터에서 바꾸세요."));
      }
      const current = local.chatModel || "";
      const choice = h("select", { class: "select", style: { width: "auto", minWidth: "220px" }, "aria-label": "기억 서버 모델" },
        models.map((model) => h("option", { value: model.id, selected: model.id === current ? true : null }, model.id)));
      return section({ title: "기억 서버가 쓰는 모델", note: "대화를 정리하고, 묻기에 답할 때 쓰는 모델입니다. 바꾸면 기억 서버를 다시 시작합니다." },
        h("div", { class: "rows" }, h("div", { class: "row" },
          h("div", {}, h("div", { class: "title" }, current ? h("code", { class: "mono" }, current) : "정해지지 않음"), h("div", { class: "sub" }, "지금 설정")),
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

    function servicesSection(services) {
      return section({ title: "게이트웨이 안의 프로그램", note: "계정마다 하나씩 도는 어댑터와, 요청을 나눠 주는 라우터입니다. 보통은 건드릴 일이 없습니다." },
        h("div", { class: "rows" }, services.map((service) => h("div", { class: "row" },
          h("div", {}, h("div", { class: "title" }, service.label || service.name, service.running ? tag("실행 중", "ok") : tag("멈춤")), h("div", { class: "sub mono" }, service.url || "")),
          h("div", { class: "end" }, service.running
            ? button("멈추기", { kind: "small", iconName: "stop", onClick: (event) => busy(event.currentTarget, async () => { const result = await gateway.post("/stop", { service: service.name }); if (result.ok === false) throw new Error(result.error); await draw(); refreshStatus(); }) })
            : button("시작", { kind: "small", iconName: "play", onClick: (event) => busy(event.currentTarget, async () => { const result = await gateway.post("/start", { service: service.name }); if (result.ok === false) throw new Error(result.error); await draw(); refreshStatus(); }) })),
        ))),
      );
    }

    refresh.addEventListener("click", () => busy(refresh, draw));
    clear(body, h("div", { class: "empty" }, spinner()));
    await draw();
    return { cleanup: () => clearInterval(timer) };
  },
};
