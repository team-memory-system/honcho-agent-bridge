// 관리자: the team this computer made with 새 팀 만들기, for its admin only. Who may
// log in to the team's memory servers (one email list, the Cloudflare Access policy
// every server shares), the 팀 주소 to send new teammates, and the Cloudflare API
// token it all runs on. Everything goes through `teammates ...` with the token saved
// on this computer (team-access.mjs); this is the one screen that names Cloudflare.
import { cli } from "../lib/api.js";
import { h, clear, copyText } from "../lib/dom.js";
import { number } from "../lib/format.js";
import { block, confirmWindow, field, kv, list, listItem, modal } from "../lib/kit.js";
import { app, loadContext } from "../lib/state.js";
import { button, busy, errorNotice, notice, pageHead, spinner, tag, toast } from "../lib/ui.js";

const SERVER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** The invite holds the teammate's tunnel token: shown here once, never kept by the page. */
function showInvite(result) {
  let code = result.invite;
  const win = modal({ title: `${result.share?.name || ""} 서버의 초대 코드`, big: true, small: true, onClose: () => { code = ""; } });
  win.body(
    notice("warn", h("b", {}, "지금 한 번만 보입니다."), h("ul", {},
      h("li", {}, "이 코드에는 그 서버의 Tunnel token이 들어 있습니다. 개인 대화로만 보내세요."),
      h("li", {}, "이 창을 닫으면 다시 볼 수 없습니다. 잃어버리면 같은 이메일과 이름으로 다시 더해 새로 받습니다."))),
    h("pre", { class: "log", style: { userSelect: "all" } }, code),
    h("p", { class: "hint" }, `받은 사람은 자기 앱의 서버 → 공유 → 초대 코드로 열기에 붙여 넣습니다. 주소는 ${result.share?.publicUrl || ""}입니다.`));
  win.foot(null, [
    button("초대 코드 복사", { kind: "primary", iconName: "copy", onClick: async () => { await copyText(code); toast("초대 코드를 복사했습니다. 개인 대화로만 보내세요."); } }),
    button("닫기", { onClick: () => win.close() }),
  ]);
  win.open();
}

/** 팀원 더하기: one Google email, and a server of their own if they share theirs too. */
function openAdd(onAdded) {
  const win = modal({ title: "팀원 더하기", big: true, small: true });
  const email = h("input", { class: "input mono", type: "email", autocomplete: "off", placeholder: "teammate@example.com" });
  const sharing = h("input", { type: "checkbox" });
  const name = h("input", { class: "input mono", autocomplete: "off", placeholder: "예: alice" });
  const nameField = field("그 사람 서버 이름", name, "영문 소문자·숫자·-만 씁니다. 주소는 memory-<이름>.<zone>이 됩니다.");
  nameField.hidden = true;
  sharing.addEventListener("change", () => { nameField.hidden = !sharing.checked; });
  const problem = h("div", {});
  win.body(
    field("Google 이메일", email),
    h("label", { class: "row2" }, sharing, "이 사람도 자기 기억을 공유"),
    nameField,
    h("div", { class: "notice warn", style: { marginTop: "14px" } },
      "더한 사람은 팀 주소로 로그인해 팀원 기억에 chat으로 물을 수 있습니다. 회사 밖 사람은 더하지 마세요."),
    problem);
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("더하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      const body = { email: email.value.trim(), share: sharing.checked };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) { clear(problem, notice("warn", "Google 이메일을 넣으세요.")); return; }
      if (sharing.checked) {
        body.name = name.value.trim().toLowerCase();
        if (!SERVER_NAME.test(body.name)) { clear(problem, notice("warn", "서버 이름은 영문 소문자·숫자·-로 32자까지 씁니다.")); return; }
      }
      const result = await cli("/api/teammates/add", body);
      win.close("ok");
      onAdded(result.email || body.email);
      if (result.invite) showInvite(result);
      else toast(`${result.email || body.email}를 더했습니다. 위의 팀 주소를 보내 주세요.`, "ok");
    }) }),
  ]);
  win.open();
  email.focus();
}

/** token 바꾸기: the team's Cloudflare steps run again with a new token, which is kept only once they pass. */
function openToken(team, onDone) {
  const win = modal({ title: "Cloudflare API token 바꾸기", big: true, small: true });
  const token = h("input", { class: "input mono", type: "password", autocomplete: "off", spellcheck: "false" });
  const problem = h("div", {});
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } }, "새 token으로 팀의 Cloudflare 설정을 다시 확인합니다. 1~2분 걸리고, 그동안 팀원 연결이 잠깐 끊길 수 있습니다."),
    field("새 API token", token, "Cloudflare에서 새로 만든 token을 여기에만 붙여 넣으세요."),
    problem);
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("바꾸기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      if (!token.value.trim()) { clear(problem, notice("warn", "새 token을 넣으세요.")); return; }
      const body = { cloudflare: true, apiToken: token.value.trim(), email: team.ownerEmail, name: (team.host || "memory").split(".")[0] || "memory" };
      if (team.zone) body.zone = team.zone;
      try {
        await cli("/api/server/share/enable", body);
      } finally {
        token.value = "";
      }
      win.close("ok");
      await loadContext();
      onDone();
      toast("token을 바꿨습니다.", "ok");
    }) }),
  ]);
  win.open();
}

export default {
  title: "관리자",
  async mount(page) {
    const body = h("div", { class: "pad stack" });
    page.append(
      pageHead({ title: "관리자", subtitle: "팀원 명단과 팀 주소를 관리합니다." }),
      h("div", { class: "page-body" }, body),
    );
    // The email just added stays marked until the page is left.
    const fresh = new Set();

    async function draw() {
      const team = app.context?.team || {};
      let roster;
      try {
        roster = await cli("/api/teammates", {});
      } catch (error) {
        clear(body, errorNotice(error));
        return;
      }
      const shared = new Map((roster.shared || []).map((item) => [item.email, item]));
      const ownerServer = (roster.servers || []).find((server) => ![...shared.values()].some((item) => item.name === server.name));
      const people = [...(roster.people || [])].sort((left, right) => (left === roster.owner ? -1 : right === roster.owner ? 1 : 0));
      const address = roster.addressText || "";
      clear(body,
        block({ title: "팀" },
          kv("팀 주소", [h("pre", { class: "mono", style: { margin: "0", whiteSpace: "pre-wrap" } }, address.trim() || "-"),
            h("div", { class: "s" }, "새 팀원에게 이 주소를 보내세요. 비밀이 없어 어디에 올려도 됩니다.")],
          button("복사", { kind: "small", onClick: async () => { await copyText(address); toast("팀 주소를 복사했습니다"); } }))),
        list({
          title: `팀원 ${number(people.length)}명`,
          actions: [button("팀원 더하기", { kind: "primary small", onClick: () => openAdd((email) => { fresh.add(email); draw(); }) })],
        }, people.map((email) => {
          const own = email === roster.owner;
          const server = own ? ownerServer : shared.get(email);
          return listItem({
            title: email,
            tags: own ? [" ", tag("나 · 관리자")] : fresh.has(email) ? [" ", tag("방금 더함", "new")] : [],
            sub: server ? `서버 ${server.host || server.name}` : "자기 서버 없음",
            fresh: fresh.has(email),
            end: own ? null : [
              shared.has(email) ? button("공유 빼기", { kind: "small quiet", onClick: async (event) => {
                const item = shared.get(email);
                const ok = await confirmWindow({ title: `${item.name} 서버의 공유를 뺄까요?`, text: `${item.host || item.name}의 Tunnel, 주소, 로그인 설정을 지웁니다. 그 사람의 초대 코드는 더 이상 쓸 수 없고, 팀원은 그 기억에 묻지 못합니다.`, confirm: "공유 빼기", danger: true });
                if (!ok) return;
                await busy(event.currentTarget, async () => { await cli("/api/teammates/unshare", { name: item.name }); await draw(); }, { done: `${item.name} 서버의 공유를 뺐습니다` });
              } }) : null,
              button("팀에서 빼기", { kind: "small danger", onClick: async (event) => {
                const ok = await confirmWindow({ title: `${email.split("@")[0]}을 팀에서 뺄까요?`, text: `${email} 은 팀 주소로 로그인하지 못합니다. 팀원 기억에 묻지 못하게 되고, 공유하던 서버가 있으면 그 공유는 따로 빼야 멈춥니다.`, confirm: "빼기", danger: true });
                if (!ok) return;
                await busy(event.currentTarget, async () => { await cli("/api/teammates/remove", { email }); fresh.delete(email); await draw(); }, { done: `${email}를 뺐습니다` });
              } }),
            ],
          });
        })),
        block({ title: "Cloudflare", actions: [button("token 바꾸기", { onClick: () => openToken(team, draw) })] },
          kv("도메인", team.zone || "-"),
          kv("API token", team.hasApiToken ? "이 컴퓨터에 저장됨" : tag("없음", "warn")),
          kv("내 서버", team.host ? h("span", { class: "mono" }, team.host) : "-")));
    }

    clear(body, spinner());
    await draw();
    return null;
  },
};
