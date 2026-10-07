// The team as this app sees it: the Google login, the hub's people and servers,
// requests between members, and a teammate's memory in Claude Code and Codex.
//
// Logging in opens Google in the browser through the team's Cloudflare Access; the
// browser comes back to this app (team-app.mjs) and the page only waits for the
// login to show up. Everything else is a POST to the app's /api/team/* routes,
// which carry this computer's team login to the hub and the gates. A teammate's
// memory is a remote MCP server (team-<name>) in Claude Code and Codex at
// https://<host>/mcp; each agent logs in to it by itself, so no token passes
// through the page.
import { get, post } from "./api.js";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

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

/** A team route's answer; one that did not succeed throws with its words and code. */
export async function teamCall(path, body = {}) {
  const result = await post(path, body);
  if (result && result.ok === false) {
    const error = new Error(result.error || "팀에 닿지 못했습니다.");
    error.code = result.code || null;
    error.status = result.status || null;
    throw error;
  }
  return result;
}

export function teamStatus() {
  return get("/api/team/status");
}

/**
 * A browser login to the hub (`kind: "hub"`, with `hub`) or to the team's servers
 * (with a server's `host`). `tab` is a window opened in the click that asked, so the
 * browser does not block it. Resolves once the login shows up, rejects when
 * `signal` aborts or ten minutes pass. `reopen()` opens the login address again.
 */
export function teamLogin({ kind, hub, host, tab = null, signal }) {
  let address = null;
  const reopen = () => { if (address) window.open(address, "_blank", "noopener"); };
  const done = (async () => {
    const before = await teamStatus().catch(() => null);
    const key = kind === "servers" ? "serversLogin" : "hubLogin";
    const previous = before?.[key]?.loggedInAt || null;
    const started = await teamCall("/api/team/login", { kind, hub, host });
    address = started.url;
    if (tab && !tab.closed) tab.location.href = address;
    else window.open(address, "_blank", "noopener");
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const now = await teamStatus().catch(() => null);
      const login = now?.[key];
      if (login?.signedIn && login.loggedInAt && login.loggedInAt !== previous) return now;
    }
    throw new Error("로그인을 10분 동안 기다렸습니다. 다시 로그인을 누르세요.");
  })();
  // Where the login went: its issuer is the team's Access, whose logout lets Google ask again.
  const issuer = () => { try { return address ? new URL(address).origin : ""; } catch { return ""; } };
  return { done, reopen, issuer };
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
