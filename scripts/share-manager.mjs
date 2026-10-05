// Sharing a personal memory server: with the owner's other computers, and with the
// team.
//
// Three Compose services under the "share" profile, all on this machine:
//   - gate    (server/gate/gate.mjs) publishes 127.0.0.1:<HONCHO_GATE_PORT>. /health
//             and /v3/* need the gate token and go to the API, for the owner's other
//             computers. /mcp needs a person's Cloudflare Access login and goes to mcp;
//             until the Access team domain, AUD tag and team MCP token are all set,
//             /mcp is not found.
//   - mcp     the Honcho MCP bridge, `chat` only, over HONCHO_TEAM_WORKSPACE as
//             HONCHO_TEAM_PEER.
//   - tunnel  cloudflared running this server's remotely managed tunnel with
//             HONCHO_TUNNEL_TOKEN; Cloudflare sends <host> to http://gate:8010.
// `server start` brings all three up whenever COMPOSE_PROFILES has "share", so the
// profile is never turned on while the tunnel token or the team MCP token is empty
// (either service would restart forever).
//
// Three ways to turn it on:
//   enable --cloudflare   the owner, with a Cloudflare API token: cloudflare-api.mjs
//                         makes the tunnel, <name>.<zone>, its ingress and the Access
//                         apps, and team-access.mjs keeps the email list.
//   enable --public-url   by hand: a tunnel made in the dashboard, its token in
//                         HONCHO_TUNNEL_TOKEN. /mcp stays off (no team domain or AUD).
//   join                  a teammate, with the invite the owner's `teammates add
//                         --share` wrote; no API token.
//
// Until 0.3.28 cloudflared ran on the host under a per-user autostart (launchd
// team-memory-system.tunnel, HKCU Run "TeamMemoryTunnel", systemd
// team-memory-tunnel.service) with its token in <runtime>/cloudflared/tunnel-token.
// enable, join and disable remove that autostart if it is still there, move the old
// token into the .env and delete <runtime>/cloudflared, so two connectors never run
// one tunnel.
//
// What is on lives in the installed .env (COMPOSE_PROFILES has "share"; the tokens
// and the Access settings) and <runtime>/share.json, which holds no secret:
//   publicUrl, enabledAt, disabledAt   the address and when it changed
//   host, teamDomain, aud, tunnelId    the Cloudflare side, when known
//   tunnel                             true while on, false once off; absent in an
//                                      older file, where the share profile meant it
//
// Everything that touches the OS goes through injectable functions (run,
// composeRunner, fetchImpl, sleep), so tests never reach docker, launchctl, reg,
// systemctl, PowerShell or Cloudflare.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  autostartRegistered,
  launchAgent as launchAgentSpec,
  RUN_KEY,
  runCommand,
  systemdUnit as systemdUnitSpec,
  uninstallLaunchAgent,
  uninstallSystemdUnit,
  unregisterWindowsRun,
  windowsRun,
  writeIfChanged,
} from "./autostart.mjs";
import {
  accessTeamDomain,
  chooseGoogleIdp,
  ensureBypassPolicy,
  ensurePeoplePolicy,
  ensureServerHost,
  findZone,
  listIdentityProviders,
  listZones,
  normalizeEmail,
} from "./cloudflare-api.mjs";
import { loadConfig } from "./config.mjs";
import { embeddingAliasBase } from "./host-manager.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";
import {
  chooseGatePort,
  compose,
  DEFAULT_GATE_PORT,
  installedServerDir,
  parseEnvironment,
  readEnvironmentFile,
  replaceEnvironment,
  withServerLifecycleLock,
} from "./server-manager.mjs";
import {
  API_TOKEN_ENV,
  apiTokenSaved,
  decodeInvite,
  INVITE_ENV,
  ownerClient,
  ownerHost,
  readTeamState,
  saveApiToken,
  tunnelIdFromToken,
  TUNNEL_TOKEN_PATTERN,
  tunnelName,
  validName,
  withTeamAccessLock,
  writeTeamState,
} from "./team-access.mjs";

export const TUNNEL_TOKEN_ENV = "HONCHO_TUNNEL_TOKEN";
export const SHARE_PROFILE = "share";
export const GATE_SERVICE = "gate";
export const MCP_SERVICE = "mcp";
export const TUNNEL_SERVICE = "tunnel";
export const SHARE_SERVICES = Object.freeze([GATE_SERVICE, MCP_SERVICE, TUNNEL_SERVICE]);
/** What the gate needs before /mcp answers at all. */
export const MCP_SETTINGS = Object.freeze(["HONCHO_ACCESS_TEAM_DOMAIN", "HONCHO_ACCESS_AUD", "HONCHO_TEAM_MCP_TOKEN"]);
export const DEFAULT_SHARE_NAME = "memory";
// The old host autostart's names, kept only so it can be found and removed.
export const LAUNCHD_LABEL = "team-memory-system.tunnel";
export { RUN_KEY };
export const RUN_VALUE = "TeamMemoryTunnel";
export const SYSTEMD_UNIT = "team-memory-tunnel.service";
const PEER_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const CLOUDFLARE_KEPT = "The Cloudflare tunnel, hostname and Access apps are left as they are, so turning sharing on again needs no new invite; teammates unshare <name> removes a teammate's";

// ---------------------------------------------------------------- context

/** Where everything sharing uses lives, beside the installed server. */
export function sharePaths({ serverDirectory, platform = process.platform, runtimeDirectory } = {}) {
  const serverDir = path.resolve(serverDirectory || installedServerDir());
  const runtimeDir = path.resolve(runtimeDirectory || path.join(path.dirname(serverDir), "runtime"));
  const cloudflaredDir = path.join(runtimeDir, "cloudflared");
  return {
    serverDir,
    envFile: path.join(serverDir, ".env"),
    composeFile: path.join(serverDir, "compose.yaml"),
    gateScript: path.join(serverDir, "gate", "gate.mjs"),
    runtimeDir,
    stateFile: path.join(runtimeDir, "share.json"),
    apiTokenFile: path.join(runtimeDir, "cloudflare", "api-token"),
    teamFile: path.join(runtimeDir, "team-access.json"),
    // The host tunnel of 0.3.28 and before, only to remove it.
    cloudflaredDir,
    legacyBinary: path.join(cloudflaredDir, platform === "win32" ? "cloudflared.exe" : "cloudflared"),
    tokenFile: path.join(cloudflaredDir, "tunnel-token"),
    vbsFile: path.join(cloudflaredDir, "tunnel.vbs"),
  };
}

function shareContext(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = path.resolve(options.homeDir || env.HONCHO_AGENT_BRIDGE_USER_HOME || os.homedir());
  const paths = sharePaths({ serverDirectory: options.serverDirectory, platform, runtimeDirectory: options.runtimeDirectory });
  return {
    platform,
    env,
    homeDir,
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    paths,
    run: options.run || runCommand,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    composeRunner: options.composeRunner || compose,
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    portInUse: options.portInUse,
    // Private files follow the machine's own rules even when a test asks for
    // another platform's autostart.
    privateFileOptions: {
      platform: options.filePlatform || process.platform,
      env,
      ...(options.privateFileRunner ? { run: options.privateFileRunner } : {}),
    },
    gateWaitMs: options.gateWaitMs ?? 30_000,
    config: options.config,
    // For the Cloudflare client: a test hands in a local fake's address.
    cloudflare: { env, apiBaseUrl: options.apiBaseUrl, cloudflareFetch: options.cloudflareFetch },
  };
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

async function readJson(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

function firstLine(text) {
  return String(text || "").trim().split(/\r?\n/)[0].slice(0, 300);
}

async function writeState(ctx, state) {
  await writeIfChanged(ctx.paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function errorResult(error) {
  return { ok: false, error: String(error?.message || error) };
}

// ------------------------------------------------------------ environment

function profilesOf(environment) {
  return String(environment.COMPOSE_PROFILES || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** Whether the gate and the tunnel are on: the tunnel is never on without the share profile. */
function modesOf(environment, state) {
  const gate = profilesOf(environment).includes(SHARE_PROFILE);
  return {
    gate,
    // In an older share.json without `tunnel`, the share profile alone meant the tunnel.
    tunnel: gate && state?.tunnel !== false,
  };
}

function withoutEnvironmentKey(text, key) {
  const lines = text.split(/\r?\n/).filter((line) => !line.startsWith(`${key}=`));
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function newSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

/** The installed .env, written the way server-manager writes it: owner-only, atomically. */
async function writeEnvironment(ctx, text) {
  await writePrivateFileAtomic(ctx.paths.envFile, text, ctx.privateFileOptions);
}

function filled(environment, key) {
  return Boolean(String(environment[key] || "").trim());
}

/** Whether /mcp can answer, by setting name only. */
export function mcpReadiness(environment) {
  const missing = MCP_SETTINGS.filter((key) => !filled(environment, key));
  return { configured: missing.length === 0, missing };
}

/** The port the gate uses: the saved one, else the first free one from 8010. */
async function gatePortFor(ctx, environment) {
  const saved = Number(environment.HONCHO_GATE_PORT);
  if (Number.isInteger(saved) && saved > 0) return { port: saved, saved: true };
  try {
    return { port: await chooseGatePort(ctx.portInUse ? { inUse: ctx.portInUse } : {}), saved: false };
  } catch {
    return { port: DEFAULT_GATE_PORT, saved: false };
  }
}

async function installedPersonalServer(ctx) {
  const issues = [];
  const [composeFile, envFile] = await Promise.all([exists(ctx.paths.composeFile), exists(ctx.paths.envFile)]);
  if (!composeFile || !envFile) {
    issues.push("No personal memory server is installed on this computer; run server prepare --profile personal first");
    return { installed: false, issues, environment: {} };
  }
  const environment = await readEnvironmentFile(ctx.paths.envFile);
  if (!embeddingAliasBase(environment.EMBEDDING_MODEL_CONFIG__MODEL)) {
    issues.push("The server installed here is not a personal-profile server; sharing is for servers made by server prepare --profile personal");
  }
  if (!(await exists(ctx.paths.gateScript))) {
    issues.push("The installed server predates sharing; run server prepare --profile personal again to install the gate");
  }
  return { installed: issues.length === 0, issues, environment };
}

/** The workspace and peer teammates ask as. An empty peer is refused, never written. */
async function teamIdentity(ctx) {
  const config = ctx.config !== undefined ? ctx.config : await loadConfig().catch(() => null);
  const peer = String(config?.user?.peerId || "").trim();
  const workspace = String(config?.honcho?.workspaceId || "").trim() || "memory";
  if (!peer) {
    return { ok: false, error: "This computer has no Honcho peer yet, so teammates' questions would run as nobody; run setup apply --user-peer <id> first, then turn sharing on" };
  }
  if (!PEER_PATTERN.test(peer) || !PEER_PATTERN.test(workspace)) {
    return { ok: false, error: "The configured peer or workspace has characters the server's .env cannot hold; run setup apply with plain letters, digits, _ or -" };
  }
  return { ok: true, workspace, peer };
}

// ------------------------------------------------- the old host tunnel

function legacyLaunchAgent(ctx) {
  return launchAgentSpec({ label: LAUNCHD_LABEL, homeDir: ctx.homeDir, uid: ctx.uid, programArguments: [ctx.paths.legacyBinary] });
}

function legacySystemdUnit(ctx) {
  return systemdUnitSpec({
    env: ctx.env,
    homeDir: ctx.homeDir,
    subject: "tunnel",
    unitName: SYSTEMD_UNIT,
    description: "Team Memory Cloudflare tunnel",
    workingDirectory: ctx.paths.cloudflaredDir,
    execStart: [ctx.paths.legacyBinary],
  });
}

function legacyWindowsRun(ctx) {
  return windowsRun({
    env: ctx.env,
    subject: "tunnel",
    valueName: RUN_VALUE,
    vbsPath: ctx.paths.vbsFile,
    workingDirectory: ctx.paths.cloudflaredDir,
    commandLine: [ctx.paths.legacyBinary],
  });
}

/** Stops only the cloudflared started with the old token file, never another one. */
async function stopLegacyWindowsTunnel(ctx, plan) {
  const needle = ctx.paths.tokenFile.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$found = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') })`,
    "$found | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "$found | ForEach-Object { $_.ProcessId }",
  ].join("; ");
  await ctx.run(plan.powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20_000 });
}

async function legacyAutostart(ctx) {
  if (ctx.platform === "darwin") return legacyLaunchAgent(ctx);
  if (ctx.platform === "linux") return legacySystemdUnit(ctx);
  if (ctx.platform === "win32") return legacyWindowsRun(ctx);
  return null;
}

/** Whether the host tunnel of 0.3.28 is still registered to start at login. */
async function hostTunnelRegistered(ctx) {
  const spec = await legacyAutostart(ctx);
  return spec ? autostartRegistered(ctx, spec) : false;
}

/**
 * Removes the host tunnel of 0.3.28 and before, if it is still here: its autostart
 * (which stops it), its token (moved into the .env when the .env has none) and
 * <runtime>/cloudflared. Afterwards only the Compose tunnel can run the token.
 */
export async function removeHostTunnel(options = {}) {
  const ctx = options.paths ? options : shareContext(options);
  let removed = null;
  const spec = await legacyAutostart(ctx);
  if (spec && await autostartRegistered(ctx, spec)) {
    if (spec.kind === "launchd") await uninstallLaunchAgent(ctx, spec);
    if (spec.kind === "systemd") await uninstallSystemdUnit(ctx, spec);
    if (spec.kind === "windows-run") {
      await unregisterWindowsRun(ctx, spec);
      await stopLegacyWindowsTunnel(ctx, spec);
    }
    removed = spec.kind;
  }
  let movedTunnelToken = false;
  const oldToken = (await fsp.readFile(ctx.paths.tokenFile, "utf8").catch(() => "")).trim();
  if (oldToken && TUNNEL_TOKEN_PATTERN.test(oldToken) && await exists(ctx.paths.envFile)) {
    const text = await fsp.readFile(ctx.paths.envFile, "utf8");
    if (!filled(parseEnvironment(text), TUNNEL_TOKEN_ENV)) {
      await writeEnvironment(ctx, replaceEnvironment(text, { [TUNNEL_TOKEN_ENV]: oldToken }));
      movedTunnelToken = true;
    }
  }
  const leftovers = await exists(ctx.paths.cloudflaredDir);
  // The token is in the .env now (or the .env already had one); the binary is unused.
  if (leftovers) await fsp.rm(ctx.paths.cloudflaredDir, { recursive: true, force: true }).catch(() => {});
  return { removed, movedTunnelToken, removedFiles: leftovers };
}

// ------------------------------------------------------------- public URL

/** The address other computers use: https, a host, nothing else. */
export function normalizePublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: false, error: "--public-url is required: the https address of the public hostname set on the tunnel" };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, error: "The public address is not a URL" }; }
  if (url.protocol !== "https:") return { ok: false, error: "The public address must use https" };
  if (url.username || url.password) return { ok: false, error: "The public address must not contain credentials" };
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(raw)) {
    return { ok: false, error: "The public address must be only https://<hostname>, with no path, query or fragment" };
  }
  if (!url.hostname.includes(".")) return { ok: false, error: "The public address needs a full hostname such as memory.example.com" };
  return { ok: true, url: `https://${url.host}` };
}

// ------------------------------------------------------------- services

async function composeCall(ctx, args, timeout = 300_000) {
  try {
    const result = await ctx.composeRunner(ctx.paths.serverDir, args, { timeout });
    return { ok: true, stdout: String(result?.stdout || ""), stderr: String(result?.stderr || "") };
  } catch (error) {
    return { ok: false, error: firstLine(error?.stderr || error?.message || error) };
  }
}

/** Each share service's Compose state ("running", "exited", ...), absent when not made. */
async function serviceStates(ctx) {
  const result = await composeCall(ctx, ["ps", "--all", "--format", "json"], 15_000);
  const states = {};
  if (!result.ok) return states;
  for (const line of result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    let items;
    try { items = JSON.parse(line); } catch { continue; }
    for (const item of Array.isArray(items) ? items : [items]) {
      if (SHARE_SERVICES.includes(item?.Service)) states[item.Service] = String(item.State || "");
    }
  }
  return states;
}

async function discardBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function waitForGate(ctx, port, token) {
  const deadline = Date.now() + ctx.gateWaitMs;
  let last = null;
  do {
    try {
      const response = await ctx.fetchImpl(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3_000),
      });
      last = response.status;
      await discardBody(response);
      if (response.ok) return { healthy: true, status: last };
    } catch {
      last = null;
    }
    await ctx.sleep(1_000);
  } while (Date.now() < deadline);
  return { healthy: false, status: last };
}

// ------------------------------------------------------------ public check

function isAccessRedirect(location) {
  try { return /(^|\.)cloudflareaccess\.com$/i.test(new URL(location).hostname); } catch { return false; }
}

/**
 * What stands between another computer and this server, from the outside:
 * ok, Cloudflare Access (the device is not let in), the gate token, or the tunnel.
 */
export function classifyPublicResponse({ status, headers = {} }) {
  const header = (name) => {
    if (typeof headers.get === "function") return headers.get(name);
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
    return key ? headers[key] : null;
  };
  const names = typeof headers.keys === "function" ? [...headers.keys()] : Object.keys(headers);
  if (status >= 200 && status < 300) return "ok";
  const accessHeader = names.some((name) => /^cf-access-/i.test(name) || /^cf-mitigated$/i.test(name));
  if (status === 403 || accessHeader) return "access";
  if (status >= 300 && status < 400 && isAccessRedirect(header("location"))) return "access";
  if (status === 401) return "token";
  if ([502, 503, 504, 521, 522, 523, 524, 530].includes(status)) return "unreachable";
  return "error";
}

async function checkPublic(ctx, publicUrl, gateToken) {
  if (!publicUrl) return { state: "error", error: "No public address is saved; turn sharing on first" };
  const headers = { Accept: "application/json" };
  if (gateToken) headers.Authorization = `Bearer ${gateToken}`;
  const clientId = String(ctx.env.CF_ACCESS_CLIENT_ID || "").trim();
  const clientSecret = String(ctx.env.CF_ACCESS_CLIENT_SECRET || "").trim();
  if (clientId && clientSecret) {
    headers["CF-Access-Client-Id"] = clientId;
    headers["CF-Access-Client-Secret"] = clientSecret;
  }
  let response;
  try {
    response = await ctx.fetchImpl(`${publicUrl}/health`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { state: "unreachable", error: String(error?.cause?.code || error?.name || "network error") };
  }
  await discardBody(response);
  const state = classifyPublicResponse({ status: response.status, headers: response.headers || {} });
  return { state, status: response.status };
}

// ------------------------------------------------------------------ status

/** Cheap: files only. What `server status` reports. */
export async function shareSummary(options = {}) {
  const paths = sharePaths(options);
  const environment = await readEnvironmentFile(paths.envFile);
  const state = await readJson(paths.stateFile);
  const modes = modesOf(environment, state);
  return {
    enabled: modes.gate,
    publicUrl: typeof state?.publicUrl === "string" ? state.publicUrl : null,
  };
}

/** What is on, by name and state only: no token, AUD tag or team-domain value leaves here. */
export async function shareStatus(options = {}) {
  const ctx = shareContext(options);
  const server = await installedPersonalServer(ctx);
  const environment = server.environment;
  const enabled = profilesOf(environment).includes(SHARE_PROFILE);
  const state = await readJson(ctx.paths.stateFile);
  const team = await readTeamState(ctx.paths);
  const modes = modesOf(environment, state);
  const { port } = await gatePortFor(ctx, environment);
  const [services, oldTokenFile, hostTunnel, apiToken] = await Promise.all([
    server.installed ? serviceStates(ctx) : Promise.resolve({}),
    exists(ctx.paths.tokenFile),
    hostTunnelRegistered(ctx).catch(() => false),
    apiTokenSaved(ctx.paths),
  ]);
  const publicUrl = typeof state?.publicUrl === "string" ? state.publicUrl : null;
  const mcp = mcpReadiness(environment);
  const issues = [...server.issues];
  if (hostTunnel) issues.push("The host tunnel of an older version is still set to start at login; turn sharing on or off once to remove it");
  const result = {
    ok: true,
    installed: server.installed,
    enabled,
    gate: { running: services.gate === "running", port, localUrl: `http://127.0.0.1:${port}` },
    tunnel: {
      enabled: modes.tunnel,
      running: services.tunnel === "running",
      tokenSaved: filled(environment, TUNNEL_TOKEN_ENV) || oldTokenFile,
      hostAutostart: hostTunnel,
    },
    mcp: { ...mcp, running: services.mcp === "running" },
    cloudflare: {
      managed: Boolean(team?.owner?.host && team.owner.host === state?.host),
      joined: state?.joined === true,
      host: typeof state?.host === "string" ? state.host : null,
      apiTokenSaved: apiToken,
      teammatesShared: team?.sharers ? Object.keys(team.sharers).length : 0,
    },
    publicUrl,
    ...(state?.enabledAt ? { enabledAt: state.enabledAt } : {}),
    ...(issues.length ? { issues } : {}),
  };
  if (options.check) result.publicCheck = await checkPublic(ctx, publicUrl, environment.HONCHO_GATE_TOKEN);
  return result;
}

// ------------------------------------------------------------------- open

/**
 * The local half every way in shares: `values` and whatever is still missing
 * (the gate token, the team MCP token, the gate port) written to the .env, the share
 * profile on, and gate, mcp and tunnel up. The profile is only turned on with a
 * tunnel token and a team MCP token in place.
 */
async function openShare(ctx, values) {
  const text = await fsp.readFile(ctx.paths.envFile, "utf8");
  const environment = parseEnvironment(text);
  const next = { ...values };
  const gateTokenCreated = !filled(environment, "HONCHO_GATE_TOKEN");
  if (gateTokenCreated) next.HONCHO_GATE_TOKEN = newSecret();
  const mcpTokenCreated = !filled(environment, "HONCHO_TEAM_MCP_TOKEN");
  if (mcpTokenCreated) next.HONCHO_TEAM_MCP_TOKEN = newSecret();
  const gatePort = await gatePortFor(ctx, environment);
  if (!gatePort.saved) next.HONCHO_GATE_PORT = String(gatePort.port);
  const merged = { ...environment, ...next };
  for (const key of [TUNNEL_TOKEN_ENV, "HONCHO_TEAM_MCP_TOKEN", "HONCHO_TEAM_PEER"]) {
    if (!filled(merged, key)) return { ok: false, failure: { ok: false, error: `${key} is empty, so sharing was not turned on` } };
  }
  const profiles = profilesOf(environment);
  if (!profiles.includes(SHARE_PROFILE)) next.COMPOSE_PROFILES = [...profiles, SHARE_PROFILE].join(",");
  const tunnelTokenUpdated = String(environment[TUNNEL_TOKEN_ENV] || "").trim() !== String(merged[TUNNEL_TOKEN_ENV]).trim();
  const updated = replaceEnvironment(text, next);
  if (updated !== text) await writeEnvironment(ctx, updated);

  // A changed token or setting recreates that container; an unchanged one is left alone.
  const up = await composeCall(ctx, ["up", "-d", ...SHARE_SERVICES], 900_000);
  if (!up.ok) {
    return {
      ok: false,
      failure: {
        ok: false,
        error: `The share services did not start: ${up.error}`,
        next: "Start the server with server start --profile personal, then turn sharing on again",
      },
    };
  }
  const gate = await waitForGate(ctx, gatePort.port, merged.HONCHO_GATE_TOKEN);
  return {
    ok: true,
    gateTokenCreated,
    mcpTokenCreated,
    tunnelTokenUpdated,
    port: gatePort.port,
    gate,
    mcp: mcpReadiness(merged),
  };
}

function openedResult(opened, extra) {
  return {
    ok: true,
    enabled: true,
    ...extra,
    gateTokenCreated: opened.gateTokenCreated,
    gate: { port: opened.port, localUrl: `http://127.0.0.1:${opened.port}`, ...opened.gate },
    tunnel: { service: TUNNEL_SERVICE, tokenUpdated: opened.tunnelTokenUpdated },
    mcp: opened.mcp,
    ...(opened.gate.healthy ? {} : { warnings: ["The gate did not answer its health check yet; check server status"] }),
  };
}

// -------------------------------------------------------- enable by hand

async function shareEnableManual(ctx, { publicUrl }) {
  const address = normalizePublicUrl(publicUrl);
  if (!address.ok) return { ok: false, error: address.error };
  const server = await installedPersonalServer(ctx);
  if (!server.installed) return { ok: false, error: server.issues[0], issues: server.issues };
  const identity = await teamIdentity(ctx);
  if (!identity.ok) return identity;
  const tunnelToken = String(ctx.env[TUNNEL_TOKEN_ENV] || "").trim();
  if (tunnelToken && !TUNNEL_TOKEN_PATTERN.test(tunnelToken)) {
    return { ok: false, error: "The tunnel token does not look like one; copy the token from the tunnel's install command in the Cloudflare dashboard" };
  }
  const saved = filled(server.environment, TUNNEL_TOKEN_ENV) || await exists(ctx.paths.tokenFile);
  if (!tunnelToken && !saved) {
    return { ok: false, error: `The tunnel token is required the first time: put it in ${TUNNEL_TOKEN_ENV} (never on the command line)` };
  }

  const host = new URL(address.url).hostname;
  const previous = await readJson(ctx.paths.stateFile);
  // The Access team domain and AUD tag of an earlier --cloudflare or join belong to
  // that host's Access app; on another host they would let /mcp check the wrong one.
  const otherHost = previous?.host !== host;
  const staleAccess = otherHost
    ? Object.fromEntries(["HONCHO_ACCESS_TEAM_DOMAIN", "HONCHO_ACCESS_AUD"].filter((key) => filled(server.environment, key)).map((key) => [key, ""]))
    : {};

  const hostTunnel = await removeHostTunnel(ctx);
  const opened = await openShare(ctx, {
    ...(tunnelToken ? { [TUNNEL_TOKEN_ENV]: tunnelToken } : {}),
    ...staleAccess,
    HONCHO_TEAM_WORKSPACE: identity.workspace,
    HONCHO_TEAM_PEER: identity.peer,
  });
  if (!opened.ok) return opened.failure;
  const keep = previous?.host === host ? Object.fromEntries(["teamDomain", "aud", "tunnelId"].filter((key) => previous[key]).map((key) => [key, previous[key]])) : {};
  const state = { publicUrl: address.url, enabledAt: new Date().toISOString(), host, ...keep, tunnel: true };
  await writeState(ctx, state);
  return {
    ...openedResult(opened, { publicUrl: address.url, enabledAt: state.enabledAt }),
    hostTunnelRemoved: hostTunnel.removed,
    next: "On each other computer, run setup with --honcho-url set to the public address and the gate token (server share token) in HONCHO_API_TOKEN",
  };
}

// ------------------------------------------------------ enable --cloudflare

async function chooseZone(client, wanted, saved) {
  const name = String(wanted || saved || "").trim().toLowerCase().replace(/\.$/, "");
  if (name) return findZone(client, name);
  const zones = await listZones(client);
  if (zones.length === 1) return findZone(client, zones[0].name);
  if (!zones.length) throw new Error("The API token cannot see any zone; give it Zone / Zone / Read and DNS / Edit on the zone to use");
  throw new Error(`--zone <zone> is needed: the API token sees ${zones.length} zones (${zones.map((zone) => zone.name).join(", ")})`);
}

async function chooseIdp(client, accountId, wanted, saved) {
  const providers = await listIdentityProviders(client, accountId);
  if (!wanted && saved) {
    const kept = providers.find((item) => item.id === saved && (item.type === "google" || item.type === "google-apps"));
    if (kept) return kept;
  }
  return chooseGoogleIdp(providers, wanted);
}

async function shareEnableCloudflare(ctx, options) {
  if (options.publicUrl) return { ok: false, error: "--cloudflare makes the address itself; leave out --public-url" };
  const name = String(options.name || DEFAULT_SHARE_NAME).trim().toLowerCase();
  if (!validName(name)) return { ok: false, error: "--name takes a short name: lower-case letters, digits and -, up to 32 characters" };
  const server = await installedPersonalServer(ctx);
  if (!server.installed) return { ok: false, error: server.issues[0], issues: server.issues };
  const identity = await teamIdentity(ctx);
  if (!identity.ok) return identity;
  const previous = (await readTeamState(ctx.paths)) || {};
  const email = normalizeEmail(options.email) || previous.ownerEmail || "";
  if (options.email && !normalizeEmail(options.email)) return { ok: false, error: "--email takes the owner's email address" };
  if (!email) return { ok: false, error: "--email <owner email> is needed the first time: the address the owner logs in to Google with" };
  const owner = await ownerClient(ctx.paths, ctx.cloudflare);
  if (!owner.ok) return owner;
  const { client } = owner;

  let made;
  let team;
  try {
    const zone = await chooseZone(client, options.zone, previous.zone);
    // The token worked, so it is kept for teammates commands.
    if (owner.source === "env") await saveApiToken(ctx.paths, owner.token, ctx.privateFileOptions);
    const sameAccount = previous.accountId === zone.accountId;
    const teamDomain = await accessTeamDomain(client, zone.accountId);
    const idp = await chooseIdp(client, zone.accountId, String(options.idp || "").trim(), sameAccount ? previous.idpId : "");
    const people = await ensurePeoplePolicy(client, zone.accountId, { id: sameAccount ? previous.peoplePolicyId : "", add: [email] });
    const bypass = await ensureBypassPolicy(client, zone.accountId, { id: sameAccount ? previous.bypassPolicyId : "" });
    const host = ownerHost(name, zone.name);
    made = await ensureServerHost(client, {
      accountId: zone.accountId,
      zoneId: zone.id,
      host,
      tunnelName: tunnelName(name),
      idpId: idp.id,
      peoplePolicyId: people.id,
      bypassPolicyId: bypass.id,
      known: sameAccount && previous.owner?.host === host ? previous.owner : {},
    });
    team = {
      accountId: zone.accountId,
      zoneId: zone.id,
      zone: zone.name,
      teamDomain,
      idpId: idp.id,
      idpName: idp.name,
      ownerEmail: email,
      peoplePolicyId: people.id,
      bypassPolicyId: bypass.id,
      owner: {
        name,
        host,
        tunnelId: made.tunnelId,
        aud: made.aud,
        peopleAppId: made.peopleAppId,
        bypassAppId: made.bypassAppId,
        dnsRecordId: made.dnsRecordId,
      },
      sharers: sameAccount ? previous.sharers || {} : {},
    };
    await writeTeamState(ctx.paths, team, ctx.privateFileOptions);
  } catch (error) {
    return errorResult(error);
  }

  const hostTunnel = await removeHostTunnel(ctx);
  const opened = await openShare(ctx, {
    [TUNNEL_TOKEN_ENV]: made.tunnelToken,
    HONCHO_ACCESS_TEAM_DOMAIN: team.teamDomain,
    HONCHO_ACCESS_AUD: made.aud,
    HONCHO_TEAM_WORKSPACE: identity.workspace,
    HONCHO_TEAM_PEER: identity.peer,
  });
  if (!opened.ok) return opened.failure;
  const publicUrl = `https://${made.host}`;
  const state = {
    publicUrl,
    enabledAt: new Date().toISOString(),
    host: made.host,
    teamDomain: team.teamDomain,
    aud: made.aud,
    tunnelId: made.tunnelId,
    tunnel: true,
  };
  await writeState(ctx, state);
  return {
    ...openedResult(opened, { publicUrl, enabledAt: state.enabledAt, host: made.host }),
    cloudflare: { zone: team.zone, tunnelName: made.tunnelName, login: team.idpName, changes: made.changes },
    hostTunnelRemoved: hostTunnel.removed,
    next: `Teammates log in at ${publicUrl}/mcp with Google once their email is on the list (teammates add <email>). The owner's other computers keep using the gate token (server share token) at ${publicUrl}`,
  };
}

export async function shareEnable(options = {}) {
  const ctx = shareContext(options);
  try {
    return await withServerLifecycleLock(ctx.paths.serverDir, "share-enable", () => (options.cloudflare
      ? withTeamAccessLock(ctx.paths, "share-enable", () => shareEnableCloudflare(ctx, options))
      : shareEnableManual(ctx, options)));
  } catch (error) {
    return errorResult(error);
  }
}

// -------------------------------------------------------------------- join

async function readInvite(ctx, options) {
  if (options.invite) return String(options.invite);
  if (options.inviteFile) {
    try { return await fsp.readFile(path.resolve(String(options.inviteFile)), "utf8"); }
    catch (error) { throw new Error(`The invite file could not be read (${error?.code || "error"})`); }
  }
  const fromEnv = String(ctx.env[INVITE_ENV] || "").trim();
  if (fromEnv) return fromEnv;
  throw new Error(`server share join needs --invite-file <file> (or the invite code in ${INVITE_ENV})`);
}

async function shareJoinUnlocked(ctx, options) {
  let invite;
  try { invite = decodeInvite(await readInvite(ctx, options)); } catch (error) { return errorResult(error); }
  const server = await installedPersonalServer(ctx);
  if (!server.installed) return { ok: false, error: server.issues[0], issues: server.issues };
  const identity = await teamIdentity(ctx);
  if (!identity.ok) return identity;

  const hostTunnel = await removeHostTunnel(ctx);
  const opened = await openShare(ctx, {
    [TUNNEL_TOKEN_ENV]: invite.tunnelToken,
    HONCHO_ACCESS_TEAM_DOMAIN: invite.teamDomain,
    HONCHO_ACCESS_AUD: invite.aud,
    HONCHO_TEAM_WORKSPACE: identity.workspace,
    HONCHO_TEAM_PEER: identity.peer,
  });
  if (!opened.ok) return opened.failure;
  const publicUrl = `https://${invite.host}`;
  const state = {
    publicUrl,
    enabledAt: new Date().toISOString(),
    host: invite.host,
    teamDomain: invite.teamDomain,
    aud: invite.aud,
    ...(tunnelIdFromToken(invite.tunnelToken) ? { tunnelId: tunnelIdFromToken(invite.tunnelToken) } : {}),
    team: invite.team,
    joined: true,
    tunnel: true,
  };
  await writeState(ctx, state);
  return {
    ...openedResult(opened, { publicUrl, enabledAt: state.enabledAt, host: invite.host }),
    team: invite.team,
    hostTunnelRemoved: hostTunnel.removed,
    next: `Teammates on the list can now ask this computer's memory at ${publicUrl}/mcp after a Google login`,
  };
}

/**
 * A teammate's server joins the team with the owner's invite (`invite`, else the
 * file `inviteFile`, else HONCHO_SHARE_INVITE). No Cloudflare API token is used.
 */
export async function shareJoin(options = {}) {
  const ctx = shareContext(options);
  try {
    return await withServerLifecycleLock(ctx.paths.serverDir, "share-join", () => shareJoinUnlocked(ctx, options));
  } catch (error) {
    return errorResult(error);
  }
}

// ----------------------------------------------------------------- disable

/** Everything closed here: the tunnel first, then mcp and the gate, then the profile. */
async function closeAll(ctx) {
  const warnings = [];
  const hostTunnel = await removeHostTunnel(ctx);
  const current = await readJson(ctx.paths.stateFile);
  if (current) {
    await writeState(ctx, {
      ...current,
      ...(current.tunnel !== undefined ? { tunnel: false } : {}),
      disabledAt: new Date().toISOString(),
    });
  }
  // The public way in closes first.
  const tunnelStopped = await composeCall(ctx, ["stop", TUNNEL_SERVICE], 120_000);
  const stopped = await composeCall(ctx, ["stop", MCP_SERVICE, GATE_SERVICE], 120_000);
  if (tunnelStopped.ok && stopped.ok) {
    const removed = await composeCall(ctx, ["rm", "-f", ...SHARE_SERVICES], 60_000);
    if (!removed.ok) warnings.push(`The stopped share containers were not removed: ${removed.error}`);
  } else {
    warnings.push(`The share services were not stopped (Docker may not be running): ${(tunnelStopped.ok ? stopped : tunnelStopped).error}`);
  }

  const text = await fsp.readFile(ctx.paths.envFile, "utf8");
  const environment = parseEnvironment(text);
  const profiles = profilesOf(environment);
  if (profiles.includes(SHARE_PROFILE)) {
    const rest = profiles.filter((item) => item !== SHARE_PROFILE);
    await writeEnvironment(ctx, rest.length
      ? replaceEnvironment(text, { COMPOSE_PROFILES: rest.join(",") })
      : withoutEnvironmentKey(text, "COMPOSE_PROFILES"));
  }
  return {
    ok: true,
    enabled: false,
    gateStopped: stopped.ok,
    tunnelStopped: tunnelStopped.ok,
    // Both stay, so turning sharing on again keeps every other computer working.
    keptGateToken: true,
    keptTunnelToken: filled(environment, TUNNEL_TOKEN_ENV),
    cloudflareKept: true,
    note: CLOUDFLARE_KEPT,
    hostTunnelRemoved: hostTunnel.removed,
    ...(warnings.length ? { warnings } : {}),
  };
}

async function shareDisableUnlocked(ctx) {
  if (!(await exists(ctx.paths.envFile))) return { ok: false, error: "No memory server is installed on this computer" };
  return closeAll(ctx);
}

/** Stops the share services on this computer. Nothing in Cloudflare changes. */
export async function shareDisable(options = {}) {
  const ctx = shareContext(options);
  return withServerLifecycleLock(ctx.paths.serverDir, "share-disable", () => shareDisableUnlocked(ctx));
}

// ------------------------------------------------------------ gate token

/** The gate token, for the local app to show so it can be copied to another computer. */
export async function shareToken(options = {}) {
  const ctx = shareContext(options);
  const token = String((await readEnvironmentFile(ctx.paths.envFile)).HONCHO_GATE_TOKEN || "").trim();
  if (!token) return { ok: false, error: "This server has no gate token yet; turn sharing on first" };
  return { ok: true, token };
}

async function shareRotateUnlocked(ctx) {
  if (!(await exists(ctx.paths.envFile))) return { ok: false, error: "No memory server is installed on this computer" };
  const text = await fsp.readFile(ctx.paths.envFile, "utf8");
  const enabled = profilesOf(parseEnvironment(text)).includes(SHARE_PROFILE);
  await writeEnvironment(ctx, replaceEnvironment(text, { HONCHO_GATE_TOKEN: newSecret() }));
  if (!enabled) return { ok: true, rotated: true, restarted: false };
  // The gate's configuration changed, so Compose recreates it; the API is left alone.
  const up = await composeCall(ctx, ["up", "-d", "--no-deps", GATE_SERVICE]);
  if (!up.ok) return { ok: false, rotated: true, restarted: false, error: `The gate was not restarted with the new token: ${up.error}` };
  return { ok: true, rotated: true, restarted: true, next: "Give every other computer the new token (server share token); the old one no longer works" };
}

export async function shareRotate(options = {}) {
  const ctx = shareContext(options);
  return withServerLifecycleLock(ctx.paths.serverDir, "share-rotate", () => shareRotateUnlocked(ctx));
}

export { API_TOKEN_ENV, INVITE_ENV, shareContext };
