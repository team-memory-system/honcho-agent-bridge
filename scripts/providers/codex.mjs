import fsp from "node:fs/promises";
import path from "node:path";
import { extractTextBlocks, normalizeCreatedAt, normalizeRawText, sanitizeId } from "./shared.mjs";

const NOISE_PREFIXES = [
  "# AGENTS.md instructions for ",
  "# CLAUDE.md instructions for ",
  "<permissions instructions>",
  "<app-context>",
  "<environment_context>",
  "<local-command-caveat>",
  "<command-message>",
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<task-notification>",
];
const NOISE_SUBSTRINGS = [
  "This file defines global defaults for coding agents on this machine.",
  "## Node.js Package Manager",
  "## Python Package Manager",
  "Global Agent Policy",
];
const REQUEST_MARKERS = ["## My request for Codex:", "My request for Codex:"];
const AUTOMATION_USER_PREFIXES = [
  "Automation:",
  "Watchdog intervention",
  "Watchdog follow-up",
  "Watchdog redirection",
  "<subagent_notification>",
];
const LINEAR_TASK_PREFIXES = ["You are working on a Linear issue", "You are working on a Linear ticket"];

function normalizeCodexText(text) {
  let out = normalizeRawText(text);
  if (!out) return "";
  for (const marker of REQUEST_MARKERS) {
    if (out.includes(marker)) {
      out = out.split(marker, 2)[1].trim();
      break;
    }
  }
  if (NOISE_PREFIXES.some((prefix) => out.startsWith(prefix))) return "";
  if (NOISE_SUBSTRINGS.some((token) => out.includes(token))) return "";
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
    const text = extractTextBlocks(payload.content, normalizeCodexText);
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
