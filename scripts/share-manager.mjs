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
// A second way in needs no domain: Cloudflare Mesh (`enable --mesh`; mesh.mjs has
// what it rests on). The host supervisor runs server/host/mesh-forwarder.mjs, which
// listens on 0.0.0.0:<mesh port> and pipes to the gate only what arrived at this
// computer's Mesh address (100.96.0.0/12); other computers of the same Cloudflare
// One account use http://<that address>:<mesh port>. Either way in, or both, can
// be on; the gate (and the share profile) stays while one is.
//
// What is on lives in two files: the installed .env (COMPOSE_PROFILES has "share"
// while the gate runs, and the gate's port and token) and <runtime>/share.json:
//   publicUrl, enabledAt, disabledAt   the tunnel's address and when it changed
//   tunnel                             false once the tunnel is off while the gate
//                                      stays; absent in a file from before Mesh, where
//                                      the share profile alone meant the tunnel
//   mesh {enabled, port, gatePort,     what the supervisor reads to run the forwarder,
//         enabledAt, lastAddress}      and the address last shown, so a changed Mesh
//                                      address is pointed out
//
// Everything that touches the OS goes through injectable functions (run, spawnImpl,
// fetchImpl, composeRunner, which, sleep, meshProbe, hostRuntime), so tests never
// reach docker, cloudflared, launchctl, reg, systemctl, warp-cli or PowerShell.
import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
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
import { embeddingAliasBase, hostStart, meshForwarderStatus, resolveHostPaths } from "./host-manager.mjs";
import {
  DEFAULT_MESH_PORT,
  ensureWindowsFirewallRule,
  MESH_CIDR,
  meshProblems,
  meshState,
  windowsFirewallRule,
} from "./mesh.mjs";
import { findOnPath } from "./runtime-installer.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";
import {
  chooseGatePort,
  compose,
  DEFAULT_GATE_PORT,
  installedServerDir,
  parseEnvironment,
  portInUse,
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
export { DEFAULT_MESH_PORT };
const MESH_PORT_SPAN = 20;
// What every Mesh result says, because nothing on this computer can show it.
export const MESH_ACCOUNT_NOTE = "Other computers reach this address only when the Cloudflare One account lets them: "
  + "the dashboard toggle \"Allow all Cloudflare One traffic to reach enrolled devices\" (Networking -> Mesh), "
  + "the device settings use_zt_virtual_ip, gateway_proxy_enabled and gateway_udp_proxy_enabled, "
  + `and ${MESH_CIDR} sent through WARP by the split tunnel; and they run WARP enrolled in the same account`;

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
    meshForwarderFile: path.join(serverDir, "host", "mesh-forwarder.mjs"),
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
  const run = options.run || runCommand;
  const which = options.which || findOnPath;
  return {
    platform,
    arch: options.arch || process.arch,
    env,
    homeDir,
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    paths,
    // The supervisor's own files: its PID file, its config, and the forwarder's state.
    hostPaths: resolveHostPaths({ installedServerDir: paths.serverDir, platform, env, homeDir }),
    hostRuntime: options.hostRuntime || { start: hostStart },
    meshProbe: options.meshProbe || (() => meshState({ platform, env, run, which, ...(options.fileExists ? { fileExists: options.fileExists } : {}) })),
    meshPortInUse: options.meshPortInUse || options.portInUse || meshPortTaken,
    meshWaitMs: options.meshWaitMs ?? 15_000,
    run,
    spawnImpl: options.spawnImpl || nodeSpawn,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    composeRunner: options.composeRunner || compose,
    which,
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

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function writeState(ctx, state) {
  await writeIfChanged(ctx.paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** True when anything holds `port` on 127.0.0.1 or on all addresses, where the forwarder listens. */
async function meshPortTaken(port) {
  if (await portInUse(port)) return true;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => server.close(() => resolve(false)));
  });
}

// ------------------------------------------------------------ environment

function profilesOf(environment) {
  return String(environment.COMPOSE_PROFILES || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** Which ways in are on: the gate runs for either, so neither is on without the share profile. */
function modesOf(environment, state) {
  const gate = profilesOf(environment).includes(SHARE_PROFILE);
  return {
    gate,
    // Before Mesh, the share profile alone meant the tunnel.
    tunnel: gate && state?.tunnel !== false,
    mesh: gate && state?.mesh?.enabled === true,
  };
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

// -------------------------------------------------------------------- mesh

/** The supervisor runs the forwarder, so it is only as up as the supervisor. */
async function supervisorRunning(ctx) {
  const record = await readJson(ctx.hostPaths.pidFile);
  return processAlive(record?.pid);
}

async function forwarderNow(ctx) {
  const config = await readJson(ctx.hostPaths.configFile);
  return { ...(await meshForwarderStatus(ctx.hostPaths, config)), configured: Boolean(config?.mesh), hostConfig: Boolean(config) };
}

/** Polls until the forwarder's state matches `running`, for at most meshWaitMs. */
async function waitForForwarder(ctx, running) {
  const deadline = Date.now() + ctx.meshWaitMs;
  let forwarder = await forwarderNow(ctx);
  while (forwarder.running !== running && Date.now() < deadline) {
    await ctx.sleep(500);
    forwarder = await forwarderNow(ctx);
  }
  return forwarder;
}

/**
 * The Mesh port: the one asked for, else the saved one, else the first free one
 * from 8011 that is not the gate's. It is kept from then on, because it is part of
 * the address the other computers were given.
 */
async function meshPortFor(ctx, saved, gatePort, requested) {
  const ours = async (port) => {
    const forwarder = await forwarderNow(ctx);
    return forwarder.running && forwarder.port === port;
  };
  if (requested !== undefined) {
    if (requested === gatePort) return { error: `Port ${requested} is the gate's own port; choose another for Mesh` };
    if (requested !== saved && !(await ours(requested)) && await ctx.meshPortInUse(requested)) {
      return { error: `Port ${requested} is taken by another program on this computer; choose another with --port` };
    }
    return { port: requested };
  }
  if (validPort(saved) && saved !== gatePort) return { port: saved };
  for (let port = DEFAULT_MESH_PORT; port < DEFAULT_MESH_PORT + MESH_PORT_SPAN; port += 1) {
    if (port === gatePort) continue;
    if (!(await ctx.meshPortInUse(port))) return { port };
  }
  return { error: `No free port between ${DEFAULT_MESH_PORT} and ${DEFAULT_MESH_PORT + MESH_PORT_SPAN - 1}; choose one with --port` };
}

function meshUrl(ip, port) {
  return ip && validPort(port) ? `http://${ip}:${port}` : null;
}

/**
 * GET /health at this computer's own Mesh address, through the forwarder and the
 * gate, beside the two local pieces. On macOS a request to the WARP interface's own
 * address goes into the tunnel rather than to loopback, so it comes back only once
 * the account lets Mesh traffic reach devices; with the forwarder and the gate up
 * that is "local-only", not a failure here.
 */
async function checkMesh(ctx, { address, gateToken, gatePort, forwarderRunning }) {
  const note = `This proves only this computer's forwarder and gate. ${MESH_ACCOUNT_NOTE}`;
  const headers = { Accept: "application/json", ...(gateToken ? { Authorization: `Bearer ${gateToken}` } : {}) };
  const get = async (url, timeoutMs) => {
    try {
      const response = await ctx.fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      await discardBody(response);
      const state = response.ok ? "ok" : response.status === 401 ? "token" : [502, 503, 504].includes(response.status) ? "unreachable" : "error";
      return { state, status: response.status };
    } catch (error) {
      return { state: "unreachable", error: String(error?.cause?.code || error?.name || "network error") };
    }
  };
  const gate = validPort(gatePort) ? await get(`http://127.0.0.1:${gatePort}/health`, 3_000) : { state: "error" };
  const local = { forwarder: forwarderRunning === true, gate: gate.state === "ok" };
  if (!address) return { state: "no-address", local, note };
  const viaMesh = await get(`${address}/health`, 5_000);
  let state = viaMesh.state;
  if (state === "unreachable" && local.forwarder && local.gate) state = "local-only";
  return {
    state,
    ...(viaMesh.status ? { status: viaMesh.status } : {}),
    ...(viaMesh.error ? { error: viaMesh.error } : {}),
    local,
    ...(state === "local-only"
      ? { detail: "The forwarder and the gate run here, but a request to this computer's own Mesh address did not come back: WARP sends it into the tunnel, so it returns only once the account lets Cloudflare One traffic reach enrolled devices. Try from another computer." }
      : {}),
    note,
  };
}

/**
 * Mesh as this computer sees it: WARP, the address, the forwarder, the Windows
 * firewall rule, and `problems` ({code, message}) for whatever stands in the way.
 * `remember` is the address to save as the last one shown.
 */
async function meshReport(ctx, { state, on, gateToken, check = false, firewall = null }) {
  const saved = state?.mesh && typeof state.mesh === "object" ? state.mesh : {};
  const port = validPort(saved.port) ? saved.port : null;
  const [probe, forwarder, supervisor] = await Promise.all([ctx.meshProbe(), forwarderNow(ctx), supervisorRunning(ctx)]);
  const address = meshUrl(probe.ip, port);
  const problems = on ? meshProblems(probe, { role: "server" }) : [];
  let rule = firewall;
  if (on && ctx.platform === "win32" && port && !rule) rule = await windowsFirewallRule({ port, run: ctx.run, env: ctx.env, platform: ctx.platform });
  if (on && rule && !rule.ok) {
    problems.push({
      code: "firewall-missing",
      message: rule.cancelled
        ? `The administrator prompt for the Windows Firewall rule was declined, so Windows blocks other computers on port ${port}; turn Mesh sharing on again to be asked again`
        : `Windows Firewall has no inbound rule for TCP ${port} from ${MESH_CIDR}, so other computers are blocked; turn Mesh sharing on again to add it (one administrator prompt)`,
    });
  }
  if (on && !forwarder.running) {
    if (forwarder.hostConfig && !forwarder.configured) {
      problems.push({ code: "host-config-old", message: "The host supervisor's config predates Mesh sharing; run server start --profile personal once so it is written again" });
    } else if (!supervisor) {
      problems.push({ code: "host-down", message: "The host supervisor, which runs the Mesh forwarder, is not running; run host start" });
    } else if (port && await ctx.meshPortInUse(port)) {
      // Not the forwarder (it is not running), so another program holds the port.
      problems.push({ code: "port-taken", message: `Another program holds port ${port}, so the Mesh forwarder cannot listen; stop it, or turn Mesh on again with --port <port> (the address changes)` });
    } else {
      problems.push({ code: "forwarder-down", message: "The Mesh forwarder is not running yet; the host supervisor starts it within seconds (host status shows it)" });
    }
  }
  let addressChanged = null;
  if (on && address && saved.lastAddress && saved.lastAddress !== address) {
    addressChanged = { from: saved.lastAddress, to: address };
    problems.push({ code: "address-changed", message: `This computer's Mesh address changed from ${saved.lastAddress} to ${address}; give the other computers the new address (setup --honcho-url ${address})` });
  }
  const report = {
    enabled: on,
    port,
    address,
    ip: probe.ip,
    warp: probe.warp,
    splitTunnelOk: probe.splitTunnel?.ok ?? null,
    splitTunnel: probe.splitTunnel || { ok: null, mode: null },
    forwarder: { running: forwarder.running, pid: forwarder.pid, supervisorRunning: supervisor },
    ...(rule ? { firewall: { ok: rule.ok, name: rule.name, ...(rule.changed ? { added: true } : {}), ...(rule.cancelled ? { cancelled: true } : {}) } } : {}),
    ...(saved.lastAddress ? { lastAddress: saved.lastAddress } : {}),
    ...(addressChanged ? { addressChanged } : {}),
    problems: problems.map((item) => item.code),
  };
  if (check && on) report.check = await checkMesh(ctx, { address, gateToken, gatePort: saved.gatePort, forwarderRunning: forwarder.running });
  return { report, problems, remember: on && address && address !== saved.lastAddress ? address : null };
}

/** Saves the address just shown, so the next status can say when it changed. */
async function rememberMeshAddress(ctx, address) {
  const current = await readJson(ctx.paths.stateFile);
  if (!current?.mesh || current.mesh.enabled !== true) return;
  await writeState(ctx, { ...current, mesh: { ...current.mesh, lastAddress: address } });
}

async function shareEnableMeshUnlocked(ctx, { port: requested }) {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1024 || requested > 65535)) {
    return { ok: false, error: "--port takes a TCP port from 1024 to 65535" };
  }
  const server = await installedPersonalServer(ctx);
  if (!server.installed) return { ok: false, error: server.issues[0], issues: server.issues };
  if (!(await exists(ctx.paths.meshForwarderFile))) {
    return { ok: false, error: "The installed server predates Mesh sharing; run server prepare --profile personal again to install the Mesh forwarder" };
  }
  const environment = await readEnvironmentFile(ctx.paths.envFile);
  const previous = (await readJson(ctx.paths.stateFile)) || {};
  const gatePort = await gatePortFor(ctx, environment);
  const chosen = await meshPortFor(ctx, previous.mesh?.port, gatePort.port, requested);
  if (chosen.error) return { ok: false, error: chosen.error };

  // The gate first: nothing is opened to Mesh while it is not up.
  const opened = await openGate(ctx, gatePort);
  if (!opened.ok) return opened.failure;
  const before = modesOf({ COMPOSE_PROFILES: opened.profileWasOn ? SHARE_PROFILE : "" }, previous);
  const probe = await ctx.meshProbe();
  const address = meshUrl(probe.ip, chosen.port);
  const enabledAt = previous.mesh?.enabled === true && opened.profileWasOn && previous.mesh.port === chosen.port
    ? previous.mesh.enabledAt || new Date().toISOString()
    : new Date().toISOString();
  const state = {
    ...previous,
    tunnel: before.tunnel,
    mesh: {
      enabled: true,
      port: chosen.port,
      gatePort: opened.port.port,
      enabledAt,
      // Shown now, in this result.
      ...(address ? { lastAddress: address } : previous.mesh?.lastAddress ? { lastAddress: previous.mesh.lastAddress } : {}),
    },
  };
  // What the supervisor reads to run the forwarder.
  await writeState(ctx, state);

  const firewall = ctx.platform === "win32"
    ? await ensureWindowsFirewallRule({ port: chosen.port, run: ctx.run, env: ctx.env, platform: ctx.platform })
    : null;

  let host = { running: await supervisorRunning(ctx), started: false };
  if (!host.running) {
    const started = await ctx.hostRuntime.start({
      profile: "personal",
      installedServerDir: ctx.paths.serverDir,
      platform: ctx.platform,
      env: ctx.env,
      homeDir: ctx.homeDir,
      skipPrepare: true,
      startTimeoutMs: 0,
    }).catch((error) => ({ ok: false, issues: [String(error?.message || error)] }));
    host = {
      running: await supervisorRunning(ctx),
      started: started?.running === true || started?.started === true,
      ...(started?.issues?.length ? { issues: started.issues } : {}),
    };
  }
  await waitForForwarder(ctx, true);
  // Compared with the address shown before this, so a changed one is pointed out here too.
  const shownBefore = { ...state, mesh: { ...state.mesh, lastAddress: previous.mesh?.lastAddress } };
  const { report, problems } = await meshReport(ctx, { state: shownBefore, on: true, gateToken: opened.gateToken, firewall });
  const warnings = problems.map((item) => item.message);
  if (!opened.gate.healthy) warnings.push("The gate did not answer its health check yet; check server status");
  return {
    ok: true,
    enabled: true,
    mesh: report,
    gateTokenCreated: opened.gateTokenCreated,
    gate: { port: opened.port.port, localUrl: `http://127.0.0.1:${opened.port.port}`, ...opened.gate },
    host,
    ...(warnings.length ? { warnings } : {}),
    note: MESH_ACCOUNT_NOTE,
    next: address
      ? `On each other computer, run setup with --honcho-url ${address} and the gate token (server share token) in HONCHO_API_TOKEN`
      : "Connect WARP on this computer to the team, then run server share status to see the Mesh address",
  };
}

/** Turns Mesh sharing on: the gate, the forwarder under the host supervisor, and on Windows the firewall rule. */
export async function shareEnableMesh(options = {}) {
  const ctx = shareContext(options);
  return withServerLifecycleLock(ctx.paths.serverDir, "share-enable", () => shareEnableMeshUnlocked(ctx, options));
}

// ------------------------------------------------------------------ public

/** Cheap: files only. What `server status` reports. */
export async function shareSummary(options = {}) {
  const paths = sharePaths(options);
  const environment = await readEnvironmentFile(paths.envFile);
  const state = await readJson(paths.stateFile);
  const modes = modesOf(environment, state);
  return {
    enabled: modes.gate,
    publicUrl: typeof state?.publicUrl === "string" ? state.publicUrl : null,
    ...(state?.mesh ? { mesh: { enabled: modes.mesh, port: validPort(state.mesh.port) ? state.mesh.port : null } } : {}),
  };
}

export async function shareStatus(options = {}) {
  const ctx = shareContext(options);
  const server = await installedPersonalServer(ctx);
  const environment = server.environment;
  const enabled = profilesOf(environment).includes(SHARE_PROFILE);
  const state = await readJson(ctx.paths.stateFile);
  const modes = modesOf(environment, state);
  const { port } = await gatePortFor(ctx, environment);
  const [running, binary, autostart, tunnelUp, tokenSaved] = await Promise.all([
    server.installed ? gateRunning(ctx) : Promise.resolve(false),
    locateCloudflared(ctx),
    tunnelAutostartInstalled(ctx),
    tunnelRunning(ctx),
    exists(ctx.paths.tokenFile),
  ]);
  const publicUrl = typeof state?.publicUrl === "string" ? state.publicUrl : null;
  const mesh = await meshReport(ctx, { state, on: modes.mesh, gateToken: environment.HONCHO_GATE_TOKEN, check: options.check === true });
  const result = {
    ok: true,
    installed: server.installed,
    enabled,
    gate: { running, port, localUrl: `http://127.0.0.1:${port}` },
    tunnel: {
      enabled: modes.tunnel,
      installed: Boolean(binary),
      binary: binary?.path || null,
      autostart,
      running: tunnelUp,
      tokenSaved,
    },
    publicUrl,
    ...(state?.enabledAt ? { enabledAt: state.enabledAt } : {}),
    mesh: mesh.report,
    ...(mesh.problems.length ? { warnings: mesh.problems.map((item) => item.message) } : {}),
    ...(modes.mesh ? { note: MESH_ACCOUNT_NOTE } : {}),
    ...(server.issues.length ? { issues: server.issues } : {}),
  };
  // A server shared over Mesh only has no public address to check.
  if (options.check && (modes.tunnel || !modes.mesh)) result.publicCheck = await checkPublic(ctx, publicUrl, environment.HONCHO_GATE_TOKEN);
  if (mesh.remember) await rememberMeshAddress(ctx, mesh.remember).catch(() => {});
  return result;
}

/**
 * The gate up: its token made once, the share profile on, its port saved, and
 * `compose up -d gate`. `port` is the gate port already chosen, else it is chosen here.
 */
async function openGate(ctx, port = null) {
  const text = await fsp.readFile(ctx.paths.envFile, "utf8");
  const environment = parseEnvironment(text);
  const values = {};
  const gateTokenCreated = !String(environment.HONCHO_GATE_TOKEN || "").trim();
  if (gateTokenCreated) values.HONCHO_GATE_TOKEN = newGateToken();
  const profiles = profilesOf(environment);
  if (!profiles.includes(SHARE_PROFILE)) values.COMPOSE_PROFILES = [...profiles, SHARE_PROFILE].join(",");
  const gatePort = port || await gatePortFor(ctx, environment);
  if (!gatePort.saved) values.HONCHO_GATE_PORT = String(gatePort.port);
  if (Object.keys(values).length) await writeEnvironment(ctx, replaceEnvironment(text, values));
  const gateToken = values.HONCHO_GATE_TOKEN || environment.HONCHO_GATE_TOKEN;

  const up = await composeCall(ctx, ["up", "-d", GATE_SERVICE]);
  if (!up.ok) {
    return {
      ok: false,
      failure: {
        ok: false,
        error: `The gate did not start: ${up.error}`,
        next: "Start the server with server start --profile personal, then turn sharing on again",
      },
    };
  }
  const gate = await waitForGate(ctx, gatePort.port, gateToken);
  return { ok: true, gateTokenCreated, port: gatePort, gateToken, gate, profileWasOn: profiles.includes(SHARE_PROFILE) };
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

  const opened = await openGate(ctx);
  if (!opened.ok) return opened.failure;
  const { gateTokenCreated, port, gate } = opened;

  const autostart = await installTunnelAutostart(ctx, cloudflared.path, { restart: tokenChanged });
  // Mesh, when it is on too, stays as it is.
  const previous = await readJson(ctx.paths.stateFile);
  const state = {
    ...(previous?.mesh ? { mesh: previous.mesh } : {}),
    publicUrl: address.url,
    enabledAt: new Date().toISOString(),
    tunnel: true,
  };
  await writeState(ctx, state);
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

/** Every way in closed: the tunnel, the Mesh forwarder, the gate and the share profile. */
async function closeAll(ctx) {
  const warnings = [];
  // The public way in closes first.
  await uninstallTunnelAutostart(ctx);
  // Then Mesh: the supervisor stops the forwarder once the state says so.
  const current = await readJson(ctx.paths.stateFile);
  const meshWasOn = current?.mesh?.enabled === true;
  if (current) {
    const now = new Date().toISOString();
    await writeState(ctx, {
      ...current,
      ...(current.tunnel !== undefined || meshWasOn ? { tunnel: false } : {}),
      ...(current.mesh ? { mesh: { ...current.mesh, enabled: false, ...(meshWasOn ? { disabledAt: now } : {}) } } : {}),
      disabledAt: now,
    });
  }
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
  const forwarder = meshWasOn ? await waitForForwarder(ctx, false) : null;
  return {
    ok: true,
    enabled: false,
    gateStopped: stopped.ok,
    ...(forwarder ? { mesh: { enabled: false, forwarderStopped: !forwarder.running } } : {}),
    // Both stay, so turning sharing on again keeps every other computer working.
    keptGateToken: true,
    keptTunnelToken: await exists(ctx.paths.tokenFile),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * `only` "mesh" or "tunnel" closes that way in alone; the gate stays while the other
 * is still on, and goes as with no `only` when it is not. No `only` closes both.
 */
async function shareDisableUnlocked(ctx, { only = null } = {}) {
  if (!(await exists(ctx.paths.envFile))) return { ok: false, error: "No memory server is installed on this computer" };
  if (!only) return closeAll(ctx);
  const environment = await readEnvironmentFile(ctx.paths.envFile);
  const state = (await readJson(ctx.paths.stateFile)) || {};
  const modes = modesOf(environment, state);
  const other = only === "mesh" ? modes.tunnel : modes.mesh;
  if (!other) return closeAll(ctx);
  const now = new Date().toISOString();
  if (only === "mesh") {
    await writeState(ctx, { ...state, mesh: { ...(state.mesh || {}), enabled: false, disabledAt: now } });
    const forwarder = await waitForForwarder(ctx, false);
    return {
      ok: true,
      enabled: true,
      mesh: { enabled: false, forwarderStopped: !forwarder.running },
      tunnel: { enabled: true },
      gateKept: true,
      ...(forwarder.running ? { warnings: ["The Mesh forwarder is still running; the host supervisor stops it within seconds"] } : {}),
    };
  }
  await uninstallTunnelAutostart(ctx);
  await writeState(ctx, { ...state, tunnel: false, disabledAt: now });
  return {
    ok: true,
    enabled: true,
    tunnel: { enabled: false },
    mesh: { enabled: true },
    gateKept: true,
    keptTunnelToken: await exists(ctx.paths.tokenFile),
  };
}

/** `options.only`: "mesh" or "tunnel" to close only that way in. */
export async function shareDisable(options = {}) {
  const ctx = shareContext(options);
  const only = options.only === "mesh" || options.only === "tunnel" ? options.only : null;
  return withServerLifecycleLock(ctx.paths.serverDir, "share-disable", () => shareDisableUnlocked(ctx, { only }));
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
