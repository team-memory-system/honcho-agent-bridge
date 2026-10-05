#!/usr/bin/env node
// Rebuild driver for the full re-import of the person's Honcho memory into a fresh
// server (runbook full-2026-10). Deleted again after the cutover.
//
//   plan    read every source, decide what goes in, stage the files, write a manifest
//           sorted by each entry's first turn across all sources, and a summary.
//           Makes no HTTP request.
//   run     guard the server, then send the manifest in order: collector kinds by
//           running collector.mjs on the staged files, direct kinds by posting the
//           staged payloads. Resumable from a ledger in the run directory.
//   verify  compare each session's message count, first/last created_at and peers on
//           the server with the manifest (read-only list requests), plus a
//           per-source and per-peer table.
//
// Kinds:
//   through the collector: claude, codex, agy, grok, chatgpt (one conversation each)
//   posted directly:       hermes, cursor, cursor-vscdb, gemini, grok-index, old-db,
//                          codex-extra
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProvider } from "./providers/index.mjs";
import { classifyAutomation as classifyCodexAutomation } from "./providers/codex.mjs";
import { classifyAutomation as classifyClaudeAutomation } from "./providers/claude.mjs";
import { conversationOrigin, parseHistory } from "./providers/agy.mjs";
import { parseConversation } from "./providers/chatgpt.mjs";
import { readConversations } from "./providers/chatgpt-archive.mjs";
import { codexSegmentId, turnHashCandidates } from "./turn-identity.mjs";
import { environmentAccess, fetchHoncho, honchoHeaders } from "./honcho-access.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DRIVER_PATH = fileURLToPath(import.meta.url);
export const DEFAULT_COLLECTOR = path.join(HERE, "collector.mjs");
export const DEFAULT_TZ = "Asia/Seoul";
export const DEFAULT_CHAR_LIMIT = 24000;
export const DEFAULT_MAX_FAILURES = 3;
export const BATCH_LIMIT = 100;
export const WORKSPACE_CONFIGURATION = Object.freeze({
  summary: Object.freeze({ enabled: false }),
  dream: Object.freeze({ enabled: false }),
});
export const COLLECTOR_KINDS = new Set(["claude", "codex", "agy", "grok", "chatgpt"]);
export const DIRECT_KINDS = new Set(["hermes", "cursor", "cursor-vscdb", "gemini", "grok-index", "old-db", "codex-extra"]);
const ROOT_PROVIDERS = new Set(["claude", "codex", "agy", "grok"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Folders a Drive backup keeps beside the conversations; none of them is one.
const SKIP_DIRS = new Set(["_부속자료", "_아카이브", "_작업기록", "subagents", "tool-results"]);
const VERSION_DIR = "_원본버전";
// Without per-turn times, turn i of n is placed at start + i × min(this, (end − start)/n).
export const MAX_INTERPOLATION_STEP_MS = 60_000;
export const NO_END_STEP_MS = 1_000;

const nfc = (value) => String(value).normalize("NFC");
const sha = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function zoneOffsetMs(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(instantMs / 1000) * 1000;
}

/** "2026-09-01", "2026-09-01T09:30[:00[.123456]]" read as wall time in `timeZone` → epoch ms. */
export function zonedInstant(local, timeZone = DEFAULT_TZ) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(String(local || "").trim());
  if (!match) throw new Error(`not a local date or time: ${local}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", fraction = ""] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let instant = wall - zoneOffsetMs(wall, timeZone);
  instant = wall - zoneOffsetMs(instant, timeZone);
  return instant + (fraction ? Math.floor(Number(`0.${fraction}`) * 1000) : 0);
}

/** An instant given with an offset or Z, or a wall time in `timeZone` → epoch ms (NaN when neither). */
export function parseInstant(value, timeZone = DEFAULT_TZ) {
  if (value == null || value === "") return NaN;
  if (typeof value === "number") return value > 1_000_000_000_000 ? value : value * 1000;
  const text = String(value).trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return Date.parse(text);
  try {
    return zonedInstant(text, timeZone);
  } catch {
    return Date.parse(text);
  }
}

/** Epoch ms → "2026-09-01T09:00:00.000+09:00" in `timeZone`. */
export function formatInZone(ms, timeZone = DEFAULT_TZ) {
  const offset = zoneOffsetMs(ms, timeZone);
  const wall = new Date(ms + offset).toISOString().slice(0, 23);
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset) / 60000;
  return `${wall}${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Times for n turns that have none of their own: turn i at start + i × step, where
 * step = min(60 s, (end − start)/n) when the end is known, else 1 s.
 */
export function interpolateTimes(n, startMs, endMs = null) {
  let step = NO_END_STEP_MS;
  if (Number.isFinite(endMs)) step = Math.min(MAX_INTERPOLATION_STEP_MS, Math.max(0, endMs - startMs) / Math.max(1, n));
  return Array.from({ length: n }, (_, index) => Math.round(startMs + index * step));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** "claude:drive:/path" → { provider, machine, dir }. */
/**
 * The person's peer id on the target server. There is no default: it is
 * install-specific, and every user turn of the plan and the run is stored under it.
 */
export function requireUserPeer(options, command) {
  const peer = String(options?.userPeer || "").trim();
  if (!peer) throw new Error(`${command} needs --user-peer <name>: the person's peer id on the target server (there is no default)`);
  return peer;
}

export function parseRoot(value) {
  const match = /^([a-z]+):([A-Za-z0-9_.-]+):(.+)$/.exec(String(value || ""));
  if (!match || !ROOT_PROVIDERS.has(match[1])) throw new Error(`--root must be <claude|codex|agy|grok>:<machine>:<dir>, got: ${value}`);
  return { provider: match[1], machine: match[2], dir: path.resolve(match[3]) };
}

/** Every uuid in a file name (plain, .pre-archive, device-tagged and segment names). */
export function uuidsInName(name) {
  return [...String(path.basename(name)).matchAll(UUID)].map((match) => match[0].toLowerCase());
}

/** The uuids in an id-list file: any uuid anywhere in it, one or many per line. */
export async function readIdList(filePath) {
  if (!filePath) return new Set();
  const text = await fsp.readFile(filePath, "utf8");
  return new Set([...text.matchAll(UUID)].map((match) => match[0].toLowerCase()));
}
export const readExcludeIds = readIdList;

/** How many Honcho messages collector.mjs makes of one turn (its splitContent). */
export function splitContent(text, limit = DEFAULT_CHAR_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + Math.floor(limit / 2)) end = newline;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}
export const splitCount = (text, limit = DEFAULT_CHAR_LIMIT) => splitContent(text, limit).length;

/** Rough token estimate: Latin text ≈ 4 characters a token, other scripts (Hangul, CJK) ≈ 1 a token. */
export function approxTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 120) || "x";
}

/** Every file under `dir` that `accept(name)` takes, outside SKIP_DIRS; `version` marks _원본버전 copies. */
export async function walkFiles(dir, accept) {
  const files = [];
  async function walk(current, inVersion) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (current === dir) throw new Error(`cannot read ${dir}: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      const name = nfc(entry.name);
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(full, inVersion || name === VERSION_DIR);
      } else if (entry.isFile() && accept(name)) {
        files.push({ path: full, name, version: inVersion });
      }
    }
  }
  await walk(dir, false);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function statOf(filePath) {
  const stat = await fsp.stat(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

/** A copy of `source` at `target` (a hard link when the file system allows; same bytes either way). */
export async function stageFile(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rm(target, { force: true });
  try {
    await fsp.link(source, target);
  } catch {
    await fsp.copyFile(source, target);
  }
  return target;
}

async function writeJson(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(value), "utf8");
  return target;
}

export async function readJsonl(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const items = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      // A line cut short by a crash; what it described is simply done again.
    }
  }
  return items;
}

/**
 * The head of a transcript: a Claude session's first `entrypoint`, a Codex rollout's
 * first session_meta (source.subagent, thread_source).
 */
export async function readSessionHead(provider, filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const head = { entrypoint: null, subagent: false, sessionMeta: false };
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (provider === "claude") {
        if (typeof record?.entrypoint === "string" && record.entrypoint) {
          head.entrypoint = record.entrypoint;
          break;
        }
      } else if (record?.type === "session_meta" && record.payload && typeof record.payload === "object") {
        const source = record.payload.source;
        head.sessionMeta = true;
        head.subagent = Boolean((source && typeof source === "object" && source.subagent) || record.payload.thread_source === "subagent");
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return head;
}

// ---------------------------------------------------------------------------
// Counting what an entry will become
// ---------------------------------------------------------------------------

function emptyCounts() {
  return { turns: 0, messages: 0, user: 0, automation: 0, assistant: 0, tokens_user: 0, peers: {} };
}

function addTurnToCounts(counts, { role, content, peer, automated, charLimit }) {
  const pieces = splitCount(content, charLimit);
  counts.turns += 1;
  counts.messages += pieces;
  counts.peers[peer] = (counts.peers[peer] || 0) + pieces;
  if (role === "user") {
    if (automated) counts.automation += 1;
    else {
      counts.user += 1;
      counts.tokens_user += approxTokens(content);
    }
  } else counts.assistant += 1;
}

function timesOf(turns) {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const turn of turns) {
    const ms = Date.parse(turn.created_at);
    if (!Number.isFinite(ms)) continue;
    if (ms < startMs) startMs = ms;
    if (ms > endMs) endMs = ms;
  }
  return { startMs, endMs };
}

function missingTimes(turns) {
  return turns.filter((turn) => !turn.created_at || !Number.isFinite(Date.parse(turn.created_at)));
}

/**
 * The turns the collector would send for `files` of one session, in order, given the
 * hashes `seen` already imported (run state): the same identity the collector uses,
 * so a turn repeated across versions is counted once.
 */
export function newTurns(sessionId, parsedFiles, seen = new Set()) {
  const known = new Set(seen);
  const out = [];
  for (const { parsed, segmentId = null, file } of parsedFiles) {
    for (const turn of parsed.turns) {
      const identity = segmentId ? { ...turn, segment_id: segmentId } : turn;
      const candidates = turnHashCandidates(sessionId, identity);
      if (candidates.some((candidate) => known.has(candidate))) continue;
      candidates.forEach((candidate) => known.add(candidate));
      out.push({ ...turn, _metadata: parsed.metadata, _file: file });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan: sources through the collector
// ---------------------------------------------------------------------------

function exclusion(base, reason, detail) {
  return { excluded: true, ...base, reason, ...(detail ? { detail } : {}) };
}

function archivedBy(files, parsedIds, excludeIds) {
  for (const file of files) {
    const hit = uuidsInName(file).find((uuid) => excludeIds.has(uuid));
    if (hit) return hit;
  }
  for (const id of parsedIds) {
    const hit = [...String(id || "").matchAll(UUID)].map((m) => m[0].toLowerCase()).find((uuid) => excludeIds.has(uuid));
    if (hit) return hit;
  }
  return null;
}

/** Common checks of a collector entry's new turns; returns an exclusion or the time span. */
function checkTurns(base, turns, ctx) {
  if (!turns.length) return { exclusion: exclusion(base, ctx.catchUp ? "no-new-turns" : "no-turns") };
  const missing = missingTimes(turns);
  if (missing.length) {
    return { exclusion: exclusion(base, "turn-without-created_at", `${missing.length} turn(s), first at line ${missing[0].line_index}`) };
  }
  const { startMs, endMs } = timesOf(turns);
  if (ctx.toMs != null && startMs >= ctx.toMs) return { exclusion: { ...exclusion(base, "after-to"), start: iso(startMs) } };
  return { startMs, endMs };
}

function collectorEntry(base, turns, { startMs, endMs }, ctx, classify) {
  const counts = emptyCounts();
  for (const turn of turns) {
    let peer = `assistant_${base.provider}`;
    let automated = false;
    if (turn.role === "user") {
      automated = classify ? classify(turn) : false;
      peer = automated ? `automation_${base.provider}` : ctx.userPeer;
    }
    addTurnToCounts(counts, { role: turn.role, content: turn.content, peer, automated, charLimit: ctx.charLimit });
  }
  return {
    excluded: false,
    ...base,
    start: iso(startMs),
    end: iso(endMs),
    ...(ctx.catchUp ? { first_new: iso(startMs) } : {}),
    ...counts,
  };
}

async function parseOrExclude(provider, filePath, base, exclusions, hookInput = {}) {
  try {
    return await getProvider(provider).parseTranscript(filePath, hookInput);
  } catch (error) {
    exclusions.push(exclusion({ ...base, file: filePath }, "parse-error", String(error?.message || error)));
    return null;
  }
}

/** Claude: one entry per parsed session id, base file first, then every other version. */
async function planClaude(roots, ctx) {
  const entries = [];
  const exclusions = [];
  const groups = new Map();
  // Pass 1: each file's session id and shape only, so thousands of transcripts are
  // never held in memory at once.
  for (const root of roots) {
    const files = await walkFiles(root.dir, (name) => name.endsWith(".jsonl") && name !== "history.jsonl");
    for (const file of files) {
      if (!ctx.fileWanted(file.path)) continue;
      const base = { kind: "claude", provider: "claude", machine: root.machine };
      const parsed = await parseOrExclude("claude", file.path, base, exclusions);
      if (!parsed) continue;
      const stat = await statOf(file.path);
      const lastMs = Math.max(0, timesOf(parsed.turns).endMs);
      const item = { ...file, machine: root.machine, ...stat, lastMs, originalId: parsed.metadata.original_session_id };
      if (!groups.has(parsed.session_id)) groups.set(parsed.session_id, []);
      groups.get(parsed.session_id).push(item);
    }
  }
  // Pass 2: one session at a time, its files parsed again in order.
  for (const [sessionId, items] of groups) {
    const mains = items.filter((item) => !item.version);
    const pool = mains.length ? mains : items;
    const first = [...pool].sort((a, b) => Number(b.machine === ctx.localMachine) - Number(a.machine === ctx.localMachine) || b.size - a.size || a.path.localeCompare(b.path))[0];
    const rest = items.filter((item) => item !== first).sort((a, b) => a.lastMs - b.lastMs || a.path.localeCompare(b.path));
    const ordered = [first, ...rest];
    const base = { kind: "claude", provider: "claude", machine: first.machine, session_id: sessionId, file: first.path };
    const archived = archivedBy(ordered.map((item) => item.path), ordered.map((item) => item.originalId), ctx.excludeIds);
    if (archived) {
      exclusions.push(exclusion(base, "archived", archived));
      continue;
    }
    const parsedFiles = [];
    for (const item of ordered) {
      const parsed = await parseOrExclude("claude", item.path, base, exclusions);
      if (parsed) parsedFiles.push({ parsed, file: item.path });
    }
    const turns = newTurns(sessionId, parsedFiles, ctx.seenHashes("claude", sessionId));
    const checked = checkTurns(base, turns, ctx);
    if (checked.exclusion) {
      exclusions.push(checked.exclusion);
      continue;
    }
    const files = [];
    for (const [index, item] of ordered.entries()) {
      const role = index === 0 ? "base" : item.version ? "version" : "copy";
      const sub = index === 0 ? "base" : `v${index}`;
      const staged = path.join(ctx.stageDir, "claude", safeName(sessionId), sub, item.name);
      files.push({ source: item.path, staged, role, adds_turns: turns.filter((turn) => turn._file === item.path).length });
    }
    const entry = collectorEntry(base, turns, checked, ctx, (turn) => classifyClaudeAutomation(turn.content, turn._metadata)[0]);
    entry.files = files;
    entry.versions = files.length - 1;
    entry.versions_adding_turns = files.slice(1).filter((file) => file.adds_turns > 0).length;
    entries.push(entry);
  }
  return { entries, exclusions };
}

function codexTurnKey(turn) {
  return `${turn.role}\u0000${String(turn.content).replace(/\s+/g, " ").trim()}\u0000${turn.created_at || ""}`;
}

/**
 * Codex: the main-path file of each rollout only (segments are entries of their own).
 * Turns found only in a version are posted directly as a codex-extra entry right after
 * the main file, never through the collector.
 */
async function planCodex(roots, ctx) {
  const entries = [];
  const exclusions = [];
  const extrasSummary = { versions_compared: 0, version_only_ids: 0, mains_with_extras: 0, extra_turns: 0, extra_messages: 0 };
  for (const root of roots) {
    const files = await walkFiles(root.dir, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
    const mainsByName = new Map();
    const versionsByName = new Map();
    for (const file of files) {
      if (file.version) {
        if (!versionsByName.has(file.name)) versionsByName.set(file.name, []);
        versionsByName.get(file.name).push(file);
      } else mainsByName.set(file.name, file);
    }
    // A rollout found only as versions: its largest version stands in for the main file.
    if (!ctx.catchUp) {
      for (const [name, versions] of versionsByName) {
        if (mainsByName.has(name)) continue;
        const sized = await Promise.all(versions.map(async (file) => ({ file, size: (await statOf(file.path)).size })));
        sized.sort((a, b) => b.size - a.size || a.file.path.localeCompare(b.file.path));
        mainsByName.set(name, { ...sized[0].file, version_only: true });
        versionsByName.set(name, sized.slice(1).map((item) => item.file));
        extrasSummary.version_only_ids += 1;
      }
    }
    for (const [name, main] of [...mainsByName].sort((a, b) => a[1].path.localeCompare(b[1].path))) {
      if (!ctx.fileWanted(main.path)) continue;
      const baseNoId = { kind: "codex", provider: "codex", machine: root.machine, file: main.path };
      const parsed = await parseOrExclude("codex", main.path, baseNoId, exclusions);
      if (!parsed) continue;
      const sessionId = parsed.session_id;
      const segmentId = codexSegmentId(main.path, parsed.metadata.original_session_id);
      const base = { ...baseNoId, session_id: sessionId, ...(segmentId ? { segment_id: segmentId } : {}) };
      const archived = archivedBy([main.path], [parsed.metadata.original_session_id], ctx.excludeIds);
      if (archived) {
        exclusions.push(exclusion(base, "archived", archived));
        continue;
      }
      const head = await readSessionHead("codex", main.path);
      if (head.subagent) {
        exclusions.push(exclusion(base, "codex-subagent"));
        continue;
      }
      const seen = ctx.seenHashes("codex", sessionId);
      const turns = newTurns(sessionId, [{ parsed, segmentId, file: main.path }], seen);
      const checked = checkTurns(base, turns, ctx);
      if (checked.exclusion) {
        exclusions.push(checked.exclusion);
        continue;
      }
      const entry = collectorEntry(base, turns, checked, ctx, (turn) => classifyCodexAutomation(turn.content, parsed.metadata)[0]);
      entry.files = [{ source: main.path, staged: path.join(ctx.stageDir, "codex", root.machine, name), role: main.version_only ? "version-only" : "main" }];
      entries.push(entry);

      // Versions: turns that only an older copy holds.
      const versions = ctx.catchUp ? [] : versionsByName.get(name) || [];
      if (!versions.length) continue;
      const known = new Set(parsed.turns.map(codexTurnKey));
      const extras = [];
      for (const version of versions) {
        extrasSummary.versions_compared += 1;
        const versionParsed = await parseOrExclude("codex", version.path, base, exclusions);
        if (!versionParsed) continue;
        for (const turn of versionParsed.turns) {
          const key = codexTurnKey(turn);
          if (known.has(key)) continue;
          known.add(key);
          extras.push({ turn, metadata: versionParsed.metadata, file: version.path });
        }
      }
      if (!extras.length) continue;
      const extraEntry = codexExtraEntry(entry, extras, ctx);
      if (extraEntry) {
        entries.push(extraEntry);
        extrasSummary.mains_with_extras += 1;
        extrasSummary.extra_turns += extraEntry.turns;
        extrasSummary.extra_messages += extraEntry.messages;
      }
    }
  }
  return { entries, exclusions, extrasSummary };
}

function codexExtraEntry(mainEntry, extras, ctx) {
  const timed = extras.filter(({ turn }) => Number.isFinite(Date.parse(turn.created_at || "")));
  if (!timed.length) return null;
  const turns = timed.map(({ turn, metadata, file }) => {
    let peer = "assistant_codex";
    let automationKind = null;
    if (turn.role === "user") {
      const [automated, kind] = classifyCodexAutomation(turn.content, metadata);
      peer = automated ? "automation_codex" : ctx.userPeer;
      automationKind = automated ? kind : null;
    }
    return {
      role: turn.role,
      content: turn.content,
      created_at: turn.created_at,
      created_at_source: "original",
      peer,
      automation_kind: automationKind,
      hash: `codex-extra:${sha({ session: mainEntry.session_id, role: turn.role, created_at: turn.created_at, content: turn.content })}`,
      extra: { codex_version_path: file, codex_line_index: turn.line_index, codex_role: turn.role },
    };
  });
  turns.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return directEntry(ctx, {
    kind: "codex-extra",
    source: "codex",
    machine: mainEntry.machine,
    sessionId: mainEntry.session_id,
    file: mainEntry.file,
    sessionMetadata: { original_session_id: mainEntry.session_id.replace(/^codex-/, "") },
    turns,
    after: mainEntry,
  });
}

function agyConversationId(file) {
  const parts = file.path.split(path.sep).map(nfc);
  const brain = parts.lastIndexOf("brain");
  if (brain >= 0 && parts[brain + 1]) return { id: parts[brain + 1], product: parts[brain - 1] || null };
  return { id: parts.at(-2), product: null };
}

/** agy: one file per conversation (transcript_full.jsonl, else transcript.jsonl), staged under brain/<id>/. */
async function planAgy(roots, ctx) {
  const entries = [];
  const exclusions = [];
  const origins = {};
  for (const root of roots) {
    const files = await walkFiles(root.dir, (name) => name === "transcript_full.jsonl" || name === "transcript.jsonl");
    const byConversation = new Map();
    for (const file of files) {
      const { id, product } = agyConversationId(file);
      const current = byConversation.get(id);
      if (!current || (file.name === "transcript_full.jsonl" && current.file.name !== "transcript_full.jsonl")) {
        byConversation.set(id, { file, product });
      }
    }
    for (const [id, { file, product }] of [...byConversation].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!ctx.fileWanted(file.path)) continue;
      const stagedProduct = product || (ctx.agyAppIds.has(id.toLowerCase()) ? "antigravity" : "antigravity-cli");
      const staged = path.join(ctx.stageDir, "agy", root.machine, stagedProduct, "brain", id, ".system_generated", "logs", file.name);
      await stageFile(file.path, staged);
      const base = { kind: "agy", provider: "agy", machine: root.machine, file: file.path };
      const parsed = await parseOrExclude("agy", staged, base, exclusions);
      if (!parsed) continue;
      const entryBase = { ...base, session_id: parsed.session_id };
      const archived = archivedBy([file.path], [id], ctx.excludeIds);
      if (archived) {
        exclusions.push(exclusion(entryBase, "archived", archived));
        continue;
      }
      const turns = newTurns(parsed.session_id, [{ parsed, file: staged }], ctx.seenHashes("agy", parsed.session_id));
      const checked = checkTurns(entryBase, turns, ctx);
      if (checked.exclusion) {
        exclusions.push(checked.exclusion);
        continue;
      }
      const origin = conversationOrigin(parsed, ctx.agyHistory);
      origins[origin] = (origins[origin] || 0) + 1;
      const entry = collectorEntry(entryBase, turns, checked, ctx, () => origin === "unlisted");
      entry.agy_origin = origin;
      entry.files = [{ source: file.path, staged, role: "main", staged_product: stagedProduct }];
      entries.push(entry);
    }
  }
  return { entries, exclusions, origins };
}

/** Grok CLI sessions with a chat_history.jsonl; staged as <session id>/chat_history.jsonl. */
async function planGrokFiles(roots, ctx) {
  const entries = [];
  const exclusions = [];
  for (const root of roots) {
    const files = await walkFiles(root.dir, (name) => name === "chat_history.jsonl");
    for (const file of files) {
      if (file.version || !ctx.fileWanted(file.path)) continue;
      const sessionDir = path.dirname(file.path);
      const sessionName = path.basename(sessionDir);
      const staged = path.join(ctx.stageDir, "grok", root.machine, sessionName, file.name);
      await stageFile(file.path, staged);
      const summary = path.join(sessionDir, "summary.json");
      if (fs.existsSync(summary)) await stageFile(summary, path.join(path.dirname(staged), "summary.json"));
      const base = { kind: "grok", provider: "grok", machine: root.machine, file: file.path };
      const parsed = await parseOrExclude("grok", staged, base, exclusions);
      if (!parsed) continue;
      const entryBase = { ...base, session_id: parsed.session_id };
      const archived = archivedBy([file.path], [sessionName], ctx.excludeIds);
      if (archived) {
        exclusions.push(exclusion(entryBase, "archived", archived));
        continue;
      }
      const turns = newTurns(parsed.session_id, [{ parsed, file: staged }], ctx.seenHashes("grok", parsed.session_id));
      const checked = checkTurns(entryBase, turns, ctx);
      if (checked.exclusion) {
        exclusions.push(checked.exclusion);
        continue;
      }
      const entry = collectorEntry(entryBase, turns, checked, ctx, null);
      entry.files = [{ source: file.path, staged, role: "main" }];
      entries.push(entry);
    }
  }
  return { entries, exclusions };
}

function newerCopy(candidate, existing) {
  const a = candidate.metadata.updated_at || "";
  const b = existing.metadata.updated_at || "";
  if (a !== b) return a > b;
  return candidate.turns.length > existing.turns.length;
}

/**
 * The export split into one file per conversation, as loadExport would read it: the
 * same parser, and the newer copy of a conversation found twice. Each file holds a
 * one-conversation array, so `collector.mjs --provider chatgpt --export <file>`
 * imports exactly that conversation.
 */
export async function splitChatGptExport(exportPath, outDir) {
  const kept = new Map();
  let read = 0;
  for await (const { conversation } of readConversations(exportPath, {})) {
    read += 1;
    let parsed;
    try {
      parsed = parseConversation(conversation);
    } catch {
      continue;
    }
    const existing = kept.get(parsed.session_id);
    if (existing && !newerCopy(parsed, existing.parsed)) continue;
    kept.set(parsed.session_id, { parsed, conversation });
  }
  const files = [];
  for (const [sessionId, { parsed, conversation }] of kept) {
    const target = path.join(outDir, `${safeName(parsed.metadata.original_session_id || sessionId)}.json`);
    await writeJson(target, [conversation]);
    files.push({ session_id: sessionId, file: target, parsed });
  }
  return { read, files };
}

async function planChatGpt(exportPath, ctx) {
  const entries = [];
  const exclusions = [];
  if (!exportPath) return { entries, exclusions, split: null };
  const split = await splitChatGptExport(exportPath, path.join(ctx.stageDir, "chatgpt"));
  for (const { session_id: sessionId, file, parsed } of split.files) {
    const base = { kind: "chatgpt", provider: "chatgpt", machine: "export", file, session_id: sessionId };
    const turns = newTurns(sessionId, [{ parsed, file }], ctx.seenHashes("chatgpt", sessionId));
    const checked = checkTurns(base, turns, ctx);
    if (checked.exclusion) {
      exclusions.push(checked.exclusion);
      continue;
    }
    const entry = collectorEntry(base, turns, checked, ctx, null);
    entry.files = [{ source: exportPath, staged: file, role: "conversation" }];
    entries.push(entry);
  }
  return { entries, exclusions, split: { conversations_read: split.read, conversations_kept: split.files.length } };
}

// ---------------------------------------------------------------------------
// Plan: sources posted directly
// ---------------------------------------------------------------------------

const AGENT_PEER = (peer) => peer.startsWith("assistant_") || peer.startsWith("automation_");

/**
 * A direct entry: the session and its messages written to a staged payload the run
 * posts as is. `turns` are { role, content, created_at, created_at_source, peer,
 * hash, automation_kind?, extra? } in time order.
 */
function directEntry(ctx, { kind, source, machine, sessionId, file, sessionMetadata = {}, turns, after = null }) {
  const counts = emptyCounts();
  const messages = [];
  const peers = new Set();
  for (const turn of turns) {
    const automated = turn.role === "user" && turn.peer !== ctx.userPeer;
    addTurnToCounts(counts, { role: turn.role, content: turn.content, peer: turn.peer, automated, charLimit: ctx.charLimit });
    peers.add(turn.peer);
    const chunks = splitContent(turn.content, ctx.charLimit);
    chunks.forEach((chunk, index) => {
      const metadata = {
        source,
        agent_provider: source,
        memory_importer: "rebuild_direct",
        rebuild_kind: kind,
        memory_origin: turn.role === "user" ? (turn.peer === ctx.userPeer ? `${source}_direct_user` : `${source}_automation`) : `${source}_assistant`,
        direct_user: turn.role === "user" && turn.peer === ctx.userPeer,
        source_turn_hash: turn.hash,
        created_at_source: turn.created_at_source,
        [`${source}_role`]: turn.role,
        ...(turn.automation_kind ? { automation_kind: turn.automation_kind } : {}),
        ...(turn.extra || {}),
      };
      if (chunks.length > 1) {
        metadata.split_part = index + 1;
        metadata.split_total = chunks.length;
      }
      messages.push({ peer_id: turn.peer, content: chunk, created_at: turn.created_at, metadata });
    });
  }
  const { startMs, endMs } = timesOf(turns);
  const payloadPath = path.join(ctx.stageDir, "direct", kind, `${safeName(sessionId)}.json`);
  const peerConfig = {};
  for (const peer of [...peers].sort()) peerConfig[peer] = { observe_me: !AGENT_PEER(peer), observe_others: false };
  const payload = {
    kind,
    session: {
      id: sessionId,
      metadata: { ...sessionMetadata, source, agent_provider: source, memory_importer: "rebuild_direct", rebuild_kind: kind },
      peers: peerConfig,
    },
    messages,
  };
  ctx.pendingPayloads.push([payloadPath, payload]);
  return {
    excluded: false,
    kind,
    provider: source,
    machine,
    session_id: sessionId,
    file,
    payload: payloadPath,
    start: iso(after ? Date.parse(after.start) : startMs),
    end: iso(endMs),
    first_turn: iso(startMs),
    ...(after ? { after_file: after.file } : {}),
    interpolated: turns.filter((turn) => turn.created_at_source === "interpolated").length,
    ...counts,
  };
}

// Sessions Hermes runs by itself: scheduled jobs, API calls and its background curator.
function hermesAutomation(source) {
  return source === "cron" || source === "api_server" || source === "curator";
}

// Text Hermes writes itself into user/assistant rows when it compacts or resumes a
// session; never the person's words.
const HERMES_OWN_TEXT = [
  /^\[CONTEXT COMPACTION/,
  /^\[Your active task list was preserved across context compression\]/,
  /^\[System note:/,
  /^You've reached the maximum number of tool-calling iterations allowed\./,
];
export const isHermesOwnText = (text) => HERMES_OWN_TEXT.some((pattern) => pattern.test(String(text || "").trim()));

// The 04-13/14 persona burst: scheduled runs whose prompt is a {"persona": …} JSON
// object. Told apart by that prompt, not by date: the person's own Discord and CLI
// sessions of those two days stay theirs.
const HERMES_PERSONA_PROMPT = /^\s*\{\s*"persona"\s*:/;
export const isHermesPersonaPrompt = (text) => HERMES_PERSONA_PROMPT.test(String(text || ""));
const hasPersonaPrompt = (messages) => messages.some((message) => message.role === "user" && isHermesPersonaPrompt(message.content));

function hermesText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

async function openSqlite(filePath) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(filePath, { readOnly: true });
}

/** Hermes sessions from state.db: user and assistant rows only, Hermes' own handoff text left out. */
export async function readHermesStateDb(dbPath) {
  const db = await openSqlite(dbPath);
  try {
    const sessions = db.prepare("SELECT id, source, parent_session_id, started_at, ended_at, end_reason, title, user_id FROM sessions").all();
    const rows = db
      .prepare("SELECT id, session_id, role, content, timestamp FROM messages WHERE role IN ('user','assistant') ORDER BY session_id, timestamp, id")
      .all();
    const bySession = new Map();
    for (const row of rows) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
      bySession.get(row.session_id).push(row);
    }
    const parents = new Map(sessions.map((session) => [session.id, session.parent_session_id]));
    const stats = { sessions: sessions.length, rows: rows.length, own_text: 0, copied_from_parent: 0, empty: 0 };
    const out = [];
    for (const session of sessions) {
      const ancestorTexts = new Set();
      let parent = session.parent_session_id;
      const visited = new Set();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        for (const row of bySession.get(parent) || []) ancestorTexts.add(`${row.role}\u0000${hermesText(row.content)}`);
        parent = parents.get(parent);
      }
      const messages = [];
      for (const row of bySession.get(session.id) || []) {
        const text = hermesText(row.content);
        if (!text) {
          stats.empty += 1;
          continue;
        }
        if (isHermesOwnText(text)) {
          stats.own_text += 1;
          continue;
        }
        // A child session (compression, reset) starts with copies of its parent's rows.
        if (session.parent_session_id && ancestorTexts.has(`${row.role}\u0000${text}`)) {
          stats.copied_from_parent += 1;
          continue;
        }
        messages.push({ id: row.id, role: row.role, content: text, timestamp: row.timestamp });
      }
      out.push({ ...session, messages });
    }
    return { sessions: out, stats };
  } finally {
    db.close();
  }
}

function hermesSessionIdFromName(name) {
  return name.replace(/\.jsonl?$/, "").replace(/^session_/, "");
}

/** One Hermes JSON (or JSONL) session file → { id, platform, start, end, messages[{role, content, timeMs?}] }. */
export async function readHermesFile(filePath, timeZone = DEFAULT_TZ) {
  const text = await fsp.readFile(filePath, "utf8");
  const name = nfc(path.basename(filePath));
  if (name.endsWith(".jsonl")) {
    const messages = [];
    let platform = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.role === "session_meta") {
        platform ??= row.platform || null;
        continue;
      }
      if (row.role !== "user" && row.role !== "assistant") continue;
      const content = hermesText(row.content);
      if (!content) continue;
      const timeMs = parseInstant(row.timestamp, timeZone);
      messages.push({ role: row.role, content, ...(Number.isFinite(timeMs) ? { timeMs } : {}) });
    }
    return { id: hermesSessionIdFromName(name), platform, start: null, end: null, messages, file: filePath };
  }
  const data = JSON.parse(text);
  const messages = [];
  for (const message of Array.isArray(data.messages) ? data.messages : []) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const content = hermesText(message.content);
    if (!content) continue;
    messages.push({ role: message.role, content });
  }
  return {
    id: String(data.session_id || hermesSessionIdFromName(name)),
    platform: data.platform || null,
    start: parseInstant(data.session_start, timeZone),
    end: parseInstant(data.last_updated, timeZone),
    messages,
    file: filePath,
  };
}

/** Copies of one session merged by role and text, the base's order first; a message only a copy holds goes after its predecessor there. */
export function mergeByRoleAndText(base, others) {
  const merged = base.map((message) => ({ ...message }));
  const keyOf = (message) => `${message.role}\u0000${message.content}`;
  const present = new Set(merged.map(keyOf));
  for (const copy of others) {
    let anchor = -1;
    for (const message of copy) {
      const key = keyOf(message);
      const at = merged.findIndex((item) => keyOf(item) === key);
      if (at >= 0) {
        anchor = at;
        continue;
      }
      if (present.has(key)) continue;
      merged.splice(anchor + 1, 0, { ...message });
      present.add(key);
      anchor += 1;
    }
  }
  return merged;
}

/**
 * A time for every message: its own when it has one (JSONL), otherwise interpolated.
 * With no time at all, turn i of n is at start + i × min(60 s, (end − start)/n); a
 * message without a time among timed ones takes the time before it (or after it,
 * at the start).
 */
export function fillTimes(messages, startMs, endMs) {
  if (!messages.some((message) => Number.isFinite(message.timeMs))) {
    return interpolateTimes(messages.length, startMs, endMs).map((ms) => ({ ms, source: "interpolated" }));
  }
  const out = [];
  let previous = null;
  for (const message of messages) {
    if (Number.isFinite(message.timeMs)) {
      previous = message.timeMs;
      out.push({ ms: message.timeMs, source: "original" });
    } else out.push({ ms: previous, source: "interpolated" });
  }
  const firstTimed = messages.find((message) => Number.isFinite(message.timeMs)).timeMs;
  for (const item of out) if (item.ms == null) item.ms = firstTimed;
  return out;
}

/**
 * Hermes: state.db for every session it holds (timed); the JSON/JSONL files for the
 * rest (copies merged by role and text, times interpolated when the file has none).
 * cron and api_server sessions and the persona burst go to automation_hermes.
 */
async function planHermes(dir, ctx) {
  const entries = [];
  const exclusions = [];
  const report = { state_db: null, state_db_sessions: 0, json_only_sessions: 0, persona_burst: 0, by_source: {} };
  if (!dir) return { entries, exclusions, report };
  const dbFiles = [];
  async function findDb(current) {
    let list;
    try {
      list = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await findDb(full);
      else if (entry.name === "state.db") dbFiles.push({ path: full, ...(await statOf(full)) });
    }
  }
  await findDb(path.join(dir, "_부속자료"));
  dbFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  const inDb = new Set();
  if (dbFiles.length) {
    report.state_db = dbFiles[0].path;
    const { sessions, stats } = await readHermesStateDb(dbFiles[0].path);
    report.state_db_rows = stats;
    for (const session of sessions) {
      inDb.add(session.id);
      report.state_db_sessions += 1;
      const sessionId = `hermes-${session.id}`;
      const base = { kind: "hermes", provider: "hermes", machine: "state.db", session_id: sessionId, file: dbFiles[0].path };
      if (!session.messages.length) {
        exclusions.push(exclusion(base, "no-turns", session.source));
        continue;
      }
      const persona = hasPersonaPrompt(session.messages);
      const automated = hermesAutomation(session.source) || persona;
      const kindLabel = persona ? "hermes_persona_burst" : `hermes_${session.source}`;
      if (persona) report.persona_burst += 1;
      const turns = session.messages.map((message) => ({
        role: message.role,
        content: message.content,
        created_at: iso(Math.round(message.timestamp * 1000)),
        created_at_source: "original",
        peer: message.role === "assistant" ? "assistant_hermes" : automated ? "automation_hermes" : ctx.userPeer,
        automation_kind: message.role === "user" && automated ? kindLabel : null,
        hash: `hermes:${session.id}:${message.id}`,
        extra: { hermes_message_id: message.id },
      }));
      const startMs = Math.min(...turns.map((turn) => Date.parse(turn.created_at)));
      if (ctx.toMs != null && startMs >= ctx.toMs) {
        exclusions.push({ ...exclusion(base, "after-to"), start: iso(startMs) });
        continue;
      }
      report.by_source[session.source] = (report.by_source[session.source] || 0) + 1;
      entries.push(
        directEntry(ctx, {
          kind: "hermes",
          source: "hermes",
          machine: "state.db",
          sessionId,
          file: dbFiles[0].path,
          sessionMetadata: {
            original_session_id: session.id,
            hermes_source: session.source,
            parent_session_id: session.parent_session_id || undefined,
            title: session.title || undefined,
            file_path: dbFiles[0].path,
          },
          turns,
        }),
      );
    }
  }

  // JSON and JSONL files, grouped by session id; the main copy first.
  const files = await walkFiles(dir, (name) => /^(?:session_.+\.json|\d{8}_\d{6}_[0-9a-f]+\.jsonl)$/.test(name));
  const groups = new Map();
  for (const file of files) {
    let read;
    try {
      read = await readHermesFile(file.path, ctx.timeZone);
    } catch (error) {
      exclusions.push(exclusion({ kind: "hermes", provider: "hermes", machine: "json", file: file.path }, "parse-error", String(error?.message || error)));
      continue;
    }
    if (inDb.has(read.id)) continue;
    if (!groups.has(read.id)) groups.set(read.id, []);
    groups.get(read.id).push({ ...read, version: file.version, size: (await statOf(file.path)).size });
  }
  for (const [id, copies] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    copies.sort((a, b) => Number(a.version) - Number(b.version) || b.messages.length - a.messages.length || b.size - a.size);
    const [first, ...rest] = copies;
    const sessionId = `hermes-${id}`;
    const base = { kind: "hermes", provider: "hermes", machine: "json", session_id: sessionId, file: first.file };
    const merged = mergeByRoleAndText(first.messages, rest.map((copy) => copy.messages)).filter((message) => !isHermesOwnText(message.content));
    if (!merged.length) {
      exclusions.push(exclusion(base, "no-turns"));
      continue;
    }
    const platform = first.platform || copies.find((copy) => copy.platform)?.platform || null;
    const startMs = Number.isFinite(first.start) ? first.start : Math.min(...merged.map((m) => m.timeMs).filter(Number.isFinite));
    if (!Number.isFinite(startMs)) {
      exclusions.push(exclusion(base, "no-time"));
      continue;
    }
    const endCandidates = copies.map((copy) => copy.end).filter(Number.isFinite);
    const endMs = endCandidates.length ? Math.max(...endCandidates) : null;
    const times = fillTimes(merged, startMs, endMs);
    const persona = hasPersonaPrompt(merged);
    const automated = hermesAutomation(platform) || id.startsWith("cron_") || persona;
    const kindLabel = persona ? "hermes_persona_burst" : `hermes_${platform || "json"}`;
    if (ctx.toMs != null && startMs >= ctx.toMs) {
      exclusions.push({ ...exclusion(base, "after-to"), start: iso(startMs) });
      continue;
    }
    report.json_only_sessions += 1;
    if (persona) report.persona_burst += 1;
    const occurrences = new Map();
    const turns = merged.map((message, index) => {
      const key = `${message.role}\u0000${message.content}`;
      const n = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, n);
      return {
        role: message.role,
        content: message.content,
        created_at: iso(times[index].ms),
        created_at_source: times[index].source,
        peer: message.role === "assistant" ? "assistant_hermes" : automated ? "automation_hermes" : ctx.userPeer,
        automation_kind: message.role === "user" && automated ? kindLabel : null,
        hash: `hermes-json:${id}:${sha(key)}:${n}`,
      };
    });
    turns.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    entries.push(
      directEntry(ctx, {
        kind: "hermes",
        source: "hermes",
        machine: "json",
        sessionId,
        file: first.file,
        sessionMetadata: { original_session_id: id, hermes_source: platform || undefined, file_path: first.file, copies: copies.length, persona_burst: persona || undefined },
        turns,
      }),
    );
  }
  return { entries, exclusions, report };
}

/** Cursor JSON exports: { composerId, createdAt, turns[{ role, text }] }, no per-turn times (1 s steps). */
async function planCursor(dir, ctx) {
  const entries = [];
  const exclusions = [];
  if (!dir) return { entries, exclusions };
  const files = await walkFiles(dir, (name) => name.endsWith(".json"));
  for (const file of files) {
    if (file.version) continue;
    const base = { kind: "cursor", provider: "cursor", machine: "json", file: file.path };
    let data;
    try {
      data = JSON.parse(await fsp.readFile(file.path, "utf8"));
    } catch (error) {
      exclusions.push(exclusion(base, "parse-error", String(error?.message || error)));
      continue;
    }
    const composerId = String(data.composerId || "").trim();
    const sessionId = `cursor-${composerId}`;
    const raw = (Array.isArray(data.turns) ? data.turns : [])
      .map((turn) => ({ role: turn?.role, content: typeof turn?.text === "string" ? turn.text.trim() : "" }))
      .filter((turn) => (turn.role === "user" || turn.role === "assistant") && turn.content);
    if (!composerId || !raw.length) {
      exclusions.push(exclusion({ ...base, session_id: sessionId }, "no-turns"));
      continue;
    }
    const startMs = parseInstant(data.createdAt, ctx.timeZone);
    if (!Number.isFinite(startMs)) {
      exclusions.push(exclusion({ ...base, session_id: sessionId }, "no-time"));
      continue;
    }
    if (ctx.toMs != null && startMs >= ctx.toMs) {
      exclusions.push({ ...exclusion({ ...base, session_id: sessionId }, "after-to"), start: iso(startMs) });
      continue;
    }
    const times = interpolateTimes(raw.length, startMs, null);
    const turns = raw.map((turn, index) => ({
      ...turn,
      created_at: iso(times[index]),
      created_at_source: "interpolated",
      peer: turn.role === "user" ? ctx.userPeer : "assistant_cursor",
      hash: `cursor:${composerId}:${index}`,
    }));
    entries.push(
      directEntry(ctx, {
        kind: "cursor",
        source: "cursor",
        machine: "json",
        sessionId,
        file: file.path,
        sessionMetadata: { original_session_id: composerId, file_path: file.path, title: typeof data.name === "string" ? data.name : undefined },
        turns,
      }),
    );
  }
  return { entries, exclusions };
}

/** The Cursor conversations taken from state.vscdb (conversations.jsonl): bubble times where there are any. */
async function planCursorVscdb(filePath, ctx, knownSessions) {
  const entries = [];
  const exclusions = [];
  if (!filePath) return { entries, exclusions };
  for (const row of await readJsonl(filePath)) {
    const composerId = String(row.composerId || "").trim();
    const sessionId = `cursor-${composerId}`;
    const base = { kind: "cursor-vscdb", provider: "cursor", machine: "state.vscdb", file: filePath, session_id: sessionId };
    if (knownSessions.has(sessionId)) {
      exclusions.push(exclusion(base, "duplicate", "also a Cursor JSON export"));
      continue;
    }
    const raw = (Array.isArray(row.turns) ? row.turns : []).filter((turn) => (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string" && turn.text.trim());
    if (!raw.length) {
      exclusions.push(exclusion(base, "no-turns"));
      continue;
    }
    // A bubble without a time sits 1 s after the one before it (the first, at the conversation's start).
    let previous = parseInstant(row.createdAt, ctx.timeZone);
    const turns = raw.map((turn) => {
      const own = parseInstant(turn.created_at, ctx.timeZone);
      const timeMs = Number.isFinite(own) ? own : Number.isFinite(previous) ? previous + NO_END_STEP_MS : NaN;
      if (Number.isFinite(timeMs)) previous = timeMs;
      return {
        role: turn.role,
        content: turn.text.trim(),
        created_at: Number.isFinite(timeMs) ? iso(timeMs) : null,
        created_at_source: Number.isFinite(own) ? "original" : "interpolated",
        peer: turn.role === "user" ? ctx.userPeer : "assistant_cursor",
        hash: `cursor-vscdb:${composerId}:${turn.bubble_id}`,
        extra: { cursor_bubble_id: turn.bubble_id },
      };
    });
    if (turns.some((turn) => !turn.created_at)) {
      exclusions.push(exclusion(base, "no-time"));
      continue;
    }
    const startMs = Math.min(...turns.map((turn) => Date.parse(turn.created_at)));
    if (ctx.toMs != null && startMs >= ctx.toMs) {
      exclusions.push({ ...exclusion(base, "after-to"), start: iso(startMs) });
      continue;
    }
    turns.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    entries.push(
      directEntry(ctx, {
        kind: "cursor-vscdb",
        source: "cursor",
        machine: "state.vscdb",
        sessionId,
        file: filePath,
        sessionMetadata: { original_session_id: composerId, title: row.name || undefined, file_path: "state.vscdb" },
        turns,
      }),
    );
  }
  return { entries, exclusions };
}

/** gemini-cli sessions: messages with ids and times; info rows are the CLI's own. */
async function planGemini(dir, ctx) {
  const entries = [];
  const exclusions = [];
  if (!dir) return { entries, exclusions };
  const files = await walkFiles(dir, (name) => name.startsWith("session-") && name.endsWith(".json"));
  for (const file of files) {
    if (file.version) continue;
    const base = { kind: "gemini", provider: "gemini", machine: "json", file: file.path };
    let data;
    try {
      data = JSON.parse(await fsp.readFile(file.path, "utf8"));
    } catch (error) {
      exclusions.push(exclusion(base, "parse-error", String(error?.message || error)));
      continue;
    }
    const short = String(data.sessionId || "").slice(0, 8) || path.basename(file.path, ".json").split("-").pop();
    const sessionId = `gemini-${short}`;
    const turns = [];
    for (const message of Array.isArray(data.messages) ? data.messages : []) {
      const role = message?.type === "user" ? "user" : message?.type === "gemini" ? "assistant" : null;
      if (!role) continue;
      const content = hermesText(message.content);
      const timeMs = parseInstant(message.timestamp, ctx.timeZone);
      if (!content || !Number.isFinite(timeMs)) continue;
      turns.push({
        role,
        content,
        created_at: iso(timeMs),
        created_at_source: "original",
        peer: role === "user" ? ctx.userPeer : "assistant_gemini",
        hash: `gemini:${data.sessionId || short}:${message.id}`,
        extra: { gemini_message_id: message.id },
      });
    }
    if (!turns.length) {
      exclusions.push(exclusion({ ...base, session_id: sessionId }, "no-turns"));
      continue;
    }
    const startMs = Math.min(...turns.map((turn) => Date.parse(turn.created_at)));
    if (ctx.toMs != null && startMs >= ctx.toMs) {
      exclusions.push({ ...exclusion({ ...base, session_id: sessionId }, "after-to"), start: iso(startMs) });
      continue;
    }
    entries.push(
      directEntry(ctx, {
        kind: "gemini",
        source: "gemini",
        machine: "json",
        sessionId,
        file: file.path,
        sessionMetadata: { original_session_id: data.sessionId, file_path: file.path },
        turns,
      }),
    );
  }
  return { entries, exclusions };
}

/** Grok's log: the times of each session's prompts and finished answers. */
export async function readGrokLog(filePath) {
  const events = new Map();
  if (!filePath) return events;
  const text = await fsp.readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.msg !== "prompt received" && row?.msg !== "agent response complete") continue;
    const sid = String(row.sid || "");
    const time = Date.parse(row.ts);
    if (!sid || !Number.isFinite(time)) continue;
    if (!events.has(sid)) events.set(sid, { prompts: [], responses: [] });
    events.get(sid)[row.msg === "prompt received" ? "prompts" : "responses"].push(time);
  }
  for (const value of events.values()) {
    value.prompts.sort((a, b) => a - b);
    value.responses.sort((a, b) => a - b);
  }
  return events;
}

// The tool names Grok lists after the replies ("read_file", "Web search:").
const GROK_TOOL_LINE = /^(?:[a-z][a-z0-9_]*|Web search:?|Web searc\w*)$/;

/**
 * One index document → prompts and replies. The document is the person's prompts
 * first, one paragraph each, then the replies, then the tools used. With `promptCount`
 * prompts (from Grok's log), the first that many paragraphs are the prompts.
 */
export function splitGrokDocument(content, promptCount) {
  const paragraphs = String(content || "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  while (paragraphs.length && paragraphs.at(-1).split("\n").every((line) => GROK_TOOL_LINE.test(line.trim()))) paragraphs.pop();
  if (paragraphs.length <= promptCount) return null;
  return {
    prompts: paragraphs.slice(0, promptCount),
    reply: paragraphs.slice(promptCount).join("\n\n"),
    // Whether every prompt is one line and the reply starts with a multi-line
    // paragraph: the shape the boundary usually has. Reported, not enforced.
    boundary_confident: paragraphs.slice(0, promptCount).every((part) => !part.includes("\n")) && paragraphs[promptCount].includes("\n"),
  };
}

/**
 * Grok search index sessions: split and timed where Grok's log covers the session
 * with as many prompts as answers; otherwise the whole document goes in as one
 * automation_grok message at the document's time.
 */
async function planGrokIndex(indexPath, logPath, ctx, knownSessions) {
  const entries = [];
  const exclusions = [];
  const report = { documents: 0, split: 0, whole: 0, boundary_confident: 0 };
  if (!indexPath) return { entries, exclusions, report };
  const log = await readGrokLog(logPath);
  const db = await openSqlite(indexPath);
  let rows;
  try {
    rows = db.prepare("SELECT session_id, cwd, updated_at, title, content FROM session_docs ORDER BY updated_at, session_id").all();
  } finally {
    db.close();
  }
  for (const row of rows) {
    report.documents += 1;
    const sessionId = `grok-${row.session_id}`;
    const base = { kind: "grok-index", provider: "grok", machine: "index", file: indexPath, session_id: sessionId };
    if (knownSessions.has(sessionId)) {
      exclusions.push(exclusion(base, "duplicate", "held by a Grok file session or the old-DB rows"));
      continue;
    }
    const content = String(row.content || "").trim();
    if (!content) {
      exclusions.push(exclusion(base, "no-turns"));
      continue;
    }
    const updatedMs = Number(row.updated_at) * 1000;
    const events = log.get(row.session_id);
    const split = events && events.prompts.length && events.prompts.length === events.responses.length ? splitGrokDocument(content, events.prompts.length) : null;
    let turns;
    if (split) {
      report.split += 1;
      if (split.boundary_confident) report.boundary_confident += 1;
      turns = split.prompts.map((prompt, index) => ({
        role: "user",
        content: prompt,
        created_at: iso(events.prompts[index]),
        created_at_source: "original",
        peer: ctx.userPeer,
        hash: `grok-index:${row.session_id}:prompt:${index + 1}`,
      }));
      turns.push({
        role: "assistant",
        content: split.reply,
        created_at: iso(events.responses.at(-1)),
        created_at_source: "original",
        peer: "assistant_grok",
        hash: `grok-index:${row.session_id}:replies`,
      });
    } else {
      report.whole += 1;
      turns = [
        {
          role: "user",
          content,
          created_at: iso(events?.prompts[0] ?? updatedMs),
          created_at_source: events?.prompts.length ? "original" : "interpolated",
          peer: "automation_grok",
          automation_kind: "grok_index_document",
          hash: `grok-index:${row.session_id}:document`,
        },
      ];
    }
    const startMs = Math.min(...turns.map((turn) => Date.parse(turn.created_at)));
    if (ctx.toMs != null && startMs >= ctx.toMs) {
      exclusions.push({ ...exclusion(base, "after-to"), start: iso(startMs) });
      continue;
    }
    const entry = directEntry(ctx, {
      kind: "grok-index",
      source: "grok",
      machine: "index",
      sessionId,
      file: indexPath,
      sessionMetadata: { original_session_id: row.session_id, cwd: row.cwd || undefined, title: row.title || undefined, grok_index_split: Boolean(split) },
      turns,
    });
    if (split) entry.boundary_confident = split.boundary_confident;
    entries.push(entry);
  }
  return { entries, exclusions, report };
}

/** Rows that exist only in the old Mac DB: any peer that is not assistant_* or automation_* is the person's and becomes --user-peer. */
async function planOldDb(filePaths, ctx, knownSessions) {
  const entries = [];
  const exclusions = [];
  const report = { rows: 0, sessions: 0, by_source: {} };
  const groups = new Map();
  for (const filePath of filePaths) {
    for (const row of await readJsonl(filePath)) {
      report.rows += 1;
      const key = row.session_name;
      if (!groups.has(key)) groups.set(key, { file: filePath, rows: [] });
      groups.get(key).rows.push(row);
    }
  }
  for (const [sessionName, { file, rows }] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const base = { kind: "old-db", provider: rows[0]?.metadata?.source || "old-db", machine: "mac-db", file, session_id: sessionName };
    const turns = [];
    for (const row of rows) {
      const timeMs = parseInstant(row.created_at, "UTC");
      const content = String(row.content || "").trim();
      if (!content || !Number.isFinite(timeMs)) continue;
      const original = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      const isUser = !/^(?:assistant|automation)_/.test(String(row.peer_name || ""));
      const peer = isUser ? ctx.userPeer : row.peer_name;
      const role = isUser || String(row.peer_name).startsWith("automation_") ? "user" : "assistant";
      const extra = {};
      for (const [key, value] of Object.entries(original)) {
        if (["source_turn_hash", "memory_trigger", "memory_importer", "direct_user", "memory_origin", "source", "agent_provider", "created_at_source"].includes(key)) continue;
        extra[key] = value;
      }
      extra.original_public_id = row.public_id;
      extra.original_peer = row.peer_name;
      turns.push({ role, content, created_at: iso(timeMs), created_at_source: "original", peer, hash: `old-db:${row.public_id}`, extra });
    }
    if (!turns.length) {
      exclusions.push(exclusion(base, "no-turns"));
      continue;
    }
    turns.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const startMs = Date.parse(turns[0].created_at);
    if (ctx.toMs != null && startMs >= ctx.toMs) {
      exclusions.push({ ...exclusion(base, "after-to"), start: iso(startMs) });
      continue;
    }
    const source = base.provider;
    report.sessions += 1;
    report.by_source[source] = (report.by_source[source] || 0) + turns.length;
    knownSessions.add(sessionName);
    entries.push(directEntry(ctx, { kind: "old-db", source, machine: "mac-db", sessionId: sessionName, file, sessionMetadata: { original_session_id: sessionName, file_path: file }, turns }));
  }
  return { entries, exclusions, report };
}

// ---------------------------------------------------------------------------
// Plan: order, summary
// ---------------------------------------------------------------------------

/** Manifest order: by start across every source and machine; ties by provider, machine, file; an entry posted "after" another follows it. */
export function sortEntries(entries, { catchUp = false } = {}) {
  const key = (entry) => Date.parse(catchUp && entry.first_new ? entry.first_new : entry.start);
  return [...entries].sort(
    (a, b) =>
      key(a) - key(b) ||
      a.provider.localeCompare(b.provider) ||
      a.machine.localeCompare(b.machine) ||
      String(a.after_file || a.file).localeCompare(String(b.after_file || b.file)) ||
      Number(Boolean(a.after_file)) - Number(Boolean(b.after_file)) ||
      a.kind.localeCompare(b.kind) ||
      a.session_id.localeCompare(b.session_id),
  );
}
export const sortSessions = sortEntries;

/** Same Honcho session id twice in one collector kind: keep the copy with the most turns, this computer's first. */
export function dedupe(entries, localMachine = "local") {
  const groups = new Map();
  for (const entry of entries) {
    const id = `${entry.kind}\t${entry.session_id}\t${entry.segment_id || ""}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  const kept = [];
  const dropped = [];
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        b.turns - a.turns ||
        Number(b.machine === localMachine) - Number(a.machine === localMachine) ||
        a.file.localeCompare(b.file),
    );
    kept.push(group[0]);
    for (const other of group.slice(1)) {
      dropped.push({
        kind: other.kind,
        provider: other.provider,
        machine: other.machine,
        file: other.file,
        session_id: other.session_id,
        start: other.start,
        reason: "duplicate",
        detail: `kept ${group[0].machine}:${group[0].file} (${group[0].turns} turns, this copy ${other.turns})`,
      });
    }
  }
  return { kept, dropped };
}

export function siblingPath(manifestPath, suffix) {
  return manifestPath.endsWith(".jsonl") ? `${manifestPath.slice(0, -".jsonl".length)}.${suffix}` : `${manifestPath}.${suffix}`;
}

export function summarize(entries, exclusions, timeZone) {
  const bySource = {};
  const byMonth = {};
  const byPeer = {};
  const byKind = {};
  for (const entry of entries) {
    const source = entry.provider;
    const row = (bySource[source] ||= { entries: 0, turns: 0, messages: 0, user: 0, automation: 0, assistant: 0, tokens_user: 0, interpolated: 0 });
    row.entries += 1;
    for (const field of ["turns", "messages", "user", "automation", "assistant", "tokens_user"]) row[field] += entry[field] || 0;
    row.interpolated += entry.interpolated || 0;
    const kind = (byKind[entry.kind] ||= { entries: 0, messages: 0 });
    kind.entries += 1;
    kind.messages += entry.messages;
    const month = formatInZone(Date.parse(entry.start), timeZone).slice(0, 7);
    const monthRow = (byMonth[month] ||= {});
    const cell = (monthRow[source] ||= { entries: 0, messages: 0, user: 0 });
    cell.entries += 1;
    cell.messages += entry.messages;
    cell.user += entry.user;
    for (const [peer, count] of Object.entries(entry.peers || {})) {
      const peerRow = (byPeer[source] ||= {});
      peerRow[peer] = (peerRow[peer] || 0) + count;
    }
  }
  const exclusionsByReason = {};
  for (const item of exclusions) {
    const key = `${item.reason}\t${item.kind || item.provider}`;
    exclusionsByReason[key] = (exclusionsByReason[key] || 0) + 1;
  }
  const totals = { entries: entries.length, messages: 0, user: 0, automation: 0, assistant: 0 };
  for (const entry of entries) for (const field of ["messages", "user", "automation", "assistant"]) totals[field] += entry[field] || 0;
  const peerTotals = {};
  for (const peers of Object.values(byPeer)) for (const [peer, count] of Object.entries(peers)) peerTotals[peer] = (peerTotals[peer] || 0) + count;
  return { totals, by_source: bySource, by_kind: byKind, by_month: byMonth, by_peer: byPeer, peer_totals: peerTotals, exclusions_by_reason: exclusionsByReason };
}

function table(header, rows) {
  const body = rows.map((cells) => cells.map(String));
  const widths = header.map((title, index) => Math.max(title.length, ...body.map((cells) => (cells[index] || "").length)));
  const line = (cells) => cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]))).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

export function formatSummary(summary) {
  const out = [];
  const sources = Object.keys(summary.by_source).sort();
  out.push(
    table(
      ["source", "entries", "turns", "messages", "user", "automation", "assistant", "~tok user", "interpolated"],
      [
        ...sources.map((source) => {
          const row = summary.by_source[source];
          return [source, row.entries, row.turns, row.messages, row.user, row.automation, row.assistant, row.tokens_user, row.interpolated];
        }),
        ["total", summary.totals.entries, "", summary.totals.messages, summary.totals.user, summary.totals.automation, summary.totals.assistant, "", ""],
      ],
    ),
  );
  out.push("");
  const peers = Object.keys(summary.peer_totals).sort();
  out.push(table(["source \\ peer", ...peers], sources.map((source) => [source, ...peers.map((peer) => summary.by_peer[source]?.[peer] || "")])));
  out.push("");
  const months = Object.keys(summary.by_month).sort();
  out.push(
    table(
      ["month (messages)", ...sources, "total"],
      months.map((month) => {
        const row = summary.by_month[month];
        return [month, ...sources.map((source) => row[source]?.messages || ""), sources.reduce((sum, source) => sum + (row[source]?.messages || 0), 0)];
      }),
    ),
  );
  out.push("");
  out.push(table(["excluded (reason, kind)", "count"], Object.entries(summary.exclusions_by_reason).sort().map(([key, count]) => [key.replace("\t", ", "), count])));
  return out.join("\n");
}

function catchUpState(stateDir) {
  const cache = new Map();
  return (provider, sessionId) => {
    if (!stateDir) return new Set();
    if (!cache.has(provider)) {
      let state = {};
      try {
        state = JSON.parse(fs.readFileSync(path.join(stateDir, `${provider}.json`), "utf8"));
      } catch {}
      cache.set(provider, state.sessions || {});
    }
    return new Set(cache.get(provider)[sessionId]?.imported_hashes || []);
  };
}

/** plan: never makes an HTTP request. */
export async function plan(options, { log = console.log } = {}) {
  const timeZone = options.tz || DEFAULT_TZ;
  if (!options.out) throw new Error("plan needs --out <manifest.jsonl>");
  const userPeer = requireUserPeer(options, options.catchUp ? "plan --catch-up" : "plan");
  const roots = (options.roots || []).map((root) => (typeof root === "string" ? parseRoot(root) : root));
  const catchUp = Boolean(options.catchUp);
  if (catchUp && !options.stateDir) throw new Error("plan --catch-up needs --state-dir (the run's state directory)");
  if (roots.some((root) => root.provider === "agy") && !options.agyHistory) throw new Error("agy roots need --agy-history (agy's prompt history)");
  const out = path.resolve(options.out);
  const stageDir = path.resolve(options.stageDir || path.join(path.dirname(out), "stage", path.basename(out, ".jsonl")));
  const toMs = options.to ? zonedInstant(options.to, timeZone) : null;
  const sinceMs = options.since ? zonedInstant(options.since, timeZone) : null;
  const mtimeBeforeMs = options.mtimeBefore ? zonedInstant(options.mtimeBefore, timeZone) : null;
  const ctx = {
    timeZone,
    toMs,
    catchUp,
    stageDir,
    userPeer,
    localMachine: options.localMachine || "local",
    charLimit: Number(options.charLimit || DEFAULT_CHAR_LIMIT),
    excludeIds: await readIdList(options.excludeIds),
    agyAppIds: await readIdList(options.agyAppIds),
    agyHistory: options.agyHistory ? parseHistory(await fsp.readFile(options.agyHistory, "utf8")) : null,
    seenHashes: catchUp ? catchUpState(path.resolve(options.stateDir)) : () => new Set(),
    pendingPayloads: [],
    // Catch-up passes read only files changed in their window.
    fileWanted: (filePath) => {
      if (sinceMs == null && mtimeBeforeMs == null) return true;
      const { mtimeMs } = fs.statSync(filePath);
      if (sinceMs != null && mtimeMs < sinceMs) return false;
      if (mtimeBeforeMs != null && mtimeMs >= mtimeBeforeMs) return false;
      return true;
    },
  };
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });

  const byProvider = (name) => roots.filter((root) => root.provider === name);
  const results = {};
  results.claude = await planClaude(byProvider("claude"), ctx);
  results.codex = await planCodex(byProvider("codex"), ctx);
  results.agy = await planAgy(byProvider("agy"), ctx);
  results.grok = await planGrokFiles(byProvider("grok"), ctx);
  results.chatgpt = await planChatGpt(catchUp ? null : options.chatgptExport, ctx);
  const known = new Set();
  if (!catchUp) {
    results.oldDb = await planOldDb(options.oldDb || [], ctx, known);
    for (const entry of results.grok.entries) known.add(entry.session_id);
    results.hermes = await planHermes(options.hermes, ctx);
    results.cursor = await planCursor(options.cursor, ctx);
    const cursorSessions = new Set(results.cursor.entries.map((entry) => entry.session_id));
    results.cursorVscdb = await planCursorVscdb(options.cursorVscdb, ctx, cursorSessions);
    results.gemini = await planGemini(options.gemini, ctx);
    results.grokIndex = await planGrokIndex(options.grokIndex, options.grokLog, ctx, known);
  }

  const collected = [];
  const exclusions = [];
  for (const result of Object.values(results)) {
    collected.push(...result.entries);
    exclusions.push(...result.exclusions);
  }
  const collectorEntries = collected.filter((entry) => COLLECTOR_KINDS.has(entry.kind));
  const { kept, dropped } = dedupe(collectorEntries, ctx.localMachine);
  const keptSet = new Set(kept);
  const droppedFiles = new Set(dropped.map((item) => item.file));
  exclusions.push(...dropped);
  const all = collected.filter((entry) => !COLLECTOR_KINDS.has(entry.kind) ? !(entry.after_file && droppedFiles.has(entry.after_file)) : keptSet.has(entry));

  // Stage what is kept: collector files (hard links) and direct payloads.
  for (const entry of all) {
    for (const file of entry.files || []) if (!fs.existsSync(file.staged)) await stageFile(file.source, file.staged);
  }
  const keptPayloads = new Set(all.map((entry) => entry.payload).filter(Boolean));
  for (const [payloadPath, payload] of ctx.pendingPayloads) if (keptPayloads.has(payloadPath)) await writeJson(payloadPath, payload);

  const entries = sortEntries(all, { catchUp }).map((entry, index) => {
    const { excluded: _excluded, ...rest } = entry;
    return {
      seq: index + 1,
      ...rest,
      start_local: formatInZone(Date.parse(entry.start), timeZone),
    };
  });
  const cleanExclusions = exclusions.map(({ excluded: _excluded, ...rest }) => rest);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  const exclusionsPath = siblingPath(out, "exclusions.jsonl");
  await fsp.writeFile(exclusionsPath, cleanExclusions.map((item) => JSON.stringify(item)).join("\n") + (cleanExclusions.length ? "\n" : ""), "utf8");
  const counts = summarize(entries, cleanExclusions, timeZone);
  const summary = {
    generated_at: new Date().toISOString(),
    catch_up: catchUp,
    tz: timeZone,
    to: options.to || null,
    to_utc: toMs != null ? iso(toMs) : null,
    since: options.since || null,
    mtime_before: options.mtimeBefore || null,
    stage_dir: stageDir,
    user_peer: ctx.userPeer,
    char_limit: ctx.charLimit,
    roots: roots.map((root) => `${root.provider}:${root.machine}:${root.dir}`),
    inputs: {
      exclude_ids: options.excludeIds || null,
      exclude_id_count: ctx.excludeIds.size,
      chatgpt_export: options.chatgptExport || null,
      hermes: options.hermes || null,
      cursor: options.cursor || null,
      cursor_vscdb: options.cursorVscdb || null,
      gemini: options.gemini || null,
      grok_index: options.grokIndex || null,
      grok_log: options.grokLog || null,
      agy_history: options.agyHistory ? path.resolve(options.agyHistory) : null,
      agy_app_ids: options.agyAppIds || null,
      agy_app_id_count: ctx.agyAppIds.size,
      old_db: options.oldDb || [],
      state_dir: options.stateDir || null,
    },
    gates: options.chatgptExport || catchUp ? [] : ["no ChatGPT export: posting cannot start until it is planned in (the first two years are ChatGPT only)"],
    entries: entries.length,
    ...counts,
    codex_versions: results.codex.extrasSummary,
    agy_origins: results.agy.origins,
    chatgpt_split: results.chatgpt.split,
    hermes: results.hermes?.report || null,
    grok_index: results.grokIndex?.report || null,
    mac_db_only: results.oldDb?.report || null,
  };
  await fsp.writeFile(siblingPath(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  log(`${entries.length} entries in the manifest: ${out}${toMs != null ? ` (entries starting before ${iso(toMs)})` : ""}`);
  for (const gate of summary.gates) log(`GATE: ${gate}`);
  log("");
  log(formatSummary(counts));
  log("");
  log(`codex versions: ${JSON.stringify(summary.codex_versions)}`);
  log(`agy origins: ${JSON.stringify(summary.agy_origins)}`);
  if (summary.hermes) log(`hermes: ${JSON.stringify(summary.hermes)}`);
  if (summary.grok_index) log(`grok index: ${JSON.stringify(summary.grok_index)}`);
  if (summary.mac_db_only) log(`mac-db-only rows: ${JSON.stringify(summary.mac_db_only)}`);
  log(`exclusion details: ${exclusionsPath}`);
  return { entries, exclusions: cleanExclusions, summary };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function withoutNulls(value) {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== null && value[key] !== undefined) out[key] = withoutNulls(value[key]);
    return out;
  }
  return value;
}

export function sameConfiguration(actual, expected = WORKSPACE_CONFIGURATION) {
  return JSON.stringify(withoutNulls(actual || {})) === JSON.stringify(withoutNulls(expected));
}

export function summaryOnConfiguration() {
  return { ...WORKSPACE_CONFIGURATION, summary: { enabled: true } };
}

export function honchoClient({ baseUrl, env = process.env, fetchImpl } = {}) {
  if (!baseUrl) throw new Error("--base-url is required");
  const root = String(baseUrl).replace(/\/+$/, "");
  const headers = honchoHeaders(
    { token: env.HONCHO_API_BEARER_TOKEN || "", access: environmentAccess(env, { legacy: true }) },
    { "Content-Type": "application/json" },
  );
  return async function request(method, apiPath, payload) {
    const init = { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) };
    const response = fetchImpl ? await fetchImpl(`${root}${apiPath}`, init) : await fetchHoncho(`${root}${apiPath}`, init);
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} for ${method} ${apiPath}: ${body.slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
    return body ? JSON.parse(body) : {};
  };
}

async function listWorkspaces(request) {
  const items = [];
  for (let page = 1; page < 1000; page += 1) {
    const data = await request("POST", `/v3/workspaces/list?page=${page}&size=100`, {});
    const batch = Array.isArray(data?.items) ? data.items : [];
    items.push(...batch);
    const pages = Number(data?.pages || 0);
    if (!batch.length || (pages && page >= pages) || batch.length < 100) break;
  }
  return items;
}

/**
 * The server may hold no workspace but the target, and the target is either missing
 * (then created, marked with this run) or carries this run's rebuild_run marker. Its
 * configuration must be the one the run sets, or the summary switch this run made.
 */
export async function guardServer(request, { workspace, runId, summaryEnabled = false }, { log = console.log } = {}) {
  const name = String(workspace || "").trim();
  if (!name) throw new Error("--workspace is required");
  if (!runId) throw new Error("--run-id is required");
  const items = await listWorkspaces(request);
  const others = items.map((item) => item?.id).filter((id) => id !== name);
  if (others.length) {
    throw new Error(`refusing: the server holds other workspaces (${others.slice(0, 5).join(", ")}${others.length > 5 ? ", …" : ""}); a rebuild goes only to a server holding nothing but its own workspace`);
  }
  const existing = items.find((item) => item?.id === name);
  if (existing) {
    const marker = existing.metadata?.rebuild_run;
    if (marker !== runId) {
      throw new Error(`refusing: workspace "${name}" exists without this run's marker (metadata.rebuild_run=${JSON.stringify(marker ?? null)}, expected ${JSON.stringify(runId)})`);
    }
    const allowed = summaryEnabled ? [WORKSPACE_CONFIGURATION, summaryOnConfiguration()] : [WORKSPACE_CONFIGURATION];
    if (!allowed.some((expected) => sameConfiguration(existing.configuration, expected))) {
      throw new Error(`refusing: workspace "${name}" has configuration ${JSON.stringify(existing.configuration || {})}, not one this run set`);
    }
    log(`workspace ${name} exists with this run's marker and ${JSON.stringify(existing.configuration)}`);
    return { created: false, workspace: existing };
  }
  const payload = { id: name, metadata: { rebuild_run: runId }, configuration: WORKSPACE_CONFIGURATION };
  const created = await request("POST", "/v3/workspaces", payload);
  if (created?.metadata?.rebuild_run !== runId || !sameConfiguration(created?.configuration)) {
    throw new Error(`workspace "${name}" came back as ${JSON.stringify({ metadata: created?.metadata, configuration: created?.configuration })}; refusing to import`);
  }
  log(`workspace ${name} created with ${JSON.stringify(payload.metadata)} ${JSON.stringify(created.configuration)}`);
  return { created: true, workspace: created };
}

/** The collector's environment for one entry of the rebuild. */
export function collectorEnv(baseEnv, { provider, runDir, workspace, tag, baseUrl, userPeer, charLimit = DEFAULT_CHAR_LIMIT, agyHistory = null }) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    // A target run (targets.mjs) filters by folder and points at another server.
    if (key.startsWith("HONCHO_AGENT_TARGET_") || key.startsWith("HONCHO_TARGET_")) delete env[key];
    // Peer names come from the defaults only: assistant_<provider>, automation_<provider>.
    if (key === "HONCHO_ASSISTANT_NAME" || /^HONCHO_[A-Z0-9]+_ASSISTANT_NAME$/.test(key) || /^HONCHO_[A-Z0-9]+_AUTOMATION_PEER$/.test(key)) delete env[key];
  }
  // A dry-run flag would make every entry "succeed" without sending anything.
  delete env.HONCHO_AGENT_DRY_RUN;
  delete env.HONCHO_CODEX_DRY_RUN;
  env.HONCHO_BASE_URL = baseUrl;
  env.HONCHO_WORKSPACE_ID = workspace;
  env.HONCHO_AGENT_PROVIDER = provider;
  env.HONCHO_USER_NAME = requireUserPeer({ userPeer }, "collectorEnv");
  env.HONCHO_AGENT_HOOK_STATE = path.join(runDir, "state", `${provider}.json`);
  env.HONCHO_AGENT_HOOK_LOG = path.join(runDir, "logs", `${provider}.log`);
  env.HONCHO_AGENT_IMPORT_TRIGGER = tag;
  env.HONCHO_CODEX_DREAM_EVERY_MESSAGES = "0";
  env.HONCHO_AGENT_HTTP_TIMEOUT_SECONDS = "60";
  env.HONCHO_AGENT_MESSAGE_CHAR_LIMIT = String(charLimit);
  if (agyHistory) env.HONCHO_AGY_HISTORY = agyHistory;
  else if (provider === "agy") env.HONCHO_AGY_HISTORY = path.join(runDir, "state", "no-agy-history.jsonl");
  return env;
}

export function collectorArgs(collectorPath, entry, file, workspace) {
  if (entry.kind === "chatgpt") return [collectorPath, "--provider", "chatgpt", "--export", file.staged, "--workspace", workspace];
  return [collectorPath, "--provider", entry.provider, "--transcript", file.staged, "--workspace", workspace];
}

function runChild(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function lastJson(text) {
  const lines = String(text || "").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

export const ledgerKey = (entry) => `${entry.kind}\t${entry.session_id}\t${entry.files?.[0]?.staged || entry.payload || entry.file}`;

export function ledgerPathFor(runDir, manifestPath) {
  return path.join(runDir, `ledger.${path.basename(manifestPath, ".jsonl")}.jsonl`);
}

async function readDriverState(runDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(runDir, "state", "driver.json"), "utf8"));
  } catch {
    return {};
  }
}

async function saveDriverState(runDir, state) {
  const target = path.join(runDir, "state", "driver.json");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(`${target}.tmp`, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(`${target}.tmp`, target);
}

async function sessionMessages(request, workspace, sessionId) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const data = await request(
      "POST",
      `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(sessionId)}/messages/list?page=${page}&size=100&reverse=false`,
      {},
    );
    const batch = Array.isArray(data?.items) ? data.items : [];
    items.push(...batch);
    const total = Number(data?.total ?? items.length);
    if (batch.length < 100 || items.length >= total) break;
  }
  return items;
}

/** Post one direct payload: the session with its peers, then the messages, at most 100 per request, one turn never split across requests. */
export async function postDirect(request, workspace, payload, { tag, reconcile = false } = {}) {
  const ws = encodeURIComponent(workspace);
  await request("POST", `/v3/workspaces/${ws}/sessions`, {
    id: payload.session.id,
    metadata: payload.session.metadata,
    configuration: {},
    peers: payload.session.peers,
  });
  let sent = new Set();
  if (reconcile) {
    try {
      sent = new Set((await sessionMessages(request, workspace, payload.session.id)).map((message) => message?.metadata?.source_turn_hash).filter(Boolean));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const pending = payload.messages
    .filter((message) => !sent.has(message.metadata.source_turn_hash))
    .map((message) => ({ ...message, metadata: { ...message.metadata, memory_trigger: tag } }));
  const groups = [];
  for (const message of pending) {
    const current = groups.at(-1);
    if (current && current.key === message.metadata.source_turn_hash) current.messages.push(message);
    else groups.push({ key: message.metadata.source_turn_hash, messages: [message] });
  }
  let batch = [];
  let posted = 0;
  const flush = async () => {
    if (!batch.length) return;
    await request("POST", `/v3/workspaces/${ws}/sessions/${encodeURIComponent(payload.session.id)}/messages`, { messages: batch });
    posted += batch.length;
    batch = [];
  };
  for (const group of groups) {
    if (group.messages.length > BATCH_LIMIT) throw new Error(`one turn of ${payload.session.id} needs more than ${BATCH_LIMIT} messages`);
    if (batch.length + group.messages.length > BATCH_LIMIT) await flush();
    batch.push(...group.messages);
  }
  await flush();
  return { posted, skipped: payload.messages.length - pending.length };
}

/** Whether this driver runs from the pinned copy (<run dir>/bridge, revision in bridge-rev.txt); the revision, or null. */
export function pinnedRevision(runDir, driverPath = DRIVER_PATH) {
  const bridge = path.join(runDir, "bridge") + path.sep;
  if (!path.resolve(driverPath).startsWith(bridge)) return null;
  try {
    return fs.readFileSync(path.join(runDir, "bridge-rev.txt"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function run(options, { log = console.log, env = process.env, request, driverPath = DRIVER_PATH } = {}) {
  if (!options.manifest) throw new Error("run needs --manifest");
  if (!options.runDir) throw new Error("run needs --run-dir");
  if (!options.baseUrl) throw new Error("run needs --base-url (the target server)");
  if (!options.runId) throw new Error("run needs --run-id (the workspace marker)");
  const userPeer = requireUserPeer(options, "run");
  const workspace = String(options.workspace || "").trim();
  if (!workspace) throw new Error("run needs --workspace");
  const runDir = path.resolve(options.runDir);
  const revision = pinnedRevision(runDir, driverPath);
  if (!revision && !options.allowUnpinned) {
    throw new Error(`refusing: run from the pinned copy in ${path.join(runDir, "bridge")} (git archive, revision in bridge-rev.txt), not ${driverPath}`);
  }
  const baseUrl = String(options.baseUrl).replace(/\/+$/, "");
  const tag = options.tag || `rebuild-${options.runId}`;
  const collectorPath = options.collector || DEFAULT_COLLECTOR;
  const maxFailures = Number(options.maxFailures || DEFAULT_MAX_FAILURES);
  const manifest = await readJsonl(options.manifest);
  if (!manifest.length) throw new Error(`manifest is empty: ${options.manifest}`);
  let summary = {};
  try {
    summary = JSON.parse(await fsp.readFile(siblingPath(options.manifest, "summary.json"), "utf8"));
  } catch {}
  // Direct payloads were written at plan time with the plan's user peer.
  if (summary.user_peer && summary.user_peer !== userPeer) {
    throw new Error(`refusing: --user-peer "${userPeer}" differs from the plan's "${summary.user_peer}" (its direct payloads already use that name)`);
  }
  const charLimit = Number(summary.char_limit) || DEFAULT_CHAR_LIMIT;
  const agyHistory = summary.inputs?.agy_history || null;
  if (summary.gates?.length && !options.ignoreGates) throw new Error(`refusing: the plan has open gates: ${summary.gates.join("; ")}`);
  const timeZone = summary.tz || DEFAULT_TZ;
  const summariesFromMs = options.summariesFrom ? zonedInstant(options.summariesFrom, timeZone) : null;

  const ledgerPath = ledgerPathFor(runDir, options.manifest);
  const done = new Set();
  const started = new Set();
  for (const entry of await readJsonl(ledgerPath)) {
    if (entry.workspace && entry.workspace !== workspace) throw new Error(`ledger ${ledgerPath} belongs to workspace "${entry.workspace}", not "${workspace}"`);
    if (entry.status === "ok") done.add(entry.key);
    else started.add(entry.key);
  }
  const send = request || honchoClient({ baseUrl, env });
  const driverState = await readDriverState(runDir);
  await guardServer(send, { workspace, runId: options.runId, summaryEnabled: Boolean(driverState.summary_enabled_at) }, { log });
  driverState.run_id = options.runId;
  driverState.bridge_rev = revision || "unpinned";
  await saveDriverState(runDir, driverState);
  await fsp.mkdir(path.join(runDir, "state"), { recursive: true });
  await fsp.mkdir(path.join(runDir, "logs"), { recursive: true });
  const pending = manifest.filter((entry) => !done.has(ledgerKey(entry)));
  const limit = options.limit ? Number(options.limit) : Infinity;
  log(`${manifest.length} entries in the manifest, ${manifest.length - pending.length} already done, ${pending.length} to go`);

  let consecutive = 0;
  let ok = 0;
  let failed = 0;
  for (const entry of pending.slice(0, limit)) {
    const key = ledgerKey(entry);
    if (summariesFromMs != null && !driverState.summary_enabled_at && Date.parse(entry.first_new || entry.start) >= summariesFromMs) {
      await send("PUT", `/v3/workspaces/${encodeURIComponent(workspace)}`, { configuration: { summary: { enabled: true } } });
      driverState.summary_enabled_at = new Date().toISOString();
      driverState.summary_enabled_before_seq = entry.seq;
      await saveDriverState(runDir, driverState);
      log(`summaries on before entry ${entry.seq} (${entry.start})`);
    }
    const startedAt = new Date().toISOString();
    const base = { key, seq: entry.seq, kind: entry.kind, session_id: entry.session_id, workspace, bridge_rev: driverState.bridge_rev };
    await fsp.appendFile(ledgerPath, `${JSON.stringify({ ...base, status: "started", started_at: startedAt })}\n`, "utf8");
    let success = false;
    let detail = {};
    try {
      if (COLLECTOR_KINDS.has(entry.kind)) {
        const childEnv = collectorEnv(env, { provider: entry.provider, runDir, workspace, tag, baseUrl, userPeer, charLimit, agyHistory });
        let newMessages = 0;
        for (const file of entry.files) {
          const outcome = await runChild(collectorArgs(collectorPath, entry, file, workspace), childEnv);
          const result = lastJson(outcome.stdout) || lastJson(outcome.stderr);
          if (!(outcome.code === 0 && result?.ok === true)) {
            throw new Error(String(result?.error || outcome.stderr || outcome.stdout || "no output").slice(0, 2000));
          }
          newMessages += Number(result.new_messages || 0);
        }
        detail = { new_messages: newMessages };
      } else if (DIRECT_KINDS.has(entry.kind)) {
        const payload = JSON.parse(await fsp.readFile(entry.payload, "utf8"));
        const result = await postDirect(send, workspace, payload, { tag, reconcile: started.has(key) });
        detail = { new_messages: result.posted, skipped_already_sent: result.skipped };
      } else throw new Error(`unknown kind ${entry.kind}`);
      success = true;
    } catch (error) {
      detail = { error: String(error?.message || error).slice(0, 2000) };
    }
    await fsp.appendFile(
      ledgerPath,
      `${JSON.stringify({ ...base, status: success ? "ok" : "failed", started_at: startedAt, finished_at: new Date().toISOString(), expected_messages: entry.messages, ...detail })}\n`,
      "utf8",
    );
    if (success) {
      ok += 1;
      consecutive = 0;
      const note = detail.new_messages !== entry.messages ? ` (manifest says ${entry.messages})` : "";
      log(`[${entry.seq}/${manifest.length}] ok ${entry.kind} ${entry.session_id} ${detail.new_messages} new messages${note}`);
    } else {
      failed += 1;
      consecutive += 1;
      started.add(key);
      log(`[${entry.seq}/${manifest.length}] FAILED ${entry.kind} ${entry.session_id}: ${detail.error.split("\n")[0]}`);
      if (consecutive >= maxFailures) {
        log(`stopping after ${consecutive} consecutive failures; run the same command again to resume`);
        return { ok, failed, stopped: true, ledger: ledgerPath };
      }
    }
  }
  log(`done: ${ok} ok, ${failed} failed this pass; ledger ${ledgerPath}`);
  return { ok, failed, stopped: false, ledger: ledgerPath };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/** The manifest's expectation per session: entries can share one (Codex segments and extras, catch-up passes). */
export function expectedSessions(entries) {
  const sessions = new Map();
  for (const entry of entries) {
    const first = Date.parse(entry.first_turn || entry.first_new || entry.start);
    const last = Date.parse(entry.end);
    const item = sessions.get(entry.session_id) || { session_id: entry.session_id, source: entry.provider, messages: 0, firstMs: first, lastMs: last, peers: {}, seqs: [] };
    item.messages += entry.messages;
    item.firstMs = Math.min(item.firstMs, first);
    item.lastMs = Math.max(item.lastMs, last);
    for (const [peer, count] of Object.entries(entry.peers || {})) item.peers[peer] = (item.peers[peer] || 0) + count;
    item.seqs.push(entry.seq);
    sessions.set(entry.session_id, item);
  }
  return sessions;
}

export function compareSession(expected, messages) {
  const problems = [];
  if (messages.length !== expected.messages) problems.push(`messages ${messages.length} != manifest ${expected.messages}`);
  if (messages.length) {
    const { startMs: min, endMs: max } = timesOf(messages);
    if (min !== expected.firstMs) problems.push(`first created_at ${iso(min)} != manifest ${iso(expected.firstMs)}`);
    if (max !== expected.lastMs) problems.push(`last created_at ${iso(max)} != manifest ${iso(expected.lastMs)}`);
  }
  const actualPeers = {};
  for (const message of messages) actualPeers[message.peer_id] = (actualPeers[message.peer_id] || 0) + 1;
  for (const peer of new Set([...Object.keys(actualPeers), ...Object.keys(expected.peers || {})])) {
    if ((actualPeers[peer] || 0) !== (expected.peers?.[peer] || 0)) problems.push(`peer ${peer} ${actualPeers[peer] || 0} != manifest ${expected.peers?.[peer] || 0}`);
  }
  return problems;
}

export async function verify(options, { log = console.log, env = process.env, request } = {}) {
  const manifests = [].concat(options.manifest || []);
  if (!manifests.length) throw new Error("verify needs --manifest");
  const workspace = String(options.workspace || "").trim();
  if (!workspace) throw new Error("verify needs --workspace");
  const send = request || honchoClient({ baseUrl: options.baseUrl, env });
  const entries = [];
  for (const manifest of manifests) {
    let list = await readJsonl(manifest);
    if (options.runDir) {
      const ok = new Set((await readJsonl(ledgerPathFor(path.resolve(options.runDir), manifest))).filter((item) => item.status === "ok").map((item) => item.key));
      list = list.filter((entry) => ok.has(ledgerKey(entry)));
    }
    entries.push(...list);
  }
  const report = { checked: 0, matched: 0, mismatched: 0, missing: 0, problems: [], by_source_peer: {} };
  for (const expected of expectedSessions(entries).values()) {
    report.checked += 1;
    let messages;
    try {
      messages = await sessionMessages(send, workspace, expected.session_id);
    } catch (error) {
      if (error.status === 404) {
        report.missing += 1;
        report.problems.push({ session_id: expected.session_id, problems: ["session not found"] });
        continue;
      }
      throw error;
    }
    for (const message of messages) {
      const source = message?.metadata?.source || message?.metadata?.agent_provider || expected.source;
      const row = (report.by_source_peer[`${source}\t${message.peer_id}`] ||= { expected: 0, actual: 0 });
      row.actual += 1;
    }
    for (const [peer, count] of Object.entries(expected.peers)) {
      const row = (report.by_source_peer[`${expected.source}\t${peer}`] ||= { expected: 0, actual: 0 });
      row.expected += count;
    }
    const problems = compareSession(expected, messages);
    if (problems.length) {
      report.mismatched += 1;
      report.problems.push({ session_id: expected.session_id, seqs: expected.seqs, problems });
    } else report.matched += 1;
  }
  for (const item of report.problems) log(`${item.session_id}: ${item.problems.join("; ")}`);
  log(table(["source, peer", "manifest", "server"], Object.entries(report.by_source_peer).sort().map(([key, row]) => [key.replace("\t", ", "), row.expected, row.actual])));
  log(`checked ${report.checked} sessions, matched ${report.matched}, mismatched ${report.mismatched}, missing ${report.missing}`);
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS = {
  "--to": "to",
  "--tz": "tz",
  "--exclude-ids": "excludeIds",
  "--out": "out",
  "--stage-dir": "stageDir",
  "--char-limit": "charLimit",
  "--local-machine": "localMachine",
  "--chatgpt-export": "chatgptExport",
  "--hermes": "hermes",
  "--cursor": "cursor",
  "--cursor-vscdb": "cursorVscdb",
  "--gemini": "gemini",
  "--grok-index": "grokIndex",
  "--grok-log": "grokLog",
  "--agy-history": "agyHistory",
  "--agy-app-ids": "agyAppIds",
  "--since": "since",
  "--mtime-before": "mtimeBefore",
  "--state-dir": "stateDir",
  "--workspace": "workspace",
  "--run-id": "runId",
  "--run-dir": "runDir",
  "--tag": "tag",
  "--base-url": "baseUrl",
  "--summaries-from": "summariesFrom",
  "--collector": "collector",
  "--max-failures": "maxFailures",
  "--limit": "limit",
  "--user-peer": "userPeer",
};
const REPEATED = { "--old-db": "oldDb", "--manifest": "manifest" };
const SWITCHES = { "--catch-up": "catchUp", "--allow-unpinned": "allowUnpinned", "--ignore-gates": "ignoreGates" };

export function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = { roots: [], oldDb: [], manifest: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (SWITCHES[flag]) {
      options[SWITCHES[flag]] = true;
      continue;
    }
    if (flag === "--root") {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options.roots.push(parseRoot(value));
    } else if (REPEATED[flag]) {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[REPEATED[flag]].push(value);
    } else if (FLAGS[flag]) {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[FLAGS[flag]] = value;
    } else throw new Error(`unknown option: ${flag}`);
    index += 1;
  }
  if (command === "run") options.manifest = options.manifest.at(-1);
  return { command, options };
}

const USAGE = `usage:
  rebuild-import.mjs plan --out <manifest.jsonl> --user-peer <name> [--to <local time>] [--tz Asia/Seoul]
      [--root <claude|codex|agy|grok>:<machine>:<dir> ...] [--exclude-ids <file>]
      [--chatgpt-export <zip|dir|json>] [--hermes <dir>] [--cursor <dir>] [--cursor-vscdb <jsonl>]
      [--gemini <dir>] [--grok-index <sqlite>] [--grok-log <jsonl>] [--agy-history <jsonl>]
      [--agy-app-ids <file>] [--old-db <jsonl> ...] [--stage-dir <dir>]
      [--catch-up --state-dir <run>/state [--since <time>] [--mtime-before <time>]]
  rebuild-import.mjs run --manifest <manifest.jsonl> --workspace <id> --run-id <id> --user-peer <name>
      --base-url URL --run-dir <dir> [--tag <trigger>] [--summaries-from <date>] [--limit N] [--max-failures 3]
  rebuild-import.mjs verify --manifest <manifest.jsonl> [--manifest ...] --workspace <id> --base-url URL [--run-dir <dir>]`;

async function main(argv) {
  const { command, options } = parseCli(argv);
  if (command === "plan") {
    await plan(options);
    return 0;
  }
  if (command === "run") {
    const result = await run(options);
    return result.stopped || result.failed ? 1 : 0;
  }
  if (command === "verify") {
    const report = await verify(options);
    return report.mismatched || report.missing ? 1 : 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === DRIVER_PATH) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`rebuild-import: ${error?.message || error}`);
    process.exitCode = 2;
  }
}
