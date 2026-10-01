// 시작하기: the first run, as a checklist that reads the real state. First pick
// how this computer takes part, then each step says whether it is done and opens
// the screen that does it.
import { get, post } from "../lib/api.js";
import { h, clear, copyText } from "../lib/dom.js";
import { ago } from "../lib/format.js";
import { app, go, loadContext, refreshStatus, savePrefs, workspace } from "../lib/state.js";
import { button, busy, pageHead, spinner, tag, toast } from "../lib/ui.js";

// Three features, not three exclusive paths: a computer turns on what it needs.
const FEATURES = [
  {
    key: "server",
    title: "서버 설치",
    text: "이 컴퓨터에 기억 서버를 설치합니다. 다른 컴퓨터의 대화도 이 서버로 받을 수 있습니다. Docker와 Ollama는 없으면 앱이 설치하고, Codex나 Claude 구독이 필요합니다.",
  },
  {
    key: "sync",
    title: "대화 동기화",
    text: "이 컴퓨터에서 Claude Code·Codex와 나눈 대화를 기억 서버로 보냅니다. 서버가 이 컴퓨터에 있으면 그리로, 다른 컴퓨터에 있으면 그 주소와 서버 토큰으로 보냅니다.",
  },
  {
    key: "chat",
    title: "다른 사람 기억에 묻기 (chat)",
    text: "에이전트가 팀원이 공유한 기억에 질문하게 합니다. 원문은 보지 않고 답만 받습니다. 팀원에게 받은 연결 정보가 필요합니다.",
  },
];

function chosenFeatures() {
  const picked = Array.isArray(app.prefs.startFeatures) ? app.prefs.startFeatures : [];
  return FEATURES.map((feature) => feature.key).filter((key) => picked.includes(key));
}

const NEEDED = { required: ["꼭 필요", ""], "app-installs": ["없으면 앱이 설치", "accent"], optional: ["있으면 좋음", ""] };

// WARP is the one program this screen installs. The app downloads it and the user
// only answers the system's password or approval prompt.
const INSTALLABLE = new Set(["warp"]);

function prereqList(items, { onInstall } = {}) {
  if (!items.length) return null;
  return h("div", { class: "rows prereqs" }, items.map((item) => {
    const installable = !item.ok && item.install?.auto === true && INSTALLABLE.has(item.key) && onInstall;
    const [label, kind] = NEEDED[item.needed] || NEEDED.optional;
    return h("div", { class: "row" },
      h("div", { style: { minWidth: "0" } },
        h("div", { class: "title" }, item.ok ? tag("있음", "ok") : item.needed === "required" ? tag("없음", "bad") : tag("없음"), item.label, item.version ? h("span", { class: "muted mono", style: { fontSize: "12px" } }, item.version) : null, tag(label, kind)),
        item.detail ? h("div", { class: "sub" }, item.detail) : null,
        !item.ok && item.install?.note ? h("div", { class: "sub" }, item.install.note) : null,
      ),
      h("div", { class: "end", style: { flexWrap: "wrap", justifyContent: "flex-end" } },
        installable ? button("설치", { kind: "small primary", onClick: (event) => onInstall(item, event.currentTarget) }) : null,
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
      pageHead({ title: "시작하기", subtitle: "이 컴퓨터가 팀 메모리에 어떻게 참여할지 고르고, 차례대로 준비합니다." }),
      h("div", { class: "page-body" }, body),
    );

    function drawChoice() {
      const picked = new Set(chosenFeatures());
      const go_ = button("이대로 준비하기", { kind: "primary", onClick: () => { savePrefs({ startFeatures: [...picked] }); drawSteps(); } });
      const sync = () => { go_.disabled = picked.size === 0; };
      clear(body,
        h("p", { class: "section-note", style: { margin: "0 0 16px" } }, "이 컴퓨터에서 쓸 기능을 고르세요. 여러 개를 같이 켤 수 있고, 나중에 더 켤 수도 있습니다."),
        h("div", { class: "choices" }, FEATURES.map((feature) => {
          const card = h("button", {
            class: `choice ${picked.has(feature.key) ? "picked" : ""}`,
            type: "button",
            "aria-pressed": picked.has(feature.key) ? "true" : "false",
            onclick: () => {
              if (picked.has(feature.key)) picked.delete(feature.key); else picked.add(feature.key);
              card.classList.toggle("picked", picked.has(feature.key));
              card.setAttribute("aria-pressed", picked.has(feature.key) ? "true" : "false");
              sync();
            },
          }, h("b", {}, feature.title), h("span", {}, feature.text));
          return card;
        })),
        h("div", { class: "form-actions" }, go_),
      );
      sync();
    }

    // What the install left for the user to do, kept on screen until it is done:
    // the wizard and a cancelled install until the program is found, the team
    // join until the check passes.
    let installNotice = null;

    async function installPrereq(item, target) {
      await busy(target, async () => {
        const result = await post("/api/app/prereqs/install", { item: item.key });
        if (result?.cancelled) {
          installNotice = { key: item.key, item, text: result.error, tone: "warn", until: "found", retry: true };
        } else if (!result || result.ok === false) {
          throw new Error(result?.error || "설치하지 못했습니다.");
        } else if (result.nextAction?.message) {
          const joined = result.nextAction.kind === "warp-team-join";
          installNotice = { key: item.key, item, text: result.nextAction.message, tone: joined ? "ok" : "", until: joined ? "ok" : "found" };
        } else {
          installNotice = null;
          if (result.detail) toast(result.detail);
        }
        // Installed or not, the list shows where things stand now.
        await drawSteps();
      });
    }

    function noticeFor(items, ok) {
      if (!installNotice) return null;
      const current = items.find((entry) => entry.key === installNotice.key);
      const settled = ok || !current || current.ok || (installNotice.until === "found" && current.version);
      if (settled) { installNotice = null; return null; }
      const notice = installNotice;
      return h("div", { class: `notice ${notice.tone}`, style: { margin: "8px 0", alignItems: "center" } },
        h("div", { style: { flex: "1" } }, notice.text),
        notice.retry ? button("다시 설치", { kind: "small primary", onClick: (event) => installPrereq(notice.item, event.currentTarget) }) : null,
      );
    }

    async function drawSteps() {
      const features = chosenFeatures();
      if (!features.length) { drawChoice(); return; }
      const list = h("div", { class: "steps" }, h("div", { class: "empty" }, spinner()));
      clear(body,
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px", flexWrap: "wrap" } },
          features.map((key) => tag(FEATURES.find((feature) => feature.key === key).title, "accent")),
          button("기능 바꾸기", { kind: "small quiet", onClick: drawChoice }),
        ),
        list,
      );
      await loadContext().catch(() => {});
      await refreshStatus();
      const context = app.context;
      const steps = [];
      const serverHere = features.includes("server");

      // Required software first: what the chosen features need, with how to get it.
      const remote = features.includes("sync") && !serverHere;
      const prereqs = await get(`/api/app/prereqs?${new URLSearchParams({ features: features.join(","), ...(remote ? { remote: "1" } : {}) })}`).catch((error) => ({ ok: false, error: error.message, items: [] }));
      const missing = (prereqs.items || []).filter((item) => item.needed === "required" && !item.ok);
      steps.push({
        title: "필요한 프로그램",
        done: Boolean(prereqs.ok),
        text: prereqs.error
          ? `확인하지 못했습니다: ${prereqs.error}`
          : prereqs.ok ? "고른 기능에 필요한 프로그램이 모두 있습니다." : `${missing.map((item) => item.label).join(", ")}부터 설치하세요. 설치한 뒤 다시 확인을 누릅니다.`,
        body: h("div", {},
          noticeFor(prereqs.items || [], Boolean(prereqs.ok)),
          prereqList(prereqs.items || [], { onInstall: installPrereq }),
        ),
        action: prereqs.ok ? null : ["다시 확인", "recheck"],
      });

      if (serverHere) {
        const server = await post("/api/server/status", { profile: "personal" }).catch(() => null);
        const gatewayReady = app.status.gateway.state === "on";
        steps.push(
          { title: "기억 서버 준비", done: Boolean(server?.installed), text: server?.installed ? "이 컴퓨터에 설치돼 있습니다." : server && !server.docker?.installed ? "Docker Desktop과 Ollama부터 이 앱이 받아서 설치합니다." : "서버 소스와 게이트웨이를 설치합니다.", action: ["서버 화면에서 준비", () => go("server")] },
          { title: "구독 계정 로그인", done: gatewayReady, text: gatewayReady ? app.status.gateway.text : "기억 서버가 생각할 모델을 쓰려면 Codex나 Claude 계정이 필요합니다.", action: ["게이트웨이에서 로그인", () => go("models/add/codex")] },
          { title: "기억 서버 시작", done: Boolean(server?.running && server?.health?.ok), text: server?.running ? "답하는 중입니다." : "로그인 뒤 서버 화면에서 준비를 한 번 더 누르고 시작합니다.", action: ["서버 화면으로", () => go("server")] },
          { title: "다른 컴퓨터에서 쓰게 열기 (선택)", done: Boolean(server?.share?.enabled), text: server?.share?.enabled ? `${server.share.publicUrl}로 열려 있습니다.` : "다른 컴퓨터의 대화도 이 서버로 받으려면 Cloudflare 통로를 엽니다.", action: ["서버 화면에서 열기", () => go("server")], optional: true },
        );
      }
      if (features.includes("sync")) {
        steps.push({
          title: "대화 동기화 설정",
          done: Boolean(context?.configured),
          text: context?.configured ? `${[context.agents.claude && "Claude Code", context.agents.codex && "Codex"].filter(Boolean).join("·") || "에이전트 없음"} → ${context.honcho.url}` : serverHere ? "내 이름과 모을 에이전트를 고릅니다. 서버 주소는 비워 두면 이 컴퓨터 서버로 보냅니다." : "서버를 둔 컴퓨터의 서버 → 다른 컴퓨터에서 쓰기에서 주소와 서버 토큰을 받아 넣고, 모을 에이전트를 고릅니다. 이 컴퓨터에서 Cloudflare WARP를 팀 계정으로 켜 두세요.",
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
      }
      if (features.includes("chat")) {
        const connected = Boolean(context?.sharedBridge?.connected);
        steps.push(
          { title: "팀원 기억에 연결", done: connected, text: connected ? context.sharedBridge.url : "팀원에게 받은 주소와 토큰을 넣습니다.", action: ["연결 화면에서 넣기", () => go("connect/share")] },
          { title: "에이전트 다시 시작", done: false, optional: true, text: features.includes("sync") ? "Claude Code는 /reload-plugins, Codex는 새 세션을 엽니다. 에이전트는 내 기억 도구를 그대로 쓰고, 팀원 기억에는 shared_chat 도구로 묻습니다." : "Claude Code는 /reload-plugins, Codex는 새 세션을 엽니다. 그러면 에이전트가 chat 도구로 팀원 기억에 물어볼 수 있습니다.", action: null },
        );
      }

      const firstOpen = steps.findIndex((step) => !step.done && !step.optional);
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
        list.after(h("div", { class: "notice ok", style: { marginTop: "16px" } }, h("div", {}, h("b", {}, "준비가 끝났습니다. "), "이제 대화가 끝날 때마다 기억이 쌓입니다.")));
      }
    }

    drawChoice();
  },
};
