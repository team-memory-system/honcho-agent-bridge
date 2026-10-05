import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTextBlocks, normalizeCreatedAt, normalizeText, sanitizeId } from "./shared.mjs";

// Grok CLI keeps each session in ~/.grok/sessions/<URL-encoded cwd>/<session id>/.
// chat_history.jsonl there holds the messages sent to the model, one per line:
// {type: "system"}, {type: "user", content: [{type: "text", text}], prompt_index |
// synthetic_reason}, {type: "reasoning"}, {type: "assistant", content, tool_calls,
// model_id}, {type: "tool_result"}. A typed prompt is the user line wrapped in
// <user_query>; the <user_info> line and synthetic lines are Grok's own.
// updates.jsonl beside it is Grok's ACP update stream (what a hook payload names
// as transcript_path); it is not parsed.
export const TRANSCRIPT_NAME = "chat_history.jsonl";

export function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function firstString(input, keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const sessionIdFromHook = (hookInput) => firstString(hookInput, ["sessionId", "session_id"]);
const cwdFromHook = (hookInput) => firstString(hookInput, ["cwd", "workspaceRoot", "workspace_root"]);

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * The chat_history.jsonl of the session a Grok hook payload names, or "" when it is
 * not on disk (a session that ended before its first message has none). The payload's
 * transcript_path is updates.jsonl, so its sibling is tried first; then the session
 * id under the encoded working directory; then every directory group, since Grok
 * stores a long working directory under a slug and hash instead.
 */
export function resolveTranscriptPath(hookInput = {}) {
  const candidates = [];
  const given = firstString(hookInput, ["transcript_path", "transcriptPath"]);
  if (given) candidates.push(path.basename(given) === TRANSCRIPT_NAME ? given : path.join(path.dirname(given), TRANSCRIPT_NAME));
  const sessionId = sessionIdFromHook(hookInput);
  if (sessionId && !/[\\/]/.test(sessionId) && sessionId !== "." && sessionId !== "..") {
    const sessions = path.join(grokHome(), "sessions");
    for (const key of ["cwd", "workspaceRoot", "workspace_root"]) {
      const cwd = firstString(hookInput, [key]);
      if (cwd) candidates.push(path.join(sessions, encodeURIComponent(path.resolve(cwd)), sessionId, TRANSCRIPT_NAME));
    }
    try {
      for (const group of fs.readdirSync(sessions, { withFileTypes: true })) {
        if (group.isDirectory()) candidates.push(path.join(sessions, group.name, sessionId, TRANSCRIPT_NAME));
      }
    } catch {}
  }
  return candidates.find(isFile) || "";
}

/** The working directory Grok recorded for the session (summary.json info.cwd), or "". */
async function recordedCwd(sessionDir) {
  try {
    const summary = JSON.parse(await fsp.readFile(path.join(sessionDir, "summary.json"), "utf8"));
    const cwd = summary?.info?.cwd;
    return typeof cwd === "string" && cwd.trim() ? cwd.trim() : "";
  } catch {
    return "";
  }
}

function extractUserText(text) {
  const raw = typeof text === "string" ? text : "";
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (query) return normalizeText(query[1]);
  if (/^\s*<user_info>/i.test(raw)) return "";
  if (/^\s*<system-reminder>/i.test(raw)) return "";
  return normalizeText(raw);
}

function contentToText(content, role) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (role === "user" && content.some((item) => item?.type === "tool_result")) return "";
    return extractTextBlocks(content, (text) => text);
  }
  return "";
}

export async function parseTranscript(transcriptPath, hookInput = {}) {
  const sessionDir = path.dirname(transcriptPath);
  const metadata = { source: "grok", file_path: transcriptPath };
  const turns = [];
  const lines = (await fsp.readFile(transcriptPath, "utf8")).split(/\r?\n/);
  metadata.original_session_id = sessionIdFromHook(hookInput) || path.basename(sessionDir);
  const cwd = cwdFromHook(hookInput) || (await recordedCwd(sessionDir));
  if (cwd) metadata.cwd = path.resolve(cwd);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "user") {
      // Lines Grok adds itself (system reminders and the like) carry a synthetic_reason.
      if (obj.synthetic_reason) continue;
      const text = extractUserText(contentToText(obj.content, "user"));
      if (!text) continue;
      turns.push({
        role: "user",
        content: text,
        created_at: normalizeCreatedAt(obj.timestamp),
        line_index: index + 1,
        source_message_id: obj.id || obj.uuid || null,
      });
      continue;
    }
    if (obj.type === "assistant") {
      const text = normalizeText(contentToText(obj.content, "assistant"), "assistant");
      if (!text) continue;
      if (typeof obj.model_id === "string" && obj.model_id) metadata.model_id ??= obj.model_id;
      turns.push({
        role: "assistant",
        content: text,
        created_at: normalizeCreatedAt(obj.timestamp),
        line_index: index + 1,
        source_message_id: obj.id || obj.uuid || null,
      });
    }
  }

  return {
    provider: "grok",
    session_id: sanitizeId(metadata.original_session_id, "grok"),
    metadata,
    turns,
  };
}
