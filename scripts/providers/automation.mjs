// Conversations no person took part in: every prompt in them is a program's (a Codex
// automation or watchdog, a Symphony task, a subagent, a `claude -p` or `codex exec`
// run), by each agent's own classifier. They go into memory only when 자동 실행 대화도
// 수집 is on (config.json `collect.automation`), and only into the own server.
import { classifyAutomation as agy } from "./agy.mjs";
import { classifyAutomation as claude } from "./claude.mjs";
import { classifyAutomation as codex } from "./codex.mjs";

const CLASSIFIERS = { agy, claude, codex };

/** Whether every user-role turn of `parsed` is a program's prompt. A session the person typed in once is theirs. */
export function automationOnly(provider, parsed) {
  const classify = CLASSIFIERS[provider];
  const prompts = (parsed?.turns || []).filter((turn) => turn.role === "user");
  if (!classify || !prompts.length) return false;
  return prompts.every((turn) => classify(turn.content, parsed.metadata || {}, parsed)[0]);
}

/**
 * The same, as far as the record a transcript names its folder in tells it (the line
 * the project list reads, projects.mjs): Codex's session_meta, or the first Claude Code
 * record with a cwd. A Codex automation's prompt comes later, but its session_meta says
 * `thread_source: "automation"`.
 */
export function automationRecord(provider, record) {
  if (provider === "codex") {
    const meta = record?.payload || {};
    return meta.thread_source === "automation" || codex("", { originator: meta.originator, source_app: meta.source, cwd: meta.cwd })[0];
  }
  if (provider === "claude") return claude("", { entrypoint: record?.entrypoint })[0];
  return false;
}
