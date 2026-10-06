// Sharing this computer's memory server through a Cloudflare tunnel. The one
// switch serves two pages. 내 컴퓨터 → 다른 컴퓨터 붙이기 is for the owner's other
// computers, which come in through the gate with the server token. 팀 → 내 기억
// 공유 is for teammates, whose Claude Code and Codex ask at /mcp after a Google
// login (Cloudflare Access); there the one who opened the team also keeps who may
// log in, whose servers are shared, and the 팀 주소. Off, both pages offer the
// ways to turn it on.
import { cli } from "../lib/api.js";
import { h, clear, copyText } from "../lib/dom.js";
import { go } from "../lib/state.js";
import { button, busy, confirmSheet, errorNotice, notice, pageHead, spinner, statusTag, tag, toast } from "../lib/ui.js";

/** For a menu row: whether sharing is on, and at which address. */
export function shareState(update) {
  cli("/api/server/share/status", { check: false }).then((share) => {
    update((share.tunnel?.enabled ?? share.enabled) ? { label: "켜짐", kind: "ok", detail: share.publicUrl || "" } : { label: "꺼짐" });
  }).catch(() => {});
}

/** The share page for `part` ("computer" or "team"), under the header its menu gives it. */
export async function openShare(page, head, part) {
  const box = h("div", {}, h("div", { class: "empty" }, spinner()));
  const draw = async (check = false) => {
    let share;
    try {
      share = await cli("/api/server/share/status", { check });
    } catch (error) {
      clear(box, errorNotice(error));
      return;
    }
    const tunnelOn = share.tunnel?.enabled ?? share.enabled;
    clear(box, tunnelOn ? shareOn(share, draw, part) : shareOff(share, draw, part));
  };
  const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침", onClick: () => busy(refresh, () => draw(false)) });
  page.append(pageHead({ ...head, actions: [refresh] }), h("div", { class: "page-body" }, h("div", { class: "pad" }, box)));
  await draw(false);
}

const PUBLIC_STATES = {
  ok: ["ok", "밖에서 닿습니다", ""],
  access: ["ok", "Cloudflare Access가 지키고 있습니다", "이 컴퓨터는 Access를 통과하지 못해 안쪽까지는 확인하지 못했습니다. 팀원은 Google로 로그인해 들어옵니다."],
  token: ["bad", "서버 token이 맞지 않습니다", "통로는 열렸지만 문지기가 token을 받지 않았습니다. 서버를 다시 시작해 보세요."],
  unreachable: ["bad", "밖에서 닿지 않습니다", "Cloudflare 통로가 아직 붙지 않았거나 주소가 다릅니다. 잠시 뒤 다시 확인하세요."],
  error: ["bad", "확인하지 못했습니다", ""],
};

function mcpRow(share) {
  const mcp = share.mcp || {};
  const state = mcp.configured ? statusTag(mcp.running, ["준비됨", "멈춤"]) : tag("꺼짐");
  return h("div", { class: "row" },
    h("div", { style: { minWidth: "0" } },
      h("div", { class: "title" }, state, "팀원 MCP (/mcp)"),
      h("div", { class: "sub" }, mcp.configured
        ? "팀원의 Claude Code·Codex가 Google 로그인 뒤 이 기억에 chat으로 묻습니다."
        : ["직접 만든 통로로 켜면 /mcp는 열리지 않습니다. Cloudflare나 초대 코드로 켜면 열립니다.", mcp.missing?.length ? ` 빠진 설정: ${mcp.missing.join(", ")}` : ""].join("")),
    ),
    h("div", { class: "end" }),
  );
}

function shareOn(share, redraw, part) {
  const check = share.publicCheck;
  const state = check ? PUBLIC_STATES[check.state] || PUBLIC_STATES.error : null;
  const cloudflare = share.cloudflare || {};
  const team = part === "team";
  return h("div", {},
    (share.issues || []).length ? h("div", { style: { marginBottom: "12px" } }, notice("warn", h("ul", {}, share.issues.map((issue) => h("li", {}, issue))))) : null,
    h("div", { class: "rows" },
      h("div", { class: "row" },
        h("div", {}, h("div", { class: "title" }, statusTag(share.tunnel?.running, ["열림", "통로 멈춤"]), "공개 주소"), h("div", { class: "sub mono" }, share.publicUrl || "")),
        h("div", { class: "end" },
          button("", { kind: "small icon-only", iconName: "copy", title: "주소 복사", onClick: async () => { await copyText(share.publicUrl); toast("주소를 복사했습니다"); } }),
          button("밖에서 확인", { kind: "small", onClick: (event) => busy(event.currentTarget, () => redraw(true)) }),
        ),
      ),
      team ? h("div", { class: "row" },
        h("div", {}, h("div", { class: "title" }, statusTag(share.tunnel?.running, ["도는 중", "멈춤"]), "Cloudflare 통로"), h("div", { class: "sub" }, cloudflare.joined ? "팀을 연 사람이 만든 통로를 이 컴퓨터에서 돌립니다." : cloudflare.managed ? "이 앱이 내 Cloudflare 계정에 만든 통로입니다." : "Cloudflare 대시보드에서 직접 만든 통로입니다.")),
        h("div", { class: "end" }),
      ) : null,
      team ? mcpRow(share) : null,
      team ? null : h("div", { class: "row" },
        h("div", {}, h("div", { class: "title" }, statusTag(share.gate?.running, ["지키는 중", "멈춤"]), "문지기"), h("div", { class: "sub" }, "내 다른 컴퓨터는 서버 token이 있어야 기억 서버로 넘어갑니다.", share.gate?.localUrl ? ` ${share.gate.localUrl}` : "")),
        h("div", { class: "end" },
          button("서버 token 복사", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
            const result = await cli("/api/server/share/token", {});
            await copyText(result.token);
            toast("서버 token을 복사했습니다. 다른 컴퓨터의 대화 쌓기에 붙여 넣으세요.");
          }) }),
        ),
      ),
    ),
    state ? h("div", { style: { marginTop: "12px" } }, notice(state[0], h("b", {}, state[1]), state[2] ? ` ${state[2]}` : "", check.error ? h("div", { class: "muted" }, check.error) : null)) : null,
    team ? null : h("div", { style: { marginTop: "12px" } }, notice("", "다른 컴퓨터에서 내 컴퓨터 → 대화 쌓기 → 다른 컴퓨터 서버를 고르고, 이 주소와 서버 token을 넣으세요.")),
    team && cloudflare.managed ? teamBlock() : null,
    team && cloudflare.joined ? h("div", { style: { marginTop: "12px" } }, notice("", h("b", {}, "팀에 들어가 있습니다."), " 팀원들이 Google로 로그인해 이 기억에 묻습니다.",
      h("div", { class: "form-actions", style: { marginTop: "8px" } }, button("팀원 기억 연결", { kind: "small", onClick: () => go("team/memories") })))) : null,
    h("div", { class: "form-actions" },
      team ? null : button("서버 token 바꾸기", { kind: "small quiet", onClick: async (event) => {
        const ok = await confirmSheet({ title: "서버 token을 바꿀까요?", text: "지금 token을 쓰는 내 다른 컴퓨터는 모두 끊깁니다. 각 컴퓨터의 대화 쌓기에 새 token을 넣어야 다시 모입니다. 끊긴 동안의 대화는 다시 연결하면 이어서 쌓입니다. 팀원의 Google 로그인은 그대로입니다.", confirm: "바꾸기", danger: true });
        if (!ok) return;
        await busy(event.currentTarget, async () => { await cli("/api/server/share/rotate", {}); await redraw(false); }, { done: "새 서버 token을 만들었습니다" });
      } }),
      button("공유 끄기", { kind: "small quiet danger", onClick: async (event) => {
        const ok = await confirmSheet({ title: "공유를 끌까요?", text: "통로, 문지기, 팀원 MCP를 이 컴퓨터에서 멈춥니다. 내 다른 컴퓨터의 대화는 다시 켤 때까지 그 컴퓨터에 쌓였다가 이어서 옵니다. Cloudflare 쪽 설정과 token은 그대로 두니, 다시 켜면 팀원도 그대로 들어옵니다.", confirm: "끄기", danger: true });
        if (!ok) return;
        await busy(event.currentTarget, async () => { await cli("/api/server/share/disable", {}); await redraw(false); }, { done: "공유를 껐습니다" });
      } }),
    ),
  );
}

// 팀원: who may log in to the team's servers, the teammates' shared servers, and
// the 팀 주소. All through the owner's saved Cloudflare API token.
function teamBlock() {
  const box = h("div", {}, h("div", { class: "empty" }, spinner()));
  const drawTeam = async (banner = null) => {
    let team;
    try {
      team = await cli("/api/teammates", {});
    } catch (error) {
      clear(box, errorNotice(error));
      return;
    }
    const sharedBy = new Map((team.shared || []).map((item) => [item.name, item]));
    clear(box,
      banner,
      h("div", { class: "rows" }, (team.people || []).map((email) => h("div", { class: "row" },
        h("div", { style: { minWidth: "0" } }, h("div", { class: "title" }, email, email === team.owner ? tag("나") : null),
          h("div", { class: "sub" }, email === team.owner ? "팀을 연 사람" : [...sharedBy.values()].some((item) => item.email === email) ? "로그인할 수 있음 · 자기 기억도 공유" : "로그인할 수 있음")),
        h("div", { class: "end" }, email === team.owner ? null : button("", { kind: "small icon-only quiet danger", iconName: "trash", title: "팀에서 빼기", onClick: async (event) => {
          const ok = await confirmSheet({ title: `${email}를 팀에서 뺄까요?`, text: "이 사람은 이제 팀의 어느 기억에도 로그인하지 못합니다. 이 사람이 공유하던 서버는 그대로 남으니, 그것도 멈추려면 아래 서버 목록에서 공유를 뺍니다.", confirm: "빼기", danger: true });
          if (!ok) return;
          await busy(event.currentTarget, async () => {
            const result = await cli("/api/teammates/remove", { email });
            await drawTeam(notice("ok", h("b", {}, `${email}를 뺐습니다.`), result.stillShared?.length ? ` 공유 중인 서버(${result.stillShared.join(", ")})는 아직 남아 있습니다.` : ""));
          });
        } })),
      ))),
      h("h3", { class: "sub-title" }, "팀의 기억 서버"),
      h("div", { class: "rows" }, (team.servers || []).map((server) => h("div", { class: "row" },
        h("div", { style: { minWidth: "0" } }, h("div", { class: "title" }, server.name, sharedBy.has(server.name) ? null : tag("이 서버")), h("div", { class: "sub mono" }, server.host),
          sharedBy.get(server.name)?.email ? h("div", { class: "sub" }, sharedBy.get(server.name).email) : null),
        h("div", { class: "end" }, sharedBy.has(server.name) ? button("공유 빼기", { kind: "small quiet danger", onClick: async (event) => {
          const ok = await confirmSheet({ title: `${server.name} 서버의 공유를 뺄까요?`, text: `Cloudflare에서 ${server.host}의 통로, 주소, Access 설정을 지웁니다. 그 사람의 초대 코드는 더 이상 쓸 수 없고, 팀원은 그 기억에 묻지 못합니다.`, confirm: "공유 빼기", danger: true });
          if (!ok) return;
          await busy(event.currentTarget, async () => {
            await cli("/api/teammates/unshare", { name: server.name });
            await drawTeam(notice("ok", h("b", {}, `${server.name} 서버의 공유를 뺐습니다.`), " 그 사람 컴퓨터에서도 공유를 끄라고 알려 주세요."));
          });
        } }) : null),
      ))),
      addTeammate(drawTeam),
      h("h3", { class: "sub-title" }, "팀 주소"),
      h("p", { class: "section-note", style: { margin: "0 0 8px" } }, "질문만 하는 팀원에게 보냅니다. 비밀이 없는 주소라서 어디에 올려도 됩니다. 받은 사람은 팀 → 팀원 기억 연결에 붙여 넣습니다."),
      h("pre", { class: "log" }, team.addressText || ""),
      h("div", { class: "form-actions" }, button("팀 주소 복사", { kind: "small", iconName: "copy", onClick: async () => { await copyText(team.addressText || ""); toast("팀 주소를 복사했습니다"); } })),
    );
  };
  drawTeam();
  return h("div", { class: "team-block" }, h("h3", { class: "sub-title" }, "팀원"), box);
}

function addTeammate(drawTeam) {
  const email = h("input", { class: "input", type: "email", autocomplete: "off", placeholder: "teammate@example.com" });
  const sharing = h("input", { type: "checkbox" });
  const name = h("input", { class: "input", autocomplete: "off", pattern: "[a-z0-9][a-z0-9-]{0,30}[a-z0-9]?", placeholder: "예: alice" });
  const nameField = h("label", { class: "field" }, h("span", {}, "그 사람 서버 이름"), name, h("small", {}, "영문 소문자·숫자·-만 씁니다. 주소는 memory-<이름>.<zone>이 됩니다."));
  nameField.hidden = true;
  sharing.addEventListener("change", () => { nameField.hidden = !sharing.checked; });
  return h("div", {},
    h("h3", { class: "sub-title" }, "팀원 더하기"),
    h("div", { class: "panel" },
      notice("warn", "지금은 등록한 사람이 내 기억 전체에 chat으로 물을 수 있습니다 (프로젝트별 제한은 아직 없음)."),
      h("div", { class: "form-grid", style: { marginTop: "12px" } },
        h("label", { class: "field" }, h("span", {}, "이메일"), email, h("small", {}, "그 사람이 Google에 로그인하는 주소입니다.")),
        h("label", { class: "field wide", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, sharing, h("span", {}, "이 사람도 자기 기억을 공유")),
        nameField,
      ),
      h("div", { class: "form-actions" }, button("더하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
        const body = { email: email.value.trim(), share: sharing.checked };
        if (!body.email) throw new Error("이메일을 넣으세요.");
        if (sharing.checked) {
          body.name = name.value.trim().toLowerCase();
          if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(body.name)) throw new Error("서버 이름은 영문 소문자·숫자·-로 32자까지 씁니다.");
        }
        const result = await cli("/api/teammates/add", body);
        email.value = "";
        name.value = "";
        sharing.checked = false;
        nameField.hidden = true;
        await drawTeam(result.invite ? inviteOnce(result) : notice("ok", h("b", {}, `${result.email}를 더했습니다.`), " 이제 이 사람이 Google로 로그인해 팀의 기억에 묻습니다. 팀 주소를 보내 주세요."));
      }) })),
    ),
  );
}

// The invite holds the teammate's tunnel token: shown here once, never kept by the page.
function inviteOnce(result) {
  let code = result.invite;
  const box = h("pre", { class: "log", style: { userSelect: "all" } }, code);
  const panel = notice("warn",
    h("b", {}, `${result.share?.name || ""} 서버의 초대 코드 — 지금 한 번만 보입니다`),
    h("ul", {},
      h("li", {}, "이 코드에는 비밀(그 서버의 통로 token)이 들어 있습니다."),
      h("li", {}, "이 화면을 떠나면 다시 볼 수 없습니다. 잃어버리면 같은 이메일과 이름으로 다시 더해 새로 받습니다."),
      h("li", {}, "개인 대화로만 보내세요. 단체방이나 여러 사람이 보는 곳에 올리지 않습니다."),
      h("li", {}, "이 코드를 가진 사람은 누구나 그 서버 자리에 대신 설 수 있습니다."),
    ),
    box,
    h("div", { class: "form-actions" },
      button("초대 코드 복사", { kind: "small primary", iconName: "copy", onClick: async () => { await copyText(code); toast("초대 코드를 복사했습니다. 개인 대화로만 보내세요."); } }),
      button("보냈습니다", { kind: "small quiet", onClick: () => { code = ""; panel.remove(); } }),
    ),
    h("div", { class: "muted" }, `받은 사람은 자기 앱의 팀 → 내 기억 공유 → 초대 코드로 공유 켜기에 붙여 넣습니다. 주소는 ${result.share?.publicUrl || ""}입니다.`),
  );
  return panel;
}

function shareOff(share, redraw, part) {
  const team = part === "team";
  const saved = share.cloudflare?.apiTokenSaved;
  const body = h("div", {});
  const cards = {};
  const pick = (key) => {
    for (const [name, card] of Object.entries(cards)) {
      card.classList.toggle("picked", name === key);
      card.setAttribute("aria-pressed", String(name === key));
    }
    clear(body, key === "cloudflare" ? cloudflareForm(share, redraw) : inviteForm(redraw));
  };
  const card = (key, title, text) => {
    cards[key] = h("button", { type: "button", class: "choice", "aria-pressed": "false", onclick: () => pick(key) }, h("b", {}, title), h("span", {}, text));
    return cards[key];
  };
  const node = h("div", {},
    (share.issues || []).length ? h("div", { style: { marginBottom: "12px" } }, notice("warn", h("ul", {}, share.issues.map((issue) => h("li", {}, issue))))) : null,
    h("div", { class: team ? "choices two" : "choices three" },
      card("cloudflare", "Cloudflare로 공유 켜기", "팀을 처음 여는 사람이 씁니다. 내 Cloudflare 계정에 통로, 주소, Google 로그인(Access)을 이 앱이 만듭니다."),
      card("invite", "초대 코드로 공유 켜기", "팀을 연 사람에게 받은 초대 코드 하나면 됩니다."),
      // Shown so the option is known; the gate runs only with the Cloudflare tunnel today.
      team ? null : h("button", { type: "button", class: "choice", disabled: true },
        h("small", { class: "tag" }, "추후 업데이트"),
        h("b", {}, "Tailscale·SSH로 열기"),
        h("span", {}, "Cloudflare 없이 내 다른 컴퓨터만 연결합니다. 서버 token으로 들어옵니다.")),
    ),
    body,
    // A tunnel made by hand lets only the server token through, so teammates have no use for it.
    team ? null : h("details", { class: "raw", style: { marginTop: "16px" } }, h("summary", { class: "muted" }, "직접 만든 통로로 켜기"), h("div", { style: { marginTop: "12px" } }, manualForm(share, redraw))),
  );
  if (saved || share.cloudflare?.managed) pick("cloudflare");
  else if (share.cloudflare?.joined) pick("invite");
  return node;
}

function cloudflareForm(share, redraw) {
  const saved = share.cloudflare?.apiTokenSaved;
  const apiToken = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: saved ? "저장된 token을 그대로 씁니다" : "Cloudflare에서 만든 API token" });
  const email = h("input", { class: "input", type: "email", autocomplete: "off", placeholder: "me@example.com" });
  const zone = h("input", { class: "input", autocomplete: "off", placeholder: "example.com" });
  const name = h("input", { class: "input", autocomplete: "off", value: "memory", placeholder: "memory" });
  return h("div", {},
    h("div", { class: "form-grid" },
      h("label", { class: "field wide" }, h("span", {}, "Cloudflare API token"), apiToken,
        h("small", {}, "Cloudflare 대시보드 → My Profile → API Tokens에서 만듭니다. 이 컴퓨터에만 저장되고 화면이나 기록에 다시 나오지 않습니다.")),
      h("label", { class: "field wide" }, h("span", {}, "내 이메일"), email, h("small", {}, "팀 기억에 로그인할 때 쓰는 Google 계정입니다. 처음 한 번만 넣으면 됩니다.")),
      h("details", { class: "field wide access-fields" },
        h("summary", {}, "token 권한과 주소"),
        h("p", { class: "muted" }, "token에는 Account의 Cloudflare Tunnel: Edit, Access: Apps and Policies: Edit, Access: Organizations, Identity Providers, and Groups: Read와, 쓸 zone의 DNS: Edit, Zone: Read만 줍니다."),
        h("div", { class: "form-grid" },
          h("label", { class: "field" }, h("span", {}, "zone"), zone, h("small", {}, "비워 두면 token이 보는 zone이 하나일 때 그것을 씁니다.")),
          h("label", { class: "field" }, h("span", {}, "이름"), name, h("small", {}, "주소는 <이름>.<zone>이 됩니다.")),
        ),
      ),
    ),
    h("div", { class: "form-actions" }, button("Cloudflare로 공유 켜기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      const body = { cloudflare: true, name: name.value.trim() || "memory" };
      if (apiToken.value.trim()) body.apiToken = apiToken.value.trim();
      else if (!saved) throw new Error("Cloudflare API token을 넣으세요.");
      if (email.value.trim()) body.email = email.value.trim();
      if (zone.value.trim()) body.zone = zone.value.trim();
      try {
        await cli("/api/server/share/enable", body);
      } finally {
        apiToken.value = "";
      }
      await redraw(true);
    }, { done: "공유를 켰습니다" }) })),
  );
}

function inviteForm(redraw) {
  const invite = h("input", { class: "input mono", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "tm1.…" });
  return h("div", {},
    h("div", { class: "form-grid" },
      h("label", { class: "field wide" }, h("span", {}, "초대 코드"), invite,
        h("small", {}, "팀을 연 사람이 개인 대화로 보낸 tm1.로 시작하는 코드입니다. 이 컴퓨터에만 저장되고 화면이나 기록에 다시 나오지 않습니다.")),
    ),
    h("div", { class: "form-actions" }, button("초대 코드로 공유 켜기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      if (!invite.value.trim()) throw new Error("초대 코드를 붙여 넣으세요.");
      try {
        await cli("/api/server/share/join", { invite: invite.value.trim() });
      } finally {
        invite.value = "";
      }
      await redraw(true);
    }, { done: "공유를 켰습니다" }) })),
  );
}

function manualForm(share, redraw) {
  const address = h("input", { class: "input", type: "url", placeholder: "https://memory.example.com", value: share.publicUrl || "" });
  const token = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: share.tunnel?.tokenSaved ? "저장된 통로 token을 그대로 씁니다" : "Cloudflare에서 복사한 통로 token" });
  const port = share.gate?.port || 8010;
  return h("div", {},
    h("div", { class: "notice share-guide" }, h("div", {},
      h("b", {}, "Cloudflare 대시보드에서 통로를 직접 만든 경우입니다."),
      h("ol", {},
        h("li", {}, "Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared를 고르고 이름을 붙입니다."),
        h("li", {}, "설치 명령이 나오면 명령은 실행하지 말고, 그 안의 긴 token만 복사해 아래에 붙여 넣습니다."),
        h("li", {}, `Public hostname에 쓸 주소를 정하고, Service는 HTTP, URL은 gate:8010으로 둡니다. (이 컴퓨터의 문지기는 localhost:${port}에서도 답합니다.)`),
      ),
      h("p", { class: "muted", style: { margin: "8px 0 0" } }, "이렇게 켜면 내 다른 컴퓨터만 서버 token으로 들어오고, 팀원 MCP(/mcp)는 열리지 않습니다."),
    )),
    h("div", { class: "form-grid", style: { marginTop: "14px" } },
      h("label", { class: "field wide" }, h("span", {}, "공개 주소"), address, h("small", {}, "Cloudflare에서 정한 Public hostname을 https://와 함께 넣습니다.")),
      h("label", { class: "field wide" }, h("span", {}, "통로 token"), token, h("small", {}, "이 컴퓨터에만 저장되고, 화면이나 기록에 다시 나오지 않습니다.")),
    ),
    h("div", { class: "form-actions" },
      button("열기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
        const publicUrl = address.value.trim();
        if (!/^https:\/\/[^/?#]+\/?$/.test(publicUrl)) throw new Error("공개 주소는 https://로 시작하는 주소만 넣습니다. 뒤에 경로는 붙이지 않습니다.");
        if (!token.value.trim() && !share.tunnel?.tokenSaved) throw new Error("Cloudflare에서 복사한 통로 token을 넣으세요.");
        const body = { publicUrl: publicUrl.replace(/\/$/, "") };
        if (token.value.trim()) body.tunnelToken = token.value.trim();
        await cli("/api/server/share/enable", body);
        token.value = "";
        await redraw(true);
      }, { done: "열었습니다" }) }),
    ),
  );
}
