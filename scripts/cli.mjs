import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_VERSION,
  configEnvironment,
  hostConfigPaths,
  installPaths,
  loadConfig,
  readJson,
  userHome,
} from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { VERSION } from "./version.mjs";
import { serverPlan, serverPrepare, serverStart, serverStatus, serverStop, serverVerify } from "./server-manager.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAIN_SCRIPT = path.join(SCRIPT_DIR, "main.mjs");
const CURRENT_HOOK_MARKER = "--managed-by agent-memory";
const LEGACY_HOOK_MARKERS = ["codex-honcho-sync", "honcho-turn-gate"];

function parseOptions(items) {
  const options = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = items[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(redactSecrets(value), null, 2)}\n`);
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/(token|secret|api[_-]?key|authorization)/i.test(key) && item) return [key, "[redacted]"];
      if (typeof item === "string" && /(url|uri|address)$/i.test(key)) return [key, publicUrl(item)];
      if (typeof item === "string" && /(error|message|stack)/i.test(key)) return [key, sanitizeUrlsInText(item)];
      return [key, redactSecrets(item)];
    }),
  );
}

function sanitizeUrlsInText(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/gi, (match) => publicUrl(match));
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "[invalid URL]";
  }
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

async function probe(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeWorkspaceAccess(config, timeoutMs = 2000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (config.honcho?.apiToken) headers.Authorization = `Bearer ${config.honcho.apiToken}`;
  try {
    const response = await fetch(`${config.honcho.baseUrl.replace(/\/+$/, "")}/v3/workspaces/list`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: sanitizeUrlsInText(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
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
  const valid = Boolean(document.user?.peerId && document.honcho?.baseUrl && document.honcho?.workspaceId && document.agents);
  return { ok: valid, state: valid ? "valid" : "invalid-schema", path: configPath, config: valid ? document : null };
}

async function claudePluginStatus() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return { installed: true, enabled: true, source: "plugin-root" };
  const document = await readJson(path.join(userHome(), ".claude", "plugins", "installed_plugins.json"), {});
  const names = Object.keys(document?.plugins || {}).filter(
    (name) => name === "agent-memory" || name.startsWith("agent-memory@"),
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
  const header = text.match(/^\[plugins\."(agent-memory(?:@[^"]+)?)"\]\s*$/m);
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

async function detect() {
  const paths = installPaths();
  const hostPaths = hostConfigPaths();
  const config = await loadConfig();
  const honchoUrl = config?.honcho?.baseUrl || "http://127.0.0.1:8001";
  const [codexConfig, claudeConfig, codexSessions, codexPlugin, claudePlugin, honcho] = await Promise.all([
    pathExists(path.dirname(hostPaths.codex)),
    pathExists(path.dirname(hostPaths.claude)),
    pathExists(path.join(userHome(), ".codex", "sessions")),
    codexPluginStatus(),
    claudePluginStatus(),
    probe(`${honchoUrl.replace(/\/+$/, "")}/health`),
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
    honcho: { baseUrl: publicUrl(honchoUrl), health: honcho },
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
  const config = {
    version: CONFIG_VERSION,
    user: { peerId: optionString(options.userPeer, existing?.user?.peerId || "") },
    honcho: {
      baseUrl: optionString(options.honchoUrl, existing?.honcho?.baseUrl || "http://127.0.0.1:8001"),
      workspaceId: optionString(options.workspace, existing?.honcho?.workspaceId || "memory"),
      ...(existing?.honcho?.apiToken ? { apiToken: existing.honcho.apiToken } : {}),
    },
    agents,
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
  const issues = [];
  const warnings = [];
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
  for (const provider of ["codex", "claude"]) {
    if (agents[provider] && !detected.agents[provider].plugin?.enabled) {
      warnings.push(`${provider} collection is enabled, but the Agent Memory plugin was not detected as enabled in ${provider}`);
    }
  }
  return {
    ok: issues.length === 0,
    ready: issues.length === 0,
    version: VERSION,
    issues,
    warnings,
    choices: {
      selectedAgents,
      honchoMode: detected.honcho.health.ok ? "connect-existing" : "external-setup-required",
    },
    config,
    operations: [
      { type: "install-runtime", target: paths.runtimeDir },
      ...(agents.codex
        ? [{ type: "merge-hook", agent: "codex", target: hostConfigPaths().codex }]
        : [{ type: "remove-managed-hook", agent: "codex", target: hostConfigPaths().codex }]),
      ...(agents.claude
        ? [
            { type: "use-plugin-hook", agent: "claude", target: "hooks/hooks.json" },
            { type: "remove-legacy-managed-hook", agent: "claude", target: hostConfigPaths().claude },
          ]
        : [{ type: "remove-legacy-managed-hook", agent: "claude", target: hostConfigPaths().claude }]),
      { type: "write-config", target: paths.configPath },
    ],
  };
}

function isManagedHookHandler(handler) {
  const command = typeof handler?.command === "string" ? handler.command : "";
  return command.includes(CURRENT_HOOK_MARKER) || LEGACY_HOOK_MARKERS.some((marker) => command.includes(marker));
}

function isManagedHook(document) {
  return (document?.hooks?.Stop || []).some((entry) => {
    if (isManagedHookHandler(entry)) return true;
    return Array.isArray(entry?.hooks) && entry.hooks.some(isManagedHookHandler);
  });
}

function hasCurrentManagedHook(document, runtimeDir, provider) {
  const expected = hookCommand(runtimeDir, provider);
  return (document?.hooks?.Stop || []).some((entry) => {
    if (entry?.command === expected) return true;
    return Array.isArray(entry?.hooks) && entry.hooks.some((handler) => handler?.command === expected);
  });
}

function hookCommand(runtimeDir, provider) {
  const cliPath = path.join(runtimeDir, "cli.mjs");
  return `"${process.execPath}" "${cliPath}" hook ${provider} ${CURRENT_HOOK_MARKER}`;
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
  return `${filePath}.agent-memory-backup-${stamp}`;
}

async function writeJsonAtomic(filePath, value, { backup = false } = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  if (backup && (await pathExists(filePath))) await fsp.copyFile(filePath, backupName(filePath));
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

async function restoreFileSnapshot(filePath, snapshot) {
  if (!snapshot.existed) {
    await fsp.rm(filePath, { force: true });
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
  if (!lock) throw new Error("Agent Memory setup is already running");
  try {
    return await fn();
  } finally {
    await releaseFileLock(lock);
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
        target: provider === "claude" ? "hooks/hooks.json" : target,
        installed: enabled,
        mode: provider === "claude" ? "bundled-plugin" : "host-settings",
        legacyHookRemoved: provider === "claude" && !documentsEqual(current, cleaned),
        changed: shouldWrite,
      });
    }
    await writeJsonAtomic(
      paths.configPath,
      { ...plan.config, installedVersion: VERSION, installedAt: new Date().toISOString() },
      { backup: true },
    );
    await finalizeRuntime(runtime);
    return { ok: true, version: VERSION, paths, runtime, hooks, restartRequired: true };
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
      await restoreFileSnapshot(paths.configPath, configSnapshot);
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

async function probeMcpServer(serverPath, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath, "--provider", "doctor"], {
      env: process.env,
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
            finish({
              ok: Boolean(initialized && Array.isArray(message.result?.tools)),
              protocolVersion: initialized?.protocolVersion || "",
              enabledToolCount: Array.isArray(message.result?.tools) ? message.result.tools.length : null,
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
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agent-memory-doctor", version: VERSION } },
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
    "file-lock.mjs",
    "version.mjs",
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
    const health = await probe(`${config.honcho.baseUrl.replace(/\/+$/, "")}/health`);
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
            ? "The hook is loaded by the installed Agent Memory Claude plugin."
            : "Install or enable Agent Memory in Claude Code so its bundled hook can load.",
        });
      } else {
        const target = hostConfigPaths()[provider];
        const document = await readJson(target, {});
        checks.push({ name: `${provider}-hook`, ok: hasCurrentManagedHook(document, paths.runtimeDir, provider), path: target });
      }
    }
  }
  return { ok: checks.every((check) => check.ok), version: VERSION, checks };
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

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || "help";
  if (command === "detect") return detect();
  if (command === "doctor" || command === "status") return doctor();
  if (command === "hook") return runHook((args.shift() || "").trim().toLowerCase());
  if (command === "server") {
    const subcommand = args.shift() || "status";
    const options = parseOptions(args);
    if (subcommand === "plan") return serverPlan({ profile: optionString(options.profile, "portable") });
    if (subcommand === "prepare") return serverPrepare({ profile: optionString(options.profile, "portable") });
    if (subcommand === "start") return serverStart({
      profile: optionString(options.profile, "portable"),
      build: options.noBuild !== true,
    });
    if (subcommand === "status") return serverStatus({ profile: optionString(options.profile, "portable") });
    if (subcommand === "stop") return serverStop({ profile: optionString(options.profile, "portable") });
    if (subcommand === "verify") return serverVerify({
      profile: optionString(options.profile, "personal"),
      liveCompletion: options.liveCompletion === true,
    });
  }
  if (command === "setup") {
    const subcommand = args.shift() || "plan";
    const options = parseOptions(args);
    if (subcommand === "plan") return setupPlan(options);
    if (subcommand === "apply") return setupApply(options);
  }
  return {
    ok: true,
    version: VERSION,
    usage: [
      "detect",
      "server plan [--profile portable|personal]",
      "server prepare [--profile portable|personal]",
      "server start [--profile portable|personal] [--no-build]",
      "server status [--profile portable|personal]",
      "server stop [--profile portable|personal]",
      "server verify [--profile personal] [--live-completion]",
      "setup plan [options]",
      "setup apply [options]",
      "doctor",
      "status",
    ],
  };
}

try {
  const result = await main();
  if (!process.argv.includes("hook")) printJson(result);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  printJson({ ok: false, error: String(error?.message || error) });
  process.exitCode = 1;
}
