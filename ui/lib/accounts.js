// The gateway's accounts and models, sorted the way the gateway uses them. A
// model belongs to one backend, and the gateway moves an account only past its
// neighbour of the same backend (subscription-gateway, gateway/accounts.mjs
// moveAccount), so order means something only inside a backend: in drain mode
// the first account is used until its limit, then the next. No DOM here, so a
// node test can check it.

const BACKEND_ORDER = ["codex", "claude"];

export function backendName(backend) {
  if (backend === "codex") return "Codex";
  if (backend === "claude") return "Claude";
  return backend || "기타";
}

// Codex, then Claude, then anything else in the order it first appeared.
function byBackend(entries) {
  const rank = (backend) => {
    const index = BACKEND_ORDER.indexOf(backend);
    return index < 0 ? BACKEND_ORDER.length : index;
  };
  return [...entries].sort(([a], [b]) => rank(a) - rank(b));
}

/**
 * Accounts grouped by backend, each group in the gateway's order. An account can
 * move up or down only inside a group of two or more, and never past its edge.
 */
export function accountGroups(accounts) {
  const groups = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account?.id) continue;
    const backend = account.backend || "";
    if (!groups.has(backend)) groups.set(backend, []);
    groups.get(backend).push(account);
  }
  return byBackend(groups).map(([backend, list]) => ({
    backend,
    label: backendName(backend),
    ordered: list.length > 1,
    accounts: list.map((account, index) => ({
      account,
      position: index + 1,
      canMoveUp: index > 0,
      canMoveDown: index < list.length - 1,
    })),
  }));
}

/** The groups where drain or balance changes anything: two or more accounts. */
export function sharedGroups(groups) {
  return (groups || []).filter((group) => group.ordered);
}

/** Model ids by the backend of the account that offers them, each id once. */
export function modelGroups(models, accounts) {
  const owners = new Map((Array.isArray(accounts) ? accounts : []).filter((account) => account?.id).map((account) => [account.id, account.backend]));
  const groups = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model === "string" ? model : model?.id;
    if (!id) continue;
    const backend = owners.get(model?.ownedBy) || model?.ownedBy || "";
    if (!groups.has(backend)) groups.set(backend, new Set());
    groups.get(backend).add(id);
  }
  return byBackend(groups).map(([backend, ids]) => ({ backend, label: backendName(backend), models: [...ids] }));
}

// ── A login the gateway is waiting on ───────────────────────────────────────
//
// The gateway (subscription-gateway ui/server.mjs, createLogins) answers
// POST /api/login and /api/accounts/add with a `prompt`, and puts the same shape
// on each account in /api/status as `pendingLogin`:
//
//   { backend, url, input: "code" | "callback" | null, running, startedAt, exitCode?, message? }
//
// `url` is the CLI's own sign-in link. When the browser is on another computer
// than the gateway, the end of the login comes back by hand: Claude's code
// (POST /api/login/code) or the localhost address Codex's sign-in stopped at
// (POST /api/login/callback). A gateway from before that sends no prompt, and the
// screen keeps its old notice.

const CODEX_CALLBACK_HOST = "localhost:1455";

/** The prompt in a login answer, or null from a gateway that sends none. */
export function loginPrompt(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Only an http(s) address becomes a link. */
export function signInLink(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Where Codex's sign-in sends the browser back to, read from its redirect_uri. */
export function callbackHost(url) {
  try {
    const redirect = new URL(new URL(String(url || "")).searchParams.get("redirect_uri") || "");
    return redirect.protocol === "http:" && redirect.host ? redirect.host : "";
  } catch {
    return "";
  }
}

/** The words of the login panel, and the box it shows: `kind` is "code", "callback" or null. */
export function loginPanelText(input, url) {
  const intro = "브라우저에 열린 로그인 창에서 로그인하세요. 끝나면 이 화면이 알아서 연결합니다.";
  if (input === "code") {
    return {
      kind: "code",
      intro,
      linkNote: "창이 안 열렸으면 이 링크를 여세요.",
      boxNote: "로그인 뒤 코드가 나오면 복사해 붙여 넣으세요.",
      label: "코드",
      placeholder: "로그인 페이지에 나온 코드",
      sent: "코드를 보냈습니다. 확인하는 중입니다…",
    };
  }
  if (input === "callback") {
    const host = callbackHost(url) || CODEX_CALLBACK_HOST;
    return {
      kind: "callback",
      intro,
      linkNote: "창이 안 열렸으면 이 링크를 여세요.",
      boxNote: `로그인 뒤 브라우저가 ${host} 주소에서 멈추면 주소창의 주소를 통째로 붙여 넣으세요.`,
      label: "브라우저가 멈춘 주소",
      placeholder: `http://${host}/auth/callback?code=…`,
      sent: "주소를 보냈습니다. 확인하는 중입니다…",
    };
  }
  // Claude on a Windows gateway: its login cannot take the code back.
  return { kind: null, intro, linkNote: "창이 안 열렸으면 이 링크를 게이트웨이가 있는 컴퓨터의 브라우저에서 여세요." };
}

/** The gateway call that hands back what was typed into the panel's box, or null for nothing to send. */
export function loginSubmission(kind, accountId, value) {
  const text = String(value || "").trim();
  if (!text || !accountId) return null;
  if (kind === "code") return { path: "/login/code", body: { account: accountId, code: text } };
  if (kind === "callback") return { path: "/login/callback", body: { account: accountId, address: text } };
  return null;
}

/** Why a login the gateway held has ended without logging in; "" while it still waits. */
export function loginEnded(prompt) {
  if (!prompt || prompt.running !== false) return "";
  const message = String(prompt.message || "").trim();
  return `로그인이 끝났지만 되지 않았습니다${message ? `: ${message}` : ""}. 로그인을 다시 누르세요.`;
}

/** The first login the gateway is still waiting on, for a screen that did not start it. */
export function pendingLogin(accounts) {
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const prompt = loginPrompt(account?.pendingLogin);
    if (account?.id && prompt?.running === true && !account.login?.loggedIn) {
      return { accountId: account.id, backend: account.backend || prompt.backend || "", prompt };
    }
  }
  return null;
}
