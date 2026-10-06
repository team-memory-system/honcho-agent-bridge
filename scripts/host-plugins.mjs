// Puts this plugin into Claude Code or Codex when setup turns collection on for a
// host that does not have it yet. Claude Code's Stop hook ships only inside the
// plugin, and Codex gets its skills and recall MCP server from it, so a host
// without the plugin collects little or nothing.
//
// The source is the one this plugin came from: the marketplace record of the host
// that has it (Claude Code's for Codex, Codex's for Claude Code), else this
// repository on GitHub. Each host's own CLI does the install, through the same
// argument-checked runner `teammates connect` uses:
//   codex  plugin marketplace add <source> [--ref <ref>]; codex plugin add honcho-agent-bridge@<marketplace>
//   claude plugin marketplace add <source>[#<ref>];        claude plugin install honcho-agent-bridge@<marketplace> --scope user
// A marketplace the host already has is not added again: Claude Code would point
// it at the new source, and Codex refuses a second source under the same name.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CLIENT_NAMES, clientFailure, findClient, runClient, safeClientArgument } from "./team-access.mjs";

export const PLUGIN_NAME = "honcho-agent-bridge";
export const DEFAULT_MARKETPLACE = "honcho-agent-bridge";
export const DEFAULT_SOURCE = "team-memory-system/honcho-agent-bridge";
// A marketplace add clones from git; 60 s is not always enough for that.
export const PLUGIN_INSTALL_TIMEOUT_MS = 180_000;
// The Codex CLI the desktop app ships on macOS, for a computer with the app only.
export const MACOS_CODEX_APP_CLIS = Object.freeze([
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
]);

const HOSTS = ["codex", "claude"];
const MARKETPLACE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const GITHUB_REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const GIT_URL = /^(?:https:\/\/|ssh:\/\/|git@)/;
const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

function hostFiles(home) {
  return {
    claudeInstalled: path.join(home, ".claude", "plugins", "installed_plugins.json"),
    claudeMarketplaces: path.join(home, ".claude", "plugins", "known_marketplaces.json"),
    codexConfig: path.join(home, ".codex", "config.toml"),
  };
}

async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
}

/** A TOML string value: '...' as it is, "..." with \" and \\ undone; anything else is null. */
function tomlString(raw) {
  const literal = raw.match(/^'([^']*)'/);
  if (literal) return literal[1];
  const basic = raw.match(/^"((?:[^"\\]|\\.)*)"/);
  return basic ? basic[1].replace(/\\(["\\])/g, "$1") : null;
}

/** `[table]` headers and their string keys, read without a TOML parser. */
function tomlTables(text) {
  const tables = new Map();
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\[\[/.test(line)) { current = null; continue; }
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      current = header[1].trim();
      if (!tables.has(current)) tables.set(current, {});
      continue;
    }
    const pair = current !== null && line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (pair) tables.get(current)[pair[1]] = tomlString(pair[2]);
  }
  return tables;
}

function tableName(header, prefix) {
  const match = header.match(new RegExp(`^${prefix}\\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$`));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

/** The marketplace Claude Code installed this plugin from: {name, source} from known_marketplaces.json. */
export async function claudeMarketplaceRecord(home) {
  const files = hostFiles(home);
  const [installed, known] = await Promise.all([readJsonFile(files.claudeInstalled), readJsonFile(files.claudeMarketplaces)]);
  for (const id of Object.keys(installed?.plugins || {})) {
    if (!id.startsWith(`${PLUGIN_NAME}@`)) continue;
    const name = id.slice(PLUGIN_NAME.length + 1);
    const source = known?.[name]?.source;
    if (source && typeof source === "object") return { name, source };
  }
  return null;
}

/** The marketplace Codex installed this plugin from: {name, source} from its [marketplaces.<name>] table. */
export async function codexMarketplaceRecord(home) {
  const tables = tomlTables(await fsp.readFile(hostFiles(home).codexConfig, "utf8").catch(() => ""));
  for (const header of tables.keys()) {
    const id = tableName(header, "plugins");
    if (!id?.startsWith(`${PLUGIN_NAME}@`)) continue;
    const name = id.slice(PLUGIN_NAME.length + 1);
    for (const [other, table] of tables) {
      if (tableName(other, "marketplaces") === name) return { name, source: table };
    }
  }
  return null;
}

function withRef(source, ref) {
  if (!safeClientArgument(source)) return null;
  if (ref === undefined || ref === null || ref === "") return { source };
  return typeof ref === "string" && GIT_REF.test(ref) ? { source, ref } : null;
}

function localDirectory(value) {
  return typeof value === "string" && path.isAbsolute(value) && safeClientArgument(value) ? { source: value } : null;
}

function fromClaudeRecord(source) {
  if (source?.source === "github" && GITHUB_REPO.test(source.repo || "")) return withRef(source.repo, source.ref);
  if (source?.source === "git" && GIT_URL.test(source.url || "")) return withRef(source.url, source.ref);
  if (source?.source === "directory") return localDirectory(source.path);
  return null;
}

function fromCodexRecord(table) {
  if (table?.source_type === "git" && GIT_URL.test(table.source || "")) return withRef(table.source, table.ref);
  if (table?.source_type === "local") return localDirectory(table.source);
  return null;
}

/**
 * Where to install this plugin into `host` from: {source, ref?, marketplace, from}.
 * The other host's record when it maps to an argument the CLI can take, else
 * team-memory-system/honcho-agent-bridge.
 */
export async function pluginSource(host, { home }) {
  const record = host === "codex" ? await claudeMarketplaceRecord(home) : await codexMarketplaceRecord(home);
  const mapped = record && MARKETPLACE_NAME.test(record.name)
    ? (host === "codex" ? fromClaudeRecord(record.source) : fromCodexRecord(record.source))
    : null;
  if (mapped) return { ...mapped, marketplace: record.name, from: host === "codex" ? "claude" : "codex" };
  return { source: DEFAULT_SOURCE, marketplace: DEFAULT_MARKETPLACE, from: "default" };
}

/** The two calls that install the plugin into `host`, as argument lists. */
export function pluginInstallArgs(host, { source, ref, marketplace }) {
  const id = `${PLUGIN_NAME}@${marketplace}`;
  if (host === "codex") {
    return [["plugin", "marketplace", "add", source, ...(ref ? ["--ref", ref] : [])], ["plugin", "add", id]];
  }
  return [["plugin", "marketplace", "add", ref ? `${source}#${ref}` : source], ["plugin", "install", id, "--scope", "user"]];
}

/** The same two calls as commands a person types. */
export function manualCommands(host, source) {
  return pluginInstallArgs(host, source).map((args) => [host, ...args].join(" "));
}

function executableFile(candidate, platform) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The CODEX_CLI_PATH values ~/.codex/config.toml holds; the Codex app writes its own CLI's path there. */
async function configuredCodexClis(home) {
  const text = await fsp.readFile(hostFiles(home).codexConfig, "utf8").catch(() => "");
  return [...text.matchAll(/^\s*CODEX_CLI_PATH\s*=\s*(.+?)\s*$/gm)].map((match) => tomlString(match[1])).filter(Boolean);
}

/**
 * The host's CLI: the one on PATH, and for Codex then the desktop app's own CLI
 * (CODEX_CLI_PATH in the environment, then in ~/.codex/config.toml, then the app
 * bundle on macOS). null when there is none.
 */
export async function hostCli(host, { home, env = process.env, platform = process.platform, appClis } = {}) {
  const found = findClient(host, { env, platform });
  if (found || host !== "codex") return found;
  const bundles = appClis ?? (platform === "darwin" ? MACOS_CODEX_APP_CLIS : []);
  const candidates = [env.CODEX_CLI_PATH, ...(await configuredCodexClis(home)), ...bundles];
  return candidates.find((candidate) => executableFile(candidate, platform)) || null;
}

/**
 * What setup does about the plugin in each host it collects from, one entry per
 * host: `enabled` or `disabled` when the plugin is there (a turned-off plugin is
 * left off), `install` when the host's CLI is here, else `missing-cli`. The last
 * two carry the source and the commands to run by hand.
 */
export async function hostPluginPlan(agents, { statuses = {}, home, env = process.env, platform = process.platform, appClis } = {}) {
  const entries = [];
  for (const host of HOSTS) {
    if (!agents?.[host]) continue;
    const status = statuses[host] || {};
    if (status.installed) {
      entries.push({ agent: host, state: status.enabled ? "enabled" : "disabled" });
      continue;
    }
    const source = await pluginSource(host, { home });
    const cli = await hostCli(host, { home, env, platform, appClis });
    entries.push({ agent: host, state: cli ? "install" : "missing-cli", ...source, cli, commands: manualCommands(host, source) });
  }
  return entries;
}

async function hasMarketplace(host, name, home) {
  const files = hostFiles(home);
  if (host === "claude") {
    const known = await readJsonFile(files.claudeMarketplaces);
    return Boolean(known && typeof known === "object" && Object.hasOwn(known, name));
  }
  const tables = tomlTables(await fsp.readFile(files.codexConfig, "utf8").catch(() => ""));
  return [...tables.keys()].some((header) => tableName(header, "marketplaces") === name);
}

function failure(result, timeoutMs) {
  return result.timedOut ? `did not finish within ${Math.round(timeoutMs / 1000)} s` : clientFailure(result);
}

function missingCli(host) {
  return { action: "missing-cli", error: `${CLIENT_NAMES[host]} (${host}) was not found on this computer` };
}

async function installOne(entry, { ctx, home, timeoutMs }) {
  const [marketplaceArgs, pluginArgs] = pluginInstallArgs(entry.agent, entry);
  const options = { binary: entry.cli, timeoutMs };
  try {
    if (!(await hasMarketplace(entry.agent, entry.marketplace, home))) {
      const added = await runClient(ctx, entry.agent, marketplaceArgs, options);
      if (added.missing) return missingCli(entry.agent);
      const text = `${added.stderr || ""}\n${added.stdout || ""}`;
      if (added.code !== 0 && !/already (?:added|exists|on disk)/i.test(text)) return { action: "failed", error: failure(added, timeoutMs) };
    }
    const installed = await runClient(ctx, entry.agent, pluginArgs, options);
    if (installed.missing) return missingCli(entry.agent);
    if (installed.code !== 0) return { action: "failed", error: failure(installed, timeoutMs) };
    return { action: "installed" };
  } catch (error) {
    return { action: "failed", error: String(error?.message || error).slice(0, 300) };
  }
}

/**
 * Carries out hostPluginPlan's entries, in order: [{agent, action, error?}] with
 * action installed, already, failed or missing-cli. Never throws.
 */
export async function installHostPlugins(entries, { home, env = process.env, platform = process.platform, clientRunner = null, timeoutMs = PLUGIN_INSTALL_TIMEOUT_MS } = {}) {
  const ctx = { env, platform, clientRunner };
  const results = [];
  for (const entry of entries) {
    if (entry.state === "enabled" || entry.state === "disabled") results.push({ agent: entry.agent, action: "already" });
    else if (entry.state === "missing-cli" || !entry.cli) results.push({ agent: entry.agent, ...missingCli(entry.agent) });
    else results.push({ agent: entry.agent, ...(await installOne(entry, { ctx, home, timeoutMs })) });
  }
  return results;
}
