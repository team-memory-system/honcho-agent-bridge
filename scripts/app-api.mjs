// What the Team Memory app needs beyond the CLI.
//
// The app is one screen over three programs: the Honcho server (memories), its
// dashboard container (the audit log and the tools it names), and the subscription
// gateway (accounts and models). Each keeps its own API. This module only knows
// where each one answers on this machine and relays the app's requests there, so
// the browser talks to one origin and never holds a Honcho token itself.
import fsp from "node:fs/promises";
import path from "node:path";

import { collectFolders, installPaths, loadConfig, readJson } from "./config.mjs";
import {
  ACCESS_REFUSED_KO,
  configuredAccess,
  environmentAccess,
  fetchHoncho,
  honchoHeaders,
  isCloudflareAccessBlock,
} from "./honcho-access.mjs";
import { ALL_TOOLS, WRITE_TOOLS } from "./mcp-tool-defaults.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";
import { publicUrl } from "./redact.mjs";
import { installedServerModel, installedServerPorts } from "./server-manager.mjs";
import { configuredTargets, countPending, sentSummary, targetSummary } from "./targets.mjs";
import { readTeamState, registeredTeamServers, teamAccessPaths } from "./team-access.mjs";
import { teamAuthPaths, teamLoginStatus } from "./team-auth.mjs";
import { VERSION } from "./version.mjs";

const DEFAULT_HONCHO_URL = "http://127.0.0.1:8001";
const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4173";
const DEFAULT_GATEWAY_UI_PORT = 11450;
const PROXY_TIMEOUT_MS = 180_000;
const MAX_PROXY_BODY_BYTES = 4 * 1024 * 1024;

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * Where each program answers. An explicit environment value wins (tests, and
 * someone running the pieces by hand); then this install's configuration; then
 * the server this installer put on this machine; then the defaults.
 */
export async function appEndpoints({ env = process.env, config, ports } = {}) {
  const loaded = config === undefined ? await loadConfig() : config;
  const installed = ports === undefined ? await installedServerPorts().catch(() => ({ installed: false })) : ports;
  const localServer = installed?.installed
    ? { apiUrl: `http://127.0.0.1:${installed.api}`, dashboardUrl: `http://127.0.0.1:${installed.dashboard}` }
    : null;
  const gatewayPort = Number.parseInt(String(env.GATEWAY_UI_PORT || ""), 10);
  const honchoUrl = trimSlash(env.HONCHO_BASE_URL || loaded?.honcho?.baseUrl || localServer?.apiUrl || DEFAULT_HONCHO_URL);
  return {
    config: loaded,
    localServer,
    honchoUrl,
    honchoToken: String(env.HONCHO_API_BEARER_TOKEN || loaded?.honcho?.apiToken || ""),
    // The saved service token goes only to the server it was saved for.
    honchoAccess: environmentAccess(env)
      || (sameOrigin(honchoUrl, loaded?.honcho?.baseUrl) ? configuredAccess(loaded) : null),
    dashboardUrl: trimSlash(env.HONCHO_DASHBOARD_URL || localServer?.dashboardUrl || DEFAULT_DASHBOARD_URL),
    gatewayUiUrl: trimSlash(env.GATEWAY_UI_URL
      || `http://127.0.0.1:${Number.isInteger(gatewayPort) && gatewayPort > 0 ? gatewayPort : DEFAULT_GATEWAY_UI_PORT}`),
  };
}

/** What the page needs to know to lay itself out. No secret leaves this function. */
export async function appContext(options = {}) {
  const endpoints = await appEndpoints(options);
  const { config } = endpoints;
  return {
    ok: true,
    version: VERSION,
    // Collecting conversations: a file left by 0.3.28's shared-bridge connection alone does not count.
    configured: Boolean(config?.user?.peerId && config?.honcho?.baseUrl),
    installedAt: config?.installedAt || null,
    user: { peerId: config?.user?.peerId || "" },
    workspace: config?.honcho?.workspaceId || "memory",
    agents: { codex: Boolean(config?.agents?.codex), claude: Boolean(config?.agents?.claude) },
    // The folders the own server takes ({ take, skip, rest }), or null for every folder.
    collect: collectFolders(config),
    honcho: { url: publicUrl(endpoints.honchoUrl), hasToken: Boolean(endpoints.honchoToken), hasAccess: Boolean(endpoints.honchoAccess) },
    localServer: endpoints.localServer ? { ...endpoints.localServer, chatModel: await installedServerModel() } : null,
    dashboardUrl: endpoints.dashboardUrl,
    gatewayUiUrl: endpoints.gatewayUiUrl,
    // Teammates' memory this computer's Claude Code and Codex reach as team-* remote
    // MCP servers, read from those clients' own files; and whether the shared-bridge
    // settings of 0.3.28 (no longer used) are still saved here.
    teamMemory: await teamMemoryContext(options),
    // Whether the team was made on this computer, which makes it the admin's (관리자).
    team: await teamContext({ ...options, config }),
    oldBridge: Boolean(config?.honcho?.mcpBridgeUrl || config?.honcho?.mcpBridgeToken),
    // Other servers that also receive the conversations from chosen folders. Read
    // from files on this computer only (config, spool, state): no request is made.
    targets: await targetsContext(config),
  };
}

/**
 * The team this computer belongs to, from its own files: who the hub said this is
 * when it last logged in (team-auth.json: the team's address, the email, the peer,
 * whether this is an admin) and, on the computer that made the team, what it made
 * (team-access.json: the zone, the admin's email, whether the Cloudflare API token
 * is saved here). Names only; no token is read.
 */
async function teamContext(options = {}) {
  if (options.team !== undefined) return options.team;
  const login = await teamLoginStatus({ paths: options.teamAuthPaths || teamAuthPaths(options.config ?? null) }).catch(() => null);
  let made = null;
  try {
    const paths = teamAccessPaths(options.teamPaths || {});
    const state = await readTeamState(paths);
    if (state?.ownerEmail && state?.peoplePolicyId) {
      const hasApiToken = await fsp.stat(paths.apiTokenFile).then(() => true, () => false);
      made = {
        name: state.teamName || "",
        hub: state.hub?.host || "",
        ownerEmail: state.ownerEmail,
        zone: state.zone || "",
        host: state.owner?.host || "",
        hasApiToken,
        deployedAt: state.hub?.deployedAt || null,
      };
    }
  } catch {}
  // The address this computer's own server has in the team, when it shares through it.
  const share = await readJson(path.join(teamAccessPaths(options.teamPaths || {}).runtimeDir, "share.json"), null);
  return {
    // 관리자: the hub says so, or this computer made the team.
    admin: Boolean(login?.admin || made),
    localHost: share?.team === true && typeof share.host === "string" ? share.host : null,
    hub: login?.hub || made?.hub || null,
    name: login?.team || made?.name || null,
    email: login?.email || null,
    peer: login?.peer || null,
    signedIn: Boolean(login?.hubLogin?.signedIn),
    serversSignedIn: Boolean(login?.serversLogin?.signedIn),
    // A hub login Access stopped refreshing (when, whose, where): still in the team,
    // with 다시 로그인 to do.
    loginEnded: login?.hubLogin?.ended || null,
    made,
    // Kept for screens that ask for these by their old names.
    ownerEmail: made?.ownerEmail || null,
    zone: made?.zone || "",
    host: made?.host || "",
    hasApiToken: Boolean(made?.hasApiToken),
  };
}

async function teamMemoryContext(options = {}) {
  const registered = await registeredTeamServers(options.teamOptions || {}).catch(() => ({ claude: {}, codex: {} }));
  const names = new Set([...Object.keys(registered.claude), ...Object.keys(registered.codex)]);
  // The hosts they reach, so the bell knows which approved chat is connected already.
  const hosts = new Set();
  for (const entry of [...Object.values(registered.claude), ...Object.values(registered.codex)]) {
    try { hosts.add(new URL(entry.url).hostname); } catch {}
  }
  return { connected: names.size, claude: Object.keys(registered.claude).length, codex: Object.keys(registered.codex).length, hosts: [...hosts] };
}

/**
 * This computer's conversations on their way into its own memory server (대화 쌓기),
 * from the spool and state the collector keeps (configEnvironment, main.mjs):
 * `{ pending, sessions, lastSentAt }`, the turns waiting to be sent, the
 * conversations sent so far, and when the last one went. Files only, no request.
 */
export async function collectFlow(config) {
  const { dataDir } = installPaths(config);
  const agents = Object.entries(config?.agents || {}).filter(([, enabled]) => enabled).map(([name]) => name);
  let pending = 0;
  let sessions = 0;
  let lastSentAt = "";
  for (const provider of agents) {
    pending += await countPending(path.join(dataDir, "spool", provider, "pending"));
    const sent = await sentSummary(path.join(dataDir, "state", `${provider}.json`));
    sessions += sent.sessions;
    if (sent.lastAt > lastSentAt) lastSentAt = sent.lastAt;
  }
  return { pending, sessions, lastSentAt: lastSentAt || null };
}

/** The dashboard's flow: the own server's side (collectFlow) and each other server's. */
export async function appFlow(config) {
  if (!config) return { collect: null, targets: [], backfill: null };
  return { collect: await collectFlow(config), targets: await targetsContext(config), backfill: await backfillFlow(config) };
}

/**
 * Past conversations on their way to the own server (`backfill`, cli.mjs): how far a
 * running one has got, or how the last one ended. Read from its status file only.
 */
async function backfillFlow(config) {
  const status = await readJson(path.join(installPaths(config).dataDir, "state", "backfill-status.json"), null);
  if (!status || typeof status !== "object") return null;
  const pid = Number(status.running?.pid);
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); alive = true; } catch (error) { alive = error?.code === "EPERM"; }
  }
  const pick = (run) => (run ? { considered: run.considered ?? 0, examined: run.examined ?? 0, remaining: run.remaining ?? 0, sent: run.sent_sessions ?? 0, failed: run.failed ?? 0, at: run.finishedAt || run.startedAt || null } : null);
  return { running: alive ? pick(status.running) : null, lastRun: pick(status.lastRun) };
}

async function targetsContext(config) {
  const targets = [];
  for (const target of configuredTargets(config)) {
    const summary = await targetSummary(config, target).catch(() => null);
    if (!summary) continue;
    const { id, label, url, folders, enabled, team, hasToken, hasAccess, lastSentAt, pending } = summary;
    targets.push({ id, label, url, folders, enabled, team, hasToken, hasAccess, lastSentAt, pending });
  }
  return targets;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_PROXY_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Relay one request and stream the answer back. Host and Origin are the target's
 * own (fetch sets them from the URL), so each program's loopback checks apply to
 * this server exactly as they would to its own screen.
 *
 * Only the memory server gets `credentials`: its bearer token and its Access
 * service token. The dashboard and the gateway are other programs.
 */
async function relay(req, res, target, { credentials = null, unreachable } = {}) {
  let body;
  try {
    body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { ok: false, error: error.message });
  }
  const base = { accept: req.headers.accept || "application/json" };
  if (body) base["content-type"] = "application/json";
  const headers = credentials ? honchoHeaders(credentials, base) : base;
  let upstream;
  try {
    const init = { method: req.method, headers, body, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) };
    upstream = credentials ? await fetchHoncho(target, init) : await fetch(target, init);
  } catch (error) {
    return sendJson(res, 502, { ok: false, unreachable: true, error: unreachable, detail: String(error?.cause?.code || error?.message || error) });
  }
  if (credentials && await isCloudflareAccessBlock(upstream)) {
    await upstream.arrayBuffer().catch(() => {});
    return sendJson(res, 502, { ok: false, unreachable: false, access: true, error: ACCESS_REFUSED_KO });
  }
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
  });
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

/** `/api/honcho/v3/...` → the Honcho API, with this install's token. */
export async function relayHoncho(req, res, url, options = {}) {
  const rest = url.pathname.slice("/api/honcho".length);
  if (!rest.startsWith("/v3/")) return sendJson(res, 400, { ok: false, error: "Only Honcho v3 routes are relayed." });
  const endpoints = await appEndpoints(options);
  return relay(req, res, `${endpoints.honchoUrl}${rest}${url.search}`, {
    credentials: honchoCredentials(endpoints),
    unreachable: "기억 서버에 연결할 수 없습니다.",
  });
}

/** `/api/dashboard/...` → the server's dashboard: the audit log and the tools it names. */
export async function relayDashboard(req, res, url, options = {}) {
  const endpoints = await appEndpoints(options);
  return relay(req, res, `${endpoints.dashboardUrl}${url.pathname}${url.search}`, {
    unreachable: "기억 서버의 관리 기능에 연결할 수 없습니다. 이 컴퓨터에 서버가 없거나 꺼져 있습니다.",
  });
}

/** `/api/gw/...` → the gateway's own screen server, which owns logins and accounts. */
export async function relayGateway(req, res, url, options = {}) {
  const rest = url.pathname.slice("/api/gw".length);
  if (!rest.startsWith("/api/")) return sendJson(res, 400, { ok: false, error: "Only gateway API routes are relayed." });
  const endpoints = await appEndpoints(options);
  return relay(req, res, `${endpoints.gatewayUiUrl}${rest}${url.search}`, {
    unreachable: "구독 게이트웨이가 꺼져 있습니다.",
  });
}

function honchoCredentials(endpoints) {
  return { token: endpoints.honchoToken, access: endpoints.honchoAccess };
}

async function honchoPost(endpoints, pathname, body = {}) {
  const response = await fetchHoncho(`${endpoints.honchoUrl}${pathname}`, {
    method: "POST",
    headers: honchoHeaders(honchoCredentials(endpoints), { "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (await isCloudflareAccessBlock(response)) {
    throw Object.assign(new Error(ACCESS_REFUSED_KO), { status: 502, access: true });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.detail;
    throw Object.assign(new Error(typeof detail === "string" ? detail : `Honcho answered ${response.status}`), { status: response.status });
  }
  return payload;
}

// What a transcript starts with before the person says anything: harness preambles,
// pasted instructions, tool notices. None of it names the conversation.
const PREAMBLE = /^\s*(<[a-z_-]+[\s>]|#\s*AGENTS|#\s*CLAUDE|\[Request interrupted|Caveat:)/i;

function titleFrom(content) {
  const line = String(content || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("```"));
  if (!line) return "";
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/**
 * One page of conversations, newest first, each with a title and an opening line.
 * Honcho stores neither, so both come from the conversation's first messages:
 * the first thing a person said that is not a harness preamble.
 */
export async function sessionsPage({ workspace, page = 1, size = 30, source = "" } = {}, options = {}) {
  const endpoints = await appEndpoints(options);
  const ws = encodeURIComponent(workspace || endpoints.config?.honcho?.workspaceId || "memory");
  const filters = source ? { filters: { metadata: { source } } } : {};
  const listing = await honchoPost(endpoints, `/v3/workspaces/${ws}/sessions/list?page=${page}&size=${size}&reverse=true`, filters);
  const items = await Promise.all((listing.items || []).map(async (session) => {
    let opening = null;
    let preview = "";
    try {
      const messages = await honchoPost(
        endpoints,
        `/v3/workspaces/${ws}/sessions/${encodeURIComponent(session.id)}/messages/list?page=1&size=6`,
        {},
      );
      const list = messages.items || [];
      opening = list.find((message) => message.metadata?.direct_user && !PREAMBLE.test(message.content || ""))
        || list.find((message) => !PREAMBLE.test(message.content || ""))
        || null;
      const reply = list.find((message) => opening && message.id !== opening.id && message.peer_id !== opening.peer_id
        && !PREAMBLE.test(message.content || ""));
      preview = reply ? titleFrom(reply.content) : "";
    } catch {
      // A session whose messages cannot be read still belongs in the list.
    }
    const metadata = session.metadata || {};
    return {
      id: session.id,
      createdAt: session.created_at,
      source: metadata.source || session.id.split("-")[0] || "",
      project: metadata.cwd ? String(metadata.cwd).split(/[\\/]/).filter(Boolean).at(-1) : "",
      title: opening ? titleFrom(opening.content) : "",
      preview,
      openedBy: opening?.peer_id || "",
    };
  }));
  return { ok: true, total: listing.total ?? items.length, page: listing.page ?? page, pages: listing.pages ?? 1, size, items };
}

// ── This computer's own MCP tools ───────────────────────────────────────────
//
// The plugin's MCP server (mcp-server.mjs) reads which tools are off from
// mcp-tools.json in the data directory on every call, so a change here applies
// to the next tool list an agent asks for.

function toolsFile(config) {
  return path.join(installPaths(config).dataDir, "mcp-tools.json");
}

export async function localTools({ config } = {}) {
  const loaded = config === undefined ? await loadConfig() : config;
  if (!loaded) return { ok: true, configured: false, tools: [] };
  const file = toolsFile(loaded);
  const document = await readJson(file, null);
  const listed = document?.disabled_tools;
  // No file yet means the server's own default: recall only.
  const disabled = new Set(Array.isArray(listed) ? listed.map(String) : WRITE_TOOLS);
  return {
    ok: true,
    configured: true,
    path: file,
    tools: ALL_TOOLS.map((name) => ({ name, enabled: !disabled.has(name), write: WRITE_TOOLS.includes(name) })),
  };
}

/** Turns one tool (`name`) or several at once (`names`, as a group switch does) on or off. */
export async function setLocalTool({ name, names, enabled }, { config } = {}) {
  const wanted = names === undefined ? [name] : names;
  if (!Array.isArray(wanted) || !wanted.length) throw Object.assign(new Error("names must list at least one tool."), { status: 400 });
  for (const item of wanted) {
    if (!ALL_TOOLS.includes(item)) throw Object.assign(new Error(`Unknown MCP tool: ${item}`), { status: 400 });
  }
  if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled must be true or false."), { status: 400 });
  const loaded = config === undefined ? await loadConfig() : config;
  if (!loaded) throw Object.assign(new Error("대화 쌓기를 먼저 켜세요."), { status: 409 });
  const current = await localTools({ config: loaded });
  const disabled = new Set(current.tools.filter((tool) => !tool.enabled).map((tool) => tool.name));
  for (const item of wanted) {
    if (enabled) disabled.delete(item); else disabled.add(item);
  }
  const file = toolsFile(loaded);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writePrivateFileAtomic(file, `${JSON.stringify({ disabled_tools: [...disabled].sort() }, null, 2)}\n`);
  return localTools({ config: loaded });
}
