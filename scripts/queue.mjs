import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson } from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { activeTargets, targetEnvironment, targetPaths, withoutTargetFilter } from "./targets.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPOOL_ROOT = expandHome(process.env.HONCHO_CODEX_GATE_SPOOL || "~/.hermes/spool/codex-honcho");
const PENDING_DIR = path.join(SPOOL_ROOT, "pending");
const LOG_PATH = expandHome(process.env.HONCHO_CODEX_GATE_LOG || "~/.hermes/logs/codex-honcho-turn-gate.log");
const IMPORTER_PATH = expandHome(process.env.HONCHO_CODEX_IMPORTER || path.join(SCRIPT_DIR, "collector.mjs"));
const INTERNAL_BATCH_SIZE = numberEnv("HONCHO_CODEX_INTERNAL_BATCH_SIZE", 1);
const EXTERNAL_BATCH_SIZE = numberEnv("HONCHO_CODEX_EXTERNAL_BATCH_SIZE", 10);
const LOCK_STALE_MS = numberEnv("HONCHO_CODEX_GATE_LOCK_STALE_MS", 120_000);
const MAX_DELAY_SECONDS = numberEnv("HONCHO_CODEX_GATE_MAX_DELAY_SECONDS", 300);
const DEFAULT_HONCHO_BASE_URL = "http://127.0.0.1:8001";
const PROVIDER = String(process.env.HONCHO_AGENT_PROVIDER || "codex").trim().toLowerCase();
// While past conversations go into the memory server in the order they started
// (past.mjs), new turns are queued as usual but the primary is not drained, so they
// reach it after the past ones. The run keeps this file; see holding().
const HOLD_PATH = process.env.HONCHO_AGENT_HOLD ? expandHome(process.env.HONCHO_AGENT_HOLD) : "";
// A hold setup places before the past run starts is dropped if no run took it over by then.
const SETUP_HOLD_MS = 30 * 60_000;
// A run that stopped (a restart, a crash) is started again at most this often.
const RESUME_EVERY_MS = 5 * 60_000;

// Other servers that also take this provider's conversations from chosen folders
// (targets.mjs). Read only from the configuration the hook named: a queue run by
// hand, or by a test, without HONCHO_AGENT_BRIDGE_CONFIG never sends anywhere else.
const CONFIG = process.env.HONCHO_AGENT_BRIDGE_CONFIG
  ? await readJson(process.env.HONCHO_AGENT_BRIDGE_CONFIG, null)
  : null;
const TARGETS = activeTargets(CONFIG, PROVIDER);

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function windowsUserEnv(name) {
  if (process.platform !== "win32") return "";
  const escapedName = name.replaceAll("'", "''");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${escapedName}', 'User')`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function importerEnv() {
  const env = {
    ...process.env,
    HONCHO_CODEX_IMPORT_TRIGGER: process.env.HONCHO_CODEX_IMPORTER_TRIGGER || "hook_gate",
  };

  env.HONCHO_BASE_URL = env.HONCHO_BASE_URL || windowsUserEnv("HONCHO_BASE_URL") || DEFAULT_HONCHO_BASE_URL;
  const token = env.HONCHO_API_BEARER_TOKEN || windowsUserEnv("HONCHO_API_BEARER_TOKEN");
  if (token) env.HONCHO_API_BEARER_TOKEN = token;
  return withoutTargetFilter(env);
}

/**
 * The same importer, pointed at one target: its server and credentials, its own
 * state, and its folders, outside which the importer sends nothing.
 */
function targetImporterEnv(target) {
  const base = {
    ...process.env,
    HONCHO_CODEX_IMPORT_TRIGGER: process.env.HONCHO_CODEX_IMPORTER_TRIGGER || "hook_gate",
  };
  return targetEnvironment(CONFIG, target, PROVIDER, base);
}

function utcNow() {
  return new Date().toISOString();
}

async function logLine(message) {
  await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fsp.appendFile(LOG_PATH, `${utcNow()} ${message}\n`, "utf8");
}

function parseArgs() {
  const args = { drain: false, drainIfDue: false, mode: "", rollout: "", dryRun: false };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--drain") args.drain = true;
    else if (item === "--drain-if-due") args.drainIfDue = true;
    else if (item === "--dry-run") args.dryRun = true;
    else if (item === "--mode") args.mode = argv[++index] || "";
    else if (item === "--rollout") args.rollout = argv[++index] || "";
  }
  return args;
}

async function readHookInput() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function pickTranscriptPath(args, hookInput) {
  if (args.rollout) return args.rollout;
  if (typeof hookInput.transcript_path === "string" && hookInput.transcript_path.trim()) {
    return hookInput.transcript_path.trim();
  }
  return "";
}

async function writePendingEntry(directory, id, entry) {
  await fsp.mkdir(directory, { recursive: true });
  const tmpPath = path.join(directory, `${id}.tmp`);
  const finalPath = path.join(directory, `${id}.json`);
  await fsp.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf8");
  await fsp.rename(tmpPath, finalPath);
  return finalPath;
}

/**
 * Each turn is queued for the primary server and, separately, for every target
 * that takes this provider. Which folder the session belongs to is left to the
 * importer, which reads it from the transcript; a target's copy of the entry only
 * means "look at this transcript for that server".
 */
async function enqueue(transcriptPath, hookInput = {}) {
  const id = `${utcNow().replace(/[^0-9A-Za-z]+/g, "-")}-${crypto.randomUUID()}`;
  const entry = {
    transcript_path: transcriptPath,
    created_at: utcNow(),
  };
  if (process.env.HONCHO_GATE_PASS_HOOK_INPUT === "1") {
    entry.hook_input = hookInput;
  }
  const finalPath = await writePendingEntry(PENDING_DIR, id, entry);
  for (const target of TARGETS) {
    try {
      await writePendingEntry(targetPaths(CONFIG, target.id).pending(PROVIDER), id, entry);
    } catch (error) {
      // A target's spool that cannot be written never costs the primary its turn.
      await logLine(`TARGET_ENQUEUE_FAILED ${target.id} ${error?.message || error}`).catch(() => {});
    }
  }
  return finalPath;
}

async function readPendingEntries(directory = PENDING_DIR) {
  await fsp.mkdir(directory, { recursive: true });
  const files = await fsp.readdir(directory);
  const entries = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const filePath = path.join(directory, file);
    try {
      const entry = JSON.parse(await fsp.readFile(filePath, "utf8"));
      if (entry && typeof entry.transcript_path === "string" && entry.transcript_path.trim()) {
        entries.push({
          filePath,
          transcriptPath: entry.transcript_path.trim(),
          createdAt: entry.created_at || "",
          hookInput: entry.hook_input && typeof entry.hook_input === "object" ? entry.hook_input : {},
        });
      }
    } catch (error) {
      await logLine(`BAD_QUEUE_FILE ${filePath} ${error?.message || error}`);
    }
  }
  return entries;
}

function envList(name, fallback) {
  return String(process.env[name] || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function activeSsid() {
  if (process.platform === "darwin") {
    const result = spawnSync("networksetup", ["-getairportnetwork", "en0"], { encoding: "utf8" });
    if (result.status === 0) {
      const match = String(result.stdout || "").match(/Current Wi-Fi Network:\s*(.+)\s*$/);
      if (match) return match[1].trim();
    }
    return "";
  }

  const result = spawnSync("netsh", ["wlan", "show", "interfaces"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return "";
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*SSID\s*:\s*(.+?)\s*$/i);
    if (match && !/^\s*BSSID\s*:/i.test(line)) return match[1].trim();
  }
  return "";
}

function hasInternalIp() {
  const prefixes = envList("HONCHO_CODEX_INTERNAL_IP_PREFIXES", "");
  for (const net of Object.values(os.networkInterfaces())) {
    for (const item of net || []) {
      if (item.family === "IPv4" && prefixes.some((prefix) => item.address.startsWith(prefix))) return true;
    }
  }
  return false;
}

function detectMode(forcedMode) {
  const mode = String(forcedMode || process.env.HONCHO_CODEX_NETWORK_MODE || process.env.HOOK_BATCH_NETWORK || "")
    .trim()
    .toLowerCase();
  if (mode === "internal" || mode === "external") return mode;

  const ssid = activeSsid();
  const internalSsids = envList("HONCHO_CODEX_INTERNAL_SSIDS", "");
  if (ssid && internalSsids.includes(ssid)) return "internal";
  if (hasInternalIp()) return "internal";
  return "external";
}

async function withDrainLock(fn) {
  const lock = await acquireFileLock(path.join(SPOOL_ROOT, "drain.lock"), {
    attempts: 1,
    staleMs: LOCK_STALE_MS,
  });
  if (!lock) return { ok: false, skipped: "drain already running" };
  try {
    return await fn();
  } finally {
    await releaseFileLock(lock);
  }
}

function parseImporterResult(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  return null;
}

function runImporter(transcriptPath, dryRun, hookInputFile = "", env = importerEnv()) {
  const args = [IMPORTER_PATH, "--rollout", transcriptPath];
  if (dryRun) args.push("--dry-run");
  if (process.env.HONCHO_GATE_PASS_HOOK_INPUT === "1" && hookInputFile) {
    args.push("--hook-input-file", hookInputFile);
  }
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
  const parsed = parseImporterResult(result.stdout);
  if (result.error) return { ok: false, error: result.error.message };
  if (!parsed) {
    return {
      ok: false,
      error: "importer returned no machine-readable result",
      status: result.status,
      stderr: String(result.stderr || "").trim(),
    };
  }
  return parsed;
}

function groupByTranscript(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.transcriptPath) || [];
    group.push(entry);
    groups.set(entry.transcriptPath, group);
  }
  return groups;
}

async function drainPending(dryRun, extraEntries = []) {
  const entries = [...(await readPendingEntries()), ...extraEntries];
  const groups = groupByTranscript(entries);

  const results = [];
  for (const [transcriptPath, group] of groups) {
    const result = runImporter(transcriptPath, dryRun, group.find((entry) => entry.filePath)?.filePath || "");
    results.push({ transcript_path: transcriptPath, result });
    if (result.ok && !dryRun) {
      for (const entry of group) {
        if (entry.filePath) await fsp.unlink(entry.filePath).catch(() => {});
      }
    }
  }

  // The primary is done before any target is tried, so a target that is slow or
  // down can only hold up itself.
  const targets = dryRun ? [] : await drainTargets();
  return {
    ok: results.every((item) => item.result.ok),
    drained_paths: results.length,
    results,
    ...(targets.length ? { targets_ok: targets.every((item) => item.ok), targets } : {}),
  };
}

/**
 * Each target's own spool, drained with its own importer environment. An entry
 * leaves the spool only when that server took it (or the importer found the
 * session outside the target's folders); otherwise it waits for the next drain,
 * as the primary's does. After the first failure a target is left for this run:
 * it is probably down, and every further try would only wait out its timeout.
 */
async function drainTargets() {
  const summaries = [];
  for (const target of TARGETS) {
    const directory = targetPaths(CONFIG, target.id).pending(PROVIDER);
    let entries;
    try {
      entries = await readPendingEntries(directory);
    } catch (error) {
      summaries.push({ id: target.id, ok: false, error: String(error?.message || error) });
      continue;
    }
    if (entries.length === 0) continue;
    const env = targetImporterEnv(target);
    const results = [];
    let failed = false;
    for (const [transcriptPath, group] of groupByTranscript(entries)) {
      if (failed) {
        results.push({ transcript_path: transcriptPath, result: { ok: false, deferred: true } });
        continue;
      }
      const result = runImporter(transcriptPath, false, group[0].filePath, env);
      results.push({ transcript_path: transcriptPath, result });
      if (result.ok) {
        for (const entry of group) await fsp.unlink(entry.filePath).catch(() => {});
      } else {
        failed = true;
        await logLine(`TARGET_DRAIN_FAILED ${target.id} ${transcriptPath} ${result.error || ""}`).catch(() => {});
      }
    }
    summaries.push({ id: target.id, ok: !failed, drained_paths: results.filter((item) => item.result.ok).length, results });
  }
  return summaries;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Whether new turns wait for the past conversations still going in. The run that
 * holds them keeps its pid in the hold file. One that is gone left the command that
 * carries it on from where it stopped, and the first turn after that starts it
 * again. A hold setup placed for a run that never started lapses after 30 minutes.
 */
async function holding() {
  if (!HOLD_PATH) return false;
  let hold;
  try {
    hold = JSON.parse(await fsp.readFile(HOLD_PATH, "utf8"));
  } catch {
    return false;
  }
  if (!hold || typeof hold !== "object") return false;
  if (alive(Number(hold.pid))) return true;
  if (Array.isArray(hold.resume) && hold.resume.length && hold.resume.every((part) => typeof part === "string")) {
    // The app that held them is gone (removed, or moved by an update): nothing would carry the run on.
    if (hold.resume[1] && !fs.existsSync(hold.resume[1])) {
      await fsp.rm(HOLD_PATH, { force: true }).catch(() => {});
      return false;
    }
    const resumed = Date.parse(hold.resumedAt || "");
    if (!(Number.isFinite(resumed) && Date.now() - resumed < RESUME_EVERY_MS)) {
      await fsp.writeFile(HOLD_PATH, JSON.stringify({ ...hold, resumedAt: utcNow() }, null, 2), "utf8").catch(() => {});
      try {
        const child = spawn(hold.resume[0], hold.resume.slice(1), { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
        child.on("error", () => {});
        child.unref();
        await logLine(`PAST_RESUMED ${hold.resume.slice(1).join(" ")}`).catch(() => {});
      } catch (error) {
        await logLine(`PAST_RESUME_FAILED ${error?.message || error}`).catch(() => {});
      }
    }
    return true;
  }
  const at = Date.parse(hold.at || "");
  if (Number.isFinite(at) && Date.now() - at < SETUP_HOLD_MS) return true;
  await fsp.rm(HOLD_PATH, { force: true }).catch(() => {});
  return false;
}

function pendingAgeSeconds(entry) {
  const createdMs = Date.parse(entry.createdAt || "");
  if (!Number.isFinite(createdMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
}

async function main() {
  const args = parseArgs();
  const hookInput = args.drain || args.drainIfDue ? {} : await readHookInput();
  const transcriptPath = pickTranscriptPath(args, hookInput);
  let dryRunEntry = null;

  if (!args.drain && !args.drainIfDue) {
    if (!transcriptPath) return { ok: true, skipped: "no transcript_path" };
    if (args.dryRun) {
      dryRunEntry = {
        filePath: null,
        transcriptPath,
        createdAt: utcNow(),
      };
    } else {
      await enqueue(transcriptPath, hookInput);
    }
  }

  const mode = detectMode(args.mode);
  // Held for the past conversations: the turn waits in the spool, and only the other
  // servers, which the past conversations never go to, are drained.
  if (!args.dryRun && (await holding())) {
    const targets = TARGETS.length ? await withDrainLock(async () => ({ ok: true, targets: await drainTargets() })) : null;
    return {
      ok: true,
      mode,
      held: true,
      queued: (await readPendingEntries()).length,
      ...(targets?.targets?.length ? { targets_ok: targets.targets.every((item) => item.ok), targets: targets.targets } : {}),
    };
  }
  if (args.drainIfDue && mode !== "external") {
    return {
      ok: true,
      mode,
      skipped: "drain-if-due only runs on external network",
    };
  }

  const threshold = mode === "internal" ? INTERNAL_BATCH_SIZE : EXTERNAL_BATCH_SIZE;
  const pending = await readPendingEntries();
  const effectivePending = dryRunEntry ? [...pending, dryRunEntry] : pending;
  const oldestPendingAgeSeconds = effectivePending.reduce((max, entry) => Math.max(max, pendingAgeSeconds(entry)), 0);
  const shouldDrain =
    args.drain ||
    effectivePending.length >= threshold ||
    (args.drainIfDue && effectivePending.length > 0 && oldestPendingAgeSeconds >= MAX_DELAY_SECONDS);

  if (!shouldDrain) {
    return {
      ok: true,
      mode,
      queued: effectivePending.length,
      threshold,
      oldest_pending_age_seconds: oldestPendingAgeSeconds,
      max_delay_seconds: MAX_DELAY_SECONDS,
    };
  }

  const drained = await withDrainLock(() => drainPending(args.dryRun, dryRunEntry ? [dryRunEntry] : []));
  return {
    ok: drained.ok,
    mode,
    queued_before: effectivePending.length,
    threshold,
    oldest_pending_age_seconds: oldestPendingAgeSeconds,
    max_delay_seconds: MAX_DELAY_SECONDS,
    ...drained,
  };
}

const quiet = process.env.HONCHO_CODEX_GATE_QUIET !== "0";
try {
  const result = await main();
  await logLine(JSON.stringify(result));
  if (!quiet) console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const result = { ok: false, error: String(error?.message || error) };
  await logLine(JSON.stringify(result)).catch(() => {});
  if (!quiet) console.error(JSON.stringify(result));
  process.exitCode = 1;
}
