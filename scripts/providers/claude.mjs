import fsp from "node:fs/promises";
import path from "node:path";
import { extractTextBlocks, normalizeCreatedAt, normalizeText, sanitizeId } from "./shared.mjs";

/**
 * A message the person typed while Claude was still working is written as a queued_command
 * attachment, not as a user row. Returns its text, "" for queued items that are not the
 * person's own prompt (task notifications, messages from other sessions), or null for any
 * other row.
 */
function queuedHumanPrompt(obj) {
  if (obj.type !== "attachment" || obj.attachment?.type !== "queued_command") return null;
  const attachment = obj.attachment;
  if (attachment.commandMode !== "prompt") return "";
  if (attachment.origin?.kind !== "human" && attachment.humanTurn !== true) return "";
  if (typeof attachment.prompt === "string") return normalizeText(attachment.prompt);
  if (Array.isArray(attachment.prompt)) return extractTextBlocks(attachment.prompt);
  return "";
}

// A bare slash command left as text ("/compact", or "/ㄷ턋" typed on a Korean layout) is not dialogue.
const BARE_COMMAND = /^\/\S+$/;

export async function parseTranscript(transcriptPath) {
  return parseLines((await fsp.readFile(transcriptPath, "utf8")).split(/\r?\n/), transcriptPath);
}

/** The same from a transcript's lines: all of them, or the first or last ones 지난 대화 reads (past.mjs). */
export function parseLines(lines, transcriptPath) {
  const metadata = { source: "claude", file_path: transcriptPath };
  const turns = [];
  const queued = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // How the session was started: "cli" when a person runs Claude Code, "sdk-cli" or
    // "sdk-ts" when a program drives it through the Agent SDK. Taken from the first
    // record that has one.
    if (metadata.entrypoint == null && typeof obj.entrypoint === "string" && obj.entrypoint) {
      metadata.entrypoint = obj.entrypoint;
    }
    // The folder the session ran in: the first record that names one, as the folder list
    // reads it (projects.mjs). A session with nothing said in it still has a folder.
    if (metadata.cwd == null && typeof obj.cwd === "string" && obj.cwd) metadata.cwd = obj.cwd;
    // isCompactSummary rows hold the summary Claude Code writes when it compacts a session.
    if (obj.isSidechain || obj.isCompactSummary) continue;
    const queuedText = queuedHumanPrompt(obj);
    if (queuedText !== null) {
      if (queuedText && !BARE_COMMAND.test(queuedText)) {
        queued.push({
          role: "user",
          content: queuedText,
          created_at: normalizeCreatedAt(obj.timestamp || obj.attachment.timestamp),
          line_index: index + 1,
          source_message_id: obj.uuid,
        });
      }
      continue;
    }
    const message = obj.message || {};
    if (!["user", "assistant"].includes(message.role)) continue;
    // Claude Code writes API errors ("You've hit your session limit …") as synthetic assistant rows.
    if (obj.isApiErrorMessage || message.model === "<synthetic>") continue;
    const content = message.content;
    let text = "";
    if (typeof content === "string") {
      text = normalizeText(content, message.role, obj.isMeta === true);
    } else if (Array.isArray(content)) {
      if (message.role === "user" && content.some((item) => item?.type === "tool_result")) continue;
      if (message.role === "assistant" && !content.some((item) => item?.type === "text")) continue;
      text = extractTextBlocks(content, (value) => normalizeText(value, message.role, obj.isMeta === true));
    }
    if (!text) continue;
    if (message.role === "user" && BARE_COMMAND.test(text)) continue;
    metadata.original_session_id ??= obj.sessionId || obj.session_id;
    metadata.git_branch ??= obj.gitBranch;
    metadata.version ??= obj.version;
    turns.push({
      role: message.role,
      content: text,
      created_at: normalizeCreatedAt(obj.timestamp),
      line_index: index + 1,
      source_message_id: obj.uuid,
    });
  }
  // Similar text and nearby timestamps do not prove these are the same input.
  // source_uuid identifies a queued command (queue-operation.commandUuid), not
  // necessarily a user row. Only an identical record UUID and text prove a replay.
  // Keep the wrapper UUID as source_message_id for compatibility with imported hashes.
  if (queued.length) {
    const typed = turns.filter((turn) => turn.role === "user");
    turns.push(...queued.filter((turn) => !typed.some((row) => turn.source_message_id
      && row.source_message_id === turn.source_message_id && row.content === turn.content)));
    turns.sort((a, b) => a.line_index - b.line_index);
  }
  return {
    provider: "claude",
    session_id: sanitizeId(metadata.original_session_id || path.basename(transcriptPath), "claude"),
    metadata,
    turns,
  };
}

/**
 * A session a program started through the Claude Agent SDK (entrypoint "sdk-cli",
 * "sdk-ts", any "sdk-*") carries that program's prompts in the user role, not the
 * person's words. Same shape as the Codex classifier: [isAutomation, kind].
 */
export function classifyAutomation(_text, sessionMetadata) {
  const entrypoint = sessionMetadata?.entrypoint;
  if (typeof entrypoint === "string" && entrypoint.startsWith("sdk-")) return [true, "claude_sdk"];
  return [false, null];
}
