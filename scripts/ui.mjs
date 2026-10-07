// The Team Memory app: one screen over the memory server, the collector and the
// subscription gateway. `cli.mjs ui open` starts it.
//
// Setting things up - install the hooks, bring up Honcho and its host services,
// share the server, connect a teammate's memory to Claude Code and Codex, drop in a
// ChatGPT export - already exists as `cli.mjs` subcommands, and runs the CLI as a
// subprocess rather than importing it, so the app and a terminal take exactly the
// same path and there is one implementation of each step. The two exceptions are
// marked where they are. Reading memories, the gateway's accounts and the server's
// tool switches are relayed to those programs' own APIs (app-api.mjs).
import { execFile } from "node:child_process";
import { createReadStream, promises as fs, realpathSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { appContext, appFlow, localTools, relayDashboard, relayGateway, relayHoncho, sessionsPage, setLocalTool } from "./app-api.mjs";
import { configEnvironment, loadConfig, userHome } from "./config.mjs";
import { listFolders } from "./folders.mjs";
import { ACCESS_ENV } from "./honcho-access.mjs";
import { FEATURES, parseFeatures } from "./prereqs.mjs";
import { securePrivateFile } from "./private-file-permissions.mjs";
import { conversationProjects } from "./projects.mjs";
import { redactSecrets } from "./redact.mjs";
import { TARGET_ID, TARGET_SECRET_ENV } from "./targets.mjs";
import { API_TOKEN_ENV, codexLogin, INVITE_ENV, teamAddress, teammateAdd, teamName } from "./team-access.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// In this checkout the scripts sit in scripts/ with ui/ beside it. In an installed
// runtime everything has been flattened into one directory, with ui/ inside it.
const INSTALLED = path.basename(HERE) !== "scripts";
const CLI = path.join(HERE, "cli.mjs");
const COLLECTOR = path.join(HERE, "collector.mjs");
const PUBLIC = INSTALLED ? path.join(HERE, "ui") : path.resolve(HERE, "..", "ui");

const host = process.env.HONCHO_AGENT_BRIDGE_UI_HOST || "127.0.0.1";
const port = Number(process.env.HONCHO_AGENT_BRIDGE_UI_PORT || 4180);

// A ChatGPT export of a few years of conversations runs to tens of megabytes.
const MAX_UPLOAD_BYTES = Number(process.env.HONCHO_AGENT_BRIDGE_UI_MAX_UPLOAD_BYTES || 256 * 1024 * 1024);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function isLoopbackHostname(hostname = "") {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (value === "localhost" || value === "::1") return true;
  if (value.startsWith("::ffff:")) return isLoopbackHostname(value.slice("::ffff:".length));
  const octets = value.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function parseHostHeader(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(`http://${value.trim()}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return { hostname: parsed.hostname, port: parsed.port };
  } catch {
    return null;
  }
}

/**
 * This UI can install hooks and start services, so it only ever answers a browser on
 * this machine, on its own origin. A page on another site must not be able to drive it.
 */
export function rejectUnsafeRequest(req) {
  const requestHost = parseHostHeader(req.headers.host);
  if (!requestHost || !isLoopbackHostname(requestHost.hostname)) {
    return { status: 403, error: "The setup UI only answers a localhost Host header." };
  }
  const originHeader = req.headers.origin;
  if (originHeader !== undefined) {
    if (typeof originHeader !== "string") return { status: 403, error: "Invalid Origin." };
    try {
      const origin = new URL(originHeader);
      const bare = origin.pathname === "/" && !origin.search && !origin.hash && !origin.username && !origin.password;
      if (!bare || !isLoopbackHostname(origin.hostname) || origin.origin !== new URL(`http://${req.headers.host}`).origin) {
        return { status: 403, error: "The setup UI only accepts same-origin localhost requests." };
      }
    } catch {
      return { status: 403, error: "Invalid Origin." };
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return { status: 415, error: "Setup UI requests must use application/json." };
    }
  }
  return null;
}

async function readJsonBody(req, limit = 1024 * 1024) {
  let raw = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    raw += chunk;
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/** Run one CLI subcommand and return its JSON result. */
export async function runCli(args, { timeout = 1_800_000, env = process.env } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { timeout, env, maxBuffer: 32 * 1024 * 1024 });
    return parseCliOutput(stdout);
  } catch (error) {
    const parsed = error?.stdout ? parseCliOutput(error.stdout) : null;
    if (parsed) return parsed;
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * `cli.mjs` prints one pretty-printed object; `collector.mjs` prints one line. Read
 * the whole of stdout first, then fall back to its last line.
 */
function parseCliOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  if (start >= 0) {
    try { return JSON.parse(text.slice(start)); } catch {}
  }
  const line = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Write the request body to a file without holding the whole export in memory.
 *
 * This is someone's entire chat history landing in the temp directory. Windows
 * ignores a POSIX creation mode, so the file is created empty, restricted, and
 * only then written to - the same order `writePrivateFileAtomic` uses.
 */
async function spoolUpload(req) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "honcho-bridge-upload-"));
  try {
    const target = path.join(directory, "conversations.json");
    await fs.writeFile(target, "", { mode: 0o600, flag: "wx" });
    await securePrivateFile(target);
    const handle = await fs.open(target, "r+");
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw new Error("The uploaded export is larger than this UI accepts.");
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    if (!size) throw new Error("The upload was empty.");
    return { directory, target, size };
  } catch (error) {
    // A rejected upload must not leave a partial copy of someone's history behind.
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Sharing this server: by hand with a tunnel token, through the Cloudflare API with
 * the owner's API token, or on a teammate's computer with the owner's invite. Each
 * of those is a secret, and like every other secret here it reaches the CLI through
 * its environment and never its arguments, because a command line is visible to
 * every process on the machine. A value the form left blank is removed rather than
 * inherited from whatever environment started this UI; the CLI then uses the one it
 * saved before, if any.
 */
const SHARE_SECRET_FIELDS = Object.freeze({ tunnelToken: "HONCHO_TUNNEL_TOKEN" });
const CLOUDFLARE_SECRET_FIELDS = Object.freeze({ apiToken: API_TOKEN_ENV });
const INVITE_SECRET_FIELDS = Object.freeze({ invite: INVITE_ENV });

function secretEnvironment(body, fields) {
  const env = { ...process.env };
  for (const [field, name] of Object.entries(fields)) {
    delete env[name];
    const value = typeof body?.[field] === "string" ? body[field].trim() : "";
    if (value) env[name] = value;
  }
  return env;
}

/**
 * What `/api/server/share/enable` runs. With `cloudflare: true` the name, zone and
 * owner's email are `--name=value` arguments and the API token is in the
 * environment; by hand only the address is an argument.
 */
export function shareEnableInvocation(body) {
  if (body?.cloudflare === true) {
    return {
      args: ["server", "share", "enable", "--cloudflare", ...inlineOption("name", body.name), ...inlineOption("zone", body.zone), ...inlineOption("email", body.email)],
      env: secretEnvironment(body, CLOUDFLARE_SECRET_FIELDS),
    };
  }
  const publicUrl = typeof body?.publicUrl === "string" ? body.publicUrl.trim() : "";
  return {
    args: ["server", "share", "enable", "--public-url", publicUrl],
    env: secretEnvironment(body, SHARE_SECRET_FIELDS),
  };
}

/** What `/api/server/share/join` runs: no argument, the invite in the environment only. */
export function shareJoinInvocation(body) {
  return { args: ["server", "share", "join"], env: secretEnvironment(body, INVITE_SECRET_FIELDS) };
}

// POST only, so a cross-site GET can never read the gate token; the Host and
// Origin checks above apply as they do to every route.
const SHARE_ROUTES = {
  "/api/server/share/status": async (body) => runCli(["server", "share", "status", ...(body?.check === true ? ["--check"] : [])], { timeout: 60_000 }),
  "/api/server/share/enable": async (body) => {
    const { args, env } = shareEnableInvocation(body);
    return runCli(args, { timeout: 900_000, env });
  },
  "/api/server/share/join": async (body) => {
    const { args, env } = shareJoinInvocation(body);
    return runCli(args, { timeout: 900_000, env });
  },
  "/api/server/share/disable": async () => runCli(["server", "share", "disable"], { timeout: 300_000 }),
  "/api/server/share/token": async () => runCli(["server", "share", "token"], { timeout: 30_000 }),
  "/api/server/share/rotate": async () => runCli(["server", "share", "rotate"], { timeout: 300_000 }),
};

/**
 * The team, on the owner's computer (who may log in, and which teammates share a
 * server), and on any computer, a teammate's memory in Claude Code and Codex
 * (team-access.mjs). The owner's Cloudflare API token is the one saved by sharing,
 * never one inherited from the environment that started this UI. Names and hosts
 * are checked here and passed in their checked form, so none can read as an option.
 */
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/;

function teamEnvironment() {
  return secretEnvironment({}, CLOUDFLARE_SECRET_FIELDS);
}

/** What `/api/teammates/<action>` runs, or null for a request without a valid name, email or address. */
export function teammateInvocation(action, body = {}) {
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const name = teamName(body?.name);
  if (action === "list") return ["teammates", "list"];
  if (action === "connected") return ["teammates", "connected"];
  if (action === "remove") return EMAIL.test(email) ? ["teammates", "remove", email] : null;
  if (action === "unshare") return name ? ["teammates", "unshare", name] : null;
  if (action === "disconnect") return name ? ["teammates", "disconnect", name] : null;
  if (action === "connect") {
    const address = teamAddress(body?.address);
    return name && address.ok ? ["teammates", "connect", name, address.host] : null;
  }
  return null;
}

async function teammateRoute(action, body, timeout) {
  const args = teammateInvocation(action, body);
  if (!args) return { ok: false, error: "Give a valid email, a short name (lower-case letters, digits and -) or a server address." };
  return runCli(args, { timeout, env: teamEnvironment() });
}

/**
 * Adding a teammate who also shares a server returns the invite once, for the page
 * to show. The CLI only ever writes an invite to a file, so this one route calls
 * team-access.mjs itself instead of the CLI; everything but the invite is redacted
 * as the CLI's output would be.
 */
async function addTeammate(body) {
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const sharing = body?.share === true;
  const share = sharing ? teamName(body?.name) : null;
  if (sharing && !share) return { ok: false, error: "Give the teammate's server a short name: lower-case letters, digits and -, up to 32 characters." };
  const { invite, ...result } = await teammateAdd({ email, share, returnInvite: Boolean(share), env: teamEnvironment() });
  return { ...redactSecrets(result), ...(typeof invite === "string" ? { invite } : {}) };
}

// POST only, like the share routes.
const TEAM_ROUTES = {
  "/api/teammates": async (body) => teammateRoute("list", body, 120_000),
  "/api/teammates/add": async (body) => addTeammate(body),
  "/api/teammates/remove": async (body) => teammateRoute("remove", body, 120_000),
  "/api/teammates/unshare": async (body) => teammateRoute("unshare", body, 300_000),
  "/api/teammates/connected": async (body) => teammateRoute("connected", body, 30_000),
  "/api/teammates/connect": async (body) => teammateRoute("connect", body, 180_000),
  "/api/teammates/disconnect": async (body) => teammateRoute("disconnect", body, 180_000),
  // `codex mcp login` opens the browser and waits for it, so it is started here and
  // answered as soon as it ends or shows its login address (team-access.mjs).
  "/api/teammates/codex-login": async (body) => codexLogin({ name: body?.name }),
  // Removes the shared-bridge settings 0.3.28 and before saved; nothing uses them now.
  "/api/bridge/disconnect": async () => runCli(["bridge", "disconnect"], { timeout: 30_000 }),
};

/**
 * Other servers that also receive the conversations from chosen folders
 * (targets.mjs). A target's API token and Access service token reach the CLI
 * through its environment, like every other secret here; every other value is
 * passed as `--name=value`, so a value that starts with `--` is never read as an
 * option of its own.
 */
const TARGET_SECRET_FIELDS = Object.freeze({
  apiToken: TARGET_SECRET_ENV.apiToken,
  accessClientId: TARGET_SECRET_ENV.accessClientId,
  accessClientSecret: TARGET_SECRET_ENV.accessClientSecret,
});

function inlineOption(name, value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return [`--${name}=${value.trim()}`];
}

function foldersValue(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).join(",");
  return typeof value === "string" ? value : "";
}

function agentsValue(value) {
  if (Array.isArray(value)) return value.filter((item) => item === "claude" || item === "codex").join(",");
  if (value && typeof value === "object") return ["claude", "codex"].filter((name) => value[name] === true).join(",");
  return typeof value === "string" ? value : "";
}

/** What `/api/targets/<action>` runs. Secrets only ever in `env`; null for a request that names no target. */
export function targetInvocation(action, body = {}) {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!TARGET_ID.test(id)) return null;
  // Only `add` carries secrets; every other action runs with none inherited.
  const env = secretEnvironment(action === "add" ? body : {}, TARGET_SECRET_FIELDS);
  const args = ["target", action, id];
  if (action === "add") {
    args.push(
      ...inlineOption("url", body.url),
      ...inlineOption("folders", foldersValue(body.folders)),
      ...inlineOption("label", body.label),
      ...inlineOption("workspace", body.workspace),
      ...inlineOption("user-peer", body.userPeer),
      ...inlineOption("agents", agentsValue(body.agents)),
    );
  } else if (action === "set") {
    if (body.folders !== undefined) args.push(...inlineOption("folders", foldersValue(body.folders)));
    if (typeof body.enabled === "boolean") args.push(`--enabled=${body.enabled}`);
    args.push(
      ...inlineOption("label", body.label),
      ...inlineOption("workspace", body.workspace),
      ...inlineOption("user-peer", body.userPeer),
    );
    if (body.agents !== undefined) args.push(...inlineOption("agents", agentsValue(body.agents)));
  } else if (action === "backfill") {
    if (typeof body.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.since)) args.push(`--since=${body.since}`);
    if (Number.isInteger(body.limit) && body.limit > 0) args.push(`--limit=${body.limit}`);
  }
  return { args, env };
}

const TARGET_TIMEOUTS = { add: 90_000, remove: 30_000, set: 30_000, test: 90_000, backfill: 3_600_000 };

// POST only, like the share routes: they change the configuration or send
// conversations to another server.
const TARGET_ROUTES = Object.fromEntries(Object.entries(TARGET_TIMEOUTS).map(([action, timeout]) => [
  `/api/targets/${action}`,
  async (body) => {
    const invocation = targetInvocation(action, body);
    if (!invocation) return { ok: false, error: "Name the target: a short id of lower-case letters, digits and dashes." };
    return runCli(invocation.args, { timeout, env: invocation.env });
  },
]));

/**
 * The conversation backup (backup.mjs). Choosing where it goes, starting a run and
 * turning the daily schedule on or off change this computer, so they are POST
 * only, and every value goes as `--name=value`, never as an option of its own.
 */
const RCLONE_REMOTE = /^[A-Za-z0-9_][A-Za-z0-9_ .+@-]{0,63}$/;

/** What `/api/backup/set` runs, or null for a request that names no destination. */
export function backupSetInvocation(body) {
  const kind = body?.kind;
  if (kind === "off") return ["backup", "set", "--off"];
  if (kind === "folder") {
    const folder = typeof body.path === "string" ? body.path.trim() : "";
    return folder && !/[\r\n]/.test(folder) ? ["backup", "set", `--folder=${folder}`] : null;
  }
  if (kind === "cloud") {
    const remote = typeof body.remote === "string" ? body.remote.trim() : "";
    const folder = typeof body.path === "string" ? body.path.trim().replace(/^\/+|\/+$/g, "") : "";
    if (!RCLONE_REMOTE.test(remote) || /[\r\n]/.test(folder)) return null;
    return ["backup", "set", `--cloud=${remote}:${folder}`];
  }
  return null;
}

/**
 * What `/api/backup/schedule` runs: on or off, and the hour of the nightly run when
 * the request names one. Null for an hour that is not a whole number from 0 to 23.
 */
export function backupScheduleInvocation(body) {
  const args = ["backup", "schedule", body?.on === true ? "on" : "off"];
  const hour = body?.hour;
  if (hour === undefined || hour === null) return args;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return [...args, `--hour=${hour}`];
}

const BACKUP_ROUTES = {
  "/api/backup/set": async (body) => {
    const args = backupSetInvocation(body);
    if (!args) return { ok: false, error: "Choose a folder, an rclone remote, or off." };
    return runCli(args, { timeout: 120_000 });
  },
  "/api/backup/start": async () => runCli(["backup", "start"], { timeout: 30_000 }),
  "/api/backup/schedule": async (body) => {
    const args = backupScheduleInvocation(body);
    if (!args) return { ok: false, error: "Choose an hour from 0 to 23." };
    return runCli(args, { timeout: 120_000 });
  },
};

/**
 * The CLI routes that only read. Every other one changes this computer, so it answers
 * a JSON POST only: a page on another site can make a browser send a GET here (an
 * image sends no Origin), but it cannot send a JSON POST without being refused.
 */
const READ_ROUTES = new Set([
  "/api/targets", "/api/status", "/api/server/status", "/api/backup/status", "/api/backup/remotes", "/api/host/status",
]);

const ROUTES = {
  "/api/targets": async () => runCli(["target", "list"], { timeout: 30_000, env: secretEnvironment({}, TARGET_SECRET_FIELDS) }),
  ...TARGET_ROUTES,
  ...TEAM_ROUTES,
  "/api/status": async () => ({
    detect: await runCli(["detect"], { timeout: 120_000 }),
    doctor: await runCli(["doctor"], { timeout: 120_000 }),
  }),
  "/api/setup/plan": async (body) => runCli(["setup", "plan", ...cliOptions(body)], { env: setupEnvironment(body) }),
  "/api/setup/apply": async (body) => runCli(["setup", "apply", ...cliOptions(body)], { env: setupEnvironment(body) }),
  "/api/server/plan": async (body) => runCli(["server", "plan", ...profileOption(body)]),
  "/api/server/prepare": async (body) => runCli(["server", "prepare", ...profileOption(body), ...modelOption(body)]),
  "/api/server/start": async (body) => runCli(["server", "start", ...profileOption(body), ...modelOption(body)]),
  "/api/server/stop": async (body) => runCli(["server", "stop", ...profileOption(body)]),
  "/api/server/status": async (body) => runCli(["server", "status", ...profileOption(body)]),
  "/api/server/verify": async (body) => runCli(["server", "verify", ...profileOption(body, "personal")]),
  ...SHARE_ROUTES,
  "/api/backup/status": async (body) => runCli(["backup", "status", ...(body?.check === true ? ["--check"] : [])], { timeout: 120_000 }),
  "/api/backup/remotes": async () => runCli(["backup", "remotes"], { timeout: 60_000 }),
  ...BACKUP_ROUTES,
};

/**
 * The host services have their own lifecycle, separate from the Docker stack.
 * `host start` installs the subscription gateway through its own CLI - the gateway
 * registers its own autostart - and registers a per-user login autostart for the
 * Ollama supervisor and starts it, so it survives this UI process restarting, a
 * terminal closing, and a reboot. `host stop`, in a terminal, removes that autostart.
 */
const HOST_ROUTES = {
  "/api/host/status": ["host", "status", "--profile", "personal"],
  "/api/host/start": ["host", "start", "--profile", "personal"],
  "/api/gateway/open": ["gateway", "open"],
};

function profileOption(body, fallback = "portable") {
  const profile = body?.profile === "personal" || body?.profile === "portable" ? body.profile : fallback;
  return ["--profile", profile];
}

/** The chat model Honcho is set to use, as the gateway names it. */
function modelOption(body) {
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  return /^[\w.:/-]{1,120}$/.test(model) ? ["--model", model] : [];
}

/**
 * The option names `setupPlan` actually reads, spelled as `parseOptions` expects
 * them on the command line. Anything else a form sends is dropped rather than
 * passed through under a name the CLI would ignore in silence.
 */
const SETUP_OPTIONS = new Set([
  "userPeer", "honchoUrl", "workspace", "agents", "codexRoot", "dataDir",
]);

/**
 * A server's API token and its Cloudflare Access service token, like the share
 * secrets, reach the CLI through its environment and never its arguments. Left
 * blank, the CLI keeps what it already saved for that same server.
 */
const SETUP_SECRET_FIELDS = Object.freeze({
  apiToken: "HONCHO_API_TOKEN",
  accessClientId: ACCESS_ENV.clientId,
  accessClientSecret: ACCESS_ENV.clientSecret,
});

function setupEnvironment(body) {
  const env = { ...process.env };
  for (const [field, name] of Object.entries(SETUP_SECRET_FIELDS)) {
    delete env[name];
    const value = typeof body?.[field] === "string" ? body[field].trim() : "";
    if (value) env[name] = value;
  }
  return env;
}

function cliOptions(body) {
  const args = [];
  for (const [key, value] of Object.entries(body || {})) {
    if (!SETUP_OPTIONS.has(key)) continue;
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    if (value === true) args.push(flag);
    else if (value === false || value === null || value === undefined) continue;
    else args.push(flag, String(value));
  }
  return args;
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * The collector reads where to send and with what credentials from its
 * environment, as it does under a hook. An environment that names another server
 * (HONCHO_BASE_URL) is used as it is: the saved tokens stay with their own server.
 */
async function importEnvironment(env = process.env) {
  const configured = configEnvironment(await loadConfig().catch(() => null), "chatgpt");
  if (!configured.HONCHO_BASE_URL) return env;
  if (env.HONCHO_BASE_URL && !sameOrigin(env.HONCHO_BASE_URL, configured.HONCHO_BASE_URL)) return env;
  return { ...env, ...configured };
}

async function importChatGpt(req, res) {
  let upload;
  try {
    upload = await spoolUpload(req);
  } catch (error) {
    return json(res, 413, { ok: false, error: String(error?.message || error) });
  }
  let payload;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [COLLECTOR, "--provider", "chatgpt", "--export", upload.target],
      { timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024, env: await importEnvironment() },
    );
    payload = parseCliOutput(stdout) || { ok: false, error: "The importer returned no result." };
  } catch (error) {
    payload = (error?.stdout ? parseCliOutput(error.stdout) : null)
      || { ok: false, error: String(error?.message || error) };
  }
  // The spooled copy of someone's conversations goes before the answer does, so a
  // caller that sees a result knows nothing was left on disk.
  await fs.rm(upload.directory, { recursive: true, force: true }).catch(() => {});
  return json(res, 200, { ...payload, uploaded_bytes: upload.size });
}

/**
 * `?features=server,sync` as `cli.mjs prereqs` arguments. Only the two
 * feature names pass.
 */
export function prereqsInvocation(query) {
  const values = query.getAll("features");
  if (values.length > 1) return { error: "features is given once, as a comma-separated list" };
  const { features, invalid } = parseFeatures(values[0] || "");
  if (invalid.length) return { error: `unknown feature: ${invalid.join(", ")} (expected ${FEATURES.join(", ")})` };
  return { args: ["prereqs", `--features=${features.join(",")}`] };
}

async function staticFile(req, res) {
  const requested = new URL(req.url, "http://ui").pathname;
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const target = path.join(PUBLIC, path.normalize(relative));
  if (!target.startsWith(`${PUBLIC}${path.sep}`) && target !== path.join(PUBLIC, "index.html")) {
    return json(res, 403, { error: "Forbidden" });
  }
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(target).pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

export function createUiServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://ui");
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
      const rejection = rejectUnsafeRequest(req);
      if (rejection) return json(res, rejection.status, { error: rejection.error });
      return staticFile(req, res);
    }
    const rejection = rejectUnsafeRequest(req);
    if (rejection) return json(res, rejection.status, { error: rejection.error });

    if (url.pathname === "/api/import/chatgpt" && req.method === "POST") {
      return importChatGpt(req, res);
    }
    if (url.pathname.startsWith("/api/honcho/")) return relayHoncho(req, res, url);
    if (url.pathname.startsWith("/api/dashboard/")) return relayDashboard(req, res, url);
    if (url.pathname.startsWith("/api/gw/")) return relayGateway(req, res, url);
    if (url.pathname === "/api/app/context" && req.method === "GET") {
      return json(res, 200, await appContext().catch((error) => ({ ok: false, error: String(error?.message || error) })));
    }
    if (url.pathname === "/api/app/mcp-tools") {
      try {
        if (req.method === "GET") return json(res, 200, await localTools());
        if (req.method === "POST") return json(res, 200, await setLocalTool(await readJsonBody(req)));
        return json(res, 405, { error: "Method not allowed" });
      } catch (error) {
        return json(res, error.status || 500, { ok: false, error: String(error?.message || error) });
      }
    }
    if (url.pathname === "/api/app/sessions" && req.method === "GET") {
      try {
        const query = url.searchParams;
        return json(res, 200, await sessionsPage({
          workspace: query.get("workspace") || "",
          page: Math.max(1, Number.parseInt(query.get("page") || "1", 10) || 1),
          size: Math.min(50, Math.max(1, Number.parseInt(query.get("size") || "30", 10) || 30)),
          source: /^[a-z0-9_-]{0,40}$/i.test(query.get("source") || "") ? query.get("source") || "" : "",
        }));
      } catch (error) {
        return json(res, error.status === 404 ? 404 : 502, {
          ok: false,
          ...(error.access ? { unreachable: false, access: true } : {}),
          error: String(error?.message || error),
        });
      }
    }
    // What waits to go to the memory server and what went, for the dashboard: read
    // only and cheap, so it can be asked every few seconds.
    if (url.pathname === "/api/app/flow") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
      try {
        return json(res, 200, { ok: true, ...(await appFlow(await loadConfig().catch(() => null))) });
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) });
      }
    }
    // The folder picker and the list of folders conversations were held in: read
    // only, and answered here rather than by the CLI.
    if (url.pathname === "/api/app/folders" || url.pathname === "/api/app/projects") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
      try {
        if (url.pathname === "/api/app/folders") {
          return json(res, 200, await listFolders({ path: url.searchParams.get("path") ?? undefined, home: userHome() }));
        }
        return json(res, 200, await conversationProjects({ config: await loadConfig().catch(() => null) }));
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) });
      }
    }
    if (url.pathname === "/api/app/prereqs") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
      const invocation = prereqsInvocation(url.searchParams);
      if (invocation.error) return json(res, 400, { ok: false, error: invocation.error });
      return json(res, 200, await runCli(invocation.args, { timeout: 60_000 }));
    }
    const route = ROUTES[url.pathname];
    const hostRoute = HOST_ROUTES[url.pathname];
    if (!route && !hostRoute) return json(res, 404, { error: "Not found" });
    if (!READ_ROUTES.has(url.pathname) && req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }
    let body = {};
    if (req.method === "POST") {
      try { body = await readJsonBody(req); }
      catch (error) { return json(res, 400, { error: String(error?.message || error) }); }
    }
    try {
      const result = hostRoute ? await runCli(hostRoute) : await route(body);
      return json(res, 200, result ?? { ok: false, error: "No result." });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message || error) });
    }
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  // `file://${argv[1]}` never matches a Windows path, which kept the screen from
  // ever listening there, and a symlinked path (macOS /tmp) differs from the real
  // one Node loads the module from.
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMainModule()) {
  createUiServer().listen(port, host, () => {
    process.stdout.write(`Team Memory: http://${host}:${port}\n`);
  });
}
