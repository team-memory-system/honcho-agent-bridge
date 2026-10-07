// The team as this app sees it: the Google login, the hub's people and servers,
// requests between members, and a teammate's memory in Claude Code and Codex.
//
// Logging in opens Google in the browser through the team's Cloudflare Access; the
// browser comes back to this app (team-app.mjs) and the page only waits for the
// login to show up, or for the app to say it failed. Everything else is a POST to
// the app's /api/team/* routes, which carry this computer's team login to the hub
// and the gates. A login Access stopped refreshing is remembered as ended, and the
// screens that need it say so with 다시 로그인. A teammate's memory is a remote MCP
// server (team-<name>) in Claude Code and Codex at https://<host>/mcp; each agent
// logs in to it by itself, so no token passes through the page.
import { get, post } from "./api.js";
import { bellSource, refreshBell } from "./bell.js";
import { h } from "./dom.js";
import { listItem } from "./kit.js";
import { app, loadContext } from "./state.js";
import { button, busy, errorNotice, notice } from "./ui.js";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const WAIT_MS = 10 * 60_000;
const POLL_MS = 1500;
// A page cannot see another site's page finish loading, so each logout gets this long.
const LOGOUT_PAUSE_MS = 2500;
/** Where a browser adds another Google account: with only one, Google picks it without asking. */
export const GOOGLE_ADD_ACCOUNT = "https://accounts.google.com/AddSession";

/** A team address as typed: a host, or an https address. The server checks it again. */
export function teamHostOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" || url.port || url.username || url.search || url.hash) return "";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return host.includes(".") ? host : "";
  } catch {
    return "";
  }
}

/**
 * A team route's answer; one that did not succeed throws with its words and code. A
 * login to do again (`login_needed`) says so in this app's words, with the login it
 * is about (`kind`, `host`) for 다시 로그인.
 */
export async function teamCall(path, body = {}) {
  const result = await post(path, body);
  if (result && result.ok === false) {
    const needed = result.code === "login_needed";
    const error = new Error(needed ? loginEndedText({ kind: result.kind }) : result.error || "팀에 닿지 못했습니다.");
    error.code = result.code || null;
    error.status = result.status || null;
    error.kind = result.kind || null;
    error.host = result.host || null;
    throw error;
  }
  return result;
}

export function teamStatus() {
  return get("/api/team/status");
}

/** A blank tab opened in the click that asked, for the login to go to (a later one is blocked). */
export function loginTab(message) {
  const tab = window.open("", "_blank");
  try {
    tab?.document.write(`<!doctype html><meta charset="utf-8"><title>팀 메모리</title><p style="font:15px system-ui,sans-serif;color:#57534b;margin:40px">${message}</p>`);
  } catch {}
  return tab;
}

/** Why the browser login the page waited for failed, from the status's `failed`. */
export function loginFailedText(failure) {
  const detail = failure?.detail ? ` (${failure.detail})` : "";
  return failure?.error === "refused"
    ? `로그인이 거절됐습니다${detail}. 다시 로그인을 누르세요.`
    : `로그인을 마치지 못했습니다${detail}. 다시 로그인을 누르세요.`;
}

/**
 * A browser login to the hub (`kind: "hub"`, with `hub`) or to the team's servers
 * (with a server's `host`). `tab` is a window opened in the click that asked, so the
 * browser does not block it. Resolves once the login shows up; rejects as soon as
 * the browser came back with an error for it, when `signal` aborts, or after ten
 * minutes. `reopen()`, in a click, starts a new login in a new window and the wait
 * follows that one: an address something already came back for never works again.
 * `logouts()` are the addresses that sign the browser out of Access.
 */
export function teamLogin({ kind, hub, host, tab = null, signal }) {
  const key = kind === "servers" ? "serversLogin" : "hubLogin";
  let started = null;
  let problem = null;
  let deadline = Date.now() + WAIT_MS;
  const open = async (target) => {
    const next = await teamCall("/api/team/login", { kind, hub, host });
    started = next;
    deadline = Date.now() + WAIT_MS;
    if (target && !target.closed) target.location.href = next.url;
    else window.open(next.url, "_blank", "noopener");
  };
  const reopen = () => {
    const target = loginTab("Google 로그인으로 넘어가는 중입니다…");
    open(target).catch((error) => { problem = error; target?.close(); });
  };
  const done = (async () => {
    const before = await teamStatus().catch(() => null);
    const previous = before?.[key]?.loggedInAt || null;
    await open(tab);
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      if (problem) throw problem;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const now = await teamStatus().catch(() => null);
      const login = now?.[key];
      if (login?.signedIn && login.loggedInAt && login.loggedInAt !== previous) return now;
      // Only the login waited for now: one reopen() replaced may fail without harm.
      const failed = (now?.failed || []).find((item) => started?.id && item.id === started.id);
      if (failed) throw new Error(loginFailedText(failed));
    }
    throw new Error("로그인을 10분 동안 기다렸습니다. 다시 로그인을 누르세요.");
  })();
  return { done, reopen, logouts: () => started?.logouts || [] };
}

/**
 * Before logging in as someone else: this computer forgets its team login, and `tab`
 * (opened in the click) signs the browser out of Access at each of `logouts`, the
 * application's own domain and the team domain, one after the other. Google still
 * picks the only account a browser is signed in to (GOOGLE_ADD_ACCOUNT adds one).
 */
export async function switchAccount(tab, logouts, { pause = LOGOUT_PAUSE_MS } = {}) {
  await teamCall("/api/team/logout", {}).catch(() => null);
  for (const address of logouts || []) {
    if (!tab || tab.closed) break;
    tab.location.href = address;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

/**
 * In a team and set up: logged in, or its login ended and waits for 다시 로그인 (the
 * computer stays set up, so the full setup does not open again), and first setup ran
 * to its end in this browser (`mode`).
 */
export function joinedTeam(team, mode) {
  return Boolean(team?.hub && (team.signedIn || team.loginEnded) && mode);
}

/** After 다른 계정으로 로그인: the hub saw the same email again, so Google chose the same account. */
export function sameAccountAgain(previous, email) {
  return Boolean(previous) && String(previous).toLowerCase() === String(email || "").toLowerCase();
}

/** The logins that ended without a sign-out (Access stopped refreshing them), from the status. */
export function endedLogins(status) {
  return ["hub", "servers"].flatMap((kind) => {
    const login = status?.[`${kind}Login`];
    return login?.ended && !login.signedIn ? [{ kind, email: login.ended.email || "", host: login.ended.host || "", at: login.ended.at || null }] : [];
  });
}

/**
 * The logins the bell offers again: those that ended, and the one a request was
 * refused for (`refused`, a login_needed error) though it still refreshes.
 */
export function loginsToRedo(status, refused = null) {
  const logins = endedLogins(status);
  const kind = refused?.code === "login_needed" ? refused.kind || "hub" : null;
  if (kind && !logins.some((item) => item.kind === kind)) logins.push({ kind, email: "", host: refused.host || "", at: null });
  return logins;
}

/** A team login that ended, in a sentence. */
export function loginEndedText({ kind, email } = {}) {
  const what = kind === "servers" ? "팀 서버 로그인" : "팀 로그인";
  return `${email ? `${email} 계정의 ` : ""}${what}이 끝났습니다. 다시 로그인하세요.`;
}

/**
 * The browser login again for a login that ended (`kind`; for the servers, a
 * server's `host`), then, after the hub's, who the hub says this is now.
 */
export async function relogin({ kind = "hub", host = "", tab = null } = {}) {
  const status = await teamStatus().catch(() => null);
  const hub = status?.hub || app.context?.team?.hub || "";
  const server = host || status?.serversLogin?.ended?.host || status?.serversLogin?.host || "";
  if (kind === "servers" && !server) throw new Error("다시 로그인할 서버 주소를 찾지 못했습니다.");
  await teamLogin({ kind, hub, host: server, tab }).done;
  if (kind !== "servers") await teamMe(hub);
}

/** 다시 로그인: the same browser login for the login that ended, then the screen again. */
function reloginButton({ kind, host, onDone }) {
  return button("다시 로그인", { kind: "primary small", onClick: (event) => {
    const tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
    busy(event.currentTarget, async () => {
      await relogin({ kind, host, tab });
      await loadContext();
      refreshBell();
      await onDone?.();
    });
  } });
}

/** A login that ended, said plainly, with 다시 로그인; `onDone` draws the screen again. */
export function loginNotice({ kind = "hub", host = "", email = "", onDone } = {}) {
  return notice("warn", h("b", {}, loginEndedText({ kind, email })), h("div", { style: { marginTop: "8px" } }, reloginButton({ kind, host, onDone })));
}

/** A failed team call on a screen: a login to do again gets 다시 로그인, anything else its words. */
export function teamErrorNotice(error, { onDone } = {}) {
  return error?.code === "login_needed" ? loginNotice({ kind: error.kind || "hub", host: error.host || "", onDone }) : errorNotice(error);
}

/**
 * Puts a team login to do again on the bell, once: one that ended, or one `refused()`
 * resolves (the requests' login_needed). After 다시 로그인 there, `onDone` shows the
 * page again.
 */
let watching = false;
export function watchTeamLogin({ onDone, refused } = {}) {
  if (watching) return;
  watching = true;
  bellSource(async () => {
    if (!app.context?.team?.hub) return [];
    const [status, error] = await Promise.all([teamStatus().catch(() => null), Promise.resolve(refused?.()).catch(() => null)]);
    return loginsToRedo(status, error).map((item) => listItem({
      title: item.kind === "servers" ? "팀 서버 로그인" : "팀 로그인",
      sub: loginEndedText(item),
      end: reloginButton({ ...item, onDone }),
    }));
  });
}

/** Who the hub says this is, after the hub login; a member gets a peer name the first time. */
export function teamMe(hub) {
  return teamCall("/api/team/me", { hub });
}

export function teamDirectory() {
  return teamCall("/api/team/directory", {});
}

export function teamRequests() {
  return teamCall("/api/team/requests", {});
}

/** Asks a member's server for chat, or (a company server) to collect into it with `folders`. */
export function sendRequest({ kind, server, folders }) {
  return teamCall("/api/team/request", { kind, server, ...(folders ? { folders } : {}) });
}

/**
 * This computer registers with a team server it writes to, after a login to the
 * team's servers when it has none yet.
 */
export async function registerWith(host, { tab = null } = {}) {
  const status = await teamStatus().catch(() => null);
  if (!status?.serversLogin?.signedIn) await teamLogin({ kind: "servers", host, tab }).done;
  try {
    return await teamCall("/api/team/register", { host });
  } catch (error) {
    // A login the gate no longer takes: once more, then give up.
    if (error.code !== "login_needed") throw error;
    await teamLogin({ kind: "servers", host }).done;
    return teamCall("/api/team/register", { host });
  }
}

/** The short name a member's server goes by in Claude Code and Codex: their peer, made safe. */
export function mateName(person) {
  const name = String(person?.peer || person?.email?.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return NAME.test(name) ? name : "";
}

/** Puts a teammate's memory into Claude Code and Codex. Resolves the CLI's answer, ok or not. */
export function connectTeammate({ name, host }) {
  return post("/api/teammates/connect", { name, address: host });
}

const CLIENTS = { claude: "Claude Code", codex: "Codex" };
const CLIENT_ACTIONS = {
  added: "넣었습니다",
  replaced: "새 주소로 바꿔 넣었습니다",
  unchanged: "이미 들어 있습니다",
  removed: "뺐습니다",
  absent: "들어 있지 않았습니다",
};

/** What `teammates connect|disconnect` did in each agent, one short line each. */
export function clientOutcome(result) {
  return Object.entries(CLIENTS).map(([key, label]) => {
    const item = result?.clients?.[key];
    if (!item) return null;
    const text = item.ok ? CLIENT_ACTIONS[item.action] || "됐습니다"
      : item.missing ? "이 컴퓨터에 없어 건너뛰었습니다"
        : `하지 못했습니다: ${item.error || "알 수 없는 오류"}`;
    return `${label}: ${text}`;
  }).filter(Boolean);
}

/** "방금", "3분 전", "2시간 전", "어제" or the date, for a time a row names. */
export function ago(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  if (hours < 48) return "어제";
  const date = new Date(at);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
