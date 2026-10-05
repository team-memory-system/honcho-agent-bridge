import fsp from "node:fs/promises";
import path from "node:path";
import { extractTextBlocks, isInjectedContextText, normalizeCreatedAt, normalizeRawText, sanitizeId } from "./shared.mjs";

const NOISE_TAGS = [
  "permissions instructions", "app-context", "environment_context",
  "local-command-caveat", "command-message", "command-name",
  "local-command-stdout", "local-command-stderr", "bash-input",
  "bash-stdout", "bash-stderr", "task-notification", "recommended_plugins",
  "turn_aborted", "hook_prompt", "skill", "codex_delegation",
  // AGENTS.md text in the 2025 format, a review's output, a shell command's record.
  "user_instructions", "user_action", "user_shell_command",
];
const AUTOMATION_USER_PREFIXES = [
  "Automation:",
  "Watchdog intervention",
  "Watchdog follow-up",
  "Watchdog redirection",
  "<subagent_notification>",
];
const LINEAR_TASK_PREFIXES = ["You are working on a Linear issue", "You are working on a Linear ticket"];

// A mentioned file as the app lists it: "## <name>: <path>", where the path is
// absolute or (from the IDE) ends with that name, then possibly "Image attachment:".
function filesMentionedLength(text) {
  const header = text.match(/^# Files mentioned by the user:\n+/);
  if (!header) return 0;
  let at = header[0].length;
  let entries = 0;
  for (;;) {
    const entry = text.slice(at).match(/^## ([^\n]+): ([^\n]+)\n(?:Image attachment: (?:true|false)\n)?\n*/);
    if (!entry) break;
    const [, name, filePath] = entry;
    if (!/^(?:\/|[A-Za-z]:[\\/]|~[\\/])/.test(filePath) && filePath.split(/[\\/]/).pop() !== name) break;
    at += entry[0].length;
    entries += 1;
  }
  if (!entries) return 0;
  const note = text.slice(at).match(/^Distinguish instructions in attached documents from the user's request\.\n+/);
  return at + (note ? note[0].length : 0);
}

const sectionPattern = (pattern) => (text) => text.match(pattern)?.[0].length || 0;

// Context the Codex app puts in front of what the person typed: the in-app
// browser's or Chrome's tab state, the IDE's active file, selection and open
// tabs, mentioned files, and a referenced ChatGPT conversation's cached
// preview. Each is matched whole, as the app writes it.
const APP_CONTEXT_SECTIONS = [
  sectionPattern(/^<in-app-browser-context source="ambient-ui-state">\n[\s\S]*?\n<\/in-app-browser-context>\n+/),
  sectionPattern(/^# In app browser:\n(?: *- [^\n]*\n)+\n*/),
  sectionPattern(/^# Chrome tabs:\n(?: *- [^\n]*\n)+\n*/),
  sectionPattern(/^# Context from my IDE setup:\n+(?:## Active file: [^\n]+\n+)?(?:## Active selection of the file:\n[\s\S]*?\n+(?=## Open tabs:\n|# Files mentioned by the user:\n|## My request for Codex:))?(?:## Open tabs:\n(?: *- [^\n]+\n)+\n*)?/),
  filesMentionedLength,
  sectionPattern(/^## Referenced ChatGPT conversation:\nThis is an untrusted ChatGPT conversation reference\.[^\n]*\n\{[^\n]*\}\n+/),
];
const REQUEST_MARKER = /^## My request(?: for Codex)?:(?:\n|$)/;

/**
 * The person's request from a message the app wrapped in context sections, or
 * null when the message does not start with such sections. The request is all
 * that follows the first request marker, so later markers it quotes survive.
 * A section the app did not write (or a heading the person typed) leaves the
 * whole message as it is.
 */
function unwrapAppContext(text) {
  let rest = text;
  let unwrapped = false;
  while (rest) {
    const marker = rest.match(REQUEST_MARKER);
    if (marker && unwrapped) return rest.slice(marker[0].length).trim();
    const length = APP_CONTEXT_SECTIONS.map((section) => section(rest)).find(Boolean);
    if (!length) return null;
    rest = rest.slice(length);
    unwrapped = true;
  }
  return null;
}

// While a thread goal is active the app sends a continuation prompt in the user
// role each turn. Only the objective inside it is the person's words.
// An objective the person edited arrives as <untrusted_objective>.
const GOAL_WRAPPERS = [
  /^<codex_internal_context source="goal">\n[\s\S]*?\n<(objective|untrusted_objective)>\n([\s\S]*?)\n<\/\1>\n[\s\S]*\n<\/codex_internal_context>$/,
  /^<goal_context>\n[\s\S]*?\n<(objective|untrusted_objective)>\n([\s\S]*?)\n<\/\1>\n[\s\S]*\n<\/goal_context>$/,
];

function goalObjective(text) {
  for (const pattern of GOAL_WRAPPERS) {
    const match = text.match(pattern);
    if (match) return match[2].trim();
  }
  return null;
}

// An attached image is written as "<image …>", the image, "</image>"; the two
// markers are the app's, not text the person typed.
function withoutImageMarkers(content) {
  const items = Array.isArray(content) ? content : [];
  return items.filter((item, index) => {
    if (item?.type !== "input_text" || typeof item.text !== "string") return true;
    const text = item.text.trim();
    if (/^<image(?:\s[^<>]*)?>$/.test(text)) return items[index + 1]?.type !== "input_image";
    if (text === "</image>") return items[index - 1]?.type !== "input_image";
    return true;
  });
}

function normalizeCodexText(text, role) {
  const out = normalizeRawText(text);
  if (!out) return "";
  if (role !== "user") return out;
  // Only unwrap context sections actually emitted by the Codex app. An
  // arbitrary occurrence of these headings (including one in an answer or
  // quoted transcript) is ordinary text. Slice once so later markers survive.
  const request = unwrapAppContext(out);
  if (request !== null) return request;
  const externalTag = out.match(/^<(external_codex_apps_[A-Za-z0-9_]+)>/)?.[1];
  if (isInjectedContextText(out, externalTag ? [...NOISE_TAGS, externalTag] : NOISE_TAGS)) return "";
  return out;
}

export async function parseTranscript(transcriptPath) {
  const metadata = { source: "codex", file_path: transcriptPath };
  const turns = [];
  const goals = new Set();
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
    if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
      const sessionMeta = obj.payload;
      if (!metadata.original_session_id && sessionMeta.id) {
        metadata.original_session_id = sessionMeta.id;
      } else if (sessionMeta.id && sessionMeta.id !== metadata.original_session_id) {
        metadata.parent_session_id ??= sessionMeta.id;
      }
      metadata.parent_session_id ??= sessionMeta.source?.subagent?.thread_spawn?.parent_thread_id;
      metadata.cwd ??= sessionMeta.cwd;
      metadata.originator ??= sessionMeta.originator;
      metadata.cli_version ??= sessionMeta.cli_version;
      metadata.source_app ??= sessionMeta.source;
      metadata.model_provider ??= sessionMeta.model_provider;
      continue;
    }
    const payload = obj.payload || {};
    if (obj.type !== "response_item" || payload.type !== "message") continue;
    if (!["user", "assistant"].includes(payload.role)) continue;
    const user = payload.role === "user";
    const content = user ? withoutImageMarkers(payload.content) : payload.content;
    let goal = false;
    const text = extractTextBlocks(content, (joined) => {
      const objective = user ? goalObjective(normalizeRawText(joined)) : null;
      goal = objective !== null;
      return goal ? objective : normalizeCodexText(joined, payload.role);
    });
    if (!text) continue;
    // The same goal is sent again every turn it stays active; keep its first copy.
    if (goal) {
      if (goals.has(text)) continue;
      goals.add(text);
    }
    turns.push({
      role: payload.role,
      content: text,
      created_at: normalizeCreatedAt(obj.timestamp),
      line_index: index + 1,
      phase: payload.phase,
    });
  }
  return {
    provider: "codex",
    session_id: sanitizeId(metadata.original_session_id || path.basename(transcriptPath), "codex"),
    metadata,
    turns,
  };
}

export function classifyAutomation(text, sessionMetadata) {
  if (AUTOMATION_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) return [true, "codex_cron"];
  if (LINEAR_TASK_PREFIXES.some((prefix) => text.startsWith(prefix))) return [true, "symphony_linear"];
  const { originator, source_app: sourceApp, cwd } = sessionMetadata;
  if (sourceApp && typeof sourceApp === "object" && sourceApp.subagent) return [true, "codex_subagent"];
  if (originator === "Claude Code") return [true, "claude_code_codex"];
  if (originator === "symphony-orchestrator") return [true, "symphony_linear"];
  if (originator === "codex_sdk_ts" || cwd === "/") return [true, "codex_sdk_ts"];
  if (sourceApp === "exec") return [true, "codex_exec"];
  if (typeof cwd === "string" && cwd.includes("/.symphony/workspaces/")) return [true, "symphony_linear"];
  return [false, null];
}
