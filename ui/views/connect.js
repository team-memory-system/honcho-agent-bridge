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
  "remove-hook": (op) => `${op.agent === "codex" ? "Codex" : "Claude Code"}에서 수집 훅을 뺍니다.`,
  "write-config": () => "이 컴퓨터의 수집 설정을 저장합니다.",
  "write-mcp-tool-defaults": (op) => `기억을 바꾸는 MCP 도구 ${op.disabled?.length || 0}개를 꺼 둔 채로 시작합니다.`,
};

const WARNINGS = [
  [/(\w+) collection is enabled, but the Honcho Agent Bridge plugin was not detected as enabled in (\w+)/, (m) => `${m[2] === "codex" ? "Codex" : "Claude Code"}에 팀 메모리 플러그인이 켜져 있지 않습니다. 플러그인을 켜야 대화가 모입니다.`],
  [/A Honcho server answers at (\S+), but it is not the server this plugin installed/, (m) => `${m[1]}에 기억 서버가 있지만 이 앱이 설치한 서버는 아닙니다. 내 서버가 맞는지 확인하세요.`],
  [/requires an API token/, () => "이 서버는 토큰이 필요합니다. 서버 토큰 칸을 채우세요."],
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
    clear(body,
      section({ id: "collect", title: "에이전트 대화 수집", note: "에이전트와 나눈 대화가 끝날 때마다 내 기억 서버로 보냅니다. 내 컴퓨터가 여러 대여도 모두 같은 서버로 모읍니다." }, collect),
      section({ id: "share", title: "다른 사람의 기억에 묻기", note: "팀원이 열어 준 공유 창구에 연결하면, 에이전트가 그 사람의 기억에 질문할 수 있습니다. 원문은 볼 수 없고 답만 받습니다." }, share),
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
            h("span", { class: "muted", style: { fontSize: "12.5px" } }, context?.configured ? `지금 ${context.honcho.url}로 보내는 중${context.honcho.hasToken ? " · 토큰 있음" : ""}` : "아직 설정하지 않았습니다."),
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
      if (check.name === "honcho-health") return "기억 서버가 답하지 않습니다.";
      if (check.name === "honcho-workspaces") return "기억 서버에 닿았지만 작업공간을 읽지 못했습니다. 토큰이 맞는지 확인하세요.";
      if (check.name === "mcp") return "에이전트용 기억 도구(MCP)가 시작되지 않습니다.";
      if (check.name === "shared-bridge") return "공유 창구가 답하지 않습니다.";
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
              h("div", { class: "sub" }, "이 컴퓨터의 에이전트는 기억 도구 대신 이 창구의 chat 도구를 씁니다.")),
            h("div", { class: "end" },
              button("시험", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
                const tested = await post("/api/bridge/test", {});
                clear(result, tested.ok
                  ? notice("ok", h("b", {}, "창구가 답했습니다."), tested.tools ? ` 쓸 수 있는 도구: ${tested.tools.join(", ")}` : "")
                  : notice("bad", h("b", {}, "창구가 답하지 않았습니다."), tested.error ? ` ${tested.error}` : ""));
              }) }),
              button("끊기", { kind: "small danger", onClick: async (event) => {
                const ok = await confirmSheet({ title: "공유 창구 연결을 끊을까요?", text: "저장한 창구 토큰을 이 컴퓨터에서 지웁니다. 다시 붙으려면 토큰을 다시 받아야 합니다.", confirm: "끊기", danger: true });
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
          h("p", { class: "muted", style: { margin: "0 0 12px", fontSize: "13px" } }, "기억 주인에게 받은 네 값을 넣습니다. 채팅에 붙여넣지 말고 여기에만 넣으세요."),
          template,
          h("div", { class: "form-actions" }, button("연결", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
            if (!form.reportValidity()) return;
            const data = Object.fromEntries(new FormData(form).entries());
            const connected = await post("/api/bridge/connect", data);
            if (!connected.ok) {
              clear(result, notice("bad", h("b", {}, "연결하지 못했습니다."), h("ul", {}, (connected.issues || [connected.error || "창구가 답하지 않았습니다."]).map((issue) => h("li", {}, issue)))));
              return;
            }
            toast("공유 창구에 연결했습니다");
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

    drawImport();
    await Promise.all([drawCollect(), drawShare()]);
    return {
      update: (next) => { if (next[0]) document.getElementById(next[0])?.scrollIntoView({ block: "start" }); },
    };
  },
};
