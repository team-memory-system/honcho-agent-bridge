import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ROOT_URL = (process.env.HONCHO_BASE_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.HONCHO_API_BEARER_TOKEN || "";
const DEFAULT_WORKSPACE = process.env.HONCHO_WORKSPACE_ID || "memory";
const DEFAULT_USER_PEER = process.env.HONCHO_USER_NAME || "user_chen";
const DEFAULT_ASSISTANT_PEER = process.env.HONCHO_ASSISTANT_NAME || "assistant_codex";
const DEFAULT_AUTOMATION_PEER = process.env.HONCHO_CODEX_AUTOMATION_PEER || "automation_codex";
const SESSION_ROOT = expandHome(process.env.CODEX_SESSION_ROOT || "~/.codex/sessions");
const STATE_PATH = expandHome(process.env.HONCHO_CODEX_HOOK_STATE || "~/.hermes/state/codex-honcho-turn-ended.json");
const LOG_PATH = expandHome(process.env.HONCHO_CODEX_HOOK_LOG || "~/.hermes/logs/codex-honcho-turn-ended.log");
const MAX_AGE_SECONDS = Number(process.env.HONCHO_CODEX_IMPORT_MAX_AGE_SECONDS || "180");
const DREAM_EVERY_MESSAGES = Number(process.env.HONCHO_CODEX_DREAM_EVERY_MESSAGES || "20");
const HTTP_TIMEOUT_SECONDS = Number(process.env.HONCHO_CODEX_HTTP_TIMEOUT_SECONDS || "8");
const MESSAGE_CHAR_LIMIT = Number(process.env.HONCHO_CODEX_MESSAGE_CHAR_LIMIT || "24000");
const STATE_HASH_LIMIT_PER_SESSION = Number(process.env.HONCHO_CODEX_STATE_HASH_LIMIT || "5000");
const IMPORT_TRIGGER = process.env.HONCHO_CODEX_IMPORT_TRIGGER || "manual";

const NOISE_PREFIXES = [
  "# AGENTS.md instructions for ",
  "# CLAUDE.md instructions for ",
  "<permissions instructions>",
  "<app-context>",
  "<environment_context>",
  "<local-command-caveat>",
  "<command-message>",
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<task-notification>",
];
const NOISE_SUBSTRINGS = [
  "This file defines global defaults for coding agents on this machine.",
  "## Node.js Package Manager",
  "## Python Package Manager",
  "Global Agent Policy",
];
const REQUEST_MARKERS = ["## My request for Codex:", "My request for Codex:"];
const AUTOMATION_USER_PREFIXES = [
  "Automation:",
  "Watchdog intervention",
  "Watchdog follow-up",
  "Watchdog redirection",
  "<subagent_notification>",
];
const LINEAR_TASK_PREFIXES = ["You are working on a Linear issue", "You are working on a Linear ticket"];

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function utcNow() {
  return new Date().toISOString();
}

async function logLine(message) {
  await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fsp.appendFile(LOG_PATH, `${utcNow()} ${message}\n`, "utf8");
}

async function jsonRequest(method, apiPath, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_SECONDS * 1000);
  const headers = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  try {
    const response = await fetch(`${ROOT_URL}${apiPath}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${apiPath}: ${body}`);
    return body ? JSON.parse(body) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function quote(value) {
  return encodeURIComponent(value);
}

function normalizeCreatedAt(value) {
  if (typeof value === "number") {
    const seconds = value > 1_000_000_000_000 ? value / 1000 : value;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return normalizeCreatedAt(numeric);
  return trimmed;
}

function normalizeText(text) {
  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!out) return "";
  for (const marker of REQUEST_MARKERS) {
    if (out.includes(marker)) {
      out = out.split(marker, 2)[1].trim();
      break;
    }
  }
  if (NOISE_PREFIXES.some((prefix) => out.startsWith(prefix))) return "";
  if (NOISE_SUBSTRINGS.some((token) => out.includes(token))) return "";
  return out.trim();
}

function extractTextBlocks(items) {
  const texts = [];
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    if (!["input_text", "output_text", "text"].includes(item.type)) continue;
    if (typeof item.text === "string" && item.text.trim()) texts.push(item.text.trim());
  }
  return normalizeText(texts.join("\n\n"));
}

function sanitizeId(value, prefix = "") {
  const base = prefix ? `${prefix}-${value}` : String(value);
  const stem = path.parse(base).name;
  const cleaned = stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "session").slice(0, 100);
}

async function latestRolloutPath(maxAgeSeconds) {
  const roots = [];
  try {
    for (const year of await fsp.readdir(SESSION_ROOT, { withFileTypes: true })) {
      if (year.isDirectory()) roots.push(path.join(SESSION_ROOT, year.name));
    }
  } catch {
    return null;
  }
  let latest = null;
  const stack = roots.length ? roots : [SESSION_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      const stat = await fsp.stat(full);
      if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { full, mtimeMs: stat.mtimeMs };
    }
  }
  if (!latest) return null;
  if (maxAgeSeconds > 0 && Date.now() - latest.mtimeMs > maxAgeSeconds * 1000) return null;
  return latest.full;
}

async function parseCodexRollout(rolloutPath) {
  const metadata = { source: "codex", file_path: rolloutPath };
  const turns = [];
  const lines = (await fsp.readFile(rolloutPath, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
      Object.assign(metadata, {
        original_session_id: obj.payload.id,
        cwd: obj.payload.cwd,
        originator: obj.payload.originator,
        cli_version: obj.payload.cli_version,
        source_app: obj.payload.source,
        model_provider: obj.payload.model_provider,
      });
      continue;
    }
    const payload = obj.payload || {};
    if (obj.type !== "response_item" || payload.type !== "message") continue;
    if (!["user", "assistant"].includes(payload.role)) continue;
    const text = extractTextBlocks(payload.content);
    if (!text) continue;
    turns.push({
      role: payload.role,
      content: text,
      created_at: normalizeCreatedAt(obj.timestamp),
      line_index: index + 1,
      phase: payload.phase,
    });
  }
  return {
    session_id: sanitizeId(metadata.original_session_id || path.basename(rolloutPath), "codex"),
    metadata,
    turns,
  };
}

async function loadState(statePath) {
  try {
    const data = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (data && typeof data === "object") {
      data.version ??= 1;
      data.sessions ??= {};
      return data;
    }
  } catch {}
  return { version: 1, sessions: {} };
}

async function saveState(statePath, state) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, statePath);
}

function turnHash(sessionId, turn) {
  const identity = {
    session_id: sessionId,
    line_index: turn.line_index,
    role: turn.role,
    content: turn.content,
  };
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function splitContent(text) {
  if (text.length <= MESSAGE_CHAR_LIMIT) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MESSAGE_CHAR_LIMIT, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + Math.floor(MESSAGE_CHAR_LIMIT / 2)) end = newline;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

function isAutomationTurn(text, sessionMetadata) {
  if (AUTOMATION_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) return [true, "codex_cron"];
  if (LINEAR_TASK_PREFIXES.some((prefix) => text.startsWith(prefix))) return [true, "symphony_linear"];
  const { originator, source_app: sourceApp, cwd } = sessionMetadata;
  if (originator === "Claude Code") return [true, "claude_code_codex"];
  if (originator === "symphony-orchestrator") return [true, "symphony_linear"];
  if (originator === "codex_sdk_ts" || cwd === "/") return [true, "codex_sdk_ts"];
  if (sourceApp === "exec") return [true, "codex_exec"];
  if (typeof cwd === "string" && cwd.includes("/.symphony/workspaces/")) return [true, "symphony_linear"];
  return [false, null];
}

function buildHonchoMessages(sessionId, parsed, sessionState) {
  const seenHashes = new Set(sessionState.imported_hashes || []);
  const pendingHashes = [];
  const peers = new Set([DEFAULT_USER_PEER, DEFAULT_ASSISTANT_PEER]);
  const messages = [];
  for (const turn of parsed.turns) {
    const digest = turnHash(sessionId, turn);
    if (seenHashes.has(digest)) continue;
    const role = turn.role;
    let peerId = DEFAULT_ASSISTANT_PEER;
    let directUser = false;
    let memoryOrigin = "codex_assistant";
    let automationKind = null;
    if (role === "user") {
      const automation = isAutomationTurn(turn.content, parsed.metadata);
      automationKind = automation[1];
      peerId = automation[0] ? DEFAULT_AUTOMATION_PEER : DEFAULT_USER_PEER;
      directUser = !automation[0];
      memoryOrigin = automation[0] ? "codex_automation" : "codex_direct_user";
    }
    peers.add(peerId);
    const chunks = splitContent(turn.content);
    chunks.forEach((chunk, index) => {
      const metadata = {
        source: "codex",
        memory_importer: "codex_turn_ended",
        memory_trigger: IMPORT_TRIGGER,
        codex_session_id: sessionId,
        codex_rollout_path: parsed.metadata.file_path,
        codex_line_index: turn.line_index,
        codex_role: role,
        memory_origin: memoryOrigin,
        direct_user: directUser,
      };
      if (turn.phase) metadata.codex_phase = turn.phase;
      if (automationKind) metadata.automation_kind = automationKind;
      if (chunks.length > 1) {
        metadata.split_part = index + 1;
        metadata.split_total = chunks.length;
      }
      const message = { peer_id: peerId, content: chunk, metadata };
      if (turn.created_at) message.created_at = turn.created_at;
      messages.push(message);
    });
    pendingHashes.push(digest);
  }
  return [messages, pendingHashes, peers];
}

async function ensureSession(workspace, sessionId, parsed, peers) {
  const peerConfig = {};
  for (const peer of peers) {
    peerConfig[peer] =
      peer === DEFAULT_ASSISTANT_PEER
        ? { observe_me: false, observe_others: true }
        : { observe_me: true, observe_others: false };
  }
  const metadata = {
    source: "codex",
    file_path: parsed.metadata.file_path,
    original_session_id: parsed.metadata.original_session_id,
    cwd: parsed.metadata.cwd,
    originator: parsed.metadata.originator,
    cli_version: parsed.metadata.cli_version,
    source_app: parsed.metadata.source_app,
    model_provider: parsed.metadata.model_provider,
    memory_importer: "codex_turn_ended",
    last_imported_at: utcNow(),
  };
  for (const key of Object.keys(metadata)) if (metadata[key] == null) delete metadata[key];
  await jsonRequest("POST", `/v3/workspaces/${quote(workspace)}/sessions`, {
    id: sessionId,
    metadata,
    configuration: {},
    peers: peerConfig,
  });
}

async function addMessages(workspace, sessionId, messages) {
  for (let start = 0; start < messages.length; start += 100) {
    await jsonRequest("POST", `/v3/workspaces/${quote(workspace)}/sessions/${quote(sessionId)}/messages`, {
      messages: messages.slice(start, start + 100),
    });
  }
}

async function existingMessageTotal(workspace, sessionId) {
  const data = await jsonRequest("POST", `/v3/workspaces/${quote(workspace)}/sessions/${quote(sessionId)}/messages/list`, {});
  return Number(data.total || 0);
}

async function syncStateFromHonchoPrefix(workspace, sessionId, parsed, sessionState) {
  let messageTotal = 0;
  try {
    messageTotal = await existingMessageTotal(workspace, sessionId);
  } catch (error) {
    await logLine(`STATE_SYNC_SKIPPED ${sessionId} ${error?.name || "Error"}: ${error?.message || error}`);
    return [0, 0];
  }

  if (messageTotal <= 0) return [0, 0];

  const importedHashes = [...(sessionState.imported_hashes || [])];
  const seenHashes = new Set(importedHashes);
  let coveredMessages = 0;
  let syncedTurns = 0;

  for (const turn of parsed.turns) {
    const chunkCount = splitContent(turn.content).length;
    if (coveredMessages + chunkCount > messageTotal) break;
    coveredMessages += chunkCount;

    const digest = turnHash(sessionId, turn);
    if (!seenHashes.has(digest)) {
      importedHashes.push(digest);
      seenHashes.add(digest);
      syncedTurns += 1;
    }
  }

  if (syncedTurns) {
    sessionState.imported_hashes = importedHashes.slice(-STATE_HASH_LIMIT_PER_SESSION);
    sessionState.synced_from_honcho_at = utcNow();
    sessionState.synced_from_honcho_message_total = messageTotal;
  }

  return [syncedTurns, messageTotal];
}

async function scheduleDreamIfDue(workspace, sessionId, sessionState) {
  if (DREAM_EVERY_MESSAGES <= 0) return false;
  if (Number(sessionState.messages_since_dream || 0) < DREAM_EVERY_MESSAGES) return false;
  await jsonRequest("POST", `/v3/workspaces/${quote(workspace)}/schedule_dream`, {
    observer: DEFAULT_ASSISTANT_PEER,
    observed: DEFAULT_USER_PEER,
    dream_type: "omni",
    session_id: sessionId,
  });
  sessionState.messages_since_dream = 0;
  sessionState.last_dream_at = utcNow();
  return true;
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

async function withLock(lockPath, fn) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      handle = await fsp.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!handle) return fn();
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
}

async function importLatest(args) {
  if (!args.rollout) {
    const hookInput = await readHookInput();
    if (typeof hookInput.transcript_path === "string" && hookInput.transcript_path.trim()) {
      args.rollout = hookInput.transcript_path.trim();
    }
  }
  const rolloutPath = args.rollout || (await latestRolloutPath(args.maxAgeSeconds));
  if (!rolloutPath) return { ok: true, skipped: "no recent rollout file" };
  if (!fs.existsSync(rolloutPath)) return { ok: false, error: `rollout not found: ${rolloutPath}` };
  const parsed = await parseCodexRollout(rolloutPath);
  const sessionId = parsed.session_id;
  const lockPath = `${STATE_PATH}.lock`;
  return withLock(lockPath, async () => {
    const state = await loadState(STATE_PATH);
    const sessions = (state.sessions ||= {});
    const sessionState = (sessions[sessionId] ||= { imported_hashes: [], messages_since_dream: 0 });
    sessionState.rollout_path = rolloutPath;
    const [syncedTurns, honchoMessageTotal] = await syncStateFromHonchoPrefix(
      args.workspace,
      sessionId,
      parsed,
      sessionState,
    );
    const [messages, pendingHashes, peers] = buildHonchoMessages(sessionId, parsed, sessionState);
    const result = {
      ok: true,
      workspace: args.workspace,
      session_id: sessionId,
      rollout_path: rolloutPath,
      parsed_turns: parsed.turns.length,
      new_turns: pendingHashes.length,
      new_messages: messages.length,
      dream_scheduled: false,
      dry_run: Boolean(args.dryRun),
      state_synced_turns: syncedTurns,
      honcho_message_total: honchoMessageTotal,
    };
    if (args.dryRun || messages.length === 0) {
      if (syncedTurns && !args.dryRun) await saveState(STATE_PATH, state);
      return result;
    }
    await ensureSession(args.workspace, sessionId, parsed, peers);
    await addMessages(args.workspace, sessionId, messages);
    sessionState.imported_hashes = [...(sessionState.imported_hashes || []), ...pendingHashes].slice(
      -STATE_HASH_LIMIT_PER_SESSION,
    );
    sessionState.last_imported_at = utcNow();
    sessionState.messages_since_dream = Number(sessionState.messages_since_dream || 0) + messages.length;
    result.dream_scheduled = await scheduleDreamIfDue(args.workspace, sessionId, sessionState);
    await saveState(STATE_PATH, state);
    return result;
  });
}

function parseArgs() {
  const args = {
    rollout: process.env.CODEX_ROLLOUT_PATH || "",
    workspace: DEFAULT_WORKSPACE,
    maxAgeSeconds: MAX_AGE_SECONDS,
    dryRun: process.env.HONCHO_CODEX_DRY_RUN === "1",
  };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") args.dryRun = true;
    else if (item === "--rollout") args.rollout = argv[++index] || "";
    else if (item === "--workspace") args.workspace = argv[++index] || DEFAULT_WORKSPACE;
    else if (item === "--max-age-seconds") args.maxAgeSeconds = Number(argv[++index] || MAX_AGE_SECONDS);
  }
  return args;
}

async function main() {
  const quiet = ["hook", "notify"].includes(IMPORT_TRIGGER) || process.env.HONCHO_CODEX_QUIET === "1";
  try {
    const result = await importLatest(parseArgs());
    await logLine(JSON.stringify(result));
    if (!quiet) console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    await logLine(`ERROR ${error?.name || "Error"}: ${error?.message || error}`);
    if (!quiet) console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    return 1;
  }
}

process.exitCode = await main();
