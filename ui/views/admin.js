// 관리자: the team, for its admins only. Who is in it (the team hub's roster, which
// is also the email list every server's Cloudflare Access checks), the 팀 주소 to
// send someone new, and, on the computer that made the team, the Cloudflare API
// token it runs on. Adding someone takes their Google email and nothing else: they
// log in at the team's address, and make a server of their own if they want one.
// The team's Jev key is set here too: the hub keeps it and judges teammates'
// questions with it for every shared server of the team, which holds only its own
// token for the hub's guard. The key never leaves the hub, and the page never sees
// it again once saved. This is the one screen that names Cloudflare.
import { post } from "../lib/api.js";
import { h, clear, copyText } from "../lib/dom.js";
import { fullDate, number } from "../lib/format.js";
import { block, confirmWindow, field, kv, list, listItem, modal } from "../lib/kit.js";
import { teamCall, teamErrorNotice } from "../lib/team.js";
import { app, loadContext } from "../lib/state.js";
import { button, busy, notice, pageHead, spinner, tag, toast } from "../lib/ui.js";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 팀원 더하기: one Google email. */
function openAdd(onAdded) {
  const win = modal({ title: "팀원 더하기", big: true, small: true });
  const email = h("input", { class: "input mono", type: "email", autocomplete: "off", placeholder: "teammate@example.com" });
  const problem = h("div", {});
  win.body(
    field("Google 이메일", email),
    h("div", { class: "notice warn", style: { marginTop: "14px" } },
      "더한 사람은 팀 주소로 로그인해 팀원 명단과 서버 주소를 보고, 팀원 기억에 chat을, 회사 서버에 대화 쌓기를 요청할 수 있습니다. 회사 밖 사람은 더하지 마세요."),
    problem);
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("더하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      const value = email.value.trim().toLowerCase();
      if (!EMAIL.test(value)) { clear(problem, notice("warn", "Google 이메일을 넣으세요.")); return; }
      await teamCall("/api/team/admin/add", { email: value });
      win.close("ok");
      onAdded(value);
      toast(`${value}를 더했습니다. 위의 팀 주소를 보내 주세요.`, "ok");
    }) }),
  ]);
  win.open();
  email.focus();
}

/** token 바꾸기: the hub is deployed again with the new token, which is kept only once that works. */
function openToken(made, onDone) {
  const win = modal({ title: "Cloudflare API token 바꾸기", big: true, small: true });
  const token = h("input", { class: "input mono", type: "password", autocomplete: "off", spellcheck: "false" });
  const problem = h("div", {});
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } }, "새 token으로 팀 주소의 Worker를 다시 올리고 팀의 Cloudflare 설정을 확인합니다. 1~2분 걸립니다."),
    field("새 API token", token, "Cloudflare에서 새로 만든 token을 여기에만 붙여 넣으세요. Workers: Admin과 zone의 Workers Routes: Edit 권한도 있어야 합니다."),
    problem);
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("바꾸기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      if (!token.value.trim()) { clear(problem, notice("warn", "새 token을 넣으세요.")); return; }
      const body = { apiToken: token.value.trim(), name: made.name, email: made.ownerEmail, zone: made.zone, hub: (made.hub || "").split(".")[0] };
      let result;
      try {
        result = await post("/api/team/make", body);
      } finally {
        token.value = "";
      }
      if (!result.ok) { clear(problem, notice("bad", result.error || "바꾸지 못했습니다.")); return; }
      win.close("ok");
      await loadContext();
      onDone();
      toast("token을 바꿨습니다.", "ok");
    }) }),
  ]);
  win.open();
}

/** Jev 키: saved to the team hub and cleared there; the field is emptied either way. */
function jevRow(jev, redraw) {
  const key = h("input", { class: "input mono", type: "password", autocomplete: "off", spellcheck: "false", placeholder: jev?.set ? "새 키로 바꾸기" : "Jev API 키", "aria-label": "Jev 키", style: { flex: "1 1 220px", minWidth: "0" } });
  const status = !jev ? tag("확인하지 못함", "warn")
    : jev.set ? h("span", { title: fullDate(jev.setAt) }, tag(`설정됨 · ${jev.setAt ? `${new Date(jev.setAt).getMonth() + 1}월 ${new Date(jev.setAt).getDate()}일` : "-"}`, "ok"))
    : tag("없음");
  const save = button("저장", { kind: "small primary", onClick: (event) => busy(event.currentTarget, async () => {
    const value = key.value.trim();
    if (!value) { toast("Jev 키를 넣으세요.", "bad"); return; }
    try {
      await teamCall("/api/team/admin/jev/set", { key: value });
    } finally {
      key.value = "";
    }
    toast("Jev 키를 저장했습니다.", "ok");
    await redraw();
  }) });
  const remove = jev?.set ? button("지우기", { kind: "small danger", onClick: async (event) => {
    const target = event.currentTarget;
    const ok = await confirmWindow({
      title: "Jev 키를 지울까요?",
      text: "지우면 바로 팀 서버들이 팀원 질문을 Jev로 살피지 않습니다.",
      confirm: "지우기",
      danger: true,
    });
    if (!ok) return;
    await busy(target, async () => { await teamCall("/api/team/admin/jev/clear", {}); await redraw(); }, { done: "Jev 키를 지웠습니다" });
  } }) : null;
  return kv("Jev 키", [
    status,
    h("div", { class: "s" }, "팀원이 묻는 말을 허브가 Jev로 먼저 살핍니다. 키는 허브에만 있고 팀 서버로 나가지 않습니다."),
    h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" } }, key, save, remove),
  ]);
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
      let jev;
      try {
        [roster, jev] = await Promise.all([
          teamCall("/api/team/admin/people", {}),
          // A hub deployed before the Jev key cannot say; the rest of the page still shows.
          teamCall("/api/team/admin/jev", {}).then((answer) => answer.jev, () => null),
        ]);
      } catch (error) {
        clear(body, teamErrorNotice(error, { onDone: draw }));
        return;
      }
      const people = [...(roster.people || [])].sort((left, right) => (left.email === team.email ? -1 : right.email === team.email ? 1 : 0));
      const address = team.hub ? `https://${team.hub}` : "";
      const made = team.made;
      clear(body,
        block({ title: "팀" },
          kv("팀 이름", roster.team?.name || team.name || "-"),
          kv("팀 주소", [h("span", { class: "mono" }, address || "-"), h("div", { class: "s" }, "새 팀원에게 이 주소를 보내세요.")],
            button("복사", { kind: "small", onClick: async () => { await copyText(address); toast("팀 주소를 복사했습니다"); } })),
          jevRow(jev, draw)),
        list({
          title: `팀원 ${number(people.length)}명`,
          actions: [button("팀원 더하기", { kind: "primary small", onClick: () => openAdd((email) => { fresh.add(email); draw(); }) })],
        }, people.map((person) => {
          const own = person.email === team.email;
          const server = (person.servers || [])[0];
          return listItem({
            title: person.email,
            tags: own ? [" ", tag("나 · 관리자")] : person.admin ? [" ", tag("관리자")] : fresh.has(person.email) ? [" ", tag("방금 더함", "new")] : [],
            sub: server ? `서버 ${server}` : person.joined ? "서버 없음" : "아직 로그인하지 않음",
            fresh: fresh.has(person.email),
            end: own ? null : button("팀에서 빼기", { kind: "small danger", onClick: async (event) => {
              const target = event.currentTarget;
              const name = person.peer || person.email.split("@")[0];
              const ok = await confirmWindow({
                title: `${name}을 팀에서 뺄까요?`,
                text: `${person.email} 은 팀 주소로 로그인하지 못합니다. 팀원 기억 연결이 끊기고, 회사 서버에도 더 이상 대화를 쌓지 못합니다.${server ? ` 그 사람의 서버 주소(${server})도 지웁니다.` : ""}`,
                confirm: "빼기",
                danger: true,
              });
              if (!ok) return;
              await busy(target, async () => { await teamCall("/api/team/admin/remove", { email: person.email }); fresh.delete(person.email); await draw(); }, { done: `${person.email}를 뺐습니다` });
            } }),
          });
        })),
        made ? block({ title: "Cloudflare", actions: [button("token 바꾸기", { onClick: () => openToken(made, draw) })] },
          kv("도메인", made.zone || "-"),
          kv("API token", made.hasApiToken
            ? (made.deployedAt ? `${new Date(made.deployedAt).getMonth() + 1}월 ${new Date(made.deployedAt).getDate()}일에 넣음` : "이 컴퓨터에 저장됨")
            : tag("없음", "warn"))) : null);
    }

    clear(body, spinner());
    await draw();
    return null;
  },
};
