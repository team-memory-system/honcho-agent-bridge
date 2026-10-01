// Cloudflare Mesh: device-to-device traffic over WARP between devices enrolled in
// one Cloudflare One account. A personal server is shared this way when there is
// no domain for a public hostname (share-manager.mjs, `server share enable --mesh`),
// and another computer sends to it at http://<its Mesh address>:<port>.
//
// What this rests on (Cloudflare's docs, checked 2026-09):
//   - Every enrolled device gets a stable IPv4 in 100.96.0.0/12, kept until it
//     registers again. `warp-cli -j debug network` names the WARP interface
//     (`.tunnel_iface.name`: utun0 on macOS, the "CloudflareWARP" adapter on
//     Windows); its IPv4 comes from os.networkInterfaces(). `warp-cli -j
//     registration show` does not carry it.
//   - Traffic between devices goes only where the account allows it, once:
//       the dashboard toggle "Allow all Cloudflare One traffic to reach enrolled
//       devices" (Networking -> Mesh; there is no API for it),
//       PATCH /accounts/{id}/devices/settings {use_zt_virtual_ip, gateway_proxy_enabled,
//       gateway_udp_proxy_enabled: true},
//       and 100.96.0.0/12 sent through WARP by the split tunnel: in the Include
//       list (Include mode), or not excluded (Exclude mode; the default Exclude
//       list has 100.64.0.0/10, which covers it).
//     Only the split tunnel shows on a device: `warp-cli settings` (text) prints
//     "Include mode, with hosts/ips:" or "Exclude mode, ..." and the entries below.
//   - Windows blocks inbound traffic from 100.96.0.0/12 unless a firewall rule
//     lets it in, and adding one needs administrator rights.
//
// Nothing here changes the account. The only change to the computer is the
// Windows firewall rule, behind one UAC prompt (ensureWindowsFirewallRule).
// Every command goes through an injectable `run`, and the interfaces through an
// injectable `interfaces`, so tests never reach warp-cli or PowerShell.
import os from "node:os";

import { locateWarpCli, powershellPath, psQuote, START_FAILED } from "./prereqs.mjs";
import { defaultRun, findOnPath, runCommand } from "./runtime-installer.mjs";

export const MESH_CIDR = "100.96.0.0/12";
export const DEFAULT_MESH_PORT = 8011;
export const FIREWALL_RULE_NAME = "Team Memory Mesh";
const COMMAND_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------------ addresses

function ipv4Number(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv4 CIDR (or a bare address, as /32) as [first, last] numbers, else null. */
export function ipv4Range(cidr) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(String(cidr || "").trim());
  if (!match) return null;
  const base = ipv4Number(match[1]);
  const bits = match[2] === undefined ? 32 : Number(match[2]);
  if (base === null || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const first = Math.floor(base / size) * size;
  return [first, first + size - 1];
}

const MESH_RANGE = ipv4Range(MESH_CIDR);

/** The dotted IPv4 when `address` (plain or `::ffff:`-mapped) is a Mesh address, else null. */
export function meshIPv4(address) {
  let text = String(address || "").trim().toLowerCase();
  if (text.startsWith("::ffff:")) text = text.slice("::ffff:".length);
  const value = ipv4Number(text);
  if (value === null || value < MESH_RANGE[0] || value > MESH_RANGE[1]) return null;
  return text;
}

/** The Mesh IPv4 an http:// URL points at, else null. */
export function meshUrlAddress(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (url.protocol !== "http:") return null;
  return meshIPv4(url.hostname);
}

function ipv4Entries(list) {
  return (Array.isArray(list) ? list : []).filter((entry) => (entry?.family === "IPv4" || entry?.family === 4) && !entry.internal);
}

/**
 * This computer's Mesh address from `warp-cli -j debug network` and
 * os.networkInterfaces(): the 100.96.0.0/12 IPv4 on the WARP interface. Only a
 * warp-cli that names no interface (an older one) has the other interfaces
 * searched, since other overlays (Tailscale's 100.64.0.0/10) use the same range.
 */
export function meshAddressFrom({ network, interfaces = {} }) {
  const name = typeof network?.tunnel_iface?.name === "string" ? network.tunnel_iface.name.trim() : "";
  if (name) {
    const entry = ipv4Entries(interfaces[name]).find((item) => meshIPv4(item.address));
    if (entry) return { ip: meshIPv4(entry.address), iface: name, source: "warp-cli" };
    return { ip: null, iface: name, source: "warp-cli" };
  }
  for (const [iface, list] of Object.entries(interfaces)) {
    const entry = ipv4Entries(list).find((item) => meshIPv4(item.address));
    if (entry) return { ip: meshIPv4(entry.address), iface, source: "interfaces" };
  }
  return { ip: null, iface: null, source: null };
}

// --------------------------------------------------------------- split tunnel

/**
 * The split tunnel from `warp-cli settings`: its mode and the entries listed
 * under "Include mode, with hosts/ips:" or "Exclude mode, with hosts/ips:".
 */
export function parseSplitTunnel(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /\b(Include|Exclude) mode\b/i.exec(lines[index]);
    if (!match || /^\s/.test(lines[index])) continue;
    const entries = [];
    for (let next = index + 1; next < lines.length && /^\s+\S/.test(lines[next]); next += 1) {
      entries.push(lines[next].trim().split(/\s+/, 1)[0]);
    }
    return { mode: match[1].toLowerCase(), entries };
  }
  return { mode: null, entries: [] };
}

/**
 * Whether the split tunnel sends all of 100.96.0.0/12 through WARP: true, false,
 * or null when the mode is unknown. `blocking` names the Exclude entry in the way.
 */
export function splitTunnelReachesMesh(split) {
  const ranges = (split?.entries || []).map((entry) => [entry, ipv4Range(entry)]).filter(([, range]) => range);
  if (split?.mode === "include") {
    return { ok: ranges.some(([, [first, last]]) => first <= MESH_RANGE[0] && last >= MESH_RANGE[1]), mode: "include" };
  }
  if (split?.mode === "exclude") {
    const blocking = ranges.find(([, [first, last]]) => first <= MESH_RANGE[1] && last >= MESH_RANGE[0]);
    return blocking ? { ok: false, mode: "exclude", blocking: blocking[0] } : { ok: true, mode: "exclude" };
  }
  return { ok: null, mode: null };
}

// ------------------------------------------------------------------ warp

function parseJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

function plain(value, max = 100) {
  return typeof value === "string" ? value.replace(/[^\p{L}\p{N} ._@-]/gu, "").trim().slice(0, max) : "";
}

function context(options = {}) {
  return {
    platform: options.platform || process.platform,
    env: options.env || process.env,
    run: options.run || defaultRun,
    which: options.which || findOnPath,
    fileExists: options.fileExists,
    interfaces: options.interfaces || (() => os.networkInterfaces()),
  };
}

/**
 * Everything Mesh needs from this computer's WARP, read-only:
 * `{ warp: {installed, connected, team, iface}, ip, iface, splitTunnel: {mode, ok, blocking?} }`.
 * The team is the account's team name; no identifier leaves this function.
 */
export async function meshState(options = {}) {
  const ctx = context(options);
  const cli = locateWarpCli({ platform: ctx.platform, env: ctx.env, which: ctx.which, ...(ctx.fileExists ? { fileExists: ctx.fileExists } : {}) });
  if (!cli) {
    return { warp: { installed: false, connected: false, team: "", iface: null }, ip: null, iface: null, splitTunnel: { mode: null, ok: null } };
  }
  const runOptions = { env: ctx.env, timeout: COMMAND_TIMEOUT_MS };
  const [status, registration, network, settings] = await Promise.all([
    runCommand(ctx.run, cli, ["-j", "status"], runOptions),
    runCommand(ctx.run, cli, ["-j", "registration", "show"], runOptions),
    runCommand(ctx.run, cli, ["-j", "debug", "network"], runOptions),
    runCommand(ctx.run, cli, ["settings"], runOptions),
  ]);
  const account = registration.ok ? parseJson(registration.stdout)?.account : null;
  const team = account?.type === "team" ? plain(account.organization) || "(unnamed)" : "";
  const connected = status.ok && parseJson(status.stdout)?.status === "Connected";
  let interfaces = {};
  try { interfaces = ctx.interfaces() || {}; } catch {}
  const found = meshAddressFrom({ network: network.ok ? parseJson(network.stdout) : null, interfaces });
  const splitTunnel = settings.ok ? splitTunnelReachesMesh(parseSplitTunnel(settings.stdout)) : { ok: null, mode: null };
  return {
    warp: { installed: true, connected, team, iface: found.iface },
    // An address on a WARP that is not connected reaches nothing.
    ip: connected ? found.ip : null,
    iface: found.iface,
    splitTunnel,
  };
}

/**
 * This computer's Mesh address: `{ ok, ip, iface, connected, team }`, with
 * `error` when there is none.
 */
export async function meshAddress(options = {}) {
  const state = await meshState(options);
  const base = { ip: state.ip, iface: state.iface, connected: state.warp.connected, team: state.warp.team };
  if (state.ip) return { ok: true, ...base };
  let error = "The WARP interface has no Mesh address (100.96.0.0/12)";
  if (!state.warp.installed) error = "Cloudflare WARP is not installed";
  else if (!state.warp.team) error = "WARP is not enrolled in a Cloudflare One team";
  else if (!state.warp.connected) error = "WARP is not connected";
  return { ok: false, ...base, error };
}

// ------------------------------------------------------------------ problems

/**
 * What stands between Mesh and this computer, as `{code, message}`: WARP missing,
 * not in a team, not connected, no Mesh address, or a split tunnel that keeps
 * 100.96.0.0/12 out of WARP. `role` is "server" (this computer is shared) or
 * "client" (it sends to a Mesh address).
 */
export function meshProblems(state, { role = "server" } = {}) {
  const problems = [];
  const reach = role === "server" ? "other computers reach this one" : "this computer reaches a Mesh address";
  if (!state?.warp?.installed) {
    problems.push({ code: "warp-missing", message: `Cloudflare WARP is not installed here, and ${reach} only through it (prereqs install warp --team <team>)` });
    return problems;
  }
  if (!state.warp.team) {
    problems.push({ code: "warp-not-team", message: `WARP here is not enrolled in a Cloudflare One team; ${reach} only between devices of the same account (warp-cli registration new <team>)` });
  } else if (!state.warp.connected) {
    problems.push({ code: "warp-disconnected", message: `WARP here is not connected; ${reach} only while it is (warp-cli connect)` });
  } else if (role === "server" && !state.ip) {
    problems.push({ code: "no-mesh-ip", message: "The WARP interface has no Mesh address (100.96.0.0/12); the account's device settings need use_zt_virtual_ip on (PATCH /accounts/{id}/devices/settings)" });
  }
  if (state.splitTunnel?.ok === false) {
    problems.push(state.splitTunnel.mode === "include"
      ? { code: "split-tunnel-include", message: "WARP's split tunnel here is in Include mode without 100.96.0.0/12, so Mesh traffic does not go through WARP; the account owner adds 100.96.0.0/12 to the Split Tunnels Include list of the device profile" }
      : { code: "split-tunnel-exclude", message: `WARP's split tunnel here excludes ${state.splitTunnel.blocking}, which covers Mesh addresses (100.96.0.0/12); the account owner takes it out of the Split Tunnels Exclude list of the device profile` });
  }
  return problems;
}

/**
 * For a Honcho URL on a Mesh address (setup plan, doctor): this computer's WARP
 * state and what keeps it from reaching that address, or null for any other URL.
 */
export async function meshClientCheck(url, options = {}) {
  const ip = meshUrlAddress(url);
  if (!ip) return null;
  const state = await meshState(options);
  return {
    ip,
    warp: state.warp,
    splitTunnelOk: state.splitTunnel.ok,
    problems: meshProblems(state, { role: "client" }),
  };
}

// --------------------------------------------------------------- Windows firewall

/** Lists this app's inbound Mesh rules as `rule <protocol> <ports> <remote addresses>` lines. */
export function windowsFirewallCheckScript() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$rules = @(Get-NetFirewallRule -DisplayName ${psQuote(FIREWALL_RULE_NAME)} | Where-Object { [string]$_.Enabled -eq 'True' -and [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Allow' })`,
    "$rules | ForEach-Object { $p = $_ | Get-NetFirewallPortFilter; $a = $_ | Get-NetFirewallAddressFilter; Write-Output ('rule ' + [string]$p.Protocol + ' ' + ($p.LocalPort -join ',') + ' ' + ($a.RemoteAddress -join ',')) }",
  ].join("; ");
}

/** True when one listed rule lets TCP `port` in from 100.96.0.0/12. */
export function firewallRuleCovers(stdout, port) {
  return String(stdout || "").replace(/\0/g, "").split(/\r?\n/).some((line) => {
    const match = /^rule (\S+) (\S+) (\S+)\s*$/.exec(line.trim());
    if (!match || match[1].toUpperCase() !== "TCP") return false;
    const ports = match[2].split(",");
    const remotes = match[3].split(",");
    return ports.includes(String(port)) && remotes.some((item) => item === MESH_CIDR || item === "100.96.0.0/255.240.0.0");
  });
}

/** The rule, as the elevated PowerShell runs it: any older copy removed first, so the port is always current. */
export function windowsFirewallRuleCommand(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("The firewall rule needs a TCP port");
  return [
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Direction Inbound -Protocol TCP -LocalPort ${value} -RemoteAddress ${MESH_CIDR} -Action Allow | Out-Null`,
  ].join("; ");
}

/**
 * PowerShell that runs windowsFirewallRuleCommand in a second, elevated
 * PowerShell, waits, and exits with its code. As with the WARP msi
 * (prereqs.mjs), Process.Start with the "runas" verb keeps a refused start's
 * Win32 code: 1223 when UAC is declined.
 */
export function windowsFirewallAddScript(port, env = process.env) {
  const inner = windowsFirewallRuleCommand(port);
  return [
    "$i = New-Object System.Diagnostics.ProcessStartInfo",
    `$i.FileName = ${psQuote(powershellPath(env))}`,
    `$i.Arguments = ${psQuote(`-NoProfile -NonInteractive -WindowStyle Hidden -Command "${inner}"`)}`,
    "$i.Verb = 'runas'",
    "$i.UseShellExecute = $true",
    "$i.WindowStyle = 'Hidden'",
    `try { $p = [System.Diagnostics.Process]::Start($i) } catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; Write-Output ('${START_FAILED} ' + [string]$e.NativeErrorCode + ' ' + $e.Message); exit 1 }`,
    "$p.WaitForExit()",
    "exit $p.ExitCode",
  ].join("; ");
}

async function powershell(ctx, script, timeout) {
  return runCommand(ctx.run, powershellPath(ctx.env), ["-NoProfile", "-NonInteractive", "-Command", script], { env: ctx.env, timeout });
}

/** Whether Windows Firewall lets TCP `port` in from Mesh addresses. Needs no admin rights. */
export async function windowsFirewallRule({ port, ...options } = {}) {
  const ctx = context(options);
  const listed = await powershell(ctx, windowsFirewallCheckScript(), 30_000);
  return { ok: listed.ok && firewallRuleCovers(listed.stdout, port), name: FIREWALL_RULE_NAME, port };
}

/**
 * The inbound rule for TCP `port` from 100.96.0.0/12, added behind one UAC prompt
 * when it is not there yet: `{ ok, changed, cancelled?, error? }`.
 */
export async function ensureWindowsFirewallRule({ port, ...options } = {}) {
  const ctx = context(options);
  if ((await windowsFirewallRule({ port, ...options })).ok) return { ok: true, changed: false, name: FIREWALL_RULE_NAME, port };
  const result = await powershell(ctx, windowsFirewallAddScript(port, ctx.env), 600_000);
  const started = new RegExp(`^${START_FAILED} (-?\\d*) ?(.*)$`, "m").exec(result.stdout.replace(/\0/g, ""));
  if (started) {
    if (started[1] === "1223") return { ok: false, changed: false, cancelled: true, name: FIREWALL_RULE_NAME, port };
    return { ok: false, changed: false, name: FIREWALL_RULE_NAME, port, error: `elevation ${started[1] || "?"}: ${started[2].trim().slice(0, 200)}` };
  }
  if (result.code === 1223) return { ok: false, changed: false, cancelled: true, name: FIREWALL_RULE_NAME, port };
  if (result.code !== 0) return { ok: false, changed: false, name: FIREWALL_RULE_NAME, port, error: `the firewall rule was not added (exit ${result.code})` };
  return { ok: true, changed: true, name: FIREWALL_RULE_NAME, port };
}
