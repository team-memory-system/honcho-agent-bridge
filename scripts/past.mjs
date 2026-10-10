// 지난 대화: the conversations from before this computer collected, put into its
// own memory server in the order they started, so its memory forms in time order.
//
// They come from up to three places, chosen in setup's 지난 대화 step:
//   - this computer: the Claude Code and Codex transcripts on its disk (always);
//   - the backup store: what the conversation backup (backup.mjs) copied there from
//     every computer of this person, a folder read in place or a cloud copied down
//     through rclone first;
//   - ChatGPT exports, one file per account, each conversation kept on its own.
// The same conversation found in two places goes in once, from the larger copy.
//
// Before anything goes in, the server is asked which of them it holds already. One
// it holds is left out, unless a copy here has turns after the server's last one:
// that one goes in its place, and the collector sends only what the server lacks. A
// conversation that started before the newest one on the server is late: it can
// still go in, but the memory then forms out of order (rederive.mjs puts that right).
//
// While they go in, new turns are held (queue.mjs reads the hold file) and go after
// them. The run keeps a ledger, so a stop or a restart carries on where it left off,
// and the conversations that failed can be tried again.
//
// Everything is kept in <dataDir>/past/:
//   scan-here.json, scan-store.json   what each place holds, cached per file by size and time
//   scan-request.json, scan-status.json, scan.lock   the scan running in the background
//   store/                            a cloud store's transcripts, copied down
//   chatgpt/<id>.json, chatgpt/<id>/  an export: its account, and its conversations one per file
//   sources.json                      the places chosen at the last 적용
//   server-index.json                 what the server held at the last look
//   plan.json                         the conversations to put in, in order
//   ledger.jsonl                      what became of each, one line each, the last line winning
//   status.json, run.lock, stop       the run
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { headLines } from "./backup-sources.mjs";
import { ROOT_FOLDER, locateRclone, rcloneMessage, runRclone } from "./backup-store.mjs";
import { deviceOf, readSettings } from "./backup.mjs";
import {
  collectAutomation,
  collectFolders,
  configEnvironment,
  holdPath,
  installPaths,
  loadConfig,
  readJson,
  userHome,
} from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { configuredAccess, environmentAccess, fetchHoncho, honchoHeaders, isCloudflareAccessBlock } from "./honcho-access.mjs";
import { projectFolder, systemTempFolders, transcriptFiles } from "./projects.mjs";
import { automationRecord } from "./providers/automation.mjs";
import { readConversations, readExportAccount } from "./providers/chatgpt-archive.mjs";
import { parseConversation } from "./providers/chatgpt.mjs";
import { parseLines as claudeLines } from "./providers/claude.mjs";
import { parseLines as codexLines } from "./providers/codex.mjs";
import { sanitizeId } from "./providers/shared.mjs";
import { publicUrl, sanitizeUrlsInText } from "./redact.mjs";
import { countPending, outsideCollectFolders, withoutTargetFilter } from "./targets.mjs";
import { codexSegmentId } from "./turn-identity.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS = ["claude", "codex"];
const HOLD_PROVIDERS = ["claude", "codex", "agy", "grok"];
// A Claude Code transcript can open with long lines before the first that names its folder.
const HEAD_BYTES = 1024 * 1024;
// The last turn is looked for in the file's last 128 KB, then its last 2 MB.
const TAIL_SPANS = [128 * 1024, 2 * 1024 * 1024];
// The head is handed to the collector's parser this many lines at a time, until it makes a message of one.
const HEAD_CHUNK_LINES = 32;
// Bumped when what a catalog item says of its file changes, so the items read before are read again.
const ITEM_VERSION = 3;
const PARSE_LINES = { claude: claudeLines, codex: codexLines };
const CONCURRENCY = 16;
// A turn here this much after the server's last one is a turn the server lacks.
const NEWER_SLACK_MS = 1000;
// Network failures in a row after which the run stops and keeps the rest for later.
const MAX_UNREACHABLE = 3;
const STATUS_EVERY_MS = 2000;
// How often a store's read looks whether another store was asked for meanwhile.
const REQUEST_EVERY_MS = 1000;
const INDEX_FRESH_MS = 3 * 60_000;
const ID_BATCH = 100;
// Seconds one conversation takes to go in, for the estimate shown before a run:
// to this computer's own server, and to one elsewhere.
const SECONDS_LOCAL = 0.1;
const SECONDS_REMOTE = 0.35;
// The collector's HTTP timeout for this run: a batch of 100 messages to a server
// across the internet takes longer than a hook's single turn.
const HTTP_TIMEOUT_SECONDS = "60";

export const SOURCE_HERE = "here";
export const SOURCE_STORE = "store";

// ------------------------------------------------------------------ files

export function pastPaths(config) {
  const { dataDir, runtimeDir } = installPaths(config);
  const dir = path.join(dataDir, "past");
  return {
    dir,
    sources: path.join(dir, "sources.json"),
    scanHere: path.join(dir, "scan-here.json"),
    scanStore: path.join(dir, "scan-store.json"),
    scanRequest: path.join(dir, "scan-request.json"),
    scanStatus: path.join(dir, "scan-status.json"),
    scanLock: path.join(dir, "scan.lock"),
    storeCache: path.join(dir, "store"),
    chatgpt: path.join(dir, "chatgpt"),
    stage: path.join(dir, "stage"),
    serverIndex: path.join(dir, "server-index.json"),
    plan: path.join(dir, "plan.json"),
    ledger: path.join(dir, "ledger.jsonl"),
    status: path.join(dir, "status.json"),
    lock: path.join(dir, "run.lock"),
    stop: path.join(dir, "stop"),
    hold: holdPath(config),
    spool: path.join(dataDir, "spool"),
    state: path.join(dataDir, "state"),
    logs: path.join(dataDir, "logs"),
    dataDir,
    runtimeDir,
  };
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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

function digest(text, length = 16) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, length);
}

function timeOf(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function exists(filePath) {
  return fsp.access(filePath).then(() => true, () => false);
}

// ------------------------------------------------------------------ transcripts

function parseRecord(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The name a transcript had where its agent wrote it. A backup copy kept beside
 * another version of the same file carries that computer's device id (and a hash)
 * after the first dot (backup-sources.mjs taggedName); agents' own names have none.
 */
export function originalName(file) {
  const base = path.basename(file);
  const dot = base.indexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}.jsonl` : base;
}

/**
 * When the turns the collector makes messages of (providers/*.mjs) in `lines` were:
 * the earliest and the latest, as the server will date the messages. Nulls when
 * none of the lines is one.
 */
function turnTimes(provider, lines, file) {
  let first = null;
  let last = null;
  for (const turn of PARSE_LINES[provider](lines, file).turns) {
    const at = timeOf(turn.created_at);
    if (at === null) continue;
    if (first === null || at < first) first = at;
    if (last === null || at > last) last = at;
  }
  return { first, last };
}

/**
 * What a transcript's first lines say: its session id, the folder it ran in, whether
 * no person took part in it (providers/automation.mjs), and when it started. It
 * started with its first message as the collector makes it (`start`), not its first
 * line (`opened`): a session opened with /clear, a hook's output or another
 * session's note says something before anyone does, and the server dates the
 * conversation by its first message. `start` is null when no line read is a message.
 */
async function readHead(provider, file) {
  const head = { sessionId: null, start: null, opened: null, cwd: null, auto: false };
  let named = false;
  let pending = [];
  for await (const line of headLines(file, HEAD_BYTES)) {
    pending.push(line);
    if (pending.length >= HEAD_CHUNK_LINES) {
      head.start = turnTimes(provider, pending, file).first;
      pending = [];
      if (head.start !== null && named) break;
    }
    if (named) continue;
    const record = parseRecord(line);
    if (!record) continue;
    head.opened ??= timeOf(record.timestamp);
    if (provider === "codex") {
      // session_meta names the session (codex.mjs); a 2025 rollout opens with a bare header instead.
      if (record.type === "session_meta" && record.payload && typeof record.payload === "object") {
        const meta = record.payload;
        head.sessionId = typeof meta.id === "string" && meta.id ? meta.id : null;
        head.cwd = typeof meta.cwd === "string" && meta.cwd ? meta.cwd : null;
        head.opened = timeOf(meta.timestamp) ?? timeOf(record.timestamp) ?? head.opened;
        head.auto = Boolean(automationRecord("codex", record));
        named = true;
      }
      continue;
    }
    if (!head.sessionId && typeof record.sessionId === "string" && record.sessionId) head.sessionId = record.sessionId;
    if (!head.cwd && typeof record.cwd === "string" && record.cwd) {
      head.cwd = record.cwd;
      head.auto = Boolean(automationRecord("claude", record));
    }
    named = Boolean(head.sessionId && head.cwd);
  }
  if (head.start === null && pending.length) head.start = turnTimes(provider, pending, file).first;
  return head;
}

/** When the transcript's last message was, from its end; the last time it records when no message is near the end. */
async function readLastTurn(provider, file, size) {
  const handle = await fsp.open(file, "r");
  try {
    let fallback = null;
    for (const span of TAIL_SPANS) {
      const length = Math.min(span, size);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      // The first line of a span that starts mid-file is cut.
      if (length < size) lines.shift();
      const { last } = turnTimes(provider, lines, file);
      if (last !== null) return last;
      for (let index = lines.length - 1; index >= 0 && fallback === null; index -= 1) {
        const record = parseRecord(lines[index]);
        fallback = record ? timeOf(record.timestamp) : null;
      }
      if (length >= size) break;
    }
    return fallback;
  } finally {
    await handle.close();
  }
}

/**
 * One transcript as the catalog keeps it. Its key is the session the collector would
 * write it to (`<provider>-<id>`, providers/*.mjs), and for a Codex continuation
 * segment the segment too, since every file of a thread carries the same id.
 */
async function transcriptItem(provider, file, from, cache) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }
  const cached = cache?.get(file);
  if (cached && cached.v === ITEM_VERSION && cached.size === stat.size && cached.mtime === stat.mtimeMs && cached.from === from) return cached;
  let head;
  let last;
  try {
    head = await readHead(provider, file);
    last = await readLastTurn(provider, file, stat.size);
  } catch {
    return null;
  }
  const name = originalName(file);
  const session = sanitizeId(head.sessionId || name, provider);
  const segment = provider === "codex" ? codexSegmentId(name, head.sessionId) : null;
  // Read to its end without a line the collector makes a message of: nothing to put in.
  const empty = head.start === null && stat.size <= HEAD_BYTES;
  return {
    v: ITEM_VERSION,
    key: `${provider}:${session}${segment ? `:${segment}` : ""}`,
    provider,
    session,
    start: head.start ?? head.opened ?? last ?? stat.mtimeMs,
    last: last ?? head.start ?? head.opened ?? stat.mtimeMs,
    cwd: head.cwd,
    auto: head.auto,
    ...(empty ? { empty: true } : {}),
    file,
    name,
    size: stat.size,
    mtime: stat.mtimeMs,
    from,
  };
}

async function readItems(files, from, cachePath, onProgress, signal = null) {
  const previous = await readJson(cachePath, null);
  const cache = new Map((previous?.items || []).map((item) => [item.file, item]));
  let done = 0;
  const items = await mapLimit(files, CONCURRENCY, async ({ provider, file }) => {
    if (signal?.aborted) return null;
    const item = await transcriptItem(provider, file, from, cache);
    done += 1;
    if (done % 250 === 0) await onProgress?.(done, files.length);
    return item;
  });
  return items.filter(Boolean);
}

/** The counts a place shows before it is chosen: conversations, from when, and by which agent. */
function sourceSummary(items) {
  const people = items.filter((item) => !item.auto && !item.empty);
  const agents = {};
  let first = null;
  for (const item of people) {
    agents[item.provider] = (agents[item.provider] || 0) + 1;
    if (item.start && (first === null || item.start < first)) first = item.start;
  }
  return { count: new Set(people.map((item) => item.key)).size, automation: items.filter((item) => item.auto && !item.empty).length, first, agents };
}

// ------------------------------------------------------------------ this computer

async function hereFiles(config) {
  const files = [];
  for (const provider of PROVIDERS) {
    for (const file of await transcriptFiles(config, provider)) {
      // Claude Code 1.x kept a subagent's transcript beside its session; it is part of that session.
      if (provider === "claude" && path.basename(file).startsWith("agent-")) continue;
      files.push({ provider, file });
    }
  }
  return files;
}

async function scanHere(config, paths, onProgress) {
  const files = await hereFiles(config);
  await onProgress?.(0, files.length);
  const items = await readItems(files, SOURCE_HERE, paths.scanHere, onProgress);
  const scanned = { version: 1, at: new Date().toISOString(), items };
  await writeJson(paths.scanHere, scanned);
  return scanned;
}

// ------------------------------------------------------------------ the backup store

/** A store as setup names it: `{ kind: "folder", path }` or `{ kind: "cloud", remote, path }`; null when it names none. */
export function storeSpec(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "folder") {
    const folder = typeof value.path === "string" ? value.path.trim() : "";
    return folder && path.isAbsolute(folder) && !/[\r\n]/.test(folder) ? { kind: "folder", path: path.resolve(folder) } : null;
  }
  if (value.kind === "cloud") {
    const remote = typeof value.remote === "string" ? value.remote.trim() : "";
    const folder = typeof value.path === "string" ? value.path.trim().replace(/^\/+|\/+$/g, "") : "";
    if (!/^[A-Za-z0-9_][A-Za-z0-9_ .+@-]{0,63}$/.test(remote)) return null;
    if (folder && folder.split("/").some((part) => !part || part === "." || part === "..")) return null;
    return { kind: "cloud", remote, path: folder };
  }
  return null;
}

export function sameStore(left, right) {
  const a = storeSpec(left);
  const b = storeSpec(right);
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.path === b.path && (a.kind !== "cloud" || a.remote === b.remote);
}

/** What the screens call a store: the 대화 folder in it. */
export function storeLabel(spec) {
  if (!spec) return "";
  if (spec.kind === "folder") return path.join(spec.path, ROOT_FOLDER);
  return `${spec.remote}:${spec.path ? `${spec.path}/` : ""}${ROOT_FOLDER}`;
}

/** The transcripts under a store's 대화 folder: agents' main conversations, never _아카이브, _부속자료 or other _ folders. */
async function storeFiles(root) {
  const found = [];
  for (const provider of PROVIDERS) {
    const stack = [path.join(root, provider)];
    while (stack.length) {
      const directory = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".partial")) {
          if (provider === "codex" && !entry.name.startsWith("rollout-")) continue;
          if (provider === "claude" && entry.name.startsWith("agent-")) continue;
          found.push({ provider, file: full });
        }
      }
    }
  }
  return found;
}

/** The computers that back up there: each keeps its own history under _부속자료/<device>. */
async function storeDevices(root) {
  const devices = new Set();
  for (const provider of PROVIDERS) {
    try {
      for (const entry of await fsp.readdir(path.join(root, provider, "_부속자료"), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "projects" && !entry.name.startsWith(".")) devices.add(entry.name);
      }
    } catch {}
  }
  return [...devices].sort();
}

async function countFiles(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) count += 1;
    }
  }
  return count;
}

// rclone takes the agents' transcripts and leaves out every _ folder (_아카이브,
// _부속자료, _원본버전) and anything that is not a transcript.
const RCLONE_FILTERS = ["--filter", "- _*/**", "--filter", "- .*", "--filter", "+ *.jsonl", "--filter", "- *"];

class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Another store was asked for while this one was being read: the read stops there. */
function stopIfMoved(signal) {
  if (signal?.aborted) throw new ScanError("moved", "another store was asked for");
}

/**
 * A cloud store copied down into the cache, agent by agent: the list first, so the
 * screen can show how far the copy has got. rclone copies only what changed since
 * the last time.
 */
async function copyCloudStore(spec, cacheRoot, onProgress, { env = process.env, signal = null } = {}) {
  const binary = locateRclone(env);
  if (!binary) throw new ScanError("rclone-missing", "rclone is not installed on this computer");
  const run = async (args, options) => {
    const result = await runRclone(binary, args, { ...options, env, signal });
    stopIfMoved(signal);
    return result;
  };
  const base = `${spec.remote}:${spec.path ? `${spec.path}/` : ""}${ROOT_FOLDER}`;
  const missing = (result) => /directory not found|not found/i.test(result.stderr || "");
  let total = 0;
  const present = [];
  for (const provider of PROVIDERS) {
    await onProgress({ phase: "list", done: 0, total: 0 });
    const listed = await run(["lsjson", "-R", "--files-only", "--no-modtime", "--no-mimetype", "--fast-list", ...RCLONE_FILTERS, `${base}/${provider}`], { timeoutMs: 3_600_000 });
    if (listed.code !== 0) {
      if (missing(listed)) continue;
      throw new ScanError("rclone-failed", rcloneMessage(listed, "rclone lsjson"));
    }
    let files = [];
    try { files = JSON.parse(listed.stdout || "[]"); } catch {}
    total += files.length;
    present.push(provider);
  }
  if (!present.length) throw new ScanError("no-store", `${base} holds no conversations`);
  const startedAt = Date.now();
  const before = await countFiles(cacheRoot);
  const report = async () => {
    const done = Math.min(total, await countFiles(cacheRoot));
    const copied = Math.max(0, done - before);
    const rate = copied / Math.max(1, (Date.now() - startedAt) / 1000);
    await onProgress({ phase: "copy", done, total, etaSec: rate > 0 ? Math.round((total - done) / rate) : null });
  };
  await report();
  for (const provider of present) {
    const timer = setInterval(() => { report().catch(() => {}); }, STATUS_EVERY_MS);
    let result;
    try {
      result = await run(["copy", "--fast-list", "--transfers", "8", "--checkers", "16", ...RCLONE_FILTERS, `${base}/${provider}`, path.join(cacheRoot, provider)], { timeoutMs: 24 * 3_600_000 });
    } finally {
      clearInterval(timer);
    }
    if (result.code !== 0) throw new ScanError("rclone-failed", rcloneMessage(result, "rclone copy"));
  }
  await report();
  const devices = new Set();
  for (const provider of present) {
    const listed = await run(["lsf", "--dirs-only", `${base}/${provider}/_부속자료`], { timeoutMs: 120_000 });
    if (listed.code !== 0) continue;
    for (const line of listed.stdout.split(/\r?\n/)) {
      const name = line.trim().replace(/\/$/, "");
      if (name && name !== "projects") devices.add(name);
    }
  }
  return { total, devices: [...devices].sort() };
}

async function scanStore(spec, paths, onProgress, signal = null) {
  let root;
  let devices;
  if (spec.kind === "folder") {
    root = path.join(spec.path, ROOT_FOLDER);
    try {
      if (!(await fsp.stat(root)).isDirectory()) throw new Error();
    } catch {
      throw new ScanError("no-store", `${root} is not a folder this computer can read`);
    }
    devices = await storeDevices(root);
  } else {
    root = path.join(paths.storeCache, digest(storeLabel(spec)));
    await fsp.mkdir(root, { recursive: true });
    ({ devices } = await copyCloudStore(spec, root, onProgress, { signal }));
  }
  stopIfMoved(signal);
  const files = await storeFiles(root);
  await onProgress({ phase: "read", done: 0, total: files.length });
  const items = await readItems(files, SOURCE_STORE, paths.scanStore, (done, total) => onProgress({ phase: "read", done, total }), signal);
  stopIfMoved(signal);
  const scanned = { version: 1, at: new Date().toISOString(), spec, label: storeLabel(spec), complete: true, devices, items };
  await writeJson(paths.scanStore, scanned);
  return scanned;
}

// ------------------------------------------------------------------ the scan in the background

/**
 * Starts reading the places setup chose, in the background, and says how far each
 * has got. `store` is the backup store to read (null for none); asked again with
 * another store, the running scan stops reading the one before (its rclone too) and
 * moves on to it. This computer is read every time.
 */
export async function pastScan(config, { store = null } = {}) {
  const paths = pastPaths(config);
  const spec = storeSpec(store);
  await writeJson(paths.scanRequest, { version: 1, store: spec, at: new Date().toISOString() });
  const status = await readJson(paths.scanStatus, {});
  const running = alive(Number(status?.pid)) && status?.running;
  if (!running) {
    await writeJson(paths.scanStatus, { ...status, running: true, pid: null, startedAt: new Date().toISOString() });
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "cli.mjs"), "past", "scan-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
  }
  return pastScanStatus(config);
}

/**
 * The background scan: this computer, then the store asked for, again while the
 * request changes. A store read while another is asked for stops at once.
 */
export async function pastScanRun(config) {
  const paths = pastPaths(config);
  const lock = await acquireFileLock(paths.scanLock, { staleMs: 6 * 3_600_000, reclaimDeadImmediately: true });
  if (!lock) return { ok: true, busy: true };
  let status = await readJson(paths.scanStatus, {});
  const save = async (fields) => {
    status = { ...status, ...fields, pid: process.pid, at: new Date().toISOString() };
    await writeJson(paths.scanStatus, status);
  };
  try {
    await save({ running: true, startedAt: new Date().toISOString() });
    for (let round = 0; round < 10; round += 1) {
      const request = await readJson(paths.scanRequest, { store: null });
      let lastWrite = 0;
      const progress = (part, fields) => {
        const now = Date.now();
        if (now - lastWrite < 1000 && fields.done !== fields.total) return Promise.resolve();
        lastWrite = now;
        return save({ [part]: { ...(status[part] || {}), ...fields, state: "running" } });
      };
      try {
        await save({ here: { state: "running", done: 0, total: 0 } });
        const here = await scanHere(config, paths, (done, total) => progress("here", { done, total }));
        await save({ here: { state: "done", done: here.items.length, total: here.items.length, ...sourceSummary(here.items), at: here.at } });
      } catch (error) {
        await save({ here: { state: "error", error: String(error?.message || error) } });
      }
      const spec = storeSpec(request.store);
      if (spec) {
        const label = storeLabel(spec);
        const moved = new AbortController();
        const watch = setInterval(() => {
          readJson(paths.scanRequest, { store: null }).then((now) => { if (!sameStore(now.store, request.store)) moved.abort(); }).catch(() => {});
        }, REQUEST_EVERY_MS);
        try {
          await save({ store: { spec, label, state: "running", phase: "list", done: 0, total: 0 } });
          const scanned = await scanStore(spec, paths, (fields) => (moved.signal.aborted ? Promise.resolve() : progress("store", { spec, label, ...fields })), moved.signal);
          await save({ store: { spec, label, state: "done", phase: "done", done: scanned.items.length, total: scanned.items.length, devices: scanned.devices, ...sourceSummary(scanned.items), at: scanned.at } });
        } catch (error) {
          // Left for the store asked for since: nothing to say about this one.
          if (error?.code === "moved") await save({ store: null });
          else await save({ store: { spec, label, state: "error", code: error?.code || "failed", error: sanitizeUrlsInText(String(error?.message || error)) } });
        } finally {
          clearInterval(watch);
        }
      } else {
        await save({ store: null });
      }
      const now = await readJson(paths.scanRequest, { store: null });
      if (sameStore(now.store, request.store)) break;
    }
  } finally {
    await save({ running: false });
    await releaseFileLock(lock);
  }
  return { ok: true, here: status.here || null, store: status.store || null };
}

/** How far the scan has got, and the ChatGPT files added so far. */
export async function pastScanStatus(config) {
  const paths = pastPaths(config);
  const status = await readJson(paths.scanStatus, {});
  const request = await readJson(paths.scanRequest, { store: null });
  // A scan that stopped half way (the app closed) is running no more.
  const running = Boolean(status?.running) && (status.pid === null ? Date.now() - (timeOf(status.startedAt) || 0) < 60_000 : alive(Number(status.pid)));
  const store = status?.store && sameStore(status.store.spec, request.store) ? status.store : null;
  const fix = (part) => (part && part.state === "running" && !running ? { ...part, state: "error", error: "the scan stopped" } : part);
  const applied = new Set((await readJson(paths.sources, null))?.chatgpt || []);
  return {
    ok: true,
    running,
    here: fix(status?.here || null),
    store: request.store ? fix(store) || { spec: request.store, label: storeLabel(request.store), state: running ? "running" : "waiting" } : null,
    chatgpt: (await chatgptFiles(paths)).map((file) => ({ ...file, applied: applied.has(file.id) })),
    device: deviceOf(await readSettings(installPaths(config).dataDir).catch(() => null)),
  };
}

// ------------------------------------------------------------------ ChatGPT exports

/** A newer copy of the same conversation: updated later, or as late with more turns (chatgpt.mjs). */
function newerConversation(candidate, existing) {
  const a = candidate.metadata.updated_at || "";
  const b = existing.metadata.updated_at || "";
  if (a !== b) return a > b;
  return candidate.turns.length > existing.turns.length;
}

function chatgptRecordPath(paths, id) {
  return path.join(paths.chatgpt, `${id}.json`);
}

/** The ChatGPT files added, newest first, without their conversations. */
async function chatgptFiles(paths) {
  let names = [];
  try {
    names = (await fsp.readdir(paths.chatgpt)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const record = await readJson(path.join(paths.chatgpt, name), null);
    if (!record?.id) continue;
    const { items, ...rest } = record;
    records.push(rest);
  }
  return records.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

/**
 * A ChatGPT export, read and kept one conversation per file. One file per account:
 * a newer export of the same account (its user.json says whose it is) takes the
 * place of the older one, which it holds all of. Returns what the file holds.
 */
export async function addChatGpt(config, sourceFile, displayName = path.basename(sourceFile)) {
  const paths = pastPaths(config);
  const account = await readExportAccount(sourceFile);
  const { size } = await fsp.stat(sourceFile);
  const id = account ? `a-${digest(account.toLowerCase(), 12)}` : `f-${digest(`${displayName}:${size}:${Date.now()}`, 12)}`;
  const directory = path.join(paths.chatgpt, id);
  const temporary = `${directory}.tmp-${process.pid}`;
  await fsp.rm(temporary, { recursive: true, force: true });
  await fsp.mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const kept = new Map();
    let read = 0;
    let unreadable = 0;
    for await (const { conversation } of readConversations(sourceFile, {})) {
      read += 1;
      let parsed;
      try {
        parsed = parseConversation(conversation);
      } catch {
        unreadable += 1;
        continue;
      }
      const existing = kept.get(parsed.session_id);
      if (existing && !newerConversation(parsed, existing.parsed)) continue;
      kept.set(parsed.session_id, { parsed, conversation });
    }
    if (!read) throw new Error("no ChatGPT conversations in this file");
    const items = [];
    let empty = 0;
    let first = null;
    let last = null;
    for (const [session, { parsed, conversation }] of kept) {
      if (!parsed.turns.length) {
        empty += 1;
        continue;
      }
      const text = JSON.stringify([conversation]);
      await fsp.writeFile(path.join(temporary, `${session}.json`), text, { mode: 0o600 });
      const times = parsed.turns.map((turn) => timeOf(turn.created_at)).filter((value) => value !== null);
      const start = times.length ? Math.min(...times) : timeOf(parsed.metadata.created_at);
      const end = times.length ? Math.max(...times) : start;
      if (start !== null && (first === null || start < first)) first = start;
      if (end !== null && (last === null || end > last)) last = end;
      items.push({
        key: `chatgpt:${session}`,
        provider: "chatgpt",
        session,
        start,
        last: end,
        cwd: null,
        auto: false,
        file: path.join(directory, `${session}.json`),
        name: `${session}.json`,
        size: Buffer.byteLength(text),
        from: `chatgpt:${id}`,
      });
    }
    await fsp.rm(directory, { recursive: true, force: true });
    await fsp.rename(temporary, directory);
    const record = {
      version: 1,
      id,
      name: displayName,
      size,
      account,
      conversations: items.length,
      empty,
      unreadable,
      first,
      last,
      addedAt: new Date().toISOString(),
      items,
    };
    await writeJson(chatgptRecordPath(paths, id), record);
    const { items: _items, ...summary } = record;
    return { ok: true, file: summary };
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Takes back a ChatGPT file not yet put in; one that went in stays, as its conversations did. */
export async function dropChatGpt(config, id) {
  const paths = pastPaths(config);
  if (!/^[af]-[0-9a-f]{12}$/.test(String(id || ""))) return { ok: false, error: "no such ChatGPT file" };
  const sources = await readJson(paths.sources, null);
  if ((sources?.chatgpt || []).includes(id)) return { ok: false, error: "this file has already gone in" };
  await fsp.rm(path.join(paths.chatgpt, id), { recursive: true, force: true });
  await fsp.rm(chatgptRecordPath(paths, id), { force: true });
  return { ok: true };
}

// ------------------------------------------------------------------ the catalog

/** The places as chosen: `{ store, chatgpt: [ids] }`, `store` null for none. */
function chosenSources(value) {
  return {
    store: storeSpec(value?.store),
    chatgpt: Array.isArray(value?.chatgpt) ? [...new Set(value.chatgpt.filter((id) => /^[af]-[0-9a-f]{12}$/.test(String(id))))] : [],
  };
}

/**
 * Every conversation in the chosen places, once: the larger copy of one found in
 * more than one place, with `lost` naming the places whose copy was left. Throws
 * when a chosen place has not been read.
 */
async function loadCatalog(paths, sources) {
  const all = [];
  const here = await readJson(paths.scanHere, null);
  if (!here?.items) throw new ScanError("not-read", "this computer's conversations have not been read yet");
  all.push(...here.items);
  if (sources.store) {
    const scanned = await readJson(paths.scanStore, null);
    if (!scanned?.complete || !sameStore(scanned.spec, sources.store)) throw new ScanError("not-read", `${storeLabel(sources.store)} has not been read yet`);
    all.push(...scanned.items);
  }
  const accounts = {};
  for (const id of sources.chatgpt) {
    const record = await readJson(chatgptRecordPath(paths, id), null);
    if (!record?.items) throw new ScanError("not-read", "a ChatGPT file is missing; choose it again");
    accounts[`chatgpt:${id}`] = record.account || null;
    all.push(...record.items);
  }
  const byKey = new Map();
  for (const item of all) {
    // A transcript with nothing the collector makes a message of has nothing to put in.
    if (item.empty) continue;
    const copies = byKey.get(item.key);
    if (copies) copies.push(item);
    else byKey.set(item.key, [item]);
  }
  const catalog = [];
  for (const copies of byKey.values()) {
    // The larger copy has every turn the smaller one has (transcripts only grow);
    // between equal ones, the one on this computer.
    const best = copies.reduce((kept, copy) => (copy.size > kept.size || (copy.size === kept.size && copy.from === SOURCE_HERE && kept.from !== SOURCE_HERE) ? copy : kept));
    const starts = copies.map((copy) => copy.start).filter((value) => value !== null);
    const lasts = copies.map((copy) => copy.last).filter((value) => value !== null);
    catalog.push({
      ...best,
      start: starts.length ? Math.min(...starts) : best.start,
      last: lasts.length ? Math.max(...lasts) : best.last,
      lost: [...new Set(copies.filter((copy) => copy.from !== best.from).map((copy) => copy.from))],
      ...(best.provider === "chatgpt" ? { account: accounts[best.from] || null } : {}),
    });
  }
  catalog.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.key.localeCompare(b.key));
  return catalog;
}

// ------------------------------------------------------------------ the server

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** The configured server: its address, workspace and credentials. */
function configuredServer(config) {
  if (!config?.honcho?.baseUrl) return null;
  return {
    url: trimSlash(config.honcho.baseUrl),
    workspace: config.honcho.workspaceId || "memory",
    token: config.honcho.apiToken || "",
    access: configuredAccess(config),
  };
}

/**
 * The server a setup still being chosen names, with the token and Access service
 * token from the environment as setup takes them, or those saved for that same server.
 */
function draftServer(config, options, env = process.env) {
  const url = typeof options.honchoUrl === "string" && options.honchoUrl.trim() ? trimSlash(options.honchoUrl.trim()) : config?.honcho?.baseUrl;
  if (!url) return null;
  const same = config?.honcho?.baseUrl && sameOrigin(config.honcho.baseUrl, url);
  return {
    url,
    workspace: (typeof options.workspace === "string" && options.workspace.trim()) || config?.honcho?.workspaceId || "memory",
    token: String(env.HONCHO_API_TOKEN || "").trim() || (same ? config.honcho.apiToken || "" : ""),
    access: environmentAccess(env) || (same ? configuredAccess(config) : null),
  };
}

function isLocalUrl(url) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function honchoJson(server, apiPath, body = {}, timeoutMs = 60_000) {
  const response = await fetchHoncho(`${server.url}${apiPath}`, {
    method: "POST",
    headers: honchoHeaders({ token: server.token, access: server.access }, { "Content-Type": "application/json", Accept: "application/json" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (await isCloudflareAccessBlock(response)) throw Object.assign(new Error(`Cloudflare Access refused this computer at ${publicUrl(server.url)}`), { access: true });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} for ${apiPath}: ${text.slice(0, 300)}`), { status: response.status });
  return text ? JSON.parse(text) : {};
}

const ws = (server) => encodeURIComponent(server.workspace);

/** When a session's last message on the server was, or null when it has none. */
async function lastMessageAt(server, session) {
  const page = await honchoJson(server, `/v3/workspaces/${ws(server)}/sessions/${encodeURIComponent(session)}/messages/list?page=1&size=1&reverse=true`);
  return timeOf(page.items?.[0]?.created_at);
}

/**
 * What the server holds of `sessions`: for each one it has, the time of its last
 * turn as the collector recorded it (null when an older collector sent it), and the
 * newest turn the server holds anywhere, from those and its most recent sessions.
 * Asked again only once the last answer is a few minutes old.
 */
async function serverIndex(server, sessions, paths, { fresh = false } = {}) {
  const ids = [...new Set(sessions)].sort();
  const signature = digest(ids.join("\n"));
  const cached = await readJson(paths.serverIndex, null);
  if (!fresh && cached && cached.url === server.url && cached.workspace === server.workspace && cached.signature === signature
    && Date.now() - (timeOf(cached.at) || 0) < INDEX_FRESH_MS) {
    return { ...cached, sessions: new Map(cached.sessions) };
  }
  let total = 0;
  let newest = null;
  const found = new Map();
  const newer = (value) => {
    if (value !== null && value !== undefined && (newest === null || value > newest)) newest = value;
  };
  let recent;
  try {
    recent = await honchoJson(server, `/v3/workspaces/${ws(server)}/sessions/list?page=1&size=20&reverse=true`);
  } catch (error) {
    // A workspace nothing went to yet: an empty server.
    if (error.status !== 404) throw error;
    recent = { items: [], total: 0 };
  }
  total = Number(recent.total || 0);
  for (const session of recent.items || []) {
    newer(timeOf(session.metadata?.last_turn_at) ?? (await lastMessageAt(server, session.id).catch(() => null)));
  }
  if (total) {
    const batches = [];
    for (let index = 0; index < ids.length; index += ID_BATCH) batches.push(ids.slice(index, index + ID_BATCH));
    await mapLimit(batches, 4, async (batch) => {
      const page = await honchoJson(server, `/v3/workspaces/${ws(server)}/sessions/list?page=1&size=${ID_BATCH}`, { filters: { id: { in: batch } } });
      for (const session of page.items || []) {
        const last = timeOf(session.metadata?.last_turn_at);
        found.set(session.id, last);
        newer(last);
      }
    });
  }
  const index = { url: server.url, workspace: server.workspace, signature, at: new Date().toISOString(), total, newest, sessions: [...found] };
  await writeJson(paths.serverIndex, index).catch(() => {});
  return { ...index, sessions: found };
}

/**
 * What becomes of one conversation on a server with `index`: "new", "late" (new, and
 * older than the server's newest turn), "newer" (there, with turns here it lacks),
 * "check" (there, sent by a collector that did not record its last turn: asked when
 * its turn comes), or "server" (there already).
 */
/** A run found nothing to put in, and nothing came into the file since. */
function emptyBefore(item, before) {
  return before?.o === "empty" && !(item.last !== null && before.last !== undefined && item.last > (before.last ?? 0) + NEWER_SLACK_MS);
}

function placeOf(item, index) {
  if (!index) return "new";
  if (!index.sessions.has(item.session)) return index.newest !== null && item.start !== null && item.start < index.newest ? "late" : "new";
  const last = index.sessions.get(item.session);
  if (last === null || last === undefined) return "check";
  return item.last !== null && item.last > last + NEWER_SLACK_MS ? "newer" : "server";
}

// ------------------------------------------------------------------ what setup shows

function emptyStats() {
  return { count: 0, dupes: 0, here: 0, store: 0, onServer: 0, put: 0, late: 0, newer: 0, first: null, last: null, agents: {} };
}

function addStats(stats, item, place) {
  stats.count += 1;
  if (item.lost.length) stats.dupes += 1;
  if (item.from === SOURCE_HERE || item.lost.includes(SOURCE_HERE)) stats.here += 1;
  if (item.from === SOURCE_STORE || item.lost.includes(SOURCE_STORE)) stats.store += 1;
  stats.agents[item.provider] = (stats.agents[item.provider] || 0) + 1;
  if (place === "server" || place === "check") {
    stats.onServer += 1;
    return;
  }
  stats.put += 1;
  if (place === "late") stats.late += 1;
  if (place === "newer") stats.newer += 1;
  if (item.start !== null) {
    if (stats.first === null || item.start < stats.first) stats.first = item.start;
    if (stats.last === null || item.start > stats.last) stats.last = item.start;
  }
}

/**
 * The projects step's numbers, before anything is applied: every folder the chosen
 * places' conversations ran in, grouped by project as the folder list groups them
 * (projects.mjs), with how many each holds, how many are on the server already, how
 * many would go in and how many of those are late. Conversations no person took part
 * in, those with no folder, and each ChatGPT file are counted apart. The server is
 * the one setup is choosing (`honchoUrl`), none yet for one it will make.
 */
export async function pastOverview(config, options = {}, env = process.env) {
  const paths = pastPaths(config);
  const sources = chosenSources(options);
  const agents = new Set(Array.isArray(options.agents) ? options.agents : PROVIDERS);
  let catalog;
  try {
    catalog = await loadCatalog(paths, sources);
  } catch (error) {
    if (error instanceof ScanError) return { ok: false, code: error.code, error: error.message };
    throw error;
  }
  // One a run found nothing in (the file was too long to tell before) is not offered again.
  const ledger = await readLedger(paths);
  catalog = catalog.filter((item) => (item.provider === "chatgpt" || agents.has(item.provider)) && !emptyBefore(item, ledger.get(item.key)));
  const server = options.newServer ? null : draftServer(config, options, env);
  let index = null;
  let serverError = null;
  if (server) {
    try {
      index = await serverIndex(server, catalog.map((item) => item.session), paths, { fresh: Boolean(options.fresh) });
    } catch (error) {
      serverError = { access: Boolean(error.access), status: error.status || null, error: sanitizeUrlsInText(String(error?.message || error)) };
    }
  }
  const home = path.resolve(userHome());
  const temps = systemTempFolders(home);
  const tempFolders = new Set(temps.map(([, folder]) => folder));
  const memo = new Map();
  const projectOf = new Map();
  const projects = new Map();
  const automation = emptyStats();
  const withoutFolder = emptyStats();
  const chatgpt = new Map();
  for (const item of catalog) {
    const place = placeOf(item, index);
    if (item.provider === "chatgpt") {
      if (!chatgpt.has(item.from)) chatgpt.set(item.from, { id: item.from.slice("chatgpt:".length), account: item.account || null, ...emptyStats() });
      addStats(chatgpt.get(item.from), item, place);
      continue;
    }
    if (item.auto) {
      addStats(automation, item, place);
      continue;
    }
    if (!item.cwd || (!path.isAbsolute(item.cwd) && !/^[A-Za-z]:[\\/]/.test(item.cwd))) {
      addStats(withoutFolder, item, place);
      continue;
    }
    if (!projectOf.has(item.cwd)) {
      projectOf.set(item.cwd, path.isAbsolute(item.cwd) ? await projectFolder(item.cwd, { home, temps, memo }).catch(() => null) : foreignProject(item.cwd));
    }
    const project = projectOf.get(item.cwd);
    if (!project) {
      addStats(withoutFolder, item, place);
      continue;
    }
    if (!projects.has(project)) {
      projects.set(project, {
        path: project,
        name: project === home ? "~" : project.split(/[\\/]/).filter(Boolean).pop() || project,
        // Only this computer's home reads as ~: another computer's folders keep their whole path.
        display: project === home ? "~" : project.startsWith(`${home}${path.sep}`) ? `~${project.slice(home.length)}` : project,
        temp: tempFolders.has(project),
        ...emptyStats(),
      });
    }
    addStats(projects.get(project), item, place);
  }
  const list = [...projects.values()].map((project) => ({ ...project, storeOnly: project.here === 0 && project.store > 0 }))
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0) || a.path.localeCompare(b.path));
  return {
    ok: true,
    server: server ? {
      url: publicUrl(server.url),
      reachable: Boolean(index),
      total: index?.total ?? null,
      newest: index?.newest ?? null,
      ...(serverError ? { problem: serverError } : {}),
    } : { url: null, reachable: false, total: 0, newest: null, new: true },
    projects: list,
    automation,
    withoutFolder,
    chatgpt: [...chatgpt.values()],
    secondsPerConversation: !server || isLocalUrl(server.url) ? SECONDS_LOCAL : SECONDS_REMOTE,
  };
}

/** A folder from another computer (a Windows path read on a Mac): the folder itself is its project. */
function foreignProject(cwd) {
  return /^[A-Za-z]:[\\/]/.test(cwd) ? cwd.replace(/[\\/]+$/, "") : null;
}

// ------------------------------------------------------------------ the ledger

async function readLedger(paths) {
  const ledger = new Map();
  let text = "";
  try {
    text = await fsp.readFile(paths.ledger, "utf8");
  } catch {
    return ledger;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.k) ledger.set(entry.k, entry);
    } catch {}
  }
  return ledger;
}

async function appendLedger(paths, entries) {
  if (!entries.length) return;
  await fsp.mkdir(path.dirname(paths.ledger), { recursive: true });
  await fsp.appendFile(paths.ledger, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
}

function ledgerEntry(item, outcome, reason = null) {
  return {
    k: item.key,
    o: outcome,
    ...(reason ? { r: reason } : {}),
    from: item.from,
    ...(item.lost?.length ? { lost: item.lost } : {}),
    start: item.start,
    last: item.last,
    at: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ the plan

/**
 * What goes in, in order, after setup applied: the chosen places' conversations of
 * the agents, folders and 자동 실행 대화 the configuration takes, less those on the
 * server and those already put in, oldest first. `late` "skip" leaves out the ones
 * older than the server's newest turn. The places chosen are kept for 기억 설정.
 */
export async function pastPlan(config, options = {}) {
  const paths = pastPaths(config);
  if (!config) return { ok: false, error: "set up collection first" };
  const sources = chosenSources(options);
  let catalog;
  try {
    catalog = await loadCatalog(paths, sources);
  } catch (error) {
    if (error instanceof ScanError) return { ok: false, code: error.code, error: error.message };
    throw error;
  }
  // Every place chosen at any 적용 stays chosen: a ChatGPT file once put in is still where its conversations came from.
  const previous = await readJson(paths.sources, null);
  await writeJson(paths.sources, {
    version: 1,
    store: sources.store,
    chatgpt: [...new Set([...(previous?.chatgpt || []), ...sources.chatgpt])],
    stores: [...(previous?.stores || []).filter((spec) => !sameStore(spec, sources.store)), ...(sources.store ? [sources.store] : [])],
    at: new Date().toISOString(),
  });
  const agents = config.agents || {};
  const filter = collectFolders(config);
  const automation = collectAutomation(config);
  const taken = catalog.filter((item) => {
    if (item.provider === "chatgpt") return true;
    if (!agents[item.provider]) return false;
    if (item.auto) return automation;
    return !outsideCollectFolders(item.cwd, filter);
  });
  const server = configuredServer(config);
  let index = null;
  try {
    index = server ? await serverIndex(server, taken.map((item) => item.session), paths, { fresh: true }) : null;
  } catch (error) {
    return { ok: false, unreachable: true, error: sanitizeUrlsInText(String(error?.message || error)) };
  }
  const ledger = await readLedger(paths);
  const skipLate = options.late === "skip";
  const items = [];
  const recorded = [];
  const counts = { considered: taken.length, dupes: 0, onServer: 0, late: 0, newer: 0, already: 0, skippedLate: 0 };
  for (const item of taken) {
    if (item.lost.length) counts.dupes += 1;
    const before = ledger.get(item.key);
    // Put in by an earlier run, and nothing newer here since.
    if (before && ["sent", "server", "empty"].includes(before.o) && !(item.last !== null && before.last !== undefined && item.last > (before.last ?? 0) + NEWER_SLACK_MS)) {
      counts.already += 1;
      continue;
    }
    const place = placeOf(item, index);
    if (place === "server") {
      counts.onServer += 1;
      recorded.push(ledgerEntry(item, "server"));
      continue;
    }
    if (place === "late") {
      counts.late += 1;
      if (skipLate) {
        counts.skippedLate += 1;
        recorded.push(ledgerEntry(item, "late"));
        continue;
      }
    }
    if (place === "newer") counts.newer += 1;
    if (place === "check") counts.onServer += 1;
    items.push({
      key: item.key,
      provider: item.provider,
      session: item.session,
      file: item.file,
      name: item.name,
      from: item.from,
      lost: item.lost,
      start: item.start,
      last: item.last,
      ...(item.account ? { account: item.account } : {}),
      ...(place === "check" ? { check: true } : {}),
      ...(place === "late" ? { late: true } : {}),
    });
  }
  // A conversation that failed and is no longer in any chosen place (its file went,
  // or its folder is no longer taken) is nothing to try again.
  const planned = new Set(items.map((item) => item.key));
  const now = new Date().toISOString();
  for (const [key, entry] of ledger) {
    if (entry.o !== "failed" || planned.has(key)) continue;
    recorded.push({ k: key, o: "gone", from: entry.from, ...(entry.lost ? { lost: entry.lost } : {}), start: entry.start, last: entry.last, at: now });
  }
  await appendLedger(paths, recorded);
  const checks = items.filter((item) => item.check).length;
  const plan = {
    version: 1,
    createdAt: new Date().toISOString(),
    server: server ? publicUrl(server.url) : null,
    workspace: server?.workspace || null,
    late: skipLate ? "skip" : "include",
    newest: index?.newest ?? null,
    counts: { ...counts, put: items.length - checks, checks },
    items,
  };
  await writeJson(paths.plan, plan);
  return {
    ok: true,
    total: items.length,
    first: items[0]?.start ?? null,
    last: items.at(-1)?.start ?? null,
    newest: plan.newest,
    ...plan.counts,
  };
}

// ------------------------------------------------------------------ the hold

/** New turns wait from now until the past run has gone through (queue.mjs). */
export async function pastHold(config) {
  const paths = pastPaths(config);
  const hold = await readJson(paths.hold, null);
  if (hold && (alive(Number(hold.pid)) || hold.resume)) return { ok: true, held: true };
  await writeJson(paths.hold, { version: 1, by: "setup", at: new Date().toISOString() });
  return { ok: true, held: true };
}

/** The turns waiting in the spool, and how many conversations they are of. */
async function heldTurns(paths) {
  let turns = 0;
  const conversations = new Set();
  for (const provider of HOLD_PROVIDERS) {
    const directory = path.join(paths.spool, provider, "pending");
    turns += await countPending(directory);
    let names = [];
    try {
      names = (await fsp.readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names) {
      const entry = await readJson(path.join(directory, name), null);
      if (typeof entry?.transcript_path === "string") conversations.add(`${provider}:${entry.transcript_path}`);
    }
  }
  return { turns, conversations: conversations.size };
}

/** The hold kept for a run to carry on later, with no run holding it now. */
async function keepHold(paths) {
  await writeJson(paths.hold, { version: 1, by: "run", pid: null, at: new Date().toISOString(), resume: resumeCommand(paths), resumedAt: new Date().toISOString() });
  return heldTurns(paths);
}

/** Lets the held turns go: the hold is dropped and the spool drained, as a hook would. */
async function releaseHold(config, paths) {
  const held = await heldTurns(paths);
  await fsp.rm(paths.hold, { force: true });
  if (!held.turns) return held;
  const installed = path.join(paths.runtimeDir, "main.mjs");
  const main = fs.existsSync(installed) ? installed : path.join(SCRIPT_DIR, "main.mjs");
  spawnSync(process.execPath, [main, "--provider", "all", "--drain"], {
    env: { ...withoutTargetFilter({ ...process.env, ...configEnvironment(config) }), HONCHO_AGENT_GATE_QUIET: "1" },
    timeout: 3_600_000,
    windowsHide: true,
  });
  return held;
}

// ------------------------------------------------------------------ the run

/** The collector in --serve mode: one conversation in, one answer out. */
class Collector {
  constructor(env) {
    this.env = env;
    this.child = null;
    this.waiting = null;
  }

  start() {
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "collector.mjs"), "--serve"], { env: this.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const waiting = this.waiting;
      this.waiting = null;
      if (!waiting) return;
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        result = { ok: false, error: "the collector answered something that is not JSON" };
      }
      waiting.resolve(result);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      const waiting = this.waiting;
      this.waiting = null;
      waiting?.resolve({ ok: false, error: `the collector stopped (exit ${code})` });
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    this.child = child;
  }

  send(item, timeoutMs = 15 * 60_000) {
    if (!this.child) this.start();
    const child = this.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
      }, timeoutMs);
      this.waiting = { resolve: (result) => { clearTimeout(timer); resolve(result); } };
      child.stdin.write(`${JSON.stringify(item)}\n`);
    });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 10_000);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}

/**
 * What became of one conversation, from the collector's answer: sent, nothing in it
 * to remember (empty), left out by the configuration (left), or failed because the
 * file could not be read, the server refused it, or the server did not answer.
 */
export function outcomeOf(result) {
  if (result?.ok) {
    if (result.provider === "chatgpt" && Number(result.imported_sessions || 0) === 0 && !result.failed_sessions) return { o: "empty" };
    if (result.skipped === "no conversation") return { o: "empty" };
    if (result.skipped) return { o: "left", r: String(result.skipped) };
    return { o: "sent", messages: Number(result.new_messages || 0) };
  }
  const text = String(
    result?.error
    || (Array.isArray(result?.sessions) ? result.sessions.find((session) => session.error)?.error : "")
    || (Array.isArray(result?.unreadable_conversations) && result.unreadable_conversations.length ? "unreadable conversation" : "")
    || "failed",
  );
  if (/Cloudflare Access refused|HTTP 401|HTTP 403/.test(text)) return { o: "failed", r: "refused", error: text };
  if (/HTTP (408|429|5\d\d)|fetch failed|aborted|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|Cannot safely|collector stopped/i.test(text)) {
    return { o: "failed", r: "unreachable", error: text };
  }
  if (/HTTP 4\d\d/.test(text)) return { o: "failed", r: "refused", error: text };
  return { o: "failed", r: "unreadable", error: text };
}

/** A store copy kept under a device-tagged name goes to the collector under its own name (Codex segments are told apart by it). */
async function staged(paths, item) {
  if (item.provider === "chatgpt" || path.basename(item.file) === item.name) return { file: item.file, cleanup: async () => {} };
  const directory = path.join(paths.stage, item.provider);
  await fsp.mkdir(directory, { recursive: true });
  const target = path.join(directory, item.name);
  await fsp.copyFile(item.file, target);
  return { file: target, cleanup: () => fsp.rm(target, { force: true }) };
}

function runEnvironment(config, paths) {
  const env = withoutTargetFilter({ ...process.env, ...configEnvironment(config) });
  // One agent's log, as a hook that started the run names it, is not every agent's.
  delete env.HONCHO_AGENT_HOOK_STATE;
  delete env.HONCHO_AGENT_HOOK_LOG;
  return {
    ...env,
    HONCHO_AGENT_LOG_DIR: paths.logs,
    HONCHO_AGENT_IMPORT_TRIGGER: "past",
    HONCHO_AGENT_HTTP_TIMEOUT_SECONDS: HTTP_TIMEOUT_SECONDS,
  };
}

/**
 * The hooks' state files say which turns of each conversation went in, and one
 * they have read back from the server is not read again. The run sends without
 * them (collector.mjs --serve), so the conversations it is about to send are marked
 * to be read back the next time a hook sends a turn of one.
 */
async function rereadAfterRun(paths, items) {
  const byProvider = new Map();
  for (const item of items) {
    if (!byProvider.has(item.provider)) byProvider.set(item.provider, new Set());
    byProvider.get(item.provider).add(item.session);
  }
  for (const [provider, sessions] of byProvider) {
    const file = path.join(paths.state, `${provider}.json`);
    if (!(await exists(file))) continue;
    const lock = await acquireFileLock(`${file}.lock`, { attempts: 50, delayMs: 100, staleMs: 120_000 });
    if (!lock) throw new Error(`the ${provider} state file is busy`);
    try {
      const state = await readJson(file, null);
      if (!state?.sessions) continue;
      let changed = false;
      for (const session of sessions) {
        const entry = state.sessions[session];
        if (!entry || (!entry.reconciled_source_hashes_at && !entry.reconciled_segments)) continue;
        delete entry.reconciled_source_hashes_at;
        delete entry.reconciled_segments;
        changed = true;
      }
      if (!changed) continue;
      // Written as the collector writes it (saveState).
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), "utf8");
      await fsp.rename(`${file}.tmp`, file);
    } finally {
      await releaseFileLock(lock);
    }
  }
}

/** The command that carries a stopped run on: the installed runtime's, which stays where it is. */
function resumeCommand(paths) {
  const installed = path.join(paths.runtimeDir, "cli.mjs");
  return [process.execPath, fs.existsSync(installed) ? installed : path.join(SCRIPT_DIR, "cli.mjs"), "past", "run"];
}

/**
 * Puts the planned conversations in, one at a time and in order, with new turns
 * held until they are through. Carries on from the ledger: what went in before is
 * not sent again. `retry` sends the ones that failed too.
 */
export async function pastRun(config, { retry = false } = {}) {
  const paths = pastPaths(config);
  if (!config) return { ok: false, error: "set up collection first" };
  const lock = await acquireFileLock(paths.lock, { staleMs: 48 * 3_600_000, reclaimDeadImmediately: true });
  if (!lock) return { ok: true, busy: true };
  const startedAt = new Date().toISOString();
  let status = await readJson(paths.status, {});
  const save = async (fields) => {
    status = { version: 1, ...status, ...fields };
    await writeJson(paths.status, status);
  };
  let collector = null;
  try {
    const plan = await readJson(paths.plan, null);
    if (!plan?.items) {
      await fsp.rm(paths.hold, { force: true });
      return { ok: false, error: "nothing planned; apply setup first" };
    }
    await fsp.rm(paths.stop, { force: true });
    const ledger = await readLedger(paths);
    // What went before this plan was made is why the plan has it (newer turns, a late
    // one let in, a failure tried again); within it, the ledger says what is done.
    const todo = plan.items.filter((item) => {
      const before = ledger.get(item.key);
      if (!before || String(before.at) < plan.createdAt) return true;
      if (before.o !== "failed") return false;
      return retry || before.r === "unreachable";
    });
    await writeJson(paths.hold, { version: 1, by: "run", pid: process.pid, at: startedAt, resume: resumeCommand(paths) });
    await rereadAfterRun(paths, todo);
    const server = configuredServer(config);
    const total = todo.length;
    const run = { pid: process.pid, startedAt, total, done: 0, sent: 0, failed: 0, month: null, from: null, etaSec: null, retry };
    await save({ running: run });
    collector = new Collector(runEnvironment(config, paths));
    const began = Date.now();
    let lastWrite = 0;
    let unreachable = 0;
    let stopped = null;
    let cancelled = false;
    const failures = { unreadable: 0, refused: 0, unreachable: 0 };
    for (const item of todo) {
      if (await exists(paths.stop)) {
        cancelled = true;
        break;
      }
      run.from = item.from;
      let outcome;
      if (item.check && server) {
        // Sent by a collector that did not record its last turn: asked now.
        const last = await lastMessageAt(server, item.session).catch(() => undefined);
        if (last !== undefined && last !== null && !(item.last !== null && item.last > last + NEWER_SLACK_MS)) outcome = { o: "server" };
      }
      if (!outcome) {
        const copy = await staged(paths, item).catch(() => null);
        if (!copy) {
          outcome = { o: "failed", r: "unreadable", error: "the file could not be read" };
        } else {
          const request = item.provider === "chatgpt"
            ? { provider: "chatgpt", export: copy.file, ...(item.account ? { metadata: { chatgpt_account: item.account } } : {}) }
            : { provider: item.provider, transcript: copy.file };
          outcome = outcomeOf(await collector.send(request));
          await copy.cleanup().catch(() => {});
        }
      }
      await appendLedger(paths, [{ ...ledgerEntry(item, outcome.o, outcome.r), ...(outcome.error ? { e: sanitizeUrlsInText(outcome.error).slice(0, 300) } : {}) }]);
      run.done += 1;
      if (outcome.o === "sent" || outcome.o === "server") {
        run.sent += 1;
        run.month = item.start;
      }
      if (outcome.o === "failed") {
        run.failed += 1;
        failures[outcome.r] = (failures[outcome.r] || 0) + 1;
      }
      unreachable = outcome.r === "unreachable" ? unreachable + 1 : 0;
      if (unreachable >= MAX_UNREACHABLE) {
        stopped = "unreachable";
        break;
      }
      if (Date.now() - lastWrite >= STATUS_EVERY_MS) {
        lastWrite = Date.now();
        const rate = (Date.now() - began) / 1000 / run.done;
        run.etaSec = Math.round(rate * (total - run.done));
        await save({ running: run });
      }
    }
    await collector.close();
    collector = null;
    // A server that stopped answering keeps the turns held: the run starts again by
    // itself (queue.mjs, pastStatus) and the order is kept once it answers.
    const held = stopped === "unreachable" ? await keepHold(paths) : await releaseHold(config, paths);
    const last = {
      startedAt,
      finishedAt: new Date().toISOString(),
      total,
      done: run.done,
      sent: run.sent,
      failed: run.failed,
      failures,
      held,
      retry,
      ...(cancelled ? { cancelled: true } : {}),
      ...(stopped ? { stopped } : {}),
    };
    await save({ running: null, last });
    await fsp.rm(paths.stop, { force: true });
    return { ok: !stopped && run.failed === 0, ...last };
  } catch (error) {
    await save({ running: null, last: { startedAt, finishedAt: new Date().toISOString(), error: sanitizeUrlsInText(String(error?.message || error)) } }).catch(() => {});
    // Kept: the next turn starts the run again (queue.mjs), and it carries on.
    throw error;
  } finally {
    await collector?.close().catch(() => {});
    await releaseFileLock(lock);
  }
}

/** Starts the run in the background and answers at once. */
export async function pastStart(config, { retry = false } = {}) {
  const paths = pastPaths(config);
  const status = await readJson(paths.status, {});
  if (status?.running && alive(Number(status.running.pid))) return { ok: true, started: false, running: status.running };
  // Held from this moment, so no new turn slips in before the run takes the hold over.
  await pastHold(config);
  const [command, ...args] = resumeCommand(paths);
  const child = spawn(command, [...args, ...(retry ? ["--retry"] : [])], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.on("error", () => {});
  child.unref();
  await writeJson(paths.status, { version: 1, ...status, running: { pid: child.pid, startedAt: new Date().toISOString(), total: null, done: 0, sent: 0, failed: 0, retry, starting: true } });
  return { ok: true, started: true, pid: child.pid };
}

/** Asks the run to stop after the conversation it is sending; the held turns then go. */
export async function pastStop(config) {
  const paths = pastPaths(config);
  const status = await readJson(paths.status, {});
  if (status?.running && alive(Number(status.running.pid))) {
    await writeJson(paths.stop, { version: 1, askedAt: new Date().toISOString() });
    return { ok: true, stopping: true };
  }
  // Nothing runs: a hold left behind (setup that never started the run) lets the turns go.
  const held = await readJson(paths.hold, null);
  if (held && !alive(Number(held.pid))) {
    const released = await releaseHold(config, paths);
    return { ok: true, stopping: false, released };
  }
  return { ok: true, stopping: false };
}

// ------------------------------------------------------------------ what 기억 설정 and the dashboard show

function sourceRow(id, sources, chatgpt) {
  if (id === SOURCE_HERE) return { id, kind: "here" };
  if (id === SOURCE_STORE) return { id, kind: "store", label: storeLabel(sources?.store || null) };
  const file = chatgpt.find((record) => `chatgpt:${record.id}` === id);
  return { id, kind: "chatgpt", account: file?.account || null, name: file?.name || null };
}

/**
 * The run as the screens show it: how far a running one has got, how the last one
 * ended, and for each place, its conversations, how many are on the server, how
 * many were the same as another place's, and how many failed and why.
 */
/** The run going now: one whose process is alive, or one just started that has not written its own status yet. */
function runningOf(status) {
  if (status?.running && alive(Number(status.running.pid))) return status.running;
  if (status?.running?.starting && Date.now() - (timeOf(status.running.startedAt) || 0) < 15_000) return status.running;
  return null;
}

/** A run that stopped half way (a restart) is carried on, as the next turn would (queue.mjs). */
async function resumeStopped(paths, hold, running) {
  if (running || !hold?.resume || alive(Number(hold.pid)) || Date.now() - (timeOf(hold.resumedAt) || 0) < 60_000) return;
  await writeJson(paths.hold, { ...hold, resumedAt: new Date().toISOString() });
  const [command, ...args] = hold.resume;
  if (!fs.existsSync(args[0] || "")) return;
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.on("error", () => {});
  child.unref();
}

export async function pastStatus(config) {
  const paths = pastPaths(config);
  const status = await readJson(paths.status, {});
  const running = runningOf(status);
  const hold = await readJson(paths.hold, null);
  await resumeStopped(paths, hold, running);
  const sources = await readJson(paths.sources, null);
  const chatgpt = await chatgptFiles(paths);
  const ledger = await readLedger(paths);
  const plan = await readJson(paths.plan, null);
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { ...sourceRow(id, sources, chatgpt), conversations: 0, stacked: 0, dupes: 0, failed: 0, late: 0, waiting: 0 });
    return rows.get(id);
  };
  const failures = { unreadable: 0, refused: 0, unreachable: 0 };
  let first = null;
  let last = null;
  const count = (entry, outcome) => {
    if (outcome === "empty" || outcome === "left" || outcome === "gone") return;
    const own = row(entry.from);
    own.conversations += 1;
    for (const id of entry.lost || []) {
      row(id).conversations += 1;
      row(id).dupes += 1;
    }
    if (outcome === "sent" || outcome === "server") {
      own.stacked += 1;
      if (entry.start !== null && entry.start !== undefined) {
        if (first === null || entry.start < first) first = entry.start;
        if (last === null || entry.start > last) last = entry.start;
      }
    } else if (outcome === "failed") {
      own.failed += 1;
      failures[entry.r] = (failures[entry.r] || 0) + 1;
    } else if (outcome === "late") {
      own.late += 1;
    } else {
      own.waiting += 1;
    }
  };
  for (const entry of ledger.values()) count(entry, entry.o);
  for (const item of plan?.items || []) if (!ledger.has(item.key)) count(item, "waiting");
  // This computer first, then the store, then the ChatGPT files in the order they came.
  const order = (item) => (item.kind === "here" ? 0 : item.kind === "store" ? 1 : 2);
  return {
    ok: true,
    running,
    stopping: Boolean(running) && (await exists(paths.stop)),
    last: status?.last || null,
    sources: [...rows.values()].sort((a, b) => order(a) - order(b)),
    chosen: sources ? { store: sources.store || null, storeLabel: storeLabel(sources.store || null), chatgpt: sources.chatgpt || [] } : null,
    chatgpt,
    failures: { total: failures.unreadable + failures.refused + failures.unreachable, ...failures },
    order: { first, last },
    held: await heldTurns(paths),
    holding: Boolean(hold),
    planned: plan ? { createdAt: plan.createdAt, total: plan.items.length } : null,
  };
}

let failedCache = null;

/** How many conversations stand failed in the ledger, read again only when it changed. */
async function failedCount(paths) {
  let stat;
  try {
    stat = await fsp.stat(paths.ledger);
  } catch {
    return 0;
  }
  if (failedCache?.file !== paths.ledger || failedCache.size !== stat.size || failedCache.mtime !== stat.mtimeMs) {
    let failed = 0;
    for (const entry of (await readLedger(paths)).values()) if (entry.o === "failed") failed += 1;
    failedCache = { file: paths.ledger, size: stat.size, mtime: stat.mtimeMs, failed };
  }
  return failedCache.failed;
}

/**
 * The dashboard's view, asked every few seconds: the run going now, how the last
 * one ended, the new turns held, and the failures left. null before any run.
 */
export async function pastFlow(config) {
  const paths = pastPaths(config);
  const status = await readJson(paths.status, null);
  const hold = await readJson(paths.hold, null);
  if (!status && !hold) return null;
  const running = runningOf(status);
  await resumeStopped(paths, hold, running);
  return {
    running,
    stopping: Boolean(running) && (await exists(paths.stop)),
    last: status?.last || null,
    held: await heldTurns(paths),
    holding: Boolean(hold),
    failed: await failedCount(paths),
  };
}

// ------------------------------------------------------------------ the command

function listOption(value) {
  if (Array.isArray(value)) return value;
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function jsonOption(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * `past <action>`: scan [--store=<json>], scan-run, scan-status, chatgpt-add --file
 * --name, chatgpt-drop --id, overview [--honcho-url --workspace --agents --store
 * --chatgpt --new-server], plan [--store --chatgpt --late include|skip], hold, start,
 * run [--retry], retry, status, stop. The ChatGPT upload and the scan's progress are
 * the app's (ui.mjs); every other step runs the same here as from the app.
 */
export async function pastCommand(action, options = {}) {
  const config = await loadConfig();
  if (action === "scan") return pastScan(config, { store: jsonOption(options.store) });
  if (action === "scan-run") return pastScanRun(config);
  if (action === "scan-status") return pastScanStatus(config);
  if (action === "chatgpt-add") {
    if (typeof options.file !== "string") return { ok: false, error: "--file names the export" };
    return addChatGpt(config, path.resolve(options.file), typeof options.name === "string" ? options.name : path.basename(options.file));
  }
  if (action === "chatgpt-drop") return dropChatGpt(config, options.id);
  if (action === "overview") {
    return pastOverview(config, {
      honchoUrl: options.honchoUrl,
      workspace: options.workspace,
      agents: options.agents ? listOption(options.agents) : undefined,
      store: jsonOption(options.store),
      chatgpt: listOption(options.chatgpt),
      newServer: options.newServer === true || options.newServer === "true",
      fresh: options.fresh === true,
    });
  }
  if (action === "plan") return pastPlan(config, { store: jsonOption(options.store), chatgpt: listOption(options.chatgpt), late: options.late });
  if (action === "hold") return pastHold(config);
  if (action === "start") return pastStart(config, { retry: options.retry === true });
  if (action === "retry") return pastStart(config, { retry: true });
  if (action === "run") return pastRun(config, { retry: options.retry === true });
  if (action === "status") return pastStatus(config);
  if (action === "stop") return pastStop(config);
  return { ok: false, error: `Unknown past action: ${action}. Expected scan, scan-status, chatgpt-add, chatgpt-drop, overview, plan, hold, start, run, retry, status or stop.` };
}

