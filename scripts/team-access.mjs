// Who may log in to the team's memory servers, and how a teammate's server joins.
//
// The owner keeps one email list: the reusable Access policy "Team Memory people",
// which every server's people app uses. `teammates add|remove` edit it with the
// owner's Cloudflare API token. `teammates add <email> --share <name>` also makes a
// second server's Cloudflare half (tunnel, memory-<name>.<zone>, ingress, Access
// apps) and writes an invite; the teammate's `server share join` does the local half
// with it and needs no API token. `teammates unshare <name>` removes that half.
//
// Files, beside the installed server under <runtime>:
//   cloudflare/api-token   the owner's API token, owner-only (0600 / owner ACL)
//   team-access.json       ids and names only, no secret: the account, zone, team
//                          domain, Google login, both policies, the owner's server
//                          and every teammate's shared server
// An invite is `tm1.` + base64url(JSON {v:1, host, tunnelToken, teamDomain, aud,
// team:[{name, host}]}). It holds a tunnel token, so it is only ever written to an
// owner-only file the user names, or handed to the app to show once; nothing here
// prints it.
//
// The asking side (`teammates connect|disconnect|connected`) is at the end: Claude
// Code and Codex reach a teammate's server themselves as a remote MCP server and log
// in through Cloudflare Access with OAuth, so nothing here holds a token for it.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLOUDFLARE_API_BASE,
  CloudflareApiError,
  cloudflareClient,
  ensurePeoplePolicy,
  ensureServerHost,
  normalizeEmail,
  policyEmails,
  removeServerHost,
  TUNNEL_PREFIX,
} from "./cloudflare-api.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";
import { installedServerDir } from "./server-manager.mjs";

export const INVITE_PREFIX = "tm1.";
export const INVITE_ENV = "HONCHO_SHARE_INVITE";
export const API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
// Tests point the client at a local fake; only a loopback address is taken from here.
export const API_BASE_ENV = "HONCHO_CLOUDFLARE_API_BASE";
export const TUNNEL_TOKEN_PATTERN = /^[A-Za-z0-9+/=_.-]{20,8192}$/;
const API_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,400}$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const AUD = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_INVITE_LENGTH = 32_768;
const MAX_TEAM = 200;

// ------------------------------------------------------------------ checks

export function validHostname(value) {
  return typeof value === "string" && HOSTNAME.test(value);
}

/** A server's short name: one DNS label, lower case, up to 32 characters. */
export function validName(value) {
  return typeof value === "string" && LABEL.test(value);
}

/** The owner's server is <name>.<zone>; a teammate's is memory-<name>.<zone>. */
export function ownerHost(name, zone) {
  return `${name}.${zone}`;
}

export function sharerHost(name, zone) {
  return `memory-${name}.${zone}`;
}

export function tunnelName(name) {
  return `${TUNNEL_PREFIX}${name}`;
}

// ------------------------------------------------------------------ invites

function inviteError(reason) {
  // Never the code itself: it holds a tunnel token.
  return new Error(`The invite code is not valid: ${reason}`);
}

function checkInvite(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw inviteError("it holds no invite");
  if (value.v !== 1) throw inviteError("it is from another version of Team Memory");
  if (!validHostname(value.host)) throw inviteError("its server address is missing or wrong");
  if (typeof value.tunnelToken !== "string" || !TUNNEL_TOKEN_PATTERN.test(value.tunnelToken)) throw inviteError("its tunnel token is missing or wrong");
  if (!validHostname(value.teamDomain)) throw inviteError("its team domain is missing or wrong");
  if (typeof value.aud !== "string" || !AUD.test(value.aud)) throw inviteError("its Access AUD tag is missing or wrong");
  if (!Array.isArray(value.team) || value.team.length > MAX_TEAM) throw inviteError("its team list is missing or too long");
  const team = value.team.map((item) => {
    if (!item || typeof item !== "object" || !validName(item.name) || !validHostname(item.host)) throw inviteError("its team list has a wrong entry");
    return { name: item.name, host: item.host };
  });
  return { v: 1, host: value.host, tunnelToken: value.tunnelToken, teamDomain: value.teamDomain, aud: value.aud, team };
}

export function encodeInvite(invite) {
  const checked = checkInvite({ v: 1, ...invite });
  return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(checked), "utf8").toString("base64url")}`;
}

/** The invite in a code, checked field by field. Throws an error that never quotes the code. */
export function decodeInvite(code) {
  const text = String(code ?? "").trim();
  if (!text) throw inviteError("it is empty");
  if (text.length > MAX_INVITE_LENGTH) throw inviteError("it is too long");
  if (!text.startsWith(INVITE_PREFIX)) throw inviteError(`it does not start with ${INVITE_PREFIX}`);
  const body = text.slice(INVITE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw inviteError("it has characters an invite never has");
  let value;
  try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw inviteError("it is cut off or changed"); }
  return checkInvite(value);
}

/** The tunnel id a connector token names (`t`), when it can be read; not a secret. */
export function tunnelIdFromToken(token) {
  try {
    const id = JSON.parse(Buffer.from(String(token), "base64").toString("utf8"))?.t;
    return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- files

export function teamAccessPaths({ serverDirectory, runtimeDirectory } = {}) {
  const serverDir = path.resolve(serverDirectory || installedServerDir());
  const runtimeDir = path.resolve(runtimeDirectory || path.join(path.dirname(serverDir), "runtime"));
  return {
    serverDir,
    runtimeDir,
    apiTokenFile: path.join(runtimeDir, "cloudflare", "api-token"),
    teamFile: path.join(runtimeDir, "team-access.json"),
  };
}

export function privateFileOptionsFrom(options = {}) {
  return {
    platform: options.filePlatform || process.platform,
    env: options.env || process.env,
    ...(options.privateFileRunner ? { run: options.privateFileRunner } : {}),
  };
}

export async function readTeamState(paths) {
  try {
    const value = JSON.parse(await fsp.readFile(paths.teamFile, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function writeTeamState(paths, state, privateFileOptions) {
  await writePrivateFileAtomic(paths.teamFile, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, privateFileOptions);
}

/** The API token from CLOUDFLARE_API_TOKEN, else the one saved before. */
export async function readApiToken(paths, env = process.env) {
  const fromEnv = String(env[API_TOKEN_ENV] || "").trim();
  if (fromEnv) {
    if (!API_TOKEN_PATTERN.test(fromEnv)) throw new Error(`${API_TOKEN_ENV} does not look like a Cloudflare API token`);
    return { token: fromEnv, source: "env" };
  }
  const saved = (await fsp.readFile(paths.apiTokenFile, "utf8").catch(() => "")).trim();
  if (saved) return { token: saved, source: "saved" };
  return { token: "", source: null };
}

/** Kept owner-only after a call has worked, so a mistyped token is never saved. */
export async function saveApiToken(paths, token, privateFileOptions) {
  const previous = (await fsp.readFile(paths.apiTokenFile, "utf8").catch(() => "")).trim();
  await writePrivateFileAtomic(paths.apiTokenFile, `${token}\n`, privateFileOptions);
  return previous !== token;
}

export async function apiTokenSaved(paths) {
  return Boolean((await fsp.readFile(paths.apiTokenFile, "utf8").catch(() => "")).trim());
}

function apiBaseUrl(options) {
  if (options.apiBaseUrl) return options.apiBaseUrl;
  const fromEnv = String((options.env || process.env)[API_BASE_ENV] || "").trim();
  if (fromEnv) {
    try {
      const url = new URL(fromEnv);
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fromEnv;
    } catch {}
  }
  return CLOUDFLARE_API_BASE;
}

/** A client for the owner's token, or a result to stop with. */
export async function ownerClient(paths, options = {}) {
  let found;
  try { found = await readApiToken(paths, options.env || process.env); } catch (error) { return { ok: false, error: error.message }; }
  if (!found.token) {
    return { ok: false, error: `The Cloudflare API token is needed: put it in ${API_TOKEN_ENV} (never on the command line)` };
  }
  const client = cloudflareClient({ token: found.token, baseUrl: apiBaseUrl(options), fetchImpl: options.cloudflareFetch || globalThis.fetch });
  return { ok: true, client, token: found.token, source: found.source };
}

/** Writes the invite to a file only the user can read. An existing other file is not replaced. */
export async function writeInviteFile(target, code, privateFileOptions) {
  const file = path.resolve(String(target));
  const existing = await fsp.readFile(file, "utf8").catch((error) => (error?.code === "ENOENT" ? null : ""));
  if (existing !== null && existing.trim() && !existing.trim().startsWith(INVITE_PREFIX)) {
    throw new Error(`${file} already exists and is not an invite; name a new file`);
  }
  await writePrivateFileAtomic(file, `${code}\n`, privateFileOptions);
  return file;
}

// --------------------------------------------------------------- teammates

function failure(error) {
  const message = error instanceof CloudflareApiError || error instanceof Error ? error.message : String(error);
  return { ok: false, error: message };
}

async function ownerContext(options) {
  const paths = teamAccessPaths(options);
  const state = await readTeamState(paths);
  if (!state?.accountId || !state?.peoplePolicyId) {
    return { ok: false, error: "This computer has not shared its server through Cloudflare yet; run server share enable --cloudflare first" };
  }
  const owner = await ownerClient(paths, options);
  if (!owner.ok) return owner;
  return { ok: true, paths, state, ...owner, privateFileOptions: privateFileOptionsFrom(options) };
}

async function afterFirstCall(ctx) {
  // The token worked, so it is worth keeping.
  if (ctx.source === "env") await saveApiToken(ctx.paths, ctx.token, ctx.privateFileOptions);
}

function sharerList(state) {
  return Object.entries(state.sharers || {}).map(([name, item]) => ({ name, host: item.host, email: item.email || null }));
}

/** The servers of the team, for an invite's team list: the owner's first. */
export function teamServers(state) {
  const owner = state.owner?.name && state.owner?.host ? [{ name: state.owner.name, host: state.owner.host }] : [];
  return [...owner, ...sharerList(state).map(({ name, host }) => ({ name, host }))];
}

/**
 * One change to the team at a time: team-access.json and the people list are read,
 * changed and written back. Separate from the server's own lifecycle lock, so the
 * list can be edited while the server starts.
 */
export async function withTeamAccessLock(paths, operation, callback) {
  const lock = await acquireFileLock(`${paths.teamFile}.lock`, { attempts: 1, staleMs: 600_000, reclaimDeadImmediately: true });
  if (!lock) throw new Error(`Another change to the team is already running, so ${operation} did not start; try again when it ends`);
  try { return await callback(); }
  finally { await releaseFileLock(lock); }
}

async function withTeamLock(options, operation, callback) {
  try { return await withTeamAccessLock(teamAccessPaths(options), operation, callback); }
  catch (error) { return failure(error); }
}

/** Who may log in: the people policy's emails, and the teammates' shared servers. */
export async function teammatesList(options = {}) {
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  try {
    const policy = await ctx.client.get(`/accounts/${encodeURIComponent(ctx.state.accountId)}/access/policies/${encodeURIComponent(ctx.state.peoplePolicyId)}`);
    await afterFirstCall(ctx);
    const servers = teamServers(ctx.state);
    return {
      ok: true,
      owner: ctx.state.ownerEmail || null,
      people: policyEmails(policy),
      servers,
      shared: sharerList(ctx.state),
      // The 팀 주소 the owner hands to teammates who only ask; no secret in it.
      addressText: teamAddressText(servers),
    };
  } catch (error) {
    return failure(error);
  }
}

async function teammateAddUnlocked(options) {
  const email = normalizeEmail(options.email);
  if (!email) return { ok: false, error: "teammates add takes an email address" };
  const share = options.share === undefined || options.share === null || options.share === "" ? null : String(options.share).trim().toLowerCase();
  if (share !== null) {
    if (!validName(share)) return { ok: false, error: "--share takes a short name: lower-case letters, digits and -, up to 32 characters" };
    if (!options.inviteOut && !options.returnInvite) return { ok: false, error: "--share needs --invite-out <file>: the invite holds a tunnel token, so it is only written to a file" };
  }
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  const { state, client } = ctx;
  if (share !== null && share === state.owner?.name) return { ok: false, error: `${share} is the name of this server; choose another name for the teammate's` };
  try {
    const policy = await ensurePeoplePolicy(client, state.accountId, { id: state.peoplePolicyId, add: [email] });
    await afterFirstCall(ctx);
    const next = { ...state, peoplePolicyId: policy.id };
    const result = { ok: true, email, added: policy.updated || policy.created, people: policy.emails };
    if (share === null) {
      await writeTeamState(ctx.paths, next, ctx.privateFileOptions);
      return result;
    }
    const host = sharerHost(share, state.zone);
    const known = state.sharers?.[share] || {};
    const made = await ensureServerHost(client, {
      accountId: state.accountId,
      zoneId: state.zoneId,
      host,
      tunnelName: tunnelName(share),
      idpId: state.idpId,
      peoplePolicyId: policy.id,
      bypassPolicyId: state.bypassPolicyId,
      known,
    });
    next.sharers = {
      ...(state.sharers || {}),
      [share]: {
        host,
        email,
        tunnelId: made.tunnelId,
        aud: made.aud,
        peopleAppId: made.peopleAppId,
        bypassAppId: made.bypassAppId,
        dnsRecordId: made.dnsRecordId,
        invitedAt: new Date().toISOString(),
      },
    };
    await writeTeamState(ctx.paths, next, ctx.privateFileOptions);
    const code = encodeInvite({
      host,
      tunnelToken: made.tunnelToken,
      teamDomain: state.teamDomain,
      aud: made.aud,
      team: teamServers(next),
    });
    result.share = { name: share, host, publicUrl: `https://${host}`, tunnelId: made.tunnelId, changes: made.changes };
    if (options.inviteOut) result.inviteFile = await writeInviteFile(options.inviteOut, code, ctx.privateFileOptions);
    if (options.returnInvite) result.invite = code;
    result.next = "Give the teammate the invite file over a private channel; on their computer: server share join --invite-file <file>";
    return result;
  } catch (error) {
    return failure(error);
  }
}

/**
 * Adds an email to the people list. With `share`, also makes that teammate's server
 * reachable at memory-<share>.<zone> and writes the invite to `inviteOut`, or, for
 * the app, returns it as `invite` when `returnInvite` is set. Nothing starts here.
 */
export async function teammateAdd(options = {}) {
  return withTeamLock(options, "teammates-add", () => teammateAddUnlocked(options));
}

async function teammateRemoveUnlocked(options) {
  const email = normalizeEmail(options.email);
  if (!email) return { ok: false, error: "teammates remove takes an email address" };
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  if (email === ctx.state.ownerEmail) return { ok: false, error: "That is the owner's own email; removing it would lock the owner out" };
  try {
    const policy = await ensurePeoplePolicy(ctx.client, ctx.state.accountId, { id: ctx.state.peoplePolicyId, remove: [email] });
    await afterFirstCall(ctx);
    const servers = sharerList(ctx.state).filter((item) => item.email === email).map((item) => item.name);
    return {
      ok: true,
      email,
      removed: policy.updated,
      people: policy.emails,
      ...(servers.length ? { stillShared: servers, next: `Their server stays reachable to the others; remove it with teammates unshare ${servers[0]}` } : {}),
    };
  } catch (error) {
    return failure(error);
  }
}

/** Takes an email off the people list. Any server that teammate shares stays. */
export async function teammateRemove(options = {}) {
  return withTeamLock(options, "teammates-remove", () => teammateRemoveUnlocked(options));
}

async function teammateUnshareUnlocked(options) {
  const name = String(options.name || "").trim().toLowerCase();
  if (!validName(name)) return { ok: false, error: "teammates unshare takes the short name given to --share" };
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  const { state } = ctx;
  if (name === state.owner?.name) return { ok: false, error: `${name} is this server; turn it off with server share disable` };
  const known = state.sharers?.[name] || {};
  const host = known.host || sharerHost(name, state.zone);
  try {
    const removed = await removeServerHost(ctx.client, {
      accountId: state.accountId,
      zoneId: state.zoneId,
      host,
      tunnelName: tunnelName(name),
      known,
    });
    await afterFirstCall(ctx);
    const sharers = { ...(state.sharers || {}) };
    delete sharers[name];
    await writeTeamState(ctx.paths, { ...state, sharers }, ctx.privateFileOptions);
    return { ok: true, name, host, removed, next: "The teammate's computer can turn its sharing off with server share disable" };
  } catch (error) {
    return failure(error);
  }
}

/** Removes a teammate's shared server from Cloudflare: its apps, hostname and tunnel. */
export async function teammateUnshare(options = {}) {
  return withTeamLock(options, "teammates-unshare", () => teammateUnshareUnlocked(options));
}

// ------------------------------------------------- asking a teammate's memory
//
// A teammate's memory is a remote MCP server at https://<host>/mcp. Claude Code and
// Codex each keep it as `team-<name>` and log in to it themselves (OAuth through
// Cloudflare Access), so no token is written here or into either entry. Both are
// changed with their own CLI, run with an argument array and no shell; a missing
// one is reported and the other is still done.
//
// Which servers this computer knows is read from files only:
//   <runtime>/share.json       the invite's team list, on a teammate's computer
//   <runtime>/team-access.json the owner's server and the teammates' shared ones
//   ~/.claude.json, ~/.codex/config.toml   what each client already has as team-*
// This computer's own shared server is left out: its agents use it directly.

export const TEAM_ENTRY_PREFIX = "team-";
export const CLIENT_NAMES = Object.freeze({ claude: "Claude Code", codex: "Codex" });
const CLIENTS = Object.keys(CLIENT_NAMES);
const CLIENT_TIMEOUT_MS = 60_000;
// What may go to a client CLI: names and https URLs only, so even cmd.exe (Windows
// runs an npm .cmd shim through it) reads every argument as plain text.
const SAFE_ARGUMENT = /^[A-Za-z0-9._:/@=-]+$/;
const UNSAFE_PATH = /["%^&|<>!\r\n]/;
const LOGIN_WAIT_MS = 8_000;
const LOGIN_LIMIT_MS = 10 * 60_000;

/** The short name in `team-<name>`: lower-case letters, digits and -, up to 32. */
export function teamName(value) {
  const name = String(value ?? "").trim().toLowerCase().replace(/^team-/, "");
  return validName(name) ? name : null;
}

export function teamEntryName(name) {
  return `${TEAM_ENTRY_PREFIX}${name}`;
}

/** A server's address as host, https://host or https://host/mcp; the URL is always https://host/mcp. */
export function teamAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: false, error: "The server address is missing: give its host, such as memory-bob.example.com" };
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return { ok: false, error: "The server address is not a host or a URL" }; }
  if (url.protocol !== "https:") return { ok: false, error: "The server address must use https" };
  if (url.username || url.password || url.port || url.search || url.hash || /[?#]/.test(raw)) {
    return { ok: false, error: "The server address must be only the host, https://<host> or https://<host>/mcp" };
  }
  if (!["/", "/mcp", "/mcp/"].includes(url.pathname)) {
    return { ok: false, error: "The server address must be only the host, https://<host> or https://<host>/mcp" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!validHostname(host)) return { ok: false, error: "The server address needs a full host name such as memory-bob.example.com" };
  return { ok: true, host, url: `https://${host}/mcp` };
}

/** memory-bob.example.com is bob's; memory.example.com is memory. */
export function nameFromHost(host) {
  const label = String(host || "").split(".")[0].toLowerCase();
  const short = label.startsWith("memory-") ? label.slice("memory-".length) : label;
  return teamName(short) || teamName(label);
}

/** The 팀 주소 text: one `<name> https://<host>/mcp` line per server. */
export function teamAddressText(servers) {
  return (servers || []).map(({ name, host }) => `${name} https://${host}/mcp`).join("\n");
}

/** Lines of `<name> <address>` or just `<address>`, as the owner's 팀 주소 text has them. */
export function parseTeamAddresses(text) {
  const servers = [];
  const errors = [];
  String(text ?? "").split(/\r?\n/).forEach((line, index) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length || words[0].startsWith("#")) return;
    const address = teamAddress(words.length > 1 ? words[1] : words[0]);
    if (!address.ok || words.length > 2) { errors.push({ line: index + 1, error: address.error || "A line holds a name and an address only" }); return; }
    const name = words.length > 1 ? teamName(words[0]) : nameFromHost(address.host);
    if (!name) { errors.push({ line: index + 1, error: "The name takes lower-case letters, digits and -, up to 32 characters" }); return; }
    if (!servers.some((item) => item.name === name)) servers.push({ name, host: address.host, url: address.url });
  });
  return { servers, errors };
}

function clientContext(options = {}) {
  const env = options.env || process.env;
  const home = path.resolve(options.homeDir || env.HONCHO_AGENT_BRIDGE_USER_HOME || os.homedir());
  return {
    env,
    platform: options.platform || process.platform,
    files: {
      claude: path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : home, ".claude.json"),
      codex: path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex"), "config.toml"),
    },
    clientRunner: options.clientRunner || null,
    loginSpawner: options.loginSpawner || null,
    options,
  };
}

async function claudeEntries(file) {
  let document;
  try { document = JSON.parse(await fsp.readFile(file, "utf8")); } catch { return {}; }
  const servers = document?.mcpServers && typeof document.mcpServers === "object" ? document.mcpServers : {};
  return Object.fromEntries(Object.entries(servers)
    .filter(([name, entry]) => name.startsWith(TEAM_ENTRY_PREFIX) && entry && typeof entry === "object")
    .map(([name, entry]) => [name, { url: typeof entry.url === "string" ? entry.url : null, type: entry.type || null }]));
}

/** `[mcp_servers.<name>]` tables and their `url`, read without a TOML parser. */
async function codexEntries(file) {
  const text = await fsp.readFile(file, "utf8").catch(() => "");
  const entries = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/);
    if (header) {
      const name = header[1] || header[2];
      current = name.startsWith(TEAM_ENTRY_PREFIX) ? name : null;
      if (current) entries[current] = { url: null };
      continue;
    }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const url = current && line.match(/^\s*url\s*=\s*"([^"]*)"/);
    if (url) entries[current].url = url[1];
  }
  return entries;
}

/** The team-* entries Claude Code and Codex have, by name, from their own files. */
export async function registeredTeamServers(options = {}) {
  const ctx = options.files ? options : clientContext(options);
  const [claude, codex] = await Promise.all([claudeEntries(ctx.files.claude), codexEntries(ctx.files.codex)]);
  return { claude, codex };
}

/** The client's executable on PATH, or null. On Windows an npm .cmd shim counts. */
export function findClient(command, { env = process.env, platform = process.platform } = {}) {
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((item) => /^\.(exe|cmd|bat|com)$/i.test(item))
    : [""];
  for (const directory of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

/** How to start a client: the binary itself, or cmd.exe for a .cmd shim, with plain-text arguments only. */
function clientCommand(binary, args, platform, env) {
  for (const arg of args) if (!SAFE_ARGUMENT.test(arg)) throw new Error("A client argument holds characters a name or an https address never has");
  if (platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    if (UNSAFE_PATH.test(binary)) throw new Error(`The path of ${path.basename(binary)} holds characters cmd.exe would read as commands`);
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", `""${binary}" ${args.join(" ")}"`],
      extra: { windowsVerbatimArguments: true },
    };
  }
  return { command: binary, args, extra: {} };
}

function execClient(command, args, extra, env) {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: CLIENT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...extra }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** One client CLI call: {missing} when the client is not installed, else {code, stdout, stderr}. */
async function runClient(ctx, client, args) {
  if (ctx.clientRunner) return ctx.clientRunner(client, args);
  const binary = findClient(client, ctx);
  if (!binary) return { missing: true };
  const { command, args: list, extra } = clientCommand(binary, args, ctx.platform, ctx.env);
  return execClient(command, list, extra, ctx.env);
}

function clientFailure(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim().split(/\r?\n/).find(Boolean) || `exit ${result.code}`;
  return text.slice(0, 300);
}

function missingClient(client) {
  return { ok: false, missing: true, error: `${CLIENT_NAMES[client]} (${client}) was not found on this computer` };
}

const ADD_ARGS = {
  claude: (entry, url) => ["mcp", "add", "--transport", "http", "--scope", "user", entry, url],
  codex: (entry, url) => ["mcp", "add", entry, "--url", url],
};
const REMOVE_ARGS = {
  claude: (entry) => ["mcp", "remove", entry, "--scope", "user"],
  codex: (entry) => ["mcp", "remove", entry],
};

async function connectClient(ctx, client, entry, url, current) {
  if (current && current.url === url && (client !== "claude" || current.type === "http")) return { ok: true, action: "unchanged" };
  if (current) {
    const removed = await runClient(ctx, client, REMOVE_ARGS[client](entry));
    if (removed.missing) return missingClient(client);
    if (removed.code !== 0) return { ok: false, action: "failed", error: clientFailure(removed) };
  }
  const added = await runClient(ctx, client, ADD_ARGS[client](entry, url));
  if (added.missing) return missingClient(client);
  if (added.code !== 0) return { ok: false, action: "failed", error: clientFailure(added) };
  return { ok: true, action: current ? "replaced" : "added" };
}

function loginSteps(entry) {
  return {
    claude: `In Claude Code, run /mcp, choose ${entry} and Authenticate`,
    codex: `codex mcp login ${entry}`,
  };
}

/**
 * Registers a teammate's server in Claude Code and Codex as `team-<name>` at
 * https://<host>/mcp. The same address again changes nothing; another address
 * replaces the entry. Logging in is left to each client.
 */
export async function teammateConnect(options = {}) {
  const name = teamName(options.name);
  if (!name) return { ok: false, error: "teammates connect takes a short name first: lower-case letters, digits and -, up to 32 characters" };
  const address = teamAddress(options.address);
  if (!address.ok) return { ok: false, error: address.error };
  const ctx = clientContext(options);
  const entry = teamEntryName(name);
  const registered = await registeredTeamServers(ctx);
  const clients = {};
  for (const client of CLIENTS) clients[client] = await connectClient(ctx, client, entry, address.url, registered[client][entry]);
  const missing = CLIENTS.filter((client) => clients[client].missing);
  const done = CLIENTS.filter((client) => clients[client].ok);
  return {
    ok: done.length > 0,
    name,
    entry,
    host: address.host,
    url: address.url,
    clients,
    ...(missing.length ? { missing } : {}),
    ...(done.length ? {} : { error: missing.length === CLIENTS.length ? "Neither Claude Code (claude) nor Codex (codex) was found on this computer" : `${entry} was not added: ${CLIENTS.map((client) => clients[client].error).filter(Boolean).join("; ")}` }),
    login: loginSteps(entry),
    next: `Log in once in each client: ${loginSteps(entry).claude}; in a terminal, ${loginSteps(entry).codex}`,
  };
}

/** Takes `team-<name>` out of Claude Code and Codex. */
export async function teammateDisconnect(options = {}) {
  const name = teamName(options.name);
  if (!name) return { ok: false, error: "teammates disconnect takes the short name given to teammates connect" };
  const ctx = clientContext(options);
  const entry = teamEntryName(name);
  const registered = await registeredTeamServers(ctx);
  const clients = {};
  for (const client of CLIENTS) {
    if (!registered[client][entry]) { clients[client] = { ok: true, action: "absent" }; continue; }
    const removed = await runClient(ctx, client, REMOVE_ARGS[client](entry));
    clients[client] = removed.missing ? missingClient(client)
      : removed.code === 0 ? { ok: true, action: "removed" } : { ok: false, action: "failed", error: clientFailure(removed) };
  }
  const failed = CLIENTS.filter((client) => !clients[client].ok);
  return { ok: failed.length === 0, name, entry, clients, ...(failed.length ? { error: `${entry} is still in ${failed.map((client) => CLIENT_NAMES[client]).join(" and ")}` } : {}) };
}

async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
}

/** The team's servers this computer knows from its own files, its own server left out. */
export async function knownTeamServers(options = {}) {
  const paths = teamAccessPaths(options);
  const [share, team] = await Promise.all([readJsonFile(path.join(paths.runtimeDir, "share.json")), readTeamState(paths)]);
  const self = typeof share?.host === "string" ? share.host : null;
  const known = new Map();
  const add = (item, source) => {
    const name = teamName(item?.name);
    if (!name || !validHostname(item?.host) || item.host === self) return;
    const current = known.get(name);
    if (current) { if (!current.sources.includes(source)) current.sources.push(source); return; }
    known.set(name, { name, host: item.host, url: `https://${item.host}/mcp`, sources: [source] });
  };
  for (const item of Array.isArray(share?.team) ? share.team : []) add(item, "invite");
  if (team) for (const item of teamServers(team)) add(item, "team");
  return [...known.values()];
}

/**
 * What `teammates connected` reports: every team server this computer knows or has
 * registered, with whether Claude Code and Codex have it, and whether each client is
 * installed here at all.
 */
export async function teammatesConnected(options = {}) {
  const ctx = clientContext(options);
  const [known, registered] = await Promise.all([knownTeamServers(options), registeredTeamServers(ctx)]);
  const servers = new Map(known.map((item) => [item.name, { ...item, claude: null, codex: null }]));
  for (const client of CLIENTS) {
    for (const [entry, value] of Object.entries(registered[client])) {
      const name = teamName(entry.slice(TEAM_ENTRY_PREFIX.length));
      if (!name) continue;
      if (!servers.has(name)) {
        const address = teamAddress(value.url);
        servers.set(name, { name, host: address.ok ? address.host : null, url: value.url, sources: [], claude: null, codex: null });
      }
      const server = servers.get(name);
      server[client] = { registered: true, url: value.url, same: value.url === server.url };
    }
  }
  const list = [...servers.values()].map((server) => ({
    ...server,
    entry: teamEntryName(server.name),
    claude: server.claude || { registered: false },
    codex: server.codex || { registered: false },
  }));
  return {
    ok: true,
    servers: list,
    clients: Object.fromEntries(CLIENTS.map((client) => [client, { name: CLIENT_NAMES[client], found: ctx.clientRunner ? true : Boolean(findClient(client, ctx)) }])),
    connected: list.filter((server) => server.claude.registered || server.codex.registered).length,
  };
}

function defaultLoginSpawner(ctx, args) {
  const binary = findClient("codex", ctx);
  if (!binary) return null;
  const { command, args: list, extra } = clientCommand(binary, args, ctx.platform, ctx.env);
  return spawn(command, list, { env: ctx.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...extra });
}

/**
 * Starts `codex mcp login team-<name>`, which opens the browser for the OAuth login
 * and waits for it. Answers when it ends, or after a few seconds with the address it
 * printed, so the page can offer it if no browser opened; the login keeps waiting
 * (at most ten minutes).
 */
export async function codexLogin(options = {}) {
  const name = teamName(options.name);
  if (!name) return { ok: false, error: "Codex login takes the short name of a connected teammate's server" };
  const ctx = clientContext(options);
  const entry = teamEntryName(name);
  const registered = await registeredTeamServers(ctx);
  if (!registered.codex[entry]) return { ok: false, error: `${entry} is not in Codex yet; connect it first` };
  let child;
  try { child = (ctx.loginSpawner || defaultLoginSpawner)(ctx, ["mcp", "login", entry]); }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
  if (!child) return missingClient("codex");
  const waitMs = options.waitMs ?? LOGIN_WAIT_MS;
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(waiting);
      resolve({ entry, ...result });
    };
    const loginUrl = () => output.match(/https:\/\/[^\s"'<>]+/)?.[0] || null;
    const read = (chunk) => {
      output = `${output}${chunk}`.slice(-16_384);
      if (loginUrl()) finish({ ok: true, state: "waiting", loginUrl: loginUrl() });
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
    child.on("exit", (code) => finish(code === 0
      ? { ok: true, state: "done" }
      : { ok: false, state: "failed", error: output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300) || `exit ${code}` }));
    const waiting = setTimeout(() => finish({ ok: true, state: "waiting", loginUrl: loginUrl() }), waitMs);
    const limit = setTimeout(() => { try { child.kill(); } catch {} }, LOGIN_LIMIT_MS);
    limit.unref?.();
    child.on("exit", () => clearTimeout(limit));
  });
}
