import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { backupCommand } from "../scripts/backup.mjs";
import {
  REPEAT_AFTER_MS,
  TEST_MESSAGE,
  WINDOWS_TOAST_APP_ID,
  alertMessage,
  backupProblem,
  cloudTypeOf,
  notificationCommand,
  sendNotification,
} from "../scripts/backup-alert.mjs";
import {
  BACKUP_CHECK_LAUNCHD_LABEL,
  BACKUP_CHECK_TASK_NAME,
  BACKUP_LAUNCHD_LABEL,
  backupCheckSpec,
} from "../scripts/backup-schedule.mjs";

const HOUR = 3_600_000;
const NASTY = "a'; Remove-Item C:\\ -Recurse; '\"$(calc) `whoami` <b>&amp;</b>\u0000\r\n%PATH% ^& | > 한글.jsonl";

async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `backup-alert-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(target, content) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

/** A home with a prompt history and one Claude memory note. */
async function makeHome(t) {
  const home = await temporaryDirectory(t, "home");
  await put(path.join(home, ".claude", "history.jsonl"), `${JSON.stringify({ display: "hi" })}\n`);
  await put(path.join(home, ".claude", "projects", "-p", "memory", "note.md"), "---\nname: note\n---\nbody\n");
  return home;
}

function fakeNotifier({ ok = true, error } = {}) {
  const sent = [];
  const notifier = async (message) => {
    sent.push(message);
    return ok ? { ok: true, method: "fake" } : { ok: false, method: "fake", error };
  };
  return { notifier, sent };
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function writeStatus(dataDir, changes) {
  const file = path.join(dataDir, "backup", "status.json");
  const current = await readJson(file).catch(() => ({}));
  await fsp.writeFile(file, JSON.stringify({ ...current, ...changes }));
}

/** A backup to a folder that is gone (연결 대기), as when a drive is unplugged. */
async function missingFolderSetup(t) {
  const scratch = await temporaryDirectory(t, "scratch");
  const dataDir = path.join(scratch, "data");
  await backupCommand("set", [], { dataDir, folder: scratch, device: "studio" });
  const missing = path.join(scratch, "Volumes", "NAS", "backup");
  const settingsPath = path.join(dataDir, "backup", "settings.json");
  const settings = await readJson(settingsPath);
  settings.destination = { kind: "folder", path: missing, volumeRoot: path.join(scratch, "Volumes", "NAS") };
  await fsp.writeFile(settingsPath, JSON.stringify(settings));
  return { dataDir, label: path.join(missing, "대화") };
}

// ------------------------------------------------------------- conditions

test("a problem is a failed run, a stopped run, or 48 hours without success over at least two runs", () => {
  const destination = { kind: "cloud", remote: "gdrive_dev", path: "" };
  const label = "gdrive_dev:대화";
  const now = Date.parse("2026-10-07T10:30:00.000Z");
  const at = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const waiting = (hoursAgo) => ({ startedAt: at(hoursAgo), ok: false, waiting: true, reason: "unauthorized-or-offline", destination: label });
  const check = (status, alive = () => false) => backupProblem({ destination, label, status, now, alive });

  assert.equal(check({}).problem, null, "nothing has run yet");
  assert.equal(backupProblem({ destination: null, label: "", status: { lastRun: waiting(1) }, now }).problem, null, "no destination, no backup");
  assert.equal(check({ lastRun: { startedAt: at(7), ok: true, destination: label }, lastSuccessAt: at(7) }).problem, null);

  // One run that waited while the last success is recent: a laptop offline at 03:MM.
  const once = check({ lastRun: waiting(7), lastSuccessAt: at(31), failing: { destination: label, since: at(7), runs: 1 } });
  assert.equal(once.problem, null);
  assert.equal(once.waiting, true);
  // The first run after days away waited: not a problem yet either.
  assert.equal(check({ lastRun: waiting(1), lastSuccessAt: at(80), failing: { destination: label, since: at(1), runs: 1 } }).problem, null);
  // Two runs waited and the last success is more than 48 hours ago.
  const stale = check({ lastRun: waiting(7), lastSuccessAt: at(55), failing: { destination: label, since: at(31), runs: 2 } });
  assert.equal(stale.problem, "stale");
  assert.equal(stale.cause, "unauthorized-or-offline");
  assert.equal(stale.since, at(31));
  assert.equal(stale.days, 2);
  assert.equal(stale.key, `stale:${at(55)}`);
  // Never succeeded: counted from the first run that did not.
  assert.equal(check({ lastRun: waiting(1), failing: { destination: label, since: at(50), runs: 3 } }).problem, "stale");
  // Exactly at 48 hours is not yet more than 48.
  assert.equal(check({ lastRun: waiting(1), lastSuccessAt: at(48), failing: { destination: label, since: at(30), runs: 2 } }).problem, null);

  const errors = check({ lastRun: { startedAt: at(7), ok: false, waiting: false, destination: label, counts: { errors: 3 } }, lastSuccessAt: at(31) });
  assert.deepEqual([errors.problem, errors.cause, errors.errors, errors.key], ["failed", "errors", 3, `failed:${at(7)}`]);
  const thrown = check({ lastRun: { startedAt: at(7), ok: false, waiting: false, destination: label, error: "listing codex: boom" }, lastSuccessAt: at(31) });
  assert.deepEqual([thrown.problem, thrown.cause], ["failed", "error"]);

  // A run whose process is gone without recording how it ended stopped midway.
  const stopped = { running: { pid: 4242, startedAt: at(6) }, lastRun: { startedAt: at(30), ok: true, destination: label }, lastSuccessAt: at(30) };
  assert.deepEqual([check(stopped).problem, check(stopped).cause, check(stopped).since], ["failed", "crashed", at(6)]);
  // While it is still going, nothing is known yet.
  assert.deepEqual(check(stopped, (pid) => pid === 4242), { problem: null, running: true });

  // A run recorded for another destination says nothing about this one.
  assert.equal(check({ lastRun: { ...waiting(1), destination: "other:대화" }, lastSuccessAt: at(200), failing: { destination: "other:대화", since: at(100), runs: 5 } }).problem, null);
});

test("each notification is two or three short lines that say what to do, and name no computer", () => {
  const cloud = { kind: "cloud", remote: "gdrive_dev", path: "" };
  const folder = { kind: "folder", path: "/Volumes/아람의 SSD/backup" };
  assert.deepEqual(alertMessage({ problem: "stale", cause: "unauthorized-or-offline", days: 3 }, { destination: cloud, cloudType: "drive" }), {
    title: "대화 백업이 3일 넘게 안 됐어요",
    lines: ["Google Drive에 연결할 수 없어요(로그인 만료일 수 있어요)", "Team Memory 앱의 백업 화면에서 확인하세요"],
  });
  assert.deepEqual(alertMessage({ problem: "failed", cause: "errors", errors: 2 }, { destination: cloud, cloudType: "drive" }), {
    title: "대화 백업이 실패했어요",
    lines: ["파일 2개를 백업하지 못했어요", "Team Memory 앱의 백업 화면에서 확인하세요"],
  });
  assert.equal(alertMessage({ problem: "failed", cause: "crashed" }, { destination: cloud }).lines[0], "백업이 끝나기 전에 멈췄어요");
  assert.equal(alertMessage({ problem: "failed", cause: "error" }, { destination: cloud }).lines[0], "백업하는 도중 오류가 났어요");
  assert.equal(alertMessage({ problem: "stale", cause: "unauthorized-or-offline", days: 2 }, { destination: cloud, cloudType: null }).lines[0],
    "rclone remote gdrive_dev에 연결할 수 없어요(로그인 만료일 수 있어요)");
  const unplugged = alertMessage({ problem: "stale", cause: "not-mounted", days: 2 }, { destination: folder });
  assert.equal(unplugged.lines[0], "백업할 폴더가 연결돼 있지 않아요(외장 드라이브나 NAS)");
  assert.doesNotMatch(JSON.stringify(unplugged), /Volumes|아람|studio/);
  assert.equal(alertMessage({ problem: "stale", cause: "rclone-missing", days: 2 }, { destination: cloud }).lines[0], "이 컴퓨터에서 rclone을 찾을 수 없어요");
});

test("the cloud's kind comes from rclone listremotes --long", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { code: 0, stdout: "gdrive_dev:  drive\nmy box:      onedrive\n", stderr: "" }; };
  assert.equal(await cloudTypeOf("gdrive_dev", { run }), "drive");
  assert.equal(await cloudTypeOf("my box", { run }), "onedrive");
  assert.equal(await cloudTypeOf("gone", { run }), null);
  assert.deepEqual(calls[0], ["listremotes", "--long"]);
  assert.equal(await cloudTypeOf("gdrive_dev", { run: async () => { throw new Error("no rclone"); } }), null);
  assert.equal(await cloudTypeOf("gdrive_dev", { run: async () => ({ code: 1, stdout: "", stderr: "x" }) }), null);
});

// ------------------------------------------------------------- notifiers

test("on macOS the text goes to osascript as arguments, never into the script", () => {
  const command = notificationCommand({ title: "대화 백업이 실패했어요", lines: [NASTY, "Team Memory 앱의 백업 화면에서 확인하세요"] }, { platform: "darwin" });
  assert.equal(command.method, "osascript");
  assert.equal(command.command, "/usr/bin/osascript");
  const split = command.args.indexOf("--");
  const script = command.args.slice(0, split);
  assert.deepEqual(script, [
    "-e", "on run argv",
    "-e", "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
    "-e", "end run",
  ]);
  const text = command.args.slice(split + 1);
  assert.equal(text.length, 3);
  assert.equal(text[0], "대화 백업이 실패했어요");
  assert.equal(text[1], NASTY.replace(/[\u0000-\u001f]+/g, " "));
  assert.doesNotMatch(text[1], /[\u0000-\u001f]/, "no control characters reach the notification");
});

test("on Windows the toast is a PowerShell -EncodedCommand whose text is base64 inside and XML text nodes", () => {
  const lines = ["대화 백업이 실패했어요", NASTY, "Team Memory 앱의 백업 화면에서 확인하세요"];
  const command = notificationCommand({ title: lines[0], lines: lines.slice(1) }, { platform: "win32", env: { SystemRoot: "D:\\Win" } });
  assert.equal(command.method, "powershell-toast");
  assert.equal(command.command, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(command.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(command.args.length, 4);
  assert.match(command.args[3], /^[A-Za-z0-9+/]+=*$/, "the command line is base64 only");
  const script = Buffer.from(command.args[3], "base64").toString("utf16le");

  // Nothing of the text is in the script as itself.
  for (const fragment of ["Remove-Item", "$(calc)", "whoami", "<b>", "%PATH%", "한글", "대화 백업"]) {
    assert.equal(script.includes(fragment), false, `${fragment} reached the script`);
  }
  // Every quoted string is base64, or one of the script's own constants.
  const quoted = [...script.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  for (const value of quoted) {
    assert.ok(/^[A-Za-z0-9+/]*=*$/.test(value) || ["Stop", "text", WINDOWS_TOAST_APP_ID].includes(value), `unexpected string in the script: ${value}`);
  }
  const decoded = [...script.matchAll(/\(Decode '([A-Za-z0-9+/=]*)'\)/g)].map((match) => Buffer.from(match[1], "base64").toString("utf8"));
  assert.deepEqual(decoded, lines.map((line) => line.replace(/[\u0000-\u001f]+/g, " ").trim()));
  assert.match(script, /ToastTemplateType\]::ToastText04/);
  assert.match(script, /CreateTextNode\(\$lines\[\$i\]\)/, "the text becomes XML text nodes");
  assert.ok(script.includes(`CreateToastNotifier('${WINDOWS_TOAST_APP_ID}')`));
  assert.doesNotMatch(script, /Import-Module|Install-Module|BurntToast/);
});

test("on Linux notify-send shows it when installed; without it nothing runs", async (t) => {
  const bin = await temporaryDirectory(t, "bin");
  const env = { PATH: bin };
  assert.deepEqual(notificationCommand({ title: "t", lines: ["a"] }, { platform: "linux", env }), { unavailable: "notify-send is not installed" });
  await put(path.join(bin, "notify-send"), "#!/bin/sh\nexit 0\n");
  await fsp.chmod(path.join(bin, "notify-send"), 0o755);
  const command = notificationCommand({ title: "대화 백업이 실패했어요", lines: ["-x 파일", "확인하세요"] }, { platform: "linux", env });
  assert.equal(command.command, path.join(bin, "notify-send"));
  assert.deepEqual(command.args, ["--app-name=Team Memory", "--", "대화 백업이 실패했어요", "-x 파일\n확인하세요"]);

  const calls = [];
  const missing = await sendNotification({ title: "t", lines: [] }, { platform: "linux", env: { PATH: "" }, run: async (...args) => { calls.push(args); return { code: 0 }; } });
  assert.deepEqual(missing, { ok: false, method: null, error: "notify-send is not installed" });
  assert.equal(calls.length, 0);
});

test("a notifier that fails or throws is reported, never thrown", async () => {
  const failed = await sendNotification({ title: "t", lines: ["a"] }, { platform: "darwin", run: async () => ({ code: 1, stdout: "", stderr: "execution error: Not authorized\nmore" }) });
  assert.deepEqual(failed, { ok: false, method: "osascript", error: "execution error: Not authorized" });
  const thrown = await sendNotification({ title: "t", lines: ["a"] }, { platform: "win32", env: {}, run: async () => { throw new Error("spawn EACCES"); } });
  assert.deepEqual(thrown, { ok: false, method: "powershell-toast", error: "spawn EACCES" });
  assert.deepEqual(await sendNotification({ title: "t", lines: [] }, { platform: "aix" }), { ok: false, method: null, error: "there is no notifier for aix" });
  const shown = await sendNotification({ title: "t", lines: ["a"] }, { platform: "darwin", run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.deepEqual(shown, { ok: true, method: "osascript" });
});

// ------------------------------------------------------------- end to end

// These make a file unreadable with chmod, which root ignores and Windows does not enforce.
const UNREADABLE_SKIP = process.platform === "win32" ? "chmod cannot make a file unreadable on Windows"
  : process.getuid?.() === 0 ? "root reads unreadable files" : false;

test("a scheduled run that ends with errors notifies once, the daytime check repeats it later, and a success ends it", { skip: UNREADABLE_SKIP }, async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const dataDir = await temporaryDirectory(t, "data");
  const note = path.join(home, ".claude", "projects", "-p", "memory", "note.md");
  await backupCommand("set", [], { dataDir, folder: dest, device: "studio" });
  await fsp.chmod(note, 0o000);
  t.after(() => fsp.chmod(note, 0o644).catch(() => {}));
  const { notifier, sent } = fakeNotifier();

  const run = await backupCommand("run", [], { dataDir, homeDir: home, scheduled: true, notifier });
  assert.equal(run.ok, false);
  assert.equal(run.counts.errors, 1);
  assert.deepEqual(run.alert, { problem: "failed", cause: "errors", notified: true });
  assert.deepEqual(sent, [{ title: "대화 백업이 실패했어요", lines: ["파일 1개를 백업하지 못했어요", "Team Memory 앱의 백업 화면에서 확인하세요"] }]);

  const status = await backupCommand("status", [], { dataDir, notifier });
  assert.equal(status.alert.problem, "failed");
  assert.equal(status.alert.since, run.startedAt);
  assert.ok(status.alert.lastNotifiedAt);
  assert.equal(status.alert.message.title, "대화 백업이 실패했어요");
  assert.equal(sent.length, 1, "status does not notify");

  // The daytime check right after: already notified for this problem.
  const soon = await backupCommand("alert", ["check"], { dataDir, notifier });
  assert.equal(soon.notified, false);
  assert.equal(sent.length, 1);
  // Hours later it is still there, so it is notified again, once.
  const later = Date.now() + REPEAT_AFTER_MS + HOUR;
  assert.equal((await backupCommand("alert", ["check"], { dataDir, notifier, now: later })).notified, true);
  assert.equal((await backupCommand("alert", ["check"], { dataDir, notifier, now: later })).notified, false);
  assert.equal(sent.length, 2);

  // A manual run that succeeds ends it.
  await fsp.chmod(note, 0o644);
  const fixed = await backupCommand("run", [], { dataDir, homeDir: home, notifier });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.alert, undefined);
  const after = await backupCommand("alert", ["check"], { dataDir, notifier, now: later + 10 * HOUR });
  assert.equal(after.problem, null);
  assert.equal(sent.length, 2);
  const state = await readJson(path.join(dataDir, "backup", "alert.json"));
  assert.equal(state.key, null);
  assert.ok(state.clearedAt);
  assert.equal((await readJson(path.join(dataDir, "backup", "status.json"))).failing, null);
  assert.equal((await backupCommand("status", [], { dataDir })).alert.problem, null);
});

test("a manual run with errors does not notify; only a scheduled run or the check does", { skip: UNREADABLE_SKIP }, async (t) => {
  const home = await makeHome(t);
  const dest = await temporaryDirectory(t, "dest");
  const dataDir = await temporaryDirectory(t, "data");
  const note = path.join(home, ".claude", "projects", "-p", "memory", "note.md");
  await backupCommand("set", [], { dataDir, folder: dest, device: "studio" });
  await fsp.chmod(note, 0o000);
  t.after(() => fsp.chmod(note, 0o644).catch(() => {}));
  const { notifier, sent } = fakeNotifier();
  const run = await backupCommand("run", [], { dataDir, homeDir: home, notifier });
  assert.equal(run.ok, false);
  assert.equal(run.alert.notified, false);
  assert.equal(sent.length, 0);
  assert.equal((await backupCommand("alert", ["check"], { dataDir, notifier })).notified, true);
  assert.equal(sent.length, 1);
});

test("a run that only waits is no alert while the last success is recent; two waits after 48 hours are", async (t) => {
  const home = await makeHome(t);
  const { dataDir, label } = await missingFolderSetup(t);
  const { notifier, sent } = fakeNotifier();

  await writeStatus(dataDir, { lastSuccessAt: new Date(Date.now() - 20 * HOUR).toISOString() });
  const offline = await backupCommand("run", [], { dataDir, homeDir: home, scheduled: true, notifier });
  assert.equal(offline.waiting, true);
  assert.equal(offline.alert, undefined);
  assert.equal(sent.length, 0);
  assert.equal((await backupCommand("alert", ["check"], { dataDir, notifier })).notified, false);

  // Back after three days away (the last run then succeeded): the first run waits. Not yet.
  const lastSuccessAt = new Date(Date.now() - 72 * HOUR).toISOString();
  await writeStatus(dataDir, { lastSuccessAt, lastRun: { startedAt: lastSuccessAt, finishedAt: lastSuccessAt, ok: true, waiting: false, destination: label }, failing: null });
  await backupCommand("run", [], { dataDir, homeDir: home, scheduled: true, notifier });
  assert.equal(sent.length, 0);
  const failing = (await readJson(path.join(dataDir, "backup", "status.json"))).failing;
  assert.equal(failing.destination, label);
  assert.equal(failing.runs, 1);
  // The next one waits too: more than 48 hours without a success, over two runs.
  const second = await backupCommand("run", [], { dataDir, homeDir: home, scheduled: true, notifier });
  assert.deepEqual(second.alert, { problem: "stale", cause: "not-mounted", notified: true });
  assert.deepEqual(sent, [{ title: "대화 백업이 3일 넘게 안 됐어요", lines: ["백업할 폴더가 연결돼 있지 않아요(외장 드라이브나 NAS)", "Team Memory 앱의 백업 화면에서 확인하세요"] }]);
  const status = await backupCommand("status", [], { dataDir });
  assert.equal(status.alert.problem, "stale");
  assert.equal(status.alert.since, failing.since);
  assert.ok(status.alert.lastNotifiedAt);
});

test("a notification that fails goes to the log and fails nothing", async (t) => {
  const home = await makeHome(t);
  const { dataDir } = await missingFolderSetup(t);
  await writeStatus(dataDir, { lastSuccessAt: new Date(Date.now() - 72 * HOUR).toISOString() });
  const { notifier } = fakeNotifier({ ok: false, error: "osascript: not allowed" });
  await backupCommand("run", [], { dataDir, homeDir: home, scheduled: true, notifier });
  const run = await backupCommand("run", [], { dataDir, homeDir: home, scheduled: true, notifier });
  assert.equal(run.waiting, true);
  assert.deepEqual(run.alert, { problem: "stale", cause: "not-mounted", notified: false });
  const check = await backupCommand("alert", ["check"], { dataDir, notifier });
  assert.equal(check.ok, true);
  assert.equal(check.notificationError, "osascript: not allowed");
  const log = await fsp.readFile(path.join(dataDir, "logs", "backup.log"), "utf8");
  assert.match(log, /alert \(run\): the notification for stale\/not-mounted failed: osascript: not allowed/);
  assert.match(log, /alert \(check\): the notification for stale\/not-mounted failed/);
  // Not marked as notified, so the next look tries again.
  assert.equal((await backupCommand("status", [], { dataDir })).alert.lastNotifiedAt, null);
});

test("the check notifies a run that stopped midway, and leaves a run that is going alone", async (t) => {
  const dest = await temporaryDirectory(t, "dest");
  const dataDir = await temporaryDirectory(t, "data");
  await backupCommand("set", [], { dataDir, folder: dest, device: "studio" });
  const { notifier, sent } = fakeNotifier();
  await writeStatus(dataDir, { running: { pid: process.pid, startedAt: new Date().toISOString() } });
  const going = await backupCommand("alert", ["check"], { dataDir, notifier });
  assert.equal(going.notified, false);
  assert.equal(going.skipped, "a run is going");

  await writeStatus(dataDir, { running: { pid: 2_147_483_646, startedAt: new Date(Date.now() - 7 * HOUR).toISOString() } });
  const stopped = await backupCommand("alert", ["check"], { dataDir, notifier });
  assert.deepEqual([stopped.problem, stopped.cause, stopped.notified], ["failed", "crashed", true]);
  assert.deepEqual(sent, [{ title: "대화 백업이 실패했어요", lines: ["백업이 끝나기 전에 멈췄어요", "Team Memory 앱의 백업 화면에서 확인하세요"] }]);
});

test("backup alert test shows the sample notification", async (t) => {
  const dataDir = await temporaryDirectory(t, "data");
  const { notifier, sent } = fakeNotifier();
  const result = await backupCommand("alert", ["test"], { dataDir, notifier });
  assert.deepEqual(result, { ok: true, method: "fake", message: TEST_MESSAGE });
  assert.deepEqual(sent, [TEST_MESSAGE]);
  assert.match(await fsp.readFile(path.join(dataDir, "logs", "backup.log"), "utf8"), /alert \(test\): shown by fake/);
  const failed = await backupCommand("alert", ["test"], { dataDir, notifier: fakeNotifier({ ok: false, error: "nope" }).notifier });
  assert.deepEqual([failed.ok, failed.error], [false, "nope"]);
  assert.equal((await backupCommand("alert", ["nope"], { dataDir })).ok, false);
});

// ------------------------------------------------------------- schedule

test("the daytime check is a second clock job at 10 and the device's minute on each OS", () => {
  const base = { env: {}, homeDir: "/Users/me", uid: 501 };
  const paths = { nodePath: "/usr/local/bin/node", cliPath: "/app/cli.mjs", logPath: "/app/logs/backup.log", workingDirectory: "/app", stateDir: "/app/state", hour: 3, minute: 17 };
  const mac = backupCheckSpec({ ...base, platform: "darwin" }, paths);
  assert.equal(mac.label, BACKUP_CHECK_LAUNCHD_LABEL);
  assert.equal(mac.plistPath, path.join("/Users/me", "Library", "LaunchAgents", "team-memory-system.backup-check.plist"));
  assert.deepEqual(mac.data.StartCalendarInterval, { Hour: 10, Minute: 17 });
  assert.equal(mac.data.RunAtLoad, false);
  assert.deepEqual(mac.data.ProgramArguments, ["/usr/local/bin/node", "/app/cli.mjs", "backup", "alert", "check"]);

  const linux = backupCheckSpec({ ...base, platform: "linux" }, paths);
  assert.equal(linux.timerName, "team-memory-backup-check.timer");
  assert.match(linux.timerPath, /team-memory-backup-check\.timer$/);
  assert.match(linux.timerText, /^OnCalendar=\*-\*-\* 10:17:00$/m);
  assert.match(linux.timerText, /^Persistent=true$/m);
  assert.match(linux.serviceText, /"backup" "alert" "check"/);

  const windows = backupCheckSpec({ ...base, platform: "win32", env: { SystemRoot: "C:\\Windows" } }, { ...paths, stateDir: "C:\\app\\state" });
  assert.equal(windows.taskName, BACKUP_CHECK_TASK_NAME);
  assert.equal(windows.vbsPath, "C:\\app\\state\\backup-check.vbs");
  assert.equal(windows.xmlPath, "C:\\app\\state\\backup-check-task.xml");
  assert.match(windows.vbs, /backup alert check >> /);
  assert.match(windows.xml, /<StartBoundary>2026-01-01T10:17:00<\/StartBoundary>/);
  assert.match(windows.xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(windows.xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(windows.xml, /<ExecutionTimeLimit>PT10M<\/ExecutionTimeLimit>/);
});

test("backup schedule on registers the nightly run and the daytime check; off removes both", async (t) => {
  const home = await temporaryDirectory(t, "home");
  const dest = await temporaryDirectory(t, "dest");
  const dataDir = await temporaryDirectory(t, "data");
  await backupCommand("set", [], { dataDir, folder: dest, device: "studio" });
  const calls = [];
  const scheduleRunner = async (command, args) => { calls.push([command, ...args]); return { code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "" }; };
  const options = { dataDir, platform: "darwin", homeDir: home, uid: 501, scheduleRunner, sleep: async () => {}, cliPath: "/app/cli.mjs", nodePath: "/usr/local/bin/node" };

  const on = await backupCommand("schedule", ["on"], options);
  assert.equal(on.ok, true);
  assert.equal(on.schedule.registered, true);
  assert.deepEqual([on.schedule.check.registered, on.schedule.check.hour, on.schedule.check.minute], [true, 10, on.schedule.minute]);
  const agents = path.join(home, "Library", "LaunchAgents");
  assert.deepEqual((await fsp.readdir(agents)).sort(), [`${BACKUP_CHECK_LAUNCHD_LABEL}.plist`, `${BACKUP_LAUNCHD_LABEL}.plist`]);
  assert.match(await fsp.readFile(path.join(agents, `${BACKUP_CHECK_LAUNCHD_LABEL}.plist`), "utf8"), /<string>alert<\/string>\s*<string>check<\/string>/);
  assert.deepEqual(calls.filter((call) => call[1] === "bootstrap").map((call) => path.basename(call[3])), [`${BACKUP_LAUNCHD_LABEL}.plist`, `${BACKUP_CHECK_LAUNCHD_LABEL}.plist`]);

  const status = await backupCommand("status", [], options);
  assert.equal(status.schedule.registered, true);
  assert.equal(status.schedule.check.registered, true);
  assert.equal(status.alert.problem, null);

  const off = await backupCommand("schedule", ["off"], options);
  assert.equal(off.ok, true);
  assert.equal(off.schedule.registered, false);
  assert.equal(off.schedule.check.registered, false);
  assert.deepEqual(await fsp.readdir(agents), []);
});
