import fsp from "node:fs/promises";
import path from "node:path";
import { extractTextBlocks, normalizeCreatedAt, normalizeText, sanitizeId } from "./shared.mjs";

export async function parseTranscript(transcriptPath) {
  const metadata = { source: "claude", file_path: transcriptPath };
  const turns = [];
  const lines = (await fsp.readFile(transcriptPath, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.isSidechain) continue;
    const message = obj.message || {};
    if (!["user", "assistant"].includes(message.role)) continue;
    const content = message.content;
    let text = "";
    if (typeof content === "string") {
      text = normalizeText(content);
    } else if (Array.isArray(content)) {
      if (message.role === "user" && content.some((item) => item?.type === "tool_result")) continue;
      if (message.role === "assistant" && !content.some((item) => item?.type === "text")) continue;
      text = extractTextBlocks(content);
    }
    if (!text) continue;
    metadata.original_session_id ??= obj.sessionId || obj.session_id;
    metadata.cwd ??= obj.cwd;
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
  return {
    provider: "claude",
    session_id: sanitizeId(metadata.original_session_id || path.basename(transcriptPath), "claude"),
    metadata,
    turns,
  };
}
