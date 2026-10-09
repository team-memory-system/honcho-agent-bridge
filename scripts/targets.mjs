// Other memory servers that also receive the conversations from chosen folders.
//
// Every conversation still goes to the owner's own server (config.honcho), exactly
// as before. A target is a second server - usually the company's shared Honcho -
// that receives a copy of the conversations whose working directory is one of its
// folders or inside one:
//
//   config.targets = [{ id, label, honcho: { baseUrl, apiToken?, access?, workspaceId },
//                       userPeerId?, folders: [absolute paths], agents?, enabled }]
//
// Each target keeps everything of its own under <dataDir>/targets/<id>/:
//
//   spool/<provider>/pending/*.json   turns waiting to be sent there
//   state/<provider>.json             what was sent there (the collector's dedupe state)
//   logs/<provider>.log               the collector's log for that server
//   backfill.json                     how far `target backfill` got
//
// so a server that is down only holds up its own spool, and nothing sent to one
// server is ever taken as sent to another.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { COLLECT_FOLDERS_ENV, collectFolders, installPaths } from "./config.mjs";
import { ACCESS_ENV } from "./honcho-access.mjs";
import { automationCwd } from "./projects.mjs";
import { publicUrl } from "./redact.mjs";

/** A target id is a slug: it names a directory and appears in check names. */
export const TARGET_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Where `target add` reads a target's secrets. Never a command-line option. */
export const TARGET_SECRET_ENV = Object.freeze({
  apiToken: "HONCHO_TARGET_API_TOKEN",
  accessClientId: "HONCHO_TARGET_CF_ACCESS_CLIENT_ID",
  accessClientSecret: "HONCHO_TARGET_CF_ACCESS_CLIENT_SECRET",
});

/** The collector reads the folder filter from here; when set, it sends nothing outside them. */
export const TARGET_FOLDERS_ENV = "HONCHO_AGENT_TARGET_FOLDERS";
export const TARGET_ID_ENV = "HONCHO_AGENT_TARGET_ID";

/** Only these agents record a working directory, so only they can go to a target. */
export const TARGET_PROVIDERS = Object.freeze(["codex", "claude"]);

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

/**
 * Case matters on Linux only. Windows and the default macOS file system (APFS,
 * case-insensitive) treat /Users/Me/Work and /users/me/work as one folder, and a
 * transcript's cwd is spelled however the shell spelled it.
 */
function caseInsensitive(platform) {
  return platform === "win32" || platform === "darwin";
}

/**
 * One spelling per folder: `~` expanded, `.`/`..` and repeated separators
 * resolved, no trailing separator (except for a root), and lower case where the
 * file system ignores case. Relative paths are not folders a session can be in.
 */
export function normalizeFolder(value, { platform = process.platform, home = os.homedir() } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let text = String(value || "").trim();
  if (!text) return "";
  text = expandHome(text, home);
  if (platform === "win32") text = text.replace(/\//g, "\\");
  if (!pathApi.isAbsolute(text)) return "";
  let normalized = pathApi.resolve(text);
  const root = pathApi.parse(normalized).root;
  while (normalized.length > root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return caseInsensitive(platform) ? normalized.toLowerCase() : normalized;
}

/** Whether `inner` is `outer` or inside it, both normalized: /a/b/c is inside /a/b, /a/bc is not. */
function within(inner, outer, sep) {
  if (!inner || !outer) return false;
  if (inner === outer) return true;
  const prefix = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner.startsWith(prefix);
}

function realpathOrNull(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

/**
 * Whether a session whose working directory is `cwd` belongs to one of `folders`.
 * A session without a cwd (a ChatGPT import, an Antigravity conversation) never
 * does. Symlinked spellings (macOS /tmp is /private/tmp) are compared too, when
 * the paths exist on this machine.
 */
export function folderMatches(cwd, folders, { platform = process.platform, home = os.homedir(), resolveLinks = true } = {}) {
  if (typeof cwd !== "string" || !cwd.trim() || !Array.isArray(folders) || folders.length === 0) return false;
  const sep = platform === "win32" ? "\\" : "/";
  const options = { platform, home };
  const spellings = (value) => {
    const values = new Set([normalizeFolder(value, options)]);
    if (resolveLinks && platform === process.platform) {
      const real = realpathOrNull(expandHome(String(value).trim(), home));
      if (real) values.add(normalizeFolder(real, options));
    }
    values.delete("");
    return [...values];
  };
  const cwdSpellings = spellings(cwd);
  return folders.some((folder) => {
    const folderSpellings = spellings(folder);
    return cwdSpellings.some((inner) => folderSpellings.some((outer) => within(inner, outer, sep)));
  });
}

/** The folder filter as the collector receives it, or null when it is not a target run. */
export function foldersFromEnvironment(env = process.env) {
  const raw = env[TARGET_FOLDERS_ENV];
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    // A filter that cannot be read matches nothing, rather than everything.
    return [];
  }
}

/**
 * The folders this computer's own server takes, as the collector receives them
 * (configEnvironment): null when it takes everything. A filter that cannot be read
 * takes nothing, rather than everything.
 */
export function collectFoldersFromEnvironment(env = process.env) {
  const raw = env[COLLECT_FOLDERS_ENV];
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return collectFolders({ collect: parsed });
  } catch {}
  return { take: [], skip: [], rest: "skip" };
}

/** How deep the deepest of `folders` that holds `cwd` is, or -1 when none does. */
function deepestHolding(cwd, folders, options) {
  let depth = -1;
  for (const folder of folders) {
    if (!folderMatches(cwd, [folder], options)) continue;
    depth = Math.max(depth, normalizeFolder(folder, options).split(/[\\/]+/).filter(Boolean).length);
  }
  return depth;
}

/**
 * Whether this computer's own server leaves out a session that ran in `cwd`: the
 * deepest folder of `take` and `skip` that holds it decides, a skip when both name
 * the same one; a session in none of them, or with no folder, goes by `rest`. An
 * automation run (projects.mjs automationCwd, such as one at `/`) is in no folder
 * the project list shows, so `rest` never takes it: 새로 생기는 프로젝트 폴더도
 * 수집 is about project folders.
 */
export function outsideCollectFolders(cwd, filter, options) {
  if (!filter) return false;
  const take = deepestHolding(cwd, filter.take, options);
  const skip = deepestHolding(cwd, filter.skip, options);
  if (take < 0 && skip < 0) return filter.rest === "skip" || (typeof cwd === "string" && automationCwd(cwd));
  return skip >= take;
}

/** The targets in a configuration, with their defaults filled in. */
export function configuredTargets(config) {
  if (!config || !Array.isArray(config.targets)) return [];
  return config.targets
    .filter((target) => target && typeof target === "object" && TARGET_ID.test(String(target.id || "")))
    .map((target) => ({
      ...target,
      enabled: target.enabled !== false,
      folders: Array.isArray(target.folders) ? target.folders.filter((item) => typeof item === "string") : [],
      honcho: target.honcho && typeof target.honcho === "object" ? target.honcho : {},
    }));
}

/** The agents a target takes conversations from: its own choice, else the primary's. */
export function targetAgents(config, target) {
  const chosen = target?.agents && typeof target.agents === "object" ? target.agents : config?.agents || {};
  return Object.fromEntries(TARGET_PROVIDERS.map((name) => [name, Boolean(chosen[name])]));
}

export function targetUserPeer(config, target) {
  return String(target?.userPeerId || config?.user?.peerId || "").trim();
}

export function targetWorkspace(config, target) {
  return String(target?.honcho?.workspaceId || config?.honcho?.workspaceId || "memory").trim();
}

/** The enabled targets that take this provider's conversations. */
export function activeTargets(config, provider) {
  if (!TARGET_PROVIDERS.includes(provider)) return [];
  return configuredTargets(config).filter((target) => target.enabled
    && target.folders.length > 0
    && target.honcho.baseUrl
    && targetAgents(config, target)[provider]);
}

export function targetAccess(target) {
  const access = target?.honcho?.access;
  const id = String(access?.clientId || "").trim();
  const secret = String(access?.clientSecret || "").trim();
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

/** Everything a target keeps on disk, in its own directory. */
export function targetPaths(config, id) {
  const root = path.join(installPaths(config).dataDir, "targets", id);
  return {
    root,
    spool: (provider) => path.join(root, "spool", provider),
    pending: (provider) => path.join(root, "spool", provider, "pending"),
    state: (provider) => path.join(root, "state", `${provider}.json`),
    log: (provider) => path.join(root, "logs", `${provider}.log`),
    backfill: path.join(root, "backfill.json"),
  };
}

// The primary server's credentials, under every name the collector reads them.
const PRIMARY_SECRET_ENV = [
  "HONCHO_API_BEARER_TOKEN",
  ACCESS_ENV.clientId,
  ACCESS_ENV.clientSecret,
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
];

/**
 * The collector's environment for one target: that server, its credentials and no
 * other's, its own state and log, and its folders. The primary's token never
 * travels to a target, and a target's never to the primary.
 */
export function targetEnvironment(config, target, provider, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const name of PRIMARY_SECRET_ENV) delete env[name];
  for (const name of Object.values(TARGET_SECRET_ENV)) delete env[name];
  const paths = targetPaths(config, target.id);
  env.HONCHO_BASE_URL = String(target.honcho.baseUrl).replace(/\/+$/, "");
  env.HONCHO_WORKSPACE_ID = targetWorkspace(config, target);
  env.HONCHO_USER_NAME = targetUserPeer(config, target);
  const token = String(target.honcho.apiToken || "").trim();
  if (token) env.HONCHO_API_BEARER_TOKEN = token;
  const access = targetAccess(target);
  if (access) {
    env[ACCESS_ENV.clientId] = access.clientId;
    env[ACCESS_ENV.clientSecret] = access.clientSecret;
  }
  env.HONCHO_AGENT_PROVIDER = provider;
  env.HONCHO_AGENT_HOOK_STATE = paths.state(provider);
  env.HONCHO_AGENT_HOOK_LOG = paths.log(provider);
  env[TARGET_ID_ENV] = target.id;
  env[TARGET_FOLDERS_ENV] = JSON.stringify(target.folders);
  // The own server's folder choice says nothing about what a target takes.
  delete env[COLLECT_FOLDERS_ENV];
  return env;
}

/** The collector's environment for the primary server: never a target's filter. */
export function withoutTargetFilter(env) {
  const next = { ...env };
  delete next[TARGET_FOLDERS_ENV];
  delete next[TARGET_ID_ENV];
  return next;
}

/** How many turns wait in a spool's pending folder to be sent. */
export async function countPending(directory) {
  try {
    return (await fsp.readdir(directory)).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

// state file -> { size, mtimeMs, summary }: a file that has not changed is not parsed again.
const sentCache = new Map();

/**
 * What a collector state file says was sent: `{ lastAt, sessions }`, the newest
 * send and how many conversations went. Missing or unreadable: nothing sent.
 */
export async function sentSummary(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { lastAt: "", sessions: 0 };
  }
  const cached = sentCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.summary;
  let summary = { lastAt: "", sessions: 0 };
  try {
    const sessions = Object.values(JSON.parse(await fsp.readFile(file, "utf8"))?.sessions || {});
    let lastAt = "";
    for (const session of sessions) {
      const value = typeof session?.last_imported_at === "string" ? session.last_imported_at : "";
      if (value > lastAt) lastAt = value;
    }
    summary = { lastAt, sessions: sessions.length };
  } catch {
    // Caught mid-write: the next write changes the file, and it is read again.
  }
  sentCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, summary });
  return summary;
}

/** What a caller may see about a target: never a secret, only whether one is set. */
export async function targetSummary(config, target) {
  const paths = targetPaths(config, target.id);
  let pending = 0;
  let lastSentAt = "";
  for (const provider of TARGET_PROVIDERS) {
    pending += await countPending(paths.pending(provider));
    const { lastAt } = await sentSummary(paths.state(provider));
    if (lastAt > lastSentAt) lastSentAt = lastAt;
  }
  return {
    id: target.id,
    label: String(target.label || target.id),
    url: target.honcho.baseUrl ? publicUrl(target.honcho.baseUrl) : null,
    workspace: targetWorkspace(config, target),
    userPeerId: targetUserPeer(config, target),
    folders: [...target.folders],
    agents: targetAgents(config, target),
    enabled: target.enabled,
    // A team's server, reached with the team login and turned on once its owner approves.
    team: target.team === true,
    hasToken: Boolean(String(target.honcho.apiToken || "").trim()),
    hasAccess: Boolean(targetAccess(target)),
    pending,
    lastSentAt: lastSentAt || null,
  };
}
