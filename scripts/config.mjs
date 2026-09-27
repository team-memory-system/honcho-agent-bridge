import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APP_ID = "honcho-agent-bridge";
export const CONFIG_VERSION = 1;

export function userHome() {
  return path.resolve(process.env.HONCHO_AGENT_BRIDGE_USER_HOME || os.homedir());
}

export function defaultAppHome() {
  if (process.env.HONCHO_AGENT_BRIDGE_HOME) return path.resolve(process.env.HONCHO_AGENT_BRIDGE_HOME);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(userHome(), "AppData", "Local");
    return path.join(base, "HonchoAgentBridge");
  }
  if (process.platform === "darwin") {
    return path.join(userHome(), "Library", "Application Support", "HonchoAgentBridge");
  }
  const base = process.env.XDG_DATA_HOME || path.join(userHome(), ".local", "share");
  return path.join(base, APP_ID);
}

export function installPaths(config = null) {
  const appHome = defaultAppHome();
  const dataDir = path.resolve(config?.paths?.dataDir || path.join(appHome, "data"));
  return {
    appHome,
    configPath: path.resolve(process.env.HONCHO_AGENT_BRIDGE_CONFIG || path.join(appHome, "config.json")),
    dataDir,
    // Keep the replaceable collector runtime isolated from the long-running
    // personal-profile host supervisor in runtime/host. On Windows a running
    // supervisor holds files open, so replacing their common parent would make
    // an otherwise unrelated collector upgrade fail with EPERM.
    runtimeDir: path.join(appHome, "runtime", "collector"),
    backupsDir: path.join(appHome, "backups"),
  };
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function loadConfig() {
  const { configPath } = installPaths();
  const config = await readJson(configPath, null);
  if (!config || typeof config !== "object" || config.version !== CONFIG_VERSION) return null;
  return config;
}

export function configEnvironment(config, provider = "") {
  if (!config) return {};
  const paths = installPaths(config);
  const env = {
    HONCHO_AGENT_BRIDGE_HOME: paths.appHome,
    HONCHO_AGENT_BRIDGE_CONFIG: paths.configPath,
    HONCHO_BASE_URL: config.honcho?.baseUrl || "http://127.0.0.1:8001",
    HONCHO_WORKSPACE_ID: config.honcho?.workspaceId || "memory",
    HONCHO_USER_NAME: config.user?.peerId || "",
    HONCHO_AGENT_GATE_SPOOL: path.join(paths.dataDir, "spool"),
    HONCHO_AGENT_GATE_LOG: path.join(paths.dataDir, "logs", "gate.log"),
    HONCHO_CODEX_INTERNAL_BATCH_SIZE: String(config.queue?.internalBatchSize ?? 1),
    HONCHO_CODEX_EXTERNAL_BATCH_SIZE: String(config.queue?.externalBatchSize ?? 1),
  };
  if (config.honcho?.apiToken) env.HONCHO_API_BEARER_TOKEN = config.honcho.apiToken;
  if (config.sources?.codex?.root) env.CODEX_SESSION_ROOT = config.sources.codex.root;
  if (provider) {
    env.HONCHO_AGENT_HOOK_STATE = path.join(paths.dataDir, "state", `${provider}.json`);
    env.HONCHO_AGENT_HOOK_LOG = path.join(paths.dataDir, "logs", `${provider}.log`);
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}

export function hostConfigPaths() {
  const home = userHome();
  return {
    codex: path.join(home, ".codex", "hooks.json"),
    claude: path.join(home, ".claude", "settings.json"),
  };
}
