// The app's team routes (ui.mjs sends /api/team/* and /oauth/callback here).
//
// These are the exception ui.mjs's header mentions: they run in the app's own
// process instead of as CLI subcommands. The browser login comes back to this
// process (the callback), and everything else is a short HTTPS request to the team
// hub or to a gate with this computer's team login (team-auth.mjs), or a change to
// the gate's access.json beside this computer's server (gate-access.mjs), or a read
// of that server's sessions for the projects to open (scope-sync.mjs). What starts
// or stops a server still goes through the CLI.
//
// No route ever returns a token, a device key or the team's Jev key. A route that
// changes something is a JSON POST, as every other route of the app.
import { loadConfig } from "./config.mjs";
import { gateDevices, gateGrants, gateStatePaths, grantChat, grantCollect, revokeDevice, revokePerson } from "./gate-access.mjs";
import { serverProjects } from "./scope-sync.mjs";
import { CALLBACK_PATH, finishLogin, registerDevice, serverWhoami, signOut, startLogin, teamAuthPaths, teamHost, teamLoginStatus } from "./team-auth.mjs";
import { computerName, hubCall, madeTeam, teamWhoami } from "./team-hub.mjs";

/** The routes that only read, so a GET may ask them. */
export const TEAM_READ_ROUTES = new Set(["/api/team/status"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function projectsFrom(value) {
  return list(value)
    .filter((item) => item && /^p-[0-9a-f]{12}$/.test(String(item.id)))
    .map((item) => ({ id: item.id, name: String(item.name || item.id).slice(0, 120) }));
}

async function context() {
  const config = await loadConfig().catch(() => null);
  return { config, paths: teamAuthPaths(config), gate: gateStatePaths(config ? { serverDirectory: config.paths?.serverDir } : {}) };
}

/** The hub's answer about the Jev key, cut to what the page may see. */
function jevStatus(answer) {
  return { set: Boolean(answer?.set), setAt: answer?.setAt ?? null, setBy: answer?.setBy ?? null };
}

/** Where the browser comes back to: this app's own address, as the request reached it. */
function redirectUri(req) {
  return `http://${req.headers.host}${CALLBACK_PATH}`;
}

/** Owner side: what is opened to whom, and the computers that write here. */
async function ownerView(gate) {
  const [grants, devices] = await Promise.all([gateGrants(gate), gateDevices(gate)]);
  return { grants, devices };
}

const ROUTES = {
  /**
   * Who this computer is signed in as, a login that ended, the browser logins that
   * failed (by id), and the team made here. Never a token.
   */
  "/api/team/status": async () => {
    const { paths } = await context();
    return { ok: true, ...(await teamLoginStatus({ paths })), made: await madeTeam() };
  },

  /**
   * Starts a browser login: to the hub (`kind: "hub"`, with `hub`), or to the servers
   * (with a server's `host`). A new state each time, with the id the page waits on
   * and the two addresses that sign the browser out of Access.
   */
  "/api/team/login": async (body, req) => {
    const { paths } = await context();
    const kind = body.kind === "servers" ? "servers" : "hub";
    const host = teamHost(kind === "hub" ? body.hub : body.host);
    if (!host) return { ok: false, error: kind === "hub" ? "팀 주소를 확인하세요." : "서버 주소를 확인하세요." };
    const started = await startLogin({ host, kind, redirectUri: redirectUri(req), paths });
    return { ok: true, url: started.url, id: started.id, logouts: started.logouts, kind, host };
  },

  /** After the hub login: who the hub says this is (and a peer name the first time). */
  "/api/team/me": async (body) => {
    const { config, paths } = await context();
    const me = await teamWhoami({ hub: body.hub, peer: config?.user?.peerId || "", paths });
    return { ok: true, ...me };
  },

  "/api/team/directory": async () => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("GET", "/api/team", undefined, { paths })) };
  },

  /** Requests to and from this person, from the hub, with this server's own grants and computers. */
  "/api/team/requests": async () => {
    const { paths, gate } = await context();
    const requests = await hubCall("GET", "/api/requests", undefined, { paths });
    return { ok: true, ...requests, ...(await ownerView(gate)) };
  },

  "/api/team/request": async (body) => {
    const { paths } = await context();
    const kind = body.kind === "collect" ? "collect" : "chat";
    const answer = await hubCall("POST", "/api/requests", {
      kind,
      server: teamHost(body.server),
      device: computerName(),
      ...(kind === "collect" ? { folders: list(body.folders).map(String).slice(0, 50) } : {}),
    }, { paths });
    return { ok: true, request: answer.request || answer };
  },

  /**
   * The owner answers a request. An approval opens the server first (access.json),
   * then tells the hub, so the requester never sees "approved" before it works.
   */
  "/api/team/decide": async (body) => {
    const { paths, gate } = await context();
    const id = String(body.id || "");
    if (!/^r-[0-9a-f]{16}$/.test(id)) return { ok: false, error: "요청을 찾을 수 없습니다." };
    if (body.approve) {
      const email = String(body.email || "");
      const peer = String(body.peer || "");
      if (body.kind === "collect") {
        const config = await loadConfig().catch(() => null);
        await grantCollect(gate, { email, peer, workspace: config?.honcho?.workspaceId || "memory" });
      } else {
        await grantChat(gate, { email, peer, projects: projectsFrom(body.projects) });
      }
    }
    const projects = projectsFrom(body.projects).map((item) => item.name);
    const answer = await hubCall("POST", `/api/requests/${id}/decide`, { approve: Boolean(body.approve), ...(body.approve && body.kind !== "collect" ? { projects } : {}) }, { paths });
    return { ok: true, request: answer.request || answer };
  },

  "/api/team/cancel": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("POST", `/api/requests/${encodeURIComponent(String(body.id || ""))}/cancel`, {}, { paths })) };
  },

  "/api/team/dismiss": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("POST", `/api/requests/${encodeURIComponent(String(body.id || ""))}/dismiss`, {}, { paths })) };
  },

  /**
   * The projects this server holds conversations of, for the window that opens them
   * to a teammate (scope-sync.mjs); `keep`, what is open to them now, stays listed.
   * A server that cannot be read says so instead of listing nothing.
   */
  "/api/team/projects": async (body) => {
    const { config } = await context();
    try {
      return await serverProjects({ config, keep: projectsFrom(body.keep) });
    } catch (error) {
      const reason = error?.cause?.code || /^HTTP \d+/.exec(String(error?.message))?.[0] || String(error?.message || error);
      return { ok: false, error: `기억 서버에서 프로젝트를 읽지 못했습니다 (${reason}).` };
    }
  },

  /** The owner changes the projects open to a teammate (`projects`), or closes chat (`close: true`). */
  "/api/team/grant": async (body) => {
    const { paths, gate } = await context();
    const email = String(body.email || "");
    const request = String(body.request || "");
    if (body.close) {
      await revokePerson(gate, { email, kind: "chat" });
      if (/^r-[0-9a-f]{16}$/.test(request)) await hubCall("POST", `/api/requests/${request}/revoke`, {}, { paths }).catch(() => null);
      return { ok: true, closed: true };
    }
    const projects = projectsFrom(body.projects);
    await grantChat(gate, { email, peer: String(body.peer || ""), projects });
    if (/^r-[0-9a-f]{16}$/.test(request)) {
      await hubCall("POST", `/api/requests/${request}/projects`, { projects: projects.map((item) => item.name) }, { paths }).catch(() => null);
    }
    return { ok: true, projects };
  },

  /** The owner stops a teammate's computers collecting into this server. */
  "/api/team/stop-collect": async (body) => {
    const { paths, gate } = await context();
    await revokePerson(gate, { email: String(body.email || ""), kind: "collect" });
    const request = String(body.request || "");
    if (/^r-[0-9a-f]{16}$/.test(request)) await hubCall("POST", `/api/requests/${request}/revoke`, {}, { paths }).catch(() => null);
    return { ok: true };
  },

  /** The computers that write to this server, and cutting one off (`revoke: <id>`). */
  "/api/team/devices": async (body) => {
    const { gate } = await context();
    if (body.revoke) await revokeDevice(gate, { id: String(body.revoke) });
    return { ok: true, devices: await gateDevices(gate) };
  },

  /** This computer registers with a team server it writes to (its own on another computer, or one that approved it). */
  "/api/team/register": async (body) => {
    const { paths } = await context();
    const host = teamHost(body.host);
    if (!host) return { ok: false, error: "서버 주소를 확인하세요." };
    return registerDevice(host, { name: computerName(), paths });
  },

  "/api/team/server": async (body) => {
    const { paths } = await context();
    const host = teamHost(body.host);
    if (!host) return { ok: false, error: "서버 주소를 확인하세요." };
    return { ok: true, ...(await serverWhoami(host, { paths })) };
  },

  "/api/team/admin/people": async () => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("GET", "/api/admin/people", undefined, { paths })) };
  },

  "/api/team/admin/add": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("POST", "/api/admin/people", { email: String(body.email || "") }, { paths })) };
  },

  "/api/team/admin/remove": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("DELETE", `/api/admin/people/${encodeURIComponent(String(body.email || ""))}`, undefined, { paths })) };
  },

  "/api/team/admin/rename": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("PUT", "/api/admin/team", { name: String(body.name || "") }, { paths })) };
  },

  /** Whether the team's hub keeps a Jev key: set, when, by whom. Never the key. */
  "/api/team/admin/jev": async () => {
    const { paths } = await context();
    return { ok: true, jev: jevStatus(await hubCall("GET", "/api/admin/jev", undefined, { paths })) };
  },

  /** Sets or replaces the team's Jev key (`key`); it goes to the hub and is not kept here. */
  "/api/team/admin/jev/set": async (body) => {
    const { paths } = await context();
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) return { ok: false, error: "Jev 키를 넣으세요." };
    return { ok: true, jev: jevStatus(await hubCall("PUT", "/api/admin/jev", { key }, { paths })) };
  },

  "/api/team/admin/jev/clear": async () => {
    const { paths } = await context();
    return { ok: true, jev: jevStatus(await hubCall("DELETE", "/api/admin/jev", undefined, { paths })) };
  },

  "/api/team/logout": async () => {
    const { paths } = await context();
    return signOut({ paths });
  },
};

/** The page the browser shows when the login comes back here. */
function loginPage(ok, message) {
  const title = ok ? "로그인됐습니다" : "로그인하지 못했습니다";
  const text = ok ? "이 창을 닫고 팀 메모리 앱으로 돌아가세요." : message;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf8f4;color:#1d1c19;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}
main{max-width:420px;padding:28px 32px;border:1px solid #e3dfd6;border-radius:14px;background:#fff}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#57534b;line-height:1.6}</style></head>
<body><main><h1>${title}</h1><p>${text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c])}</p></main>
${ok ? "<script>setTimeout(() => window.close(), 1500)</script>" : ""}</body></html>`;
}

/** GET /oauth/callback: finishes the login this app started (an unknown state does nothing). */
export async function handleLoginCallback(url, res) {
  const { paths } = await context();
  let ok = false;
  let message = "";
  try {
    await finishLogin({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
      paths,
    });
    ok = true;
  } catch (error) {
    message = String(error?.message || error);
  }
  const html = loginPage(ok, message);
  res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

/** One /api/team/* route, or null when there is none of that name. */
export function teamRoute(pathname) {
  return ROUTES[pathname] || null;
}

/**
 * Runs a route; any failure comes back as { ok: false, error } with the hub's or
 * gate's own code, and for a login to do again, which one (`kind`, `host`).
 */
export async function runTeamRoute(route, body, req) {
  try {
    return await route(body, req);
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.status ? { status: error.status } : {}),
      ...(error?.kind ? { kind: error.kind } : {}),
      ...(error?.code === "login_needed" && error?.host ? { host: error.host } : {}),
    };
  }
}

