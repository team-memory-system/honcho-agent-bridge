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
import fsp from "node:fs/promises";
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
    return {
      ok: true,
      owner: ctx.state.ownerEmail || null,
      people: policyEmails(policy),
      servers: teamServers(ctx.state),
      shared: sharerList(ctx.state),
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
