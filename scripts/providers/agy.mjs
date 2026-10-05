import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTag, normalizeCreatedAt, normalizeRawText, sanitizeId } from "./shared.mjs";

function findConversationId(transcriptPath, hookInput) {
  if (typeof hookInput.conversationId === "string" && hookInput.conversationId.trim()) {
    return hookInput.conversationId.trim();
  }
  if (typeof hookInput.conversation_id === "string" && hookInput.conversation_id.trim()) {
    return hookInput.conversation_id.trim();
  }
  const parts = path.resolve(transcriptPath).split(path.sep);
  const brainIndex = parts.lastIndexOf("brain");
  if (brainIndex >= 0 && parts[brainIndex + 1]) return parts[brainIndex + 1];
  return path.basename(path.dirname(path.dirname(path.dirname(transcriptPath))));
}

export async function parseTranscript(transcriptPath, hookInput = {}) {
  const raw = await fsp.readFile(transcriptPath, "utf8");
  const conversationId = findConversationId(transcriptPath, hookInput);
  const metadata = {
    source: "agy",
    file_path: transcriptPath,
    original_session_id: conversationId,
    conversation_id: conversationId,
    workspace_paths: hookInput.workspacePaths || hookInput.workspace_paths,
    artifact_directory_path: hookInput.artifactDirectoryPath || hookInput.artifact_directory_path,
  };
  const turns = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.status && obj.status !== "DONE") continue;
    let role = null;
    let text = "";
    if (obj.source === "USER_EXPLICIT" && obj.type === "USER_INPUT") {
      role = "user";
      const rawContent = normalizeRawText(obj.content || "");
      text = normalizeRawText(extractTag(rawContent, "USER_REQUEST") || rawContent);
    } else if (obj.source === "MODEL" && obj.type === "PLANNER_RESPONSE" && typeof obj.content === "string") {
      role = "assistant";
      text = normalizeRawText(obj.content);
    }
    if (!role || !text) continue;
    turns.push({
      role,
      content: text,
      created_at: normalizeCreatedAt(obj.created_at),
      line_index: index + 1,
      step_index: obj.step_index,
      step_type: obj.type,
      step_source: obj.source,
    });
  }
  return {
    provider: "agy",
    session_id: sanitizeId(conversationId || path.basename(transcriptPath), "agy"),
    metadata,
    turns,
  };
}

// ---------------------------------------------------------------------------
// Who started a conversation: the person, or a program calling agy.
//
// Programs run agy too (one-shot prompts, games, batch questions), and their
// prompts arrive as USER_INPUT like the person's. agy's interactive prompt history
// (~/.gemini/antigravity-cli/history.jsonl) records what the person typed:
// {display, timestamp (ms), workspace, conversationId?}. A conversation is the
// person's when
//   - its id is in that history ("history_id"), or
//   - its first prompt is within HISTORY_WINDOW_MS of a history entry that has no
//     conversationId ("history_time"; older agy versions wrote none), or
//   - it came from the Antigravity app, whose transcripts live under
//     ~/.gemini/antigravity/brain or antigravity-ide/brain ("app").
// Any other conversation is a program's ("unlisted"), and its prompts go to the
// automation peer. Without a readable history nothing can be told apart, so every
// conversation stays the person's ("no_history").
// ---------------------------------------------------------------------------

export const HISTORY_WINDOW_MS = 10_000;
const APP_PRODUCTS = new Set(["antigravity", "antigravity-ide"]);

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** The prompt history the rule reads: HONCHO_AGY_HISTORY, else agy CLI's own. */
export function historyPath(env = process.env) {
  const explicit = typeof env.HONCHO_AGY_HISTORY === "string" ? env.HONCHO_AGY_HISTORY.trim() : "";
  return explicit ? expandHome(explicit) : path.join(os.homedir(), ".gemini", "antigravity-cli", "history.jsonl");
}

/** History text → { ids: Set of conversation ids, idlessTimes: sorted ms of entries with no id }. */
export function parseHistory(text) {
  const ids = new Set();
  const idlessTimes = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.conversationId === "string" ? entry.conversationId.trim() : "";
    if (id) {
      ids.add(id.toLowerCase());
      continue;
    }
    const time = Number(entry.timestamp);
    if (Number.isFinite(time) && time > 0) idlessTimes.push(time);
  }
  idlessTimes.sort((a, b) => a - b);
  return { ids, idlessTimes };
}

const historyCache = new Map();

/** The parsed history at `filePath`, or null when it cannot be read. Re-read when the file changes. */
export function readHistory(filePath = historyPath()) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = historyCache.get(filePath);
  if (cached?.key === key) return cached.history;
  let history;
  try {
    history = parseHistory(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  historyCache.set(filePath, { key, history });
  return history;
}

/** Whether a transcript path is the Antigravity app's: <…>/antigravity[-ide]/brain/<id>/…. */
export function isAppTranscript(transcriptPath) {
  const parts = String(transcriptPath || "").split(/[\\/]/);
  const brainIndex = parts.lastIndexOf("brain");
  return brainIndex > 0 && APP_PRODUCTS.has(parts[brainIndex - 1]);
}

function firstPromptMs(parsed) {
  const first = (parsed?.turns || []).find((turn) => turn.role === "user");
  const time = Date.parse(first?.created_at || "");
  return Number.isFinite(time) ? time : null;
}

function nearIdlessEntry(history, time) {
  if (time == null) return false;
  return history.idlessTimes.some((entry) => Math.abs(entry - time) <= HISTORY_WINDOW_MS);
}

/**
 * Which branch of the rule decides `parsed`: "history_id", "history_time", "app",
 * "unlisted" (a program's), or "no_history". `history` is a parsed history, or
 * undefined to read historyPath().
 */
export function conversationOrigin(parsed, history = readHistory()) {
  if (!history) return "no_history";
  const id = String(parsed?.metadata?.conversation_id || parsed?.metadata?.original_session_id || "").trim().toLowerCase();
  if (id && history.ids.has(id)) return "history_id";
  if (nearIdlessEntry(history, firstPromptMs(parsed))) return "history_time";
  if (isAppTranscript(parsed?.metadata?.file_path)) return "app";
  return "unlisted";
}

const origins = new WeakMap();

/**
 * Same shape as the Claude and Codex classifiers: [isAutomation, kind]. The whole
 * conversation is decided at once, from `parsed` (the collector passes it); the
 * turn's text plays no part.
 */
export function classifyAutomation(_text, _sessionMetadata, parsed) {
  if (!parsed || typeof parsed !== "object") return [false, null];
  let origin = origins.get(parsed);
  if (!origin) {
    origin = conversationOrigin(parsed);
    origins.set(parsed, origin);
  }
  return origin === "unlisted" ? [true, "agy_script"] : [false, null];
}
