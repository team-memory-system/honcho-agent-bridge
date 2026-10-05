// 게이트웨이: the subscription gateway, seen from here. Log Codex and Claude
// accounts in, order them inside each backend and choose how they share the load,
// and see the models they offer (써 보기 opens 묻기 with that model). Which model
// the memory server uses is a server setting, on the 서버 screen. Everything is
// the gateway's own API; this page only puts it in one place.
import { cli, gateway } from "../lib/api.js";
import { accountGroups, backendName, loginEnded, loginPanelText, loginPrompt, loginSubmission, modelGroups, pendingLogin, sharedGroups, signInLink } from "../lib/accounts.js";
import { h, clear, copyText } from "../lib/dom.js";
import { ago, number } from "../lib/format.js";
import { app, go, refreshStatus } from "../lib/state.js";
import { button, busy, confirmSheet, empty, errorNotice, notice, pageHead, section, segmented, spinner, tag, toast } from "../lib/ui.js";

const LOGIN_WAIT_MS = 5 * 60_000;

function planLabel(plan) {
  return plan ? String(plan).replace(/^\w/, (letter) => letter.toUpperCase()) : "";
}

export default {
  title: "게이트웨이",
  async mount(page, params) {
    const body = h("div", { class: "pad" });
    const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침" });
    page.append(
      pageHead({
        title: "구독 게이트웨이",
        subtitle: "Codex·Claude 구독 계정을 모델 API로 바꿔 줍니다. 계정을 넣고 나눠 쓰는 방식을 정하고, 모델을 써 봅니다.",
        actions: [
          app.context?.gatewayUiUrl ? h("a", { class: "btn quiet", href: app.context.gatewayUiUrl, target: "_blank", rel: "noreferrer" }, "게이트웨이 화면") : null,
          refresh,
        ].filter(Boolean),
      }),
      h("div", { class: "page-body" }, body),
    );

    let report = null;
    // The login this screen waits on: { accountId, backend, since, prompt, view }.
    // `prompt` is null from a gateway that sends none, which keeps the old notice.
    let waiting = null;
    let timer = null;
    // The advanced part stays open across redraws once someone opened it.
    let advancedOpen = false;

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
      // A login the gateway still waits on, started before this screen opened.
      if (!waiting) {
        const found = pendingLogin(accounts);
        if (found) beginWaiting(found.accountId, found.backend, found.prompt);
      }
      const serving = new Set(report.servingAccounts || []);
      const models = report.models?.models || [];
      const typing = typingIn(waiting?.view?.root);
      clear(body,
        waiting ? (waiting.view ? waiting.view.root : loginPanel()) : null,
        overview(accounts, serving),
        accountsSection(accounts, serving),
        modelsSection(models, accounts),
        servicesSection(report.services || []),
      );
      typing();
    }

    // Redrawing moves the login panel, the same element, back into place; the
    // box it holds keeps its text, and gets its caret back here.
    function typingIn(root) {
      const active = document.activeElement;
      if (!root || !active || !root.contains(active)) return () => {};
      const { selectionStart, selectionEnd } = active;
      return () => {
        if (!active.isConnected) return;
        active.focus({ preventScroll: true });
        try { active.setSelectionRange(selectionStart, selectionEnd); } catch {}
      };
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
                serving.size ? `계정 ${number(serving.size)}개가 일하는 중` : "일하는 계정 없음"),
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

    function accountRow(entry, group, serving) {
      const { account } = entry;
      const login = account.login || {};
      const routing = account.routing || {};
      const coolingUntil = routing.cooldown_until && new Date(routing.cooldown_until) > new Date() ? routing.cooldown_until : null;
      const state = !login.cliAvailable ? tag(`${backendName(account.backend)} 명령 없음`, "bad")
        : !login.loggedIn ? tag("로그인 안 됨", "warn")
          : coolingUntil ? tag("한도 회복 중", "warn")
            : serving.has(account.id) ? tag("일하는 중", "ok")
              : tag("연결 안 됨", "warn");
      const facts = [
        planLabel(login.plan) || null,
        routing.requests_in_window ? `최근 요청 ${number(routing.requests_in_window)}회` : null,
        routing.last_used_at ? `마지막 사용 ${ago(routing.last_used_at)}` : null,
        coolingUntil ? `${new Date(coolingUntil).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}까지 쉬는 중` : null,
        routing.last_limit_reason && coolingUntil ? routing.last_limit_reason : null,
      ].filter(Boolean);
      const name = login.account || account.id;
      // In drain mode the number is the order the gateway uses them in.
      const rank = group.ordered && report.mode !== "balance" ? h("span", { class: "gw-rank", title: `${entry.position}번째로 씀` }, String(entry.position)) : null;
      return h("div", { class: "row" },
        h("div", {},
          h("div", { class: "title" }, rank, h("span", { class: `src ${account.backend}`, "aria-hidden": "true" }, account.backend === "codex" ? "X" : "C"), h("span", { class: "gw-name" }, name),
            login.account ? h("span", { class: "muted mono" }, account.id) : null, state),
          h("div", { class: "sub" }, facts.join(" · ") || (login.error || "")),
        ),
        h("div", { class: "end" },
          group.ordered ? h("span", { class: "gw-move" },
            button("", { kind: "small icon-only quiet", iconName: "up", title: `${name} 위로`, disabled: !entry.canMoveUp, onClick: (event) => move(event.currentTarget, account.id, "up") }),
            button("", { kind: "small icon-only quiet", iconName: "down", title: `${name} 아래로`, disabled: !entry.canMoveDown, onClick: (event) => move(event.currentTarget, account.id, "down") }),
          ) : null,
          login.loggedIn
            ? button("로그아웃", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
              const result = await gateway.post("/logout", { account: account.id });
              if (result.ok === false) throw new Error(result.error);
              await draw();
            }, { done: "로그아웃했습니다" }) })
            : login.cliAvailable ? button("로그인", { kind: "small primary", onClick: (event) => busy(event.currentTarget, async () => {
              const result = await gateway.post("/login", { account: account.id });
              if (result.ok === false) throw new Error(result.error);
              startWaiting(account.id, account.backend, result.prompt);
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

    // The gateway swaps an account only with its neighbour of the same backend,
    // which is why the arrows live inside each backend's group.
    async function move(control, id, direction) {
      await busy(control, async () => {
        const result = await gateway.post("/accounts/move", { account: id, direction });
        if (result?.ok === false) throw new Error(result.error || "순서를 바꾸지 못했습니다.");
        // Order is priority, and the router reads it when it starts.
        if (report.ready) await gateway.post("/connect", {});
        await draw();
      });
    }

    function addButtons(kind) {
      const add = (backend) => (event) => busy(event.currentTarget, () => addAccount(backend));
      return [
        button("Codex 계정 추가", { kind, iconName: "plus", title: "ChatGPT 구독 계정으로 로그인합니다", onClick: add("codex") }),
        button("Claude 계정 추가", { kind, iconName: "plus", title: "Claude 구독 계정으로 로그인합니다", onClick: add("claude") }),
      ];
    }

    function modeBlock(shared) {
      const scope = shared.length > 1
        ? `${shared.map((group) => group.label).join("·")} 계정 각각 안에서 적용됩니다.`
        : `${shared[0].label} 계정 ${number(shared[0].accounts.length)}개에 적용됩니다.`;
      return h("div", { class: "gw-mode" },
        h("div", {},
          h("div", { class: "title" }, "계정을 나눠 쓰는 방식"),
          h("div", { class: "sub" }, h("b", {}, "순서대로"), ": 위 계정을 한도까지 쓰고 다음 계정으로. ", h("b", {}, "고르게"), ": 요청을 계정마다 나눔."),
          h("div", { class: "sub" }, scope),
        ),
        segmented([["drain", "순서대로"], ["balance", "고르게"]], report.mode, async (mode) => {
          try {
            await gateway.post("/mode", { mode });
            // The router reads the mode when it starts; connecting restarts it.
            if (report.ready) await gateway.post("/connect", {});
            toast(mode === "balance" ? "요청을 계정마다 고르게 나눕니다" : "위 계정부터 순서대로 씁니다");
            draw();
          } catch (error) { toast(error.message, "bad"); }
        }),
      );
    }

    function accountsSection(accounts, serving) {
      const intro = "게이트웨이가 모델을 부를 때 쓰는 Codex·Claude 구독 계정입니다. 브라우저에서 로그인해 추가합니다.";
      if (!accounts.length) {
        return section({ title: "구독 계정", note: intro },
          h("div", { class: "gw-empty" },
            empty("아직 구독 계정이 없습니다", "Codex는 ChatGPT 구독, Claude는 Claude 구독 계정으로 로그인합니다. 하나면 되고, 로그인을 마치면 이 화면이 알아서 연결합니다.", ...addButtons("primary")),
          ),
        );
      }
      const groups = accountGroups(accounts);
      const shared = sharedGroups(groups);
      // With one group to explain, the choice sits under that group; with more, under all of them.
      const modeIn = (group) => (shared.length === 1 && shared[0] === group ? modeBlock(shared) : null);
      return section({ title: "구독 계정", note: intro },
        h("div", { class: "gw-add" }, addButtons("")),
        groups.map((group) => h("div", { class: "gw-group" },
          h("div", { class: "gw-group-head" },
            h("b", {}, group.label),
            h("span", {}, [`계정 ${number(group.accounts.length)}개`, group.ordered ? (report.mode === "balance" ? "고르게 나눠 씀" : "위 계정부터 씀") : null].filter(Boolean).join(" · ")),
          ),
          h("div", { class: "rows" }, group.accounts.map((entry) => accountRow(entry, group, serving))),
          modeIn(group),
        )),
        shared.length > 1 ? modeBlock(shared) : null,
      );
    }

    async function addAccount(backend) {
      const result = await gateway.post("/accounts/add", { backend });
      if (!result.ok) throw new Error(result.error || "계정을 추가하지 못했습니다.");
      startWaiting(result.account.id, backend, result.login?.prompt);
    }

    function startWaiting(accountId, backend, prompt) {
      beginWaiting(accountId, backend, prompt);
      draw();
    }

    function beginWaiting(accountId, backend, prompt) {
      const current = { accountId, backend, since: Date.now(), prompt: loginPrompt(prompt), view: null };
      waiting = current;
      if (current.prompt) {
        current.view = loginView(current);
        updateLoginView(current, current.prompt);
      }
      clearInterval(timer);
      timer = setInterval(() => poll(current), 3000);
    }

    function stopWaiting() {
      waiting = null;
      clearInterval(timer);
    }

    async function poll(current) {
      if (!current || waiting !== current) return;
      if (Date.now() - current.since > LOGIN_WAIT_MS) {
        stopWaiting();
        // A gateway that holds the login ends it too, so it does not come back as still waiting.
        if (current.prompt) await gateway.post("/login/cancel", { account: current.accountId }).catch(() => {});
        toast("로그인을 5분 동안 기다렸지만 끝나지 않았습니다. 다시 시도하세요.", "bad");
        draw();
        return;
      }
      try {
        const next = await gateway.status();
        if (waiting !== current) return;
        const account = (next.accounts || []).find((item) => item.id === current.accountId);
        if (account?.login?.loggedIn) {
          stopWaiting();
          const result = await gateway.post("/connect", {}).catch((error) => ({ ok: false, error: error.message }));
          toast(result.ok ? `${backendName(current.backend)} 계정을 연결했습니다` : `로그인은 됐지만 연결하지 못했습니다: ${result.error}`, result.ok ? "" : "bad");
          draw();
          refreshStatus();
          return;
        }
        if (current.prompt && account?.pendingLogin) updateLoginView(current, account.pendingLogin);
      } catch {}
    }

    // The login panel of a gateway that sends a prompt. Built once per login and
    // updated in place, so the status poll never wipes what is being typed. On the
    // gateway's own computer the browser finishes the login by itself; from
    // another one this is where the link is, and where Claude's code or the
    // address Codex's browser stopped at goes back.
    function loginView(current) {
      const intro = h("div", { class: "muted", style: { fontSize: "13px" } });
      const linkNote = h("div", { class: "muted", style: { fontSize: "13px", marginTop: "10px" } });
      const link = h("a", { class: "mono", target: "_blank", rel: "noopener noreferrer", style: { wordBreak: "break-all" } });
      const copy = button("", { kind: "small icon-only quiet", iconName: "copy", title: "링크 복사", onClick: async () => {
        if (!view.url) return;
        await copyText(view.url);
        toast("링크를 복사했습니다");
      } });
      const boxNote = h("div", { class: "muted", style: { fontSize: "13px", marginTop: "10px" } });
      const label = h("span", {});
      const input = h("input", { class: "input", autocomplete: "off", spellcheck: "false" });
      const send = button("보내기", { kind: "primary", type: "submit" });
      const form = h("form", { style: { display: "flex", gap: "8px", alignItems: "flex-end", marginTop: "6px" } },
        h("label", { class: "field", style: { flex: "1", minWidth: "0" } }, label, input), send);
      const status = h("div", { role: "status", style: { fontSize: "13px", marginTop: "8px" } });
      const cancel = button("취소", { kind: "small quiet" });
      const turning = spinner();
      const root = h("div", { class: "panel", style: { marginBottom: "24px", display: "flex", gap: "12px", alignItems: "flex-start" } },
        turning,
        h("div", { style: { flex: "1", minWidth: "0" } },
          h("b", {}, `${backendName(current.backend)} 로그인을 기다리는 중`),
          intro,
          linkNote,
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" } }, link, copy),
          boxNote,
          form,
          status,
        ),
        cancel,
      );
      const view = { root, turning, intro, linkNote, link, copy, boxNote, label, input, send, form, status, kind: undefined, text: null, url: null };

      const say = (text, kind = "") => {
        status.textContent = text;
        status.style.color = kind === "bad" ? "var(--bad)" : "var(--ink-3)";
      };
      view.say = say;

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submission = loginSubmission(view.kind, current.accountId, input.value);
        if (!submission || send.disabled) return;
        send.disabled = true;
        try {
          const result = await gateway.post(submission.path, submission.body);
          if (result?.ok === false) throw new Error(result.error || "보내지 못했습니다.");
          input.value = "";
          say(view.text.sent);
          // Exchanging the code takes a moment; the five minutes start again from here.
          current.since = Date.now();
        } catch (error) {
          say(error?.message || "보내지 못했습니다.", "bad");
        } finally {
          send.disabled = false;
        }
      });
      cancel.addEventListener("click", async () => {
        if (cancel.disabled) return;
        cancel.disabled = true;
        try {
          const result = await gateway.post("/login/cancel", { account: current.accountId });
          if (result?.ok === false) throw new Error(result.error || "취소하지 못했습니다.");
          if (waiting === current) stopWaiting();
          draw();
        } catch (error) {
          say(error?.message || "취소하지 못했습니다.", "bad");
        } finally {
          cancel.disabled = false;
        }
      });
      return view;
    }

    function updateLoginView(current, prompt) {
      const view = current.view;
      if (!view || !prompt) return;
      const url = signInLink(prompt.url);
      if (url && url !== view.url) {
        view.url = url;
        view.link.href = url;
        view.link.textContent = url;
      }
      if (!view.url) view.link.textContent = "로그인 링크를 기다리는 중입니다…";
      // A .btn sets its own display, which the hidden attribute does not override.
      view.copy.style.display = view.url ? "" : "none";
      // The box is chosen once: a poll that finds the CLI gone must not take it away mid-typing.
      if (view.kind === undefined) view.kind = loginPanelText(prompt.input).kind;
      view.text = loginPanelText(view.kind, view.url || prompt.url);
      view.intro.textContent = view.text.intro;
      view.linkNote.textContent = view.text.linkNote;
      view.boxNote.textContent = view.text.boxNote || "";
      view.boxNote.hidden = !view.kind;
      view.form.hidden = !view.kind;
      view.form.style.display = view.kind ? "flex" : "none";
      if (view.kind) {
        view.label.textContent = view.text.label;
        view.input.placeholder = view.text.placeholder;
      }
      const ended = loginEnded(prompt);
      view.turning.style.visibility = ended ? "hidden" : "";
      if (ended) view.say(ended, "bad");
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
      const serverModel = app.context?.localServer?.chatModel || "";
      const groups = modelGroups(models, accounts);
      return section({ title: "모델", note: "계정이 제공하는 모델입니다. 써 보기를 누르면 묻기 화면에서 그 모델에 바로 물어볼 수 있습니다." },
        groups.length
          ? groups.map((group) => h("div", { class: "gw-group" },
            h("div", { class: "gw-group-head" }, h("b", {}, group.label), h("span", {}, `모델 ${number(group.models.length)}개`)),
            h("div", { class: "gw-models" }, group.models.map((id) => h("div", { class: `gw-model ${id === serverModel ? "current" : ""}` },
              h("div", { class: "gw-model-name" }, h("code", { class: "mono", title: id }, id), id === serverModel ? tag("기억 서버가 씀", "accent") : null),
              button("써 보기", { kind: "small quiet gw-go", iconName: "arrow", title: `${id} 써 보기`, onClick: () => go(`ask/model/${encodeURIComponent(id)}`) }),
            ))),
          ))
          : empty("쓸 수 있는 모델이 없습니다", "계정을 로그인하고 연결하면 모델이 보입니다."),
        app.context?.localServer
          ? h("p", { class: "gw-foot" }, "기억 서버가 쓰는 모델은 서버 화면에서 바꿉니다. ", button("서버 화면으로", { kind: "small quiet gw-go", iconName: "arrow", onClick: () => go("server") }))
          : null,
      );
    }

    function servicesSection(services) {
      return h("details", { class: "gw-advanced", open: advancedOpen ? true : null, ontoggle: (event) => { advancedOpen = event.currentTarget.open; } },
        h("summary", {}, "고급", h("span", { class: "muted" }, " · 게이트웨이 안의 프로그램")),
        h("p", { class: "section-note" }, "계정마다 하나씩 도는 어댑터와, 요청을 나눠 주는 라우터입니다. 보통은 건드릴 일이 없습니다."),
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
    // Another screen's "log in" button lands here as #/models/add/<backend>.
    if (params[0] === "add" && ["codex", "claude"].includes(params[1])) {
      history.replaceState(null, "", "#/models");
      if (report) await addAccount(params[1]).catch((error) => toast(error.message, "bad"));
    }
    return { cleanup: () => clearInterval(timer) };
  },
};
