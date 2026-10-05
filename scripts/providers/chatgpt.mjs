// ChatGPT web conversations, from the export ChatGPT emails you ("Export data").
//
// Unlike the CLI providers, one export holds every conversation, and each one is a
// tree rather than a list: editing a message or regenerating an answer branches
// it. Only the branch that ends at `current_node` is what the user actually saw,
// so that is the branch that becomes memory. How the export's files are found
// and read (zip, folder, numbered shards) is in chatgpt-archive.mjs.
import { conversationsIn, readConversations } from "./chatgpt-archive.mjs";
import { normalizeCreatedAt, normalizeRawText, sanitizeId } from "./shared.mjs";

export { conversationsIn };

const KEPT_ROLES = new Set(["user", "assistant"]);
const KEPT_CONTENT_TYPES = new Set(["text", "multimodal_text"]);
// Conversation fields worth keeping on the session, when the export has them.
const SESSION_FIELDS = [
  "default_model_slug",
  "conversation_template_id",
  "gizmo_id",
  "conversation_origin",
  "is_archived",
  "is_starred",
  "is_do_not_remember",
];

function bump(counts, key, by = 1) {
  counts[key] = (counts[key] || 0) + by;
}

function emptyStats() {
  return {
    off_branch_messages: 0,
    skipped: {},
    skipped_content_types: {},
    dropped_parts: {},
    time_filled: 0,
    time_missing: 0,
    citations_removed: 0,
  };
}

// create_time is Unix seconds (a float), sometimes null; 0 is no time either.
function timeOf(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && !(value > 0)) return null;
  if (typeof value === "string" && Number.isFinite(Number(value)) && !(Number(value) > 0)) return null;
  return normalizeCreatedAt(value);
}

function partsToText(content, stats) {
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const texts = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.trim()) texts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    // Voice turns carry their words as an audio_transcription part.
    if (typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text);
      continue;
    }
    // Images, audio and file pointers: the file itself is not memory.
    bump(stats.dropped_parts, part.content_type || "object");
  }
  return normalizeRawText(texts.join("\n\n"));
}

// Answers that searched the web carry the app's markup, which it draws as pills
// and cards: "citeturn0search3", "entity[\"people\",
// \"Name\"]", image groups and nav lists; "..." brackets the
// cited words. Older answers cite as "【12†source】". As text these are noise; an
// entity keeps the name it showed.
const APP_MARKUP = /([ \t]*)([A-Za-z_]+)([\s\S]*?)/g;
const OLD_CITATION = /[ \t]*【\d+(?::\d+)?†[^】\n]*】/g;

export function cleanAnswerMarkup(text, stats = emptyStats()) {
  let cleaned = text.replace(APP_MARKUP, (match, lead, kind, body) => {
    stats.citations_removed += 1;
    if (/entity$/.test(kind)) {
      try {
        const value = JSON.parse(body);
        if (Array.isArray(value) && typeof value[1] === "string" && value[1].trim()) return `${lead}${value[1]}`;
      } catch {
        // not the shape it usually has; dropped like a citation
      }
    }
    return "";
  });
  cleaned = cleaned.replace(OLD_CITATION, () => {
    stats.citations_removed += 1;
    return "";
  });
  return normalizeRawText(cleaned.replace(/[-]/g, ""));
}

function skipReason(message) {
  const role = message.author?.role;
  if (!KEPT_ROLES.has(role)) return `role:${role || "unknown"}`;
  const metadata = message.metadata || {};
  if (metadata.is_visually_hidden_from_conversation) return "hidden";
  // Custom instructions and memory injections arrive as user turns nobody typed.
  if (metadata.is_user_system_message) return "custom_instructions";
  // An assistant turn addressed to a tool (python, web search, image generation,
  // the memory tool "bio", canvas) is a call the reader never saw as an answer.
  if (role === "assistant" && typeof message.recipient === "string" && message.recipient && message.recipient !== "all") {
    return "tool_call";
  }
  const type = message.content?.content_type;
  if (!KEPT_CONTENT_TYPES.has(type)) return `content:${type || "none"}`;
  return null;
}

// The active branch, oldest first. Walking up from `current_node` skips every
// regenerated or edited sibling, which is what the reader saw.
export function activeBranch(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  let nodeId = conversation.current_node;
  if (!nodeId || !mapping[nodeId]) {
    // Some exports omit current_node; fall back to the newest message.
    let newest = null;
    for (const [id, node] of Object.entries(mapping)) {
      const time = node?.message?.create_time;
      if (typeof time !== "number") continue;
      if (!newest || time > newest.time) newest = { id: node.id || id, time };
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
    created_at: timeOf(conversation?.create_time),
    updated_at: timeOf(conversation?.update_time),
  };
  for (const field of SESSION_FIELDS) {
    const value = conversation?.[field];
    if (["string", "number", "boolean"].includes(typeof value)) metadata[field] = value;
  }
  const stats = emptyStats();
  const branch = activeBranch(conversation);
  const onBranch = new Set(branch);
  const mapping = conversation?.mapping && typeof conversation.mapping === "object" ? conversation.mapping : {};
  for (const node of Object.values(mapping)) {
    if (!onBranch.has(node) && KEPT_ROLES.has(node?.message?.author?.role)) stats.off_branch_messages += 1;
  }

  const turns = [];
  let lineIndex = 0;
  // A message without a time takes the last time before it on the branch, so it
  // stays in its place in time; the first one takes the conversation's.
  let lastTime = metadata.created_at;
  for (const node of branch) {
    lineIndex += 1;
    const message = node?.message;
    if (!message || typeof message !== "object") continue;
    const ownTime = timeOf(message.create_time);
    if (ownTime) lastTime = ownTime;
    const type = message.content?.content_type || "none";
    const reason = skipReason(message);
    if (reason) {
      bump(stats.skipped, reason);
      bump(stats.skipped_content_types, type);
      continue;
    }
    const role = message.author.role;
    let text = partsToText(message.content, stats);
    if (role === "assistant" && text) text = cleanAnswerMarkup(text, stats);
    if (!text) {
      // An image or file sent with no words.
      bump(stats.skipped, "no_text");
      bump(stats.skipped_content_types, type);
      continue;
    }
    if (!ownTime) {
      if (lastTime) stats.time_filled += 1;
      else stats.time_missing += 1;
    }
    turns.push({
      role,
      content: text,
      created_at: ownTime || lastTime || null,
      line_index: lineIndex,
      source_message_id: message.id || node.id,
    });
  }
  return {
    provider: "chatgpt",
    session_id: sanitizeId(conversationId || metadata.title || "conversation", "chatgpt"),
    metadata,
    turns,
    stats,
  };
}

function firstTime(parsed) {
  return parsed.turns[0]?.created_at || parsed.metadata.created_at || null;
}

function newerCopy(candidate, existing) {
  const a = candidate.metadata.updated_at || "";
  const b = existing.metadata.updated_at || "";
  if (a !== b) return a > b;
  return candidate.turns.length > existing.turns.length;
}

function mergeCounts(into, from) {
  for (const [key, value] of Object.entries(from)) bump(into, key, value);
}

function summarize(sessions, extra) {
  const summary = {
    ...extra,
    importable_conversations: 0,
    empty_conversations: 0,
    do_not_remember_conversations: 0,
    turns_by_role: {},
    skipped: {},
    skipped_content_types: {},
    dropped_parts: {},
    branches: { conversations_with_other_branches: 0, off_branch_messages: 0 },
    times: { first: null, last: null, filled_from_previous: 0, missing: 0 },
    citations_removed: 0,
  };
  for (const parsed of sessions) {
    const { stats } = parsed;
    if (parsed.turns.length) summary.importable_conversations += 1;
    else summary.empty_conversations += 1;
    if (parsed.metadata.is_do_not_remember === true) summary.do_not_remember_conversations += 1;
    for (const turn of parsed.turns) {
      bump(summary.turns_by_role, turn.role);
      if (turn.created_at && (!summary.times.first || turn.created_at < summary.times.first)) summary.times.first = turn.created_at;
      if (turn.created_at && (!summary.times.last || turn.created_at > summary.times.last)) summary.times.last = turn.created_at;
    }
    mergeCounts(summary.skipped, stats.skipped);
    mergeCounts(summary.skipped_content_types, stats.skipped_content_types);
    mergeCounts(summary.dropped_parts, stats.dropped_parts);
    if (stats.off_branch_messages) {
      summary.branches.conversations_with_other_branches += 1;
      summary.branches.off_branch_messages += stats.off_branch_messages;
    }
    summary.times.filled_from_previous += stats.time_filled;
    summary.times.missing += stats.time_missing;
    summary.citations_removed += stats.citations_removed;
  }
  return summary;
}

/**
 * Every conversation of an export, parsed, ready to import: `sessions` holds the
 * ones with something to remember, oldest first, each conversation once (a
 * conversation found twice keeps its newer copy). Nothing is sent anywhere.
 */
export async function loadExport(exportPath) {
  const report = { files: [], skipped_archives: [] };
  const byId = new Map();
  const unreadable = [];
  let read = 0;
  let duplicates = 0;
  for await (const { conversation, source } of readConversations(exportPath, report)) {
    read += 1;
    let parsed;
    try {
      parsed = parseConversation(conversation);
    } catch (error) {
      unreadable.push({ conversation_id: conversation?.conversation_id || conversation?.id || null, source, error: String(error?.message || error) });
      continue;
    }
    parsed.metadata.file_path = source;
    const existing = byId.get(parsed.session_id);
    if (existing) {
      duplicates += 1;
      if (newerCopy(parsed, existing)) byId.set(parsed.session_id, parsed);
      continue;
    }
    byId.set(parsed.session_id, parsed);
  }
  if (!read) {
    const skipped = report.skipped_archives.map((entry) => `${entry.archive} (${entry.reason})`);
    throw new Error(`no conversations found in ${exportPath}${skipped.length ? `; not read: ${skipped.join(", ")}` : ""}`);
  }
  const all = [...byId.values()];
  const summary = summarize(all, { conversations_read: read, duplicate_conversations: duplicates, unreadable_conversations: unreadable.length });
  const sessions = all
    .filter((parsed) => parsed.turns.length)
    .sort((a, b) => {
      const left = firstTime(a);
      const right = firstTime(b);
      if (left !== right) {
        if (!left) return 1;
        if (!right) return -1;
        return left < right ? -1 : 1;
      }
      return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
    });
  return { conversations: read, files: report.files, skipped_archives: report.skipped_archives, unreadable, sessions, summary };
}

export async function parseExport(filePath) {
  return (await loadExport(filePath)).sessions;
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
