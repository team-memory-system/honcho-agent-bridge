// 서버 → 공유: this computer's memory server opened through a Cloudflare Tunnel.
// The owner's other computers come in through the gate with the server token, and
// teammates' Claude Code and Codex ask at /mcp after a Google login (Cloudflare
// Access). With it on, one block says where it is and how it stands; with it off,
// the ways to turn it on. The team it opens to is 관리자 (admin.js). Only the way
// the team's admin takes names Cloudflare; a teammate sees the invite code.
import { cli } from "../lib/api.js";
import { h, clear, copyText } from "../lib/dom.js";
import { screenTabs } from "../lib/tabs.js";
import { block, confirmWindow, kv } from "../lib/kit.js";
import { button, busy, errorNotice, notice, pageHead, spinner, statusTag, tag, toast } from "../lib/ui.js";

/** 서버 → 공유: the switch, and with it on, the address and the server token. */
export default {
  title: "서버",
  async mount(page) {
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
      clear(box, tunnelOn ? shareOn(share, draw) : shareOff(share, draw));
    };
    const refresh = button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침", onClick: () => busy(refresh, () => draw(false)) });
    page.append(
      pageHead({ title: "서버", subtitle: "내 다른 컴퓨터와 팀원이 이 서버에 닿게 엽니다.", actions: [refresh], subnav: screenTabs("share") }),
      h("div", { class: "page-body" }, h("div", { class: "pad stack" }, box)),
    );
    await draw(false);
  },
};

const PUBLIC_STATES = {
  ok: ["ok", "밖에서 닿습니다", ""],
  // Access answered before the gate could: reachable, the inside not checked.
  access: ["ok", "밖에서 닿습니다", "Google 로그인 화면까지 확인했습니다."],
  token: ["bad", "서버 token이 맞지 않습니다", "주소는 열렸지만 gate가 token을 받지 않았습니다. 서버 → 기억 서버에서 멈추기를 누르고 시작을 누르세요."],
  unreachable: ["bad", "밖에서 닿지 않습니다", "Tunnel이 아직 붙지 않았거나 주소가 다릅니다. 잠시 뒤 밖에서 확인을 다시 누르세요."],
  error: ["bad", "확인하지 못했습니다", ""],
};

function mcpLine(share) {
  const mcp = share.mcp || {};
  if (!mcp.configured) {
    return [tag("꺼짐"), h("div", { class: "s" }, ["팀원이 묻게 하려면 공유를 끄고 팀 만들기나 초대 코드로 다시 켜세요.", mcp.missing?.length ? ` 빠진 설정: ${mcp.missing.join(", ")}` : ""].join(""))];
  }
  return [statusTag(mcp.running, ["준비됨", "멈춤"]), " ", h("span", { class: "mono muted" }, share.publicUrl ? `${share.publicUrl}/mcp` : "")];
}

function shareOn(share, redraw) {
  const check = share.publicCheck;
  const state = check ? PUBLIC_STATES[check.state] || PUBLIC_STATES.error : null;
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
    (share.issues || []).length ? notice("warn", h("ul", {}, share.issues.map((issue) => h("li", {}, issue)))) : null,
    block({
      title: "공유",
      tag: statusTag(share.tunnel?.running, ["켜짐", "멈춤"]),
      actions: [
        button("밖에서 확인", { kind: "small", onClick: (event) => busy(event.currentTarget, () => redraw(true)) }),
        button("공유 끄기", { kind: "small danger", onClick: async (event) => {
          const ok = await confirmWindow({ title: "공유를 끌까요?", text: "Tunnel, gate, 팀원 MCP를 이 컴퓨터에서 멈춥니다. 내 다른 컴퓨터의 대화는 다시 켤 때까지 그 컴퓨터에 쌓였다가 이어서 옵니다. 주소와 token은 그대로 두니, 다시 켜면 팀원도 그대로 들어옵니다.", confirm: "끄기", danger: true });
          if (!ok) return;
          await busy(event.currentTarget, async () => { await cli("/api/server/share/disable", {}); await redraw(false); }, { done: "공유를 껐습니다" });
        } }),
      ],
    },
    kv("이 서버의 주소", h("span", { class: "mono" }, share.publicUrl || ""),
      button("", { kind: "small icon-only", iconName: "copy", title: "주소 복사", onClick: async () => { await copyText(share.publicUrl); toast("주소를 복사했습니다"); } })),
    kv("서버 token", [statusTag(share.gate?.running, ["gate 켜짐", "gate 멈춤"]), h("div", { class: "s" }, "내 다른 컴퓨터가 이 서버에 쌓을 때 넣는 token입니다.")],
      h("span", { style: { display: "flex", gap: "6px" } },
        button("복사", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
          const result = await cli("/api/server/share/token", {});
          await copyText(result.token);
          toast("서버 token을 복사했습니다. 다른 컴퓨터의 대화 수집 설정에 붙여 넣으세요.");
        }) }),
        button("바꾸기", { kind: "small quiet", onClick: async (event) => {
          const ok = await confirmWindow({ title: "서버 token을 바꿀까요?", text: "지금 token을 쓰는 내 다른 컴퓨터는 모두 끊깁니다. 각 컴퓨터의 대화 수집 설정에 새 token을 넣어야 다시 모입니다. 끊긴 동안의 대화는 다시 연결하면 이어서 쌓입니다. 팀원의 Google 로그인은 그대로입니다.", confirm: "바꾸기", danger: true });
          if (!ok) return;
          await busy(event.currentTarget, async () => { await cli("/api/server/share/rotate", {}); await redraw(false); }, { done: "새 서버 token을 만들었습니다" });
        } }))),
    kv("팀원 MCP", mcpLine(share))),
    state ? notice(state[0], h("b", {}, state[1]), state[2] ? ` ${state[2]}` : "", check.error ? h("div", { class: "muted" }, check.error) : null) : null,
    notice("", "다른 컴퓨터에서 기억 설정 → 대화 수집 → 수정을 누르고, 다른 컴퓨터의 내 서버에 이 주소와 서버 token을 넣으세요."));
}

function shareOff(share, redraw) {
  const saved = share.cloudflare?.apiTokenSaved;
  const managed = share.cloudflare?.managed;
  const body = h("div", {});
  const cards = {};
  const pick = (key) => {
    for (const [name, card] of Object.entries(cards)) {
      card.classList.toggle("picked", name === key);
      card.setAttribute("aria-pressed", String(name === key));
    }
    clear(body, key === "team" ? cloudflareForm(share, redraw) : inviteForm(redraw));
  };
  const card = (key, title, text) => {
    cards[key] = h("button", { type: "button", class: "choice", "aria-pressed": "false", onclick: () => pick(key) }, h("b", {}, title), h("span", {}, text));
    return cards[key];
  };
  const node = h("div", {},
    (share.issues || []).length ? h("div", { style: { marginBottom: "12px" } }, notice("warn", h("ul", {}, share.issues.map((issue) => h("li", {}, issue))))) : null,
    h("div", { class: "choices three" },
      managed
        ? card("team", "다시 켜기", "만들어 둔 팀 그대로 켭니다.")
        : card("team", "팀 만들기", "팀 관리자가 처음 한 번 합니다."),
      card("invite", "초대 코드로 열기", "팀 관리자에게 받은 초대 코드를 넣습니다."),
      // Shown so the option is known; the gate runs only with the Cloudflare Tunnel today.
      h("button", { type: "button", class: "choice", disabled: true },
        h("small", { class: "tag" }, "추후 업데이트"),
        h("b", {}, "Tailscale·SSH로 열기"),
        h("span", {}, "내 다른 컴퓨터만 서버 token으로 연결합니다.")),
    ),
    body,
    h("details", { class: "raw", style: { marginTop: "16px" } }, h("summary", { class: "muted" }, "직접 만든 Tunnel로 켜기"), h("div", { style: { marginTop: "12px" } }, manualForm(share, redraw))),
  );
  if (saved || managed) pick("team");
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
    h("div", { class: "form-actions" }, button(share.cloudflare?.managed ? "다시 켜기" : "팀 만들기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
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
    h("div", { class: "form-actions" }, button("열기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
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
  const token = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: share.tunnel?.tokenSaved ? "저장된 Tunnel token을 그대로 씁니다" : "Cloudflare에서 복사한 Tunnel token" });
  const port = share.gate?.port || 8010;
  return h("div", {},
    h("div", { class: "notice share-guide" }, h("div", {},
      h("b", {}, "Cloudflare 대시보드에서 Tunnel을 직접 만든 경우입니다."),
      h("ol", {},
        h("li", {}, "Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared를 고르고 이름을 붙입니다."),
        h("li", {}, "설치 명령이 나오면 명령은 실행하지 말고, 그 안의 긴 token만 복사해 아래에 붙여 넣습니다."),
        h("li", {}, `Public hostname에 쓸 주소를 정하고, Service는 HTTP, URL은 gate:8010으로 둡니다. (gate는 이 컴퓨터의 localhost:${port}에서도 답합니다.)`),
      ),
      h("p", { class: "muted", style: { margin: "8px 0 0" } }, "이 방식으로는 내 다른 컴퓨터만 서버 token으로 들어옵니다. 팀원 MCP(/mcp)는 팀 만들기나 초대 코드로 켤 때 열립니다."),
    )),
    h("div", { class: "form-grid", style: { marginTop: "14px" } },
      h("label", { class: "field wide" }, h("span", {}, "공개 주소"), address, h("small", {}, "Cloudflare에서 정한 Public hostname을 https://와 함께 넣습니다.")),
      h("label", { class: "field wide" }, h("span", {}, "Tunnel token"), token, h("small", {}, "이 컴퓨터에만 저장되고, 화면이나 기록에 다시 나오지 않습니다.")),
    ),
    h("div", { class: "form-actions" },
      button("열기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
        const publicUrl = address.value.trim();
        if (!/^https:\/\/[^/?#]+\/?$/.test(publicUrl)) throw new Error("공개 주소는 https://로 시작하는 주소만 넣습니다. 뒤에 경로는 붙이지 않습니다.");
        if (!token.value.trim() && !share.tunnel?.tokenSaved) throw new Error("Cloudflare에서 복사한 Tunnel token을 넣으세요.");
        const body = { publicUrl: publicUrl.replace(/\/$/, "") };
        if (token.value.trim()) body.tunnelToken = token.value.trim();
        await cli("/api/server/share/enable", body);
        token.value = "";
        await redraw(true);
      }, { done: "열었습니다" }) }),
    ),
  );
}
