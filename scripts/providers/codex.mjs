import fsp from "node:fs/promises";
import path from "node:path";
import { extractTextBlocks, isInjectedContextText, normalizeCreatedAt, normalizeRawText, sanitizeId } from "./shared.mjs";

const NOISE_TAGS = [
  "permissions instructions", "app-context", "environment_context",
  "local-command-caveat", "command-message", "command-name",
  "local-command-stdout", "local-command-stderr", "bash-input",
  "bash-stdout", "bash-stderr", "task-notification", "recommended_plugins",
  "turn_aborted", "hook_prompt", "skill", "codex_delegation",
];
const AUTOMATION_USER_PREFIXES = [
  "Automation:",
  "Watchdog intervention",
  "Watchdog follow-up",
  "Watchdog redirection",
  "<subagent_notification>",
];
const LINEAR_TASK_PREFIXES = ["You are working on a Linear issue", "You are working on a Linear ticket"];

function normalizeCodexText(text, role) {
  const out = normalizeRawText(text);
  if (!out) return "";
  if (role !== "user") return out;
  // Only unwrap the file-mention envelope actually emitted by the Codex app.
  // An arbitrary occurrence of this heading (including one in an answer or
  // quoted transcript) is ordinary text. Slice once so later markers survive.
  const wrapper = out.match(/^# Files mentioned by the user:\n+((?:## [^\n]+: (?:\/|[A-Za-z]:[\\/]|~[\\/])[^\n]+\n+)+)## My request for Codex:\n/);
  if (wrapper) {
    return out.slice(wrapper[0].length).trim();
  }
  const externalTag = out.match(/^<(external_codex_apps_[A-Za-z0-9_]+)>/)?.[1];
  if (isInjectedContextText(out, externalTag ? [...NOISE_TAGS, externalTag] : NOISE_TAGS)) return "";
  return out;
}

export async function parseTranscript(transcriptPath) {
  const metadata = { source: "codex", file_path: transcriptPath };
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
    const text = extractTextBlocks(payload.content, (text) => normalizeCodexText(text, payload.role));
    if (!text) continue;
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
