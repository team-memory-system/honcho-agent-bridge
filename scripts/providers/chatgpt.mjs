// ChatGPT web conversations, from the export ChatGPT emails you ("Export data").
//
// Unlike the CLI providers, one file holds every conversation, and each one is a
// tree rather than a list: regenerating an answer branches it. Only the branch
// that ends at `current_node` is what the user actually saw, so that is the branch
// that becomes memory.
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeCreatedAt, normalizeRawText, sanitizeId } from "./shared.mjs";

const KEPT_ROLES = new Set(["user", "assistant"]);
const KEPT_CONTENT_TYPES = new Set(["text", "multimodal_text"]);

function partsToText(content) {
  if (!content || typeof content !== "object") return "";
  if (!KEPT_CONTENT_TYPES.has(content.content_type)) return "";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const texts = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.trim()) texts.push(part);
      continue;
    }
    // multimodal_text carries image pointers and audio next to the text.
    if (part && typeof part === "object" && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text);
    }
  }
  return normalizeRawText(texts.join("\n\n"));
}

function isHidden(message) {
  const metadata = message.metadata || {};
  if (metadata.is_visually_hidden_from_conversation) return true;
  // Custom instructions and memory injections arrive as user turns nobody typed.
  if (metadata.is_user_system_message) return true;
  return false;
}

// The active branch, oldest first. Walking up from `current_node` skips every
// regenerated sibling, which is what the reader saw.
export function activeBranch(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  let nodeId = conversation.current_node;
  if (!nodeId) {
    // Some exports omit current_node; fall back to the newest leaf.
    let newest = null;
    for (const node of Object.values(mapping)) {
      const time = node?.message?.create_time;
      if (typeof time !== "number") continue;
      if (!newest || time > newest.time) newest = { id: node.id, time };
    }
    nodeId = newest?.id;
  }
  const chain = [];
  const visited = new Set();
  while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
    visited.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  return chain.reverse();
}

export function parseConversation(conversation) {
  const conversationId = conversation?.conversation_id || conversation?.id || "";
  const metadata = {
    source: "chatgpt",
    original_session_id: conversationId,
    title: typeof conversation?.title === "string" ? conversation.title : "",
    created_at: normalizeCreatedAt(conversation?.create_time),
    updated_at: normalizeCreatedAt(conversation?.update_time),
  };
  const turns = [];
  let lineIndex = 0;
  for (const node of activeBranch(conversation)) {
    lineIndex += 1;
    const message = node.message;
    if (!message || typeof message !== "object") continue;
    const role = message.author?.role;
    if (!KEPT_ROLES.has(role)) continue;
    if (isHidden(message)) continue;
    const text = partsToText(message.content);
    if (!text) continue;
    turns.push({
      role,
      content: text,
      created_at: normalizeCreatedAt(message.create_time) || metadata.created_at,
      line_index: lineIndex,
      source_message_id: message.id || node.id,
    });
  }
  return {
    provider: "chatgpt",
    session_id: sanitizeId(conversationId || metadata.title || "conversation", "chatgpt"),
    metadata,
    turns,
  };
}

export function conversationsIn(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.conversations)) return payload.conversations;
    if (payload.mapping) return [payload];
  }
  return [];
}

export async function readExport(filePath) {
  const stat = await fsp.stat(filePath);
  let target = filePath;
  if (stat.isDirectory()) target = path.join(filePath, "conversations.json");
  const raw = await fsp.readFile(target, "utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`not a ChatGPT export (invalid JSON): ${target}: ${error.message}`);
  }
  const conversations = conversationsIn(payload);
  if (!conversations.length) throw new Error(`no conversations found in ${target}`);
  return { path: target, conversations };
}

export async function parseExport(filePath) {
  const { conversations } = await readExport(filePath);
  return conversations.map((conversation) => parseConversation(conversation)).filter((parsed) => parsed.turns.length);
}

// Kept so the standard single-transcript path still works when a file holds one
// conversation.
export async function parseTranscript(transcriptPath) {
  const parsedAll = await parseExport(transcriptPath);
  if (!parsedAll.length) throw new Error(`no importable conversation in ${transcriptPath}`);
  if (parsedAll.length > 1) {
    throw new Error(
      `${transcriptPath} holds ${parsedAll.length} conversations; import it with --provider chatgpt --export`,
    );
  }
  const parsed = parsedAll[0];
  parsed.metadata.file_path = transcriptPath;
  return parsed;
}
