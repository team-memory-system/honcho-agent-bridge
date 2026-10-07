// Where this computer's Claude Code and Codex conversations were held, grouped by
// project, for the app to offer as folders to send.
//
// Each transcript records the folder it was opened in (the collector keeps it as
// the session's `cwd`), and the nearest folder above it with a `.git` is taken as
// its project. Outside any repository, one-off folders count under the folder
// that holds them, so a thousand of them are one entry: anything in the system's
// temporary folder counts under it, and a folder whose name starts with a date
// counts under the folder above it (the Codex app opens a new
// ~/Documents/Codex/<YYYY-MM-DD>-<task> or <YYYY-MM-DD>/<task> for each task).
// `target backfill` finds transcripts with the same two functions below, so the
// list covers exactly the conversations a backfill would look at.
//
// Importing this module does nothing on its own.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { userHome } from "./config.mjs";

export async function walkFiles(root, accept, depth = Infinity) {
  const found = [];
  const stack = [{ directory: root, level: 0 }];
  while (stack.length) {
    const { directory, level } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && level + 1 < depth) stack.push({ directory: full, level: level + 1 });
      else if (entry.isFile() && accept(entry.name)) found.push(full);
    }
  }
  return found;
}

/** Where each agent keeps its transcripts on this computer. */
export async function transcriptFiles(config, provider) {
  if (provider === "codex") {
    const root = config?.sources?.codex?.root || path.join(userHome(), ".codex", "sessions");
    return walkFiles(root, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
  }
  // Claude Code: ~/.claude/projects/<project>/<session>.jsonl. Subagent transcripts
  // sit deeper and are not conversations of their own.
  const root = config?.sources?.claude?.root || path.join(userHome(), ".claude", "projects");
  return walkFiles(root, (name) => name.endsWith(".jsonl"), 2);
}

const PROVIDERS = ["claude", "codex"];
// A Claude transcript can open with a long summary line before the first one with a cwd.
const HEAD_BYTES = 512 * 1024;
const CHUNK_BYTES = 16 * 1024;
const CONCURRENCY = 16;
const NEWLINE = 0x0a;

// file path -> { size, mtimeMs, cwd }: a file that has not changed is not read again.
const headCache = new Map();

/** The folder a transcript line says the session ran in, if this line says so. */
function cwdFromLine(provider, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  // Codex: the session_meta line (codex.mjs). Claude Code: any line with a cwd (claude.mjs).
  const value = provider === "codex"
    ? (record.type === "session_meta" ? record.payload?.cwd : undefined)
    : record.cwd;
  return typeof value === "string" && value ? value : null;
}

/** The cwd from the first 512 KB of a transcript, reading no further than it takes to find it. */
async function readCwd(provider, file) {
  const handle = await fsp.open(file, "r");
  try {
    let pending = Buffer.alloc(0);
    let offset = 0;
    while (offset < HEAD_BYTES) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, HEAD_BYTES - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      let end;
      while ((end = pending.indexOf(NEWLINE, start)) !== -1) {
        const line = pending.toString("utf8", start, end).trim();
        start = end + 1;
        const cwd = line ? cwdFromLine(provider, line) : null;
        if (cwd) return cwd;
      }
      pending = pending.subarray(start);
    }
    // The last line: whole at the end of the file, or cut at 512 KB and then not JSON.
    const rest = pending.toString("utf8").trim();
    return rest ? cwdFromLine(provider, rest) : null;
  } finally {
    await handle.close();
  }
}

/** `{ cwd, mtimeMs }` for one transcript, or null for one that is gone. */
async function transcriptCwd(provider, file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }
  const cached = headCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return { cwd: cached.cwd, mtimeMs: stat.mtimeMs };
  let cwd;
  try {
    cwd = await readCwd(provider, file);
  } catch {
    // Unreadable now; tried again next time.
    return { cwd: null, mtimeMs: stat.mtimeMs };
  }
  headCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, cwd });
  return { cwd, mtimeMs: stat.mtimeMs };
}

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Sessions run by automation (codex.mjs classifyAutomation), not by someone at a project. */
function automationCwd(cwd) {
  return cwd === "/" || cwd.replace(/\\/g, "/").includes("/.symphony/workspaces/");
}

async function isDirectory(target) {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function hasGit(directory) {
  try {
    await fsp.lstat(path.join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** The folder above the first folder in `cwd` whose name starts with a date (YYYY-MM-DD), or null. */
export function datedParent(cwd) {
  const match = /^(.*?)[\\/]\d{4}-\d{2}-\d{2}(?!\d)/.exec(cwd);
  return match && match[1] && !/^[A-Za-z]:$/.test(match[1]) ? match[1] : null;
}

const within = (child, parent) => child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

/**
 * The system's temporary folders as `[name, folder]` pairs, longest name first:
 * each folder under the name it may be written as (/tmp is /private/tmp on a Mac).
 * One that holds `home` is left out, so a home inside it is read as usual.
 */
export function systemTempFolders(home) {
  const pairs = new Map();
  for (const name of new Set(["/tmp", "/var/tmp", os.tmpdir()])) {
    if (!path.isAbsolute(name) || path.parse(name).root === name) continue;
    let folder = name;
    try {
      folder = fs.realpathSync(name);
    } catch {
      continue;
    }
    if (home === folder || within(home, folder)) continue;
    pairs.set(name, folder);
    pairs.set(folder, folder);
  }
  return [...pairs].sort((left, right) => right[0].length - left[0].length);
}

/** The temporary folder `cwd` is inside, as its real path, or null. */
function tempParent(cwd, temps) {
  for (const [name, folder] of temps) if (within(cwd, name)) return folder;
  return null;
}

/** The nearest folder at or above `directory` that holds a `.git`, or null. */
async function gitRoot(directory, memo) {
  const visited = [];
  let current = directory;
  let found = null;
  for (;;) {
    if (memo.has(current)) {
      found = memo.get(current);
      break;
    }
    visited.push(current);
    if (await hasGit(current)) {
      found = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const seen of visited) memo.set(seen, found);
  return found;
}

/**
 * The project a session's folder belongs to, by the rule the list below uses: its
 * repository's root, else the folder that holds one-off folders, else the folder.
 * null for no folder, or one only automation runs in.
 */
export async function projectFolder(cwd, { home = userHome(), temps = systemTempFolders(path.resolve(home)), memo = new Map() } = {}) {
  if (typeof cwd !== "string" || !cwd || !path.isAbsolute(cwd) || automationCwd(cwd)) return null;
  const folder = path.resolve(cwd);
  const root = (await isDirectory(folder)) ? await gitRoot(folder, memo) : null;
  return root || tempParent(folder, temps) || datedParent(folder) || folder;
}

/**
 * A remote's address as the same repository reads on every computer: no scheme,
 * user, port, `.git` or trailing slash, lower case. `git@host:owner/repo.git` and
 * `https://host/owner/repo` are both `host/owner/repo`.
 */
export function normalizeRemote(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw);
  let host;
  let rest;
  if (scp) {
    [, host, rest] = scp;
  } else {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "file:") return null;
      host = parsed.hostname;
      rest = parsed.pathname;
    } catch {
      return null;
    }
  }
  const pathPart = rest.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return host && pathPart ? `${host}/${pathPart}`.toLowerCase() : null;
}

/** The git config of the repository at `root`, following a worktree's or a submodule's `.git` file. */
async function gitConfigFile(root) {
  const dotGit = path.join(root, ".git");
  let stat;
  try { stat = await fsp.lstat(dotGit); } catch { return null; }
  if (stat.isDirectory()) return path.join(dotGit, "config");
  const text = await fsp.readFile(dotGit, "utf8").catch(() => "");
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!gitdir) return null;
  const directory = path.resolve(root, gitdir);
  const common = (await fsp.readFile(path.join(directory, "commondir"), "utf8").catch(() => "")).trim();
  return path.join(common ? path.resolve(directory, common) : directory, "config");
}

/** The repository's `origin` remote at `root`, normalized, or null. */
export async function gitRemote(root) {
  const file = await gitConfigFile(root);
  if (!file) return null;
  const text = await fsp.readFile(file, "utf8").catch(() => "");
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (section) { inOrigin = section[1] === "origin"; continue; }
    if (/^\s*\[/.test(line)) { inOrigin = false; continue; }
    const url = inOrigin && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url) return normalizeRemote(url[1]);
  }
  return null;
}

/** A project's scope id: `p-` and 12 hex. */
export const PROJECT_SCOPE = /^p-[0-9a-f]{12}$/;

/**
 * The Honcho scope a project's conversations go to when its owner opens it to a
 * teammate: `p-` and 12 hex of a hash of the repository's origin remote, so a
 * repository has the same scope on every computer that cloned it. A folder with no
 * remote is known by its name.
 */
export async function projectScope(projectPath) {
  const name = path.basename(projectPath) || projectPath;
  const remote = await gitRemote(projectPath);
  const key = remote ? `git:${remote}` : `name:${name.toLowerCase()}`;
  return { id: `p-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`, name };
}

/**
 * This computer's conversation projects, newest first:
 * `{ ok: true, projects: [{ path, name, sessions, lastAt, agents: { claude, codex }, exists, git, folded, folders, temp }], scanned, withoutFolder }`.
 * `git` is a repository root, `folded` a folder that holds one-off folders,
 * `folders` how many distinct folders the sessions were opened in, and `temp` a
 * temporary folder of the system's. The `temp` option stands in for those
 * (systemTempFolders).
 */
export async function conversationProjects({ config, home: given, temp } = {}) {
  const home = path.resolve(given || userHome());
  const temps = temp || systemTempFolders(home);
  // The same roots `target backfill` reads, with `home` standing in for this user's.
  const sources = {
    claude: { root: config?.sources?.claude?.root || path.join(home, ".claude", "projects") },
    codex: { root: config?.sources?.codex?.root || path.join(home, ".codex", "sessions") },
  };
  const transcripts = [];
  for (const provider of PROVIDERS) {
    for (const file of await transcriptFiles({ sources }, provider)) transcripts.push({ provider, file });
  }
  const heads = await mapLimit(transcripts, CONCURRENCY, ({ provider, file }) => transcriptCwd(provider, file));

  let scanned = 0;
  let withoutFolder = 0;
  const byCwd = new Map();
  transcripts.forEach(({ provider }, index) => {
    const head = heads[index];
    if (!head) return;
    scanned += 1;
    const { cwd, mtimeMs } = head;
    if (!cwd || !path.isAbsolute(cwd)) {
      withoutFolder += 1;
      return;
    }
    if (automationCwd(cwd)) return;
    const key = path.resolve(cwd);
    const entry = byCwd.get(key) || { sessions: [] };
    entry.sessions.push({ provider, mtimeMs });
    byCwd.set(key, entry);
  });

  const memo = new Map();
  const projects = new Map();
  for (const [cwd, { sessions }] of byCwd) {
    const exists = await isDirectory(cwd);
    const root = exists ? await gitRoot(cwd, memo) : null;
    const holder = root ? null : tempParent(cwd, temps) || datedParent(cwd);
    const projectPath = root || holder || cwd;
    let project = projects.get(projectPath);
    if (!project) {
      project = {
        path: projectPath,
        name: projectPath === home ? "~" : path.basename(projectPath) || projectPath,
        sessions: 0,
        lastMs: 0,
        agents: { claude: 0, codex: 0 },
        exists: holder ? await isDirectory(holder) : exists,
        git: Boolean(root),
        folded: false,
        folders: 0,
      };
    }
    // The holder may have been opened itself too, before or after what it holds.
    if (holder) project.folded = true;
    project.folders += 1;
    for (const session of sessions) {
      project.sessions += 1;
      project.agents[session.provider] += 1;
      project.lastMs = Math.max(project.lastMs, session.mtimeMs);
    }
    projects.set(projectPath, project);
  }

  const sorted = [...projects.values()]
    .sort((left, right) => right.lastMs - left.lastMs || left.path.localeCompare(right.path));
  const scopes = await mapLimit(sorted, CONCURRENCY, (project) => projectScope(project.path));
  const list = sorted.map((project, index) => ({
    path: project.path,
    name: project.name,
    sessions: project.sessions,
    lastAt: new Date(project.lastMs).toISOString(),
    agents: project.agents,
    exists: project.exists,
    git: project.git,
    folded: project.folded,
    folders: project.folders,
    temp: temps.some(([, folder]) => folder === project.path),
    // The scope the project's conversations go to when it is opened to a teammate.
    scope: scopes[index].id,
  }));
  return { ok: true, projects: list, scanned, withoutFolder };
}
