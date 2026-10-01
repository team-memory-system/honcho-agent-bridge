// The personal profile's host side: what runs on this machine beside the Honcho
// containers, because it cannot run inside them.
//
// Two things, with two lifecycles:
//   - The subscription gateway (scripts/gateway.mjs), which turns the user's own
//     Codex and Claude logins into the router every chat model goes through. It is
//     fetched into runtime/subscription-gateway and installed through its own CLI,
//     which registers the gateway's own per-user autostart, so it comes back after
//     a reboot by itself.
//   - Ollama with the Qwen3 embedding alias, kept resident by
//     server/host/supervisor.mjs. `host start` registers a per-user login autostart
//     for that supervisor and starts it; every copy finds the running one through
//     its PID file.
//
// Ollama is whichever copy is found first: on PATH, the macOS app's CLI, the
// Windows installer's copy, or the app's own copy in <app home>/runtime/ollama,
// which prepare downloads when there is none (scripts/runtime-installer.mjs). The
// app's own copy has no service of its own, so `ollama serve` is always started by
// this app for it: by prepare, by `host start`, and by the supervisor whenever the
// API stops answering.
//
// The supervisor's autostart (through autostart.mjs; no admin rights):
//   launchd      ~/Library/LaunchAgents/team-memory-system.host.plist
//                (RunAtLoad, KeepAlive {SuccessfulExit: false})
//   windows-run  the value "TeamMemoryHost" under HKCU\...\CurrentVersion\Run, which
//                runs <runtime>/host/supervisor.vbs through a hidden wscript at logon
//   systemd      ~/.config/systemd/user/team-memory-host.service (Restart=on-failure)
// Each runs exactly what `host start` would spawn: this node, the supervisor, and
// `--config <host-config.json> --log <logs>/supervisor.log`. `host stop` (and so
// `server stop`) removes it first, so nothing starts the supervisor again. After a
// reboot the supervisor comes back at login, and with it the app's own `ollama serve`.
//
// The supervisor also runs the Mesh forwarder (server/host/mesh-forwarder.mjs)
// while the share state (<runtime>/share.json, written by share-manager.mjs) turns
// Mesh sharing on, so it comes back with the same autostart. The host config names
// the three files that takes; `host status` reports the forwarder.
import { execFile, spawn as nodeSpawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEFAULT_GATEWAY_ROUTER_URL,
  DEFAULT_GATEWAY_UI_URL,
  gatewayCliPath,
  gatewayDirectory,
  gatewayLoginAction,
  gatewaySourceProbe,
  gatewayStatus,
  loopbackUrl,
  prepareGateway,
} from "./gateway.mjs";
import {
  autostartRegistered,
  installLaunchAgent,
  installSystemdUnit,
  kickstartLaunchAgent,
  launchAgent,
  registerWindowsRun,
  runCommand,
  systemdUnit,
  UNDER_TEST_ERROR,
  uninstallLaunchAgent,
  uninstallSystemdUnit,
  unregisterWindowsRun,
  windowsRun,
} from "./autostart.mjs";
import { securePrivateFile } from "./private-file-permissions.mjs";
import { installOllama, locateOllama, ollamaDownload, ollamaRuntimeDir } from "./runtime-installer.mjs";

const execFileAsync = promisify(execFile);
const FORMAT_VERSION = 1;
export const HOST_LAUNCHD_LABEL = "team-memory-system.host";
export const HOST_RUN_VALUE = "TeamMemoryHost";
export const HOST_SYSTEMD_UNIT = "team-memory-host.service";

/**
 * The Ollama aliases the personal profile knows, each with the one base model it
 * must be created from. A new install starts on the 4B alias. The 8B alias is what
 * earlier installs created; their stored vectors were made by 8B, so that alias is
 * kept and is only ever (re)created from 8B.
 */
export const EMBEDDING_ALIASES = Object.freeze({
  "qwen3-embedding-4b-honcho-8192": "qwen3-embedding:4b",
  "qwen3-embedding-honcho-8192": "qwen3-embedding:8b",
});
export const DEFAULT_EMBEDDING_ALIAS = "qwen3-embedding-4b-honcho-8192";
const KNOWN_EMBEDDING_BASES = new Set(Object.values(EMBEDDING_ALIASES));

/** The base model a known alias is made from, or "" for an alias this table does not know. */
export function embeddingAliasBase(alias) {
  const name = String(alias || "").trim().replace(/:latest$/, "");
  return Object.hasOwn(EMBEDDING_ALIASES, name) ? EMBEDDING_ALIASES[name] : "";
}

/** The Modelfile an alias is created from. */
export function embeddingModelfile({ baseModel, contextLength }) {
  return `FROM ${baseModel}\nPARAMETER num_ctx ${contextLength}\n`;
}

/**
 * True when `ollama show --modelfile` output names a known Qwen3 base other than
 * the expected one on an uncommented FROM line. Blob paths and the commented
 * `# FROM <alias>` hint say nothing about the base, so they never count.
 */
function namesOtherKnownBase(modelfileText, baseModel) {
  for (const line of String(modelfileText || "").split(/\r?\n/)) {
    const match = line.match(/^\s*FROM\s+(\S+)\s*$/i);
    if (!match) continue;
    const named = match[1].replace(/:latest$/, "");
    if (KNOWN_EMBEDDING_BASES.has(named) && named !== baseModel) return true;
  }
  return false;
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function homeFor(env, fallback = os.homedir()) {
  return path.resolve(env.HONCHO_AGENT_BRIDGE_USER_HOME || env.HOME || env.USERPROFILE || fallback);
}

function appHomeFor(platform, env, homeDir) {
  if (env.HONCHO_AGENT_BRIDGE_HOME) return path.resolve(env.HONCHO_AGENT_BRIDGE_HOME);
  if (platform === "win32") return path.resolve(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "HonchoAgentBridge");
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "HonchoAgentBridge");
  return path.resolve(env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "honcho-agent-bridge");
}

export function resolveHostPaths({
  installedServerDir,
  platform = process.platform,
  env = process.env,
  homeDir = homeFor(env),
} = {}) {
  const appHome = appHomeFor(platform, env, homeDir);
  const serverDir = path.resolve(installedServerDir || env.HONCHO_AGENT_BRIDGE_SERVER_DIR || path.join(appHome, "server"));
  const runtimeDir = path.resolve(env.HONCHO_AGENT_BRIDGE_HOST_RUNTIME_DIR || path.join(path.dirname(serverDir), "runtime", "host"));
  const configFile = path.join(runtimeDir, "host-config.json");
  // How a CLI that exits finds the supervisor it started. Not OS registration.
  const pidFile = path.join(runtimeDir, "supervisor.pid.json");
  const logDir = path.join(runtimeDir, "logs");
  return {
    appHome,
    serverDir,
    runtimeDir,
    configFile,
    pidFile,
    logDir,
    gatewayDir: gatewayDirectory(serverDir),
    // The app's own Ollama, when this computer had none.
    ollamaDir: ollamaRuntimeDir(serverDir),
    supervisorFile: path.join(serverDir, "host", "supervisor.mjs"),
    // Mesh sharing: the forwarder the supervisor runs, the share state that turns it
    // on (share-manager's sharePaths().stateFile), and what the forwarder writes once
    // it listens.
    meshForwarderFile: path.join(serverDir, "host", "mesh-forwarder.mjs"),
    shareStateFile: path.join(path.dirname(serverDir), "runtime", "share.json"),
    meshStateFile: path.join(runtimeDir, "mesh-forwarder.json"),
    // Generated right before `ollama create`, from the alias's own base model.
    modelfileFor: (model) => path.join(runtimeDir, `${String(model).replace(/[^A-Za-z0-9._-]/g, "_")}.Modelfile`),
    profileFile: (profile) => path.join(serverDir, `host-profile.${profile}.json`),
  };
}

export function parseDotEnv(text) {
  const result = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'") value = value.slice(1, -1);
    else if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    result[match[1]] = value;
  }
  return result;
}

function assertNoSecretFields(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api[_-]?key|token|secret|password|credential|authorization)/i.test(key)) {
      throw new Error(`Host profile must not contain secret field: ${[...trail, key].join(".")}`);
    }
    if (item && typeof item === "object") assertNoSecretFields(item, [...trail, key]);
  }
}

function validModel(value, fallback) {
  const candidate = String(value || fallback || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,199}$/.test(candidate)) throw new Error("Host profile contains an invalid model identifier");
  return candidate;
}

function localServiceUrl(raw, fallback) {
  const source = String(raw || fallback || "").trim();
  const url = new URL(source);
  if (url.username || url.password) throw new Error("Host service URLs must not contain credentials");
  if (["host.docker.internal", "localhost", "0.0.0.0", "::1"].includes(url.hostname)) url.hostname = "127.0.0.1";
  if (!/^https?:$/.test(url.protocol)) throw new Error("Host service URL must use http or https");
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function firstEnvironment(environment, keys) {
  for (const key of keys) if (environment[key]) return environment[key];
  return "";
}

function isLocalEndpoint(value) {
  try { return ["127.0.0.1", "localhost", "host.docker.internal", "::1", "0.0.0.0"].includes(new URL(value).hostname); }
  catch { return false; }
}

function numberOption(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error("Host profile contains an invalid numeric setting");
  return parsed;
}

function keepAliveOption(value) {
  if (value === undefined || value === null || value === "" || value === "-1") return -1;
  if (value === -1 || value === 0 || value === "0") return Number(value);
  const candidate = String(value).trim();
  if (/^[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|ms|s|m|h)$/.test(candidate)) return candidate;
  throw new Error("Host profile contains an invalid Ollama keep-alive setting");
}

/**
 * Where the gateway is expected to answer. The gateway reports its real addresses
 * itself when it installs; these are what a plan can show before that.
 */
function deriveGateway(profileConfig, paths) {
  const input = profileConfig.gateway || {};
  const uiUrl = input.uiUrl === undefined ? DEFAULT_GATEWAY_UI_URL : loopbackUrl(input.uiUrl, { keepPath: true });
  const routerUrl = input.routerUrl === undefined ? DEFAULT_GATEWAY_ROUTER_URL : loopbackUrl(input.routerUrl, { keepPath: true });
  if (!uiUrl || !routerUrl) throw new Error("Host profile gateway addresses must be credential-free loopback URLs");
  return { directory: paths.gatewayDir, uiUrl, routerUrl };
}

/**
 * Pure topology derivation. Only model names, local endpoints, ports, and paths
 * survive this boundary; .env credentials are intentionally never copied.
 */
export function deriveHostTopology({
  environment = {},
  profileConfig = {},
  paths,
  platform = process.platform,
} = {}) {
  assertNoSecretFields(profileConfig);
  const gateway = deriveGateway(profileConfig, paths);
  const ollamaInput = profileConfig.ollama || {};
  const rawOllamaUrl = ollamaInput.baseUrl || firstEnvironment(environment, [
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL",
    "LLM_OPENAI_COMPATIBLE_BASE_URL",
  ]);
  const ollamaEnabled = ollamaInput.enabled ?? (Boolean(rawOllamaUrl) && isLocalEndpoint(rawOllamaUrl));
  if (ollamaEnabled && rawOllamaUrl && !isLocalEndpoint(rawOllamaUrl)) throw new Error("Managed Ollama must use a loopback endpoint");
  const ollamaUrl = localServiceUrl(rawOllamaUrl || "http://127.0.0.1:11434", "http://127.0.0.1:11434");
  const dimensions = numberOption(ollamaInput.dimensions || environment.EMBEDDING_VECTOR_DIMENSIONS, 1536, { min: 1, max: 65_536 });
  const contextLength = numberOption(ollamaInput.contextLength || environment.EMBEDDING_MAX_INPUT_TOKENS, 8192, { min: 256, max: 1_000_000 });
  // The vectors already stored were made by the alias the installed .env names, so
  // a known alias there wins over the bundled profile's (which is what a new
  // install gets). The alias's base model always comes from EMBEDDING_ALIASES.
  const installedModel = environment.EMBEDDING_MODEL_CONFIG__MODEL;
  const model = validModel(
    embeddingAliasBase(installedModel) ? String(installedModel).trim() : (ollamaInput.model || installedModel),
    DEFAULT_EMBEDDING_ALIAS,
  );
  return {
    format: FORMAT_VERSION,
    platform,
    gateway,
    ollama: {
      enabled: Boolean(ollamaEnabled),
      baseUrl: ollamaUrl,
      executable: String(ollamaInput.executable || "ollama"),
      model,
      baseModel: validModel(embeddingAliasBase(model) || ollamaInput.baseModel, EMBEDDING_ALIASES[DEFAULT_EMBEDDING_ALIAS]),
      contextLength,
      dimensions,
      keepAlive: keepAliveOption(ollamaInput.keepAlive),
      warmIntervalMs: numberOption(ollamaInput.warmIntervalMs, 300_000, { min: 15_000, max: 86_400_000 }),
      // How often the supervisor checks that `ollama serve` answers, and starts it when not.
      serviceCheckIntervalMs: numberOption(ollamaInput.serviceCheckIntervalMs, 15_000, { min: 1_000, max: 3_600_000 }),
      manageService: ollamaInput.manageService !== false,
      // True when the executable is the app's own download, which nothing else starts.
      owned: false,
    },
    state: {
      configFile: paths.configFile,
      pidFile: paths.pidFile,
      logDir: paths.logDir,
    },
    supervisorFile: paths.supervisorFile,
    ...(paths.shareStateFile && paths.meshForwarderFile && paths.meshStateFile
      ? { mesh: { shareStateFile: paths.shareStateFile, forwarderFile: paths.meshForwarderFile, stateFile: paths.meshStateFile } }
      : {}),
  };
}

function cmdArg(value) {
  const text = String(value);
  if (/[\r\n"%]/.test(text)) throw new Error("Windows command contains unsupported characters");
  return `"${text}"`;
}

export function windowsBatchInvocation(command, args, env = process.env) {
  const shell = env.ComSpec || path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const commandLine = [command, ...args].map(cmdArg).join(" ");
  return {
    command: shell,
    args: [`/d /s /v:off /c "${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function sanitizeError(error, fallback = "command failed") {
  const source = String(error?.stderr || error?.message || error || fallback);
  return source
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|hch)-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (text) => {
      try { const url = new URL(text); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "[redacted-url]"; }
    })
    .slice(0, 500);
}

async function defaultRun(command, args, options = {}) {
  try {
    const needsWindowsCommandShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const invocation = needsWindowsCommandShell
      ? windowsBatchInvocation(command, args, options.env || process.env)
      : { command, args, windowsVerbatimArguments: false };
    const result = await execFileAsync(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: options.timeout || 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, error: sanitizeError(error) };
  }
}

async function runWith(runner, command, args, options) {
  try {
    const result = await runner(command, args, options);
    return result?.ok === false ? result : { ok: true, stdout: result?.stdout || "", stderr: result?.stderr || "" };
  } catch (error) { return { ok: false, error: sanitizeError(error) }; }
}

async function resolveExecutable(command, platform, runner, env) {
  if (path.isAbsolute(command)) return (await exists(command)) ? path.resolve(command) : "";
  const locator = platform === "win32" ? "where.exe" : "which";
  const located = await runWith(runner, locator, [command], { env, timeout: 5_000 });
  if (!located.ok) return "";
  const candidate = String(located.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return candidate ? path.resolve(candidate) : "";
}

async function probeJson(fetchImpl, url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    let data = null;
    try { data = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, data };
  } catch { return { ok: false, status: null, data: null }; }
  finally { clearTimeout(timer); }
}

function modelNames(text) {
  return String(text || "").split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/, 1)[0]).filter(Boolean);
}

function hasModel(names, wanted) {
  const normalized = (value) => String(value).replace(/:latest$/, "");
  return names.some((name) => normalized(name) === normalized(wanted));
}

async function readInputs({ profile, profilePath, paths }) {
  const environmentPath = path.join(paths.serverDir, ".env");
  const environment = (await exists(environmentPath)) ? parseDotEnv(await fsp.readFile(environmentPath, "utf8")) : {};
  const candidate = path.resolve(profilePath || paths.profileFile(profile));
  let profileConfig = {};
  if (await exists(candidate)) {
    profileConfig = JSON.parse(await fsp.readFile(candidate, "utf8"));
    if (!profileConfig || typeof profileConfig !== "object" || Array.isArray(profileConfig)) throw new Error("Host profile must be a JSON object");
    assertNoSecretFields(profileConfig);
  }
  return { environmentPath, environment, profilePath: candidate, profileConfig, profileExists: await exists(candidate) };
}

function publicTopology(topology) {
  return {
    gateway: {
      directory: topology.gateway.directory,
      uiUrl: topology.gateway.uiUrl,
      routerUrl: topology.gateway.routerUrl,
    },
    ollama: {
      enabled: topology.ollama.enabled,
      baseUrl: topology.ollama.baseUrl,
      model: topology.ollama.model,
      baseModel: topology.ollama.baseModel,
      contextLength: topology.ollama.contextLength,
      dimensions: topology.ollama.dimensions,
    },
  };
}

/** Inspect the personal host runtime without changing the host. */
export async function hostPlan({
  profile = "personal",
  installedServerDir,
  profilePath,
  platform = process.platform,
  env = process.env,
  homeDir = homeFor(env),
  run = defaultRun,
  fetchImpl = globalThis.fetch,
  gatewaySourceInspector = null,
  arch = os.arch(),
  ollamaLocator = null,
} = {}) {
  const resolved = resolveHostPaths({ installedServerDir, platform, env, homeDir });
  const paths = { ...resolved, homeDir, env };
  const issues = [];
  const warnings = [];
  if (profile !== "personal") issues.push("The subscription gateway and Ollama host services are only defined for the personal profile");
  let inputs;
  try { inputs = await readInputs({ profile, profilePath, paths }); }
  catch (error) {
    return { ok: false, ready: false, profile, paths: resolved, issues: [sanitizeError(error)], warnings, operations: [] };
  }
  if (!(await exists(inputs.environmentPath)) && !inputs.profileExists) issues.push("Neither installed server/.env nor host-profile.personal.json exists");
  let topology;
  try { topology = deriveHostTopology({ environment: inputs.environment, profileConfig: inputs.profileConfig, paths, platform }); }
  catch (error) {
    return { ok: false, ready: false, profile, paths: resolved, issues: [sanitizeError(error)], warnings, operations: [] };
  }

  // The installed server's pin says which gateway this bundle expects.
  const gatewaySource = await (gatewaySourceInspector
    ? gatewaySourceInspector()
    : gatewaySourceProbe({ pinDirectory: resolved.serverDir, directory: topology.gateway.directory }));
  if (gatewaySource.state === "missing" && !gatewaySource.fetchable) {
    issues.push(`The subscription gateway cannot be installed: ${gatewaySource.reason}`);
  }
  if (gatewaySource.state === "stale" && !gatewaySource.fetchable) {
    issues.push(`The subscription gateway source cannot be updated: ${gatewaySource.reason}`);
  }
  if (gatewaySource.state === "external") {
    warnings.push(`${topology.gateway.directory} was not fetched by this installer; it is used as it is and never replaced`);
  }

  let ollamaExecutable = topology.ollama.enabled ? await resolveExecutable(topology.ollama.executable, platform, run, env) : "";
  let ollamaSource = ollamaExecutable ? "path" : "";
  if (topology.ollama.enabled && !ollamaExecutable && topology.ollama.executable === "ollama") {
    // Not on PATH: the Ollama apps' own CLIs, then the app's own copy.
    const located = await (ollamaLocator
      ? ollamaLocator({ platform, env, homeDir, ollamaDir: paths.ollamaDir })
      : locateOllama({ platform, env, homeDir, ollamaDir: paths.ollamaDir, which: () => null }));
    if (located) {
      ollamaExecutable = path.resolve(located.path);
      ollamaSource = located.source;
    }
  }
  if (ollamaExecutable) {
    topology.ollama.executable = ollamaExecutable;
    topology.ollama.owned = ollamaSource === "runtime"
      || path.dirname(ollamaExecutable) === path.resolve(paths.ollamaDir);
  }
  const ollamaInstall = topology.ollama.enabled && !ollamaExecutable
    ? ollamaDownload({ platform, arch, ollamaDir: paths.ollamaDir })
    : null;
  let ollama = { installed: false, running: false, version: "", models: [], baseModelPresent: false, aliasPresent: false, aliasMatches: false };
  if (topology.ollama.enabled) {
    const cli = ollamaExecutable
      ? await runWith(run, topology.ollama.executable, ["--version"], { env, timeout: 5_000 })
      : { ok: false, stdout: "", stderr: "" };
    const api = await probeJson(fetchImpl, `${topology.ollama.baseUrl}/api/version`);
    const list = cli.ok && api.ok ? await runWith(run, topology.ollama.executable, ["list"], { env, timeout: 10_000 }) : { ok: false, stdout: "" };
    const names = list.ok ? modelNames(list.stdout) : [];
    const aliasPresent = hasModel(names, topology.ollama.model);
    let aliasMatches = false;
    if (aliasPresent) {
      const shown = await runWith(run, topology.ollama.executable, ["show", "--modelfile", topology.ollama.model], { env, timeout: 10_000 });
      aliasMatches = shown.ok
        && new RegExp(`\\bPARAMETER\\s+num_ctx\\s+${topology.ollama.contextLength}\\b`, "i").test(shown.stdout)
        && !namesOtherKnownBase(shown.stdout, topology.ollama.baseModel);
    }
    ollama = {
      installed: cli.ok,
      running: api.ok,
      version: cli.ok ? String(cli.stdout || cli.stderr || "").trim().slice(0, 100) : "",
      models: names,
      baseModelPresent: hasModel(names, topology.ollama.baseModel),
      aliasPresent,
      aliasMatches,
    };
    if (!ollama.installed && ollamaInstall) {
      warnings.push(`Ollama is not installed; prepare downloads it from ${ollamaInstall.url} into ${ollamaInstall.destination}`);
    } else if (!ollama.installed && ollamaExecutable) {
      issues.push(`Ollama at ${ollamaExecutable} did not run (ollama --version failed)`);
    } else if (!ollama.installed) {
      issues.push(`Ollama is not installed, and this app has no Ollama download for ${platform} on ${arch}; install Ollama so that it is on PATH`);
    }
    if (topology.ollama.contextLength !== 8192 || !KNOWN_EMBEDDING_BASES.has(topology.ollama.baseModel)) {
      issues.push(`The personal host profile requires ${[...KNOWN_EMBEDDING_BASES].join(" or ")} with an 8192-token context`);
    }
    if (ollama.installed && !ollama.running) warnings.push("Ollama is installed but not running; prepare will try to start its local service");
  }
  if (!(await exists(paths.supervisorFile))) issues.push("The bundled host supervisor is missing");

  const operations = [];
  if (ollamaInstall) {
    operations.push({ type: "install-ollama", url: ollamaInstall.url, destination: ollamaInstall.destination, checksums: ollamaInstall.checksums });
  }
  if (gatewaySource.fetchable) {
    operations.push({
      type: gatewaySource.state === "stale" ? "update-gateway-source" : "fetch-gateway-source",
      ...gatewaySource.pin,
      directory: topology.gateway.directory,
    });
  }
  operations.push({ type: "gateway-install", directory: topology.gateway.directory, uiUrl: topology.gateway.uiUrl });
  if (topology.ollama.enabled && !ollama.baseModelPresent) operations.push({ type: "ollama-pull", model: topology.ollama.baseModel });
  if (topology.ollama.enabled && (!ollama.aliasPresent || !ollama.aliasMatches)) operations.push({ type: "ollama-create", model: topology.ollama.model, baseModel: topology.ollama.baseModel });
  operations.push({ type: "write-host-config", target: paths.configFile });
  const result = {
    ok: issues.length === 0,
    ready: issues.length === 0,
    profile,
    source: inputs.profileExists ? "host-profile" : "server-environment",
    profilePath: inputs.profileExists ? inputs.profilePath : null,
    paths: resolved,
    topology: publicTopology(topology),
    gateway: {
      source: gatewaySource,
      installed: await exists(gatewayCliPath(topology.gateway.directory)),
    },
    ollama,
    executables: { node: path.resolve(process.execPath), ollama: ollamaExecutable || null, ollamaOwned: topology.ollama.owned },
    issues,
    warnings,
    operations,
  };
  Object.defineProperty(result, "_internal", { value: { topology }, enumerable: false });
  return result;
}

async function writePrivateAtomic(target, content, mode, privateFileOptions) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, { mode });
  try {
    await securePrivateFile(temporary, privateFileOptions);
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function waitForOllama(fetchImpl, url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await probeJson(fetchImpl, `${url}/api/version`, 1_500)).ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function spawnDetached(spawnImpl, command, args, options) {
  const child = spawnImpl(command, args, { ...options, detached: true, stdio: "ignore", windowsHide: true });
  child.unref?.();
  return child;
}

/**
 * Fetch and install the gateway, prepare the Qwen alias, and write the host config.
 *
 * `server prepare` installs the gateway itself, before it builds the new bundle,
 * because it needs the gateway's router key for that bundle's .env. It passes
 * `skipGateway` so the gateway's install does not run twice.
 */
export async function hostPrepare(options = {}) {
  const run = options.run || defaultRun;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnImpl = options.spawnImpl || nodeSpawn;
  let plan = await hostPlan({ ...options, run, fetchImpl });
  if (!plan.ready) {
    // A stopped Ollama daemon is recoverable during preparation; all other
    // readiness issues must remain non-mutating.
    return { ...plan, _internal: undefined };
  }
  const { topology } = plan._internal;
  const actions = [];
  await fsp.mkdir(topology.state.logDir, { recursive: true });

  let gateway = null;
  if (!options.skipGateway) {
    gateway = await prepareGateway({
      pinDirectory: plan.paths.serverDir,
      directory: topology.gateway.directory,
      sourceFetcher: options.gatewaySourceFetcher,
      runner: options.gatewayRunner,
      env: options.env,
    });
    if (!gateway.ok) {
      return { ok: false, ready: false, profile: plan.profile, issues: [gateway.error], warnings: plan.warnings, actions, gateway };
    }
    if (gateway.source?.fetched || gateway.source?.updated) {
      actions.push({ type: gateway.source.updated ? "update-gateway-source" : "fetch-gateway-source", commit: gateway.source.commit, changed: true });
    }
    actions.push({ type: "gateway-install", autostart: gateway.autostart, changed: true });
  }

  const installOperation = topology.ollama.enabled && plan.operations.find((item) => item.type === "install-ollama");
  if (installOperation) {
    const installed = await (options.ollamaInstaller || installOllama)({
      platform: options.platform || process.platform,
      arch: options.arch || os.arch(),
      env: options.env || process.env,
      ollamaDir: installOperation.destination,
      fetchImpl: options.downloadFetch || fetchImpl,
      run,
    });
    if (!installed.ok) {
      return { ok: false, ready: false, profile: plan.profile, issues: installed.issues, warnings: plan.warnings, actions };
    }
    actions.push(installed.action);
    plan = await hostPlan({ ...options, run, fetchImpl });
    if (!plan.ready || !plan.executables?.ollama) {
      return { ok: false, ready: false, profile: plan.profile, issues: plan.issues?.length ? plan.issues : ["The downloaded Ollama was not found after installing it"], warnings: plan.warnings, actions };
    }
    Object.assign(topology.ollama, plan._internal.topology.ollama);
  }

  if (topology.ollama.enabled) {
    if (!plan.ollama.running) {
      try {
        spawnDetached(spawnImpl, topology.ollama.executable, ["serve"], {
          env: { ...(options.env || process.env), OLLAMA_HOST: new URL(topology.ollama.baseUrl).host },
          cwd: plan.paths.runtimeDir,
        });
      } catch {
        return { ok: false, ready: false, profile: plan.profile, issues: ["Ollama is installed but its local service could not be started"], warnings: plan.warnings, actions };
      }
      if (!(await waitForOllama(fetchImpl, topology.ollama.baseUrl))) {
        return { ok: false, ready: false, profile: plan.profile, issues: ["Ollama did not become ready in time"], warnings: plan.warnings, actions };
      }
      actions.push({ type: "ollama-serve", changed: true });
      const refreshed = await hostPlan({ ...options, run, fetchImpl });
      if (refreshed.ready && !refreshed.operations.some((item) => item.type === "install-ollama")) plan = refreshed;
    }
    if (!plan.ollama.baseModelPresent) {
      const pulled = await runWith(run, topology.ollama.executable, ["pull", topology.ollama.baseModel], { env: options.env || process.env, timeout: 3_600_000 });
      if (!pulled.ok) return { ok: false, ready: false, profile: plan.profile, issues: ["The Qwen3 embedding base model could not be pulled"], warnings: plan.warnings, actions };
      actions.push({ type: "ollama-pull", model: topology.ollama.baseModel, changed: true });
    }
    if (!plan.ollama.aliasPresent || !plan.ollama.aliasMatches) {
      // The Modelfile is written from the alias's own base right before the create,
      // so an alias is never made from another model than the one its vectors need.
      const modelfile = plan.paths.modelfileFor(topology.ollama.model);
      await writePrivateAtomic(modelfile, embeddingModelfile(topology.ollama), 0o600, {
        platform: options.platform || process.platform,
        run,
        env: options.env || process.env,
      });
      const created = await runWith(run, topology.ollama.executable, ["create", topology.ollama.model, "-f", modelfile], { env: options.env || process.env, timeout: 600_000 });
      if (!created.ok) return { ok: false, ready: false, profile: plan.profile, issues: ["The Qwen3 8192 model alias could not be created"], warnings: plan.warnings, actions };
      actions.push({ type: "ollama-create", model: topology.ollama.model, baseModel: topology.ollama.baseModel, changed: true });
    }
  }

  const runtimeConfig = {
    format: FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    profile: plan.profile,
    gateway: topology.gateway,
    ollama: topology.ollama,
    state: topology.state,
    supervisorFile: topology.supervisorFile,
    mesh: topology.mesh,
  };
  await writePrivateAtomic(topology.state.configFile, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 0o600, {
    platform: options.platform || process.platform,
    run,
    env: options.env || process.env,
  });
  actions.push({ type: "write-host-config", changed: true });
  return {
    ok: true,
    ready: true,
    profile: plan.profile,
    paths: plan.paths,
    topology: publicTopology(topology),
    configFile: topology.state.configFile,
    actions,
    warnings: plan.warnings,
    ...(gateway ? { gateway } : {}),
  };
}

async function readRuntimeConfig(paths) {
  try {
    const value = JSON.parse(await fsp.readFile(paths.configFile, "utf8"));
    if (value?.format !== FORMAT_VERSION) return null;
    return value;
  } catch { return null; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function pidState(pidFile) {
  try {
    const record = JSON.parse(await fsp.readFile(pidFile, "utf8"));
    return { record, running: processAlive(record.pid) };
  } catch { return { record: null, running: false }; }
}

async function readJsonFile(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

/**
 * The Mesh forwarder the supervisor runs while Mesh sharing is on: whether the
 * share state turns it on, its port, and whether a forwarder listens on that port.
 * Files and a PID check only.
 */
export async function meshForwarderStatus(paths, config = null) {
  const shareStateFile = config?.mesh?.shareStateFile || paths.shareStateFile;
  const stateFile = config?.mesh?.stateFile || paths.meshStateFile;
  const [share, record] = await Promise.all([readJsonFile(shareStateFile), readJsonFile(stateFile)]);
  const mesh = share?.mesh && typeof share.mesh === "object" ? share.mesh : null;
  const port = Number.isInteger(mesh?.port) ? mesh.port : null;
  const pid = Number.isInteger(record?.pid) ? record.pid : null;
  const running = Boolean(pid && processAlive(pid) && (!port || record.port === port));
  return {
    enabled: mesh?.enabled === true,
    port,
    running,
    pid: running ? pid : null,
    // An older host config has no mesh files, so its supervisor cannot run the forwarder.
    supported: Boolean(config ? config.mesh : true),
  };
}

/** The gateway answered and has nobody logged in, so its router has nothing to route to. */
function gatewayNeedsLogin(status) {
  return status?.gateway?.installed === true && status.gateway.ok === false && status.gateway.loggedIn === false;
}

// ---------------------------------------------------------------- autostart

/** What follows node on the supervisor's command line, for `host start` and every autostart. */
export function supervisorArguments({ supervisorFile, configFile, logDir }) {
  return [supervisorFile, "--config", configFile, "--log", path.join(logDir, "supervisor.log")];
}

function autostartContext(options) {
  const env = options.env || process.env;
  return {
    platform: options.platform || process.platform,
    env,
    homeDir: path.resolve(options.homeDir || homeFor(env)),
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    // {code, stdout, stderr} like share-manager's `run`; `run` here is the Ollama runner.
    run: options.autostartRunner || runCommand,
    sleep: options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

/**
 * The OLLAMA_* settings (OLLAMA_MODELS, say) `host start` hands the supervisor
 * through its environment. A login autostart has no shell to inherit them from, so
 * launchd and systemd get them written down. OLLAMA_HOST comes from the host config,
 * and anything named like a credential stays out.
 */
function supervisorEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => /^OLLAMA_/i.test(key)
    && key.toUpperCase() !== "OLLAMA_HOST"
    && !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key)
    && typeof value === "string" && value && !/[\r\n]/.test(value)));
}

/** The supervisor's login autostart on this platform, or null where there is none. */
export function hostAutostartSpec(ctx, { nodePath, supervisorFile, configFile, logDir, runtimeDir }) {
  const programArguments = [nodePath, ...supervisorArguments({ supervisorFile, configFile, logDir })];
  // The supervisor logs to --log itself; this catches only what node prints when it
  // cannot run the supervisor at all.
  const errorLog = path.join(logDir, "supervisor.error.log");
  if (ctx.platform === "darwin") {
    return launchAgent({
      label: HOST_LAUNCHD_LABEL,
      homeDir: ctx.homeDir,
      uid: ctx.uid,
      programArguments,
      workingDirectory: runtimeDir,
      stderrPath: errorLog,
      // Restarted after a crash (a non-zero exit or a signal), never after exit 0. A
      // copy that finds another supervisor running exits 0 at once, and so does a
      // deliberate stop, so KeepAlive cannot spin on either. A plain `KeepAlive: true`
      // would relaunch that duplicate every ten seconds for as long as the other runs.
      keepAlive: { SuccessfulExit: false },
      environment: { HOME: ctx.homeDir, ...supervisorEnvironment(ctx.env) },
    });
  }
  if (ctx.platform === "win32") {
    return windowsRun({
      env: ctx.env,
      subject: "host supervisor",
      valueName: HOST_RUN_VALUE,
      vbsPath: path.join(runtimeDir, "supervisor.vbs"),
      workingDirectory: runtimeDir,
      commandLine: programArguments,
      comments: [
        "Team Memory: starts this computer's host supervisor (keeps the embedding model loaded) at logon, with no window.",
        "Written by `cli.mjs host start`; `cli.mjs host stop` removes it.",
      ],
    });
  }
  if (ctx.platform === "linux") {
    return systemdUnit({
      env: ctx.env,
      homeDir: ctx.homeDir,
      subject: "host supervisor",
      unitName: HOST_SYSTEMD_UNIT,
      comment: "Written by `cli.mjs host start`; `cli.mjs host stop` removes it.",
      description: "Team Memory host supervisor (keeps the embedding model loaded)",
      workingDirectory: runtimeDir,
      execStart: programArguments,
      environment: supervisorEnvironment(ctx.env),
      stderrPath: errorLog,
      // Same reasoning as launchd's SuccessfulExit: only a failure is restarted.
      restart: "on-failure",
      restartSec: 10,
    });
  }
  return null;
}

function hostAutostartFor(options, paths, config) {
  const ctx = autostartContext(options);
  const spec = hostAutostartSpec(ctx, {
    nodePath: options.nodePath || process.execPath,
    supervisorFile: config?.supervisorFile || paths.supervisorFile,
    configFile: config?.state?.configFile || paths.configFile,
    logDir: config?.state?.logDir || paths.logDir,
    runtimeDir: paths.runtimeDir,
  });
  return { ctx, spec };
}

function autostartError(error) {
  // A test that forgot its fake runner must fail, not pass with a warning.
  if (error?.code === UNDER_TEST_ERROR) throw error;
  return sanitizeError(error, "the login autostart could not be changed");
}

async function registeredNow(ctx, spec) {
  try { return await autostartRegistered(ctx, spec); }
  catch (error) { autostartError(error); return false; }
}

/**
 * Registers the supervisor's autostart. launchd and systemd start the supervisor
 * through it when none runs (`started`); on Windows the Run value only takes effect
 * at the next logon, so `host start` starts this one itself, with the same command.
 */
async function registerHostAutostart(ctx, spec, { supervisorRunning }) {
  if (!spec) return { registered: false, kind: null, started: false, error: `There is no login autostart for ${ctx.platform}` };
  try {
    if (spec.kind === "launchd") {
      const installed = await installLaunchAgent(ctx, spec);
      let started = installed.started;
      // Loaded and unchanged, but not running (stopped by hand, say): start it now.
      if (!started && !supervisorRunning) {
        await kickstartLaunchAgent(ctx, spec);
        started = true;
      }
      return { registered: true, kind: spec.kind, path: installed.path, changed: installed.changed, started };
    }
    if (spec.kind === "systemd") {
      const installed = await installSystemdUnit(ctx, spec);
      return { registered: true, kind: spec.kind, path: installed.path, changed: installed.changed, started: installed.started };
    }
    const installed = await registerWindowsRun(ctx, spec);
    return { registered: true, kind: spec.kind, path: installed.path, changed: installed.changed, started: false };
  } catch (error) {
    const message = autostartError(error);
    return { registered: await registeredNow(ctx, spec), kind: spec.kind, started: false, error: message };
  }
}

/** Removes the supervisor's autostart. launchd and systemd stop the supervisor as they do. */
async function unregisterHostAutostart(ctx, spec) {
  if (!spec) return { registered: false, kind: null, removed: false };
  const wasRegistered = await registeredNow(ctx, spec);
  try {
    if (spec.kind === "launchd") await uninstallLaunchAgent(ctx, spec);
    else if (spec.kind === "systemd") await uninstallSystemdUnit(ctx, spec);
    else await unregisterWindowsRun(ctx, spec);
    return { registered: false, kind: spec.kind, removed: wasRegistered };
  } catch (error) {
    const message = autostartError(error);
    return { registered: await registeredNow(ctx, spec), kind: spec.kind, removed: false, error: message };
  }
}

async function hostAutostartStatus(options, paths, config) {
  const { ctx, spec } = hostAutostartFor(options, paths, config);
  if (!spec) return { registered: false, kind: null };
  return { registered: await registeredNow(ctx, spec), kind: spec.kind };
}

/**
 * Prepare (the gateway included) and start the personal host supervisor.
 *
 * The supervisor gets a per-user login autostart (see the top of this file), and
 * starts through it now where the OS can do that (launchd, systemd); on Windows,
 * or when the autostart cannot be registered, it is spawned directly and detached
 * with the same command, which is reported in `autostart.error` and `warnings`.
 * Either way it outlives the terminal or the UI process that pressed the button,
 * and is found again through its PID file. The gateway's own install registers the
 * gateway's own autostart.
 */
export async function hostStart(options = {}) {
  const prepared = options.skipPrepare
    ? { ok: true, ready: true }
    : await hostPrepare(options);
  if (!prepared.ready) return prepared;
  const paths = resolveHostPaths(options);
  const config = await readRuntimeConfig(paths);
  if (!config) return { ok: false, ready: false, issues: ["Host runtime config was not generated"] };
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const existing = await pidState(config.state.pidFile);
  let started = false;
  let ollamaRestarted = false;
  // The app's own Ollama has nothing else to start it. A supervisor that is already
  // running brings it back on its next check; this brings it back now. A supervisor
  // about to be started starts it itself.
  if (existing.running && config.ollama?.enabled && config.ollama.owned && config.ollama.manageService !== false) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (!(await probeJson(fetchImpl, `${config.ollama.baseUrl}/api/version`)).ok) {
      try {
        spawnDetached(spawnImpl, config.ollama.executable, ["serve"], {
          env: { ...(options.env || process.env), OLLAMA_HOST: new URL(config.ollama.baseUrl).host },
          cwd: paths.runtimeDir,
        });
        ollamaRestarted = true;
      } catch {
        // The supervisor's own check tries again.
      }
    }
  }
  await fsp.mkdir(config.state.logDir, { recursive: true });
  const { ctx: autostartCtx, spec } = hostAutostartFor(options, paths, config);
  const registration = await registerHostAutostart(autostartCtx, spec, { supervisorRunning: existing.running });
  let startedBy = null;
  if (!existing.running) {
    if (registration.started) startedBy = registration.kind;
    else {
      try {
        spawnDetached(spawnImpl, options.nodePath || process.execPath,
          supervisorArguments({ supervisorFile: config.supervisorFile, configFile: config.state.configFile, logDir: config.state.logDir }),
          { cwd: paths.runtimeDir, env: options.env || process.env });
        startedBy = "spawn";
      } catch (error) {
        return { ok: false, ready: false, issues: [sanitizeError(error, "the host supervisor could not be started")], autostart: registration };
      }
    }
    started = true;
  }
  const autostart = {
    registered: registration.registered,
    kind: registration.kind,
    ...(registration.path ? { path: registration.path } : {}),
    ...(registration.changed !== undefined ? { changed: registration.changed } : {}),
    ...(registration.error ? { error: registration.error } : {}),
  };
  const deadline = Date.now() + (options.startTimeoutMs ?? 180_000);
  const pollMs = options.statusPollMs ?? 1_000;
  let status = await hostStatus(options);
  // Waiting for a router with no login behind it would only run out the clock.
  while (!status.ok && !gatewayNeedsLogin(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    status = await hostStatus(options);
  }
  const loginNeeded = gatewayNeedsLogin(status);
  return {
    ...status,
    autostart,
    ...(registration.error
      ? { warnings: [`The host supervisor has no login autostart, so it will not come back after a reboot by itself: ${registration.error}`] }
      : {}),
    prepared: true,
    started,
    ...(startedBy ? { startedBy } : {}),
    alreadyRunning: existing.running,
    ...(ollamaRestarted ? { ollamaRestarted } : {}),
    timedOut: !status.ok && !loginNeeded,
    ...(loginNeeded
      ? { nextAction: gatewayLoginAction(status.gateway.ui?.url || config.gateway?.uiUrl, "run host start again") }
      : {}),
  };
}

/**
 * The gateway's own status plus the supervisor and Ollama. Only booleans and
 * non-secret topology are reported; response bodies are discarded.
 */
export async function hostStatus(options = {}) {
  const paths = resolveHostPaths(options);
  const gateway = await gatewayStatus({ directory: paths.gatewayDir, runner: options.gatewayRunner, env: options.env });
  const config = await readRuntimeConfig(paths);
  const autostart = await hostAutostartStatus(options, paths, config);
  if (!config) return { ok: false, installed: false, running: false, gateway, autostart, paths };
  const pid = await pidState(config.state.pidFile);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const ollamaHealth = config.ollama.enabled ? await probeJson(fetchImpl, `${config.ollama.baseUrl}/api/version`) : { ok: true, status: null };
  let resident = !config.ollama.enabled;
  if (config.ollama.enabled && ollamaHealth.ok) {
    const ps = await probeJson(fetchImpl, `${config.ollama.baseUrl}/api/ps`);
    resident = Boolean(ps.ok && Array.isArray(ps.data?.models) && ps.data.models.some((item) => hasModel([item.name || item.model], config.ollama.model)));
  }
  const running = pid.running;
  return {
    ok: running && gateway.ok && ollamaHealth.ok && resident,
    installed: true,
    running,
    supervisor: { pid: pid.record?.pid || null, processAlive: pid.running },
    gateway,
    ollama: { enabled: config.ollama.enabled, healthy: ollamaHealth.ok, status: ollamaHealth.status, model: config.ollama.model, resident },
    // Reported, never part of `ok`: `host start` waits for `ok`, and the forwarder is
    // only wanted while Mesh sharing is on.
    mesh: await meshForwarderStatus(paths, config),
    autostart,
    paths,
  };
}

/**
 * Remove the supervisor's login autostart, stop the supervisor, and unload only its
 * embedding model. The gateway is left running: it has its own lifecycle, and
 * `gateway/cli.mjs uninstall` in its directory is what removes it.
 */
export async function hostStop(options = {}) {
  const paths = resolveHostPaths(options);
  const config = await readRuntimeConfig(paths);
  const initialPid = config ? await pidState(config.state.pidFile) : { record: null, running: false };
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  // First, so nothing starts the supervisor again; launchd and systemd stop it here.
  const { ctx: autostartCtx, spec } = hostAutostartFor(options, paths, config);
  const autostart = await unregisterHostAutostart(autostartCtx, spec);
  const autostartWarning = autostart.error
    ? `The login autostart could not be removed, so the supervisor may start again at the next login: ${autostart.error}`
    : null;
  if (!config) {
    return {
      ok: !autostart.error,
      stopped: false,
      reason: "host runtime is not installed",
      autostart,
      ...(autostartWarning ? { warning: autostartWarning } : {}),
    };
  }
  const run = options.run || defaultRun;
  const env = options.env || process.env;
  const isProcessAlive = options.isProcessAlive || processAlive;
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const originalPid = Number(initialPid.record?.pid || 0);
  const identityMatches = initialPid.record?.configFile === config.state.configFile
    && initialPid.record?.supervisorFile === config.supervisorFile;
  const originalRunning = originalPid > 0 && isProcessAlive(originalPid);
  const gracefulDeadline = Date.now() + (options.gracefulStopTimeoutMs ?? 3_000);
  while (originalRunning && isProcessAlive(originalPid) && Date.now() < gracefulDeadline) {
    await wait(options.stopPollMs ?? 150);
  }
  let signaled = false;
  let signalFailed = false;
  if (originalRunning && isProcessAlive(originalPid) && identityMatches) {
    try {
      if ((options.platform || process.platform) === "win32") {
        const killed = await runWith(run, "taskkill", ["/PID", String(originalPid), "/T", "/F"], { env, timeout: 10_000 });
        signaled = killed.ok;
        signalFailed = !killed.ok;
      } else {
        (options.killProcess || process.kill)(originalPid, "SIGTERM");
        signaled = true;
      }
    } catch { signalFailed = true; }
  }
  if (signaled) {
    const forcedDeadline = Date.now() + (options.forcedStopTimeoutMs ?? 5_000);
    while (isProcessAlive(originalPid) && Date.now() < forcedDeadline) {
      await wait(options.stopPollMs ?? 150);
    }
  }
  if (config.ollama.enabled) await runWith(run, config.ollama.executable, ["stop", config.ollama.model], { env, timeout: 30_000 });
  const stopped = !originalRunning || !isProcessAlive(originalPid);
  return {
    ok: stopped && !autostart.error,
    stopped,
    signaled,
    preservedConfig: true,
    autostart,
    warning: originalRunning && !identityMatches
      ? "A stale PID was not signaled because its ownership could not be verified"
      : (!stopped && signalFailed ? "The host supervisor could not be terminated" : (!stopped ? "The host supervisor is still running" : autostartWarning)),
  };
}
