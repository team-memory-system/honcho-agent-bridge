// The conversation backup: byte-exact copies of the agents' own files, straight
// from where the apps keep them to a folder or a cloud, laid out as
// 대화/<agent>/YYYY/MM/DD/<original file name> (see backup-sources.mjs).
//
// It is not the input to Honcho (the collector and the Stop hook are) and nothing
// here reads the backup back. It keeps no copy of the data on this computer: only
// a ledger of what it copied (path, size, mtime, md5, where it went) so the next
// run skips what has not changed, and the outcome of the last run.
//
// The rules for a destination that several computers share, with no folder per
// computer:
//   - copy only; never sync, never delete anything at the destination;
//   - a file missing there is copied (new);
//   - the same bytes are left alone (unchanged);
//   - a shorter file there that is a byte prefix of this one (an append-only
//     transcript that grew) is replaced (prefix-replace);
//   - anything else there is kept, and this computer's version is written beside
//     it under a name tagged with this computer's device id, then, if that name
//     is taken by other bytes too, also with the first 8 hex of its md5 (keep-both);
//   - modification times never decide anything.
// A Codex session lives in one place: an archived one goes under codex/_아카이브/,
// and a copy of it still in the normal date folder is moved there (archive-moves).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installPaths, loadConfig, userHome } from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import {
  ARCHIVE_FOLDER,
  claudeSessionStart,
  codexSessionMeta,
  counterpartFor,
  destinationFor,
  discoverSources,
  kstDateFolder,
  taggedName,
} from "./backup-sources.mjs";
import {
  folderStore,
  parseCloudDestination,
  rcloneRemotes,
  rcloneStore,
  volumeRootOf,
} from "./backup-store.mjs";
import {
  backupScheduleSpec,
  backupScheduleStatus,
  installBackupSchedule,
  removeBackupSchedule,
  scheduleMinute,
} from "./backup-schedule.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_VERSION = 1;
const LEDGER_VERSION = 1;
export const BUCKETS = Object.freeze(["new", "unchanged", "prefix-replace", "keep-both", "archive-moves"]);
// Above this many folders to look at, a cloud is listed per agent in one recursive pass.
const PER_FOLDER_LISTING_LIMIT = 40;
const DEFAULT_HOUR = 3;
const ORIGINAL_VERSIONS = "_원본버전";

// ------------------------------------------------------------------ settings

export function backupPaths(dataDir) {
  const directory = path.join(dataDir, "backup");
  return {
    directory,
    settings: path.join(directory, "settings.json"),
    status: path.join(directory, "status.json"),
    lock: path.join(directory, "run.lock"),
    ledger: (key) => path.join(directory, `ledger-${key}.json`),
    log: path.join(dataDir, "logs", "backup.log"),
  };
}

async function defaultDataDir() {
  return installPaths(await loadConfig().catch(() => null)).dataDir;
}

async function readJsonFile(filePath, fallback) {
  try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** A device id from the host name: lower-case letters, digits and dashes. */
export function defaultDeviceId(hostname = os.hostname()) {
  const base = String(hostname || "").replace(/\.(local|lan|home)$/i, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return base || "device";
}

export function validDeviceId(value) {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value);
}

export async function readSettings(dataDir) {
  const settings = await readJsonFile(backupPaths(dataDir).settings, null);
  if (!settings || settings.version !== SETTINGS_VERSION) return { version: SETTINGS_VERSION, destination: null, device: null, hour: DEFAULT_HOUR };
  return { hour: DEFAULT_HOUR, ...settings };
}

async function writeSettings(dataDir, settings) {
  await writeJsonFile(backupPaths(dataDir).settings, { ...settings, version: SETTINGS_VERSION });
}

export function deviceOf(settings) {
  return validDeviceId(settings?.device) ? settings.device : defaultDeviceId();
}

/** What a destination is called on screen and in the ledger's name. */
export function destinationLabel(destination) {
  if (!destination) return "";
  if (destination.kind === "folder") return path.join(destination.path, "대화");
  return `${destination.remote}:${destination.path ? `${destination.path}/` : ""}대화`;
}

function destinationKey(destination) {
  const identity = destination.kind === "folder" ? `folder:${path.resolve(destination.path)}` : `cloud:${destination.remote}:${destination.path || ""}`;
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

export function storeFor(destination, { rcloneRun, env } = {}) {
  if (destination.kind === "folder") return folderStore({ folder: destination.path, volumeRoot: destination.volumeRoot || null });
  if (destination.kind === "cloud") return rcloneStore({ remote: destination.remote, path: destination.path || "", run: rcloneRun, env });
  throw new Error(`unknown destination kind: ${destination.kind}`);
}

// ------------------------------------------------------------------ hashing

/**
 * md5 of the first `size` bytes of a file (the size it had when it was looked
 * at), and of each shorter prefix in `cuts`, in one pass.
 */
export async function hashLocal(filePath, size, cuts = []) {
  const wanted = [...new Set(cuts.filter((cut) => cut > 0 && cut < size))].sort((a, b) => a - b);
  const prefixes = new Map();
  if (cuts.includes(0)) prefixes.set(0, crypto.createHash("md5").digest("hex"));
  const hash = crypto.createHash("md5");
  let offset = 0;
  let next = 0;
  if (size > 0) {
    for await (const chunk of fs.createReadStream(filePath, { start: 0, end: size - 1 })) {
      let start = 0;
      while (next < wanted.length && wanted[next] <= offset + chunk.length) {
        const cut = wanted[next] - offset;
        hash.update(chunk.subarray(start, cut));
        start = cut;
        prefixes.set(wanted[next], hash.copy().digest("hex"));
        next += 1;
      }
      hash.update(chunk.subarray(start));
      offset += chunk.length;
    }
  }
  if (offset !== size) throw new Error(`the file changed size while it was read (${offset} of ${size} bytes)`);
  return { size, md5: hash.digest("hex"), prefixes };
}

// ------------------------------------------------------------------ planning

function dirOf(rel) {
  return rel.split("/").slice(0, -1).join("/");
}

function inDir(rel, name) {
  const dir = dirOf(rel);
  return dir ? `${dir}/${name}` : name;
}

async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

class Plan {
  constructor(store) {
    this.store = store;
    this.files = new Map();
    this.dirs = new Set();
    this.moves = [];
    this.copies = [];
    this.unchanged = [];
    this.errors = [];
    // name → files kept under a date folder's _원본버전/<session>/<hash>/ by the
    // 2026-10-04 reorganisation; only reported, never written to.
    this.versions = new Map();
  }

  /** md5 of what is at `rel` now, from the listing or read from a folder. */
  async md5(entry) {
    if (entry.md5 === undefined && entry.origin && this.store.md5) entry.md5 = await this.store.md5(entry.origin);
    return entry.md5;
  }

  async same(entry, local) {
    if (entry.size !== local.size) return false;
    const md5 = await this.md5(entry);
    if (md5 === undefined) throw new Error("the destination reports no md5, so this file cannot be compared");
    return md5 === local.md5;
  }

  /** Whether everything at `entry` is also the start of the local file. */
  async containedIn(entry, local) {
    if (entry.size > local.size) return false;
    if (entry.size === 0) return true;
    const md5 = await this.md5(entry);
    if (md5 === undefined) throw new Error("the destination reports no md5, so this file cannot be compared");
    if (entry.size === local.size) return md5 === local.md5;
    if (!local.prefixes.has(entry.size)) local.prefixes.set(entry.size, (await hashLocal(local.path, entry.size)).md5);
    return md5 === local.prefixes.get(entry.size);
  }

  move(item, from, to) {
    const entry = this.files.get(from);
    this.files.delete(from);
    this.files.set(to, entry);
    this.moves.push({ item, from, to });
  }
}

async function classify(item, stat, cached) {
  if (item.agent === "codex" && (item.kind === "main" || item.kind === "archived")) {
    if (cached?.excluded === "subagent") return { excluded: "subagent" };
    if (cached?.date) return { date: cached.date };
    const meta = await codexSessionMeta(item.localPath);
    if (meta.subagent) return { excluded: "subagent" };
    return { date: kstDateFolder(meta.startedAt), basis: meta.basis };
  }
  if (item.agent === "claude" && item.kind === "main") {
    if (cached?.date) return { date: cached.date };
    const start = await claudeSessionStart(item.localPath);
    return { date: kstDateFolder(start.startedAt), basis: start.basis };
  }
  return {};
}

/**
 * Looks at this computer and the destination and decides every copy and move,
 * without changing either. `ledger.files` is keyed by local path.
 */
async function plan({ store, items, ledger, device, full, log, wholeTrees = false }) {
  const result = new Plan(store);
  const pending = [];
  const fresh = {};
  const excluded = {};
  const ledgerHits = [];

  for (const item of items) {
    let stat;
    try { stat = await fsp.stat(item.localPath); } catch (error) {
      result.errors.push({ item, error: `cannot read: ${error.code || error.message}` });
      continue;
    }
    const cached = ledger.files[item.localPath];
    if (!full && cached?.dest && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      ledgerHits.push({ item, dest: cached.dest, size: stat.size });
      fresh[item.localPath] = cached;
      continue;
    }
    let kind;
    try { kind = await classify(item, stat, cached); } catch (error) {
      result.errors.push({ item, error: `cannot read its first records: ${error.message}` });
      continue;
    }
    if (kind.excluded) {
      const key = `${item.agent}/${item.kind === "archived" ? "archived-" : ""}${kind.excluded}`;
      excluded[key] = (excluded[key] || 0) + 1;
      fresh[item.localPath] = { excluded: kind.excluded };
      continue;
    }
    if ((item.kind === "main" || item.kind === "archived") && !kind.date) {
      // No timestamped record yet (Claude writes a one-line bridge-session stub for a
      // session that never got a message): not a conversation yet. It is looked at
      // again on every run, and goes once it has one.
      const key = `${item.agent}/no-records-yet`;
      excluded[key] = (excluded[key] || 0) + 1;
      continue;
    }
    const { rel, shared } = destinationFor(item, { date: kind.date, device });
    const counterpart = counterpartFor(item, { date: kind.date });
    pending.push({ item, stat, date: kind.date, rel, shared, counterpart, previous: cached?.dest || null });
  }

  // What is at the destination, for every folder these files can land in.
  const dirs = new Set();
  for (const entry of pending) {
    dirs.add(dirOf(entry.rel));
    if (entry.counterpart) dirs.add(dirOf(entry.counterpart));
    if (entry.previous) dirs.add(dirOf(entry.previous));
  }
  const trees = store.kind === "cloud" && (wholeTrees || dirs.size > PER_FOLDER_LISTING_LIMIT)
    ? [...new Set([...dirs].map((dir) => dir.split("/")[0]))].sort()
    : [];
  log(`listing ${trees.length ? trees.join(", ") : `${dirs.size} folders`} at ${store.label}`);
  const listing = await store.list([...dirs].sort(), { trees });
  for (const [rel, entry] of listing.files) {
    result.files.set(rel, { ...entry, origin: rel });
    if (rel.includes(`/${ORIGINAL_VERSIONS}/`)) {
      const name = rel.split("/").at(-1);
      if (!result.versions.has(name)) result.versions.set(name, []);
      result.versions.get(name).push({ rel, ...entry });
    }
  }
  for (const dir of listing.dirs) result.dirs.add(dir);

  log(`comparing ${pending.length} files`);
  for (const entry of pending) {
    const { item, stat } = entry;
    try {
      const names = [entry.rel, entry.counterpart, entry.previous, entry.shared ? inDir(entry.rel, taggedName(item.name, device)) : null];
      const candidates = names.filter(Boolean).map((rel) => result.files.get(rel)).filter(Boolean);
      const local = await hashLocal(item.localPath, stat.size, candidates.map((candidate) => candidate.size));
      local.path = item.localPath;
      local.mtimeMs = stat.mtimeMs;
      await relocate(result, entry, local);
      await decide(result, entry, local, device);
    } catch (error) {
      result.errors.push({ item, error: error.message });
    }
  }
  return { plan: result, fresh, excluded, ledgerHits };
}

/**
 * A copy of this session in the other place (the normal date folder for an
 * archived session, _아카이브 for one that is no longer archived) moves to where
 * the session lives now, so it is in one place only.
 */
async function relocate(result, entry, local) {
  const other = entry.counterpart && result.files.get(entry.counterpart);
  if (!other || other.planned) return;
  const here = result.files.get(entry.rel);
  const otherInLocal = await result.containedIn(other, local);
  if ((!here && otherInLocal) || (here && await result.same(other, here))
    || (here && otherInLocal && await result.containedIn(here, local))) {
    // The same bytes, or bytes this file starts with (and so does whatever is there),
    // which this file is copied over next: nothing is lost by moving it onto that name.
    result.move(entry.item, entry.counterpart, entry.rel);
    return;
  }
  // Different bytes. Codex rewrites a session when it archives it (every record gains
  // an `ordinal`, some events change), so the copy from before holds the only
  // original-format bytes. It is kept under its own name beside the session: going
  // into _아카이브 that is <name>.pre-archive.jsonl, as the 2026-10-05 pass over
  // 대화/codex named them; when that is taken by other bytes too, or going the other
  // way, the name carries the first 8 hex of its md5.
  const md5 = await result.md5(other);
  if (md5 === undefined) throw new Error("the destination reports no md5, so this file cannot be compared");
  const names = entry.item.kind === "archived"
    ? [taggedName(entry.item.name, "pre-archive"), taggedName(entry.item.name, `pre-archive.${md5.slice(0, 8)}`)]
    : [taggedName(entry.item.name, md5.slice(0, 8))];
  for (const name of names) {
    const keep = inDir(entry.rel, name);
    const taken = result.files.get(keep);
    if (taken && !(await result.same(taken, { size: other.size, md5 }))) continue;
    result.move(entry.item, entry.counterpart, keep);
    return;
  }
  throw new Error(`every name for the moved copy of ${entry.item.name} is taken by other bytes`);
}

async function decide(result, entry, local, device) {
  const { item, rel, shared } = entry;
  const chain = [rel];
  if (shared) chain.push(inDir(rel, taggedName(item.name, device)));
  if (entry.previous && !chain.includes(entry.previous) && dirOf(entry.previous) === dirOf(rel)) chain.push(entry.previous);
  const hashTag = shared ? `${device}.${local.md5.slice(0, 8)}` : local.md5.slice(0, 8);
  chain.push(inDir(rel, taggedName(item.name, hashTag)));

  for (const candidate of chain) {
    const there = result.files.get(candidate);
    const record = { item, entry, local, to: candidate, primary: rel };
    if (!there) {
      const sameAs = candidate === rel
        ? (result.versions.get(item.name) || []).find((version) => version.size === local.size && version.md5 === local.md5 && version.rel.startsWith(`${dirOf(rel)}/`))
        : null;
      result.copies.push({ ...record, bucket: candidate === rel ? "new" : "keep-both", replaced: null, ...(sameAs ? { sameAsVersion: sameAs.rel } : {}) });
      result.files.set(candidate, { size: local.size, md5: local.md5, planned: true });
      return;
    }
    if (await result.same(there, local)) {
      result.unchanged.push(record);
      return;
    }
    if (there.size < local.size && await result.containedIn(there, local)) {
      result.copies.push({ ...record, bucket: "prefix-replace", replaced: there.size });
      result.files.set(candidate, { size: local.size, md5: local.md5, planned: true });
      return;
    }
  }
  throw new Error(`every name for ${item.name} in ${dirOf(rel)} holds other bytes`);
}

// ------------------------------------------------------------------ running

function kindKey(item) {
  return `${item.agent}/${item.kind}`;
}

function emptyCounts() {
  return Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0]));
}

function summarize({ plan: result, excluded, discoveredExcluded, ledgerHits, examplesPerKind, executed }) {
  const counts = emptyCounts();
  const bytes = emptyCounts();
  const byKind = {};
  const examples = Object.fromEntries(BUCKETS.map((bucket) => [bucket, {}]));
  const add = (bucket, item, size, example) => {
    counts[bucket] += 1;
    bytes[bucket] += size || 0;
    const key = kindKey(item);
    byKind[key] ??= emptyCounts();
    byKind[key][bucket] += 1;
    if (example) {
      examples[bucket][key] ??= [];
      if (examples[bucket][key].length < examplesPerKind) examples[bucket][key].push(example);
    }
  };
  for (const move of result.moves) add("archive-moves", move.item, 0, { from: move.from, to: move.to, local: move.item.localPath });
  for (const copy of result.copies) {
    const example = { from: copy.item.localPath, to: copy.to, size: copy.local.size };
    if (copy.bucket === "prefix-replace") example.replacedSize = copy.replaced;
    if (copy.sameAsVersion) example.sameBytesAt = copy.sameAsVersion;
    if (copy.bucket === "keep-both") {
      const there = result.files.get(copy.primary);
      example.differsFrom = copy.primary;
      if (there && !there.planned) example.differsFromSize = there.size;
    }
    add(copy.bucket, copy.item, copy.local.size, example);
  }
  for (const record of result.unchanged) add("unchanged", record.item, record.local.size, { from: record.item.localPath, to: record.to });
  for (const hit of ledgerHits) add("unchanged", hit.item, hit.size, null);
  const allExcluded = { ...discoveredExcluded };
  for (const [key, count] of Object.entries(excluded)) allExcluded[key] = (allExcluded[key] || 0) + count;
  return {
    counts: { ...counts, errors: result.errors.length },
    bytes,
    byKind,
    skippedByLedger: ledgerHits.length,
    // New at their own name, while the same bytes already sit under _원본버전/.
    newSameAsOriginalVersion: {
      files: result.copies.filter((copy) => copy.sameAsVersion).length,
      bytes: result.copies.filter((copy) => copy.sameAsVersion).reduce((sum, copy) => sum + copy.local.size, 0),
    },
    excluded: allExcluded,
    examples: Object.fromEntries(Object.entries(examples).filter(([bucket]) => bucket !== "unchanged" || !executed)),
    errors: result.errors.slice(0, 50).map(({ item, error }) => ({ path: item.localPath, error })),
  };
}

function ledgerEntry(local, to, date) {
  return { size: local.size, mtimeMs: local.mtimeMs, md5: local.md5, dest: to, ...(date ? { date } : {}) };
}

/**
 * One backup run. With `dryRun`, it looks at both sides and reports what it would
 * do, and writes nothing anywhere (not even its own ledger).
 */
export async function runBackup({
  destination,
  dataDir,
  homeDir = userHome(),
  device = defaultDeviceId(),
  dryRun = false,
  full = false,
  store: givenStore,
  rcloneRun,
  examplesPerKind = 3,
  concurrency,
  wholeTrees = false,
  log = () => {},
} = {}) {
  if (!destination) return { ok: false, error: "no backup destination is set" };
  const store = givenStore || storeFor(destination, { rcloneRun });
  const startedAt = new Date().toISOString();
  const base = { destination: destinationLabel(destination), kind: destination.kind, device, dryRun, startedAt };

  const probe = await store.probe();
  if (!probe.ok) return { ok: false, waiting: true, reason: probe.reason, ...(probe.detail ? { detail: probe.detail } : {}), ...base };

  const { items, excluded: discoveredExcluded } = await discoverSources({ homeDir });
  const ledgerPath = dataDir ? backupPaths(dataDir).ledger(destinationKey(destination)) : null;
  const ledgerFile = ledgerPath ? await readJsonFile(ledgerPath, null) : null;
  const ledger = ledgerFile?.version === LEDGER_VERSION ? ledgerFile : { version: LEDGER_VERSION, files: {} };

  const planned = await plan({ store, items, ledger, device, full, log, wholeTrees });
  const { plan: result, fresh } = planned;

  if (!dryRun) {
    const saveLedger = async () => {
      if (ledgerPath) await writeJsonFile(ledgerPath, { version: LEDGER_VERSION, destination: base.destination, files: fresh });
    };
    for (const record of result.unchanged) fresh[record.item.localPath] = ledgerEntry(record.local, record.to, record.entry.date);
    const failed = new Set();
    for (const move of result.moves) {
      try {
        log(`move ${move.from} -> ${move.to}`);
        await store.move(move.from, move.to);
      } catch (error) {
        result.errors.push({ item: move.item, error: error.message });
        failed.add(move.item.localPath);
      }
    }
    // A cloud may make two folders of one name when two uploads create it at once,
    // so new folders are made one at a time before the uploads run side by side.
    if (store.kind === "cloud") {
      const needed = [...new Set(result.copies.map((copy) => dirOf(copy.to)))].filter((dir) => !result.dirs.has(dir)).sort();
      for (const dir of needed) {
        try { await store.mkdir(dir); } catch (error) { log(error.message); }
      }
    }
    let done = 0;
    const copies = result.copies.filter((copy) => !failed.has(copy.item.localPath));
    await pool(copies, concurrency || (store.kind === "cloud" ? 4 : 8), async (copy) => {
      try {
        await store.copy(copy.item.localPath, copy.to);
        fresh[copy.item.localPath] = ledgerEntry(copy.local, copy.to, copy.entry.date);
      } catch (error) {
        result.errors.push({ item: copy.item, error: error.message });
        delete fresh[copy.item.localPath];
      }
      done += 1;
      if (done % 200 === 0) {
        log(`copied ${done}/${copies.length}`);
        await saveLedger();
      }
    });
    for (const { item } of result.errors) delete fresh[item.localPath];
    await saveLedger();
  }

  const summary = summarize({ ...planned, discoveredExcluded, examplesPerKind, executed: !dryRun });
  return {
    ok: summary.counts.errors === 0,
    ...base,
    finishedAt: new Date().toISOString(),
    ...summary,
  };
}

// ------------------------------------------------------------------ status

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function readStatus(dataDir) {
  return readJsonFile(backupPaths(dataDir).status, {});
}

async function writeStatus(dataDir, changes) {
  const current = await readStatus(dataDir);
  await writeJsonFile(backupPaths(dataDir).status, { ...current, ...changes });
}

function lastRunRecord(result) {
  return {
    startedAt: result.startedAt,
    finishedAt: result.finishedAt || new Date().toISOString(),
    ok: Boolean(result.ok),
    waiting: Boolean(result.waiting),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
    ...(result.error ? { error: result.error } : {}),
    destination: result.destination || "",
    ...(result.counts ? { counts: result.counts, bytes: result.bytes } : {}),
    ...(result.errors?.length ? { errors: result.errors.slice(0, 20) } : {}),
  };
}

// ------------------------------------------------------------------ commands

function scheduleContext(options) {
  const env = options.env || process.env;
  return {
    platform: options.platform || process.platform,
    env,
    homeDir: options.homeDir || userHome(),
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    run: options.scheduleRunner,
    sleep: options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

/** The node the schedule names: the PATH entry for this node, which survives an upgrade. */
function stableNodePath() {
  let target;
  try { target = fs.realpathSync(process.execPath); } catch { return process.execPath; }
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    try { if (fs.realpathSync(path.join(directory, name)) === target) return path.join(directory, name); } catch {}
  }
  return process.execPath;
}

/** The installed runtime's cli.mjs when there is one, else this checkout's. */
async function scheduledCli() {
  const runtime = path.join(installPaths(await loadConfig().catch(() => null)).runtimeDir, "cli.mjs");
  try { await fsp.access(runtime); return runtime; } catch { return path.join(SCRIPT_DIR, "cli.mjs"); }
}

async function scheduleFor(options, settings, dataDir) {
  const device = deviceOf(settings);
  const hour = Number.isInteger(settings.hour) ? settings.hour : DEFAULT_HOUR;
  const ctx = scheduleContext(options);
  const cliPath = options.cliPath || await scheduledCli();
  const spec = backupScheduleSpec(ctx, {
    nodePath: options.nodePath || stableNodePath(),
    cliPath,
    logPath: backupPaths(dataDir).log,
    workingDirectory: path.dirname(cliPath),
    stateDir: backupPaths(dataDir).directory,
    hour,
    minute: scheduleMinute(device),
  });
  return { ctx, spec, hour, minute: scheduleMinute(device) };
}

function parseDestinationOptions(options) {
  if (options.folder !== undefined && options.cloud !== undefined) return { error: "give --folder or --cloud, not both" };
  if (options.folder !== undefined) {
    if (typeof options.folder !== "string" || !path.isAbsolute(options.folder)) return { error: "--folder takes an absolute folder path" };
    return { destination: { kind: "folder", path: path.resolve(options.folder) } };
  }
  if (options.cloud !== undefined) {
    const parsed = typeof options.cloud === "string" ? parseCloudDestination(options.cloud) : null;
    if (!parsed) return { error: "--cloud takes an rclone remote and an optional folder, as remote: or remote:folder" };
    return { destination: { kind: "cloud", ...parsed } };
  }
  return {};
}

async function backupStatus(options, dataDir) {
  const settings = await readSettings(dataDir);
  const status = await readStatus(dataDir);
  const running = status.running && processAlive(status.running.pid) ? status.running : null;
  // A run to a destination chosen before says nothing about the one chosen now.
  const lastRun = status.lastRun && settings.destination && status.lastRun.destination === destinationLabel(settings.destination) ? status.lastRun : null;
  const { ctx, spec, hour, minute } = await scheduleFor(options, settings, dataDir);
  const schedule = { hour, minute, ...(await backupScheduleStatus(ctx, spec).catch((error) => ({ registered: false, error: error.message }))) };
  let reachable;
  if (options.check === true && settings.destination) {
    const probe = await storeFor(settings.destination).probe().catch((error) => ({ ok: false, reason: "error", detail: error.message }));
    reachable = probe;
  }
  const state = !settings.destination ? "off"
    : running ? "running"
      : reachable ? (reachable.ok ? "ready" : "waiting")
        : lastRun?.waiting ? "waiting" : "ready";
  return {
    ok: true,
    state,
    destination: settings.destination ? { ...settings.destination, label: destinationLabel(settings.destination) } : null,
    device: deviceOf(settings),
    deviceSaved: validDeviceId(settings.device),
    schedule,
    running,
    ...(reachable ? { reachable } : {}),
    lastRun,
    lastSuccessAt: lastRun ? status.lastSuccessAt || null : null,
  };
}

async function backupSet(options, dataDir) {
  const settings = await readSettings(dataDir);
  const next = { ...settings };
  if (options.off === true) next.destination = null;
  else {
    const parsed = parseDestinationOptions(options);
    if (parsed.error) return { ok: false, error: parsed.error };
    if (parsed.destination?.kind === "folder") {
      let stat;
      try { stat = await fsp.stat(parsed.destination.path); } catch { stat = null; }
      if (!stat?.isDirectory()) return { ok: false, error: `${parsed.destination.path} is not a folder that exists now; connect the drive first` };
      parsed.destination.volumeRoot = await volumeRootOf(parsed.destination.path);
    }
    if (parsed.destination?.kind === "cloud") {
      const remotes = await rcloneRemotes();
      if (!remotes.installed) return { ok: false, error: "rclone is not installed on this computer" };
      if (!remotes.remotes.includes(parsed.destination.remote)) return { ok: false, error: `rclone has no remote named ${parsed.destination.remote}` };
    }
    if (parsed.destination) next.destination = parsed.destination;
  }
  if (options.device !== undefined) {
    if (!validDeviceId(options.device)) return { ok: false, error: "--device takes lower-case letters, digits and dashes (up to 40)" };
    next.device = options.device;
  }
  if (options.hour !== undefined) {
    const hour = Number(options.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: "--hour takes 0 to 23" };
    next.hour = hour;
  }
  // The device id is fixed the first time a destination is chosen, so a renamed
  // computer keeps writing under the same names.
  if (next.destination && !validDeviceId(next.device)) next.device = defaultDeviceId();
  await writeSettings(dataDir, next);
  return backupStatus(options, dataDir);
}

async function backupRun(options, dataDir) {
  const settings = await readSettings(dataDir);
  const parsed = parseDestinationOptions(options);
  if (parsed.error) return { ok: false, error: parsed.error };
  const destination = parsed.destination || settings.destination;
  if (!destination) return { ok: false, error: "no backup destination is set; choose one with backup set --folder or --cloud" };
  const dryRun = options.dryRun === true;
  const device = deviceOf(settings);
  const examplesPerKind = Number.isInteger(Number(options.examples)) && Number(options.examples) > 0 ? Number(options.examples) : 3;
  const log = options.verbose === true ? (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) : () => {};
  const run = () => runBackup({ destination, dataDir, device, dryRun, full: options.full === true, examplesPerKind, log, ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  if (dryRun) return run();

  const paths = backupPaths(dataDir);
  const lock = await acquireFileLock(paths.lock, { staleMs: 24 * 3_600_000, reclaimDeadImmediately: true });
  if (!lock) return { ok: false, busy: true, error: "another backup run is still going" };
  // Only the configured destination's runs are what the screen shows.
  const recorded = !parsed.destination;
  try {
    if (recorded) await writeStatus(dataDir, { running: { pid: process.pid, startedAt: new Date().toISOString() } });
    let result;
    try { result = await run(); } catch (error) { result = { ok: false, error: error.message, startedAt: new Date().toISOString(), destination: destinationLabel(destination) }; }
    if (recorded) {
      await writeStatus(dataDir, {
        running: null,
        lastRun: lastRunRecord(result),
        ...(result.ok ? { lastSuccessAt: result.finishedAt } : {}),
      });
    }
    return result;
  } finally {
    await releaseFileLock(lock);
  }
}

/** Starts a run in the background (the screen's button) and returns at once. */
async function backupStart(options, dataDir) {
  const settings = await readSettings(dataDir);
  if (!settings.destination) return { ok: false, error: "no backup destination is set" };
  const status = await readStatus(dataDir);
  if (status.running && processAlive(status.running.pid)) return { ok: true, started: false, running: status.running };
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "cli.mjs"), "backup", "run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  return { ok: true, started: true, pid: child.pid };
}

async function backupSchedule(action, options, dataDir) {
  if (action !== "on" && action !== "off") return { ok: false, error: "backup schedule takes on or off" };
  const settings = await readSettings(dataDir);
  if (options.hour !== undefined) {
    const hour = Number(options.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: "--hour takes 0 to 23" };
    settings.hour = hour;
  }
  if (action === "on" && !settings.destination) return { ok: false, error: "choose a destination first (backup set --folder or --cloud)" };
  if (!validDeviceId(settings.device)) settings.device = defaultDeviceId();
  await writeSettings(dataDir, settings);
  await fsp.mkdir(path.dirname(backupPaths(dataDir).log), { recursive: true });
  const { ctx, spec, hour, minute } = await scheduleFor(options, settings, dataDir);
  if (!spec) return { ok: false, error: `there is no scheduler for ${ctx.platform}` };
  try {
    const outcome = action === "on" ? await installBackupSchedule(ctx, spec) : await removeBackupSchedule(ctx, spec);
    return { ok: true, schedule: { hour, minute, ...outcome, ...(await backupScheduleStatus(ctx, spec)) } };
  } catch (error) {
    if (error?.code === "ERR_OS_REGISTRATION_UNDER_TEST") throw error;
    return { ok: false, error: error.message };
  }
}

/** `cli.mjs backup <action>`. */
export async function backupCommand(action, positional, options = {}) {
  const dataDir = options.dataDir || await defaultDataDir();
  if (action === "status") return backupStatus(options, dataDir);
  if (action === "set") return backupSet(options, dataDir);
  if (action === "run") return backupRun(options, dataDir);
  if (action === "start") return backupStart(options, dataDir);
  if (action === "schedule") return backupSchedule(positional[0], options, dataDir);
  if (action === "remotes") return rcloneRemotes();
  return { ok: false, error: `Unknown backup action: ${action}. Expected status, set, run, start, schedule or remotes.` };
}

export { ARCHIVE_FOLDER };
