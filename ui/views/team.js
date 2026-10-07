// 팀: teammates' memories this computer's agents ask, and who may ask mine.
//
// 팀원 기억 lists every member from the team hub. Asking a teammate's memory starts
// with a chat request, which its owner approves with the projects they open; then
// 연결 puts it into Claude Code and Codex as a remote MCP server (team-<name>), and
// its row's switch takes it out and puts it back. 내 기억을 여는 팀원 is the other
// way: what this computer's server opened to whom (its gate's access.json), with
// 수정 for the projects and for closing it again, and who collects into it. Who
// asked my memory is 조회 기록 (audit.js).
import { post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { confirmWindow, list, listItem } from "../lib/kit.js";
import { chooseProjects, connectApproved, loadRequests, openConnected } from "../lib/requests.js";
import { clientOutcome, connectTeammate, mateName, sendRequest, teamCall, teamDirectory } from "../lib/team.js";
import { refreshBell } from "../lib/bell.js";
import { app, go, loadContext, refreshStatus } from "../lib/state.js";
import { button, busy, errorNotice, notice, pageHead, spinner, tag, toggle } from "../lib/ui.js";

const CLIENTS = { claude: "Claude Code", codex: "Codex" };

/** The person's name as the team shows it: their peer, else the start of their email. */
function nameOf(person) {
  return person.peer || person.email.split("@")[0];
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
      const team = app.context?.team || {};
      if (!team.hub || !team.signedIn) {
        clear(body, notice("warn", "팀에 로그인하지 않았습니다. ", button("팀에 들어가기", { kind: "small", onClick: () => go("start") })));
        return;
      }
      let directory;
      let requests;
      let connected;
      try {
        [directory, requests, connected] = await Promise.all([
          teamDirectory(),
          loadRequests({ fresh: true }),
          post("/api/teammates/connected", {}),
        ]);
      } catch (error) {
        clear(body, errorNotice(error));
        return;
      }
      const servers = new Map((directory.servers || []).map((server) => [server.owner, server]));
      const outgoing = new Map();
      for (const request of requests?.outgoing || []) {
        if (request.kind === "chat" && !outgoing.has(request.server)) outgoing.set(request.server, request);
      }
      const registered = new Map((connected.servers || []).map((server) => [server.host, server]));
      const clients = connected.clients || {};
      const missing = Object.entries(CLIENTS).filter(([key]) => clients[key]?.found === false).map(([, label]) => label);

      const mateRow = (person) => {
        const server = servers.get(person.email);
        if (!server) return listItem({ title: nameOf(person), sub: "서버 없음" });
        const request = outgoing.get(server.host);
        const local = registered.get(server.host);
        const agents = local ? Object.keys(CLIENTS).filter((key) => local[key]?.registered) : [];
        const projects = request?.projects?.length ? ` · 열린 프로젝트 ${request.projects.length}개` : "";
        const name = mateName(person);
        // Connected once: the switch takes it out of the agents and puts it back.
        if (agents.length || local) {
          const on = agents.length > 0;
          return listItem({
            title: nameOf(person),
            sub: on ? `${agents.map((key) => CLIENTS[key]).join("·")}${projects}` : `꺼 둠${projects}`,
            end: [
              on && local?.codex?.registered ? button("로그인 안내", { kind: "small quiet", onClick: () => openConnected({ name, entry: local.entry }) }) : null,
              toggle(on, async (next) => {
                if (next) {
                  const result = await connectTeammate({ name, host: server.host });
                  if (!result.ok) throw new Error(result.error || clientOutcome(result).join(" · ") || "연결하지 못했습니다.");
                  await loadContext();
                  refreshStatus();
                  openConnected({ name, entry: result.entry });
                  draw();
                  return;
                }
                const ok = await confirmWindow({
                  title: `${nameOf(person)}의 기억을 끌까요?`,
                  text: `Claude Code와 Codex에서 team-${name} 을 뺍니다. 다시 켜면 에이전트마다 한 번 더 로그인합니다.`,
                  confirm: "끄기",
                  danger: true,
                });
                if (!ok) return false;
                const result = await post("/api/teammates/disconnect", { name });
                await loadContext();
                refreshStatus();
                if (!result.ok) throw new Error(clientOutcome(result).join(" · ") || "다 끄지 못했습니다.");
              }, { label: `${nameOf(person)} 기억 켜기` }),
            ],
          });
        }
        if (request?.status === "pending") {
          return listItem({
            title: nameOf(person),
            tags: [" ", tag("승인 기다리는 중", "warn")],
            sub: server.host,
            end: button("요청 취소", { kind: "small quiet", onClick: (event) => busy(event.currentTarget, async () => {
              await teamCall("/api/team/cancel", { id: request.id });
              refreshBell();
              await draw();
            }) }),
          });
        }
        if (request?.status === "approved") {
          return listItem({
            title: nameOf(person),
            tags: [" ", tag("승인됨", "ok")],
            sub: `열린 프로젝트 ${(request.projects || []).length}개`,
            end: button("연결", { kind: "primary small", onClick: (event) => busy(event.currentTarget, async () => {
              await connectApproved({ ...request, ownerPeer: person.peer });
              refreshBell();
              await draw();
            }) }),
          });
        }
        return listItem({
          title: nameOf(person),
          tags: request?.status === "declined" ? [" ", tag("거절됨")] : [],
          sub: server.host,
          end: button("chat 요청", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            await sendRequest({ kind: "chat", server: server.host });
            refreshBell();
            await draw();
          }, { done: `${nameOf(person)}에게 chat을 요청했습니다` }) }),
        });
      };

      const mates = (directory.people || []).filter((person) => person.email !== team.email).map(mateRow);
      // What is opened to whom lives beside the server, so the computer that runs it lists it.
      const myServer = servers.get(team.email);
      const granted = myServer && myServer.host === team.localHost ? grantRows(requests, directory) : null;
      clear(body,
        missing.length ? notice("warn", `${missing.join(", ")}가 이 컴퓨터에 없어 그쪽에는 넣지 않습니다.`) : null,
        list({ title: "팀원 기억", empty: "아직 다른 팀원이 없습니다." }, mates),
        granted ? list({
          title: "내 기억을 여는 팀원",
          actions: [button("조회 기록", { kind: "small", onClick: () => go("audit") })],
          empty: "아직 없습니다.",
        }, granted) : null);
    }

    /** What this computer's server opened to whom: chat with its projects, or collecting into it. */
    function grantRows(requests, directory) {
      const people = new Map((directory.people || []).map((person) => [person.email, person]));
      const approved = new Map();
      for (const request of requests?.granted || []) approved.set(`${request.kind}:${request.from}`, request);
      return (requests?.grants || []).flatMap((grant) => {
        const person = people.get(grant.email) || { email: grant.email, peer: grant.peer };
        const rows = [];
        if (grant.chat) {
          const request = approved.get(`chat:${grant.email}`);
          rows.push(listItem({
            title: nameOf(person),
            tags: [" ", tag("chat")],
            sub: grant.chat.projects.length ? `열린 프로젝트: ${grant.chat.projects.map((project) => project.name).join(" · ")}` : "열린 프로젝트 없음",
            end: button("수정", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
              await editGrant(person, grant, request);
            }) }),
          }));
        }
        if (grant.collect) {
          const request = approved.get(`collect:${grant.email}`);
          rows.push(listItem({
            title: nameOf(person),
            tags: [" ", tag("대화 쌓기")],
            sub: "이 서버에 대화를 쌓습니다",
            end: button("멈추기", { kind: "small danger", onClick: async (event) => {
              const ok = await confirmWindow({ title: `${nameOf(person)}의 대화 쌓기를 멈출까요?`, text: `${grant.email} 의 컴퓨터는 이 서버에 더 이상 쌓지 못합니다. 이미 쌓인 대화는 그대로 둡니다.`, confirm: "멈추기", danger: true });
              if (!ok) return;
              await busy(event.currentTarget, async () => {
                await teamCall("/api/team/stop-collect", { email: grant.email, request: request?.id || "" });
                await draw();
              });
            } }),
          }));
        }
        return rows;
      });
    }

    /** 수정: the projects open to a teammate, or 끊기 to close chat to them. */
    async function editGrant(person, grant, request) {
      let closed = false;
      const name = nameOf(person);
      const close = button(`${name} 끊기`, { kind: "danger", onClick: async (event) => {
        const target = event.currentTarget;
        const ok = await confirmWindow({ title: `${name}을 끊을까요?`, text: `${name}은 내 기억에 더 이상 chat으로 묻지 못합니다.`, confirm: "끊기", danger: true });
        if (!ok) return;
        await busy(target, async () => {
          await teamCall("/api/team/grant", { email: grant.email, request: request?.id || "", close: true });
          closed = true;
          target.closest("dialog")?.close();
        }, { done: `${name}을 끊었습니다` });
      } });
      const projects = await chooseProjects({
        title: `${name}에게 연 프로젝트`,
        lead: `${name}가 chat으로 물을 때 답에 쓸 프로젝트입니다.`,
        chosen: grant.chat.projects,
        confirm: "적용",
        extra: close,
      });
      if (projects && !closed) {
        await teamCall("/api/team/grant", { email: grant.email, peer: grant.peer, projects, request: request?.id || "" });
        post("/api/team/scopes", {}).catch(() => {});
      }
      await draw();
    }

    clear(body, spinner());
    await draw();
    return null;
  },
};
