import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_VERSION,
  collectFolders,
  configEnvironment,
  hostConfigPaths,
  installPaths,
  loadConfig,
  readJson,
  userHome,
} from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";
import { formatJson, formatRevealedToken, publicUrl, sanitizeUrlsInText } from "./redact.mjs";
import {
  ACCESS_CODE,
  ACCESS_ENV,
  accessRefusedMessage,
  configuredAccess,
  fetchHoncho,
  honchoHeaders,
  isCloudflareAccessBlock,
} from "./honcho-access.mjs";
import { VERSION } from "./version.mjs";
import { WRITE_TOOLS } from "./mcp-tool-defaults.mjs";
import {
  installedServerDir,
  installedServerPorts,
  serverPlan,
  serverPrepare,
  serverStart,
  serverStatus,
  serverStop,
  serverVerify,
} from "./server-manager.mjs";
import { hostPlan, hostPrepare, hostStart, hostStatus, hostStop } from "./host-manager.mjs";
import {
  shareDisable,
  shareEnable,
  shareEnableTeam,
  shareJoin,
  shareRotate,
  shareStatus,
  shareToken,
  TUNNEL_TOKEN_ENV,
} from "./share-manager.mjs";
import { gateDevices, gateGrants, gateStatePaths, readGateAccess } from "./gate-access.mjs";
import { syncScopes } from "./scope-sync.mjs";
import { TEAM_AUTH_ENV, teamAuthPaths, teamLoginStatus } from "./team-auth.mjs";
import { computerName, hubCall, madeTeam, teamMake } from "./team-hub.mjs";
import {
  API_TOKEN_ENV,
  INVITE_ENV,
  teammateAdd,
  teammateConnect,
  teammateDisconnect,
  teammateRemove,
  teammatesConnected,
  teammatesList,
  teammateUnshare,
} from "./team-access.mjs";
import { gatewayDirectory, gatewayOpen } from "./gateway.mjs";
import { hostPluginPlan, installHostPlugins } from "./host-plugins.mjs";
import { getProvider } from "./providers/index.mjs";
import {
  TARGET_ID,
  TARGET_PROVIDERS,
  TARGET_SECRET_ENV,
  configuredTargets,
  folderMatches,
  outsideCollectFolders,
  targetAccess,
  targetAgents,
  targetEnvironment,
  targetPaths,
  targetSummary,
  targetWorkspace,
  withoutTargetFilter,
} from "./targets.mjs";
import { dockerPathEnvironment, resolveDockerCli } from "./runtime-installer.mjs";
import { checkPrereqs, FEATURES, parseFeatures } from "./prereqs.mjs";
import { backupCommand } from "./backup.mjs";
import { transcriptFiles } from "./projects.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAIN_SCRIPT = path.join(SCRIPT_DIR, "main.mjs");
const CURRENT_HOOK_MARKER = "--managed-by honcho-agent-bridge";
const LEGACY_HOOK_MARKERS = ["codex-honcho-sync", "honcho-turn-gate"];

// The config fields 0.3.28 and before wrote for relaying someone else's shared
// bridge through this plugin's MCP server: its address, its token and its Cloudflare
// service token. Nothing reads them any more (a teammate's memory is now a remote MCP
// server in Claude Code and Codex, `teammates connect`). Setup no longer carries them
// over, and `bridge disconnect` removes them on a computer that never runs setup.
const OLD_RELAY_FIELDS = ["mcpBridgeUrl", "mcpBridgeToken", "accessClientId", "accessClientSecret"];

// Where setup reads the token for a Honcho server that requires one.
const HONCHO_API_TOKEN_ENV = "HONCHO_API_TOKEN";

function parseOptions(items) {
  const options = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith("--")) continue;
    const [name, inline] = item.slice(2).split(/=(.*)/s);
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) {
      options[key] = inline;
      continue;
    }
    const next = items[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

// Marks the one result whose purpose is to show a secret: `server share token`,
// which the local app shows so the owner can copy it to another computer.
const REVEALS_TOKEN = Symbol("reveals-token");

function printJson(value) {
  process.stdout.write(formatJson(value));
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readHostJson(target) {
  if (!(await pathExists(target))) return {};
  let value;
  try {
    value = JSON.parse(await fsp.readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`Refusing to modify invalid JSON settings at ${target}: ${error?.message || error}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Refusing to modify non-object JSON settings at ${target}`);
  }
  return value;
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * A server that requires a token answers /health with 401 without one, and one
 * behind Cloudflare Access refuses a machine without its service token.
 */
function authHeaders(config, extra = {}) {
  return honchoHeaders({ token: config?.honcho?.apiToken, access: configuredAccess(config) }, extra);
}

/**
 * One request to the memory server. Redirects are not followed off its origin, so
 * Access's redirect to its login page is seen for what it is.
 */
async function probeHoncho(baseUrl, apiPath, { headers = {}, timeoutMs = 1500, method = "GET", body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchHoncho(`${String(baseUrl).replace(/\/+$/, "")}${apiPath}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    if (await isCloudflareAccessBlock(response)) {
      const reason = accessRefusedMessage(baseUrl);
      return { ok: false, status: response.status, access: true, code: ACCESS_CODE, reason, error: reason };
    }
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: sanitizeUrlsInText(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

function probeHealth(baseUrl, config) {
  return probeHoncho(baseUrl, "/health", { headers: authHeaders(config) });
}

function probeWorkspaceAccess(config, timeoutMs = 2000) {
  return probeHoncho(config.honcho.baseUrl, "/v3/workspaces/list", {
    method: "POST",
    headers: authHeaders(config, { "Content-Type": "application/json", Accept: "application/json" }),
    body: "{}",
    timeoutMs,
  });
}

async function inspectConfiguration() {
  const configPath = installPaths().configPath;
  if (!(await pathExists(configPath))) return { ok: false, state: "missing", path: configPath, config: null };
  let document;
  try {
    document = JSON.parse(await fsp.readFile(configPath, "utf8"));
  } catch (error) {
    return { ok: false, state: "malformed", path: configPath, error: error?.message || String(error), config: null };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, state: "invalid-schema", path: configPath, config: null };
  }
  if (document.version !== CONFIG_VERSION) {
    return {
      ok: false,
      state: "wrong-version",
      path: configPath,
      expectedVersion: CONFIG_VERSION,
      actualVersion: document.version ?? null,
      config: null,
    };
  }
  const valid = collectsConversations(document);
  return { ok: valid, state: valid ? "valid" : "invalid-schema", path: configPath, config: valid ? document : null };
}

function collectsConversations(config) {
  return Boolean(config?.user?.peerId && config?.honcho?.baseUrl && config?.honcho?.workspaceId && config?.agents);
}

async function claudePluginStatus() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return { installed: true, enabled: true, source: "plugin-root" };
  const document = await readJson(path.join(userHome(), ".claude", "plugins", "installed_plugins.json"), {});
  const names = Object.keys(document?.plugins || {}).filter(
    (name) => name === "honcho-agent-bridge" || name.startsWith("honcho-agent-bridge@"),
  );
  const settings = await readJson(path.join(userHome(), ".claude", "settings.json"), {});
  const enabledPlugins = settings?.enabledPlugins || {};
  return {
    installed: names.length > 0,
    enabled: names.some((name) => enabledPlugins[name] === true),
    pluginIds: names,
    source: "user-settings",
  };
}

async function codexPluginStatus() {
  if (process.env.CODEX_PLUGIN_ROOT) return { installed: true, enabled: true, source: "plugin-root" };
  const configPath = path.join(userHome(), ".codex", "config.toml");
  let text = "";
  try {
    text = await fsp.readFile(configPath, "utf8");
  } catch {}
  const header = text.match(/^\[plugins\."(honcho-agent-bridge(?:@[^"]+)?)"\]\s*$/m);
  const remainder = header ? text.slice((header.index || 0) + header[0].length) : "";
  const nextSection = remainder.match(/^\[/m);
  const body = nextSection ? remainder.slice(0, nextSection.index) : remainder;
  const installed = Boolean(header);
  const enabled = installed && !/^enabled\s*=\s*false\s*$/m.test(body);
  return { installed, enabled, pluginId: header?.[1] || "", source: "user-settings", configPath };
}

function parseAgents(value, detected) {
  if (typeof value === "string") {
    return Object.fromEntries(
      ["codex", "claude"].map((name) => [name, value.split(",").map((item) => item.trim()).includes(name)]),
    );
  }
  return { codex: detected.codex, claude: detected.claude };
}

function optionString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * The Honcho address setup uses when none is given: the configured one, else the
 * server this plugin installed here (its port may not be 8001), else the default.
 */
async function defaultHonchoUrl(config) {
  if (config?.honcho?.baseUrl) return { url: config.honcho.baseUrl, source: "config" };
  const ports = await installedServerPorts(installedServerDir(config));
  if (ports.installed) return { url: `http://127.0.0.1:${ports.api}`, source: "installed-server" };
  return { url: "http://127.0.0.1:8001", source: "default" };
}

/**
 * Whether a local Honcho answering at `url` is this plugin's own Docker server.
 * Something else can hold the port - on one test machine it was an SSH tunnel to
 * another computer's Honcho - and must not be taken for the user's own server.
 * null when it cannot be told (not a loopback address, or no Docker).
 */
function managedByThisInstall(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!isLoopbackHostname(parsed.hostname)) return null;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  try {
    // The docker on PATH, else Docker Desktop's own copy.
    const cli = resolveDockerCli();
    const published = execFileSync(cli?.path || "docker", [
      "ps",
      "--filter", "label=com.docker.compose.project=honcho-agent-bridge",
      "--filter", "label=com.docker.compose.service=api",
      "--format", "{{.Ports}}",
    ], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: dockerPathEnvironment(cli) });
    return new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|::):${port}->`).test(published);
  } catch {
    return null;
  }
}

async function detect() {
  const paths = installPaths();
  const hostPaths = hostConfigPaths();
  const config = await loadConfig();
  const { url: honchoUrl, source: honchoUrlSource } = await defaultHonchoUrl(config);
  const [codexConfig, claudeConfig, codexSessions, codexPlugin, claudePlugin, honcho] = await Promise.all([
    pathExists(path.dirname(hostPaths.codex)),
    pathExists(path.dirname(hostPaths.claude)),
    pathExists(path.join(userHome(), ".codex", "sessions")),
    codexPluginStatus(),
    claudePluginStatus(),
    probeHealth(honchoUrl, config),
  ]);
  return {
    ok: true,
    version: VERSION,
    platform: process.platform,
    node: process.version,
    paths,
    configured: Boolean(config),
    agents: {
      codex: { detected: codexConfig || codexSessions, plugin: codexPlugin, configPath: hostPaths.codex },
      claude: { detected: claudeConfig, plugin: claudePlugin, configPath: hostPaths.claude },
    },
    honcho: {
      baseUrl: publicUrl(honchoUrl),
      source: honchoUrlSource,
      health: honcho,
      managedByThisInstall: honcho.ok ? managedByThisInstall(honchoUrl) : null,
    },
  };
}

async function setupPlan(options = {}) {
  const detected = await detect();
  const existing = await loadConfig();
  const detectedAgents = {
    codex: detected.agents.codex.detected,
    claude: detected.agents.claude.detected,
  };
  const agents = options.agents ? parseAgents(options.agents, detectedAgents) : { ...(existing?.agents || detectedAgents) };
  const baseUrl = optionString(options.honchoUrl, (await defaultHonchoUrl(existing)).url);
  // A server that requires a token (one on another computer, behind its own auth)
  // gets it from the environment: a command line is visible to every process. A
  // saved token belongs to the server it was saved for and never follows the
  // collector to another one.
  const envToken = String(process.env[HONCHO_API_TOKEN_ENV] || "").trim();
  const savedToken = existing?.honcho?.apiToken && sameOrigin(existing.honcho.baseUrl, baseUrl) ? existing.honcho.apiToken : "";
  const apiToken = envToken || savedToken;
  // The Cloudflare Access service token for a server behind Access. Same rules as
  // the token: environment only, kept for the same server, dropped for another one.
  const envAccessId = String(process.env[ACCESS_ENV.clientId] || "").trim();
  const envAccessSecret = String(process.env[ACCESS_ENV.clientSecret] || "").trim();
  const envAccessGiven = Boolean(envAccessId || envAccessSecret);
  const envAccess = envAccessId && envAccessSecret ? { clientId: envAccessId, clientSecret: envAccessSecret } : null;
  const existingAccess = configuredAccess(existing);
  const savedAccess = existingAccess && sameOrigin(existing.honcho.baseUrl, baseUrl) ? existingAccess : null;
  const access = envAccessGiven ? envAccess : savedAccess;
  const collect = collectChoice(options, existing);
  const config = {
    version: CONFIG_VERSION,
    user: { peerId: optionString(options.userPeer, existing?.user?.peerId || "") },
    honcho: {
      baseUrl,
      workspaceId: optionString(options.workspace, existing?.honcho?.workspaceId || "memory"),
      ...(apiToken ? { apiToken } : {}),
      ...(access ? { access } : {}),
    },
    agents,
    ...(collect.collect ? { collect: collect.collect } : {}),
    // Written by `target add|set|remove`. Setup rebuilds the rest of the file and
    // must not drop the other servers some folders also go to.
    ...(Array.isArray(existing?.targets) ? { targets: existing.targets } : {}),
    sources: {
      codex: {
        root: optionString(options.codexRoot, existing?.sources?.codex?.root || path.join(userHome(), ".codex", "sessions")),
      },
    },
    paths: {
      dataDir: optionString(options.dataDir, existing?.paths?.dataDir || installPaths(existing).dataDir),
    },
  };
  const paths = installPaths(config);
  const selectedAgents = Object.entries(agents).filter(([, enabled]) => enabled).map(([name]) => name);
  const issues = [...collect.issues];
  const warnings = [...collect.warnings];
  const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 18) issues.push("Node.js 18 or newer is required");
  if (!config.user.peerId.trim()) issues.push("user peer id is required");
  try {
    const url = new URL(config.honcho.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) issues.push("Honcho URL must use http or https");
    if (url.username || url.password || url.search || url.hash) {
      issues.push("Honcho URL must not contain credentials, query parameters, or a fragment; use the API token field for authentication");
    }
  } catch {
    issues.push("Honcho URL is invalid");
  }
  if (selectedAgents.length === 0) issues.push("at least one detected agent must be selected");
  const onCommandLine = Object.keys(options).filter((key) => /token|secret|clientid/i.test(key));
  const accessOnCommandLine = onCommandLine.filter((key) => /access|client/i.test(key));
  if (onCommandLine.length > accessOnCommandLine.length) {
    issues.push(`pass the API token through ${HONCHO_API_TOKEN_ENV}, not the command line`);
  }
  if (accessOnCommandLine.length) {
    issues.push(`pass the Cloudflare Access service token through ${ACCESS_ENV.clientId} and ${ACCESS_ENV.clientSecret}, not the command line`);
  }
  if (envAccessGiven && !envAccess) {
    issues.push(`the Cloudflare Access service token needs both ${ACCESS_ENV.clientId} and ${ACCESS_ENV.clientSecret}`);
  }
  if (existing?.honcho?.apiToken && !envToken && !savedToken) {
    warnings.push(`The API token saved for ${publicUrl(existing.honcho.baseUrl)} is not carried to ${publicUrl(baseUrl)}`);
  }
  if (existingAccess && !envAccessGiven && !savedAccess) {
    warnings.push(`The Cloudflare Access service token saved for ${publicUrl(existing.honcho.baseUrl)} is not carried to ${publicUrl(baseUrl)}`);
  }
  // Moving from a server elsewhere to one installed here: setup keeps the saved
  // address unless told otherwise, which the 2026-09-30 install test tripped on.
  const installedPorts = await installedServerPorts(installedServerDir(existing));
  const installedUrl = `http://127.0.0.1:${installedPorts.api}`;
  if (installedPorts.installed && !options.honchoUrl && !sameOrigin(baseUrl, installedUrl)) {
    warnings.push(`This computer has a Honcho server installed at ${installedUrl}, but collection goes to ${publicUrl(baseUrl)}. Pass --honcho-url ${installedUrl} to collect into this computer's server.`);
  }
  // A host without the plugin gets it installed by apply; one where it is turned
  // off is left off and warned about.
  const plugins = await hostPluginPlan(agents, {
    statuses: { codex: detected.agents.codex.plugin, claude: detected.agents.claude.plugin },
    home: userHome(),
  });
  for (const entry of plugins) {
    if (entry.state === "disabled") {
      warnings.push(`${entry.agent} collection is enabled, but the Honcho Agent Bridge plugin was not detected as enabled in ${entry.agent}`);
    }
    if (entry.state === "missing-cli") {
      warnings.push(`${entry.agent} collection is enabled, but the Honcho Agent Bridge plugin is not installed in ${entry.agent} and the ${entry.agent} command was not found; install it by running ${entry.commands.join(", then ")}`);
    }
  }
  // The address this plan writes, which is not always the one detect tried.
  const health = await probeHealth(config.honcho.baseUrl, config);
  const managed = health.ok ? managedByThisInstall(config.honcho.baseUrl) : null;
  if (health.access) warnings.push(health.reason);
  if (health.status === 401) {
    warnings.push(config.honcho.apiToken
      ? `${publicUrl(config.honcho.baseUrl)} rejected the API token; check the token for that server`
      : `${publicUrl(config.honcho.baseUrl)} requires an API token; set ${HONCHO_API_TOKEN_ENV} in your shell and run setup again`);
  }
  if (health.ok && managed === false) {
    warnings.push(`A Honcho server answers at ${publicUrl(config.honcho.baseUrl)}, but it is not the server this plugin installed on this computer (it may be a tunnel to another machine). Confirm it is yours before collecting into it.`);
  }
  return {
    ok: issues.length === 0,
    ready: issues.length === 0,
    version: VERSION,
    issues,
    warnings,
    choices: {
      selectedAgents,
      honchoMode: !health.ok ? "external-setup-required" : managed === false ? "connect-unknown-existing" : "connect-existing",
    },
    config,
    operations: [
      { type: "install-runtime", target: paths.runtimeDir },
      ...(agents.codex
        ? [{ type: "merge-hook", agent: "codex", target: hostConfigPaths().codex }]
        : [{ type: "remove-managed-hook", agent: "codex", target: hostConfigPaths().codex }]),
      ...(agents.claude
        ? [
            { type: "use-plugin-hook", agent: "claude", target: "hooks/claude-hooks.json" },
            { type: "remove-legacy-managed-hook", agent: "claude", target: hostConfigPaths().claude },
          ]
        : [{ type: "remove-legacy-managed-hook", agent: "claude", target: hostConfigPaths().claude }]),
      { type: "write-config", target: paths.configPath },
      ...((await pathExists(mcpToolsPath(paths)))
        ? []
        : [{ type: "write-mcp-tool-defaults", target: mcpToolsPath(paths), disabled: [...WRITE_TOOLS] }]),
      ...plugins
        .filter((entry) => entry.state === "install")
        .map(({ agent, source, ref, marketplace }) => ({ type: "install-plugin", agent, source, ...(ref ? { ref } : {}), marketplace })),
    ],
  };
}

function isManagedHookHandler(handler) {
  const command = typeof handler?.command === "string" ? handler.command : "";
  return command.includes(CURRENT_HOOK_MARKER) || LEGACY_HOOK_MARKERS.some((marker) => command.includes(marker));
}

/** A managed hook for this runtime whose node binary still exists, whatever PATH doctor runs with. */
function hasCurrentManagedHook(document, runtimeDir, provider) {
  const suffix = ` "${path.join(runtimeDir, "cli.mjs")}" hook ${provider} ${CURRENT_HOOK_MARKER}`;
  const current = (command) => {
    if (typeof command !== "string" || !command.endsWith(suffix)) return false;
    const node = command.slice(0, -suffix.length).match(/^"(.+)"$/)?.[1];
    return Boolean(node) && fs.existsSync(node);
  };
  return (document?.hooks?.Stop || []).some((entry) => {
    if (current(entry?.command)) return true;
    return Array.isArray(entry?.hooks) && entry.hooks.some((handler) => current(handler?.command));
  });
}

function mcpToolsPath(paths) {
  return path.join(paths.dataDir, "mcp-tools.json");
}

/**
 * The node the hook command names. process.execPath is the resolved binary, which
 * on this kind of install is a versioned folder (~/.local/opt/node-v24.19.0-...)
 * that disappears on upgrade; the PATH entry that resolves to it survives.
 */
function stableNodePath() {
  let target;
  try { target = fs.realpathSync(process.execPath); } catch { return process.execPath; }
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      if (fs.realpathSync(candidate) === target) return candidate;
    } catch {}
  }
  return process.execPath;
}

function hookCommand(runtimeDir, provider) {
  const cliPath = path.join(runtimeDir, "cli.mjs");
  return `"${stableNodePath()}" "${cliPath}" hook ${provider} ${CURRENT_HOOK_MARKER}`;
}

function mergeStopHook(document, provider, runtimeDir) {
  const next = structuredClone(document && typeof document === "object" ? document : {});
  next.hooks ||= {};
  const existing = Array.isArray(next.hooks.Stop) ? next.hooks.Stop : [];
  existing.push({
    hooks: [
      {
        type: "command",
        command: hookCommand(runtimeDir, provider),
        timeout: 120,
        statusMessage: `Syncing ${provider} conversation to personal memory`,
      },
    ],
  });
  next.hooks.Stop = existing;
  return next;
}

function removeManagedStopHooks(document) {
  const next = structuredClone(document && typeof document === "object" ? document : {});
  if (!next.hooks || !Array.isArray(next.hooks.Stop)) return next;
  next.hooks.Stop = next.hooks.Stop
    .map((entry) => {
      if (isManagedHookHandler(entry)) return null;
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return entry;
      const remainingHandlers = entry.hooks.filter((handler) => !isManagedHookHandler(handler));
      return remainingHandlers.length ? { ...entry, hooks: remainingHandlers } : null;
    })
    .filter(Boolean);
  if (next.hooks.Stop.length === 0) delete next.hooks.Stop;
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

function documentsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function backupName(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.honcho-agent-bridge-backup-${stamp}`;
}

async function writeJsonAtomic(filePath, value, { backup = false, privateFile = false } = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  if (backup && (await pathExists(filePath))) {
    const backupPath = backupName(filePath);
    if (privateFile) await writePrivateFileAtomic(backupPath, await fsp.readFile(filePath));
    else await fsp.copyFile(filePath, backupPath);
  }
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (privateFile) {
    await writePrivateFileAtomic(filePath, content);
    return;
  }
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, { mode: 0o600 });
  await fsp.rename(temporary, filePath);
  await fsp.chmod(filePath, 0o600).catch(() => {});
}

async function installRuntime(target) {
  if (path.resolve(SCRIPT_DIR) === path.resolve(target)) return { changed: false, source: SCRIPT_DIR, target };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  const previous = `${target}.previous`;
  const previousBackup = `${previous}.setup-${process.pid}`;
  let movedExistingRuntime = false;
  let backedUpPrevious = false;
  try {
    await fsp.rm(temporary, { recursive: true, force: true });
    await fsp.rm(previousBackup, { recursive: true, force: true });
    await fsp.cp(SCRIPT_DIR, temporary, { recursive: true });
    // The setup UI's pages live beside scripts/, not inside it, so they need their
    // own copy; ui.mjs looks for them next to itself once installed.
    const uiSource = path.join(path.dirname(SCRIPT_DIR), "ui");
    if (await pathExists(uiSource)) await fsp.cp(uiSource, path.join(temporary, "ui"), { recursive: true });
    if (await pathExists(previous)) {
      await fsp.rename(previous, previousBackup);
      backedUpPrevious = true;
    }
    if (await pathExists(target)) {
      await fsp.rename(target, previous);
      movedExistingRuntime = true;
    }
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (movedExistingRuntime && !(await pathExists(target)) && (await pathExists(previous))) {
      await fsp.rename(previous, target).catch(() => {});
    }
    if (backedUpPrevious && !(await pathExists(previous)) && (await pathExists(previousBackup))) {
      await fsp.rename(previousBackup, previous).catch(() => {});
    }
    throw error;
  }
  return {
    changed: true,
    source: SCRIPT_DIR,
    target,
    rollback: movedExistingRuntime ? previous : null,
    previousBackup: backedUpPrevious ? previousBackup : null,
  };
}

async function fileSnapshot(filePath) {
  try {
    const [content, stat] = await Promise.all([fsp.readFile(filePath), fsp.stat(filePath)]);
    return { existed: true, content, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { existed: false, content: null, mode: null };
    throw error;
  }
}

async function restoreFileSnapshot(filePath, snapshot, { privateFile = false } = {}) {
  if (!snapshot.existed) {
    await fsp.rm(filePath, { force: true });
    return;
  }
  if (privateFile) {
    await writePrivateFileAtomic(filePath, snapshot.content, { mode: snapshot.mode ?? 0o600 });
    return;
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.restore-${process.pid}`;
  await fsp.writeFile(temporary, snapshot.content, { mode: snapshot.mode ?? 0o600 });
  await fsp.rename(temporary, filePath);
  if (snapshot.mode != null) await fsp.chmod(filePath, snapshot.mode).catch(() => {});
}

async function rollbackRuntime(runtime) {
  if (!runtime?.changed) return;
  await fsp.rm(runtime.target, { recursive: true, force: true });
  if (runtime.rollback && (await pathExists(runtime.rollback))) await fsp.rename(runtime.rollback, runtime.target);
  if (runtime.previousBackup && (await pathExists(runtime.previousBackup))) {
    await fsp.rm(`${runtime.target}.previous`, { recursive: true, force: true });
    await fsp.rename(runtime.previousBackup, `${runtime.target}.previous`);
  }
}

async function finalizeRuntime(runtime) {
  if (runtime?.previousBackup) {
    await fsp.rm(runtime.previousBackup, { recursive: true, force: true });
    runtime.previousBackup = null;
  }
}

async function withSetupLock(appHome, fn) {
  const lockPath = path.join(appHome, "setup.lock");
  const lock = await acquireFileLock(lockPath, {
    attempts: 1,
    staleMs: 600_000,
    reclaimDeadImmediately: true,
  });
  if (!lock) throw new Error("Honcho Agent Bridge setup is already running");
  try {
    return await fn();
  } finally {
    await releaseFileLock(lock);
  }
}

/**
 * What the user still has to do in each host; the 2026-09-30 install test missed
 * both. A plugin setup could not install comes first, with the commands to run.
 */
function setupNextSteps(agents, plugins = [], entries = []) {
  const steps = [];
  const action = (agent) => plugins.find((item) => item.agent === agent)?.action;
  for (const item of plugins) {
    if (item.action !== "failed" && item.action !== "missing-cli") continue;
    const commands = entries.find((entry) => entry.agent === item.agent)?.commands || [];
    const name = item.agent === "codex" ? "Codex" : "Claude Code";
    // The commands stay out of the message: printing strips a URL's #ref from a message.
    steps.push({
      agent: item.agent,
      action: "install-plugin",
      commands,
      message: `Install the Honcho Agent Bridge plugin in ${name} yourself: run the commands below in order.`,
    });
  }
  if (agents.codex) {
    steps.push({
      agent: "codex",
      action: "approve-hook",
      message: action("codex") === "installed"
        ? "Setup installed the Honcho Agent Bridge plugin in Codex. Open a new Codex session; it asks to approve the new Stop hook (or open /hooks). Approve 'Syncing codex conversation to personal memory'; nothing is collected from Codex until then."
        : "Codex asks to approve the new Stop hook when a session starts (or open /hooks). Approve 'Syncing codex conversation to personal memory'; nothing is collected from Codex until then.",
    });
  }
  if (agents.claude) {
    steps.push({
      agent: "claude",
      action: "reload-plugins",
      message: action("claude") === "installed"
        ? "Setup installed the Honcho Agent Bridge plugin in Claude Code. Open Claude Code anew, or run /reload-plugins in a session that is already open, to load its hook and MCP server."
        : "Claude Code sessions that were already open need /reload-plugins (or a restart) to load the plugin's hook and MCP server; new sessions load them by themselves. Turns from before the reload are sent with the next one.",
    });
  }
  return steps;
}

/**
 * Installs the plugin into each host setup collects from that lacks it. Runs after
 * the hooks and the configuration are written; nothing here fails setup or rolls
 * it back.
 */
async function installPlugins(agents) {
  let entries = [];
  try {
    entries = await hostPluginPlan(agents, {
      statuses: { codex: await codexPluginStatus(), claude: await claudePluginStatus() },
      home: userHome(),
    });
    return { entries, plugins: await installHostPlugins(entries, { home: userHome() }) };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 300);
    return { entries, plugins: entries.map((entry) => ({ agent: entry.agent, action: "failed", error: reason })) };
  }
}

async function setupApply(options = {}) {
  const plan = await setupPlan(options);
  if (!plan.ready) return plan;
  const paths = installPaths(plan.config);
  return withSetupLock(paths.appHome, () => applySetupPlan(plan, paths));
}

async function applySetupPlan(plan, paths) {
  const hostSnapshots = {};
  for (const provider of ["codex", "claude"]) {
    const target = hostConfigPaths()[provider];
    hostSnapshots[provider] = { ...(await fileSnapshot(target)), document: await readHostJson(target) };
  }
  const configFileSnapshot = await fileSnapshot(paths.configPath);
  const configSnapshot = {
    ...configFileSnapshot,
    document: configFileSnapshot.existed ? await readHostJson(paths.configPath) : {},
  };
  let runtime = null;
  const changedHosts = [];
  try {
    runtime = await installRuntime(paths.runtimeDir);
    const hooks = [];
    for (const provider of ["codex", "claude"]) {
      const enabled = Boolean(plan.config.agents[provider]);
      const target = hostConfigPaths()[provider];
      const current = hostSnapshots[provider].document;
      const cleaned = removeManagedStopHooks(current);
      const next = provider === "codex" && enabled ? mergeStopHook(cleaned, provider, paths.runtimeDir) : cleaned;
      const shouldWrite = !documentsEqual(current, next) || (provider === "codex" && enabled && !(await pathExists(target)));
      if (shouldWrite) {
        await writeJsonAtomic(target, next, { backup: true });
        changedHosts.push(provider);
      }
      hooks.push({
        provider,
        target: provider === "claude" ? "hooks/claude-hooks.json" : target,
        installed: enabled,
        mode: provider === "claude" ? "bundled-plugin" : "host-settings",
        legacyHookRemoved: provider === "claude" && !documentsEqual(current, cleaned),
        changed: shouldWrite,
      });
    }
    await writeJsonAtomic(
      paths.configPath,
      { ...plan.config, installedVersion: VERSION, installedAt: new Date().toISOString() },
      { backup: true, privateFile: true },
    );
    await finalizeRuntime(runtime);
    const warnings = [];
    const toolsPath = mcpToolsPath(paths);
    if (!(await pathExists(toolsPath))) {
      try {
        await writeJsonAtomic(toolsPath, { disabled_tools: [...WRITE_TOOLS] });
      } catch (error) {
        warnings.push(`MCP tool defaults were not written to ${toolsPath}: ${error?.message || error}`);
      }
    }
    const { entries, plugins } = await installPlugins(plan.config.agents);
    return {
      ok: true,
      version: VERSION,
      paths,
      runtime,
      hooks,
      plugins,
      restartRequired: true,
      nextSteps: setupNextSteps(plan.config.agents, plugins, entries),
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const provider of [...changedHosts].reverse()) {
      try {
        await restoreFileSnapshot(hostConfigPaths()[provider], hostSnapshots[provider]);
      } catch (rollbackError) {
        rollbackErrors.push(`${provider} settings: ${rollbackError?.message || rollbackError}`);
      }
    }
    try {
      await restoreFileSnapshot(paths.configPath, configSnapshot, { privateFile: true });
    } catch (rollbackError) {
      rollbackErrors.push(`configuration: ${rollbackError?.message || rollbackError}`);
    }
    try {
      await rollbackRuntime(runtime);
    } catch (rollbackError) {
      rollbackErrors.push(`runtime: ${rollbackError?.message || rollbackError}`);
    }
    const suffix = rollbackErrors.length ? `; rollback issues: ${rollbackErrors.join("; ")}` : "; changes were rolled back";
    throw new Error(`Setup failed: ${error?.message || error}${suffix}`);
  }
}

async function installedRuntimeVersion(runtimeDir) {
  try {
    const source = await fsp.readFile(path.join(runtimeDir, "version.mjs"), "utf8");
    return source.match(/VERSION\s*=\s*["']([^"']+)["']/)?.[1] || "";
  } catch {
    return "";
  }
}

async function probeMcpServer(serverPath, timeoutMs = 2500, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath, "--provider", "doctor"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    let initialized = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "MCP smoke test timed out", stderr: sanitizeUrlsInText(stderr.slice(-500)) }),
      timeoutMs,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) initialized = message.result;
        if (message.id === 2) {
          if (message.error) finish({ ok: false, error: message.error.message });
          else {
            const tools = Array.isArray(message.result?.tools) ? message.result.tools : null;
            finish({
              ok: Boolean(initialized && tools),
              protocolVersion: initialized?.protocolVersion || "",
              enabledToolCount: tools ? tools.length : null,
              toolNames: tools ? tools.map((entry) => entry?.name).filter(Boolean) : [],
            });
          }
        }
      }
    });
    child.on("error", (error) => finish({ ok: false, error: sanitizeUrlsInText(error?.message || error) }));
    child.on("exit", (code, signal) => {
      if (!settled) finish({ ok: false, error: `MCP server exited before handshake (${code ?? signal ?? "unknown"})` });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "honcho-agent-bridge-doctor", version: VERSION } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}

async function doctor() {
  const configuration = await inspectConfiguration();
  const config = configuration.config;
  const paths = installPaths(config);
  const checks = [];
  checks.push({ name: "configuration", ...configuration, config: undefined });
  const requiredRuntimeFiles = [
    "main.mjs",
    "cli.mjs",
    "queue.mjs",
    "collector.mjs",
    "mcp-server.mjs",
    "ui.mjs",
    "file-lock.mjs",
    "version.mjs",
    "honcho-source.mjs",
    "honcho-access.mjs",
    "redact.mjs",
    "targets.mjs",
  ];
  const missingRuntimeFiles = [];
  for (const file of requiredRuntimeFiles) {
    if (!(await pathExists(path.join(paths.runtimeDir, file)))) missingRuntimeFiles.push(file);
  }
  const runtimeVersion = await installedRuntimeVersion(paths.runtimeDir);
  checks.push({
    name: "runtime",
    ok: missingRuntimeFiles.length === 0 && runtimeVersion === VERSION && config?.installedVersion === VERSION,
    path: paths.runtimeDir,
    expectedVersion: VERSION,
    actualVersion: runtimeVersion || null,
    configuredVersion: config?.installedVersion || null,
    missingFiles: missingRuntimeFiles,
  });
  if (config) {
    const health = await probeHealth(config.honcho.baseUrl, config);
    checks.push({ name: "honcho-health", ...health, url: publicUrl(config.honcho.baseUrl) });
    checks.push({ name: "honcho-workspaces", ...(await probeWorkspaceAccess(config)), url: publicUrl(config.honcho.baseUrl) });
    const mcpPath = path.join(paths.runtimeDir, "mcp-server.mjs");
    checks.push({ name: "mcp", ...(await probeMcpServer(mcpPath)), path: mcpPath });
    for (const [provider, enabled] of Object.entries(config.agents || {})) {
      if (!enabled) continue;
      const plugin = provider === "claude" ? await claudePluginStatus() : await codexPluginStatus();
      checks.push({ name: `${provider}-plugin`, ok: plugin.installed && plugin.enabled, ...plugin });
      if (provider === "claude") {
        checks.push({
          name: "claude-hook",
          ok: plugin.installed && plugin.enabled,
          mode: "bundled-plugin",
          note: plugin.installed && plugin.enabled
            ? "The hook is loaded by the installed Honcho Agent Bridge Claude plugin."
            : "Install or enable Honcho Agent Bridge in Claude Code so its bundled hook can load.",
        });
      } else {
        const target = hostConfigPaths()[provider];
        const document = await readJson(target, {});
        checks.push({ name: `${provider}-hook`, ok: hasCurrentManagedHook(document, paths.runtimeDir, provider), path: target });
      }
    }
    for (const target of configuredTargets(config)) {
      if (!target.enabled) continue;
      const probe = await probeTarget(config, target);
      checks.push({ name: `target-${target.id}`, ok: probe.ok, url: publicUrl(target.honcho.baseUrl), health: probe.health, workspace: probe.workspace });
    }
  }
  return { ok: checks.every((check) => check.ok), version: VERSION, checks };
}

// ------------------------------------------------------- the old shared bridge
//
// Until 0.3.28 `bridge connect` saved a teammate's bridge address, its token and a
// Cloudflare service token in config.json, and the plugin's MCP server relayed it.
// That relay is gone; `bridge disconnect` takes the saved values out, and deletes a
// file that held nothing else.

function isLoopbackHostname(hostname) {
  const value = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || /^127(\.\d{1,3}){3}$/.test(value);
}

function serverUrlIssues(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return ["the server address is not a valid URL"];
  }
  const issues = [];
  if (!["http:", "https:"].includes(url.protocol)) issues.push("the server address must use https");
  else if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    issues.push("the server address must use https unless it is on this machine, or its token travels in the clear");
  }
  if (url.username || url.password || url.search || url.hash) {
    issues.push("the server address must not contain credentials, query parameters, or a fragment");
  }
  return issues;
}

async function oldBridgeRemove() {
  const configPath = installPaths().configPath;
  if (!(await pathExists(configPath))) return { ok: true, changed: false };
  let document;
  try {
    document = JSON.parse(await fsp.readFile(configPath, "utf8"));
  } catch (error) {
    return { ok: false, issues: [`refusing to rewrite ${configPath}: it is not valid JSON (${error?.message || error})`] };
  }
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== CONFIG_VERSION) {
    return { ok: false, issues: [`refusing to rewrite ${configPath}: it is not this version's configuration`] };
  }
  if (!OLD_RELAY_FIELDS.some((key) => key in (document.honcho || {}))) return { ok: true, changed: false };
  const paths = installPaths(document);
  return withSetupLock(paths.appHome, async () => {
    const honcho = { ...document.honcho };
    for (const key of OLD_RELAY_FIELDS) delete honcho[key];
    const next = { ...document, honcho };
    // A file that only ever held the bridge has nothing left worth keeping.
    if (!collectsConversations(next)) {
      await fsp.rm(configPath, { force: true });
      return { ok: true, changed: true, removedConfig: true, restartRequired: true };
    }
    await writeJsonAtomic(configPath, next, { backup: true, privateFile: true });
    return { ok: true, changed: true, restartRequired: true };
  });
}

// ------------------------------------------------------------- other servers
//
// A target is a second memory server - usually the company's - that also receives
// the conversations from chosen folders (targets.mjs). The owner's own server
// still receives everything. Its secrets come from HONCHO_TARGET_API_TOKEN and
// HONCHO_TARGET_CF_ACCESS_CLIENT_ID/SECRET only, never from the command line.

const TARGET_TIMEOUT_MS = 10_000;
const BACKFILL_DEFAULT_LIMIT = 500;
const BACKFILL_MAX_LIMIT = 5000;
const BACKFILL_MAX_CONSECUTIVE_FAILURES = 3;

function targetHeaders(target, extra = {}) {
  return honchoHeaders({ token: target.honcho.apiToken, access: targetAccess(target) }, extra);
}

/** A probe's answer in the words setup uses for the same answer from the primary. */
function explainTargetProbe(result, target, what) {
  if (result.ok || result.access) return result;
  const url = publicUrl(target.honcho.baseUrl);
  if (result.status === 401) {
    return {
      ...result,
      reason: target.honcho.apiToken
        ? `${url} rejected the API token; check the token for that server`
        : `${url} requires an API token; set ${TARGET_SECRET_ENV.apiToken} in your shell and add the target again`,
    };
  }
  if (result.status === 403) return { ...result, reason: `${url} refused ${what} with this token` };
  if (result.status) return { ...result, reason: `${url} answered ${what} with HTTP ${result.status}` };
  return { ...result, reason: `${url} did not answer: ${result.error || "no response"}` };
}

/**
 * Health, then a read of the target's workspace, with the same Access and 401
 * classification setup uses. A workspace-scoped token cannot list every workspace,
 * so the read is of the one workspace the collector writes to.
 */
async function probeTarget(config, target) {
  const baseUrl = target.honcho.baseUrl;
  const health = explainTargetProbe(
    await probeHoncho(baseUrl, "/health", { headers: targetHeaders(target), timeoutMs: TARGET_TIMEOUT_MS }),
    target,
    "the health check",
  );
  if (!health.ok) return { ok: false, health, workspace: null };
  const workspaceId = targetWorkspace(config, target);
  const workspace = explainTargetProbe(
    await probeHoncho(baseUrl, `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/list?page=1&size=1`, {
      method: "POST",
      headers: targetHeaders(target, { "Content-Type": "application/json", Accept: "application/json" }),
      body: "{}",
      timeoutMs: TARGET_TIMEOUT_MS,
    }),
    target,
    `a read of workspace ${workspaceId}`,
  );
  return { ok: workspace.ok, health, workspace: { ...workspace, id: workspaceId } };
}

function targetSecretsOnCommandLine(options) {
  const keys = Object.keys(options).filter((key) => /token|secret|clientid|password/i.test(key));
  return keys.length
    ? [`pass the target's API token through ${TARGET_SECRET_ENV.apiToken} and its Cloudflare Access service token through ${TARGET_SECRET_ENV.accessClientId} and ${TARGET_SECRET_ENV.accessClientSecret}, not the command line`]
    : [];
}

function targetUrlIssues(value) {
  return serverUrlIssues(value);
}

/** `--folders a,b`: absolute folders (or `~/...`), resolved, one spelling each. */
function parseFolders(value, flag = "--folders") {
  const issues = [];
  const warnings = [];
  const folders = [];
  if (typeof value !== "string" || !value.trim()) return { folders, issues: [`${flag} needs at least one folder`], warnings };
  for (const raw of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    let expanded = raw;
    if (raw === "~") expanded = userHome();
    else if (raw.startsWith("~/") || raw.startsWith("~\\")) expanded = path.join(userHome(), raw.slice(2));
    if (!path.isAbsolute(expanded)) {
      issues.push(`${raw} is not an absolute folder; give the whole path, or start it with ~/`);
      continue;
    }
    let folder = path.resolve(expanded);
    const root = path.parse(folder).root;
    while (folder.length > root.length && /[\\/]$/.test(folder)) folder = folder.slice(0, -1);
    if (folders.some((existing) => folderMatches(folder, [existing], { resolveLinks: false }) && folderMatches(existing, [folder], { resolveLinks: false }))) continue;
    folders.push(folder);
    if (!fs.existsSync(folder)) warnings.push(`${folder} does not exist on this computer; conversations there are sent once it does`);
  }
  if (!folders.length && !issues.length) issues.push(`${flag} needs at least one folder`);
  return { folders, issues, warnings };
}

/**
 * Which folders' conversations the own server takes (config.json `collect`):
 * `--take-folders a,b` and `--skip-folders c,d` name folders, the deepest one a
 * session ran in deciding, and `--rest-folders take|skip` says what happens to a
 * session in none of them, folders made later included (take when not given).
 * `--all-folders` takes every folder again. Without any of them, what config.json
 * says stays.
 */
function collectChoice(options, existing) {
  const kept = collectFolders(existing);
  const named = ["takeFolders", "skipFolders", "restFolders"].filter((key) => options[key] !== undefined);
  if (options.allFolders !== undefined) {
    return named.length
      ? { collect: kept, issues: ["--all-folders takes every folder; leave out --take-folders, --skip-folders and --rest-folders"], warnings: [] }
      : { collect: null, issues: [], warnings: [] };
  }
  if (!named.length) return { collect: kept, issues: [], warnings: [] };
  const none = { folders: [], issues: [], warnings: [] };
  const take = options.takeFolders === undefined ? none : parseFolders(options.takeFolders, "--take-folders");
  const skip = options.skipFolders === undefined ? none : parseFolders(options.skipFolders, "--skip-folders");
  const rest = options.restFolders === undefined ? "take" : options.restFolders;
  const issues = [...take.issues, ...skip.issues];
  if (rest !== "take" && rest !== "skip") issues.push("--rest-folders takes take or skip");
  // Taking no folder and skipping the rest would collect nothing at all.
  else if (rest === "skip" && !take.folders.length && !take.issues.length) issues.push("--rest-folders skip needs --take-folders with the folders to take");
  return { collect: collectFolders({ collect: { take: take.folders, skip: skip.folders, rest } }), issues, warnings: take.warnings };
}

function parseTargetAgents(value) {
  if (value === undefined) return { agents: undefined, issues: [] };
  if (typeof value !== "string") return { agents: undefined, issues: ["--agents takes claude, codex or claude,codex"] };
  const names = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((name) => !TARGET_PROVIDERS.includes(name));
  if (unknown.length || !names.length) {
    return { agents: undefined, issues: [`--agents takes ${TARGET_PROVIDERS.join(", ")}; only they record the folder a conversation ran in`] };
  }
  return { agents: Object.fromEntries(TARGET_PROVIDERS.map((name) => [name, names.includes(name)])), issues: [] };
}

function parseEnabled(value) {
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** The configuration a target command may change: one that already collects conversations. */
async function collectingConfiguration() {
  const configuration = await inspectConfiguration();
  if (configuration.state !== "valid" || !collectsConversations(configuration.config)) {
    return {
      error: configuration.state === "valid"
        ? "set up collection to your own server first (setup apply); a target only receives a copy of it"
        : `the configuration at ${configuration.path} is ${configuration.state}`,
    };
  }
  return { config: configuration.config, paths: installPaths(configuration.config) };
}

function findTarget(config, id) {
  return configuredTargets(config).find((target) => target.id === id) || null;
}

/** Re-read and rewrite config.json under the setup lock, so two commands never lose each other's change. */
async function updateTargets(change) {
  const initial = await collectingConfiguration();
  if (initial.error) return { ok: false, error: initial.error };
  return withSetupLock(initial.paths.appHome, async () => {
    const current = await collectingConfiguration();
    if (current.error) return { ok: false, error: current.error };
    const targets = Array.isArray(current.config.targets) ? structuredClone(current.config.targets) : [];
    const outcome = await change(targets, current.config);
    if (!outcome.ok) return outcome;
    const next = { ...current.config, targets };
    await writeJsonAtomic(current.paths.configPath, next, { backup: true, privateFile: true });
    return { ...outcome, config: next };
  });
}

async function targetList() {
  const configuration = await inspectConfiguration();
  const config = configuration.config;
  const targets = [];
  for (const target of configuredTargets(config)) targets.push(await targetSummary(config, target));
  return { ok: true, primary: config?.honcho?.baseUrl ? publicUrl(config.honcho.baseUrl) : null, targets };
}

async function targetAdd(id, options = {}) {
  const issues = [...targetSecretsOnCommandLine(options)];
  const warnings = [];
  if (!TARGET_ID.test(String(id || ""))) issues.push("the target id is a short slug: lower-case letters, digits and dashes");
  const url = optionString(options.url, "");
  if (url) issues.push(...targetUrlIssues(url));
  else issues.push("--url is required");
  const parsedFolders = parseFolders(options.folders);
  issues.push(...parsedFolders.issues);
  warnings.push(...parsedFolders.warnings);
  const parsedAgents = parseTargetAgents(options.agents);
  issues.push(...parsedAgents.issues);
  const token = String(process.env[TARGET_SECRET_ENV.apiToken] || "").trim();
  const accessId = String(process.env[TARGET_SECRET_ENV.accessClientId] || "").trim();
  const accessSecret = String(process.env[TARGET_SECRET_ENV.accessClientSecret] || "").trim();
  if (Boolean(accessId) !== Boolean(accessSecret)) {
    issues.push(`the Cloudflare Access service token needs both ${TARGET_SECRET_ENV.accessClientId} and ${TARGET_SECRET_ENV.accessClientSecret}`);
  }
  const base = await collectingConfiguration();
  if (base.error) issues.push(base.error);
  else {
    if (findTarget(base.config, id)) issues.push(`a target named ${id} already exists; change it with target set, or remove it first`);
    if (url && sameOrigin(url, base.config.honcho.baseUrl)) issues.push("that is your own server, which already receives every conversation");
  }
  if (issues.length) return { ok: false, saved: false, issues, warnings };

  // A team's server (a company server) is reached with this computer's team login,
  // never a token, and takes nothing until its owner approves; the app turns it on then.
  const team = options.team === true;
  if (team && (token || accessId)) return { ok: false, saved: false, issues: ["a team server takes the team login, not a token"], warnings };
  const teamPeer = team ? (await teamLoginStatus({ paths: teamAuthPaths(base.config) })).peer : null;
  const target = {
    id,
    label: optionString(options.label, id),
    honcho: {
      baseUrl: url.replace(/\/+$/, ""),
      workspaceId: optionString(options.workspace, base.config.honcho.workspaceId || "memory"),
      ...(token ? { apiToken: token } : {}),
      ...(accessId && accessSecret ? { access: { clientId: accessId, clientSecret: accessSecret } } : {}),
    },
    ...(optionString(options.userPeer, "") || teamPeer ? { userPeerId: optionString(options.userPeer, "") || teamPeer } : {}),
    folders: parsedFolders.folders,
    ...(parsedAgents.agents ? { agents: parsedAgents.agents } : {}),
    ...(team ? { team: true } : {}),
    enabled: !team,
  };
  if (!Object.values(targetAgents(base.config, target)).some(Boolean)) {
    return { ok: false, saved: false, issues: ["none of this target's agents is collected here; pass --agents claude,codex or enable them in setup"], warnings };
  }
  if (team) {
    const saved = await updateTargets(async (targets) => {
      if (targets.some((item) => item?.id === id)) return { ok: false, saved: false, issues: [`a target named ${id} already exists`] };
      targets.push(target);
      return { ok: true, saved: true };
    });
    if (!saved.ok) return { ...saved, warnings };
    return {
      ok: true,
      saved: true,
      target: await targetSummary(saved.config, findTarget(saved.config, id)),
      warnings,
      note: `Kept off until the owner of ${publicUrl(url)} approves; the app turns it on then`,
    };
  }
  // The server has to answer before anything is saved.
  const probe = await probeTarget(base.config, target);
  if (!probe.health.ok) {
    return { ok: false, saved: false, issues: [probe.health.reason || "the server did not answer"], health: probe.health, warnings };
  }
  if (!probe.workspace.ok) {
    const refused = probe.workspace.access || [401, 403].includes(probe.workspace.status);
    if (refused) return { ok: false, saved: false, issues: [probe.workspace.reason], health: probe.health, workspace: probe.workspace, warnings };
    warnings.push(probe.workspace.reason);
  }
  const saved = await updateTargets(async (targets) => {
    if (targets.some((item) => item?.id === id)) return { ok: false, saved: false, issues: [`a target named ${id} already exists`] };
    targets.push(target);
    return { ok: true, saved: true };
  });
  if (!saved.ok) return { ...saved, warnings };
  return {
    ok: true,
    saved: true,
    target: await targetSummary(saved.config, findTarget(saved.config, id)),
    health: probe.health,
    workspace: probe.workspace,
    warnings,
    note: `From the next turn on, conversations in these folders are also sent to ${publicUrl(url)}. Earlier ones are not; send them with: target backfill ${id} --since YYYY-MM-DD`,
  };
}

async function targetRemove(id) {
  if (!TARGET_ID.test(String(id || ""))) return { ok: false, error: "name the target to remove" };
  const result = await updateTargets(async (targets) => {
    const index = targets.findIndex((item) => item?.id === id);
    if (index < 0) return { ok: false, error: `no target named ${id}` };
    targets.splice(index, 1);
    return { ok: true, removed: id };
  });
  if (!result.ok) return result;
  // Its spool goes too, so nothing queued for it is ever sent. What is already on
  // that server stays there.
  const paths = targetPaths(result.config, id);
  await fsp.rm(paths.root, { recursive: true, force: true });
  return { ok: true, removed: id, removedData: paths.root };
}

async function targetSet(id, options = {}) {
  const issues = [...targetSecretsOnCommandLine(options)];
  if (!TARGET_ID.test(String(id || ""))) issues.push("name the target to change");
  const changes = {};
  const warnings = [];
  if (options.folders !== undefined) {
    const parsed = parseFolders(options.folders);
    issues.push(...parsed.issues);
    warnings.push(...parsed.warnings);
    changes.folders = parsed.folders;
  }
  if (options.enabled !== undefined) {
    const enabled = parseEnabled(options.enabled);
    if (enabled === null) issues.push("--enabled takes true or false");
    else changes.enabled = enabled;
  }
  if (options.label !== undefined) changes.label = optionString(options.label, id);
  if (options.workspace !== undefined) {
    const workspace = optionString(options.workspace, "");
    if (!workspace) issues.push("--workspace needs a workspace id");
    else changes.workspaceId = workspace;
  }
  if (options.userPeer !== undefined) {
    const peer = optionString(options.userPeer, "");
    if (!peer) issues.push("--user-peer needs a peer id");
    else changes.userPeerId = peer;
  }
  if (options.agents !== undefined) {
    const parsed = parseTargetAgents(options.agents);
    issues.push(...parsed.issues);
    if (parsed.agents) changes.agents = parsed.agents;
  }
  if (!issues.length && !Object.keys(changes).length) issues.push("nothing to change: pass --folders, --enabled, --label, --workspace, --user-peer or --agents");
  if (issues.length) return { ok: false, saved: false, issues, warnings };
  const result = await updateTargets(async (targets) => {
    const target = targets.find((item) => item?.id === id);
    if (!target) return { ok: false, error: `no target named ${id}` };
    if (changes.folders) target.folders = changes.folders;
    if (changes.enabled !== undefined) target.enabled = changes.enabled;
    if (changes.label !== undefined) target.label = changes.label;
    if (changes.workspaceId) target.honcho = { ...(target.honcho || {}), workspaceId: changes.workspaceId };
    if (changes.userPeerId) target.userPeerId = changes.userPeerId;
    if (changes.agents) target.agents = changes.agents;
    return { ok: true, saved: true };
  });
  if (!result.ok) return { ...result, warnings };
  return { ok: true, saved: true, target: await targetSummary(result.config, findTarget(result.config, id)), warnings };
}

async function targetTest(id) {
  const configuration = await inspectConfiguration();
  const target = findTarget(configuration.config, id);
  if (!target) return { ok: false, error: `no target named ${id}` };
  const probe = await probeTarget(configuration.config, target);
  return { ok: probe.ok, id, url: publicUrl(target.honcho.baseUrl), enabled: target.enabled, health: probe.health, workspace: probe.workspace };
}

// ------------------------------------------------------------------ backfill
//
// Adding a target sends nothing from before. `target backfill` sends past
// conversations on request, in bounded runs: each run looks at up to --limit
// transcripts, oldest first, and remembers which it finished in the target's
// backfill.json, so the next run carries on where this one stopped. The importer
// dedupes against the target's own state and what that server already holds, so
// running it again sends nothing twice.

function parseSince(value) {
  if (value === undefined) return { sinceMs: 0, issues: [] };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { issues: ["--since takes a date as YYYY-MM-DD"] };
  // Midnight at the start of that day, on this computer's clock.
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { issues: [`${value} is not a date`] };
  }
  return { sinceMs: date.getTime(), issues: [] };
}

function foldersKey(folders) {
  return JSON.stringify([...folders].sort());
}

function runCollector(provider, transcript, env) {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, "collector.mjs"), "--provider", provider, "--transcript", transcript], {
    encoding: "utf8",
    env,
    timeout: 600_000,
  });
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLines = String(result.stderr || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines.reverse(), ...errorLines.reverse()]) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return { ok: false, error: result.error?.message || `the importer exited with ${result.status}` };
}

/**
 * Sends past Claude Code and Codex sessions through the importer, oldest first: the
 * transcripts of `agents` changed since `sinceMs`, each kept or left out by
 * `accepts(parsed)` and sent with `envFor(provider)`. What became of each transcript
 * is kept in `progressPath` with its size and time, so a run carries on where the
 * last one stopped; `filterKey` names the folders it was decided for, and a session
 * left out is looked at again once they change. `onProgress` hears each step.
 */
async function backfillSessions({ config, agents, sinceMs, limit, accepts, envFor, progressPath, filterKey, onProgress }) {
  const progress = await readJson(progressPath, null);
  const done = progress && typeof progress.done === "object" && progress.done ? progress.done : {};
  if (progress?.folders !== filterKey) {
    for (const [key, entry] of Object.entries(done)) if (entry?.outcome !== "sent") delete done[key];
  }
  const saveProgress = () => writeJsonAtomic(progressPath, { version: 1, folders: filterKey, done });

  const candidates = [];
  for (const provider of TARGET_PROVIDERS) {
    if (!agents[provider]) continue;
    for (const file of await transcriptFiles(config, provider)) {
      let stat;
      try { stat = await fsp.stat(file); } catch { continue; }
      if (stat.mtimeMs < sinceMs) continue;
      const key = `${provider}:${file}`;
      if (done[key] && done[key].mtimeMs === stat.mtimeMs && done[key].size === stat.size) continue;
      candidates.push({ provider, file, key, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.file.localeCompare(right.file));

  const summary = { sent_sessions: 0, new_messages: 0, outside_folders: 0, unreadable: 0, failed: 0 };
  const failures = [];
  let examined = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;
  const tell = () => onProgress?.({ considered: candidates.length, examined, remaining: candidates.length - examined, ...summary });
  await tell();
  for (const candidate of candidates.slice(0, limit)) {
    examined += 1;
    let parsed;
    try {
      parsed = await getProvider(candidate.provider).parseTranscript(candidate.file, {});
    } catch (error) {
      // Looked at again only once the file changes; it says nothing about the server.
      summary.unreadable += 1;
      done[candidate.key] = { mtimeMs: candidate.mtimeMs, size: candidate.size, outcome: "unreadable" };
      failures.push({ transcript_path: candidate.file, error: String(error?.message || error) });
      continue;
    }
    // Decided here without starting the importer; the importer checks again.
    if (!accepts(parsed)) {
      summary.outside_folders += 1;
      done[candidate.key] = { mtimeMs: candidate.mtimeMs, size: candidate.size, outcome: "outside" };
      continue;
    }
    const result = runCollector(candidate.provider, candidate.file, envFor(candidate.provider));
    if (result.ok) {
      consecutiveFailures = 0;
      if (!result.skipped) summary.sent_sessions += 1;
      summary.new_messages += Number(result.new_messages || 0);
      done[candidate.key] = { mtimeMs: candidate.mtimeMs, size: candidate.size, outcome: result.skipped ? "outside" : "sent", at: new Date().toISOString() };
      await saveProgress();
      await tell();
    } else {
      summary.failed += 1;
      consecutiveFailures += 1;
      failures.push({ transcript_path: candidate.file, session_id: parsed.session_id, error: sanitizeUrlsInText(result.error || "failed") });
      // The server is most likely down; the rest wait for the next run.
      if (consecutiveFailures >= BACKFILL_MAX_CONSECUTIVE_FAILURES) {
        stoppedEarly = true;
        break;
      }
    }
  }
  await saveProgress();
  return {
    considered: candidates.length,
    examined,
    remaining: candidates.length - examined,
    ...summary,
    ...(stoppedEarly ? { stopped: `stopped after ${BACKFILL_MAX_CONSECUTIVE_FAILURES} failures in a row; run it again once the server answers` } : {}),
    ...(failures.length ? { failures: failures.slice(0, 20) } : {}),
  };
}

function backfillLimit(value, fallback) {
  if (value === undefined) return fallback;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= BACKFILL_MAX_LIMIT ? limit : null;
}

async function targetBackfill(id, options = {}) {
  const issues = [...targetSecretsOnCommandLine(options)];
  const since = parseSince(options.since);
  issues.push(...since.issues);
  const limit = backfillLimit(options.limit, BACKFILL_DEFAULT_LIMIT);
  if (limit === null) issues.push(`--limit takes a whole number from 1 to ${BACKFILL_MAX_LIMIT}`);
  const base = await collectingConfiguration();
  if (base.error) issues.push(base.error);
  const target = base.config ? findTarget(base.config, id) : null;
  if (base.config && !target) issues.push(`no target named ${id}`);
  if (target && !target.enabled) issues.push(`${id} is turned off; turn it on with target set ${id} --enabled true`);
  if (target && !target.folders.length) issues.push(`${id} has no folders`);
  if (issues.length) return { ok: false, issues };

  const { config } = base;
  const result = await backfillSessions({
    config,
    agents: targetAgents(config, target),
    sinceMs: since.sinceMs,
    limit,
    accepts: (parsed) => folderMatches(parsed.metadata?.cwd, target.folders),
    envFor: (provider) => targetEnvironment(config, target, provider, { ...process.env, HONCHO_AGENT_IMPORT_TRIGGER: "backfill" }),
    progressPath: targetPaths(config, id).backfill,
    filterKey: foldersKey(target.folders),
  });
  return { ok: result.failed === 0, id, url: publicUrl(target.honcho.baseUrl), since: options.since || null, limit, ...result };
}

// ── Past conversations to this computer's own server ─────
//
// The hook sends a session whole on its next turn, so a session never opened again
// never reaches the server by itself. `backfill` sends them: every past Claude Code
// and Codex session in the folders setup chose (config.json `collect`), oldest first,
// deduped against what the collector already sent. `backfill start` runs it in the
// background, which is what first setup does once it has applied.

function ownBackfillPaths(config) {
  const { dataDir } = installPaths(config);
  return {
    progress: path.join(dataDir, "state", "backfill.json"),
    status: path.join(dataDir, "state", "backfill-status.json"),
    lock: path.join(dataDir, "state", "backfill.lock"),
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function ownBackfillRun(options = {}) {
  const issues = [];
  const since = parseSince(options.since);
  issues.push(...since.issues);
  // Unlike a target's, this one runs in the background and goes through them all.
  const limit = backfillLimit(options.limit, Number.POSITIVE_INFINITY);
  if (limit === null) issues.push(`--limit takes a whole number from 1 to ${BACKFILL_MAX_LIMIT}`);
  const base = await collectingConfiguration();
  if (base.error) issues.push(base.error);
  if (issues.length) return { ok: false, issues };

  const { config } = base;
  const paths = ownBackfillPaths(config);
  const lock = await acquireFileLock(paths.lock, { staleMs: 24 * 3_600_000, reclaimDeadImmediately: true });
  if (!lock) return { ok: false, busy: true, error: "another backfill is still running" };
  const startedAt = new Date().toISOString();
  const writeStatus = (fields) => writeJsonAtomic(paths.status, { version: 1, ...fields });
  try {
    const filter = collectFolders(config);
    let lastWrite = 0;
    const result = await backfillSessions({
      config,
      agents: config.agents || {},
      sinceMs: since.sinceMs,
      limit,
      accepts: (parsed) => !outsideCollectFolders(parsed.metadata?.cwd, filter),
      envFor: (provider) => withoutTargetFilter({
        ...process.env,
        ...configEnvironment(config, provider),
        HONCHO_AGENT_PROVIDER: provider,
        HONCHO_AGENT_IMPORT_TRIGGER: "backfill",
      }),
      progressPath: paths.progress,
      filterKey: JSON.stringify(filter || {}),
      // The screen reads how far it got; a write every few seconds is enough.
      onProgress: async (progress) => {
        if (Date.now() - lastWrite < 2_000) return;
        lastWrite = Date.now();
        await writeStatus({ running: { pid: process.pid, startedAt, ...progress } });
      },
    });
    const finished = { ok: result.failed === 0, url: publicUrl(config.honcho.baseUrl), since: options.since || null, limit, ...result };
    await writeStatus({ running: null, lastRun: { startedAt, finishedAt: new Date().toISOString(), ...finished } });
    return finished;
  } finally {
    await releaseFileLock(lock);
  }
}

/** Starts a backfill in the background and returns at once. */
async function ownBackfillStart(options = {}) {
  const base = await collectingConfiguration();
  if (base.error) return { ok: false, error: base.error };
  const since = parseSince(options.since);
  if (since.issues.length) return { ok: false, issues: since.issues };
  const status = await readJson(ownBackfillPaths(base.config).status, {});
  if (status?.running && processAlive(status.running.pid)) return { ok: true, started: false, running: status.running };
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "cli.mjs"), "backfill", "run", ...(options.since ? ["--since", options.since] : [])], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  return { ok: true, started: true, pid: child.pid };
}

/** Where the last backfill got: `running` while one goes, `lastRun` once it has finished. */
async function ownBackfillStatus() {
  const base = await collectingConfiguration();
  if (base.error) return { ok: false, error: base.error };
  const status = await readJson(ownBackfillPaths(base.config).status, {});
  const running = status?.running && processAlive(status.running.pid) ? status.running : null;
  return { ok: true, running, lastRun: status?.lastRun || null };
}

async function targetCommand(args) {
  const action = args.shift() || "list";
  const id = args[0] && !args[0].startsWith("--") ? args.shift() : "";
  const options = parseOptions(args);
  if (action === "list") return targetList();
  if (action === "add") return targetAdd(id, options);
  if (action === "remove") return targetRemove(id);
  if (action === "set") return targetSet(id, options);
  if (action === "test") return targetTest(id);
  if (action === "backfill") return targetBackfill(id, options);
  return { ok: false, error: `Unknown target action: ${action}. Expected list, add, remove, set, test or backfill.` };
}

// ---------------------------------------------------------------- setup screen

const UI_HOST = "127.0.0.1";
// Present only in a page that connects teammates' memory as remote MCP servers, so
// an older setup screen still running from a previous install is not mistaken for
// this one.
const UI_MARKER = 'id="team-memory-app"';

async function uiState(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return response.ok && text.includes(UI_MARKER) ? "ours" : "other";
  } catch {
    return "down";
  } finally {
    clearTimeout(timeout);
  }
}

function openBrowser(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the setup screen if it is not already up, and open it in a browser.
 *
 * Detached, so the screen outlives the agent's shell command that asked for it.
 * It is bound to loopback whatever the environment says: it can install hooks
 * and write credentials.
 */
async function uiOpen(options = {}) {
  const port = Number(process.env.HONCHO_AGENT_BRIDGE_UI_PORT || 4180);
  const url = `http://${UI_HOST}:${port}/`;
  // `--screen models` opens the app on that screen (its #/models route), and
  // `--screen start?team=team.example.com` first setup at that team's login.
  const screen = typeof options.screen === "string" ? options.screen.replace(/^[#/]+/, "") : "";
  if (screen && !/^[a-z0-9/_-]+(?:\?team=[a-z0-9.-]+)?$/i.test(screen)) return { ok: false, url, error: `Not a screen name: ${screen}` };
  const pageUrl = screen ? `${url}#/${screen}` : url;
  const state = await uiState(url);
  if (state === "other") {
    return { ok: false, url, error: `Something else is answering at ${url}. Close it, or set HONCHO_AGENT_BRIDGE_UI_PORT.` };
  }
  let pid = null;
  if (state === "down") {
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "ui.mjs")], {
      cwd: SCRIPT_DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, HONCHO_AGENT_BRIDGE_UI_HOST: UI_HOST, HONCHO_AGENT_BRIDGE_UI_PORT: String(port) },
    });
    child.unref();
    pid = child.pid;
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      ready = (await uiState(url)) === "ours";
    }
    if (!ready) return { ok: false, url, pid, error: "The setup screen did not start." };
  }
  const browserRequested = options.noBrowser === true ? false : openBrowser(pageUrl);
  return { ok: true, url: pageUrl, started: state === "down", pid, browserRequested };
}

async function runHook(provider) {
  const config = await loadConfig();
  if (!config || !config.agents?.[provider]) return { ok: true, skipped: "agent memory is not configured for this provider" };
  const installedMain = path.join(installPaths(config).runtimeDir, "main.mjs");
  const runtimeMain = (await pathExists(installedMain)) ? installedMain : MAIN_SCRIPT;
  const result = spawnSync(process.execPath, [runtimeMain, "--provider", provider], {
    stdio: "inherit",
    env: { ...process.env, ...configEnvironment(config, provider) },
  });
  return { ok: result.status === 0, status: result.status, signal: result.signal };
}

function usage() {
  return {
    ok: true,
    version: VERSION,
    usage: [
      "detect",
      "prereqs [--features server,sync]",
      "server plan [--profile portable|personal]",
      "server prepare [--profile portable|personal] [--model <id>]",
      "server start [--profile portable|personal] [--no-build] [--model <id>]",
      "server status [--profile portable|personal]",
      "server stop [--profile portable|personal]",
      "server verify [--profile personal] [--live-completion]",
      "server share status [--check]",
      "server share enable --cloudflare [--name memory] [--zone <zone>] [--email <owner email>] [--idp <id|name>] (the Cloudflare API token in CLOUDFLARE_API_TOKEN, kept for later)",
      "server share enable --public-url <https://host> (the tunnel token in HONCHO_TUNNEL_TOKEN)",
      "server share join --invite-file <file> (or the invite code in HONCHO_SHARE_INVITE)",
      "server share disable",
      "server share token",
      "server share rotate",
      "team make --name <team name> --email <admin Google email> [--zone <zone>] [--hub <label>] (the Cloudflare API token in CLOUDFLARE_API_TOKEN; it needs Workers Scripts: Edit as well)",
      "team status",
      "team share [--label <name>] [--replace] (after logging in to the team in the app)",
      "team scopes",
      "team grants",
      "team devices",
      "teammates list",
      "teammates add <email> [--share <name> --invite-out <file>] (the Cloudflare API token in CLOUDFLARE_API_TOKEN, else the saved one)",
      "teammates remove <email>",
      "teammates unshare <name>",
      "teammates connect <name> <host|https://host/mcp> (adds team-<name> to Claude Code and Codex as a remote MCP server; no token is stored)",
      "teammates disconnect <name>",
      "teammates connected",
      "host plan [--profile personal]",
      "host prepare [--profile personal]",
      "host start [--profile personal]",
      "host status [--profile personal]",
      "host stop [--profile personal]",
      "gateway open",
      "setup plan|apply [--agents codex,claude] [--user-peer <id>] [--workspace <id>] [--honcho-url <url>] [--take-folders <dir,dir>] [--skip-folders <dir,dir>] [--rest-folders take|skip] [--all-folders] [--data-dir <dir>] [--codex-root <dir>] (a server's API token in HONCHO_API_TOKEN; its Cloudflare Access service token in HONCHO_CF_ACCESS_CLIENT_ID, HONCHO_CF_ACCESS_CLIENT_SECRET)",
      "backfill run|start|status [--since YYYY-MM-DD] (past conversations of the collected folders to this computer's own server; start runs it in the background)",
      "bridge disconnect (removes the shared-bridge settings 0.3.28 and before saved)",
      "target list",
      "target add <id> --url <https://host> --folders <dir,dir> [--label <text>] [--workspace <id>] [--user-peer <id>] [--agents claude,codex] (its API token in HONCHO_TARGET_API_TOKEN; its Cloudflare Access service token in HONCHO_TARGET_CF_ACCESS_CLIENT_ID, HONCHO_TARGET_CF_ACCESS_CLIENT_SECRET)",
      "target set <id> [--folders <dir,dir>] [--enabled true|false] [--label <text>] [--workspace <id>] [--user-peer <id>] [--agents claude,codex]",
      "target test <id>",
      "target backfill <id> [--since YYYY-MM-DD] [--limit <n>]",
      "target remove <id>",
      "ui open [--screen <name>] [--no-browser]",
      "backup status [--check]",
      "backup set --folder <absolute path> | --cloud <rclone remote>:[folder] | --off [--device <id>] [--hour <0-23>]",
      "backup run [--dry-run] [--full] [--folder <path> | --cloud <remote>:[folder]] [--examples <n>] [--verbose]",
      "backup start (a run in the background)",
      "backup schedule on|off [--hour <0-23>] (the nightly run and the daytime check for problems)",
      "backup alert check|test (check: notify a backup problem now; test: show a sample notification)",
      "backup remotes",
      "doctor",
      "status",
    ],
  };
}

// A command line is visible to every process here, so no secret travels on one: the
// tunnel token, the Cloudflare API token and an invite code (which holds a tunnel
// token) come from the environment or a file.
function secretOnCommandLine(options) {
  const keys = Object.keys(options).filter((key) => /token|secret/i.test(key) || key === "invite" || key === "inviteCode");
  if (!keys.length) return null;
  return {
    ok: false,
    error: `pass the tunnel token through ${TUNNEL_TOKEN_ENV}, not the command line (the Cloudflare API token through ${API_TOKEN_ENV}, an invite through --invite-file or ${INVITE_ENV})`,
  };
}

/**
 * `server share <action>`: this server, reachable from the owner's other computers
 * through the gate, and from teammates' agents over /mcp, by a Cloudflare tunnel to a
 * public hostname.
 */
async function serverShare(args) {
  const action = args[0] && !args[0].startsWith("--") ? args[0] : "status";
  const options = parseOptions(args[0] === action ? args.slice(1) : args);
  const refused = secretOnCommandLine(options);
  if (refused) return refused;
  if (action === "status") return shareStatus({ check: options.check === true });
  if (action === "enable") {
    if (options.cloudflare === undefined) return shareEnable({ publicUrl: optionString(options.publicUrl, "") });
    if (options.cloudflare !== true) return { ok: false, error: "--cloudflare takes no value" };
    for (const key of ["name", "zone", "email", "idp"]) {
      if (options[key] !== undefined && typeof options[key] !== "string") return { ok: false, error: `--${key} takes a value` };
    }
    return shareEnable({
      cloudflare: true,
      publicUrl: optionString(options.publicUrl, ""),
      name: optionString(options.name, ""),
      zone: optionString(options.zone, ""),
      email: optionString(options.email, ""),
      idp: optionString(options.idp, ""),
    });
  }
  if (action === "join") {
    if (options.inviteFile !== undefined && typeof options.inviteFile !== "string") return { ok: false, error: "--invite-file takes a file" };
    return shareJoin({ inviteFile: optionString(options.inviteFile, "") });
  }
  if (action === "disable") return shareDisable();
  if (action === "rotate") return shareRotate();
  if (action === "token") {
    const result = await shareToken();
    return result.ok ? { ...result, [REVEALS_TOKEN]: true } : result;
  }
  return { ok: false, error: `Unknown share action: ${action}. Expected status, enable, join, disable, token or rotate.` };
}

/**
 * `teammates <action>`: the owner's list of who may log in to the team's servers, and
 * the teammates' shared servers, through the owner's Cloudflare API token. An invite
 * is only ever written to the --invite-out file, never printed.
 */
async function teammatesCommand(args) {
  const action = args[0] && !args[0].startsWith("--") ? args.shift() : "list";
  const positional = [];
  while (args.length && !args[0].startsWith("--")) positional.push(args.shift());
  const options = parseOptions(args);
  const refused = secretOnCommandLine(options);
  if (refused) return refused;
  if (action === "list") return teammatesList();
  if (action === "add") {
    if (options.share !== undefined && typeof options.share !== "string") return { ok: false, error: "--share takes a short name for the teammate's server" };
    if (options.inviteOut !== undefined && typeof options.inviteOut !== "string") return { ok: false, error: "--invite-out takes a file" };
    if (options.inviteOut && options.share === undefined) return { ok: false, error: "--invite-out goes with --share <name>" };
    return teammateAdd({
      email: positional[0] || "",
      share: optionString(options.share, ""),
      inviteOut: optionString(options.inviteOut, ""),
    });
  }
  if (action === "remove") return teammateRemove({ email: positional[0] || "" });
  if (action === "unshare") return teammateUnshare({ name: positional[0] || "" });
  // The asking side: a teammate's server in Claude Code and Codex. No Cloudflare token.
  if (action === "connect") return teammateConnect({ name: positional[0] || "", address: positional[1] || "" });
  if (action === "disconnect") return teammateDisconnect({ name: positional[0] || "" });
  if (action === "connected") return teammatesConnected();
  return { ok: false, error: `Unknown teammates action: ${action}. Expected list, add, remove, unshare, connect, disconnect or connected.` };
}

/**
 * `team <action>`: the team this computer belongs to (team-hub.mjs, team-auth.mjs).
 *   make     on the admin's first computer: the team hub, with the Cloudflare API
 *            token in CLOUDFLARE_API_TOKEN (never on the command line)
 *   status   the team made here and who this computer is signed in as; no token
 *   share    this computer's server at the address the team makes for it; the
 *            tunnel token goes from the hub to this process and nowhere else
 *   scopes   fills the scopes of the projects opened to teammates (scope-sync.mjs)
 *   grants, devices   what this server opened to whom, and the computers writing to it
 * Logging in needs a browser coming back to the app, so it is the app's (team-app.mjs).
 */
async function teamCommand(args) {
  const action = args[0] && !args[0].startsWith("--") ? args.shift() : "status";
  const options = parseOptions(args);
  const refused = secretOnCommandLine(options);
  if (refused) return refused;
  const config = await loadConfig();
  const gate = gateStatePaths({ serverDirectory: config?.paths?.serverDir });
  if (action === "make") {
    for (const key of ["name", "email", "zone", "hub", "idp"]) {
      if (options[key] !== undefined && typeof options[key] !== "string") return { ok: false, error: `--${key} takes a value` };
    }
    return teamMake({
      name: optionString(options.name, ""),
      email: optionString(options.email, ""),
      zone: optionString(options.zone, ""),
      hubLabel: optionString(options.hub, ""),
      idp: optionString(options.idp, ""),
    });
  }
  if (action === "status") {
    return { ok: true, made: await madeTeam(), login: await teamLoginStatus({ paths: teamAuthPaths(config) }) };
  }
  if (action === "share") {
    const paths = teamAuthPaths(config);
    const login = await teamLoginStatus({ paths });
    if (!login.hub || !login.email) return { ok: false, error: "Log in to the team in the app first" };
    if (options.label !== undefined && typeof options.label !== "string") return { ok: false, error: "--label takes a short name" };
    let made;
    try {
      made = await hubCall("POST", "/api/servers", {
        ...(options.label ? { label: options.label } : {}),
        workspace: config?.honcho?.workspaceId || "memory",
        device: computerName(),
        ...(options.replace === true ? { replace: true } : {}),
      }, { paths });
    } catch (error) {
      return { ok: false, error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}), ...(error?.payload?.server ? { server: error.payload.server } : {}) };
    }
    const shared = await shareEnableTeam({
      host: made.server?.host,
      teamDomain: made.teamDomain,
      aud: made.aud,
      owners: [login.email],
      peer: login.peer || config?.user?.peerId || "",
      workspace: config?.honcho?.workspaceId || "memory",
      env: { ...process.env, [TUNNEL_TOKEN_ENV]: made.tunnelToken },
    });
    return { ...shared, server: made.server };
  }
  if (action === "scopes") {
    if (!config) return { ok: false, error: "Run setup apply first" };
    const access = await readGateAccess(gate);
    const projects = new Map();
    for (const person of Object.values(access.people)) {
      for (const project of person.chat?.projects || []) projects.set(project.id, project);
    }
    return syncScopes({ config, projects: [...projects.values()] });
  }
  if (action === "grants") return { ok: true, grants: await gateGrants(gate) };
  if (action === "devices") return { ok: true, devices: await gateDevices(gate) };
  return { ok: false, error: `Unknown team action: ${action}. Expected make, status, share, scopes, grants or devices.` };
}

/**
 * `prereqs [--features server,sync]`: what this computer needs before setup,
 * for the features chosen on it.
 */
async function prereqs(options = {}) {
  const value = options.features;
  if (value !== undefined && typeof value !== "string" && value !== true) {
    return { ok: false, error: `--features takes ${FEATURES.join(",")}` };
  }
  const { features, invalid } = parseFeatures(typeof value === "string" ? value : "");
  if (invalid.length) return { ok: false, error: `unknown feature: ${invalid.join(", ")} (expected ${FEATURES.join(", ")})` };
  const config = await loadConfig().catch(() => null);
  return checkPrereqs({ features, serverDir: installedServerDir(config) });
}

async function main() {
  const args = process.argv.slice(2);
  // `setup apply --help` ran apply in the 2026-09-30 install test. Help never acts.
  if (args.some((item) => item === "--help" || item === "-h")) return usage();
  const command = args.shift() || "help";
  // Where the team login lives, for every request to a team server (fetchHoncho).
  if (!process.env[TEAM_AUTH_ENV]) process.env[TEAM_AUTH_ENV] = teamAuthPaths(await loadConfig().catch(() => null)).authFile;
  if (command === "detect") return detect();
  if (command === "prereqs") return prereqs(parseOptions(args));
  if (command === "doctor" || command === "status") return doctor();
  if (command === "hook") return runHook((args.shift() || "").trim().toLowerCase());
  if (command === "server") {
    const subcommand = args.shift() || "status";
    // Sharing is for the personal server only; it takes no --profile.
    if (subcommand === "share") return serverShare(args);
    const options = parseOptions(args);
    const profile = optionString(options.profile, "portable");
    // The chat model is chosen from what the gateway offers, so it only means
    // something for the personal profile.
    if (options.model !== undefined && (typeof options.model !== "string" || profile !== "personal")) {
      return { ok: false, error: "--model takes a model id and applies to --profile personal only" };
    }
    const model = optionString(options.model, "");
    if (subcommand === "plan") return serverPlan({ profile });
    if (subcommand === "prepare") return serverPrepare({ profile, model });
    if (subcommand === "start") return serverStart({
      profile,
      build: options.noBuild !== true,
      model,
    });
    if (subcommand === "status") return serverStatus({ profile: optionString(options.profile, "portable") });
    if (subcommand === "stop") return serverStop({ profile: optionString(options.profile, "portable") });
    if (subcommand === "verify") return serverVerify({
      profile: optionString(options.profile, "personal"),
      liveCompletion: options.liveCompletion === true,
    });
  }
  if (command === "host") {
    const subcommand = args.shift() || "status";
    const options = parseOptions(args);
    const hostOptions = { profile: optionString(options.profile, "personal") };
    if (subcommand === "plan") return hostPlan(hostOptions);
    if (subcommand === "prepare") return hostPrepare(hostOptions);
    if (subcommand === "start") return hostStart(hostOptions);
    if (subcommand === "status") return hostStatus(hostOptions);
    if (subcommand === "stop") return hostStop(hostOptions);
  }
  if (command === "gateway") {
    const subcommand = args.shift() || "open";
    // Asks the gateway to open its own screen, where the user logs in with Codex
    // and Claude, and reports that screen's address.
    if (subcommand === "open") return gatewayOpen({ directory: gatewayDirectory(installedServerDir()) });
  }
  if (command === "setup") {
    const subcommand = args.shift() || "plan";
    const options = parseOptions(args);
    if (subcommand === "plan") return setupPlan(options);
    if (subcommand === "apply") return setupApply(options);
  }
  if (command === "bridge") {
    const subcommand = args.shift() || "";
    if (subcommand === "disconnect") return oldBridgeRemove();
    return { ok: false, error: "The shared-bridge relay was removed: connect a teammate's memory with teammates connect <name> <host>; bridge disconnect removes the old settings" };
  }
  if (command === "target") return targetCommand(args);
  if (command === "backfill") {
    const subcommand = args.shift() || "status";
    const options = parseOptions(args);
    if (subcommand === "run") return ownBackfillRun(options);
    if (subcommand === "start") return ownBackfillStart(options);
    if (subcommand === "status") return ownBackfillStatus();
  }
  if (command === "teammates") return teammatesCommand(args);
  if (command === "team") return teamCommand(args);
  if (command === "backup") {
    const subcommand = args.shift() || "status";
    const positional = [];
    while (args.length && !args[0].startsWith("--")) positional.push(args.shift());
    return backupCommand(subcommand, positional, parseOptions(args));
  }
  if (command === "ui") {
    const subcommand = args.shift() || "open";
    const options = parseOptions(args);
    if (subcommand === "open") return uiOpen(options);
  }
  return usage();
}

try {
  const result = await main();
  if (result?.[REVEALS_TOKEN]) process.stdout.write(formatRevealedToken(result));
  else if (process.argv[2] !== "hook") printJson(result);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  printJson({ ok: false, error: String(error?.message || error) });
  process.exitCode = 1;
}
