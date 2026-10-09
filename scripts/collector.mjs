import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getProvider } from "./providers/index.mjs";
import { codexSegmentId, segmentHashesFromStoredMessages, turnHashCandidates } from "./turn-identity.mjs";
import { classifyAutomation as classifyCodexAutomation } from "./providers/codex.mjs";
import { classifyAutomation as classifyClaudeAutomation } from "./providers/claude.mjs";
import { classifyAutomation as classifyAgyAutomation } from "./providers/agy.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import {
  accessRefusedMessage,
  environmentAccess,
  fetchHoncho,
  honchoHeaders,
  isCloudflareAccessBlock,
} from "./honcho-access.mjs";
import { projectFolder, projectScope } from "./projects.mjs";
import { automationOnly } from "./providers/automation.mjs";
import { COLLECT_AUTOMATION_ENV } from "./config.mjs";
import { collectFoldersFromEnvironment, folderMatches, foldersFromEnvironment, outsideCollectFolders } from "./targets.mjs";

const ROOT_URL = (process.env.HONCHO_BASE_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.HONCHO_API_BEARER_TOKEN || "";
// Cloudflare Access sits in front of Honcho once it is reachable from outside this
// machine. A browser gets a login page; a collector has to present a service
// token. The hook environment carries the one setup saved
// (HONCHO_CF_ACCESS_CLIENT_ID/SECRET); the older CF_ACCESS_CLIENT_ID/SECRET still
// work when those are not set.
const CF_ACCESS = environmentAccess(process.env, { legacy: true });
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

const SUPPORTED_PROVIDERS = new Set(["codex", "claude", "agy", "chatgpt", "grok"]);
const CODEX_AUTOMATION_PEER = process.env.HONCHO_CODEX_AUTOMATION_PEER || "automation_codex";
const CLAUDE_AUTOMATION_PEER = process.env.HONCHO_CLAUDE_AUTOMATION_PEER || "automation_claude";
const AGY_AUTOMATION_PEER = process.env.HONCHO_AGY_AUTOMATION_PEER || "automation_agy";
// Providers whose user-role turns can be a program's prompts rather than the person's
// words: [classifier, peer those turns go to]. A classifier is called with the turn's
// text, the session metadata and the whole parsed session (agy decides per
// conversation). Codex has its own path (buildCodexMessages).
const AUTOMATION_CLASSIFIERS = {
  claude: [classifyClaudeAutomation, CLAUDE_AUTOMATION_PEER],
  agy: [classifyAgyAutomation, AGY_AUTOMATION_PEER],
};
// Set only when this run sends to another server (a target, see targets.mjs): the
// folders whose conversations that server takes. Nothing outside them, and nothing
// without a working directory, is sent - checked here, before any request, so no
// caller of this importer can send a target anything else.
const TARGET_FOLDERS = foldersFromEnvironment(process.env);
// The folders this computer's own server takes, when setup chose some (config.json
// `collect`). A target run has its own folders and never this choice.
const COLLECT_FOLDERS = TARGET_FOLDERS === null ? collectFoldersFromEnvironment(process.env) : null;
// 자동 실행 대화도 수집 (config.json `collect.automation`): the own server's runs
// alone, and only when it is on. A target never takes those conversations.
const COLLECT_AUTOMATION = TARGET_FOLDERS === null && process.env[COLLECT_AUTOMATION_ENV] === "1";

/**
 * Whether this run may not send `parsed`. A session is decided by its own working
 * directory, the first one its transcript records: a session that moves to
 * another folder part-way stays where it started.
 */
function outsideTargetFolders(parsed) {
  if (TARGET_FOLDERS === null) return false;
  return !folderMatches(parsed?.metadata?.cwd, TARGET_FOLDERS);
}

/**
 * Why the own server leaves `parsed` out, or null. A conversation no person took part
 * in (providers/automation.mjs) goes by 자동 실행 대화도 수집 alone: the folder list
 * shows none of them, so the folder choice says nothing about them, and a target run
 * never takes one. A ChatGPT conversation has no folder and is chosen on its own.
 */
function leftOut(provider, parsed) {
  if (automationOnly(provider, parsed)) return COLLECT_AUTOMATION ? null : "automation";
  if (provider !== "chatgpt" && outsideCollectFolders(parsed?.metadata?.cwd, COLLECT_FOLDERS)) return "outside collected folders";
  return null;
}

/**
 * A transcript with nothing said in it: only tool output, a bare slash command, or a
 * session closed before the first prompt. It makes no conversation on the server.
 */
function nothingSaid(parsed) {
  return !parsed?.turns?.length;
}

function skippedOutsideFolders(provider, parsed, transcriptPath, skipped = "outside target folders") {
  return {
    ok: true,
    provider,
    session_id: parsed?.session_id || null,
    transcript_path: transcriptPath,
    new_messages: 0,
    skipped,
  };
}


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
    dryRun: process.env.HONCHO_AGENT_DRY_RUN === "1" || process.env.HONCHO_CODEX_DRY_RUN === "1",
    hookInputFile: "",
    // A ChatGPT export holds every conversation in one file, so it imports as a
    // batch instead of as one transcript.
    exportPath: "",
  };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--provider") args.provider = argv[++index] || args.provider;
    else if (item === "--transcript" || item === "--transcript-path" || item === "--rollout") {
      args.transcript = argv[++index] || "";
    } else if (item === "--workspace") args.workspace = argv[++index] || DEFAULT_WORKSPACE;
    else if (item === "--dry-run") args.dryRun = true;
    else if (item === "--hook-input-file") args.hookInputFile = argv[++index] || "";
    else if (item === "--export") args.exportPath = argv[++index] || "";
  }
  args.provider = args.provider.trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(args.provider)) throw new Error(`unsupported provider: ${args.provider}`);
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
  // A team server gets this computer's team login instead (fetchHoncho).
  const headers = honchoHeaders({ token: AUTH_TOKEN, access: CF_ACCESS }, { "Content-Type": "application/json" });
  try {
    const response = await fetchHoncho(`${ROOT_URL}${apiPath}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    if (await isCloudflareAccessBlock(response)) throw new Error(`${accessRefusedMessage(ROOT_URL)} (HTTP ${response.status} for ${apiPath})`);
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

/** How many of `messages` go to each peer, e.g. { user: 1, assistant_agy: 1 }. */
function countByPeer(messages) {
  const counts = {};
  for (const message of messages) counts[message.peer_id] = (counts[message.peer_id] || 0) + 1;
  return counts;
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
    let peerId = assistantPeer(provider);
    let directUser = false;
    let memoryOrigin = `${provider}_assistant`;
    let automationKind = null;
    if (turn.role === "user") {
      const [classify, automationPeer] = AUTOMATION_CLASSIFIERS[provider] || [];
      const automation = classify ? classify(turn.content, parsed.metadata, parsed) : [false, null];
      automationKind = automation[1];
      peerId = automation[0] ? automationPeer : DEFAULT_USER_PEER;
      directUser = !automation[0];
      memoryOrigin = automation[0] ? `${provider}_automation` : `${provider}_direct_user`;
    }
    peers.add(peerId);
    const chunks = splitContent(turn.content);
    chunks.forEach((chunk, index) => {
      const metadata = {
        source: provider,
        agent_provider: provider,
        memory_importer: "agent_turn_ended",
        memory_trigger: IMPORT_TRIGGER,
        memory_origin: memoryOrigin,
        direct_user: directUser,
        transcript_path: parsed.metadata.file_path,
        [`${provider}_session_id`]: sessionId,
        [`${provider}_role`]: turn.role,
        source_turn_hash: sourceTurnHash,
      };
      if (automationKind) metadata.automation_kind = automationKind;
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
      if (turn.segment_id) metadata.codex_segment_id = turn.segment_id;
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

const projectMemo = new Map();

/**
 * The project a session ran in (projects.mjs): its scope id and name, so the server
 * can put the session into that project's scope once the project is opened to a
 * teammate. Nothing for a session with no folder.
 */
async function projectMetadata(cwd) {
  if (!projectMemo.has(cwd)) {
    projectMemo.set(cwd, (async () => {
      const folder = await projectFolder(cwd).catch(() => null);
      if (!folder) return {};
      const scope = await projectScope(folder).catch(() => null);
      return scope ? { project_id: scope.id, project_name: scope.name } : {};
    })());
  }
  return projectMemo.get(cwd);
}

async function ensureSession(workspace, provider, sessionId, parsed, peers) {
  const peerConfig = {};
  for (const peer of peers) {
    // 에이전트·자동화 피어는 학습(파생) 대상에서 제외 — 셀프 표상 노이즈 방지
    const isAgentPeer = peer.startsWith("assistant_") || peer.startsWith("automation_");
    peerConfig[peer] = { observe_me: !isAgentPeer, observe_others: false };
  }
  const metadata = {
    ...parsed.metadata,
    ...(await projectMetadata(parsed.metadata?.cwd)),
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

/**
 * Turns of a Codex continuation segment are told apart by their segment (see
 * turn-identity.mjs). Earlier collectors sent them under bare line hashes, so the
 * first time this collector reads a segment it rebuilds the segment hashes of the
 * turns Honcho already holds from that file, using each stored message's rollout
 * path. Without that list nothing is sent: the bare hashes alone cannot show which
 * of a thread's files a sent turn came from.
 */
async function reconcileCodexSegment(workspace, sessionId, segmentId, sessionState) {
  const reconciled = Array.isArray(sessionState.reconciled_segments) ? sessionState.reconciled_segments : [];
  if (reconciled.includes(segmentId)) return false;
  let listed;
  try {
    listed = await existingMessages(workspace, sessionId);
  } catch (error) {
    await logLine("codex", `SEGMENT_SYNC_FAILED ${sessionId} ${segmentId} ${error?.name || "Error"}: ${error?.message || error}`);
    throw new Error(`Cannot safely import segment ${segmentId} of ${sessionId} until Honcho message reconciliation succeeds`);
  }
  sessionState.imported_hashes = mergeStateHashes(
    sessionState.imported_hashes || [],
    segmentHashesFromStoredMessages(sessionId, segmentId, listed.messages),
  );
  sessionState.reconciled_segments = [...reconciled, segmentId];
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
  const rolloutPath = args.transcript;
  if (!rolloutPath) return { ok: true, provider: "codex", skipped: "no transcript path" };
  if (!fs.existsSync(rolloutPath)) return { ok: false, provider: "codex", error: `rollout not found: ${rolloutPath}` };

  const parsed = await getProvider("codex").parseTranscript(rolloutPath, hookInput);
  if (outsideTargetFolders(parsed)) return skippedOutsideFolders("codex", parsed, rolloutPath);
  const left = leftOut("codex", parsed);
  if (left) return skippedOutsideFolders("codex", parsed, rolloutPath, left);
  if (nothingSaid(parsed)) return skippedOutsideFolders("codex", parsed, rolloutPath, "no conversation");
  const sessionId = parsed.session_id;
  const segmentId = codexSegmentId(rolloutPath, parsed.metadata.original_session_id);
  if (segmentId) for (const turn of parsed.turns) turn.segment_id = segmentId;
  return withStateLock("codex", async () => {
    const state = await loadState("codex");
    const sessions = (state.sessions ||= {});
    const sessionState = (sessions[sessionId] ||= { imported_hashes: [] });
    sessionState.rollout_path = rolloutPath;
    const basePeers = new Set([DEFAULT_USER_PEER, assistantPeer("codex")]);
    if (!args.dryRun) await ensureSession(args.workspace, "codex", sessionId, parsed, basePeers);
    const [syncedTurns, honchoMessageTotal, stateReconciled] = args.dryRun
      ? [0, 0, false]
      : await syncStateFromHoncho("codex", args.workspace, sessionId, sessionState);
    const segmentReconciled = segmentId && !args.dryRun
      ? await reconcileCodexSegment(args.workspace, sessionId, segmentId, sessionState)
      : false;
    const [messages, pendingHashes, peers] = buildCodexMessages(sessionId, parsed, sessionState);
    const result = {
      ok: true,
      provider: "codex",
      workspace: args.workspace,
      session_id: sessionId,
      rollout_path: rolloutPath,
      ...(segmentId ? { codex_segment_id: segmentId } : {}),
      parsed_turns: parsed.turns.length,
      new_turns: pendingHashes.length,
      new_messages: messages.length,
      dry_run: Boolean(args.dryRun),
      state_synced_turns: syncedTurns,
      honcho_message_total: honchoMessageTotal,
    };
    if (args.dryRun || messages.length === 0) {
      if ((stateReconciled || segmentReconciled) && !args.dryRun) {
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
  return importParsedSession(args, parsed, args.transcript);
}

async function importParsedSession(args, parsed, transcriptPath, options = {}) {
  // Every non-Codex write passes here; a target run never writes a session from
  // outside its folders, whoever called.
  if (outsideTargetFolders(parsed)) return skippedOutsideFolders(args.provider, parsed, transcriptPath);
  const left = leftOut(args.provider, parsed);
  if (left) return skippedOutsideFolders(args.provider, parsed, transcriptPath, left);
  if (nothingSaid(parsed)) return skippedOutsideFolders(args.provider, parsed, transcriptPath, "no conversation");
  const sessionId = parsed.session_id;
  return withStateLock(args.provider, async () => {
    const state = await loadState(args.provider);
    const sessions = (state.sessions ||= {});
    let sessionState = (sessions[sessionId] ||= { imported_hashes: [] });
    // `destination` names the server and workspace the state was recorded for. A
    // state recorded for another one says nothing about this one, so it is
    // dropped and rebuilt from what this workspace holds.
    if (options.destination && sessionState.destination !== options.destination) {
      sessionState = sessions[sessionId] = { imported_hashes: [], destination: options.destination };
    }
    sessionState.transcript_path = transcriptPath;
    const basePeers = new Set([DEFAULT_USER_PEER, assistantPeer(args.provider)]);
    if (!args.dryRun) await ensureSession(args.workspace, args.provider, sessionId, parsed, basePeers);
    const [syncedTurns, honchoMessageTotal, stateReconciled] = args.dryRun
      ? [0, 0, false]
      : await syncStateFromHoncho(args.provider, args.workspace, sessionId, sessionState);
    const [messages, pendingHashes, peers] = buildMessages(args.provider, sessionId, parsed, sessionState);
    options.onMessages?.(messages);
    const result = {
      ok: true,
      provider: args.provider,
      workspace: args.workspace,
      session_id: sessionId,
      transcript_path: transcriptPath,
      parsed_turns: parsed.turns.length,
      new_turns: pendingHashes.length,
      new_messages: messages.length,
      new_messages_by_peer: countByPeer(messages),
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
    if ([...peers].some((peer) => !basePeers.has(peer))) {
      await ensureSession(args.workspace, args.provider, sessionId, parsed, peers);
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

async function importChatGptExport(args) {
  const exportPath = args.exportPath || args.transcript;
  if (!exportPath) throw new Error("missing ChatGPT export path (--export)");
  if (!fs.existsSync(exportPath)) throw new Error(`export not found: ${exportPath}`);

  // The whole export is read and parsed before anything is sent, so a damaged or
  // truncated file stops the import before its first write. Conversations go in
  // oldest first.
  const loaded = await getProvider("chatgpt").loadExport(exportPath);
  const destination = `${ROOT_URL}/v3/workspaces/${args.workspace}`;
  const newMessagesByPeer = {};
  const countMessages = (messages) => {
    for (const message of messages) newMessagesByPeer[message.peer_id] = (newMessagesByPeer[message.peer_id] || 0) + 1;
  };
  const sessions = [];
  let newMessages = 0;
  let failed = 0;
  const progress = process.stderr.isTTY && !args.dryRun;
  for (const [index, parsed] of loaded.sessions.entries()) {
    try {
      const result = await importParsedSession(args, parsed, parsed.metadata.file_path, { destination, onMessages: countMessages });
      newMessages += result.new_messages;
      sessions.push({ session_id: result.session_id, new_messages: result.new_messages, parsed_turns: result.parsed_turns });
    } catch (error) {
      // One conversation that cannot be sent must not abandon the rest of the export.
      failed += 1;
      sessions.push({ session_id: parsed.session_id, error: String(error?.message || error) });
    }
    if (progress && ((index + 1) % 100 === 0 || index + 1 === loaded.sessions.length)) {
      process.stderr.write(`chatgpt: ${index + 1}/${loaded.sessions.length} conversations, ${newMessages} new messages, ${failed} failed\n`);
    }
  }
  return {
    ok: failed === 0 && loaded.unreadable.length === 0,
    provider: "chatgpt",
    workspace: args.workspace,
    user_peer: DEFAULT_USER_PEER,
    assistant_peer: assistantPeer("chatgpt"),
    export_path: path.resolve(exportPath),
    files: loaded.files,
    skipped_archives: loaded.skipped_archives,
    conversations: loaded.conversations,
    imported_sessions: sessions.filter((session) => !session.error).length,
    failed_sessions: failed,
    unreadable_conversations: loaded.unreadable,
    new_messages: newMessages,
    new_messages_by_peer: newMessagesByPeer,
    dry_run: Boolean(args.dryRun),
    summary: loaded.summary,
    sessions,
  };
}

async function main() {
  const args = parseArgs();
  const hookInput =
    args.provider === "chatgpt"
      ? {}
      : args.hookInputFile || !args.transcript
        ? await readHookInput(args.hookInputFile)
        : {};
  if (!args.transcript) {
    args.transcript = hookInput.transcript_path || hookInput.transcriptPath || "";
  }
  // A Grok hook names updates.jsonl (or only the session); the messages are in the
  // session's chat_history.jsonl.
  if (args.provider === "grok") {
    args.transcript = getProvider("grok").resolveTranscriptPath({ ...hookInput, transcript_path: args.transcript }) || args.transcript;
  }
  if (args.provider === "chatgpt") {
    // A ChatGPT conversation has no working directory, so it never belongs to a
    // target's folders. Refused before the export is even read.
    if (TARGET_FOLDERS !== null) {
      return { ok: true, provider: "chatgpt", new_messages: 0, skipped: "ChatGPT imports never go to another server" };
    }
    return importChatGptExport(args);
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
