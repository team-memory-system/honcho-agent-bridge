// One subscription account logged in to the gateway, as a panel any screen can
// show: the gateway starts the CLI's own sign-in, the panel shows its link, and
// takes back Claude's code or the address Codex's browser stopped at when the
// browser is on another computer. It asks the gateway every few seconds and
// connects the router once the account is in (lib/accounts.js has the rules).
import { gateway } from "./api.js";
import { backendName, loginEnded, loginPanelText, loginPrompt, loginSubmission, signInLink } from "./accounts.js";
import { h, copyText } from "./dom.js";
import { button, spinner, toast } from "./ui.js";

const LOGIN_WAIT_MS = 5 * 60_000;
const POLL_MS = 3_000;

/**
 * Logs in `accountId` (an account already added), or adds one for `backend` first.
 * `done` resolves true once the gateway says it is logged in and connected, false
 * when it was cancelled or gave up after five minutes.
 */
export function gatewayLogin({ backend, accountId = null, prompt: given = null, label }) {
  const intro = h("div", { class: "hint", style: { marginTop: "2px" } });
  const linkNote = h("div", { class: "hint" });
  const link = h("a", { class: "mono", target: "_blank", rel: "noopener noreferrer", style: { wordBreak: "break-all", fontSize: "12.5px" } });
  let url = null;
  const copy = button("", { kind: "small icon-only quiet", iconName: "copy", title: "링크 복사", onClick: async () => {
    if (!url) return;
    await copyText(url);
    toast("링크를 복사했습니다");
  } });
  const boxNote = h("div", { class: "hint" });
  const boxLabel = h("span", {});
  const input = h("input", { class: "input", autocomplete: "off", spellcheck: "false" });
  const send = button("보내기", { kind: "primary small", type: "submit" });
  const form = h("form", { style: { display: "flex", gap: "8px", alignItems: "flex-end", marginTop: "6px" } },
    h("label", { class: "fld", style: { flex: "1", minWidth: "0", marginTop: "0" } }, boxLabel, input), send);
  const status = h("div", { class: "hint", role: "status" });
  const turning = spinner();
  const cancel = button("취소", { kind: "small quiet" });
  const root = h("div", { class: "subfields", style: { display: "flex", gap: "12px", alignItems: "flex-start", margin: "10px 0 0" } },
    turning,
    h("div", { style: { flex: "1", minWidth: "0" } },
      h("b", {}, label || `${backendName(backend)} 로그인을 기다리는 중`),
      intro, linkNote, h("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "2px" } }, link, copy),
      boxNote, form, status),
    cancel);

  let kind;
  let text = null;
  let since = Date.now();
  let timer = null;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const say = (message, bad = false) => {
    status.textContent = message;
    status.style.color = bad ? "var(--bad)" : "";
  };
  const stop = (result) => {
    clearInterval(timer);
    timer = null;
    turning.style.visibility = "hidden";
    finish(result);
  };
  // Why the login stopped, kept apart from what to press: a screen that drops the
  // panel when it fails says the reason with its own button.
  let reason = "";
  const fail = (why, next = "") => {
    reason = why;
    say(next ? `${why} ${next}` : why, true);
    stop(false);
  };

  function show(prompt) {
    if (!prompt) {
      intro.textContent = "브라우저에 열린 로그인 창에서 계정을 고르고 허용하세요. 끝나면 이 창이 알아서 이어 갑니다.";
      form.style.display = "none";
      copy.style.display = "none";
      return;
    }
    const next = signInLink(prompt.url);
    if (next && next !== url) {
      url = next;
      link.href = next;
      link.textContent = next;
    }
    if (!url) link.textContent = "로그인 링크를 기다리는 중입니다…";
    copy.style.display = url ? "" : "none";
    // The box is chosen once: a poll that finds the CLI gone must not take it away mid-typing.
    if (kind === undefined) kind = loginPanelText(prompt.input).kind;
    text = loginPanelText(kind, url || prompt.url);
    intro.textContent = text.intro;
    linkNote.textContent = text.linkNote;
    boxNote.textContent = text.boxNote || "";
    boxNote.hidden = !kind;
    form.style.display = kind ? "flex" : "none";
    if (kind) {
      boxLabel.textContent = text.label;
      input.placeholder = text.placeholder;
    }
    const ended = loginEnded(prompt);
    if (ended) say(ended, true);
  }

  async function poll() {
    if (Date.now() - since > LOGIN_WAIT_MS) {
      await gateway.post("/login/cancel", { account: accountId }).catch(() => {});
      fail("로그인을 5분 동안 기다렸지만 끝나지 않았습니다.", "다시 하세요.");
      return;
    }
    try {
      const report = await gateway.status();
      const account = (report.accounts || []).find((item) => item.id === accountId);
      if (account?.login?.loggedIn) {
        const connected = await gateway.post("/connect", {}).catch((error) => ({ ok: false, error: error.message }));
        if (connected.ok === false) {
          fail(`로그인은 됐지만 연결하지 못했습니다: ${connected.error || ""}`);
          return;
        }
        say(`${account.login.account || backendName(backend)} 로그인을 마쳤습니다.`);
        stop(true);
        return;
      }
      if (account?.pendingLogin) show(loginPrompt(account.pendingLogin));
    } catch {}
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submission = loginSubmission(kind, accountId, input.value);
    if (!submission || send.disabled) return;
    send.disabled = true;
    try {
      const result = await gateway.post(submission.path, submission.body);
      if (result?.ok === false) throw new Error(result.error || "보내지 못했습니다.");
      input.value = "";
      say(text?.sent || "보냈습니다.");
      // Exchanging the code takes a moment; the five minutes start again from here.
      since = Date.now();
    } catch (error) {
      say(error?.message || "보내지 못했습니다.", true);
    } finally {
      send.disabled = false;
    }
  });
  cancel.addEventListener("click", async () => {
    if (cancel.disabled) return;
    cancel.disabled = true;
    await gateway.post("/login/cancel", { account: accountId }).catch(() => {});
    reason = "로그인을 그만두었습니다.";
    say(reason);
    stop(false);
  });

  (async () => {
    try {
      let prompt = given;
      if (!accountId) {
        const added = await gateway.post("/accounts/add", { backend });
        if (!added.ok) throw new Error(added.error || "계정을 더하지 못했습니다.");
        accountId = added.account.id;
        prompt = added.login?.prompt;
      } else if (!prompt) {
        const started = await gateway.post("/login", { account: accountId });
        if (started.ok === false) throw new Error(started.error || "로그인을 시작하지 못했습니다.");
        prompt = started.prompt;
      }
      show(loginPrompt(prompt));
      timer = setInterval(poll, POLL_MS);
    } catch (error) {
      fail(error?.message || String(error));
    }
  })();

  // The account added here, so trying again logs the same one in rather than adding another.
  return { root, done, cancel: () => cancel.click(), account: () => accountId, reason: () => reason };
}
