// Sharing a personal memory server with the owner's other computers.
//
// Two pieces, both on this machine:
//   - The gate (server/gate/gate.mjs), a Compose service under the "share" profile.
//     It publishes 127.0.0.1:<HONCHO_GATE_PORT> and lets through only requests that
//     carry the gate token, and only /health and /v3/*.
//   - A Cloudflare tunnel (cloudflared) that the owner created in the Zero Trust
//     dashboard, pointing its public hostname at http://localhost:<gate port>.
//     Cloudflare Access in front of that hostname decides which devices may reach
//     it at all; the gate token decides which of them may use the API.
//
// The tunnel runs under a per-user autostart this module registers through
// autostart.mjs:
//   launchd      ~/Library/LaunchAgents/team-memory-system.tunnel.plist (RunAtLoad, KeepAlive)
//   windows-run  the value "TeamMemoryTunnel" under HKCU\...\CurrentVersion\Run, which
//                runs a hidden wscript .vbs at logon
//   systemd      ~/.config/systemd/user/team-memory-tunnel.service
// None needs admin rights. The tunnel token only ever lives in
// <runtime>/cloudflared/tunnel-token (owner-only) and reaches cloudflared through
// --token-file, never through a command line.
//
// Everything that touches the OS goes through injectable functions (run, spawnImpl,
// fetchImpl, composeRunner, which, sleep), so tests never reach docker,
// cloudflared, launchctl, reg or systemctl.
import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  autostartRegistered,
  installLaunchAgent,
  installSystemdUnit,
  launchAgent as launchAgentSpec,
  launchAgentRunning,
  registerWindowsRun,
  RUN_KEY,
  runCommand,
  systemdUnit as systemdUnitSpec,
  systemdUnitActive,
  uninstallLaunchAgent,
  uninstallSystemdUnit,
  unregisterWindowsRun,
  windowsRun,
  writeIfChanged,
} from "./autostart.mjs";
import { embeddingAliasBase } from "./host-manager.mjs";
import { findOnPath } from "./runtime-installer.mjs";
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

export const TUNNEL_TOKEN_ENV = "HONCHO_TUNNEL_TOKEN";
export const SHARE_PROFILE = "share";
export const GATE_SERVICE = "gate";
export const LAUNCHD_LABEL = "team-memory-system.tunnel";
export { RUN_KEY };
export const RUN_VALUE = "TeamMemoryTunnel";
export const SYSTEMD_UNIT = "team-memory-tunnel.service";
export const CLOUDFLARED_DOWNLOAD_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
const TUNNEL_TOKEN_PATTERN = /^[A-Za-z0-9+/=_.-]{20,8192}$/;

// ---------------------------------------------------------------- context

// Shared with the Docker and Ollama finders; still exported from here for callers.
export { findOnPath };

/** Where everything sharing uses lives, beside the installed server. */
export function sharePaths({ serverDirectory, platform = process.platform, runtimeDirectory } = {}) {
  const serverDir = path.resolve(serverDirectory || installedServerDir());
  const runtimeDir = path.resolve(runtimeDirectory || path.join(path.dirname(serverDir), "runtime"));
  const cloudflaredDir = path.join(runtimeDir, "cloudflared");
  const logDir = path.join(cloudflaredDir, "logs");
  return {
    serverDir,
    envFile: path.join(serverDir, ".env"),
    composeFile: path.join(serverDir, "compose.yaml"),
    gateScript: path.join(serverDir, "gate", "gate.mjs"),
    runtimeDir,
    stateFile: path.join(runtimeDir, "share.json"),
    cloudflaredDir,
    binary: path.join(cloudflaredDir, platform === "win32" ? "cloudflared.exe" : "cloudflared"),
    tokenFile: path.join(cloudflaredDir, "tunnel-token"),
    logDir,
    logFile: path.join(logDir, "tunnel.log"),
    errorLogFile: path.join(logDir, "tunnel.error.log"),
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
    arch: options.arch || process.arch,
    env,
    homeDir,
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    paths,
    run: options.run || runCommand,
    spawnImpl: options.spawnImpl || nodeSpawn,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    composeRunner: options.composeRunner || compose,
    which: options.which || findOnPath,
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


// ------------------------------------------------------------ environment

function profilesOf(environment) {
  return String(environment.COMPOSE_PROFILES || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function withoutEnvironmentKey(text, key) {
  const lines = text.split(/\r?\n/).filter((line) => !line.startsWith(`${key}=`));
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function newGateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function writeEnvironment(ctx, text) {
  await writePrivateFileAtomic(ctx.paths.envFile, text, ctx.privateFileOptions);
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

// ------------------------------------------------------------- cloudflared

/** The release asset for this machine, as Cloudflare names it. */
export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!cpu) throw new Error(`cloudflared has no download for this processor (${arch})`);
  if (platform === "darwin") return { name: `cloudflared-darwin-${cpu}.tgz`, archive: "tgz" };
  if (platform === "win32") return { name: "cloudflared-windows-amd64.exe", archive: null };
  if (platform === "linux") return { name: `cloudflared-linux-${cpu}`, archive: null };
  throw new Error(`cloudflared has no download for ${platform}`);
}

/** The one regular file of that name in an uncompressed tar archive. */
export function extractTarEntry(archive, wanted) {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const start = offset + 512;
    if ((type === "0" || type === "\0") && path.posix.basename(name) === wanted) {
      return Buffer.from(archive.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`The downloaded archive has no ${wanted}`);
}

async function cloudflaredVersion(ctx, binary) {
  const result = await ctx.run(binary, ["--version"], { timeout: 15_000 });
  if (result.code !== 0) return null;
  const match = /cloudflared version (\S+)/.exec(`${result.stdout}\n${result.stderr}`);
  return match ? match[1] : firstLine(result.stdout) || "unknown";
}

/** Where cloudflared already is, without running or downloading anything. */
async function locateCloudflared(ctx) {
  const onPath = ctx.which("cloudflared", ctx.env, ctx.platform);
  if (onPath) return { path: onPath, source: "path" };
  if (await exists(ctx.paths.binary)) return { path: ctx.paths.binary, source: "runtime" };
  return null;
}

async function downloadCloudflared(ctx) {
  const asset = cloudflaredAsset(ctx.platform, ctx.arch);
  const url = `${CLOUDFLARED_DOWNLOAD_BASE}${asset.name}`;
  let response;
  try {
    response = await ctx.fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    throw new Error(`cloudflared could not be downloaded from ${url}: ${error?.cause?.code || error?.message || error}`);
  }
  if (!response.ok) throw new Error(`cloudflared could not be downloaded from ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const binary = asset.archive === "tgz" ? extractTarEntry(zlib.gunzipSync(bytes), "cloudflared") : bytes;
  if (!binary.length) throw new Error("The downloaded cloudflared is empty");
  await fsp.mkdir(ctx.paths.cloudflaredDir, { recursive: true, mode: 0o700 });
  const temporary = `${ctx.paths.binary}.download-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, binary, { mode: 0o755, flag: "wx" });
    await fsp.chmod(temporary, 0o755).catch(() => {});
    await fsp.rename(temporary, ctx.paths.binary);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { url, asset: asset.name };
}

/** cloudflared on PATH, else the app's own copy, else downloaded into it. Always verified. */
export async function ensureCloudflared(options = {}) {
  const ctx = options.paths ? options : shareContext(options);
  const found = await locateCloudflared(ctx);
  if (found) {
    const version = await cloudflaredVersion(ctx, found.path);
    if (version) return { ...found, version, downloaded: false };
    if (found.source === "path") {
      // A broken cloudflared on PATH is not used; the app's own copy may still be fine.
      if (await exists(ctx.paths.binary)) {
        const own = await cloudflaredVersion(ctx, ctx.paths.binary);
        if (own) return { path: ctx.paths.binary, source: "runtime", version: own, downloaded: false };
      }
    }
  }
  const download = await downloadCloudflared(ctx);
  const version = await cloudflaredVersion(ctx, ctx.paths.binary);
  if (!version) {
    await fsp.rm(ctx.paths.binary, { force: true }).catch(() => {});
    throw new Error("The downloaded cloudflared did not run (cloudflared --version failed)");
  }
  return { path: ctx.paths.binary, source: "downloaded", version, downloaded: true, from: download.url };
}

// --------------------------------------------------------------- autostart

/** The arguments the tunnel runs with. The token is only ever the file's path. */
export function tunnelArguments(ctx) {
  return [
    "tunnel",
    "--no-autoupdate",
    // launchd and systemd capture output themselves; a hidden wscript has nowhere to put it.
    ...(ctx.platform === "win32" ? ["--logfile", ctx.paths.logFile] : []),
    "run",
    "--token-file",
    ctx.paths.tokenFile,
  ];
}

export function launchAgent(ctx, binary) {
  return launchAgentSpec({
    label: LAUNCHD_LABEL,
    homeDir: ctx.homeDir,
    uid: ctx.uid,
    programArguments: [binary, ...tunnelArguments(ctx)],
    workingDirectory: ctx.paths.cloudflaredDir,
    stdoutPath: ctx.paths.logFile,
    stderrPath: ctx.paths.errorLogFile,
    keepAlive: true,
  });
}

export function windowsAutostart(ctx, binary) {
  return windowsRun({
    env: ctx.env,
    subject: "tunnel",
    valueName: RUN_VALUE,
    vbsPath: ctx.paths.vbsFile,
    workingDirectory: ctx.paths.cloudflaredDir,
    commandLine: [binary, ...tunnelArguments(ctx)],
    comments: [
      "Team Memory: starts this computer's Cloudflare tunnel at logon, with no window.",
      "Written by `cli.mjs server share enable`; `cli.mjs server share disable` removes it.",
    ],
  });
}

export function systemdUnit(ctx, binary) {
  return systemdUnitSpec({
    env: ctx.env,
    homeDir: ctx.homeDir,
    subject: "tunnel",
    unitName: SYSTEMD_UNIT,
    comment: "Written by `cli.mjs server share enable`; `cli.mjs server share disable` removes it.",
    description: "Team Memory Cloudflare tunnel",
    wantsNetwork: true,
    workingDirectory: ctx.paths.cloudflaredDir,
    execStart: [binary, ...tunnelArguments(ctx)],
    stdoutPath: ctx.paths.logFile,
    stderrPath: ctx.paths.errorLogFile,
    restart: "always",
    restartSec: 5,
  });
}

/** Only the processes started with this install's token file, never another cloudflared. */
function windowsProcessScript(tokenFile, { stop = false } = {}) {
  const needle = tokenFile.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$found = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') })`,
    stop ? "$found | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" : "",
    "$found | ForEach-Object { $_.ProcessId }",
  ].filter(Boolean).join("; ");
}

async function windowsTunnelProcesses(ctx, { stop = false } = {}) {
  const plan = windowsAutostart(ctx, ctx.paths.binary);
  const result = await ctx.run(plan.powershell, ["-NoProfile", "-NonInteractive", "-Command", windowsProcessScript(ctx.paths.tokenFile, { stop })], { timeout: 20_000 });
  if (result.code !== 0) return [];
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
}

async function installWindows(ctx, binary, { restart = false } = {}) {
  const plan = windowsAutostart(ctx, binary);
  const { changed } = await registerWindowsRun(ctx, plan);
  let running = (await windowsTunnelProcesses(ctx)).length > 0;
  if (running && (changed || restart)) {
    await windowsTunnelProcesses(ctx, { stop: true });
    running = false;
  }
  if (running) return { kind: "windows-run", path: plan.vbsPath, changed, started: false };
  // Started now exactly the way logon starts it.
  const child = ctx.spawnImpl(plan.wscript, ["//B", "//NoLogo", plan.vbsPath], { detached: true, stdio: "ignore", windowsHide: true });
  child?.on?.("error", () => {});
  child?.unref?.();
  return { kind: "windows-run", path: plan.vbsPath, changed, started: true };
}

async function uninstallWindows(ctx) {
  await unregisterWindowsRun(ctx, windowsAutostart(ctx, ctx.paths.binary));
  await windowsTunnelProcesses(ctx, { stop: true });
}

/** Registers the tunnel's autostart and starts the tunnel through it. */
export async function installTunnelAutostart(ctx, binary, options = {}) {
  await fsp.mkdir(ctx.paths.logDir, { recursive: true, mode: 0o700 });
  // An unchanged agent launchd already runs is left alone: KeepAlive keeps it up.
  // A new token file is only read at start, so the caller passes `restart` then.
  if (ctx.platform === "darwin") return installLaunchAgent(ctx, launchAgent(ctx, binary), options);
  if (ctx.platform === "win32") return installWindows(ctx, binary, options);
  if (ctx.platform === "linux") return installSystemdUnit(ctx, systemdUnit(ctx, binary), options);
  throw new Error(`The tunnel cannot start by itself on ${ctx.platform}`);
}

/** Removes the tunnel's autostart and stops the tunnel it runs. */
export async function uninstallTunnelAutostart(ctx) {
  if (ctx.platform === "darwin") return uninstallLaunchAgent(ctx, launchAgent(ctx, ctx.paths.binary));
  if (ctx.platform === "win32") return uninstallWindows(ctx);
  if (ctx.platform === "linux") return uninstallSystemdUnit(ctx, systemdUnit(ctx, ctx.paths.binary));
  throw new Error(`Nothing to remove on ${ctx.platform}`);
}

async function tunnelAutostartInstalled(ctx) {
  if (ctx.platform === "darwin") return autostartRegistered(ctx, launchAgent(ctx, ctx.paths.binary));
  if (ctx.platform === "linux") return autostartRegistered(ctx, systemdUnit(ctx, ctx.paths.binary));
  if (ctx.platform === "win32") return autostartRegistered(ctx, windowsAutostart(ctx, ctx.paths.binary));
  return false;
}

async function tunnelRunning(ctx) {
  if (ctx.platform === "darwin") return launchAgentRunning(ctx, launchAgent(ctx, ctx.paths.binary));
  if (ctx.platform === "linux") return systemdUnitActive(ctx, systemdUnit(ctx, ctx.paths.binary));
  if (ctx.platform === "win32") return (await windowsTunnelProcesses(ctx)).length > 0;
  return false;
}

// ------------------------------------------------------------------- gate

async function composeCall(ctx, args, timeout = 300_000) {
  try {
    const result = await ctx.composeRunner(ctx.paths.serverDir, args, { timeout });
    return { ok: true, stdout: String(result?.stdout || ""), stderr: String(result?.stderr || "") };
  } catch (error) {
    return { ok: false, error: firstLine(error?.stderr || error?.message || error) };
  }
}

async function gateRunning(ctx) {
  const result = await composeCall(ctx, ["ps", "--format", "json", GATE_SERVICE], 15_000);
  if (!result.ok) return false;
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let items;
    try { items = JSON.parse(line); } catch { continue; }
    for (const item of Array.isArray(items) ? items : [items]) {
      if (item?.Service === GATE_SERVICE && item?.State === "running") return true;
    }
  }
  return false;
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

// ------------------------------------------------------------------ public

/** Cheap: files only. What `server status` reports. */
export async function shareSummary(options = {}) {
  const paths = sharePaths(options);
  const environment = await readEnvironmentFile(paths.envFile);
  const state = await readJson(paths.stateFile);
  return {
    enabled: profilesOf(environment).includes(SHARE_PROFILE),
    publicUrl: typeof state?.publicUrl === "string" ? state.publicUrl : null,
  };
}

export async function shareStatus(options = {}) {
  const ctx = shareContext(options);
  const server = await installedPersonalServer(ctx);
  const environment = server.environment;
  const enabled = profilesOf(environment).includes(SHARE_PROFILE);
  const state = await readJson(ctx.paths.stateFile);
  const { port } = await gatePortFor(ctx, environment);
  const [running, binary, autostart, tunnelUp, tokenSaved] = await Promise.all([
    server.installed ? gateRunning(ctx) : Promise.resolve(false),
    locateCloudflared(ctx),
    tunnelAutostartInstalled(ctx),
    tunnelRunning(ctx),
    exists(ctx.paths.tokenFile),
  ]);
  const publicUrl = typeof state?.publicUrl === "string" ? state.publicUrl : null;
  const result = {
    ok: true,
    installed: server.installed,
    enabled,
    gate: { running, port, localUrl: `http://127.0.0.1:${port}` },
    tunnel: {
      installed: Boolean(binary),
      binary: binary?.path || null,
      autostart,
      running: tunnelUp,
      tokenSaved,
    },
    publicUrl,
    ...(state?.enabledAt ? { enabledAt: state.enabledAt } : {}),
    ...(server.issues.length ? { issues: server.issues } : {}),
  };
  if (options.check) result.publicCheck = await checkPublic(ctx, publicUrl, environment.HONCHO_GATE_TOKEN);
  return result;
}

async function shareEnableUnlocked(ctx, { publicUrl }) {
  const address = normalizePublicUrl(publicUrl);
  if (!address.ok) return { ok: false, error: address.error };
  const server = await installedPersonalServer(ctx);
  if (!server.installed) return { ok: false, error: server.issues[0], issues: server.issues };
  const tunnelToken = String(ctx.env[TUNNEL_TOKEN_ENV] || "").trim();
  const tokenSaved = await exists(ctx.paths.tokenFile);
  if (!tunnelToken && !tokenSaved) {
    return { ok: false, error: `The tunnel token is required the first time: put it in ${TUNNEL_TOKEN_ENV} (never on the command line)` };
  }
  if (tunnelToken && !TUNNEL_TOKEN_PATTERN.test(tunnelToken)) {
    return { ok: false, error: "The tunnel token does not look like one; copy the token from the tunnel's install command in the Cloudflare dashboard" };
  }

  // cloudflared first: nothing about the server changes if it cannot be had.
  const cloudflared = await ensureCloudflared(ctx);
  let tokenChanged = false;
  if (tunnelToken) {
    const previous = await fsp.readFile(ctx.paths.tokenFile, "utf8").catch(() => null);
    tokenChanged = previous !== tunnelToken;
    // Written again even when equal, so its owner-only permissions are restored.
    await writePrivateFileAtomic(ctx.paths.tokenFile, tunnelToken, ctx.privateFileOptions);
  }

  const text = await fsp.readFile(ctx.paths.envFile, "utf8");
  const environment = parseEnvironment(text);
  const values = {};
  const gateTokenCreated = !String(environment.HONCHO_GATE_TOKEN || "").trim();
  if (gateTokenCreated) values.HONCHO_GATE_TOKEN = newGateToken();
  const profiles = profilesOf(environment);
  if (!profiles.includes(SHARE_PROFILE)) values.COMPOSE_PROFILES = [...profiles, SHARE_PROFILE].join(",");
  const port = await gatePortFor(ctx, environment);
  if (!port.saved) values.HONCHO_GATE_PORT = String(port.port);
  if (Object.keys(values).length) await writeEnvironment(ctx, replaceEnvironment(text, values));
  const gateToken = values.HONCHO_GATE_TOKEN || environment.HONCHO_GATE_TOKEN;

  const up = await composeCall(ctx, ["up", "-d", GATE_SERVICE]);
  if (!up.ok) {
    return {
      ok: false,
      error: `The gate did not start: ${up.error}`,
      next: "Start the server with server start --profile personal, then turn sharing on again",
    };
  }
  const gate = await waitForGate(ctx, port.port, gateToken);

  const autostart = await installTunnelAutostart(ctx, cloudflared.path, { restart: tokenChanged });
  const state = { publicUrl: address.url, enabledAt: new Date().toISOString() };
  await writeIfChanged(ctx.paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return {
    ok: true,
    enabled: true,
    publicUrl: address.url,
    enabledAt: state.enabledAt,
    gateTokenCreated,
    gate: { port: port.port, localUrl: `http://127.0.0.1:${port.port}`, ...gate },
    tunnel: {
      binary: cloudflared.path,
      source: cloudflared.source,
      version: cloudflared.version,
      tokenUpdated: tokenChanged,
      autostart,
    },
    ...(gate.healthy ? {} : { warnings: ["The gate did not answer its health check yet; check server status"] }),
    next: "On each other computer, run setup with --honcho-url set to the public address and the gate token (server share token) in HONCHO_API_TOKEN",
  };
}

export async function shareEnable(options = {}) {
  const ctx = shareContext(options);
  return withServerLifecycleLock(ctx.paths.serverDir, "share-enable", () => shareEnableUnlocked(ctx, options));
}

async function shareDisableUnlocked(ctx) {
  if (!(await exists(ctx.paths.envFile))) return { ok: false, error: "No memory server is installed on this computer" };
  const warnings = [];
  // The public way in closes first.
  await uninstallTunnelAutostart(ctx);
  const stopped = await composeCall(ctx, ["stop", GATE_SERVICE], 120_000);
  if (stopped.ok) {
    const removed = await composeCall(ctx, ["rm", "-f", GATE_SERVICE], 60_000);
    if (!removed.ok) warnings.push(`The stopped gate container was not removed: ${removed.error}`);
  } else {
    warnings.push(`The gate was not stopped (Docker may not be running): ${stopped.error}`);
  }

  const text = await fsp.readFile(ctx.paths.envFile, "utf8");
  const profiles = profilesOf(parseEnvironment(text));
  if (profiles.includes(SHARE_PROFILE)) {
    const rest = profiles.filter((item) => item !== SHARE_PROFILE);
    await writeEnvironment(ctx, rest.length
      ? replaceEnvironment(text, { COMPOSE_PROFILES: rest.join(",") })
      : withoutEnvironmentKey(text, "COMPOSE_PROFILES"));
  }
  const state = await readJson(ctx.paths.stateFile);
  if (state) {
    await writeIfChanged(ctx.paths.stateFile, `${JSON.stringify({ ...state, disabledAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return {
    ok: true,
    enabled: false,
    gateStopped: stopped.ok,
    // Both stay, so turning sharing on again keeps every other computer working.
    keptGateToken: true,
    keptTunnelToken: await exists(ctx.paths.tokenFile),
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function shareDisable(options = {}) {
  const ctx = shareContext(options);
  return withServerLifecycleLock(ctx.paths.serverDir, "share-disable", () => shareDisableUnlocked(ctx));
}

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
  await writeEnvironment(ctx, replaceEnvironment(text, { HONCHO_GATE_TOKEN: newGateToken() }));
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

export { shareContext };
