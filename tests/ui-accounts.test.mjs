// The gateway screen groups accounts by backend so its up/down buttons only offer
// moves the gateway actually makes.
import assert from "node:assert/strict";
import test from "node:test";

import {
  accountGroups,
  backendAccounts,
  backendName,
  callbackHost,
  loginEnded,
  loginPanelText,
  loginPrompt,
  loginSubmission,
  modelGroups,
  pendingLogin,
  sharedGroups,
  signInLink,
} from "../ui/lib/accounts.js";

const account = (id, backend) => ({ id, backend });

// The gateway's own rule (subscription-gateway gateway/accounts.mjs moveAccount):
// swap with the neighbour of the same backend, or leave the order alone.
function gatewayMove(accounts, id, direction) {
  const next = [...accounts];
  const index = next.findIndex((entry) => entry.id === id);
  const same = next.map((entry, position) => ({ entry, position })).filter(({ entry }) => entry.backend === next[index].backend);
  const rank = same.findIndex(({ position }) => position === index);
  const neighbour = same[direction === "up" ? rank - 1 : rank + 1];
  if (!neighbour) return next;
  [next[index], next[neighbour.position]] = [next[neighbour.position], next[index]];
  return next;
}

const ids = (list) => list.map((entry) => entry.id).join(",");

function summary(groups) {
  return groups.map((group) => ({
    backend: group.backend,
    ordered: group.ordered,
    accounts: group.accounts.map((entry) => [entry.account.id, entry.position, entry.canMoveUp, entry.canMoveDown]),
  }));
}

test("one Codex and two Claude accounts: only the Claude pair can be reordered", () => {
  const groups = accountGroups([account("codex-1", "codex"), account("claude-1", "claude"), account("claude-2", "claude")]);
  assert.deepEqual(summary(groups), [
    { backend: "codex", ordered: false, accounts: [["codex-1", 1, false, false]] },
    { backend: "claude", ordered: true, accounts: [["claude-1", 1, false, true], ["claude-2", 2, true, false]] },
  ]);
  assert.deepEqual(sharedGroups(groups).map((group) => group.backend), ["claude"]);
});

test("interleaved accounts are grouped Codex first, each group in the gateway's order", () => {
  const groups = accountGroups([
    account("claude-2", "claude"), account("codex-1", "codex"), account("claude-1", "claude"), account("codex-2", "codex"),
  ]);
  assert.deepEqual(summary(groups), [
    { backend: "codex", ordered: true, accounts: [["codex-1", 1, false, true], ["codex-2", 2, true, false]] },
    { backend: "claude", ordered: true, accounts: [["claude-2", 1, false, true], ["claude-1", 2, true, false]] },
  ]);
  assert.deepEqual(sharedGroups(groups).map((group) => group.backend), ["codex", "claude"]);
});

test("a move is offered exactly when the gateway would change the order", () => {
  const layouts = [
    [account("codex-1", "codex"), account("claude-1", "claude"), account("claude-2", "claude")],
    [account("claude-1", "claude"), account("codex-1", "codex"), account("claude-2", "claude"), account("codex-2", "codex"), account("codex-3", "codex")],
    [account("claude-1", "claude")],
  ];
  for (const accounts of layouts) {
    for (const group of accountGroups(accounts)) {
      for (const entry of group.accounts) {
        const id = entry.account.id;
        assert.equal(entry.canMoveUp, ids(gatewayMove(accounts, id, "up")) !== ids(accounts), `${ids(accounts)}: ${id} up`);
        assert.equal(entry.canMoveDown, ids(gatewayMove(accounts, id, "down")) !== ids(accounts), `${ids(accounts)}: ${id} down`);
      }
    }
  }
});

test("no accounts, broken entries and unknown backends", () => {
  assert.deepEqual(accountGroups([]), []);
  assert.deepEqual(accountGroups(undefined), []);
  assert.deepEqual(sharedGroups(accountGroups(null)), []);
  const groups = accountGroups([null, { backend: "codex" }, account("gemini-1", "gemini"), account("codex-1", "codex"), account("odd-1")]);
  assert.deepEqual(groups.map((group) => [group.backend, group.label, group.accounts.length]), [["codex", "Codex", 1], ["gemini", "gemini", 1], ["", "기타", 1]]);
  assert.equal(backendName("claude"), "Claude");
});

test("models are grouped by the backend of the account that offers them", () => {
  const accounts = [account("codex-1", "codex"), account("claude-1", "claude"), account("claude-2", "claude")];
  const models = [
    { id: "claude-opus-5-5", ownedBy: "claude-1" },
    { id: "gpt-5.5", ownedBy: "codex-1" },
    { id: "gpt-6-luna", ownedBy: "codex-1" },
    { id: "claude-sonnet-5", ownedBy: "claude-2" },
    { id: "claude-opus-5-5", ownedBy: "claude-2" },
    { id: "local-1", ownedBy: "ollama" },
    { id: "mystery" },
    { ownedBy: "codex-1" },
  ];
  assert.deepEqual(modelGroups(models, accounts).map((group) => [group.label, group.models]), [
    ["Codex", ["gpt-5.5", "gpt-6-luna"]],
    ["Claude", ["claude-opus-5-5", "claude-sonnet-5"]],
    ["ollama", ["local-1"]],
    ["기타", ["mystery"]],
  ]);
  assert.deepEqual(modelGroups(undefined, undefined), []);
});

// A login whose browser is on another computer than the gateway. The shapes are
// the gateway's own (subscription-gateway ui/server.mjs createLogins and its
// /api/login, /api/login/code, /api/login/callback routes).
const CODEX_SIGN_IN = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=st4te";
const CLAUDE_SIGN_IN = "https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";
const prompt = (backend, input, extra = {}) => ({ backend, url: backend === "codex" ? CODEX_SIGN_IN : CLAUDE_SIGN_IN, input, running: true, startedAt: "2026-10-05T14:00:00.000Z", ...extra });

test("a gateway from before the login panel sends no prompt, and the screen keeps its old notice", () => {
  // POST /api/login and /api/accounts/add from that gateway.
  const login = { ok: true, started: true, accountId: "codex-1", backend: "codex", pid: 4000, logPath: "/x/login-codex-1.log" };
  assert.equal(loginPrompt(login.prompt), null);
  assert.equal(loginPrompt({ ok: true, account: { id: "codex-1" }, login }.login?.prompt), null);
  for (const value of [undefined, null, "", "prompt", [], 3]) assert.equal(loginPrompt(value), null, String(value));
  // Its status has no pendingLogin: nothing to pick up.
  assert.equal(pendingLogin([{ id: "codex-1", backend: "codex", login: { loggedIn: false } }]), null);
  assert.equal(pendingLogin(undefined), null);
});

test("Codex asks for the address its browser stopped at, Claude for its code", () => {
  const codex = loginPanelText("callback", CODEX_SIGN_IN);
  assert.equal(codex.kind, "callback");
  assert.equal(codex.label, "브라우저가 멈춘 주소");
  assert.match(codex.boxNote, /localhost:1455 주소에서 멈추면/);
  assert.equal(codex.placeholder, "http://localhost:1455/auth/callback?code=…");

  const claude = loginPanelText("code", CLAUDE_SIGN_IN);
  assert.equal(claude.kind, "code");
  assert.equal(claude.label, "코드");
  assert.match(claude.boxNote, /코드/);

  // Claude on a Windows gateway takes nothing back: a link and no box.
  const neither = loginPanelText(null, CLAUDE_SIGN_IN);
  assert.equal(neither.kind, null);
  assert.equal(neither.label, undefined);
  assert.match(neither.linkNote, /게이트웨이가 있는 컴퓨터/);

  // The callback's port is the login's own; before the link arrives, Codex's usual one.
  assert.equal(callbackHost(CODEX_SIGN_IN.replace("1455", "1457")), "localhost:1457");
  assert.match(loginPanelText("callback", CODEX_SIGN_IN.replace("1455", "1457")).boxNote, /localhost:1457/);
  assert.match(loginPanelText("callback", null).boxNote, /localhost:1455/);
  assert.equal(callbackHost(CLAUDE_SIGN_IN), "", "Claude's redirect is not a localhost callback");
});

test("only an http(s) sign-in address becomes a link", () => {
  assert.equal(signInLink(CODEX_SIGN_IN), CODEX_SIGN_IN);
  assert.equal(signInLink(CLAUDE_SIGN_IN), CLAUDE_SIGN_IN);
  for (const bad of ["javascript:alert(1)//authorize", "data:text/html,x", "not a url", "", null, undefined]) {
    assert.equal(signInLink(bad), null, String(bad));
  }
});

test("what is typed goes to the gateway route for that login, trimmed", () => {
  assert.deepEqual(loginSubmission("code", "claude-1", "  abc#def \n"), { path: "/login/code", body: { account: "claude-1", code: "abc#def" } });
  const address = "http://localhost:1455/auth/callback?code=ac_1&state=st4te";
  assert.deepEqual(loginSubmission("callback", "codex-1", ` ${address} `), { path: "/login/callback", body: { account: "codex-1", address } });
  assert.equal(loginSubmission("code", "claude-1", "   "), null);
  assert.equal(loginSubmission("callback", "", address), null);
  assert.equal(loginSubmission(null, "claude-1", "abc"), null);
});

test("a login that ended without logging in says why; one still waiting says nothing", () => {
  assert.equal(loginEnded(prompt("claude", "code")), "");
  assert.equal(loginEnded(null), "");
  assert.equal(
    loginEnded(prompt("claude", null, { running: false, exitCode: 1, message: "Login failed: Request failed with status code 400" })),
    "로그인이 끝났지만 되지 않았습니다: Login failed: Request failed with status code 400. 로그인을 다시 누르세요.",
  );
  assert.equal(loginEnded(prompt("codex", null, { running: false, exitCode: "SIGTERM", message: "" })), "로그인이 끝났지만 되지 않았습니다. 로그인을 다시 누르세요.");
});

test("a login the gateway still waits on is picked up; ended, finished and absent ones are not", () => {
  const accounts = [
    { id: "codex-1", backend: "codex", login: { loggedIn: true }, pendingLogin: prompt("codex", "callback") },
    { id: "claude-1", backend: "claude", login: { loggedIn: false }, pendingLogin: prompt("claude", null, { running: false, exitCode: 1 }) },
    { id: "codex-2", backend: "codex", login: { loggedIn: false }, pendingLogin: null },
    { id: "claude-2", backend: "claude", login: { loggedIn: false }, pendingLogin: prompt("claude", "code") },
  ];
  assert.deepEqual(pendingLogin(accounts), { accountId: "claude-2", backend: "claude", prompt: accounts[3].pendingLogin });
  assert.equal(pendingLogin(accounts.slice(0, 3)), null);
});

test("setup's logins count what the gateway already holds: accounts logged in, and slots whose login never finished", () => {
  const accounts = [
    { id: "codex-1", backend: "codex", login: { loggedIn: false } },
    { id: "codex-2", backend: "codex", login: { loggedIn: true, account: "me@example.com" } },
    { id: "claude-1", backend: "claude", login: { loggedIn: true } },
    { id: "codex-3", backend: "codex" },
    { backend: "codex", login: { loggedIn: true } },
  ];
  const codex = backendAccounts(accounts, "codex");
  assert.deepEqual(codex.loggedIn.map((account) => account.id), ["codex-2"]);
  assert.deepEqual(codex.empty, ["codex-1", "codex-3"]);
  assert.deepEqual(backendAccounts(accounts, "claude").empty, []);
  assert.deepEqual(backendAccounts(null, "codex"), { loggedIn: [], empty: [] });
});
