// Alerts for the conversation backup: a notification from this computer's own
// operating system when its backup has a problem, so it is not seen only on the
// 백업 screen.
//
// The problems, from the backup's own status (backup.mjs keeps it):
//   failed  the last run ended with errors, failed outright, or stopped before it
//           finished (its process is gone and it never recorded how it ended);
//   stale   no successful run for more than 48 hours, while at least two runs since
//           the last success did not succeed: a destination that keeps answering
//           "waiting", an expired login. One run that only waited is not a problem
//           when the last success is recent, nor the first run after the computer
//           was off or asleep for days.
//
// Who looks:
//   - a scheduled run (`backup run --scheduled`), right after it records how it went;
//   - the daytime check (`backup alert check`, registered next to the nightly run by
//     backup-schedule.mjs), which reads the local status only and runs no backup.
// Each look sends at most one notification, and none for a problem it already
// notified less than 4 hours ago (a run on wake and the daytime check right after).
// While a problem lasts it is notified again at the next look; a successful run
// ends it and nothing more is sent.
//
// Notifiers, best effort: a failure is returned (and logged by the caller), never thrown.
//   darwin  osascript `display notification`, the text as the script's arguments
//   win32   Windows PowerShell 5.1 shows a ToastText04 toast through
//           Windows.UI.Notifications under PowerShell's own AppUserModelID. The
//           script goes as -EncodedCommand and each line inside it as base64, and
//           the text becomes XML text nodes, so no text is ever read as code or markup.
//   linux   notify-send, when it is installed
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { locateRclone, runRclone } from "./backup-store.mjs";

export const STALE_AFTER_MS = 48 * 3_600_000;
export const REPEAT_AFTER_MS = 4 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const STATE_VERSION = 1;
const MAX_LINE = 240;

// Windows PowerShell's AppUserModelID (its Start menu shortcut), present on every Windows 10/11.
export const WINDOWS_TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const SEE_THE_SCREEN = "Team Memory 앱의 백업 화면에서 확인하세요";

export const TEST_MESSAGE = Object.freeze({
  title: "대화 백업 알림 시험이에요",
  lines: Object.freeze(["대화 백업에 문제가 생기면 이렇게 알려 드려요", "이 알림은 닫아도 돼요"]),
});

const CLOUD_NAMES = {
  drive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  box: "Box",
  pcloud: "pCloud",
  mega: "MEGA",
  protondrive: "Proton Drive",
  s3: "S3",
  b2: "Backblaze B2",
  webdav: "WebDAV",
  sftp: "SFTP",
};

// ------------------------------------------------------------------ problems

const iso = (time) => new Date(time).toISOString();

/**
 * The problem the backup has now, from its status (the one backup.mjs writes), or
 * {problem: null}. `label` is the configured destination's label: a run recorded for
 * another destination says nothing about this one. `alive(pid)` tells whether a run
 * that never recorded its end is still going. With `running: true`, a run is going
 * and its outcome is not known yet.
 */
export function backupProblem({ destination, label, status = {}, now = Date.now(), alive = () => false }) {
  if (!destination) return { problem: null };
  const running = status.running && Number.isInteger(status.running.pid) ? status.running : null;
  if (running && alive(running.pid)) return { problem: null, running: true };
  const crashed = running;
  const lastRun = status.lastRun && status.lastRun.destination === label ? status.lastRun : null;
  if (!crashed && (!lastRun || lastRun.ok)) return { problem: null };

  let failing = status.failing && status.failing.destination === label ? status.failing : null;
  if (!failing && lastRun && !lastRun.ok) failing = { since: lastRun.startedAt, runs: 1 };
  const runs = (failing?.runs || 0) + (crashed ? 1 : 0);
  const since = failing?.since || crashed?.startedAt || lastRun?.startedAt || null;
  const lastSuccessAt = status.lastSuccessAt || null;
  const cause = crashed ? "crashed"
    : lastRun.waiting ? lastRun.reason || "waiting"
      : lastRun.counts?.errors ? "errors" : "error";
  const errors = !crashed && lastRun?.counts?.errors ? lastRun.counts.errors : 0;
  const base = { cause, since, lastSuccessAt, ...(errors ? { errors } : {}) };

  const noSuccessSince = lastSuccessAt || since;
  const age = now - Date.parse(noSuccessSince);
  if (age > STALE_AFTER_MS && runs >= 2) {
    return { problem: "stale", ...base, days: Math.floor(age / DAY_MS), key: `stale:${noSuccessSince}` };
  }
  if (crashed || !lastRun.waiting) {
    return { problem: "failed", ...base, key: `failed:${crashed ? crashed.startedAt : lastRun.startedAt}` };
  }
  return { problem: null, waiting: true };
}

/** What the destination is called in a notification: never a path, never a computer's name. */
export function destinationName(destination, cloudType) {
  if (destination?.kind === "cloud") return CLOUD_NAMES[cloudType] || `rclone remote ${destination.remote}`;
  return "백업할 폴더";
}

function causeLine(problem, destination, name) {
  switch (problem.cause) {
    case "crashed": return "백업이 끝나기 전에 멈췄어요";
    case "errors": return `파일 ${problem.errors}개를 백업하지 못했어요`;
    case "error": return "백업하는 도중 오류가 났어요";
    case "unauthorized-or-offline": return `${name}에 연결할 수 없어요(로그인 만료일 수 있어요)`;
    case "rclone-missing": return "이 컴퓨터에서 rclone을 찾을 수 없어요";
    case "rclone-failed": return "rclone이 응답하지 않아요";
    case "remote-missing": return `rclone에 ${destination?.remote || ""} remote가 없어요`;
    case "missing":
    case "not-mounted": return "백업할 폴더가 연결돼 있지 않아요(외장 드라이브나 NAS)";
    case "not-directory": return "백업할 곳이 폴더가 아니에요";
    case "not-writable": return "백업할 폴더에 쓸 수 없어요(권한)";
    case "not-absolute": return "백업할 폴더 경로가 올바르지 않아요";
    default: return `${name}에 연결할 수 없어요`;
  }
}

/** The notification for a problem: a title and two short lines. */
export function alertMessage(problem, { destination, cloudType = null } = {}) {
  const name = destinationName(destination, cloudType);
  const title = problem.problem === "stale" ? `대화 백업이 ${Math.max(2, problem.days || 2)}일 넘게 안 됐어요` : "대화 백업이 실패했어요";
  return { title, lines: [causeLine(problem, destination, name), SEE_THE_SCREEN] };
}

/** The rclone type of a remote (drive, onedrive, …), from rclone's local configuration only; null when unknown. */
export async function cloudTypeOf(remote, { run, env = process.env } = {}) {
  try {
    let invoke = run;
    if (!invoke) {
      if (process.env.NODE_TEST_CONTEXT) return null;
      const binary = locateRclone(env);
      if (!binary) return null;
      invoke = (args, options) => runRclone(binary, args, { ...options, env });
    }
    const result = await invoke(["listremotes", "--long"], { timeoutMs: 30_000 });
    if (result?.code !== 0) return null;
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      const match = /^([^:]+):\s+(\S+)/.exec(line.trim());
      if (match?.[1] === remote) return match[2];
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ notifiers

function cleanLine(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, MAX_LINE);
}

function findOnPath(name, env) {
  for (const directory of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * The PowerShell script for a toast. Each line is in it only as base64 of its UTF-8
 * bytes (letters, digits, + / =), decoded at run time and put into the toast's XML
 * as a text node.
 */
export function windowsToastScript(lines) {
  const encoded = lines.map((line) => `(Decode '${Buffer.from(line, "utf8").toString("base64")}')`);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    "function Decode([string]$value) { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($value)) }",
    `$lines = @(${encoded.join(", ")})`,
    "$content = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText04)",
    "$template = New-Object System.Xml.XmlDocument",
    "$template.LoadXml($content.GetXml())",
    "$nodes = $template.GetElementsByTagName('text')",
    "for ($i = 0; $i -lt $lines.Count -and $i -lt $nodes.Count; $i++) { $null = $nodes[$i].AppendChild($template.CreateTextNode($lines[$i])) }",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml($template.OuterXml)",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_TOAST_APP_ID}').Show($toast)`,
    "",
  ].join("\r\n");
}

/**
 * The command that shows `message` ({title, lines}) on this platform:
 * {method, command, args}, or {unavailable} when there is no way to.
 */
export function notificationCommand(message, { platform = process.platform, env = process.env, findExecutable = findOnPath } = {}) {
  const title = cleanLine(message.title);
  const lines = (message.lines || []).map(cleanLine).filter(Boolean).slice(0, 2);
  if (platform === "darwin") {
    return {
      method: "osascript",
      command: "/usr/bin/osascript",
      // The text goes as the run handler's arguments, never into the script itself.
      args: [
        "-e", "on run argv",
        "-e", "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
        "-e", "end run",
        "--", title, lines[0] || "", lines[1] || "",
      ],
    };
  }
  if (platform === "win32") {
    const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const script = windowsToastScript([title, ...lines]);
    return {
      method: "powershell-toast",
      command: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    };
  }
  if (platform === "linux") {
    const binary = findExecutable("notify-send", env);
    if (!binary) return { unavailable: "notify-send is not installed" };
    return { method: "notify-send", command: binary, args: ["--app-name=Team Memory", "--", title, lines.join("\n")] };
  }
  return { unavailable: `there is no notifier for ${platform}` };
}

function execRun(command, args) {
  // A test that forgot its fake must not put a notification on this computer.
  if (process.env.NODE_TEST_CONTEXT) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "refusing to show a real notification under node --test; inject a notifier" });
  }
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      resolve({ code: typeof error.code === "number" ? error.code : -1, stdout: String(stdout || ""), stderr: String(stderr || "") || String(error.message || "") });
    });
  });
}

/** Shows `message`. Resolves {ok, method, error?}; never throws. */
export async function sendNotification(message, { platform = process.platform, env = process.env, run = execRun, findExecutable = findOnPath } = {}) {
  let command;
  try {
    command = notificationCommand(message, { platform, env, findExecutable });
    if (command.unavailable) return { ok: false, method: null, error: command.unavailable };
    const result = await run(command.command, command.args);
    if (result?.code === 0) return { ok: true, method: command.method };
    const detail = String(result?.stderr || result?.stdout || "").trim().split(/\r?\n/)[0].slice(0, 300);
    return { ok: false, method: command.method, error: detail || `${command.method} exited with ${result?.code}` };
  } catch (error) {
    return { ok: false, method: command?.method || null, error: String(error?.message || error) };
  }
}

/** A notifier for this platform: message → {ok, method, error?}. */
export function platformNotifier(options = {}) {
  return (message) => sendNotification(message, options);
}

// ------------------------------------------------------------------ state

async function readState(statePath) {
  try {
    const state = JSON.parse(await fsp.readFile(statePath, "utf8"));
    return state?.version === STATE_VERSION ? state : {};
  } catch {
    return {};
  }
}

async function writeState(statePath, state) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify({ ...state, version: STATE_VERSION })}\n`, { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, statePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Appends one line to the backup log; best effort. */
export async function logLine(logPath, text) {
  if (!logPath) return;
  try {
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    await fsp.appendFile(logPath, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

/**
 * The alert as `backup status` and the screen show it: the problem now (if any), since
 * when, the notification's text, and when one was last sent.
 */
export async function alertState({ statePath, destination, label, status, now = Date.now(), alive, cloudType = (remote) => cloudTypeOf(remote) }) {
  const problem = backupProblem({ destination, label, status, now, alive });
  const state = await readState(statePath);
  const lastNotified = state.notified ? { lastNotifiedAt: state.notified.at, lastNotifiedProblem: state.notified.problem } : { lastNotifiedAt: null };
  if (!problem.problem) return { problem: null, ...(problem.running ? { running: true } : {}), ...lastNotified };
  const type = destination?.kind === "cloud" ? await cloudType(destination.remote) : null;
  return {
    problem: problem.problem,
    cause: problem.cause,
    since: problem.since,
    lastSuccessAt: problem.lastSuccessAt,
    message: alertMessage(problem, { destination, cloudType: type }),
    ...lastNotified,
  };
}

/**
 * One look at the backup's state. With `send`, a problem is notified (at most once,
 * and not again within REPEAT_AFTER_MS of the same problem's last notification);
 * without, a problem is only reported. No problem clears the alert. Never throws for
 * a notification that fails: that is in the result and the log.
 */
export async function checkAlert({
  statePath,
  logPath,
  destination,
  label,
  status,
  now = Date.now(),
  alive,
  send = true,
  notifier = platformNotifier(),
  cloudType = (remote) => cloudTypeOf(remote),
  source = "check",
}) {
  const problem = backupProblem({ destination, label, status, now, alive });
  const state = await readState(statePath);
  if (problem.running) return { ok: true, problem: null, notified: false, skipped: "a run is going" };
  if (!problem.problem) {
    if (state.key) {
      await writeState(statePath, { key: null, notified: state.notified || null, clearedAt: iso(now) });
      await logLine(logPath, `alert (${source}): the problem has ended`);
    }
    return { ok: true, problem: null, notified: false };
  }
  const summary = { problem: problem.problem, cause: problem.cause, since: problem.since };
  if (!send) return { ok: true, ...summary, notified: false };
  const notifiedAt = Date.parse(state.notified?.at || "");
  if (state.key === problem.key && now - notifiedAt < REPEAT_AFTER_MS) {
    return { ok: true, ...summary, notified: false, skipped: "notified less than 4 hours ago" };
  }
  const type = destination?.kind === "cloud" ? await cloudType(destination.remote) : null;
  const message = alertMessage(problem, { destination, cloudType: type });
  const outcome = await notifier(message);
  if (!outcome?.ok) {
    await logLine(logPath, `alert (${source}): the notification for ${problem.problem}/${problem.cause} failed: ${outcome?.error || "unknown"}`);
    return { ok: true, ...summary, message, notified: false, notificationError: outcome?.error || "unknown" };
  }
  await writeState(statePath, { key: problem.key, notified: { at: iso(now), ...summary }, clearedAt: null });
  await logLine(logPath, `alert (${source}): notified ${problem.problem}/${problem.cause} by ${outcome.method}`);
  return { ok: true, ...summary, message, notified: true, method: outcome.method };
}
