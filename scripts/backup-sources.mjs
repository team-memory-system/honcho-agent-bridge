// What the conversation backup copies from this computer, and where each file goes.
//
// The backup copies the apps' own files byte for byte. Nothing here converts or
// filters content: a transcript's first records are read only to learn the day its
// conversation started (and, for Codex, whether it is a subagent's), the same way
// the 2026-10-04 reorganisation of the destination did.
//
//   claude  ~/.claude/projects/<project>/<session>.jsonl          main transcript
//           ~/.claude/projects/<project>/memory/*.md              memory notes
//           ~/.claude/history.jsonl                               prompt history
//   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl          main transcript
//           ~/.codex/archived_sessions/rollout-*.jsonl            archived transcript
//           ~/.codex/history.jsonl                                prompt history
//   agy     ~/.gemini/<product>/brain/<conversation>/.system_generated/logs/
//             transcript_full.jsonl, transcript.jsonl             main transcript
//           (<product>: antigravity-cli, antigravity, antigravity-ide)
//           ~/.gemini/antigravity-cli/history.jsonl               prompt history
//   grok    ~/.grok/sessions/<encoded cwd>/<session>/
//             chat_history.jsonl, updates.jsonl                   main transcript
//
// Left out, and only counted: Claude subagent transcripts and tool results (inside
// <project>/<session>/), Codex subagent rollouts (session_meta.source.subagent),
// a stale copy in sessions/ of a session that is in archived_sessions/, everything
// else in an agy conversation folder (artifacts, screenshots, recordings) and in a
// Grok session folder (summary, prompts, events), and Grok's search index. Never
// read: everything else the apps keep (runtime state, caches), and ~/.hermes, which
// has no Hermes left in it (on one computer it is a link to Team Memory's own state).
//
// Destination, relative to 대화/ (the date is the day the conversation started, KST):
//   <agent>/YYYY/MM/DD/<original file name>
//   agy|grok/YYYY/MM/DD/<conversation id>/<original file name>   (their file names
//                                    are the same in every conversation)
//   codex/_아카이브/YYYY/MM/DD/<original file name>
//   <agent>/_부속자료/<device>/history.jsonl
//   claude/_부속자료/projects/<project>/memory/<name>.md
import fsp from "node:fs/promises";
import path from "node:path";

export const AGENTS = Object.freeze(["claude", "codex", "agy", "grok"]);
export const ARCHIVE_FOLDER = "_아카이브";
export const SUPPORT_FOLDER = "_부속자료";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// A Claude transcript's first own record is normally in its first few kilobytes;
// an attachment can push it further, but not past this.
const CLAUDE_HEAD_BYTES = 16 * 1024 * 1024;
// Codex's session_meta is one line that carries the base instructions.
const CODEX_HEAD_BYTES = 8 * 1024 * 1024;
// An agy transcript starts with the user's first input, which can be long.
const AGY_HEAD_BYTES = 8 * 1024 * 1024;
const AGY_PRODUCTS = Object.freeze(["antigravity-cli", "antigravity", "antigravity-ide"]);
const AGY_TRANSCRIPTS = Object.freeze(["transcript_full.jsonl", "transcript.jsonl"]);
const GROK_TRANSCRIPTS = Object.freeze(["chat_history.jsonl", "updates.jsonl"]);
const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pad = (value) => String(value).padStart(2, "0");

/** "YYYY/MM/DD" of an instant in Korea Standard Time (UTC+9, no daylight saving), or null. */
export function kstDateFolder(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}/${pad(shifted.getUTCMonth() + 1)}/${pad(shifted.getUTCDate())}`;
}

/** Complete lines from the start of a file, reading at most `maxBytes`. */
export async function* headLines(filePath, maxBytes) {
  const handle = await fsp.open(filePath, "r");
  try {
    let parts = [];
    let readTotal = 0;
    while (readTotal < maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, maxBytes - readTotal));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
      let start = 0;
      let newline;
      while ((newline = chunk.indexOf(10, start)) >= 0 && newline < bytesRead) {
        parts.push(chunk.subarray(start, newline));
        yield Buffer.concat(parts).toString("utf8");
        parts = [];
        start = newline + 1;
      }
      if (start < bytesRead) parts.push(chunk.subarray(start, bytesRead));
    }
    // A last line without its newline is still being written; it is not read.
  } finally {
    await handle.close();
  }
}

function parseLine(line) {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * When a Claude Code session started: the timestamp of its first record that
 * carries its own sessionId, else of the first record with any timestamp.
 */
export async function claudeSessionStart(filePath) {
  const sessionId = path.basename(filePath, ".jsonl");
  let fallback = null;
  for await (const line of headLines(filePath, CLAUDE_HEAD_BYTES)) {
    const record = parseLine(line);
    if (!record || typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) continue;
    if (record.sessionId === sessionId) return { startedAt: record.timestamp, basis: "own-record" };
    fallback ??= record.timestamp;
  }
  return fallback ? { startedAt: fallback, basis: "first-record" } : { startedAt: null, basis: "unknown" };
}

/**
 * A Codex rollout's first line: session_meta (payload.timestamp, payload.source),
 * or the older header ({id, timestamp}) of 2025 rollouts.
 */
export async function codexSessionMeta(filePath) {
  for await (const line of headLines(filePath, CODEX_HEAD_BYTES)) {
    const record = parseLine(line);
    if (!record) return { startedAt: null, subagent: false, basis: "unknown" };
    const meta = record.type === "session_meta" && record.payload && typeof record.payload === "object" ? record.payload : null;
    const source = meta?.source;
    const subagent = Boolean((source && typeof source === "object" && source.subagent) || meta?.thread_source === "subagent");
    const startedAt = [meta?.timestamp, record.timestamp].find((value) => typeof value === "string" && Number.isFinite(Date.parse(value))) || null;
    return { startedAt, subagent, basis: startedAt ? (meta ? "session-meta" : "header") : "unknown" };
  }
  return { startedAt: null, subagent: false, basis: "unknown" };
}

/** When an agy conversation started: the created_at of the transcript's first record that has one. */
export async function agySessionStart(filePath) {
  for await (const line of headLines(filePath, AGY_HEAD_BYTES)) {
    const record = parseLine(line);
    if (record && typeof record.created_at === "string" && Number.isFinite(Date.parse(record.created_at))) {
      return { startedAt: record.created_at, basis: "first-record" };
    }
  }
  return { startedAt: null, basis: "unknown" };
}

/**
 * When a Grok session started: summary.json's created_at beside the transcript,
 * else the time in its UUIDv7 session id, else the first update's timestamp.
 * chat_history.jsonl itself carries no times.
 */
export async function grokSessionStart(filePath) {
  const sessionDir = path.dirname(filePath);
  try {
    const summary = JSON.parse(await fsp.readFile(path.join(sessionDir, "summary.json"), "utf8"));
    if (typeof summary?.created_at === "string" && Number.isFinite(Date.parse(summary.created_at))) {
      return { startedAt: summary.created_at, basis: "summary" };
    }
  } catch {}
  const v7 = UUID_V7.exec(path.basename(sessionDir));
  if (v7) {
    const ms = Number.parseInt(`${v7[1]}${v7[2]}`, 16);
    if (Number.isFinite(ms) && ms > 0) return { startedAt: new Date(ms).toISOString(), basis: "session-id" };
  }
  try {
    for await (const line of headLines(path.join(sessionDir, "updates.jsonl"), AGY_HEAD_BYTES)) {
      const record = parseLine(line);
      if (record && Number.isFinite(record.timestamp)) {
        const ms = record.timestamp > 1e12 ? record.timestamp : record.timestamp * 1000;
        return { startedAt: new Date(ms).toISOString(), basis: "first-update" };
      }
    }
  } catch {}
  return { startedAt: null, basis: "unknown" };
}

async function readDirectory(directory) {
  try {
    return await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readDirectory(directory)) {
    if (entry.isDirectory()) count += await countFiles(path.join(directory, entry.name));
    else if (entry.isFile() && entry.name !== ".DS_Store") count += 1;
  }
  return count;
}

async function isFile(target) {
  try { return (await fsp.stat(target)).isFile(); } catch { return false; }
}

/** The app folders on this computer, overridable for tests. */
export function sourceRoots(homeDir) {
  return {
    claude: path.join(homeDir, ".claude"),
    codex: path.join(homeDir, ".codex"),
    agy: path.join(homeDir, ".gemini"),
    grok: path.join(homeDir, ".grok"),
  };
}

/**
 * Every file the backup may copy, without reading any content. Codex rollouts are
 * still unclassified here (main or subagent is in their first line). `excluded`
 * counts what is left out on purpose, by "<agent>/<kind>".
 */
export async function discoverSources({ homeDir, agents = AGENTS } = {}) {
  const roots = sourceRoots(homeDir);
  const items = [];
  const excluded = {};
  const exclude = (key, count = 1) => { if (count) excluded[key] = (excluded[key] || 0) + count; };

  if (agents.includes("claude")) {
    const projects = path.join(roots.claude, "projects");
    for (const project of await readDirectory(projects)) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(projects, project.name);
      for (const entry of await readDirectory(projectDir)) {
        const full = path.join(projectDir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          // Claude Code 1.x kept subagent transcripts beside the session as agent-*.jsonl.
          if (entry.name.startsWith("agent-")) exclude("claude/subagent");
          else items.push({ agent: "claude", kind: "main", localPath: full, name: entry.name, project: project.name });
        } else if (entry.isDirectory() && entry.name === "memory") {
          for (const note of await readDirectory(full)) {
            if (note.isFile() && note.name.endsWith(".md")) {
              items.push({ agent: "claude", kind: "memory", localPath: path.join(full, note.name), name: note.name, project: project.name });
            }
          }
        } else if (entry.isDirectory()) {
          // <session>/subagents, <session>/tool-results and anything else a session keeps.
          for (const part of await readDirectory(full)) {
            const count = part.isDirectory() ? await countFiles(path.join(full, part.name)) : part.isFile() && part.name !== ".DS_Store" ? 1 : 0;
            if (part.name === "subagents") exclude("claude/subagent", count);
            else if (part.name === "tool-results") exclude("claude/tool-result", count);
            else exclude("claude/other", count);
          }
        }
      }
    }
    const history = path.join(roots.claude, "history.jsonl");
    if (await isFile(history)) items.push({ agent: "claude", kind: "history", localPath: history, name: "history.jsonl" });
  }

  if (agents.includes("codex")) {
    const sessions = path.join(roots.codex, "sessions");
    const archived = path.join(roots.codex, "archived_sessions");
    const archivedIds = new Set();
    for (const entry of await readDirectory(archived)) {
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        archivedIds.add(codexSessionId(entry.name));
        items.push({ agent: "codex", kind: "archived", localPath: path.join(archived, entry.name), name: entry.name });
      }
    }
    const stack = [sessions];
    while (stack.length) {
      const directory = stack.pop();
      for (const entry of await readDirectory(directory)) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          // A session lives in one place. A stale copy left in sessions/ of a session
          // that is in archived_sessions/ is never copied to the normal date folder.
          if (archivedIds.has(codexSessionId(entry.name))) exclude("codex/duplicate-of-archived");
          else items.push({ agent: "codex", kind: "main", localPath: full, name: entry.name });
        }
      }
    }
    const history = path.join(roots.codex, "history.jsonl");
    if (await isFile(history)) items.push({ agent: "codex", kind: "history", localPath: history, name: "history.jsonl" });
  }

  if (agents.includes("agy")) {
    for (const product of AGY_PRODUCTS) {
      const brain = path.join(roots.agy, product, "brain");
      for (const conversation of await readDirectory(brain)) {
        if (!conversation.isDirectory()) continue;
        const conversationDir = path.join(brain, conversation.name);
        const logs = path.join(conversationDir, ".system_generated", "logs");
        let transcripts = 0;
        for (const name of AGY_TRANSCRIPTS) {
          const full = path.join(logs, name);
          if (!(await isFile(full))) continue;
          items.push({ agent: "agy", kind: "main", localPath: full, name, session: conversation.name });
          transcripts += 1;
        }
        // Artifacts, screenshots, browser recordings and the rest of the conversation's folder.
        exclude("agy/other", (await countFiles(conversationDir)) - transcripts);
      }
    }
    const history = path.join(roots.agy, "antigravity-cli", "history.jsonl");
    if (await isFile(history)) items.push({ agent: "agy", kind: "history", localPath: history, name: "history.jsonl" });
  }

  if (agents.includes("grok")) {
    const sessions = path.join(roots.grok, "sessions");
    for (const group of await readDirectory(sessions)) {
      if (group.isFile() && group.name !== ".DS_Store") exclude(group.name.startsWith("session_search.") ? "grok/search-index" : "grok/other");
      if (!group.isDirectory()) continue;
      for (const session of await readDirectory(path.join(sessions, group.name))) {
        const sessionDir = path.join(sessions, group.name, session.name);
        if (!session.isDirectory()) {
          if (session.isFile() && session.name !== ".DS_Store") exclude("grok/other");
          continue;
        }
        let transcripts = 0;
        for (const name of GROK_TRANSCRIPTS) {
          const full = path.join(sessionDir, name);
          if (!(await isFile(full))) continue;
          items.push({ agent: "grok", kind: "main", localPath: full, name, session: session.name });
          transcripts += 1;
        }
        // summary.json, system_prompt.txt, prompt_context.json, events.jsonl, locks and the like.
        exclude("grok/other", (await countFiles(sessionDir)) - transcripts);
      }
    }
  }

  return { items, excluded };
}

/** The session id at the end of a rollout's name (rollout-<time>-<id>.jsonl), or the name itself. */
export function codexSessionId(name) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return match ? match[1].toLowerCase() : name;
}

/** "name.ext" → ["name", ".ext"]; history.jsonl → ["history", ".jsonl"]. */
export function splitName(name) {
  const extension = path.extname(name);
  return [extension ? name.slice(0, -extension.length) : name, extension];
}

/** The same file name with a tag before its extension: rollout-x.jsonl → rollout-x.<tag>.jsonl. */
export function taggedName(name, tag) {
  const [stem, extension] = splitName(name);
  return `${stem}.${tag}${extension}`;
}

/**
 * Where a file goes, relative to 대화/. `date` ("YYYY/MM/DD") is needed for main and
 * archived transcripts. `shared` says whether other computers may write the same
 * path (then a different version is kept under a device-tagged name).
 */
export function destinationFor(item, { date, device }) {
  // agy and Grok name every conversation's transcript the same, so each conversation has its own folder.
  if (item.kind === "main" && item.session) return { rel: `${item.agent}/${date}/${item.session}/${item.name}`, shared: true };
  if (item.kind === "main") return { rel: `${item.agent}/${date}/${item.name}`, shared: true };
  if (item.kind === "archived") return { rel: `${item.agent}/${ARCHIVE_FOLDER}/${date}/${item.name}`, shared: true };
  if (item.kind === "history") return { rel: `${item.agent}/${SUPPORT_FOLDER}/${device}/${item.name}`, shared: false };
  if (item.kind === "memory") return { rel: `${item.agent}/${SUPPORT_FOLDER}/projects/${item.project}/memory/${item.name}`, shared: true };
  throw new Error(`no destination for ${item.kind}`);
}

/** The same session's path in the other place: the normal date folder for an archived one, and back. */
export function counterpartFor(item, { date }) {
  if (item.agent !== "codex") return null;
  if (item.kind === "archived") return `${item.agent}/${date}/${item.name}`;
  if (item.kind === "main") return `${item.agent}/${ARCHIVE_FOLDER}/${date}/${item.name}`;
  return null;
}
