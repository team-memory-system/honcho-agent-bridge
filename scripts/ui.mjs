// The collector's install screen.
//
// Everything here already exists as a `cli.mjs` subcommand. This is the same set of
// steps for someone who does not open a terminal: see what is missing, connect to
// someone else's shared bridge, install the hooks, bring up Honcho and the proxies,
// and drop in a ChatGPT export. `cli.mjs ui open` starts it.
//
// It runs the CLI as a subprocess rather than importing it, so the UI and a terminal
// take exactly the same path and there is one implementation of each step.
import { execFile } from "node:child_process";
import { createReadStream, promises as fs, realpathSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { installPaths } from "./config.mjs";
import { securePrivateFile, writePrivateFileAtomic } from "./private-file-permissions.mjs";

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
 * The proxies are enabled in the installed host profile, which is also the only
 * place that says where their source lives. A fresh install ships with the
 * location blank and all three off, so without this the UI's proxy buttons could
 * never succeed - they would prepare a host that manages nothing.
 *
 * Only these fields are writable. Everything else in the profile, including the
 * Ollama section, is left exactly as it was, and a secret is refused outright
 * because `deriveHostTopology` rejects the whole profile when one appears.
 */
const PROXY_NAMES = Object.freeze({ codex: "codexProxy", claude: "claudeProxy", router: "router" });

function hostProfilePath() {
  return path.join(installPaths().appHome, "server", "host-profile.personal.json");
}

async function readProxyProfile() {
  const target = hostProfilePath();
  let profile;
  try { profile = JSON.parse(await fs.readFile(target, "utf8")); }
  catch { return { ok: false, path: target, error: "The installed host profile does not exist yet. Install the server first." }; }
  const proxies = {};
  for (const [name, key] of Object.entries(PROXY_NAMES)) {
    proxies[name] = { enabled: profile[key]?.enabled === true, baseUrl: profile[key]?.baseUrl || "", sourceDir: profile[key]?.sourceDir || "" };
  }
  return { ok: true, path: target, llmProxyRoot: profile.llmProxyRoot || "", proxies };
}

async function writeProxyProfile(body) {
  const current = await readProxyProfile();
  if (!current.ok) return current;
  const target = current.path;
  const profile = JSON.parse(await fs.readFile(target, "utf8"));

  if (typeof body.llmProxyRoot === "string") {
    const root = body.llmProxyRoot.trim();
    if (root) {
      const resolved = path.resolve(root);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) throw new Error("not a directory");
      } catch {
        return { ok: false, error: `That is not a directory on this machine: ${resolved}` };
      }
      profile.llmProxyRoot = resolved;
    } else {
      profile.llmProxyRoot = "";
    }
  }
  for (const [name, key] of Object.entries(PROXY_NAMES)) {
    const wanted = body.proxies?.[name]?.enabled;
    if (typeof wanted !== "boolean") continue;
    profile[key] = { ...(profile[key] || {}), enabled: wanted };
    if (wanted && !profile.llmProxyRoot && !profile[key].sourceDir) {
      return { ok: false, error: `Set the proxy source location before enabling ${name}.` };
    }
  }

  // Same writer the rest of the installer uses, so the file keeps its restricted
  // ACL on Windows and its owner-only mode elsewhere.
  await writePrivateFileAtomic(target, `${JSON.stringify(profile, null, 2)}\n`);
  return { ...(await readProxyProfile()), updated: true };
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
  "/api/setup/plan": async (body) => runCli(["setup", "plan", ...cliOptions(body)]),
  "/api/setup/apply": async (body) => runCli(["setup", "apply", ...cliOptions(body)]),
  "/api/server/plan": async (body) => runCli(["server", "plan", ...profileOption(body)]),
  "/api/server/prepare": async (body) => runCli(["server", "prepare", ...profileOption(body)]),
  "/api/server/start": async (body) => runCli(["server", "start", ...profileOption(body)]),
  "/api/server/stop": async (body) => runCli(["server", "stop", ...profileOption(body)]),
  "/api/server/status": async (body) => runCli(["server", "status", ...profileOption(body)]),
  "/api/server/verify": async (body) => runCli(["server", "verify", ...profileOption(body, "personal")]),
  "/api/proxies/config": async (body) => (
    Object.keys(body || {}).length ? writeProxyProfile(body) : readProxyProfile()
  ),
};

/**
 * The proxies have their own lifecycle, separate from the Docker stack: `host start`
 * launches the supervisor detached and records its PID, so the proxies survive this
 * UI process restarting or a terminal closing. Nothing is registered with launchd,
 * the Windows task scheduler or systemd - which also means nothing brings them back
 * after a reboot until someone opens the app or runs `host start` again.
 *
 * The UI says "proxy" because that is what the person is looking for.
 */
const PROXY_ROUTES = {
  "/api/proxies/health": ["host", "status", "--profile", "personal"],
  "/api/proxies/install": ["host", "prepare", "--profile", "personal"],
  "/api/proxies/start": ["host", "start", "--profile", "personal"],
  "/api/proxies/stop": ["host", "stop", "--profile", "personal"],
};

function profileOption(body, fallback = "portable") {
  const profile = body?.profile === "personal" || body?.profile === "portable" ? body.profile : fallback;
  return ["--profile", profile];
}

/**
 * The option names `setupPlan` actually reads, spelled as `parseOptions` expects
 * them on the command line. Anything else a form sends is dropped rather than
 * passed through under a name the CLI would ignore in silence.
 */
const SETUP_OPTIONS = new Set([
  "userPeer", "honchoUrl", "workspace", "agents", "codexRoot", "dataDir",
]);

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
      { timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 },
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
    const route = ROUTES[url.pathname];
    const proxyRoute = PROXY_ROUTES[url.pathname];
    if (!route && !proxyRoute) return json(res, 404, { error: "Not found" });
    let body = {};
    if (req.method === "POST") {
      try { body = await readJsonBody(req); }
      catch (error) { return json(res, 400, { error: String(error?.message || error) }); }
    }
    try {
      const result = proxyRoute ? await runCli(proxyRoute) : await route(body);
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
    process.stdout.write(`Honcho Agent Bridge setup: http://${host}:${port}\n`);
  });
}
