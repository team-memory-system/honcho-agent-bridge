// Per-user login autostarts, shared by everything this app keeps running.
//
//   launchd      ~/Library/LaunchAgents/<label>.plist, loaded into gui/<uid>
//   windows-run  a value under HKCU\...\CurrentVersion\Run that runs a hidden
//                wscript .vbs at logon
//   systemd      ~/.config/systemd/user/<unit>, enabled for default.target
//
// None needs admin rights. The callers are share-manager.mjs (the Cloudflare tunnel)
// and host-manager.mjs (the host supervisor); each builds its own spec with the
// functions here and keeps what only it knows (how to find its processes).
//
// Every OS call goes through `ctx.run(command, args)`, which resolves to
// {code, stdout, stderr}, and `ctx.sleep(ms)`, so tests hand in fakes. The default
// runner refuses launchctl, reg, schtasks, systemctl and wscript under `node --test`,
// so a test that forgot its fake fails instead of changing this computer.
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export const LAUNCHCTL = "/bin/launchctl";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const STARTUP_APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
export const UNDER_TEST_ERROR = "ERR_OS_REGISTRATION_UNDER_TEST";
const OS_REGISTRATION = /^(?:launchctl|reg|schtasks|systemctl|wscript)(?:\.exe)?$/i;

function commandName(command) {
  return String(command).split(/[\\/]/).pop();
}

/** execFile that always resolves: {code, stdout, stderr, error?}. */
export async function runCommand(command, args, options = {}) {
  if (process.env.NODE_TEST_CONTEXT && OS_REGISTRATION.test(commandName(command))) {
    throw Object.assign(
      new Error(`Refusing to run ${commandName(command)} under node --test; inject a fake runner`),
      { code: UNDER_TEST_ERROR },
    );
  }
  return new Promise((resolve) => {
    execFile(command, args, {
      env: options.env || process.env,
      cwd: options.cwd,
      timeout: options.timeout || 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      resolve({
        code: typeof error.code === "number" ? error.code : -1,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: typeof error.code === "string" ? error.code : undefined,
      });
    });
  });
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function firstLine(text) {
  return String(text || "").trim().split(/\r?\n/)[0].slice(0, 300);
}

export function failure(result, fallback) {
  return firstLine(result?.stderr || result?.stdout) || result?.error || `${fallback} (exit ${result?.code})`;
}

/** Writes only when the bytes differ; reports whether it wrote. */
export async function writeIfChanged(target, content, mode = 0o600) {
  const previous = await fsp.readFile(target).catch(() => null);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  if (previous && previous.equals(bytes)) return false;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.rm(temporary, { force: true });
  await fsp.writeFile(temporary, bytes, { mode, flag: "wx" });
  await fsp.rename(temporary, target);
  return true;
}

// ------------------------------------------------------------------ launchd

function xmlEscape(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistValue(value, depth) {
  const pad = "\t".repeat(depth);
  if (value === true) return `${pad}<true/>`;
  if (value === false) return `${pad}<false/>`;
  if (typeof value === "string") return `${pad}<string>${xmlEscape(value)}</string>`;
  if (Number.isInteger(value)) return `${pad}<integer>${value}</integer>`;
  if (Array.isArray(value)) return [`${pad}<array>`, ...value.map((item) => plistValue(item, depth + 1)), `${pad}</array>`].join("\n");
  const keys = Object.keys(value).sort();
  return [`${pad}<dict>`, ...keys.flatMap((key) => [`${pad}\t<key>${xmlEscape(key)}</key>`, plistValue(value[key], depth + 1)]), `${pad}</dict>`].join("\n");
}

/**
 * A LaunchAgent that starts at login (RunAtLoad). `keepAlive` is `true` (always
 * restart) or a KeepAlive dictionary such as {SuccessfulExit: false}.
 */
export function launchAgent({ label, homeDir, uid, programArguments, workingDirectory, stdoutPath, stderrPath, keepAlive = true, environment }) {
  const data = {
    Label: label,
    ProgramArguments: programArguments,
    RunAtLoad: true,
    KeepAlive: keepAlive,
    ...(workingDirectory ? { WorkingDirectory: workingDirectory } : {}),
    ...(stdoutPath ? { StandardOutPath: stdoutPath } : {}),
    ...(stderrPath ? { StandardErrorPath: stderrPath } : {}),
    ...(environment && Object.keys(environment).length ? { EnvironmentVariables: environment } : {}),
  };
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(data, 0),
    "</plist>",
    "",
  ].join("\n");
  return {
    kind: "launchd",
    label,
    plistPath: path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`),
    target: `gui/${uid}/${label}`,
    domain: `gui/${uid}`,
    data,
    text,
  };
}

export async function launchAgentLoaded(ctx, agent) {
  return (await ctx.run(LAUNCHCTL, ["print", agent.target])).code === 0;
}

export async function launchAgentRunning(ctx, agent) {
  const result = await ctx.run(LAUNCHCTL, ["print", agent.target]);
  return result.code === 0 && /\bstate = running\b|\bpid = \d+/.test(result.stdout);
}

/**
 * Writes the plist and loads it. An unchanged agent launchd already has is left
 * alone unless `restart`; a changed one is booted out and bootstrapped again.
 * Bootstrapping a RunAtLoad agent starts it.
 */
export async function installLaunchAgent(ctx, agent, { restart = false } = {}) {
  const changed = await writeIfChanged(agent.plistPath, agent.text);
  const loaded = await launchAgentLoaded(ctx, agent);
  if (loaded && !changed && !restart) return { kind: "launchd", path: agent.plistPath, changed, started: false };
  if (loaded) await ctx.run(LAUNCHCTL, ["bootout", agent.target]);
  let result;
  // Right after a bootout, launchd can refuse a bootstrap for a moment (error 5).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await ctx.run(LAUNCHCTL, ["bootstrap", agent.domain, agent.plistPath]);
    if (result.code === 0) return { kind: "launchd", path: agent.plistPath, changed, started: true };
    await ctx.sleep(1_000);
  }
  throw new Error(`launchctl bootstrap failed: ${failure(result, "launchctl bootstrap")}`);
}

/** Starts a loaded agent that is not running; a running one is left alone. */
export async function kickstartLaunchAgent(ctx, agent) {
  const result = await ctx.run(LAUNCHCTL, ["kickstart", agent.target]);
  if (result.code !== 0) throw new Error(`launchctl kickstart failed: ${failure(result, "launchctl kickstart")}`);
}

/** Boots the agent out (launchd stops what it runs) and deletes the plist. */
export async function uninstallLaunchAgent(ctx, agent) {
  if (await launchAgentLoaded(ctx, agent)) {
    const result = await ctx.run(LAUNCHCTL, ["bootout", agent.target]);
    if (result.code !== 0 && await launchAgentLoaded(ctx, agent)) {
      throw new Error(`launchctl bootout failed: ${failure(result, "launchctl bootout")}`);
    }
  }
  await fsp.rm(agent.plistPath, { force: true });
}

// -------------------------------------------------------------- windows-run

function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function windowsCommandLine(parts) {
  return parts.map((part) => (/[\s"]/.test(part) ? `"${String(part).replace(/"/g, '\\"')}"` : part)).join(" ");
}

/**
 * A Run value that starts a hidden wscript at logon, and the .vbs it runs.
 * `comments` are the .vbs's first lines, without the leading "' ".
 */
export function windowsRun({ env = {}, subject, valueName, vbsPath, workingDirectory, commandLine, comments = [] }) {
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32");
  const wscript = path.win32.join(system32, "wscript.exe");
  const vbs = [
    ...comments.map((line) => `' ${line}`),
    "Option Explicit",
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(workingDirectory)}`,
    `shell.Run ${vbsString(windowsCommandLine(commandLine))}, 0, False`,
    "",
  ].join("\r\n");
  return {
    kind: "windows-run",
    subject,
    valueName,
    reg: path.win32.join(system32, "reg.exe"),
    powershell: path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    wscript,
    vbsPath,
    vbs,
    runValue: `"${wscript}" //B //NoLogo "${vbsPath}"`,
  };
}

/** Writes the .vbs (UTF-16, so any path survives) and sets the Run value. */
export async function registerWindowsRun(ctx, plan) {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan.vbs, "utf16le")]);
  const changed = await writeIfChanged(plan.vbsPath, bytes, 0o644);
  const added = await ctx.run(plan.reg, ["add", RUN_KEY, "/v", plan.valueName, "/t", "REG_SZ", "/d", plan.runValue, "/f"]);
  if (added.code !== 0) throw new Error(`The ${plan.subject} autostart could not be registered (reg add): ${failure(added, "reg add")}`);
  return { kind: "windows-run", path: plan.vbsPath, changed };
}

export async function windowsRunRegistered(ctx, plan) {
  return (await ctx.run(plan.reg, ["query", RUN_KEY, "/v", plan.valueName])).code === 0;
}

/** Removes the Run value, its Task Manager approval entry, and the .vbs. Stops nothing. */
export async function unregisterWindowsRun(ctx, plan) {
  const removed = await ctx.run(plan.reg, ["delete", RUN_KEY, "/v", plan.valueName, "/f"]);
  if (removed.code !== 0 && await windowsRunRegistered(ctx, plan)) {
    throw new Error(`The ${plan.subject} autostart could not be removed (reg delete): ${failure(removed, "reg delete")}`);
  }
  await ctx.run(plan.reg, ["delete", STARTUP_APPROVED_KEY, "/v", plan.valueName, "/f"]);
  await fsp.rm(plan.vbsPath, { force: true });
}

// ------------------------------------------------------------------ systemd

function systemdQuote(value, { exec = false } = {}) {
  let text = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (exec) text = text.replace(/\$/g, "$$$$");
  return `"${text}"`;
}

function systemdPath(value) {
  return String(value).replace(/%/g, "%%");
}

/** A systemd --user service enabled for default.target, so it starts at login. */
export function systemdUnit({
  env = {},
  homeDir,
  subject,
  unitName,
  comment,
  description,
  wantsNetwork = false,
  workingDirectory,
  execStart,
  environment = {},
  stdoutPath,
  stderrPath,
  restart = "always",
  restartSec = 5,
}) {
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(homeDir, ".config");
  const text = [
    ...(comment ? [`# ${comment}`] : []),
    "[Unit]",
    `Description=${description}`,
    ...(wantsNetwork ? ["Wants=network-online.target", "After=network-online.target"] : []),
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdPath(workingDirectory)}`,
    `ExecStart=${execStart.map((part) => systemdQuote(part, { exec: true })).join(" ")}`,
    ...Object.entries(environment).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    ...(stdoutPath ? [`StandardOutput=append:${systemdPath(stdoutPath)}`] : []),
    ...(stderrPath ? [`StandardError=append:${systemdPath(stderrPath)}`] : []),
    `Restart=${restart}`,
    `RestartSec=${restartSec}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return { kind: "systemd", subject, unitName, unitPath: path.join(configHome, "systemd", "user", unitName), text };
}

async function systemctl(ctx, args, { check = true } = {}) {
  const result = await ctx.run("systemctl", ["--user", ...args]);
  if (check && result.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${failure(result, "systemctl")}`);
  return result;
}

/** Writes and enables the unit, then starts it (restarts it when it changed or `restart`). */
export async function installSystemdUnit(ctx, unit, { restart = false } = {}) {
  const probe = await ctx.run("systemctl", ["--user", "show-environment"]);
  if (probe.code !== 0) {
    throw new Error(`systemd --user is not available, so the ${unit.subject} cannot start by itself: ${failure(probe, "systemctl --user")}`);
  }
  const changed = await writeIfChanged(unit.unitPath, unit.text, 0o644);
  await systemctl(ctx, ["daemon-reload"]);
  await systemctl(ctx, ["enable", unit.unitName]);
  await systemctl(ctx, [changed || restart ? "restart" : "start", unit.unitName]);
  return { kind: "systemd", path: unit.unitPath, changed, started: true };
}

/** Disables and stops the unit, then deletes it. */
export async function uninstallSystemdUnit(ctx, unit) {
  const present = await exists(unit.unitPath);
  if (present) await systemctl(ctx, ["disable", "--now", unit.unitName], { check: false });
  await fsp.rm(unit.unitPath, { force: true });
  if (present) await systemctl(ctx, ["daemon-reload"], { check: false });
}

export async function systemdUnitActive(ctx, unit) {
  const result = await ctx.run("systemctl", ["--user", "is-active", unit.unitName]);
  return result.code === 0 && result.stdout.trim() === "active";
}

// ------------------------------------------------------------------- status

/** Whether the spec is registered: the plist or unit file, or the Run value. */
export async function autostartRegistered(ctx, spec) {
  if (spec.kind === "launchd") return exists(spec.plistPath);
  if (spec.kind === "systemd") return exists(spec.unitPath);
  if (spec.kind === "windows-run") return windowsRunRegistered(ctx, spec);
  return false;
}
