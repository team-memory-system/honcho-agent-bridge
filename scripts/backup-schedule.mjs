// When the conversation backup runs by itself: once a day, at an hour (3 by
// default) and a minute taken from this computer's device id, so computers that
// share one destination do not start at the same moment (Google Drive can make
// two folders of one name when two computers create it at once).
//
//   launchd   ~/Library/LaunchAgents/team-memory-system.backup.plist
//             (StartCalendarInterval; a run missed while asleep runs on wake)
//   systemd   ~/.config/systemd/user/team-memory-backup.{service,timer}
//             (OnCalendar, Persistent=true)
//   windows   the Task Scheduler task "TeamMemoryBackup" (daily, StartWhenAvailable),
//             which runs <state>/backup.vbs through a hidden wscript
//
// Each runs `node <cli.mjs> backup run --scheduled`. None needs admin rights. Every OS call
// goes through ctx.run, which tests replace (autostart.mjs refuses the real
// launchctl, systemctl and schtasks under node --test).
//
// Next to it, the same way, a daytime check at 10 and the same minute runs
// `node <cli.mjs> backup alert check` (backup-alert.mjs): it reads the backup's local
// status only and notifies while a problem lasts, since the nightly run happens
// while the person sleeps.
//
//   launchd   ~/Library/LaunchAgents/team-memory-system.backup-check.plist
//   systemd   ~/.config/systemd/user/team-memory-backup-check.{service,timer}
//   windows   the task "TeamMemoryBackupCheck", which runs <state>/backup-check.vbs
//
// `backup schedule on` registers both and `backup schedule off` removes both.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { failure, installLaunchAgent, launchAgent, runCommand, uninstallLaunchAgent, writeIfChanged } from "./autostart.mjs";

export const BACKUP_LAUNCHD_LABEL = "team-memory-system.backup";
export const BACKUP_TASK_NAME = "TeamMemoryBackup";
export const BACKUP_SYSTEMD_SERVICE = "team-memory-backup.service";
export const BACKUP_SYSTEMD_TIMER = "team-memory-backup.timer";
export const BACKUP_CHECK_LAUNCHD_LABEL = "team-memory-system.backup-check";
export const BACKUP_CHECK_TASK_NAME = "TeamMemoryBackupCheck";
export const BACKUP_CHECK_SYSTEMD_SERVICE = "team-memory-backup-check.service";
export const BACKUP_CHECK_SYSTEMD_TIMER = "team-memory-backup-check.timer";
export const BACKUP_CHECK_HOUR = 10;

// The two clock jobs. The nightly run's texts are what they were before the check
// existed, so a computer that already has it registered keeps the same files.
const JOBS = {
  run: {
    label: BACKUP_LAUNCHD_LABEL,
    taskName: BACKUP_TASK_NAME,
    service: BACKUP_SYSTEMD_SERVICE,
    timer: BACKUP_SYSTEMD_TIMER,
    command: ["backup", "run", "--scheduled"],
    file: "backup",
    serviceDescription: "Team Memory conversation backup",
    timerDescription: "Team Memory conversation backup, once a day",
    vbsComment: "' Team Memory: the daily conversation backup, with no window.",
    taskDescription: "Team Memory: the daily conversation backup",
    timeLimit: "PT12H",
  },
  check: {
    label: BACKUP_CHECK_LAUNCHD_LABEL,
    taskName: BACKUP_CHECK_TASK_NAME,
    service: BACKUP_CHECK_SYSTEMD_SERVICE,
    timer: BACKUP_CHECK_SYSTEMD_TIMER,
    command: ["backup", "alert", "check"],
    file: "backup-check",
    serviceDescription: "Team Memory conversation backup check",
    timerDescription: "Team Memory conversation backup check, once a day",
    vbsComment: "' Team Memory: the daytime check for conversation backup problems, with no window.",
    taskDescription: "Team Memory: the daytime check for conversation backup problems",
    timeLimit: "PT10M",
  },
};

/** The minute past the hour this device runs at, the same every time for the same id. */
export function scheduleMinute(device) {
  return crypto.createHash("sha256").update(String(device)).digest().readUInt32BE(0) % 60;
}

const pad = (value) => String(value).padStart(2, "0");

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

function xmlEscape(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The nightly run's schedule for this platform, or null where there is none. */
export function backupScheduleSpec(ctx, paths) {
  // --scheduled: once a week this run also checks past the ledger (backup.mjs).
  return clockJobSpec(ctx, JOBS.run, paths);
}

/** The daytime check's schedule for this platform (at BACKUP_CHECK_HOUR), or null where there is none. */
export function backupCheckSpec(ctx, paths) {
  return clockJobSpec(ctx, JOBS.check, { ...paths, hour: BACKUP_CHECK_HOUR });
}

function clockJobSpec(ctx, job, { nodePath, cliPath, logPath, workingDirectory, stateDir, hour, minute }) {
  const programArguments = [nodePath, cliPath, ...job.command];
  if (ctx.platform === "darwin") {
    return launchAgent({
      label: job.label,
      homeDir: ctx.homeDir,
      uid: ctx.uid,
      programArguments,
      workingDirectory,
      stdoutPath: logPath,
      stderrPath: logPath,
      runAtLoad: false,
      keepAlive: null,
      startCalendarInterval: { Hour: hour, Minute: minute },
      // launchd's PATH has no Homebrew; rclone is found through it or its usual places.
      environment: { HOME: ctx.homeDir, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  }
  if (ctx.platform === "linux") {
    const configHome = ctx.env.XDG_CONFIG_HOME ? path.resolve(ctx.env.XDG_CONFIG_HOME) : path.join(ctx.homeDir, ".config");
    const unitDir = path.join(configHome, "systemd", "user");
    const comment = "# Written by `cli.mjs backup schedule on`; `cli.mjs backup schedule off` removes it.";
    return {
      kind: "systemd-timer",
      timerName: job.timer,
      servicePath: path.join(unitDir, job.service),
      timerPath: path.join(unitDir, job.timer),
      serviceText: [
        comment,
        "[Unit]",
        `Description=${job.serviceDescription}`,
        "",
        "[Service]",
        "Type=oneshot",
        `WorkingDirectory=${String(workingDirectory).replace(/%/g, "%%")}`,
        `ExecStart=${programArguments.map(systemdQuote).join(" ")}`,
        `StandardOutput=append:${String(logPath).replace(/%/g, "%%")}`,
        `StandardError=append:${String(logPath).replace(/%/g, "%%")}`,
        "",
      ].join("\n"),
      timerText: [
        comment,
        "[Unit]",
        `Description=${job.timerDescription}`,
        "",
        "[Timer]",
        `OnCalendar=*-*-* ${pad(hour)}:${pad(minute)}:00`,
        "Persistent=true",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
      ].join("\n"),
    };
  }
  if (ctx.platform === "win32") {
    const system32 = path.win32.join(ctx.env.SystemRoot || ctx.env.SYSTEMROOT || "C:\\Windows", "System32");
    const wscript = path.win32.join(system32, "wscript.exe");
    const vbsPath = path.win32.join(stateDir, `${job.file}.vbs`);
    // cmd keeps what the run prints in the log; the outer quotes are cmd's own.
    const commandLine = `cmd /c ""${nodePath}" "${cliPath}" ${job.command.join(" ")} >> "${logPath}" 2>&1"`;
    const vbs = [
      job.vbsComment,
      "' Written by `cli.mjs backup schedule on`; `cli.mjs backup schedule off` removes it.",
      "Option Explicit",
      "Dim shell",
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = "${String(workingDirectory).replace(/"/g, '""')}"`,
      `shell.Run "${commandLine.replace(/"/g, '""')}", 0, True`,
      "",
    ].join("\r\n");
    const xml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      `  <RegistrationInfo><Description>${xmlEscape(job.taskDescription)}</Description></RegistrationInfo>`,
      "  <Triggers>",
      "    <CalendarTrigger>",
      `      <StartBoundary>2026-01-01T${pad(hour)}:${pad(minute)}:00</StartBoundary>`,
      "      <Enabled>true</Enabled>",
      "      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>",
      "    </CalendarTrigger>",
      "  </Triggers>",
      '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <StartWhenAvailable>true</StartWhenAvailable>",
      `    <ExecutionTimeLimit>${job.timeLimit}</ExecutionTimeLimit>`,
      "    <Enabled>true</Enabled>",
      "  </Settings>",
      '  <Actions Context="Author">',
      `    <Exec><Command>${xmlEscape(wscript)}</Command><Arguments>//B //NoLogo "${xmlEscape(vbsPath)}"</Arguments><WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory></Exec>`,
      "  </Actions>",
      "</Task>",
      "",
    ].join("\r\n");
    return {
      kind: "schtasks",
      taskName: job.taskName,
      schtasks: path.win32.join(system32, "schtasks.exe"),
      vbsPath,
      vbs,
      xmlPath: path.win32.join(stateDir, `${job.file}-task.xml`),
      xml,
    };
  }
  return null;
}

function utf16(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

async function systemctl(ctx, args, { check = true } = {}) {
  const result = await (ctx.run || runCommand)("systemctl", ["--user", ...args]);
  if (check && result.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${failure(result, "systemctl")}`);
  return result;
}

/** Writes the schedule and registers it. Nothing runs until the clock says so. */
export async function installBackupSchedule(ctx, spec) {
  const run = ctx.run || runCommand;
  if (spec.kind === "launchd") {
    const installed = await installLaunchAgent({ ...ctx, run }, spec);
    return { kind: spec.kind, path: installed.path, changed: installed.changed };
  }
  if (spec.kind === "systemd-timer") {
    const probe = await run("systemctl", ["--user", "show-environment"]);
    if (probe.code !== 0) throw new Error(`systemd --user is not available, so the backup cannot run by itself: ${failure(probe, "systemctl --user")}`);
    const serviceChanged = await writeIfChanged(spec.servicePath, spec.serviceText, 0o644);
    const timerChanged = await writeIfChanged(spec.timerPath, spec.timerText, 0o644);
    await systemctl(ctx, ["daemon-reload"]);
    await systemctl(ctx, ["enable", "--now", spec.timerName]);
    if (timerChanged) await systemctl(ctx, ["restart", spec.timerName]);
    return { kind: spec.kind, path: spec.timerPath, changed: serviceChanged || timerChanged };
  }
  if (spec.kind === "schtasks") {
    const vbsChanged = await writeIfChanged(spec.vbsPath, utf16(spec.vbs), 0o644);
    const xmlChanged = await writeIfChanged(spec.xmlPath, utf16(spec.xml), 0o644);
    const created = await run(spec.schtasks, ["/Create", "/TN", spec.taskName, "/XML", spec.xmlPath, "/F"]);
    if (created.code !== 0) throw new Error(`The backup task could not be registered (schtasks /Create): ${failure(created, "schtasks")}`);
    return { kind: spec.kind, path: spec.xmlPath, changed: vbsChanged || xmlChanged };
  }
  throw new Error(`unknown schedule kind: ${spec.kind}`);
}

/** Unregisters the schedule and deletes its files. A run in progress finishes. */
export async function removeBackupSchedule(ctx, spec) {
  const run = ctx.run || runCommand;
  if (spec.kind === "launchd") {
    const present = await exists(spec.plistPath);
    await uninstallLaunchAgent({ ...ctx, run }, spec);
    return { kind: spec.kind, removed: present };
  }
  if (spec.kind === "systemd-timer") {
    const present = await exists(spec.timerPath);
    if (present) await systemctl(ctx, ["disable", "--now", spec.timerName], { check: false });
    await fsp.rm(spec.timerPath, { force: true });
    await fsp.rm(spec.servicePath, { force: true });
    if (present) await systemctl(ctx, ["daemon-reload"], { check: false });
    return { kind: spec.kind, removed: present };
  }
  if (spec.kind === "schtasks") {
    const present = (await run(spec.schtasks, ["/Query", "/TN", spec.taskName])).code === 0;
    if (present) {
      const deleted = await run(spec.schtasks, ["/Delete", "/TN", spec.taskName, "/F"]);
      if (deleted.code !== 0) throw new Error(`The backup task could not be removed (schtasks /Delete): ${failure(deleted, "schtasks")}`);
    }
    await fsp.rm(spec.vbsPath, { force: true });
    await fsp.rm(spec.xmlPath, { force: true });
    return { kind: spec.kind, removed: present };
  }
  throw new Error(`unknown schedule kind: ${spec.kind}`);
}

/** Whether the schedule is registered; reads files only, except on Windows where the task is asked for. */
export async function backupScheduleStatus(ctx, spec) {
  if (!spec) return { registered: false, kind: null };
  if (spec.kind === "launchd") return { registered: await exists(spec.plistPath), kind: spec.kind, path: spec.plistPath };
  if (spec.kind === "systemd-timer") return { registered: await exists(spec.timerPath), kind: spec.kind, path: spec.timerPath };
  if (spec.kind === "schtasks") {
    const result = await (ctx.run || runCommand)(spec.schtasks, ["/Query", "/TN", spec.taskName]);
    return { registered: result.code === 0, kind: spec.kind, name: spec.taskName };
  }
  return { registered: false, kind: spec.kind };
}
