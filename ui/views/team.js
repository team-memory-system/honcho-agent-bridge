// 팀: teammates' memories this computer's agents ask, and who may ask mine. A
// teammate's memory is a remote MCP server (team-<name>) in Claude Code and Codex;
// its row's switch puts it in or takes it out (lib/team.js), and each agent logs in
// to it by itself, which the 연결 window says how. Teammates get `chat` alone, fixed
// in the server's settings, so there are no tool switches here. Who asked my memory
// is 조회 기록 (audit.js).
import { cli, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { confirmWindow, field, list, listItem, modal } from "../lib/kit.js";
import { clientOutcome, connectTeammate, parseTeamAddresses } from "../lib/team.js";
import { app, go, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, errorNotice, notice, pageHead, spinner, tag, toggle } from "../lib/ui.js";

const CLIENTS = { claude: "Claude Code", codex: "Codex" };

/** After a teammate's memory went in: each agent logs in to it once, and how. */
function openConnected(mate) {
  const entry = mate.entry || `team-${mate.name}`;
  const win = modal({ title: `${mate.name}의 기억 연결`, big: true, small: true });
  const codexState = tag("로그인 필요", "warn");
  const codexNote = h("div", { class: "s" }, "Codex 로그인을 누르고, 브라우저가 열리면 팀 Google 계정으로 로그인하세요.");
  const codexLogin = button("Codex 로그인", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
    const login = await post("/api/teammates/codex-login", { name: mate.name });
    if (!login.ok) throw new Error(login.error || "Codex 로그인을 시작하지 못했습니다.");
    if (login.state === "done") {
      clear(codexState, "로그인됨");
      codexState.className = "tag ok";
      return;
    }
    clear(codexNote, "브라우저에서 로그인을 마치세요. 창이 열리지 않았으면 ",
      login.loginUrl ? h("a", { href: login.loginUrl, target: "_blank", rel: "noreferrer" }, "로그인 주소") : "로그인 주소",
      "를 여세요. 10분 안에 마치지 않으면 다시 누릅니다.");
  }) });
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } },
      `${mate.name}의 기억을 이 컴퓨터의 Claude Code와 Codex에 도구로 넣었습니다. ${mate.name}의 서버는 팀 Google 계정으로만 열려서, 에이전트마다 한 번 로그인하면 끝납니다.`),
    h("div", { class: "opts" },
      h("div", { class: "agent" }, h("span", { class: "src claude" }, "C"),
        h("div", { class: "ab" }, h("div", { class: "t" }, "Claude Code ", tag("로그인 필요", "warn")),
          h("div", { class: "s" }, "열린 세션에서 ", h("span", { class: "mono" }, "/mcp"), " 를 열고 ", h("span", { class: "mono" }, entry), " 을 골라 Authenticate를 누르고, 브라우저가 열리면 팀 Google 계정으로 로그인하세요."))),
      h("div", { class: "agent" }, h("span", { class: "src codex" }, "X"),
        h("div", { class: "ab" }, h("div", { class: "t" }, "Codex ", codexState), codexNote),
        codexLogin)));
  win.foot(null, button("닫기", { onClick: () => win.close() }));
  win.open();
}

/** 팀 주소로 더하기: the addresses the admin sent, each put into the agents. */
function openAdd(onDone) {
  const win = modal({ title: "팀원 기억 더하기", big: true, small: true });
  const box = h("textarea", { class: "input mono", rows: "4", spellcheck: "false", placeholder: "alice https://memory-alice.example.com/mcp" });
  const problem = h("div", {});
  win.body(field("팀 주소", box, "관리자가 관리자 탭에서 복사해 보낸 팀 주소를 붙여 넣습니다. 주소 하나만 넣어도 됩니다."), problem);
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("연결", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      const { found, bad } = parseTeamAddresses(box.value);
      if (!found.length) { clear(problem, notice("warn", "알아볼 수 있는 주소가 없습니다. https://로 시작하는 주소나 memory-이름.도메인 꼴로 넣으세요.")); return; }
      const failed = [];
      const done = [];
      for (const mate of found) {
        const result = await connectTeammate(mate).catch((error) => ({ ok: false, error: error.message }));
        if (result.ok) done.push({ ...mate, entry: result.entry });
        else failed.push(`${mate.name}: ${result.error || clientOutcome(result).join(" · ")}`);
      }
      if (failed.length || bad.length) {
        clear(problem, notice("bad", h("ul", {}, [...failed, ...bad.map((line) => `알아보지 못한 줄: ${line}`)].map((line) => h("li", {}, line)))));
        if (!done.length) return;
      }
      win.close("ok");
      await loadContext();
      refreshStatus();
      onDone();
      if (done.length) openConnected(done[0]);
    }) }),
  ]);
  win.open();
}

export default {
  title: "팀",
  async mount(page) {
    const body = h("div", { class: "pad stack" });
    page.append(
      pageHead({ title: "팀", subtitle: "팀원의 기억에 chat으로 묻고, 내 기억을 누구에게 열었는지 봅니다." }),
      h("div", { class: "page-body" }, body),
    );

    async function draw() {
      let status;
      try {
        status = await cli("/api/teammates/connected", {});
      } catch (error) {
        clear(body, errorNotice(error));
        return;
      }
      const clients = status.clients || {};
      const missing = Object.entries(CLIENTS).filter(([key]) => clients[key]?.found === false).map(([, label]) => label);
      const rows = (status.servers || []).map((server) => {
        const registered = Object.keys(CLIENTS).filter((key) => server[key]?.registered);
        const moved = registered.some((key) => server[key].same === false);
        const on = registered.length > 0;
        return listItem({
          title: server.name,
          tags: moved ? [" ", tag("주소가 바뀜", "warn")] : [],
          sub: on ? `${registered.map((key) => CLIENTS[key]).join("·")} · ${server.host || server.url || ""}` : server.host || server.url || "",
          end: [
            on && server.codex?.registered ? button("로그인 안내", { kind: "small quiet", onClick: () => openConnected(server) }) : null,
            toggle(on && !moved, async (next) => {
              if (next) {
                const result = await connectTeammate({ name: server.name, host: server.host || server.url });
                if (!result.ok) throw new Error(result.error || clientOutcome(result).join(" · ") || "연결하지 못했습니다.");
                await loadContext();
                refreshStatus();
                openConnected({ ...server, entry: result.entry });
                return;
              }
              const ok = await confirmWindow({
                title: `${server.name}의 기억을 끌까요?`,
                text: `Claude Code와 Codex에서 ${server.entry || `team-${server.name}`} 를 뺍니다. 다시 켜면 에이전트마다 한 번 더 로그인합니다.`,
                confirm: "끄기",
                danger: true,
              });
              if (!ok) return false;
              const result = await post("/api/teammates/disconnect", { name: server.name });
              await loadContext();
              refreshStatus();
              if (!result.ok) throw new Error(clientOutcome(result).join(" · ") || "다 끄지 못했습니다.");
            }, { label: `${server.name} 기억 켜기` }),
          ],
        });
      });
      const audits = Boolean(app.context?.localServer) || app.auditAnswers;
      clear(body,
        app.context?.oldBridge ? notice("warn", h("b", {}, "예전 방식의 팀원 기억 연결이 남아 있습니다."), " ",
          button("예전 연결 지우기", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            await cli("/api/bridge/disconnect", {});
            await loadContext();
            draw();
          }, { done: "예전 연결을 지웠습니다" }) })) : null,
        missing.length ? notice("warn", `${missing.join(", ")}가 이 컴퓨터에 없어 그쪽에는 넣지 않습니다.`) : null,
        list({
          title: "팀원 기억",
          actions: [button("팀 주소로 더하기", { kind: "small", onClick: () => openAdd(draw) })],
          empty: "아직 연결한 팀원 기억이 없습니다. 관리자에게 받은 팀 주소로 더하세요.",
        }, rows),
        audits ? list({
          title: "내 기억을 여는 팀원",
          actions: [button("조회 기록", { kind: "small", onClick: () => go("audit") })],
          empty: "",
        }, [listItem({
          title: "팀 명단에 있는 사람",
          sub: app.context?.team?.admin
            ? "관리자 탭의 팀원 명단에 있는 사람은 모두 내 기억에 chat으로 물을 수 있습니다."
            : "팀 관리자가 명단에 넣은 사람은 모두 내 기억에 chat으로 물을 수 있습니다.",
          end: app.context?.team?.admin ? button("관리자 탭", { kind: "small quiet", onClick: () => go("admin") }) : null,
        })]) : null);
    }

    clear(body, spinner());
    await draw();
    return null;
  },
};
