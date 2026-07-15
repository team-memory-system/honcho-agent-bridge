import { execFile, spawn as nodeSpawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { securePrivateFile } from "./private-file-permissions.mjs";

const execFileAsync = promisify(execFile);
const FORMAT_VERSION = 1;
const LABEL = "com.agent-memory.host";

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function homeFor(env, fallback = os.homedir()) {
  return path.resolve(env.AGENT_MEMORY_USER_HOME || env.HOME || env.USERPROFILE || fallback);
}

function appHomeFor(platform, env, homeDir) {
  if (env.AGENT_MEMORY_HOME) return path.resolve(env.AGENT_MEMORY_HOME);
  if (platform === "win32") return path.resolve(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "AgentMemory");
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "AgentMemory");
  return path.resolve(env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "agent-memory");
}

export function resolveHostPaths({
  installedServerDir,
  platform = process.platform,
  env = process.env,
  homeDir = homeFor(env),
} = {}) {
  const appHome = appHomeFor(platform, env, homeDir);
  const serverDir = path.resolve(installedServerDir || env.AGENT_MEMORY_SERVER_DIR || path.join(appHome, "server"));
  const runtimeDir = path.resolve(env.AGENT_MEMORY_HOST_RUNTIME_DIR || path.join(path.dirname(serverDir), "runtime", "host"));
  const configFile = path.join(runtimeDir, "host-config.json");
  const disabledFile = path.join(runtimeDir, "disabled");
  const pidFile = path.join(runtimeDir, "supervisor.pid.json");
  const logDir = path.join(runtimeDir, "logs");
  return {
    appHome,
    serverDir,
    runtimeDir,
    configFile,
    disabledFile,
    pidFile,
    logDir,
    supervisorFile: path.join(serverDir, "host", "supervisor.mjs"),
    modelfile: path.join(serverDir, "host", "qwen3-embedding-8192.Modelfile"),
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
 * Pure topology derivation. Only model names, local endpoints, ports, and paths
 * survive this boundary; .env credentials are intentionally never copied.
 */
export function deriveHostTopology({
  environment = {},
  profileConfig = {},
  paths,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  assertNoSecretFields(profileConfig);
  const proxyInput = profileConfig.codexProxy || {};
  const ollamaInput = profileConfig.ollama || {};
  const rawProxyUrl = proxyInput.baseUrl || firstEnvironment(environment, [
    "DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL",
    "SUMMARY_MODEL_CONFIG__OVERRIDES__BASE_URL",
    "LLM_VLLM_BASE_URL",
  ]);
  const rawOllamaUrl = ollamaInput.baseUrl || firstEnvironment(environment, [
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL",
    "LLM_OPENAI_COMPATIBLE_BASE_URL",
  ]);
  const proxyEnabled = proxyInput.enabled ?? (Boolean(rawProxyUrl) && isLocalEndpoint(rawProxyUrl));
  const ollamaEnabled = ollamaInput.enabled ?? (Boolean(rawOllamaUrl) && isLocalEndpoint(rawOllamaUrl));
  if (proxyEnabled && rawProxyUrl && !isLocalEndpoint(rawProxyUrl)) throw new Error("Managed Codex proxy must use a loopback endpoint");
  if (ollamaEnabled && rawOllamaUrl && !isLocalEndpoint(rawOllamaUrl)) throw new Error("Managed Ollama must use a loopback endpoint");
  const proxyUrl = localServiceUrl(rawProxyUrl || "http://127.0.0.1:11435", "http://127.0.0.1:11435");
  const ollamaUrl = localServiceUrl(rawOllamaUrl || "http://127.0.0.1:11434", "http://127.0.0.1:11434");
  const proxySourceDir = path.join(paths.serverDir, "honcho", "codex-openai-proxy");
  const dimensions = numberOption(ollamaInput.dimensions || environment.EMBEDDING_VECTOR_DIMENSIONS, 1536, { min: 1, max: 65_536 });
  const contextLength = numberOption(ollamaInput.contextLength || environment.EMBEDDING_MAX_INPUT_TOKENS, 8192, { min: 256, max: 1_000_000 });
  return {
    format: FORMAT_VERSION,
    platform,
    proxy: {
      enabled: Boolean(proxyEnabled),
      baseUrl: proxyUrl,
      port: numberOption(proxyInput.port || new URL(proxyUrl).port || 11435, 11435, { max: 65_535 }),
      defaultModel: validModel(proxyInput.defaultModel || environment.DERIVER_MODEL_CONFIG__MODEL, "gpt-5.6-sol"),
      authPath: path.resolve(proxyInput.authPath || environment.CODEX_AUTH_PATH || path.join(homeDir, ".codex", "auth.json")),
      sourceDir: proxySourceDir,
      entrypoint: path.join(proxySourceDir, "server.mjs"),
      packageFile: path.join(proxySourceDir, "package.json"),
      dependenciesPath: path.join(proxySourceDir, "node_modules", "@mariozechner", "pi-ai"),
    },
    ollama: {
      enabled: Boolean(ollamaEnabled),
      baseUrl: ollamaUrl,
      executable: String(ollamaInput.executable || "ollama"),
      model: validModel(ollamaInput.model || environment.EMBEDDING_MODEL_CONFIG__MODEL, "qwen3-embedding-honcho-8192"),
      baseModel: validModel(ollamaInput.baseModel, "qwen3-embedding:8b"),
      contextLength,
      dimensions,
      keepAlive: keepAliveOption(ollamaInput.keepAlive),
      warmIntervalMs: numberOption(ollamaInput.warmIntervalMs, 300_000, { min: 15_000, max: 86_400_000 }),
      manageService: ollamaInput.manageService !== false,
    },
    state: {
      configFile: paths.configFile,
      disabledFile: paths.disabledFile,
      pidFile: paths.pidFile,
      logDir: paths.logDir,
    },
    supervisorFile: paths.supervisorFile,
  };
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function systemdArg(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
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

function shellArg(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function startupAdapter({ kind, nodePath = process.execPath, topology, paths }) {
  const args = [topology.supervisorFile, "--config", topology.state.configFile];
  if (kind === "launchagent") {
    return {
      kind,
      label: LABEL,
      path: path.join(paths.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`),
      mode: 0o644,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key>\n  <array><string>${xml(nodePath)}</string><string>${xml(args[0])}</string><string>--config</string><string>${xml(args[2])}</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>10</integer>\n  <key>StandardOutPath</key><string>${xml(path.join(topology.state.logDir, "host.log"))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(topology.state.logDir, "host.error.log"))}</string>\n</dict>\n</plist>\n`,
    };
  }
  if (kind === "windows-task") {
    const launcherPath = path.join(paths.runtimeDir, "start-host.cmd");
    const taskArguments = `/d /s /v:off /c "${cmdArg(launcherPath)}"`;
    return {
      kind,
      label: "AgentMemoryHost",
      path: path.join(paths.runtimeDir, "AgentMemoryHost.task.xml"),
      mode: 0o600,
      encoding: "utf16le-bom",
      launcherPath,
      launcherMode: 0o600,
      launcherContent: `@echo off\r\nif exist ${cmdArg(topology.state.disabledFile)} exit /b 0\r\n${cmdArg(nodePath)} ${cmdArg(args[0])} --config ${cmdArg(args[2])} >> ${cmdArg(path.join(topology.state.logDir, "host.log"))} 2>&1\r\n`,
      content: [
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        "  <RegistrationInfo><Description>Agent Memory host services</Description></RegistrationInfo>",
        "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
        '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <StartWhenAvailable>true</StartWhenAvailable>",
        "    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>",
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "    <Enabled>true</Enabled>",
        "  </Settings>",
        `  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>${xml(taskArguments)}</Arguments><WorkingDirectory>${xml(paths.runtimeDir)}</WorkingDirectory></Exec></Actions>`,
        "</Task>",
        "",
      ].join("\r\n"),
    };
  }
  if (kind === "systemd-user") {
    const configHome = paths.env.XDG_CONFIG_HOME || path.join(paths.homeDir, ".config");
    return {
      kind,
      label: "agent-memory-host.service",
      path: path.join(configHome, "systemd", "user", "agent-memory-host.service"),
      mode: 0o644,
      content: `[Unit]\nDescription=Agent Memory host services\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${systemdArg(nodePath)} ${systemdArg(args[0])} --config ${systemdArg(args[2])}\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`,
    };
  }
  return {
    kind: "direct-fallback",
    label: "agent-memory-host",
    path: path.join(paths.runtimeDir, "start-host.sh"),
    mode: 0o700,
    content: `#!/bin/sh\n[ -e ${shellArg(topology.state.disabledFile)} ] && exit 0\nwhile [ ! -e ${shellArg(topology.state.disabledFile)} ]; do\n  ${shellArg(nodePath)} ${shellArg(args[0])} --config ${shellArg(args[2])} >>${shellArg(path.join(topology.state.logDir, "host.log"))} 2>&1\n  status=$?\n  [ "$status" -eq 0 ] && exit 0\n  sleep 10\ndone\n`,
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

async function inspectAuth(authPath) {
  if (!(await exists(authPath))) return { exists: false, valid: false, hasAccessToken: false, hasRefreshToken: false };
  try {
    const document = JSON.parse(await fsp.readFile(authPath, "utf8"));
    const hasAccessToken = typeof document?.tokens?.access_token === "string" && document.tokens.access_token.length > 0;
    const hasRefreshToken = typeof document?.tokens?.refresh_token === "string" && document.tokens.refresh_token.length > 0;
    return { exists: true, valid: hasAccessToken && hasRefreshToken, hasAccessToken, hasRefreshToken };
  } catch { return { exists: true, valid: false, hasAccessToken: false, hasRefreshToken: false }; }
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

async function chooseAdapter(platform, runner, env) {
  if (platform === "darwin") return "launchagent";
  if (platform === "win32") return "windows-task";
  const systemd = await runWith(runner, "systemctl", ["--user", "show-environment"], { env, timeout: 5_000 });
  return systemd.ok ? "systemd-user" : "direct-fallback";
}

function publicTopology(topology) {
  return {
    proxy: {
      enabled: topology.proxy.enabled,
      baseUrl: topology.proxy.baseUrl,
      port: topology.proxy.port,
      defaultModel: topology.proxy.defaultModel,
      authPath: topology.proxy.authPath,
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
} = {}) {
  const resolved = resolveHostPaths({ installedServerDir, platform, env, homeDir });
  const paths = { ...resolved, homeDir, env };
  const issues = [];
  const warnings = [];
  if (profile !== "personal") issues.push("Managed Codex and Ollama host services are only defined for the personal profile");
  let inputs;
  try { inputs = await readInputs({ profile, profilePath, paths }); }
  catch (error) {
    return { ok: false, ready: false, profile, paths: resolved, issues: [sanitizeError(error)], warnings, operations: [] };
  }
  if (!(await exists(inputs.environmentPath)) && !inputs.profileExists) issues.push("Neither installed server/.env nor host-profile.personal.json exists");
  let topology;
  try { topology = deriveHostTopology({ environment: inputs.environment, profileConfig: inputs.profileConfig, paths, platform, homeDir }); }
  catch (error) {
    return { ok: false, ready: false, profile, paths: resolved, issues: [sanitizeError(error)], warnings, operations: [] };
  }

  const adapterKind = await chooseAdapter(platform, run, env);
  const adapter = startupAdapter({ kind: adapterKind, nodePath: process.execPath, topology, paths });
  const auth = topology.proxy.enabled ? await inspectAuth(topology.proxy.authPath) : { exists: false, valid: false };
  const npmName = platform === "win32" ? "npm.cmd" : "npm";
  const pnpmName = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const npmExecutable = topology.proxy.enabled ? await resolveExecutable(npmName, platform, run, env) : "";
  const pnpmExecutable = topology.proxy.enabled ? await resolveExecutable(pnpmName, platform, run, env) : "";
  const ollamaExecutable = topology.ollama.enabled ? await resolveExecutable(topology.ollama.executable, platform, run, env) : "";
  if (ollamaExecutable) topology.ollama.executable = ollamaExecutable;
  const npm = topology.proxy.enabled && npmExecutable
    ? await runWith(run, npmExecutable, ["--version"], { env, timeout: 5_000 })
    : { ok: !topology.proxy.enabled };
  const pnpm = topology.proxy.enabled && pnpmExecutable
    ? await runWith(run, pnpmExecutable, ["--version"], { env, timeout: 5_000 })
    : { ok: false };
  const packageLock = path.join(topology.proxy.sourceDir, "package-lock.json");
  const shrinkwrap = path.join(topology.proxy.sourceDir, "npm-shrinkwrap.json");
  const pnpmLock = path.join(topology.proxy.sourceDir, "pnpm-lock.yaml");
  const npmLockFile = (await exists(shrinkwrap)) ? shrinkwrap : ((await exists(packageLock)) ? packageLock : null);
  const pnpmLockFile = (await exists(pnpmLock)) ? pnpmLock : null;
  const dependencyMode = pnpmLockFile
    ? (pnpm.ok ? "pnpm-frozen" : (npm.ok ? "npm-exec-pnpm-frozen" : "unavailable"))
    : (npmLockFile && npm.ok ? "npm-ci" : (npm.ok ? "npm-install-unlocked" : "unavailable"));
  const proxySource = {
    package: await exists(topology.proxy.packageFile),
    entrypoint: await exists(topology.proxy.entrypoint),
    dependenciesReady: await exists(topology.proxy.dependenciesPath),
    lockFile: pnpmLockFile || npmLockFile,
    dependencyMode,
  };
  if (topology.proxy.enabled) {
    if (!proxySource.package || !proxySource.entrypoint) issues.push("The installed Codex OpenAI proxy source is incomplete");
    if (dependencyMode === "unavailable") issues.push("Neither a compatible package manager nor npm fallback is available for the Codex proxy");
    if (!auth.exists) issues.push("Codex authentication was not found in the current user's home directory");
    else if (!auth.valid) issues.push("Codex authentication exists but does not contain usable access and refresh credentials");
    if (!inputs.environment.LLM_VLLM_API_KEY) issues.push("The installed server environment has no private Codex proxy shared secret");
  }

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
      aliasMatches = shown.ok && new RegExp(`\\bPARAMETER\\s+num_ctx\\s+${topology.ollama.contextLength}\\b`, "i").test(shown.stdout);
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
    if (!ollama.installed) issues.push("Ollama is not installed or is not available on PATH");
    if (!(await exists(paths.modelfile))) issues.push("The bundled Qwen3 8192 Modelfile is missing");
    if (topology.ollama.contextLength !== 8192 || topology.ollama.baseModel !== "qwen3-embedding:8b") {
      issues.push("The bundled personal host profile requires qwen3-embedding:8b with an 8192-token context");
    }
    if (ollama.installed && !ollama.running) warnings.push("Ollama is installed but not running; prepare will try to start its local service");
  }
  if (adapterKind === "direct-fallback") warnings.push("A systemd user session is unavailable; a managed direct-start fallback will be used");
  if (topology.proxy.enabled && !proxySource.dependenciesReady && dependencyMode === "npm-install-unlocked") {
    warnings.push("The proxy bundle has no supported lockfile; dependency installation will be non-reproducible");
  }
  if (!(await exists(paths.supervisorFile))) issues.push("The bundled host supervisor is missing");

  const operations = [];
  if (topology.proxy.enabled && !proxySource.dependenciesReady) operations.push({ type: "install-proxy-dependencies", mode: dependencyMode, directory: topology.proxy.sourceDir });
  if (topology.ollama.enabled && !ollama.baseModelPresent) operations.push({ type: "ollama-pull", model: topology.ollama.baseModel });
  if (topology.ollama.enabled && (!ollama.aliasPresent || !ollama.aliasMatches)) operations.push({ type: "ollama-create", model: topology.ollama.model });
  operations.push({ type: "write-host-config", target: paths.configFile }, { type: "write-startup-adapter", adapter: adapterKind, target: adapter.path });
  const result = {
    ok: issues.length === 0,
    ready: issues.length === 0,
    profile,
    source: inputs.profileExists ? "host-profile" : "server-environment",
    profilePath: inputs.profileExists ? inputs.profilePath : null,
    paths: resolved,
    topology: publicTopology(topology),
    auth,
    proxy: { ...proxySource, npmAvailable: npm.ok, pnpmAvailable: pnpm.ok, sharedSecretConfigured: Boolean(inputs.environment.LLM_VLLM_API_KEY) },
    ollama,
    executables: { node: path.resolve(process.execPath), npm: npmExecutable || null, pnpm: pnpmExecutable || null, ollama: ollamaExecutable || null },
    startup: { kind: adapterKind, path: adapter.path, label: adapter.label },
    issues,
    warnings,
    operations,
  };
  Object.defineProperty(result, "_internal", {
    value: { topology, adapter, sharedSecret: inputs.environment.LLM_VLLM_API_KEY || "" },
    enumerable: false,
  });
  return result;
}

async function writeAtomic(target, content, mode) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, { mode });
  await fsp.rename(temporary, target);
  await fsp.chmod(target, mode).catch(() => {});
}

export function encodeStartupContent(content, encoding) {
  if (encoding !== "utf16le-bom") return content;
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(content), "utf16le")]);
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

/** Install proxy dependencies, prepare the Qwen alias, and write host adapters. */
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
  const { topology, adapter, sharedSecret } = plan._internal;
  const actions = [];
  await fsp.mkdir(topology.state.logDir, { recursive: true });

  if (topology.proxy.enabled && !plan.proxy.dependenciesReady) {
    let executable = plan.executables.npm;
    let args;
    if (plan.proxy.dependencyMode === "pnpm-frozen") {
      executable = plan.executables.pnpm;
      args = ["install", "--frozen-lockfile", "--prod", "--ignore-scripts"];
    } else if (plan.proxy.dependencyMode === "npm-exec-pnpm-frozen") {
      args = ["exec", "--yes", "pnpm@10.14.0", "--", "install", "--frozen-lockfile", "--prod", "--ignore-scripts"];
    } else if (plan.proxy.dependencyMode === "npm-ci") {
      args = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
    } else {
      args = ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"];
    }
    const result = await runWith(run, executable, args, {
      cwd: topology.proxy.sourceDir,
      env: options.env || process.env,
      timeout: 600_000,
    });
    if (!result.ok) return { ok: false, ready: false, profile: plan.profile, issues: ["Codex proxy dependency installation failed"], warnings: plan.warnings, actions };
    actions.push({ type: "install-proxy-dependencies", mode: plan.proxy.dependencyMode, changed: true });
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
      if (refreshed.ready) plan = refreshed;
    }
    if (!plan.ollama.baseModelPresent) {
      const pulled = await runWith(run, topology.ollama.executable, ["pull", topology.ollama.baseModel], { env: options.env || process.env, timeout: 3_600_000 });
      if (!pulled.ok) return { ok: false, ready: false, profile: plan.profile, issues: ["The Qwen3 embedding base model could not be pulled"], warnings: plan.warnings, actions };
      actions.push({ type: "ollama-pull", model: topology.ollama.baseModel, changed: true });
    }
    if (!plan.ollama.aliasPresent || !plan.ollama.aliasMatches) {
      const created = await runWith(run, topology.ollama.executable, ["create", topology.ollama.model, "-f", plan.paths.modelfile], { env: options.env || process.env, timeout: 600_000 });
      if (!created.ok) return { ok: false, ready: false, profile: plan.profile, issues: ["The Qwen3 8192 model alias could not be created"], warnings: plan.warnings, actions };
      actions.push({ type: "ollama-create", model: topology.ollama.model, changed: true });
    }
  }

  const runtimeConfig = {
    format: FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    profile: plan.profile,
    proxy: { ...topology.proxy, sharedSecret },
    ollama: topology.ollama,
    state: topology.state,
    supervisorFile: topology.supervisorFile,
    startup: {
      kind: adapter.kind,
      path: adapter.path,
      label: adapter.label,
      launcherPath: adapter.launcherPath || null,
    },
  };
  await writePrivateAtomic(topology.state.configFile, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 0o600, {
    platform: options.platform || process.platform,
    run,
    env: options.env || process.env,
  });
  await writeAtomic(adapter.path, encodeStartupContent(adapter.content, adapter.encoding), adapter.mode);
  if (adapter.launcherPath) await writeAtomic(adapter.launcherPath, adapter.launcherContent, adapter.launcherMode);
  actions.push({ type: "write-host-config", changed: true }, { type: "write-startup-adapter", kind: adapter.kind, changed: true });
  return {
    ok: true,
    ready: true,
    profile: plan.profile,
    paths: plan.paths,
    topology: publicTopology(topology),
    startup: { kind: adapter.kind, path: adapter.path, label: adapter.label },
    configFile: topology.state.configFile,
    actions,
    warnings: plan.warnings,
  };
}

async function readRuntimeConfig(paths) {
  try {
    const value = JSON.parse(await fsp.readFile(paths.configFile, "utf8"));
    if (value?.format !== FORMAT_VERSION) return null;
    return value;
  } catch { return null; }
}

async function activateStartup(config, { run, spawnImpl, platform, env, taskStartupGraceMs }) {
  const startup = config.startup;
  if (startup.kind === "launchagent") {
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : env.UID}`;
    await runWith(run, "launchctl", ["bootout", domain, startup.path], { env, timeout: 10_000 });
    const loaded = await runWith(run, "launchctl", ["bootstrap", domain, startup.path], { env, timeout: 10_000 });
    if (!loaded.ok) return { ok: false, error: "LaunchAgent could not be loaded" };
    await runWith(run, "launchctl", ["kickstart", "-k", `${domain}/${startup.label}`], { env, timeout: 10_000 });
    return { ok: true, mode: startup.kind };
  }
  if (startup.kind === "systemd-user") {
    const reload = await runWith(run, "systemctl", ["--user", "daemon-reload"], { env, timeout: 10_000 });
    const enabled = reload.ok && await runWith(run, "systemctl", ["--user", "enable", "--now", startup.label], { env, timeout: 20_000 });
    if (!enabled?.ok) return { ok: false, error: "systemd user service could not be enabled" };
    return { ok: true, mode: startup.kind };
  }
  if (startup.kind === "windows-task") {
    const created = await runWith(run, "schtasks.exe", ["/Create", "/TN", startup.label, "/XML", startup.path, "/F"], { env, timeout: 20_000 });
    if (!created.ok) return { ok: false, error: "Windows user task could not be registered" };
    const launched = await runWith(run, "schtasks.exe", ["/Run", "/TN", startup.label], { env, timeout: 10_000 });
    if (launched.ok) {
      const deadline = Date.now() + taskStartupGraceMs;
      do {
        const pid = await pidState(config.state.pidFile);
        if (pid.running) return { ok: true, mode: startup.kind, scheduledLaunchRequested: true };
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (true);
    }
    try {
      const launcherPath = startup.launcherPath || path.join(path.dirname(startup.path), "start-host.cmd");
      const invocation = windowsBatchInvocation(launcherPath, [], env);
      spawnDetached(spawnImpl, invocation.command, invocation.args, {
        env,
        cwd: path.dirname(config.state.configFile),
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      return {
        ok: true,
        mode: "windows-task-direct-fallback",
        scheduledLaunchRequested: launched.ok,
      };
    } catch {
      return { ok: false, error: "Windows user task and direct host supervisor launch both failed" };
    }
  }
  try {
    spawnDetached(spawnImpl, startup.path, [], { env, cwd: path.dirname(config.state.configFile) });
    return { ok: true, mode: "direct-fallback" };
  } catch { return { ok: false, error: `Direct host supervisor start failed on ${platform}` }; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function pidState(pidFile) {
  try {
    const record = JSON.parse(await fsp.readFile(pidFile, "utf8"));
    const heartbeatAgeMs = Date.now() - new Date(record.heartbeatAt || record.startedAt || 0).getTime();
    return { record, running: processAlive(record.pid), heartbeatAgeMs };
  } catch { return { record: null, running: false, heartbeatAgeMs: null }; }
}

/** Prepare and start the personal host supervisor through the native user adapter. */
export async function hostStart(options = {}) {
  const prepared = options.skipPrepare
    ? { ok: true, ready: true, startup: null }
    : await hostPrepare(options);
  if (!prepared.ready) return prepared;
  const paths = resolveHostPaths(options);
  const config = await readRuntimeConfig(paths);
  if (!config) return { ok: false, ready: false, issues: ["Host runtime config was not generated"] };
  await fsp.rm(config.state.disabledFile, { force: true });
  const activation = await activateStartup(config, {
    run: options.run || defaultRun,
    spawnImpl: options.spawnImpl || nodeSpawn,
    platform: options.platform || process.platform,
    env: options.env || process.env,
    taskStartupGraceMs: options.taskStartupGraceMs ?? 3_000,
  });
  if (!activation.ok) return { ok: false, ready: false, issues: [activation.error], startup: prepared.startup };
  const deadline = Date.now() + (options.startTimeoutMs ?? 180_000);
  const pollMs = options.statusPollMs ?? 500;
  let status = await hostStatus(options);
  while (!status.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    status = await hostStatus(options);
  }
  return { ...status, prepared: true, activation, timedOut: !status.ok };
}

/** Report only booleans and non-secret topology; response bodies are discarded. */
export async function hostStatus(options = {}) {
  const paths = resolveHostPaths(options);
  const config = await readRuntimeConfig(paths);
  if (!config) return { ok: false, installed: false, running: false, disabled: await exists(paths.disabledFile), paths };
  const disabled = await exists(config.state.disabledFile);
  const pid = await pidState(config.state.pidFile);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const proxyHealth = config.proxy.enabled ? await probeJson(fetchImpl, `${config.proxy.baseUrl}/health`) : { ok: true, status: null };
  const ollamaHealth = config.ollama.enabled ? await probeJson(fetchImpl, `${config.ollama.baseUrl}/api/version`) : { ok: true, status: null };
  let resident = !config.ollama.enabled;
  if (config.ollama.enabled && ollamaHealth.ok) {
    const ps = await probeJson(fetchImpl, `${config.ollama.baseUrl}/api/ps`);
    resident = Boolean(ps.ok && Array.isArray(ps.data?.models) && ps.data.models.some((item) => hasModel([item.name || item.model], config.ollama.model)));
  }
  const adapterPresent = await exists(config.startup.path);
  const running = pid.running && pid.heartbeatAgeMs < 60_000;
  return {
    ok: !disabled && running && proxyHealth.ok && ollamaHealth.ok && resident,
    installed: true,
    running,
    disabled,
    supervisor: { pid: pid.record?.pid || null, processAlive: pid.running, heartbeatAgeMs: pid.heartbeatAgeMs },
    proxy: { enabled: config.proxy.enabled, healthy: proxyHealth.ok, status: proxyHealth.status, port: config.proxy.port, model: config.proxy.defaultModel },
    ollama: { enabled: config.ollama.enabled, healthy: ollamaHealth.ok, status: ollamaHealth.status, model: config.ollama.model, resident },
    startup: { kind: config.startup.kind, installed: adapterPresent, path: config.startup.path },
    paths,
  };
}

async function deactivateStartup(config, run, env) {
  if (config.startup.kind === "launchagent") {
    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : env.UID}`;
    await runWith(run, "launchctl", ["bootout", domain, config.startup.path], { env, timeout: 10_000 });
  } else if (config.startup.kind === "systemd-user") {
    await runWith(run, "systemctl", ["--user", "disable", "--now", config.startup.label], { env, timeout: 20_000 });
  } else if (config.startup.kind === "windows-task") {
    await runWith(run, "schtasks.exe", ["/End", "/TN", config.startup.label], { env, timeout: 10_000 });
  }
}

/** Disable auto-restart, stop the supervisor, and unload only its embedding model. */
export async function hostStop(options = {}) {
  const paths = resolveHostPaths(options);
  const config = await readRuntimeConfig(paths);
  const initialPid = config ? await pidState(config.state.pidFile) : { record: null, running: false, heartbeatAgeMs: null };
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await writeAtomic(paths.disabledFile, `${JSON.stringify({ disabledAt: new Date().toISOString() })}\n`, 0o600);
  if (!config) return { ok: true, stopped: false, disabled: true, reason: "host runtime is not installed" };
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
  await deactivateStartup(config, run, env);
  let signaled = false;
  let signalFailed = false;
  if (originalRunning && isProcessAlive(originalPid) && identityMatches && initialPid.heartbeatAgeMs < 60_000) {
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
    ok: stopped,
    stopped,
    disabled: true,
    signaled,
    preservedAdapter: true,
    preservedConfig: true,
    warning: originalRunning && !identityMatches
      ? "A stale PID was not signaled because its ownership could not be verified"
      : (!stopped && signalFailed ? "The host supervisor could not be terminated" : (!stopped ? "The host supervisor is still running" : null)),
  };
}
