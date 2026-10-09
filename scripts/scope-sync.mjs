// Keeps each opened project's Honcho scope filled with that project's conversations,
// on the computer that runs the server.
//
// A teammate's chat answers from one scope per project (the MCP bridge sends
// `scope`), so a project opened to someone must have its conversations in its scope.
// Every collector tags a session with its project (`project_id`, `project_name` in the
// session's metadata, projects.mjs), on whichever computer it ran; this adds the
// tagged sessions of every opened project to that project's scope, and only once
// each. A session sent before the tag existed goes, once, to the one project its
// folder belongs to: on this computer the project projects.mjs makes of that folder,
// never one in a folder above it (the home folder, ~/dev), and from another computer
// the project of that folder's name.
//
// Adding a session already in a scope does nothing in Honcho, and a session with
// messages is copied into the scope in the background (no LLM call), so running this
// again is cheap. What was added is kept in <dataDir>/state/scopes.json.
//
// The window that opens projects to a teammate lists what this would fill: the
// projects the server holds sessions of, by the same two rules (serverProjects).
import fsp from "node:fs/promises";
import path from "node:path";

import { installPaths, userHome } from "./config.mjs";
import { configuredAccess, fetchHoncho, honchoHeaders } from "./honcho-access.mjs";
import { conversationProjects, datedParent, PROJECT_SCOPE, projectFolder, systemTempFolders } from "./projects.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";

const PAGE_SIZE = 100;
const BATCH = 100;
const MAX_PAGES = 1_000;
// Pages of a listing asked at once, once the first has said how many there are.
const PARALLEL = 4;

export function scopeStatePath(config) {
  return path.join(installPaths(config).dataDir, "state", "scopes.json");
}

async function readState(file) {
  try {
    const value = JSON.parse(await fsp.readFile(file, "utf8"));
    if (value?.scopes && typeof value.scopes === "object") return value;
  } catch {}
  return { version: 1, scopes: {} };
}

function honchoClient(config, fetchImpl) {
  const base = String(config?.honcho?.baseUrl || "http://127.0.0.1:8001").replace(/\/+$/, "");
  const headers = honchoHeaders({ token: config?.honcho?.apiToken, access: configuredAccess(config) }, { "Content-Type": "application/json", Accept: "application/json" });
  return async (method, apiPath, body) => {
    const response = await (fetchImpl || fetchHoncho)(`${base}${apiPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${apiPath}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
}

async function sessionPages(call, workspace, filters, onPage) {
  const listing = async (page) => {
    const data = await call("POST", `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/list?page=${page}&size=${PAGE_SIZE}`, filters ? { filters } : {});
    const items = Array.isArray(data.items) ? data.items : [];
    onPage(items);
    return { items, pages: Number(data.pages) || 0 };
  };
  const first = await listing(1);
  if (first.items.length < PAGE_SIZE) return;
  if (first.pages) {
    // A server with thousands of sessions: the rest a few pages at a time.
    const last = Math.min(first.pages, MAX_PAGES);
    let next = 2;
    const worker = async () => {
      while (next <= last) {
        const page = next;
        next += 1;
        await listing(page);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return;
  }
  for (let page = 2; page <= MAX_PAGES; page += 1) {
    if ((await listing(page)).items.length < PAGE_SIZE) break;
  }
}

/** The last part of a folder written on any computer: / or \\ as the separator. */
function folderName(folder) {
  return String(folder || "").replace(/[\\/]+$/, "").split(/[\\/]/).at(-1).toLowerCase();
}

/** The folder a session sent before the tag ran in, or "" for a tagged one or one with no folder. */
function untaggedCwd(item) {
  const metadata = item?.metadata || {};
  if (!item?.id || metadata.project_id) return "";
  return typeof metadata.cwd === "string" ? metadata.cwd : "";
}

/**
 * The one project a session sent before the tag belongs to, by the folder it ran in
 * (`cwd`): the project projects.mjs makes of that folder (its repository, else the
 * folder that holds one-off folders, else the folder) when this computer has it
 * (`here`, conversationProjects); otherwise, as for a folder on another computer,
 * this computer's project of that folder's name, else one of `projects`
 * ([{ id, name }]) of that name. Never a project in a folder above it, so the home
 * folder's project gets only what ran in the home folder itself.
 * Returns `async cwd => id or null`.
 */
function legacyMatcher(projects, here, { home } = {}) {
  const root = path.resolve(home || userHome());
  const options = { home: root, temps: systemTempFolders(root), memo: new Map() };
  const byFolder = new Map();
  const byName = new Map();
  for (const item of here) {
    if (!item.scope) continue;
    const folder = path.resolve(item.path);
    if (!byFolder.has(folder)) byFolder.set(folder, item.scope);
  }
  // A name is this computer's folder of it first (`here` is newest first), then a project's own.
  for (const item of here) if (item.scope && !byName.has(folderName(item.path))) byName.set(folderName(item.path), item.scope);
  for (const project of projects) {
    const name = String(project.name || "").toLowerCase();
    if (name && !byName.has(name)) byName.set(name, project.id);
  }
  const known = new Map();
  const owner = async (cwd) => {
    // A path of another system (C:\… read on a Mac) is known by its name alone.
    if (!path.isAbsolute(cwd)) return byName.get(folderName(datedParent(cwd) || cwd)) || null;
    const folder = await projectFolder(cwd, options).catch(() => null);
    if (!folder) return null;
    return byFolder.get(folder) || byName.get(folderName(folder)) || null;
  };
  return (cwd) => {
    if (!known.has(cwd)) known.set(cwd, owner(cwd));
    return known.get(cwd);
  };
}

/** This computer's conversation projects, or none when they cannot be read. */
async function localProjects(config, home) {
  return (await conversationProjects({ config, home }).catch(() => ({ projects: [] }))).projects || [];
}

/**
 * Fills the scope of every project in `projects` ([{ id, name }]) with its sessions.
 * Returns what each scope got this time.
 */
export async function syncScopes({ config, projects, fetchImpl, local, home } = {}) {
  const wanted = (Array.isArray(projects) ? projects : []).filter((item) => PROJECT_SCOPE.test(String(item?.id)));
  const workspace = String(config?.honcho?.workspaceId || "memory");
  const call = honchoClient(config, fetchImpl);
  const file = scopeStatePath(config);
  const state = await readState(file);
  // The folders of this computer's projects, by scope, for sessions sent before the tag.
  const here = local || await localProjects(config, home);
  // Each of those sessions has one owner among every project opened, so they are
  // listed once, for the first project that has not looked for them yet.
  const belongs = legacyMatcher(wanted, here, { home });
  let untagged = null;
  const earlier = async () => {
    if (!untagged) {
      const listed = [];
      await sessionPages(call, workspace, null, (items) => {
        for (const item of items) {
          const cwd = untaggedCwd(item);
          if (cwd) listed.push({ id: item.id, cwd });
        }
      });
      // Each folder is read once, many at a time.
      await Promise.all([...new Set(listed.map((item) => item.cwd))].map(belongs));
      untagged = listed;
    }
    return untagged;
  };
  const results = [];
  for (const project of wanted) {
    const entry = state.scopes[project.id] || { name: project.name, added: [], legacyScanned: false };
    const added = new Set(entry.added);
    await call("POST", `/v3/workspaces/${encodeURIComponent(workspace)}/scopes`, { id: project.id, metadata: { name: project.name } });
    const found = new Set();
    await sessionPages(call, workspace, { metadata: { project_id: project.id } }, (items) => {
      for (const item of items) if (item?.id) found.add(item.id);
    });
    if (!entry.legacyScanned) {
      for (const { id, cwd } of await earlier()) if ((await belongs(cwd)) === project.id) found.add(id);
      entry.legacyScanned = true;
    }
    const fresh = [...found].filter((id) => !added.has(id));
    for (let index = 0; index < fresh.length; index += BATCH) {
      const batch = fresh.slice(index, index + BATCH);
      await call("POST", `/v3/workspaces/${encodeURIComponent(workspace)}/scopes/${encodeURIComponent(project.id)}/sessions`, { session_ids: batch });
      for (const id of batch) added.add(id);
    }
    state.scopes[project.id] = { name: project.name, added: [...added], legacyScanned: entry.legacyScanned, syncedAt: new Date().toISOString() };
    results.push({ id: project.id, name: project.name, added: fresh.length, sessions: added.size });
  }
  await writePrivateFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  return { ok: true, workspace, scopes: results };
}

/**
 * Waits until Honcho has copied what the sessions added to scope `id` already hold
 * (GET …/scopes/<id>/status: no session's copy still pending), up to `timeoutMs`.
 * A scope just filled answers from what is copied so far; this is for the one
 * question asked right after (가드 시험). Returns whether nothing is pending.
 */
export async function scopeSettled({ config, id, timeoutMs = 60_000, intervalMs = 1_500, fetchImpl, wait } = {}) {
  if (!PROJECT_SCOPE.test(String(id))) return false;
  const workspace = String(config?.honcho?.workspaceId || "memory");
  const call = honchoClient(config, fetchImpl);
  const pause = wait || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = await call("GET", `/v3/workspaces/${encodeURIComponent(workspace)}/scopes/${encodeURIComponent(id)}/status`);
    const jobs = Object.values(status?.backfill_status || {});
    if (!jobs.some((job) => job?.state === "pending")) return true;
    if (Date.now() >= until) return false;
    await pause(intervalMs);
  }
}

/**
 * The projects this server holds sessions of, as `syncScopes` would fill their
 * scopes, newest first: `{ ok: true, workspace, projects: [{ id, name, sessions,
 * lastAt, folder }] }`. A project's sessions are the ones tagged with it and the ones
 * sent before the tag that belong to it (legacyMatcher), among the tagged projects and
 * this computer's; one listing of the workspace answers it. `keep` ([{ id, name }], what
 * is open to someone now) stays in the list with none. `lastAt` is when the newest
 * of them last got a turn, and `folder` the project's folder on this computer, else
 * the one its newest session ran in.
 */
export async function serverProjects({ config, keep = [], fetchImpl, local, home } = {}) {
  const workspace = String(config?.honcho?.workspaceId || "memory");
  const call = honchoClient(config, fetchImpl);
  const sessions = new Map();
  const [here] = await Promise.all([
    local || localProjects(config, home),
    sessionPages(call, workspace, null, (items) => {
      for (const item of items) if (item?.id) sessions.set(item.id, item);
    }),
  ]);
  const projects = new Map();
  const project = (id) => {
    if (!projects.has(id)) projects.set(id, { id, tagged: "", sessions: 0, lastMs: 0, cwd: "" });
    return projects.get(id);
  };
  const count = (entry, item) => {
    const metadata = item.metadata || {};
    const at = Date.parse(metadata.last_imported_at) || Date.parse(item.created_at) || 0;
    entry.sessions += 1;
    if (at < entry.lastMs) return;
    entry.lastMs = at;
    if (typeof metadata.cwd === "string" && metadata.cwd) entry.cwd = metadata.cwd;
    if (typeof metadata.project_name === "string" && metadata.project_name) entry.tagged = metadata.project_name;
  };
  const untagged = [];
  for (const item of sessions.values()) {
    const id = item.metadata?.project_id;
    if (PROJECT_SCOPE.test(String(id))) count(project(id), item);
    else if (untaggedCwd(item)) untagged.push(item);
  }
  // Every project a session sent before the tag could belong to: the tagged ones,
  // this computer's and the ones kept, each under the name syncScopes would get.
  const kept = new Map(keep.filter((item) => PROJECT_SCOPE.test(String(item?.id))).map((item) => [item.id, String(item.name || "")]));
  // This computer's newest folder of each project (`here` is newest first).
  const mine = new Map();
  for (const item of here) if (item.scope && !mine.has(item.scope)) mine.set(item.scope, item);
  for (const id of [...mine.keys(), ...kept.keys()]) project(id);
  const named = [...projects.values()].map((entry) => ({ id: entry.id, name: kept.get(entry.id) || mine.get(entry.id)?.name || entry.tagged || entry.id }));
  const belongs = legacyMatcher(named, here, { home });
  await Promise.all([...new Set(untagged.map(untaggedCwd))].map(belongs));
  for (const item of untagged) {
    const id = await belongs(untaggedCwd(item));
    if (id && projects.has(id)) count(projects.get(id), item);
  }
  const list = named
    .map(({ id, name }) => ({ ...projects.get(id), name }))
    .filter((entry) => entry.sessions > 0 || kept.has(entry.id))
    .sort((left, right) => right.lastMs - left.lastMs || left.name.localeCompare(right.name))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      sessions: entry.sessions,
      lastAt: entry.lastMs ? new Date(entry.lastMs).toISOString() : null,
      folder: mine.get(entry.id)?.path || entry.cwd || null,
    }));
  return { ok: true, workspace, projects: list };
}
