// The Team Memory app: one screen over the memory server, the collector and the
// subscription gateway. `cli.mjs ui open` starts it.
//
// Setting things up - connect to someone else's shared bridge, install the hooks,
// bring up Honcho and its host services, drop in a ChatGPT export - already exists
// as `cli.mjs` subcommands, and runs the CLI as a subprocess rather than importing
// it, so the app and a terminal take exactly the same path and there is one
// implementation of each step. Reading memories, the gateway's accounts and the
// server's tool switches are relayed to those programs' own APIs (app-api.mjs).
import { execFile } from "node:child_process";
import { createReadStream, promises as fs, realpathSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { appContext, localTools, relayDashboard, relayGateway, relayHoncho, sessionsPage, setLocalTool } from "./app-api.mjs";
import { configEnvironment, loadConfig } from "./config.mjs";
import { ACCESS_ENV } from "./honcho-access.mjs";
import { securePrivateFile } from "./private-file-permissions.mjs";

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
 * The shared-bridge values are credentials for someone else's memory. They reach
 * the CLI through its environment, never its arguments, because a command line is
 * visible to every process on the machine. A value the form left blank is removed
 * rather than inherited from whatever environment started this UI.
 */
const BRIDGE_SECRET_FIELDS = Object.freeze({
  token: "HONCHO_MCP_BEARER_TOKEN",
  accessClientId: "CF_ACCESS_CLIENT_ID",
  accessClientSecret: "CF_ACCESS_CLIENT_SECRET",
});

function connectBridge(body) {
  const env = { ...process.env };
  for (const [field, name] of Object.entries(BRIDGE_SECRET_FIELDS)) {
    delete env[name];
    const value = typeof body?.[field] === "string" ? body[field].trim() : "";
    if (value) env[name] = value;
  }
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  return runCli(["bridge", "connect", "--url", url], { timeout: 90_000, env });
}

const ROUTES = {
  "/api/bridge/status": async () => runCli(["bridge", "status"], { timeout: 30_000 }),
  "/api/bridge/connect": async (body) => connectBridge(body),
  "/api/bridge/test": async () => runCli(["bridge", "test"], { timeout: 90_000 }),
  "/api/bridge/disconnect": async () => runCli(["bridge", "disconnect"], { timeout: 30_000 }),
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
};

/**
 * The host services have their own lifecycle, separate from the Docker stack.
 * `host start` installs the subscription gateway through its own CLI - the gateway
 * registers its own autostart - and launches the Ollama supervisor detached, so it
 * survives this UI process restarting or a terminal closing. This repository
 * registers nothing with launchd, the Windows task scheduler or systemd, so after
 * a reboot the supervisor stays down until someone opens the app or runs
 * `host start` again; the gateway comes back by itself.
 */
const HOST_ROUTES = {
  "/api/host/status": ["host", "status", "--profile", "personal"],
  "/api/host/prepare": ["host", "prepare", "--profile", "personal"],
  "/api/host/start": ["host", "start", "--profile", "personal"],
  "/api/host/stop": ["host", "stop", "--profile", "personal"],
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
 * A server's API token and its Cloudflare Access service token, like the
 * shared-bridge secrets, reach the CLI through its environment and never its
 * arguments. Left blank, the CLI keeps what it already saved for that same server.
 * These are the memory server's own names; the shared bridge's are above.
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
    const route = ROUTES[url.pathname];
    const hostRoute = HOST_ROUTES[url.pathname];
    if (!route && !hostRoute) return json(res, 404, { error: "Not found" });
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
