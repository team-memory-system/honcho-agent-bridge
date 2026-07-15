import fsp from "node:fs/promises";
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
