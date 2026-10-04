#!/usr/bin/env node
// Rebuild driver: re-imports conversation originals into a fresh Honcho workspace,
// one session at a time, in the order the conversations started.
//
//   plan    scan transcript roots, classify, sort, write a manifest (no HTTP at all)
//   run     guard the workspace, then run collector.mjs once per manifest session,
//           keeping a resumable ledger.jsonl in the run directory
//   verify  compare each session's message count and first/last created_at in
//           Honcho with the manifest (read-only list requests)
//
// Every session is sent by the ordinary collector (scripts/collector.mjs); this
// driver only decides what is sent, in which order, and with which environment.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProvider } from "./providers/index.mjs";
import { classifyAutomation as classifyCodexAutomation } from "./providers/codex.mjs";
import { environmentAccess, fetchHoncho, honchoHeaders } from "./honcho-access.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COLLECTOR = path.join(HERE, "collector.mjs");
export const DEFAULT_BASE_URL = "http://127.0.0.1:8001";
export const DEFAULT_TZ = "Asia/Seoul";
export const DEFAULT_USER_PEER = "user_chen";
export const DEFAULT_CHAR_LIMIT = 24000;
export const DEFAULT_MAX_FAILURES = 3;
// The live workspace every hook writes to; a rebuild never touches it.
export const PROTECTED_WORKSPACES = new Set(["memory"]);
export const WORKSPACE_CONFIGURATION = Object.freeze({ summary: Object.freeze({ enabled: false }) });
const PROVIDERS = new Set(["claude", "codex"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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

/** "2026-09-01" or "2026-09-01T09:30[:00]" read as wall time in `timeZone` → epoch ms. */
export function zonedInstant(local, timeZone = DEFAULT_TZ) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(local || "").trim());
  if (!match) throw new Error(`not a local date or time: ${local}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let instant = wall - zoneOffsetMs(wall, timeZone);
  instant = wall - zoneOffsetMs(instant, timeZone);
  return instant;
}

/** Epoch ms → "2026-09-01T09:00:00.000+09:00" in `timeZone`. */
export function formatInZone(ms, timeZone = DEFAULT_TZ) {
  const offset = zoneOffsetMs(ms, timeZone);
  const wall = new Date(ms + offset).toISOString().slice(0, 23);
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset) / 60000;
  return `${wall}${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** "claude:local:/path" → { provider, machine, dir }. */
export function parseRoot(value) {
  const match = /^([a-z]+):([A-Za-z0-9_.-]+):(.+)$/.exec(String(value || ""));
  if (!match || !PROVIDERS.has(match[1])) throw new Error(`--root must be <claude|codex>:<machine>:<dir>, got: ${value}`);
  return { provider: match[1], machine: match[2], dir: path.resolve(match[3]) };
}

/** Every session uuid in a file name (plain, .pre-archive, device-tagged and _원본버전 names). */
export function uuidsInName(name) {
  return [...String(path.basename(name)).matchAll(UUID)].map((match) => match[0].toLowerCase());
}

/** The uuids in an exclude-list file: any uuid anywhere in it, one or many per line. */
export async function readExcludeIds(filePath) {
  if (!filePath) return new Set();
  const text = await fsp.readFile(filePath, "utf8");
  return new Set([...text.matchAll(UUID)].map((match) => match[0].toLowerCase()));
}

function wantedFile(provider, relative) {
  const name = path.basename(relative);
  if (!name.endsWith(".jsonl")) return false;
  const parts = relative.split(path.sep);
  if (provider === "claude") return !parts.includes("subagents") && !parts.includes("tool-results");
  return name.startsWith("rollout-");
}

/** The transcript files under one root, in a stable order. */
export async function scanRoot(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === root.dir) throw new Error(`cannot read root ${root.provider}:${root.machine}:${root.dir}: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && wantedFile(root.provider, path.relative(root.dir, full))) files.push(full);
    }
  }
  await walk(root.dir);
  return files.sort();
}

/**
 * What the head of a transcript says about who started it: a Claude session's first
 * `entrypoint`, a Codex rollout's first session_meta (source.subagent, thread_source).
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

/** How many Honcho messages collector.mjs makes of one turn (its splitContent). */
export function splitCount(text, limit = DEFAULT_CHAR_LIMIT) {
  if (text.length <= limit) return 1;
  let count = 0;
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + Math.floor(limit / 2)) end = newline;
    }
    if (text.slice(start, end).trim()) count += 1;
    start = end;
  }
  return count;
}

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

/**
 * One transcript → a manifest candidate or an exclusion. `window` is { fromMs, toMs }
 * (half-open), `excludeIds` a Set of lowercase uuids.
 */
export async function classifyFile(root, filePath, { window, excludeIds, charLimit = DEFAULT_CHAR_LIMIT, timeZone = DEFAULT_TZ }) {
  const base = { provider: root.provider, machine: root.machine, file: filePath };
  let parsed;
  try {
    parsed = await getProvider(root.provider).parseTranscript(filePath, {});
  } catch (error) {
    return { excluded: true, ...base, reason: "parse-error", detail: String(error?.message || error) };
  }
  const session = { ...base, session_id: parsed.session_id };
  if (!parsed.turns.length) return { excluded: true, ...session, reason: "no-turns" };
  const missing = parsed.turns.filter((turn) => !turn.created_at || !Number.isFinite(Date.parse(turn.created_at)));
  if (missing.length) {
    return { excluded: true, ...session, reason: "turn-without-created_at", detail: `${missing.length} turn(s), first at line ${missing[0].line_index}` };
  }
  const times = parsed.turns.map((turn) => Date.parse(turn.created_at));
  const startMs = Math.min(...times);
  const endMs = Math.max(...times);
  const start = new Date(startMs).toISOString();
  if (startMs < window.fromMs || startMs >= window.toMs) return { excluded: true, ...session, start, reason: "outside-window" };
  const archived = uuidsInName(filePath).find((uuid) => excludeIds.has(uuid));
  if (archived) return { excluded: true, ...session, start, reason: "archived", detail: archived };
  const head = await readSessionHead(root.provider, filePath);
  if (root.provider === "codex" && head.subagent) return { excluded: true, ...session, start, reason: "codex-subagent" };
  if (root.provider === "claude" && head.entrypoint?.startsWith("sdk-")) {
    return { excluded: true, ...session, start, reason: "claude-sdk", detail: head.entrypoint };
  }

  const counts = { user: 0, automation: 0, assistant: 0, messages: 0, tokens_user: 0, tokens_assistant: 0 };
  for (const turn of parsed.turns) {
    counts.messages += splitCount(turn.content, charLimit);
    if (turn.role === "user") {
      const automated = root.provider === "codex" && classifyCodexAutomation(turn.content, parsed.metadata)[0];
      if (automated) counts.automation += 1;
      else {
        counts.user += 1;
        counts.tokens_user += approxTokens(turn.content);
      }
    } else {
      counts.assistant += 1;
      counts.tokens_assistant += approxTokens(turn.content);
    }
  }
  return {
    excluded: false,
    ...session,
    source_uuid: uuidsInName(filePath)[0] || null,
    start,
    end: new Date(endMs).toISOString(),
    start_local: formatInZone(startMs, timeZone),
    turns: parsed.turns.length,
    ...counts,
    entrypoint: head.entrypoint || undefined,
  };
}

/** Same Honcho session id twice: keep the copy with the most turns, this computer's ("local") first. */
export function dedupe(sessions, localMachine = "local") {
  const groups = new Map();
  for (const session of sessions) {
    if (!groups.has(session.session_id)) groups.set(session.session_id, []);
    groups.get(session.session_id).push(session);
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
        excluded: true,
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

/** Manifest order: by start across every source and machine; ties by provider, machine, file. */
export function sortSessions(sessions) {
  return [...sessions].sort(
    (a, b) =>
      Date.parse(a.start) - Date.parse(b.start) ||
      a.provider.localeCompare(b.provider) ||
      a.machine.localeCompare(b.machine) ||
      a.file.localeCompare(b.file),
  );
}

export function countTable(sessions) {
  const rows = new Map();
  for (const session of sessions) {
    const key = `${session.provider}\t${session.machine}`;
    if (!rows.has(key)) {
      rows.set(key, { provider: session.provider, machine: session.machine, sessions: 0, user: 0, automation: 0, assistant: 0, messages: 0, tokens_user: 0, tokens_assistant: 0 });
    }
    const row = rows.get(key);
    row.sessions += 1;
    for (const field of ["user", "automation", "assistant", "messages", "tokens_user", "tokens_assistant"]) row[field] += session[field];
  }
  const list = [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.machine.localeCompare(b.machine));
  const total = { provider: "total", machine: "", sessions: 0, user: 0, automation: 0, assistant: 0, messages: 0, tokens_user: 0, tokens_assistant: 0 };
  for (const row of list) for (const field of Object.keys(total)) if (typeof row[field] === "number") total[field] += row[field];
  return [...list, total];
}

export function formatCountTable(rows) {
  const header = ["provider", "machine", "sessions", "user msgs", "automation", "assistant msgs", "honcho msgs", "~tok user", "~tok assistant"];
  const body = rows.map((row) => [
    row.provider,
    row.machine,
    row.sessions,
    row.user,
    row.automation,
    row.assistant,
    row.messages,
    row.tokens_user,
    row.tokens_assistant,
  ].map(String));
  const widths = header.map((title, index) => Math.max(title.length, ...body.map((cells) => cells[index].length)));
  const line = (cells) => cells.map((cell, index) => (index < 2 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]))).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

export function siblingPath(manifestPath, suffix) {
  return manifestPath.endsWith(".jsonl") ? `${manifestPath.slice(0, -".jsonl".length)}.${suffix}` : `${manifestPath}.${suffix}`;
}

/** plan: never makes an HTTP request. */
export async function plan(options, { log = console.log } = {}) {
  const timeZone = options.tz || DEFAULT_TZ;
  if (!options.from || !options.to) throw new Error("plan needs --from and --to");
  if (!options.roots?.length) throw new Error("plan needs at least one --root <provider>:<machine>:<dir>");
  if (!options.out) throw new Error("plan needs --out <manifest.jsonl>");
  const window = { fromMs: zonedInstant(options.from, timeZone), toMs: zonedInstant(options.to, timeZone) };
  if (!(window.fromMs < window.toMs)) throw new Error("--from must be before --to");
  const excludeIds = await readExcludeIds(options.excludeIds);
  const charLimit = Number(options.charLimit || DEFAULT_CHAR_LIMIT);
  const roots = options.roots.map((root) => (typeof root === "string" ? parseRoot(root) : root));

  const candidates = [];
  const exclusions = [];
  let scanned = 0;
  for (const root of roots) {
    const files = await scanRoot(root);
    for (const file of files) {
      scanned += 1;
      const result = await classifyFile(root, file, { window, excludeIds, charLimit, timeZone });
      if (result.excluded) {
        delete result.excluded;
        exclusions.push(result);
      } else {
        delete result.excluded;
        candidates.push(result);
      }
    }
  }
  const { kept, dropped } = dedupe(candidates, options.localMachine || "local");
  for (const item of dropped) {
    delete item.excluded;
    exclusions.push(item);
  }
  const sessions = sortSessions(kept).map((session, index) => ({ seq: index + 1, ...session }));
  const table = countTable(sessions);
  const byReason = {};
  for (const item of exclusions) {
    const key = `${item.reason}\t${item.provider}\t${item.machine}`;
    byReason[key] = (byReason[key] || 0) + 1;
  }

  await fsp.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await fsp.writeFile(options.out, sessions.map((session) => JSON.stringify(session)).join("\n") + (sessions.length ? "\n" : ""), "utf8");
  const exclusionsPath = siblingPath(options.out, "exclusions.jsonl");
  await fsp.writeFile(exclusionsPath, exclusions.map((item) => JSON.stringify(item)).join("\n") + (exclusions.length ? "\n" : ""), "utf8");
  const summary = {
    generated_at: new Date().toISOString(),
    window: { from: options.from, to: options.to, tz: timeZone, from_utc: new Date(window.fromMs).toISOString(), to_utc: new Date(window.toMs).toISOString() },
    roots: roots.map((root) => `${root.provider}:${root.machine}:${root.dir}`),
    exclude_ids: options.excludeIds || null,
    exclude_id_count: excludeIds.size,
    char_limit: charLimit,
    scanned_files: scanned,
    sessions: sessions.length,
    counts: table,
    exclusions_by_reason: byReason,
  };
  await fsp.writeFile(siblingPath(options.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  log(`window ${summary.window.from_utc} .. ${summary.window.to_utc} (${options.from} .. ${options.to} ${timeZone}, half-open)`);
  log(`scanned ${scanned} files, ${sessions.length} sessions in the manifest: ${options.out}`);
  log("");
  log(formatCountTable(table));
  log("");
  log("excluded (reason, provider, machine: files)");
  for (const [key, count] of Object.entries(byReason).sort()) log(`  ${key.replaceAll("\t", "  ")}: ${count}`);
  log(`exclusion details: ${exclusionsPath}`);
  return { sessions, exclusions, table, summary };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

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
      // A line cut short by a crash; the session it described is simply run again.
    }
  }
  return items;
}

export function assertWorkspaceAllowed(workspace) {
  const name = String(workspace || "").trim();
  if (!name) throw new Error("--workspace is required");
  if (PROTECTED_WORKSPACES.has(name.toLowerCase())) {
    throw new Error(`refusing to import into the live workspace "${name}"; a rebuild goes to its own workspace`);
  }
  return name;
}

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

export function honchoClient({ baseUrl = DEFAULT_BASE_URL, env = process.env, fetchImpl } = {}) {
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

/**
 * The workspace exists with summaries off, or is created that way. An existing
 * workspace with any other configuration is refused, never changed.
 */
export async function ensureWorkspace(request, workspace, { log = console.log } = {}) {
  const name = assertWorkspaceAllowed(workspace);
  const listed = await request("POST", "/v3/workspaces/list?page=1&size=10", { filters: { id: name } });
  const existing = (Array.isArray(listed?.items) ? listed.items : []).find((item) => item?.id === name);
  if (existing) {
    if (!sameConfiguration(existing.configuration)) {
      throw new Error(
        `workspace "${name}" exists with configuration ${JSON.stringify(existing.configuration || {})}; expected ${JSON.stringify(WORKSPACE_CONFIGURATION)}. Refusing to import.`,
      );
    }
    log(`workspace ${name} exists with ${JSON.stringify(existing.configuration)}`);
    return { created: false, workspace: existing };
  }
  const created = await request("POST", "/v3/workspaces", { id: name, configuration: WORKSPACE_CONFIGURATION });
  if (!sameConfiguration(created?.configuration)) {
    throw new Error(`workspace "${name}" came back with configuration ${JSON.stringify(created?.configuration || {})}; refusing to import.`);
  }
  log(`workspace ${name} created with ${JSON.stringify(created.configuration)}`);
  return { created: true, workspace: created };
}

/** The collector's environment for one session of the rebuild. */
export function collectorEnv(baseEnv, { provider, runDir, workspace, tag, baseUrl, userPeer = DEFAULT_USER_PEER, charLimit = DEFAULT_CHAR_LIMIT }) {
  const env = { ...baseEnv };
  // A target run (targets.mjs) filters by folder and points at another server; a
  // dry-run flag would make every session "succeed" without sending anything.
  for (const key of Object.keys(env)) {
    if (key.startsWith("HONCHO_AGENT_TARGET_") || key.startsWith("HONCHO_TARGET_")) delete env[key];
  }
  delete env.HONCHO_AGENT_DRY_RUN;
  delete env.HONCHO_CODEX_DRY_RUN;
  env.HONCHO_BASE_URL = baseUrl;
  env.HONCHO_WORKSPACE_ID = workspace;
  env.HONCHO_AGENT_PROVIDER = provider;
  env.HONCHO_USER_NAME = userPeer;
  env.HONCHO_AGENT_HOOK_STATE = path.join(runDir, "state", `${provider}.json`);
  env.HONCHO_AGENT_HOOK_LOG = path.join(runDir, "logs", `${provider}.log`);
  env.HONCHO_AGENT_IMPORT_TRIGGER = tag;
  env.HONCHO_CODEX_DREAM_EVERY_MESSAGES = "0";
  env.HONCHO_AGENT_HTTP_TIMEOUT_SECONDS = "60";
  env.HONCHO_AGENT_MESSAGE_CHAR_LIMIT = String(charLimit);
  return env;
}

export function collectorArgs(collectorPath, session, workspace) {
  return [collectorPath, "--provider", session.provider, "--transcript", session.file, "--workspace", workspace];
}

function runCollector(collectorPath, session, workspace, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, collectorArgs(collectorPath, session, workspace), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

export const ledgerKey = (session) => `${session.session_id}\t${session.file}`;

export async function run(options, { log = console.log, env = process.env, request } = {}) {
  const workspace = assertWorkspaceAllowed(options.workspace);
  if (!options.manifest) throw new Error("run needs --manifest");
  if (!options.runDir) throw new Error("run needs --run-dir");
  const runDir = path.resolve(options.runDir);
  const baseUrl = String(options.baseUrl || env.HONCHO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const tag = options.tag || `rebuild:${workspace}`;
  const collectorPath = options.collector || DEFAULT_COLLECTOR;
  const maxFailures = Number(options.maxFailures || DEFAULT_MAX_FAILURES);
  const userPeer = options.userPeer || DEFAULT_USER_PEER;
  const manifest = await readJsonl(options.manifest);
  if (!manifest.length) throw new Error(`manifest is empty: ${options.manifest}`);
  let charLimit = DEFAULT_CHAR_LIMIT;
  try {
    charLimit = Number(JSON.parse(await fsp.readFile(siblingPath(options.manifest, "summary.json"), "utf8")).char_limit) || DEFAULT_CHAR_LIMIT;
  } catch {}

  const ledgerPath = path.join(runDir, "ledger.jsonl");
  const done = new Set();
  for (const entry of await readJsonl(ledgerPath)) {
    if (entry.workspace && entry.workspace !== workspace) {
      throw new Error(`ledger ${ledgerPath} belongs to workspace "${entry.workspace}", not "${workspace}"`);
    }
    if (entry.status === "ok") done.add(ledgerKey(entry));
  }
  await ensureWorkspace(request || honchoClient({ baseUrl, env }), workspace, { log });
  await fsp.mkdir(path.join(runDir, "state"), { recursive: true });
  await fsp.mkdir(path.join(runDir, "logs"), { recursive: true });
  const pending = manifest.filter((session) => !done.has(ledgerKey(session)));
  const limit = options.limit ? Number(options.limit) : Infinity;
  log(`${manifest.length} sessions in the manifest, ${manifest.length - pending.length} already done, ${pending.length} to go`);

  let consecutive = 0;
  let ok = 0;
  let failed = 0;
  for (const session of pending.slice(0, limit)) {
    const childEnv = collectorEnv(env, { provider: session.provider, runDir, workspace, tag, baseUrl, userPeer, charLimit });
    const startedAt = new Date().toISOString();
    const outcome = await runCollector(collectorPath, session, workspace, childEnv);
    const result = lastJson(outcome.stdout) || lastJson(outcome.stderr);
    const success = outcome.code === 0 && result?.ok === true;
    const entry = {
      seq: session.seq,
      session_id: session.session_id,
      file: session.file,
      provider: session.provider,
      machine: session.machine,
      workspace,
      status: success ? "ok" : "failed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      expected_messages: session.messages,
      new_messages: result?.new_messages ?? null,
      honcho_message_total: result?.honcho_message_total ?? null,
      exit_code: outcome.code,
    };
    if (!success) entry.error = String(result?.error || outcome.stderr || outcome.stdout || "no output").slice(0, 2000);
    await fsp.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
    if (success) {
      ok += 1;
      consecutive = 0;
      const note = result.new_messages !== session.messages ? ` (manifest says ${session.messages})` : "";
      log(`[${session.seq}/${manifest.length}] ok ${session.session_id} ${result.new_messages} new messages${note}`);
    } else {
      failed += 1;
      consecutive += 1;
      log(`[${session.seq}/${manifest.length}] FAILED ${session.session_id}: ${entry.error.split("\n")[0]}`);
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

export function compareSession(session, messages) {
  const problems = [];
  if (messages.length !== session.messages) problems.push(`messages ${messages.length} != manifest ${session.messages}`);
  if (messages.length) {
    const times = messages.map((message) => Date.parse(message.created_at)).filter(Number.isFinite);
    const min = new Date(Math.min(...times)).toISOString();
    const max = new Date(Math.max(...times)).toISOString();
    if (Date.parse(min) !== Date.parse(session.start)) problems.push(`first created_at ${min} != manifest ${session.start}`);
    if (Date.parse(max) !== Date.parse(session.end)) problems.push(`last created_at ${max} != manifest ${session.end}`);
  }
  return problems;
}

export async function verify(options, { log = console.log, env = process.env, request } = {}) {
  const workspace = assertWorkspaceAllowed(options.workspace);
  if (!options.manifest) throw new Error("verify needs --manifest");
  const baseUrl = String(options.baseUrl || env.HONCHO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const send = request || honchoClient({ baseUrl, env });
  const manifest = await readJsonl(options.manifest);
  let only = null;
  if (options.runDir) {
    only = new Set((await readJsonl(path.join(path.resolve(options.runDir), "ledger.jsonl"))).filter((e) => e.status === "ok").map(ledgerKey));
  }
  const report = { checked: 0, matched: 0, mismatched: 0, missing: 0, skipped: 0, problems: [] };
  for (const session of manifest) {
    if (only && !only.has(ledgerKey(session))) {
      report.skipped += 1;
      continue;
    }
    report.checked += 1;
    let messages;
    try {
      messages = await sessionMessages(send, workspace, session.session_id);
    } catch (error) {
      if (error.status === 404) {
        report.missing += 1;
        report.problems.push({ seq: session.seq, session_id: session.session_id, problems: ["session not found"] });
        continue;
      }
      throw error;
    }
    const problems = compareSession(session, messages);
    if (problems.length) {
      report.mismatched += 1;
      report.problems.push({ seq: session.seq, session_id: session.session_id, problems });
    } else report.matched += 1;
  }
  for (const item of report.problems) log(`[${item.seq}] ${item.session_id}: ${item.problems.join("; ")}`);
  log(
    `checked ${report.checked}, matched ${report.matched}, mismatched ${report.mismatched}, missing ${report.missing}` +
      (only ? `, skipped ${report.skipped} not yet ok in the ledger` : ""),
  );
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS = {
  "--from": "from",
  "--to": "to",
  "--tz": "tz",
  "--exclude-ids": "excludeIds",
  "--out": "out",
  "--char-limit": "charLimit",
  "--local-machine": "localMachine",
  "--manifest": "manifest",
  "--workspace": "workspace",
  "--run-dir": "runDir",
  "--tag": "tag",
  "--base-url": "baseUrl",
  "--collector": "collector",
  "--max-failures": "maxFailures",
  "--limit": "limit",
  "--user-peer": "userPeer",
};

export function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = { roots: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--root") {
      options.roots.push(parseRoot(value));
      index += 1;
    } else if (FLAGS[flag]) {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[FLAGS[flag]] = value;
      index += 1;
    } else throw new Error(`unknown option: ${flag}`);
  }
  return { command, options };
}

const USAGE = `usage:
  rebuild-import.mjs plan --from 2026-09-01 --to 2026-10-01 [--tz Asia/Seoul]
                          --root <claude|codex>:<machine>:<dir> [--root ...]
                          [--exclude-ids <file>] --out <manifest.jsonl>
  rebuild-import.mjs run --manifest <manifest.jsonl> --workspace <id> --run-dir <dir>
                         [--tag <trigger>] [--base-url URL] [--limit N] [--max-failures 3]
  rebuild-import.mjs verify --manifest <manifest.jsonl> --workspace <id> [--run-dir <dir>] [--base-url URL]`;

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`rebuild-import: ${error?.message || error}`);
    process.exitCode = 2;
  }
}
