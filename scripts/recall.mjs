#!/usr/bin/env node
// Recall at the start of work. Claude Code hooks call this so an agent begins with
// what was decided before, instead of waiting to be told to search memory.
//
//   session-start  (SessionStart: startup, clear)
//     The task is not known yet, only the folder. Brings the short summary of the
//     last conversation in this folder and the decisions made in the recent ones.
//   prompt         (UserPromptSubmit, until the first real request of a session)
//     The task is known. Searches conclusions with the request and brings the few
//     past judgments that match it, from any folder or agent.
//
// What is never sent to the agent: the peer card (it holds identity and personal
// attributes), automation peers, whole raw messages. Every block says that these
// are machine-made notes that may be wrong or out of date.
//
// Fails open: any error or a slow server prints nothing and exits 0.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { environmentAccess, fetchHoncho, honchoHeaders } from "./honcho-access.mjs";
import { sanitizeId } from "./providers/shared.mjs";

const ROOT_URL = (process.env.HONCHO_BASE_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.HONCHO_API_BEARER_TOKEN || "";
const ACCESS = environmentAccess(process.env, { legacy: true });
const WORKSPACE = process.env.HONCHO_WORKSPACE_ID || "memory";
const USER_PEER = process.env.HONCHO_USER_NAME || "user";
const REQUEST_TIMEOUT_MS = Number(process.env.HONCHO_RECALL_TIMEOUT_MS || "2500");
const DEBUG = process.env.HONCHO_RECALL_DEBUG === "1";
const debug = (message) => DEBUG && process.stderr.write(`[recall] ${message}\n`);
const STATE_FILE = process.env.HONCHO_RECALL_STATE || path.join(os.homedir(), ".hermes", "state", "claude-recall.json");

export const LIMITS = Object.freeze({
  recentSessions: 3,
  folderSessions: 20,
  localDistance: 0.56,
  globalDistance: 0.42,
  perSession: 30,
  decisions: 8,
  related: 6,
  summaryChars: 600,
  lineChars: 180,
  minPromptChars: 6,
  queryChars: 400,
  keepSessions: 300,
});

const NOTE =
  "주의: 대화에서 자동으로 뽑은 기록이라 틀리거나 이미 바뀌었을 수 있다. 지금 대화와 지시가 우선이고, 중요한 판단은 원문(Honcho search)으로 확인한다.";

// Conclusions that record a decision, a preference, an instruction or a standing principle,
// not small talk or a bare question. Matched loosely; the note under every block says these may be wrong.
const JUDGMENT = [
  /원한다|원함|원했|원하지|원하는|하라고|하지 말|말라고|말라|말자|필요가 없|필요하다|필요했|되어야|돼야|해야 한|해야 했|하길|하기를|달라고|바란다|좋겠|정했|정함|결정|교정|고치자|고치길|바꾸|바꿔|빼라|빼자|빼고|넣지|넣어|쓰지 않|쓰지 말|선호|싫어|좋아한|좋다고|좋았다고|요청했|지적했|피드백|기준(?:을|이|은)\s|규칙|금지|않기로|않겠다/,
  /\b(wants?|wanted|prefers?|preferred|decided|decision|chose|instructs?|instructed|insists?|should|must|needs? to|needed to|is needed|are needed|no need|has to|have to|avoid|rule|criteria|corrected|suggested changing|requested|asked (?:the assistant |claude |codex |them |it )?(?:to|for)|told (?:the assistant|claude|codex) to|tries to|aims to|intends to|would not|will not|do not|don't|never|instead of|rather than|was good|were good|liked)\b/i,
];
// Questions and musings look like judgments to the patterns above but are not.
const NOT_JUDGMENT = /\b(asked whether|asked if|wondered|wonders|was curious)\b|궁금|물었다|물어봤/i;

// Claude Code's compaction summary used to be stored as the person's own message, so the deriver
// turned its boilerplate into "<the person> instructed to continue without asking further questions".
// Those are machine text, not the person's judgment.
const MACHINE_NOTE = /\b(continu\w+ (?:the |a )?(?:previous |prior |resumed |earlier )?conversation|where it left off|ran out of context|summary of the earlier|without (?:asking|recap)|resumed conversation)\b|이전 대화(?:를|에서) 이어|요약을 제공/i;

export function isJudgment(text) {
  const value = String(text || "");
  if (MACHINE_NOTE.test(value)) return false;
  if (NOT_JUDGMENT.test(value)) return false;
  return JUDGMENT.some((pattern) => pattern.test(value));
}

function bigrams(text) {
  const clean = String(text || "").toLowerCase().replace(/[\s\p{P}]+/gu, "");
  const grams = new Set();
  for (let index = 0; index < clean.length - 1; index += 1) grams.add(clean.slice(index, index + 2));
  return grams;
}

/** Same note said twice (the deriver often writes one fact in two wordings). */
export function nearDuplicate(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  return shared / (x.size + y.size - shared) >= 0.6;
}

export function dedupe(items, seen = []) {
  const kept = [];
  for (const item of items) {
    if ([...seen, ...kept].some((other) => other.id === item.id || nearDuplicate(other.content, item.content))) continue;
    kept.push(item);
  }
  return kept;
}

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() + 9 * 3600 * 1000); // KST, the user's clock
  return `${String(local.getUTCMonth() + 1).padStart(2, "0")}/${String(local.getUTCDate()).padStart(2, "0")}`;
}

function agentOf(sessionId) {
  const match = /^(claude|codex|agy|chatgpt|hermes)/.exec(String(sessionId || ""));
  return match ? match[1] : "";
}

function clip(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function line(item, { withAgent = false } = {}) {
  const tag = [shortDate(item.created_at), withAgent ? agentOf(item.session_id) : ""].filter(Boolean).join(" · ");
  return `- ${tag ? `${tag} ` : ""}${clip(item.content, LIMITS.lineChars)}`;
}

/** The SessionStart block. Empty string when there is nothing worth saying. */
export function formatStart({ summary, summaryAt, decisions }) {
  const parts = [];
  if (summary) parts.push(`지난번 이 폴더 대화 요약${summaryAt ? ` (${shortDate(summaryAt)})` : ""}:\n${clip(summary, LIMITS.summaryChars)}`);
  if (decisions.length) parts.push(`이 폴더에서 정한 것 (최근 순):\n${decisions.map((item) => line(item)).join("\n")}`);
  if (!parts.length) return "";
  return `[Honcho 기억 · 세션 시작 때 자동으로 불러온 참고]\n${parts.join("\n\n")}\n${NOTE}`;
}

/** The first-request block: this folder's matches first, then a few from anywhere else. */
export function formatPrompt({ local = [], elsewhere = [] }) {
  const parts = [];
  if (local.length) parts.push(`이 폴더에서:\n${local.map((item) => line(item)).join("\n")}`);
  if (elsewhere.length) parts.push(`다른 곳에서:\n${elsewhere.map((item) => line(item, { withAgent: true })).join("\n")}`);
  if (!parts.length) return "";
  return `[Honcho 기억 · 이 요청과 관련된 지난 판단]\n${parts.join("\n")}\n${NOTE}`;
}

/** Choose decisions from recent sessions: judgment-like, newest first, no near-duplicates. */
export function pickDecisions(conclusions, limit = LIMITS.decisions) {
  const sorted = [...conclusions].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return dedupe(sorted.filter((item) => isJudgment(item.content))).slice(0, limit);
}

/**
 * Choose related judgments for a request. The server's relevance order is kept; only
 * judgment-like conclusions count, and what the session-start block already showed is left out.
 * Matches from this folder's sessions come first; the rest of memory adds a few more.
 */
export function pickRelated({ local = [], global = [] }, shownIds = [], limit = LIMITS.related) {
  const shown = new Set(shownIds);
  const usable = (items) => items.filter((item) => !shown.has(item.id) && isJudgment(item.content));
  const near = dedupe(usable(local)).slice(0, Math.max(0, limit - 2));
  const localSessions = new Set(local.map((item) => item.session_id));
  const far = dedupe(usable(global).filter((item) => !localSessions.has(item.session_id)), near).slice(0, limit - near.length);
  return { local: near, elsewhere: far };
}

export function substantivePrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text || text.startsWith("/")) return "";
  if (text.replace(/\s/g, "").length < LIMITS.minPromptChars) return "";
  return text;
}

// ------------------------------------------------------------------ Honcho

async function request(method, apiPath, { body, params } = {}) {
  const url = new URL(`${ROOT_URL}${apiPath}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchHoncho(url, {
      method,
      headers: honchoHeaders({ token: AUTH_TOKEN, access: ACCESS }, { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      debug(`${method} ${apiPath} → ${response.status}`);
      return null;
    }
    return await response.json().catch(() => null);
  } catch (error) {
    debug(`${method} ${apiPath} → ${error?.name || error}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const ws = () => encodeURIComponent(WORKSPACE);
const pair = { observer: USER_PEER, observed: USER_PEER };

async function sessionSummary(sessionId) {
  const data = await request("GET", `/v3/workspaces/${ws()}/sessions/${encodeURIComponent(sessionId)}/summaries`);
  const short = data?.short_summary;
  return short?.content ? { content: short.content, created_at: short.created_at || "" } : null;
}

async function sessionConclusions(sessionId) {
  const data = await request("POST", `/v3/workspaces/${ws()}/conclusions/list`, {
    params: { reverse: false, size: LIMITS.perSession },
    body: { filters: { ...pair, session_id: sessionId } },
  });
  return Array.isArray(data?.items) ? data.items : [];
}

async function queryConclusions(query, sessionIds = null) {
  const filters = sessionIds ? { ...pair, session_id: { in: sessionIds } } : pair;
  // Cosine distance. Checked 10/3: unrelated hits on a short question sat at 0.4–0.5, this folder's
  // relevant ones mostly under 0.55. So the rest of memory gets a strict cap, the folder a looser one.
  const distance = sessionIds ? LIMITS.localDistance : LIMITS.globalDistance;
  const data = await request("POST", `/v3/workspaces/${ws()}/conclusions/query`, {
    body: { query: clip(query, LIMITS.queryChars), top_k: 12, distance, filters },
  });
  return Array.isArray(data) ? data : [];
}

// ------------------------------------------------------------------ local state

async function readState() {
  try {
    const data = JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
    return data && typeof data === "object" && data.sessions ? data : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

async function writeState(state) {
  const entries = Object.entries(state.sessions).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
  const trimmed = { sessions: Object.fromEntries(entries.slice(0, LIMITS.keepSessions)) };
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(trimmed), "utf8");
  await fsp.rename(tmp, STATE_FILE);
}

/** Earlier Claude Code sessions of the same folder, newest first (their transcripts sit side by side). */
export async function earlierSessions(transcriptPath, limit = LIMITS.recentSessions) {
  if (!transcriptPath) return [];
  const dir = path.dirname(transcriptPath);
  const current = path.basename(transcriptPath);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") || name === current) continue;
    try {
      const stat = await fsp.stat(path.join(dir, name));
      files.push({ name, mtime: stat.mtimeMs });
    } catch {}
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((file) => sanitizeId(file.name.replace(/\.jsonl$/, ""), "claude"));
}

/** Resolves once the line is handed to the pipe, so exiting right after does not cut it off. */
function emit(eventName, text) {
  if (!text) return Promise.resolve();
  const data = `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } })}\n`;
  return new Promise((resolve) => process.stdout.write(data, () => resolve()));
}

async function onSessionStart(input) {
  if (input.source && !["startup", "clear"].includes(input.source)) return;
  const sessions = await earlierSessions(input.transcript_path);
  if (!sessions.length) return;
  const [summary, ...lists] = await Promise.all([sessionSummary(sessions[0]), ...sessions.map(sessionConclusions)]);
  const decisions = pickDecisions(lists.flat());
  const text = formatStart({ summary: summary?.content, summaryAt: summary?.created_at, decisions });
  await emit("SessionStart", text);
  if (input.session_id && decisions.length) {
    const state = await readState();
    state.sessions[input.session_id] = { ...(state.sessions[input.session_id] || {}), shown: decisions.map((item) => item.id), at: new Date().toISOString() };
    await writeState(state);
  }
}

async function onPrompt(input) {
  const prompt = substantivePrompt(input.prompt);
  if (!prompt || !input.session_id) return;
  const state = await readState();
  const entry = state.sessions[input.session_id] || {};
  if (entry.prompted) return;
  const sessions = await earlierSessions(input.transcript_path, LIMITS.folderSessions);
  const [local, global] = await Promise.all([sessions.length ? queryConclusions(prompt, sessions) : [], queryConclusions(prompt)]);
  await emit("UserPromptSubmit", formatPrompt(pickRelated({ local, global }, entry.shown || [])));
  state.sessions[input.session_id] = { ...entry, prompted: true, at: new Date().toISOString() };
  await writeState(state);
}

async function readInput() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function main() {
  const mode = process.argv[2];
  const input = await readInput();
  if (mode === "session-start") await onSessionStart(input);
  else if (mode === "prompt") await onPrompt(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const guard = setTimeout(() => process.exit(0), Number(process.env.HONCHO_RECALL_BUDGET_MS || "7000"));
  guard.unref();
  main().catch(() => {}).finally(() => process.exit(0));
}
