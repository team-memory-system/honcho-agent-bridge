import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ACCESS_ENV, configuredAccess } from "./honcho-access.mjs";

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

// Where the collector reads which folders this computer's own server takes.
export const COLLECT_FOLDERS_ENV = "HONCHO_AGENT_COLLECT_FOLDERS";

/**
 * The folders this computer's own server takes, from config.json `collect`:
 * `{ take: [...], skip: [...], rest: "take" | "skip" }`. A session goes by the
 * deepest of those folders it ran in, so a folder taken inside a skipped one is
 * still taken, and the other way round; one in none of them goes by `rest`, which
 * is how folders made later are taken or not. null when it takes everything, as
 * it did before setup could choose.
 */
export function collectFolders(config) {
  const collect = config?.collect;
  if (!collect || typeof collect !== "object") return null;
  const folders = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : []);
  const take = folders(collect.take);
  const skip = folders(collect.skip);
  const rest = collect.rest === "skip" ? "skip" : "take";
  if (!skip.length && rest === "take") return null;
  return { take, skip, rest };
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
    // The team login and device keys a team server takes (team-auth.mjs).
    HONCHO_AGENT_TEAM_AUTH: path.join(paths.dataDir, "state", "team-auth.json"),
    // A configured install sends each finished turn on its own.
    HONCHO_CODEX_INTERNAL_BATCH_SIZE: "1",
    HONCHO_CODEX_EXTERNAL_BATCH_SIZE: "1",
  };
  if (config.honcho?.apiToken) env.HONCHO_API_BEARER_TOKEN = config.honcho.apiToken;
  // The memory server's Access service token, never the shared bridge's.
  const access = configuredAccess(config);
  if (access) {
    env[ACCESS_ENV.clientId] = access.clientId;
    env[ACCESS_ENV.clientSecret] = access.clientSecret;
  }
  if (provider) {
    env.HONCHO_AGENT_HOOK_STATE = path.join(paths.dataDir, "state", `${provider}.json`);
    env.HONCHO_AGENT_HOOK_LOG = path.join(paths.dataDir, "logs", `${provider}.log`);
  }
  const folders = collectFolders(config);
  if (folders) env[COLLECT_FOLDERS_ENV] = JSON.stringify(folders);
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}

export function hostConfigPaths() {
  const home = userHome();
  return {
    codex: path.join(home, ".codex", "hooks.json"),
    claude: path.join(home, ".claude", "settings.json"),
  };
}
