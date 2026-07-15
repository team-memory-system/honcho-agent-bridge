import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getProvider } from "./providers/index.mjs";
import { classifyAutomation as classifyCodexAutomation } from "./providers/codex.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";

const ROOT_URL = (process.env.HONCHO_BASE_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.HONCHO_API_BEARER_TOKEN || "";
const DEFAULT_WORKSPACE = process.env.HONCHO_WORKSPACE_ID || "memory";
const DEFAULT_USER_PEER = process.env.HONCHO_USER_NAME || "user";
const HTTP_TIMEOUT_SECONDS = Number(
  process.env.HONCHO_AGENT_HTTP_TIMEOUT_SECONDS || process.env.HONCHO_CODEX_HTTP_TIMEOUT_SECONDS || "8",
);
const MESSAGE_CHAR_LIMIT = Number(
  process.env.HONCHO_AGENT_MESSAGE_CHAR_LIMIT || process.env.HONCHO_CODEX_MESSAGE_CHAR_LIMIT || "24000",
);
const STATE_LOCK_STALE_MS = Number(process.env.HONCHO_AGENT_STATE_LOCK_STALE_MS || "120000");
const IMPORT_TRIGGER = process.env.HONCHO_AGENT_IMPORT_TRIGGER || process.env.HONCHO_CODEX_IMPORT_TRIGGER || "manual";

const SUPPORTED_PROVIDERS = new Set(["codex", "claude", "agy"]);
const CODEX_SESSION_ROOT = expandHome(process.env.CODEX_SESSION_ROOT || "~/.codex/sessions");
const CODEX_MAX_AGE_SECONDS = Number(process.env.HONCHO_CODEX_IMPORT_MAX_AGE_SECONDS || "180");
const CODEX_DREAM_EVERY_MESSAGES = Number(process.env.HONCHO_CODEX_DREAM_EVERY_MESSAGES || "20");
const CODEX_AUTOMATION_PEER = process.env.HONCHO_CODEX_AUTOMATION_PEER || "automation_codex";


function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function utcNow() {
  return new Date().toISOString();
}

function quote(value) {
  return encodeURIComponent(value);
}

function parseArgs() {
  const args = {
    provider: process.env.HONCHO_AGENT_PROVIDER || "codex",
    transcript: "",
    workspace: DEFAULT_WORKSPACE,
    maxAgeSeconds: CODEX_MAX_AGE_SECONDS,
    dryRun: process.env.HONCHO_AGENT_DRY_RUN === "1" || process.env.HONCHO_CODEX_DRY_RUN === "1",
    hookInputFile: "",
  };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--provider") args.provider = argv[++index] || args.provider;
    else if (item === "--transcript" || item === "--transcript-path" || item === "--rollout") {
      args.transcript = argv[++index] || "";
    } else if (item === "--workspace") args.workspace = argv[++index] || DEFAULT_WORKSPACE;
    else if (item === "--max-age-seconds") args.maxAgeSeconds = Number(argv[++index] || CODEX_MAX_AGE_SECONDS);
    else if (item === "--dry-run") args.dryRun = true;
    else if (item === "--hook-input-file") args.hookInputFile = argv[++index] || "";
  }
  args.provider = args.provider.trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(args.provider)) throw new Error(`unsupported provider: ${args.provider}`);
  if (args.provider === "codex" && !args.transcript) args.transcript = process.env.CODEX_ROLLOUT_PATH || "";
  return args;
}

async function readHookInput(filePath) {
  if (filePath) {
    try {
      const entry = JSON.parse(await fsp.readFile(filePath, "utf8"));
      return entry.hook_input && typeof entry.hook_input === "object" ? entry.hook_input : entry;
    } catch {
      return {};
    }
  }
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

async function latestCodexRolloutPath(maxAgeSeconds) {
  const roots = [];
  try {
    for (const year of await fsp.readdir(CODEX_SESSION_ROOT, { withFileTypes: true })) {
      if (year.isDirectory()) roots.push(path.join(CODEX_SESSION_ROOT, year.name));
    }
  } catch {
    return null;
  }
  let latest = null;
  const stack = roots.length ? roots : [CODEX_SESSION_ROOT];
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

function statePath(provider) {
  const explicit = process.env.HONCHO_AGENT_HOOK_STATE;
  if (explicit) return expandHome(explicit);
  return expandHome(`~/.hermes/state/${provider}-honcho-turn-ended.json`);
}

function logPath(provider) {
  const explicit = process.env.HONCHO_AGENT_HOOK_LOG;
  if (explicit) return expandHome(explicit);
  return expandHome(`~/.hermes/logs/${provider}-honcho-turn-ended.log`);
}

async function logLine(provider, message) {
  const target = logPath(provider);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.appendFile(target, `${utcNow()} ${message}\n`, "utf8");
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

function assistantPeer(provider) {
  const envKey = `HONCHO_${provider.toUpperCase()}_ASSISTANT_NAME`;
  return process.env[envKey] || process.env.HONCHO_ASSISTANT_NAME || `assistant_${provider}`;
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

async function loadState(provider) {
  try {
    const data = JSON.parse(await fsp.readFile(statePath(provider), "utf8"));
    if (data && typeof data === "object") {
      data.version ??= 1;
      data.sessions ??= {};
      return data;
    }
  } catch {}
  return { version: 2, sessions: {} };
}

async function saveState(provider, state) {
  const target = statePath(provider);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, target);
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function legacyTurnHash(sessionId, turn) {
  const identity = {
    session_id: sessionId,
    source_message_id: turn.source_message_id || null,
    line_index: turn.source_message_id ? null : turn.line_index,
    step_index: turn.source_message_id ? null : turn.step_index,
    role: turn.role,
    content: turn.content,
  };
  return digest(identity);
}

function turnHashCandidates(sessionId, turn) {
  const candidates = [];
  if (turn.source_message_id) {
    candidates.push(digest({ version: 2, session_id: sessionId, source_message_id: turn.source_message_id, role: turn.role }));
  }
  if (turn.line_index != null || turn.step_index != null) {
    candidates.push(
      digest({
        version: 2,
        session_id: sessionId,
        line_index: turn.line_index ?? null,
        step_index: turn.step_index ?? null,
        role: turn.role,
      }),
    );
  }
  if (candidates.length === 0) {
    candidates.push(digest({ version: 2, session_id: sessionId, role: turn.role, content: turn.content }));
  }
  candidates.push(legacyTurnHash(sessionId, turn));
  return [...new Set(candidates)];
}

function primaryTurnHash(sessionId, turn) {
  return turnHashCandidates(sessionId, turn)[0];
}

function mergeStateHashes(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function buildMessages(provider, sessionId, parsed, sessionState) {
  const seenHashes = new Set(sessionState.imported_hashes || []);
  const pendingHashes = [];
  const peers = new Set([DEFAULT_USER_PEER, assistantPeer(provider)]);
  const messages = [];

  for (const turn of parsed.turns) {
    const candidates = turnHashCandidates(sessionId, turn);
    if (candidates.some((candidate) => seenHashes.has(candidate))) continue;
    const sourceTurnHash = candidates[0];
    const peerId = turn.role === "user" ? DEFAULT_USER_PEER : assistantPeer(provider);
    peers.add(peerId);
    const chunks = splitContent(turn.content);
    chunks.forEach((chunk, index) => {
      const metadata = {
        source: provider,
        agent_provider: provider,
        memory_importer: "agent_turn_ended",
        memory_trigger: IMPORT_TRIGGER,
        memory_origin: turn.role === "user" ? `${provider}_direct_user` : `${provider}_assistant`,
        direct_user: turn.role === "user",
        transcript_path: parsed.metadata.file_path,
        [`${provider}_session_id`]: sessionId,
        [`${provider}_role`]: turn.role,
        source_turn_hash: sourceTurnHash,
      };
      if (turn.line_index) metadata[`${provider}_line_index`] = turn.line_index;
      if (turn.source_message_id) metadata.source_message_id = turn.source_message_id;
      if (turn.step_index != null) metadata[`${provider}_step_index`] = turn.step_index;
      if (turn.step_type) metadata[`${provider}_step_type`] = turn.step_type;
      if (chunks.length > 1) {
        metadata.split_part = index + 1;
        metadata.split_total = chunks.length;
      }
      const message = { peer_id: peerId, content: chunk, metadata };
      if (turn.created_at) message.created_at = turn.created_at;
      messages.push(message);
    });
    pendingHashes.push(sourceTurnHash);
    candidates.forEach((candidate) => seenHashes.add(candidate));
  }

  return [messages, pendingHashes, peers];
}

function buildCodexMessages(sessionId, parsed, sessionState) {
  const seenHashes = new Set(sessionState.imported_hashes || []);
  const pendingHashes = [];
  const codexAssistantPeer = assistantPeer("codex");
  const peers = new Set([DEFAULT_USER_PEER, codexAssistantPeer]);
  const messages = [];
  for (const turn of parsed.turns) {
    const candidates = turnHashCandidates(sessionId, turn);
    if (candidates.some((candidate) => seenHashes.has(candidate))) continue;
    const sourceTurnHash = candidates[0];
    const role = turn.role;
    let peerId = codexAssistantPeer;
    let directUser = false;
    let memoryOrigin = "codex_assistant";
    let automationKind = null;
    if (role === "user") {
      const automation = classifyCodexAutomation(turn.content, parsed.metadata);
      automationKind = automation[1];
      peerId = automation[0] ? CODEX_AUTOMATION_PEER : DEFAULT_USER_PEER;
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
        source_turn_hash: sourceTurnHash,
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
    pendingHashes.push(sourceTurnHash);
    candidates.forEach((candidate) => seenHashes.add(candidate));
  }
  return [messages, pendingHashes, peers];
}

async function ensureSession(workspace, provider, sessionId, parsed, peers) {
  const peerConfig = {};
  for (const peer of peers) {
    peerConfig[peer] = { observe_me: true, observe_others: false };
  }
  const metadata = {
    ...parsed.metadata,
    source: provider,
    agent_provider: provider,
    memory_importer: provider === "codex" ? "codex_turn_ended" : "agent_turn_ended",
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
  const groups = [];
  for (const message of messages) {
    const key = message?.metadata?.source_turn_hash || crypto.randomUUID();
    const current = groups.at(-1);
    if (current?.key === key) current.messages.push(message);
    else groups.push({ key, messages: [message] });
  }
  if (groups.some((group) => group.messages.length > 100)) {
    throw new Error("A single transcript turn exceeds Honcho's 100-message atomic batch limit");
  }
  const batches = [];
  let batch = [];
  for (const group of groups) {
    if (batch.length && batch.length + group.messages.length > 100) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...group.messages);
  }
  if (batch.length) batches.push(batch);
  for (const items of batches) {
    await jsonRequest("POST", `/v3/workspaces/${quote(workspace)}/sessions/${quote(sessionId)}/messages`, {
      messages: items,
    });
  }
}

async function existingMessages(workspace, sessionId) {
  const messages = [];
  let page = 1;
  let total = 0;
  while (true) {
    const data = await jsonRequest(
      "POST",
      `/v3/workspaces/${quote(workspace)}/sessions/${quote(sessionId)}/messages/list?page=${page}&size=100&reverse=false`,
      {},
    );
    const items = Array.isArray(data.items) ? data.items : [];
    total = Number(data.total || items.length || 0);
    messages.push(...items);
    if (items.length < 100 || messages.length >= total) break;
    page += 1;
  }
  return { messages, total };
}

function hashesFromStoredMessage(provider, sessionId, message) {
  const metadata = message?.metadata || {};
  if (typeof metadata.source_turn_hash === "string" && metadata.source_turn_hash) {
    return [metadata.source_turn_hash];
  }
  const lineIndex = metadata[`${provider}_line_index`];
  const stepIndex = metadata[`${provider}_step_index`];
  const sourceMessageId = metadata.source_message_id;
  const role = metadata[`${provider}_role`];
  if (!sourceMessageId && lineIndex == null && stepIndex == null) return [];
  return turnHashCandidates(sessionId, {
    source_message_id: sourceMessageId,
    line_index: lineIndex,
    step_index: stepIndex,
    role,
    content: message?.content || "",
  }).slice(0, -1);
}

async function syncStateFromHoncho(provider, workspace, sessionId, sessionState) {
  if (sessionState.reconciled_source_hashes_at && !sessionState.write_in_progress) {
    return [0, Number(sessionState.synced_from_honcho_message_total || 0), false];
  }
  let listed;
  try {
    listed = await existingMessages(workspace, sessionId);
  } catch (error) {
    await logLine(provider, `STATE_SYNC_SKIPPED ${sessionId} ${error?.name || "Error"}: ${error?.message || error}`);
    if (sessionState.write_in_progress || !sessionState.reconciled_source_hashes_at) {
      throw new Error(`Cannot safely retry ${sessionId} until Honcho message reconciliation succeeds`);
    }
    return [0, 0, false];
  }

  const existing = new Set(sessionState.imported_hashes || []);
  const recovered = [];
  for (const message of listed.messages) {
    for (const candidate of hashesFromStoredMessage(provider, sessionId, message)) {
      if (!existing.has(candidate)) {
        existing.add(candidate);
        recovered.push(candidate);
      }
    }
  }
  sessionState.imported_hashes = mergeStateHashes(sessionState.imported_hashes || [], recovered);
  delete sessionState.write_in_progress;
  sessionState.reconciled_source_hashes_at = utcNow();
  sessionState.synced_from_honcho_message_total = listed.total;
  return [recovered.length, listed.total, true];
}

async function scheduleCodexDreamIfDue(workspace, sessionId, sessionState) {
  if (CODEX_DREAM_EVERY_MESSAGES <= 0) return false;
  if (Number(sessionState.messages_since_dream || 0) < CODEX_DREAM_EVERY_MESSAGES) return false;
  await jsonRequest("POST", `/v3/workspaces/${quote(workspace)}/schedule_dream`, {
    observer: assistantPeer("codex"),
    observed: DEFAULT_USER_PEER,
    dream_type: "omni",
    session_id: sessionId,
  });
  sessionState.messages_since_dream = 0;
  sessionState.last_dream_at = utcNow();
  return true;
}

async function withStateLock(provider, fn) {
  const lockPath = `${statePath(provider)}.lock`;
  const lock = await acquireFileLock(lockPath, { attempts: 50, delayMs: 100, staleMs: STATE_LOCK_STALE_MS });
  if (!lock) throw new Error(`state lock is busy for provider: ${provider}`);
  try {
    return await fn();
  } finally {
    await releaseFileLock(lock);
  }
}

async function importCodex(args, hookInput) {
  if (!args.transcript) {
    args.transcript = hookInput.transcript_path || hookInput.transcriptPath || "";
  }
  const rolloutPath = args.transcript || (await latestCodexRolloutPath(args.maxAgeSeconds));
  if (!rolloutPath) return { ok: true, provider: "codex", skipped: "no recent rollout file" };
  if (!fs.existsSync(rolloutPath)) return { ok: false, provider: "codex", error: `rollout not found: ${rolloutPath}` };

  const parsed = await getProvider("codex").parseTranscript(rolloutPath, hookInput);
  const sessionId = parsed.session_id;
  return withStateLock("codex", async () => {
    const state = await loadState("codex");
    const sessions = (state.sessions ||= {});
    const sessionState = (sessions[sessionId] ||= { imported_hashes: [], messages_since_dream: 0 });
    sessionState.rollout_path = rolloutPath;
    const basePeers = new Set([DEFAULT_USER_PEER, assistantPeer("codex")]);
    if (!args.dryRun) await ensureSession(args.workspace, "codex", sessionId, parsed, basePeers);
    const [syncedTurns, honchoMessageTotal, stateReconciled] = args.dryRun
      ? [0, 0, false]
      : await syncStateFromHoncho("codex", args.workspace, sessionId, sessionState);
    const [messages, pendingHashes, peers] = buildCodexMessages(sessionId, parsed, sessionState);
    const result = {
      ok: true,
      provider: "codex",
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
      if (stateReconciled && !args.dryRun) {
        state.version = 2;
        await saveState("codex", state);
      }
      return result;
    }
    if ([...peers].some((peer) => !basePeers.has(peer))) {
      await ensureSession(args.workspace, "codex", sessionId, parsed, peers);
    }
    sessionState.write_in_progress = { started_at: utcNow(), message_count: messages.length };
    state.version = 2;
    await saveState("codex", state);
    await addMessages(args.workspace, sessionId, messages);
    sessionState.imported_hashes = mergeStateHashes(sessionState.imported_hashes || [], pendingHashes);
    sessionState.last_imported_at = utcNow();
    sessionState.messages_since_dream = Number(sessionState.messages_since_dream || 0) + messages.length;
    result.dream_scheduled = await scheduleCodexDreamIfDue(args.workspace, sessionId, sessionState);
    delete sessionState.write_in_progress;
    state.version = 2;
    await saveState("codex", state);
    return result;
  });
}

async function importGenericProvider(args, hookInput) {
  if (!args.transcript) throw new Error("missing transcript path");
  if (!fs.existsSync(args.transcript)) throw new Error(`transcript not found: ${args.transcript}`);

  const parsed = await getProvider(args.provider).parseTranscript(args.transcript, hookInput);
  const sessionId = parsed.session_id;
  return withStateLock(args.provider, async () => {
    const state = await loadState(args.provider);
    const sessions = (state.sessions ||= {});
    const sessionState = (sessions[sessionId] ||= { imported_hashes: [] });
    sessionState.transcript_path = args.transcript;
    const basePeers = new Set([DEFAULT_USER_PEER, assistantPeer(args.provider)]);
    if (!args.dryRun) await ensureSession(args.workspace, args.provider, sessionId, parsed, basePeers);
    const [syncedTurns, honchoMessageTotal, stateReconciled] = args.dryRun
      ? [0, 0, false]
      : await syncStateFromHoncho(args.provider, args.workspace, sessionId, sessionState);
    const [messages, pendingHashes, peers] = buildMessages(args.provider, sessionId, parsed, sessionState);
    const result = {
      ok: true,
      provider: args.provider,
      workspace: args.workspace,
      session_id: sessionId,
      transcript_path: args.transcript,
      parsed_turns: parsed.turns.length,
      new_turns: pendingHashes.length,
      new_messages: messages.length,
      dry_run: Boolean(args.dryRun),
      state_synced_turns: syncedTurns,
      honcho_message_total: honchoMessageTotal,
    };

    if (args.dryRun || messages.length === 0) {
      if (stateReconciled && !args.dryRun) {
        state.version = 2;
        await saveState(args.provider, state);
      }
      return result;
    }
    sessionState.write_in_progress = { started_at: utcNow(), message_count: messages.length };
    state.version = 2;
    await saveState(args.provider, state);
    await addMessages(args.workspace, sessionId, messages);
    sessionState.imported_hashes = mergeStateHashes(sessionState.imported_hashes || [], pendingHashes);
    sessionState.last_imported_at = utcNow();
    delete sessionState.write_in_progress;
    state.version = 2;
    await saveState(args.provider, state);
    return result;
  });
}

async function main() {
  const args = parseArgs();
  const hookInput = args.hookInputFile || !args.transcript ? await readHookInput(args.hookInputFile) : {};
  if (!args.transcript) {
    args.transcript = hookInput.transcript_path || hookInput.transcriptPath || "";
  }
  if (args.provider === "codex") return importCodex(args, hookInput);
  return importGenericProvider(args, hookInput);
}

const provider = (process.env.HONCHO_AGENT_PROVIDER || "agent").trim().toLowerCase();
try {
  const result = await main();
  await logLine(result.provider || provider, JSON.stringify(result)).catch(() => {});
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const result = { ok: false, provider, error: String(error?.message || error) };
  await logLine(provider, JSON.stringify(result)).catch(() => {});
  console.error(JSON.stringify(result));
  process.exitCode = 1;
}
