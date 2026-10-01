// 연결: where this computer's conversations go, and what else it is connected to.
// Collect from Claude Code and Codex, point at a memory server, join someone
// else's shared window, and bring in a ChatGPT export. Each step is the same CLI
// command a terminal would run.
import { cli, get, post } from "../lib/api.js";
import { h, clear, $ } from "../lib/dom.js";
import { ago, number } from "../lib/format.js";
import { app, go, loadContext, me, refreshStatus, workspace } from "../lib/state.js";
import { button, busy, confirmSheet, details, errorNotice, notice, pageHead, section, spinner, tag, toast } from "../lib/ui.js";

const OPERATIONS = {
  "install-runtime": () => "수집 프로그램을 이 컴퓨터에 설치합니다.",
  "merge-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에 대화가 끝날 때마다 모으는 훅을 넣습니다.`,
  "use-plugin-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}는 플러그인에 든 훅을 씁니다.`,
  "remove-legacy-managed-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에 예전 방식으로 넣었던 훅을 뺍니다.`,
  "remove-managed-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에서는 대화를 모으지 않으니 넣어 둔 수집 훅이 있으면 뺍니다.`,
  "remove-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에서 수집 훅을 뺍니다.`,
  "write-config": () => "이 컴퓨터의 수집 설정을 저장합니다.",
  "write-mcp-tool-defaults": (op) => `기억을 바꾸는 MCP 도구 ${op.disabled?.length || 0}개를 꺼 둔 채로 시작합니다.`,
};

const WARNINGS = [
  [/(\w+) collection is enabled, but the Honcho Agent Bridge plugin was not detected as enabled in (\w+)/, (m) => `${m[2] === "codex" ? "Codex" : "Claude Code"}에 팀 메모리 플러그인이 켜져 있지 않습니다. 플러그인을 켜야 대화가 모입니다.`],
  [/A Honcho server answers at (\S+), but it is not the server this plugin installed/, (m) => `${m[1]}에 기억 서버가 있지만 이 앱이 설치한 서버는 아닙니다. 내 서버가 맞는지 확인하세요.`],
  [/requires an API token/, () => "이 서버는 토큰이 필요합니다. 서버 토큰 칸을 채우세요."],
  [/is behind Cloudflare Access and refused this computer/, () => "Cloudflare Access가 이 컴퓨터를 막았습니다. 이 컴퓨터에서 Cloudflare WARP를 팀 계정으로 켜거나, 아래에 Access 서비스 토큰을 넣으세요."],
  [/Cloudflare Access (?:client id|service token).*(?:both|together)/i, () => "Access 서비스 토큰은 ID와 비밀을 함께 넣어야 합니다."],
  [/rejected the API token/, () => "서버가 이 토큰을 받지 않습니다. 서버를 둔 컴퓨터의 토큰이 맞는지 확인하세요."],
  [/at least one detected agent must be selected/, () => "대화를 모을 에이전트를 하나 이상 고르세요. 이 컴퓨터에 설치된 Claude Code나 Codex만 고를 수 있습니다."],
  [/The API token saved for (\S+) is not carried to (\S+)/, (m) => `${m[1]}에 쓰던 토큰은 ${m[2]}로 옮기지 않습니다. 새 서버의 토큰을 넣으세요.`],
  [/This computer has a Honcho server installed at (\S+), but collection goes to (\S+)\./, (m) => `이 컴퓨터에 ${m[1]} 기억 서버가 설치돼 있는데, 대화는 ${m[2]}로 보내게 돼 있습니다. 이 컴퓨터 서버로 모으려면 기억 서버 주소에 ${m[1]}을 넣으세요.`],
  [/Honcho URL is invalid/, () => "기억 서버 주소가 올바르지 않습니다."],
  [/Honcho URL must not contain credentials/, () => "기억 서버 주소에 아이디·비밀번호·물음표 뒤 값을 넣지 마세요. 토큰은 서버 토큰 칸에 넣습니다."],
];

function explainWarning(text) {
  for (const [pattern, render] of WARNINGS) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

function formBody(form) {
  const data = new FormData(form);
  const body = {};
  for (const [key, value] of data.entries()) {
    if (key === "agents") continue;
    if (String(value).trim()) body[key] = String(value).trim();
  }
  body.agents = data.getAll("agents").join(",") || "none";
  return body;
}

export default {
  title: "연결",
  async mount(page, params) {
    const body = h("div", { class: "pad" });
    page.append(
      pageHead({ title: "연결", subtitle: "이 컴퓨터의 대화를 어디로 모을지, 무엇과 이어져 있는지 정합니다." }),
      h("div", { class: "page-body" }, body),
    );

    const collect = h("div", {}, spinner());
    const share = h("div", {}, spinner());
    const importer = h("div", {});
    const targets = h("div", {}, spinner());
    clear(body,
      section({ id: "collect", title: "대화 동기화", note: "이 컴퓨터의 Claude Code·Codex 대화가 끝날 때마다 내 기억 서버로 보냅니다. 내 컴퓨터가 여러 대여도 모두 같은 서버로 모읍니다." }, collect),
      section({ id: "targets", title: "회사 서버에도 보내기", note: "정한 폴더에서 한 대화만 회사 서버 같은 다른 기억 서버에도 보냅니다. 내 서버에는 지금처럼 모든 대화가 가고, 다른 서버가 꺼져 있어도 내 서버는 멈추지 않습니다." }, targets),
      section({ id: "share", title: "다른 사람 기억에 묻기 (chat)", note: "팀원이 공유한 기억에 연결하면, 에이전트가 그 사람의 기억에 질문할 수 있습니다. 원문은 볼 수 없고 답만 받습니다. 이 컴퓨터가 대화 동기화도 하면 내 기억 도구는 그대로 두고 shared_chat 도구가 더해집니다." }, share),
      section({ id: "import", title: "ChatGPT 기록 가져오기", note: "ChatGPT 설정 → 데이터 제어 → 내보내기로 받은 파일 안의 conversations.json을 올립니다. 같은 파일을 다시 올려도 겹쳐 쌓이지 않습니다." }, importer),
    );
    if (params[0]) setTimeout(() => document.getElementById(params[0])?.scrollIntoView({ block: "start" }), 50);

    // ── Collection ────────────────────────────────────────

    async function drawCollect(banner = null) {
      clear(collect, h("div", { class: "empty" }, spinner()));
      const [status, claude, codex] = await Promise.allSettled([
        get("/api/status"),
        get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1", source: "claude" })}`),
        get(`/api/app/sessions?${new URLSearchParams({ workspace: workspace(), size: "1", source: "codex" })}`),
      ]);
      const detect = status.status === "fulfilled" ? status.value.detect : null;
      const doctor = status.status === "fulfilled" ? status.value.doctor : null;
      const context = app.context;
      const latest = { claude: claude.value?.items?.[0], codex: codex.value?.items?.[0] };

      const agentRow = (name, label) => {
        const found = detect?.agents?.[name];
        const collecting = Boolean(context?.agents?.[name]);
        const plugin = found?.plugin || {};
        const last = latest[name];
        const state = !found?.detected ? tag("설치 안 됨")
          : collecting && plugin.enabled ? tag("모으는 중", "ok")
            : collecting ? tag("플러그인 꺼짐", "warn")
              : tag("모으지 않음");
        return h("div", { class: "row" },
          h("div", {},
            h("div", { class: "title" }, h("span", { class: `src ${name}` }, name === "codex" ? "X" : "C"), label, state),
            h("div", { class: "sub" }, last ? `이 서버에 마지막으로 모인 ${label} 대화 ${ago(last.createdAt)} · ${last.title || "제목 없음"}` : `이 서버에 모인 ${label} 대화가 아직 없습니다.`),
          ),
          h("div", { class: "end" }, collecting && !plugin.enabled && found?.detected
            ? h("span", { class: "muted", style: { fontSize: "12.5px" } }, name === "codex" ? "Codex에서 플러그인을 켜고 새 세션을 여세요" : "Claude Code에서 /plugin 으로 켜세요")
            : null),
        );
      };

      const checks = (doctor?.checks || []).filter((check) => !check.ok);
      const template = $("#tpl-setup-form").content.cloneNode(true);
      const form = template.querySelector("form");
      form.elements.userPeer.value = context?.user?.peerId || me() || "";
      form.elements.workspace.value = context?.workspace || workspace();
      form.elements.honchoUrl.value = context?.configured ? context.honcho.url : "";
      if (context?.configured) {
        for (const box of form.querySelectorAll('input[name="agents"]')) box.checked = Boolean(context.agents[box.value]);
      } else if (detect) {
        for (const box of form.querySelectorAll('input[name="agents"]')) box.checked = Boolean(detect.agents?.[box.value]?.detected);
      }
      if (context?.honcho?.hasToken) form.elements.apiToken.placeholder = "저장된 토큰을 그대로 씁니다";
      if (context?.honcho?.hasAccess) {
        form.elements.accessClientId.placeholder = "저장된 값을 그대로 씁니다";
        form.elements.accessClientSecret.placeholder = "저장된 값을 그대로 씁니다";
      }
      const result = h("div", {});

      const preview = async (control) => busy(control, async () => {
        if (!form.reportValidity()) return;
        const plan = await post("/api/setup/plan", formBody(form));
        clear(result, planView(plan));
      });
      const apply = async (control) => {
        if (!form.reportValidity()) return;
        const plan = await post("/api/setup/plan", formBody(form)).catch((error) => ({ ok: false, error: error.message }));
        if (!plan.ready) { clear(result, planView(plan)); return; }
        const ok = await confirmSheet({
          title: "이대로 설정할까요?",
          text: "바꾸는 설정 파일은 미리 백업합니다.",
          detail: h("ul", { style: { margin: "0 0 8px", paddingLeft: "18px", fontSize: "13px", color: "var(--ink-2)" } }, (plan.operations || []).map((op) => h("li", {}, (OPERATIONS[op.type] || (() => op.type))(op)))),
          confirm: "설정하기",
        });
        if (!ok) return;
        const chosen = new FormData(form).getAll("agents");
        await busy(control, async () => {
          const done = await post("/api/setup/apply", formBody(form));
          if (!done.ok) { clear(result, planView(done)); throw new Error("설정하지 못했습니다."); }
          await loadContext();
          refreshStatus();
          // Redraw with the new setup, and keep what to do next above it.
          await drawCollect(notice("ok", h("b", {}, "설정했습니다. 에이전트를 다시 시작하면 모이기 시작합니다."),
            h("ul", {},
              chosen.includes("codex") ? h("li", {}, "Codex: 새 세션을 열면 훅을 승인하라고 묻습니다. “Syncing codex conversation to personal memory”를 승인하세요.") : null,
              chosen.includes("claude") ? h("li", {}, "Claude Code: 열려 있는 세션에서 /reload-plugins 를 실행하거나 새로 여세요.") : null,
              h("li", {}, "그다음부터는 대화가 끝날 때마다 자동으로 모입니다. 시작하기 화면에서 첫 기억이 들어왔는지 확인할 수 있습니다."),
            )));
        });
      };

      clear(collect,
        banner ? h("div", { style: { marginBottom: "14px" } }, banner) : null,
        h("div", { class: "rows" }, agentRow("claude", "Claude Code"), agentRow("codex", "Codex")),
        checks.length && context?.configured ? h("div", { style: { marginTop: "12px" } }, notice("warn", h("b", {}, "점검에서 걸린 것"), h("ul", {}, checks.map((check) => h("li", {}, checkText(check)))))) : null,
        h("div", { class: "panel", style: { marginTop: "16px" } },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "12px" } },
            h("b", {}, context?.configured ? "수집 설정 바꾸기" : "수집 설정하기"),
            h("span", { class: "muted", style: { fontSize: "12.5px" } }, context?.configured ? `지금 ${context.honcho.url}로 보내는 중${context.honcho.hasToken ? " · 토큰 있음" : ""}${context.honcho.hasAccess ? " · Access 서비스 토큰 있음" : ""}` : "아직 설정하지 않았습니다."),
          ),
          template,
          h("div", { class: "form-actions" },
            button("미리 보기", { onClick: (event) => preview(event.currentTarget) }),
            button(context?.configured ? "바꾸기" : "설정하기", { kind: "primary", onClick: (event) => apply(event.currentTarget) }),
          ),
          result,
        ),
      );
    }

    function checkText(check) {
      const agent = (name) => (name === "codex" ? "Codex" : "Claude Code");
      const plugin = /^(codex|claude)-plugin$/.exec(check.name);
      if (plugin) return check.installed
        ? `${agent(plugin[1])}에 팀 메모리 플러그인이 설치돼 있지만 꺼져 있습니다. 켜야 대화가 모입니다.`
        : `${agent(plugin[1])}에 팀 메모리 플러그인이 없습니다. 플러그인을 설치하고 켜세요.`;
      if (check.name === "claude-hook") return "Claude Code는 플러그인에 든 훅으로 모읍니다. 플러그인을 켜면 함께 켜집니다.";
      const hook = /^(codex|claude)-hook$/.exec(check.name);
      if (hook) return `${agent(hook[1])}에 대화 수집 훅이 없거나 예전 것입니다. 설정을 다시 적용하세요.`;
      if (check.name === "configuration") return "수집 설정이 없습니다.";
      if (check.name === "runtime") return `수집 프로그램이 ${check.actualVersion ? `예전 판(${check.actualVersion})` : "설치돼 있지 않습니다"}. 설정을 다시 적용하면 새로 설치합니다.`;
      if (check.name === "honcho-health" && check.code === "cloudflare-access") return "Cloudflare Access가 이 컴퓨터를 막았습니다. WARP를 팀 계정으로 켜거나 Access 서비스 토큰을 넣으세요.";
      if (check.name === "honcho-health" && check.status === 401) return "기억 서버가 토큰을 받지 않습니다. 서버를 둔 컴퓨터에서 서버 토큰을 다시 복사해 넣으세요.";
      if (check.name === "honcho-health") return "기억 서버가 답하지 않습니다.";
      if (check.name === "honcho-workspaces") return "기억 서버에 닿았지만 작업공간을 읽지 못했습니다. 토큰이 맞는지 확인하세요.";
      if (check.name === "mcp") return "에이전트용 기억 도구(MCP)가 시작되지 않습니다.";
      if (check.name === "shared-bridge") return "팀원 기억이 답하지 않습니다.";
      return `${check.name}: ${check.error || check.state || "문제 있음"}`;
    }

    function planView(plan) {
      const issues = plan.issues || (plan.error ? [plan.error] : []);
      return h("div", { style: { marginTop: "14px", display: "flex", flexDirection: "column", gap: "10px" } },
        issues.length ? notice("bad", h("b", {}, "이대로는 설정할 수 없습니다."), h("ul", {}, issues.map((issue) => h("li", {}, explainWarning(issue))))) : null,
        (plan.warnings || []).length ? notice("warn", h("b", {}, "확인할 것"), h("ul", {}, plan.warnings.map((warning) => h("li", {}, explainWarning(warning))))) : null,
        plan.operations?.length ? notice("", h("b", {}, "하게 될 일"), h("ul", {}, plan.operations.map((op) => h("li", {}, (OPERATIONS[op.type] || (() => op.type))(op))))) : null,
        details("자세한 결과", plan),
      );
    }

    // ── Shared bridge ─────────────────────────────────────

    async function drawShare() {
      let status;
      try { status = await post("/api/bridge/status", {}); } catch (error) { clear(share, errorNotice(error)); return; }
      const result = h("div", {});
      if (status.connected) {
        clear(share,
          h("div", { class: "rows" }, h("div", { class: "row" },
            h("div", {}, h("div", { class: "title" }, tag("연결됨", "ok"), h("code", { class: "mono" }, status.url || "")),
              h("div", { class: "sub" }, "이 컴퓨터의 에이전트는 이 연결의 chat 도구로 묻습니다.")),
            h("div", { class: "end" },
              button("시험", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
                const tested = await post("/api/bridge/test", {});
                clear(result, tested.ok
                  ? notice("ok", h("b", {}, "연결이 답했습니다."), tested.tools ? ` 쓸 수 있는 도구: ${tested.tools.join(", ")}` : "")
                  : notice("bad", h("b", {}, "연결이 답하지 않았습니다."), tested.error ? ` ${tested.error}` : ""));
              }) }),
              button("끊기", { kind: "small danger", onClick: async (event) => {
                const ok = await confirmSheet({ title: "팀원 기억 연결을 끊을까요?", text: "저장한 토큰을 이 컴퓨터에서 지웁니다. 다시 붙으려면 토큰을 다시 받아야 합니다.", confirm: "끊기", danger: true });
                if (!ok) return;
                await busy(event.currentTarget, async () => { await cli("/api/bridge/disconnect", {}); await loadContext(); drawShare(); refreshStatus(); }, { done: "연결을 끊었습니다" });
              } }),
            ),
          )),
          result,
        );
        return;
      }
      const template = $("#tpl-bridge-form").content.cloneNode(true);
      const form = template.querySelector("form");
      clear(share,
        h("div", { class: "panel" },
          h("p", { class: "muted", style: { margin: "0 0 12px", fontSize: "13px" } }, "팀원에게 받은 주소와 토큰을 넣습니다. 채팅에 붙여넣지 말고 여기에만 넣으세요. 이 컴퓨터에 Cloudflare WARP가 팀으로 연결돼 있어야 합니다."),
          template,
          h("div", { class: "form-actions" }, button("연결", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            if (!form.reportValidity()) return;
            const data = Object.fromEntries(new FormData(form).entries());
            const connected = await post("/api/bridge/connect", data);
            if (!connected.ok) {
              clear(result, notice("bad", h("b", {}, "연결하지 못했습니다."), h("ul", {}, (connected.issues || [connected.error || "연결이 답하지 않았습니다."]).map((issue) => h("li", {}, issue)))));
              return;
            }
            toast("팀원 기억에 연결했습니다");
            await loadContext();
            drawShare();
            refreshStatus();
          }) })),
          result,
        ),
      );
    }

    // ── ChatGPT import ────────────────────────────────────

    function drawImport() {
      const file = h("input", { type: "file", accept: ".json,application/json", class: "input", style: { paddingTop: "4px" } });
      const result = h("div", {});
      const upload = button("올리기", { kind: "primary", iconName: "upload", disabled: true });
      file.addEventListener("change", () => {
        upload.disabled = !file.files?.length;
        clear(result, file.files?.[0] ? h("p", { class: "muted", style: { fontSize: "13px" } }, `${file.files[0].name} · ${(file.files[0].size / 1024 / 1024).toFixed(1)}MB`) : null);
      });
      upload.addEventListener("click", () => busy(upload, async () => {
        const chosen = file.files?.[0];
        if (!chosen) return;
        clear(result, h("div", { class: "muted", style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" } }, spinner(), "올리고 읽는 중… 대화가 많으면 몇 분 걸립니다."));
        const response = await fetch("/api/import/chatgpt", { method: "POST", headers: { "content-type": "application/json" }, body: chosen });
        const payload = await response.json().catch(() => ({ ok: false, error: "결과를 읽지 못했습니다." }));
        if (!payload.ok) {
          clear(result, notice("bad", h("b", {}, "가져오지 못했습니다."), ` ${payload.error || ""}`), details("자세한 결과", payload));
          return;
        }
        clear(result, notice("ok", h("b", {}, "가져왔습니다."),
          ` 대화 ${number(payload.conversations ?? 0)}개를 읽어 ${number(payload.imported_sessions ?? 0)}개를 넣었고, 새 메시지는 ${number(payload.new_messages ?? 0)}개입니다.`,
          payload.new_messages === 0 ? " 이미 들어 있는 기록이었습니다." : ""), details("자세한 결과", payload));
        file.value = "";
        upload.disabled = true;
      }));
      clear(importer, h("div", { class: "panel" }, h("div", { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: "10px", alignItems: "center" } }, file, upload), result));
    }

    // ── Other servers ─────────────────────────────────────

    async function drawTargets(banner = null) {
      let list;
      try {
        list = await cli("/api/targets", {});
      } catch (error) {
        clear(targets, errorNotice(error));
        return;
      }
      const items = list.targets || [];
      if (!app.context?.configured) {
        clear(targets, notice("", "먼저 위에서 대화 수집을 설정하세요. 그다음에 다른 서버를 더할 수 있습니다."));
        return;
      }
      clear(targets,
        banner,
        items.length ? h("div", { class: "rows" }, items.map(targetRow)) : null,
        addTargetForm(items.length === 0),
      );
    }

    function targetRow(target) {
      const status = h("div", {});
      const sent = target.lastSentAt ? `마지막으로 보낸 때 ${new Date(target.lastSentAt).toLocaleString("ko-KR")}` : "아직 보낸 대화 없음";
      return h("div", { class: "row", style: { alignItems: "flex-start" } },
        h("div", { style: { minWidth: "0" } },
          h("div", { class: "title" }, target.enabled ? tag("보내는 중", "ok") : tag("멈춤"), target.label || target.id, target.pending ? tag(`기다리는 대화 ${target.pending}`, "warn") : null),
          h("div", { class: "sub mono" }, target.url || ""),
          h("div", { class: "sub" }, `폴더: ${(target.folders || []).join(", ")}`),
          h("div", { class: "sub" }, [`작업공간 ${target.workspace}`, `이름 ${target.userPeerId}`, target.hasToken ? "토큰 있음" : null, target.hasAccess ? "Access 서비스 토큰 있음" : null, sent].filter(Boolean).join(" · ")),
          status,
        ),
        h("div", { class: "end", style: { flexWrap: "wrap", justifyContent: "flex-end" } },
          button("시험", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            const result = await post("/api/targets/test", { id: target.id });
            clear(status, result.ok
              ? notice("ok", "서버가 답하고 작업공간을 읽을 수 있습니다.")
              : notice("bad", explainWarning(result.health?.error || result.workspace?.error || result.error || "서버가 답하지 않습니다.")));
          }) }),
          button("폴더 바꾸기", { kind: "small quiet", onClick: async () => {
            const next = window.prompt("보낼 폴더를 쉼표로 나눠 적으세요.", (target.folders || []).join(", "));
            if (next === null) return;
            try { await cli("/api/targets/set", { id: target.id, folders: next.split(",").map((item) => item.trim()).filter(Boolean) }); toast("폴더를 바꿨습니다"); drawTargets(); } catch (error) { toast(error.message, "bad"); }
          } }),
          button(target.enabled ? "멈추기" : "다시 보내기", { kind: "small quiet", onClick: (event) => busy(event.currentTarget, async () => { await cli("/api/targets/set", { id: target.id, enabled: !target.enabled }); await drawTargets(); }) }),
          button("지난 대화 보내기", { kind: "small quiet", onClick: async (event) => {
            const since = window.prompt("언제부터의 대화를 보낼까요? (예: 2026-09-01) 비워 두면 그 폴더의 모든 지난 대화를 보냅니다.", "");
            if (since === null) return;
            if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since.trim())) { toast("날짜는 2026-09-01처럼 적습니다.", "bad"); return; }
            const ok = await confirmSheet({ title: `${target.label || target.id}에 지난 대화를 보낼까요?`, text: `${(target.folders || []).join(", ")} 폴더에서 한 대화${since ? `(${since.trim()} 이후)` : ""}를 보냅니다. 이미 보낸 것은 다시 보내지 않습니다. 한 번에 500개까지 보내고, 남으면 다시 누르면 이어서 보냅니다.`, confirm: "보내기" });
            if (!ok) return;
            await busy(event.currentTarget, async () => {
              const body = { id: target.id };
              if (since.trim()) body.since = since.trim();
              const result = await post("/api/targets/backfill", body);
              const counts = [`대화 ${number(result.sent_sessions || 0)}개`, `새 메시지 ${number(result.new_messages || 0)}개`, result.remaining ? `남은 것 ${number(result.remaining)}개 (다시 누르면 이어서)` : null, result.failed ? `실패 ${number(result.failed)}개` : null].filter(Boolean).join(" · ");
              clear(status, notice(result.ok ? "ok" : "warn", h("b", {}, result.ok ? "보냈습니다." : "일부만 보냈습니다."), ` ${counts}`, result.stopped ? h("div", {}, "서버가 계속 답하지 않아 멈췄습니다. 서버가 돌아오면 다시 누르세요.") : null));
              await loadContext();
            });
          } }),
          button("", { kind: "small icon-only quiet danger", iconName: "trash", title: "빼기", onClick: async (event) => {
            const ok = await confirmSheet({ title: `${target.label || target.id}를 뺄까요?`, text: "이제부터 이 서버로 보내지 않습니다. 이미 보낸 대화는 그 서버에 그대로 남습니다. 아직 못 보낸 대화는 버립니다.", confirm: "빼기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => { await cli("/api/targets/remove", { id: target.id }); await drawTargets(); }, { done: "뺐습니다" });
          } }),
        ),
      );
    }

    function addTargetForm(open) {
      const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
      const wide = (label, input, hint) => h("label", { class: "field wide" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
      const inputs = {
        label: h("input", { class: "input", placeholder: "예: 회사" }),
        url: h("input", { class: "input", type: "url", placeholder: "https://memory.company.com" }),
        folders: h("textarea", { class: "input", rows: "2", placeholder: "/Users/me/work, /Users/me/dev/company-app" }),
        apiToken: h("input", { class: "input", type: "password", autocomplete: "off" }),
        workspace: h("input", { class: "input", placeholder: app.context?.workspace || "memory" }),
        userPeer: h("input", { class: "input", placeholder: app.context?.user?.peerId || "" }),
        accessClientId: h("input", { class: "input", type: "password", autocomplete: "off" }),
        accessClientSecret: h("input", { class: "input", type: "password", autocomplete: "off" }),
      };
      const outcome = h("div", {});
      const form = h("div", { class: "panel" },
        h("div", { class: "form-grid" },
          field("이름", inputs.label, "화면에 보일 이름입니다."),
          field("서버 주소", inputs.url),
          wide("보낼 폴더", inputs.folders, "이 폴더 안에서 연 에이전트 대화만 보냅니다. 쉼표나 줄바꿈으로 여러 개를 적습니다."),
          wide("서버 토큰", inputs.apiToken, "그 서버 관리자에게 받습니다."),
          field("그 서버의 작업공간", inputs.workspace, "비우면 내 서버와 같게 둡니다."),
          field("그 서버에서 쓸 내 이름", inputs.userPeer, "비우면 내 서버와 같게 둡니다."),
          h("details", { class: "field wide access-fields" },
            h("summary", {}, "Cloudflare WARP를 켤 수 없는 컴퓨터라면"),
            h("div", { class: "form-grid" }, field("Access 서비스 토큰 ID", inputs.accessClientId), field("Access 서비스 토큰 비밀", inputs.accessClientSecret)),
          ),
        ),
        h("div", { class: "form-actions" },
          button("더하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            const label = inputs.label.value.trim() || "회사";
            const body = {
              id: slug(label),
              label,
              url: inputs.url.value.trim(),
              folders: inputs.folders.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
            };
            for (const key of ["workspace", "userPeer", "apiToken", "accessClientId", "accessClientSecret"]) if (inputs[key].value.trim()) body[key] = inputs[key].value.trim();
            const result = await post("/api/targets/add", body);
            if (!result.ok) {
              clear(outcome, notice("bad", h("b", {}, "더하지 못했습니다."), h("ul", {}, (result.issues || [result.error]).filter(Boolean).map((issue) => h("li", {}, explainWarning(issue))))));
              return;
            }
            await drawTargets(notice("ok", h("b", {}, `${label}에도 보냅니다.`), " 지금부터 끝나는 대화가 갑니다. 지난 대화도 보내려면 지난 대화 보내기를 누르세요.",
              result.warnings?.length ? h("ul", {}, result.warnings.map((warning) => h("li", {}, explainWarning(warning)))) : null));
          }) }),
        ),
        outcome,
      );
      return open ? form : h("details", { class: "raw", style: { marginTop: "12px" } }, h("summary", {}, "다른 서버 더하기"), h("div", { style: { marginTop: "10px" } }, form));
    }

    function slug(text) {
      if (/회사/.test(text)) return "company";
      const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return ascii || `server-${Date.now().toString(36).slice(-4)}`;
    }

    drawImport();
    await Promise.all([drawCollect(), drawShare(), drawTargets()]);
    return {
      update: (next) => { if (next[0]) document.getElementById(next[0])?.scrollIntoView({ block: "start" }); },
    };
  },
};
