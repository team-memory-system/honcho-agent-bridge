import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPOOL_ROOT = expandHome(process.env.HONCHO_CODEX_GATE_SPOOL || "~/.hermes/spool/codex-honcho");
const PENDING_DIR = path.join(SPOOL_ROOT, "pending");
const LOG_PATH = expandHome(process.env.HONCHO_CODEX_GATE_LOG || "~/.hermes/logs/codex-honcho-turn-gate.log");
const IMPORTER_PATH = expandHome(process.env.HONCHO_CODEX_IMPORTER || path.join(SCRIPT_DIR, "collector.mjs"));
const IMPORTER_EXEC = process.env.HONCHO_CODEX_IMPORTER_EXEC || "";
const INTERNAL_BATCH_SIZE = numberEnv("HONCHO_CODEX_INTERNAL_BATCH_SIZE", 1);
const EXTERNAL_BATCH_SIZE = numberEnv("HONCHO_CODEX_EXTERNAL_BATCH_SIZE", 10);
const LOCK_STALE_MS = numberEnv("HONCHO_CODEX_GATE_LOCK_STALE_MS", 120_000);
const MAX_DELAY_SECONDS = numberEnv("HONCHO_CODEX_GATE_MAX_DELAY_SECONDS", 300);
const DEFAULT_HONCHO_BASE_URL = "http://127.0.0.1:8001";

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
    HONCHO_CODEX_QUIET: "0",
    HONCHO_CODEX_DREAM_EVERY_MESSAGES: "0",
  };

  env.HONCHO_BASE_URL = env.HONCHO_BASE_URL || windowsUserEnv("HONCHO_BASE_URL") || DEFAULT_HONCHO_BASE_URL;
  const token = env.HONCHO_API_BEARER_TOKEN || windowsUserEnv("HONCHO_API_BEARER_TOKEN");
  if (token) env.HONCHO_API_BEARER_TOKEN = token;
  return env;
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

async function enqueue(transcriptPath, hookInput = {}) {
  await fsp.mkdir(PENDING_DIR, { recursive: true });
  const id = `${utcNow().replace(/[^0-9A-Za-z]+/g, "-")}-${crypto.randomUUID()}`;
  const tmpPath = path.join(PENDING_DIR, `${id}.tmp`);
  const finalPath = path.join(PENDING_DIR, `${id}.json`);
  const entry = {
    transcript_path: transcriptPath,
    created_at: utcNow(),
  };
  if (process.env.HONCHO_GATE_PASS_HOOK_INPUT === "1") {
    entry.hook_input = hookInput;
  }
  await fsp.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf8");
  await fsp.rename(tmpPath, finalPath);
  return finalPath;
}

async function readPendingEntries() {
  await fsp.mkdir(PENDING_DIR, { recursive: true });
  const files = await fsp.readdir(PENDING_DIR);
  const entries = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const filePath = path.join(PENDING_DIR, file);
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

function importerCommand() {
  if (IMPORTER_EXEC) return { command: IMPORTER_EXEC, args: [IMPORTER_PATH] };
  if (IMPORTER_PATH.endsWith(".py")) return { command: "/usr/bin/python3", args: [IMPORTER_PATH] };
  return { command: process.execPath, args: [IMPORTER_PATH] };
}

function runImporter(transcriptPath, dryRun, hookInputFile = "") {
  const importer = importerCommand();
  const args = [...importer.args, "--rollout", transcriptPath];
  if (dryRun) args.push("--dry-run");
  if (process.env.HONCHO_GATE_PASS_HOOK_INPUT === "1" && hookInputFile) {
    args.push("--hook-input-file", hookInputFile);
  }
  const result = spawnSync(importer.command, args, { encoding: "utf8", env: importerEnv() });
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

async function drainPending(dryRun, extraEntries = []) {
  const entries = [...(await readPendingEntries()), ...extraEntries];
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.transcriptPath) || [];
    group.push(entry);
    groups.set(entry.transcriptPath, group);
  }

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

  return {
    ok: results.every((item) => item.result.ok),
    drained_paths: results.length,
    results,
  };
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
