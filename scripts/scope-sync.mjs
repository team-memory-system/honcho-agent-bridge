// Keeps each opened project's Honcho scope filled with that project's conversations,
// on the computer that runs the server.
//
// A teammate's chat answers from one scope per project (the MCP bridge sends
// `scope`), so a project opened to someone must have its conversations in its scope.
// Every collector tags a session with its project (`project_id`, `project_name` in the
// session's metadata, projects.mjs), on whichever computer it ran; this adds the
// tagged sessions of every opened project to that project's scope, and only once
// each. Sessions sent before the tag existed are found once per project by their
// folder: inside the project's folder on this computer, or a folder of the same name
// elsewhere.
//
// Adding a session already in a scope does nothing in Honcho, and a session with
// messages is copied into the scope in the background (no LLM call), so running this
// again is cheap. What was added is kept in <dataDir>/state/scopes.json.
import fsp from "node:fs/promises";
import path from "node:path";

import { installPaths } from "./config.mjs";
import { configuredAccess, fetchHoncho, honchoHeaders } from "./honcho-access.mjs";
import { conversationProjects, PROJECT_SCOPE } from "./projects.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";

const PAGE_SIZE = 100;
const BATCH = 100;
const MAX_PAGES = 1_000;

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
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await call("POST", `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/list?page=${page}&size=${PAGE_SIZE}`, filters ? { filters } : {});
    const items = Array.isArray(data.items) ? data.items : [];
    onPage(items);
    if (items.length < PAGE_SIZE || (Number(data.pages) && page >= Number(data.pages))) break;
  }
}

/** The last part of a folder written on any computer: / or \\ as the separator. */
function folderName(folder) {
  return String(folder || "").replace(/[\\/]+$/, "").split(/[\\/]/).at(-1).toLowerCase();
}

/**
 * Fills the scope of every project in `projects` ([{ id, name }]) with its sessions.
 * Returns what each scope got this time.
 */
export async function syncScopes({ config, projects, fetchImpl, local } = {}) {
  const wanted = (Array.isArray(projects) ? projects : []).filter((item) => PROJECT_SCOPE.test(String(item?.id)));
  const workspace = String(config?.honcho?.workspaceId || "memory");
  const call = honchoClient(config, fetchImpl);
  const file = scopeStatePath(config);
  const state = await readState(file);
  // The folders of this computer's projects, by scope, for sessions sent before the tag.
  const here = local || (await conversationProjects({ config }).catch(() => ({ projects: [] }))).projects || [];
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
      const folders = here.filter((item) => item.scope === project.id).map((item) => path.resolve(item.path));
      const names = new Set([String(project.name || "").toLowerCase(), ...folders.map(folderName)].filter(Boolean));
      await sessionPages(call, workspace, null, (items) => {
        for (const item of items) {
          const metadata = item?.metadata || {};
          if (!item?.id || metadata.project_id) continue;
          const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
          if (!cwd) continue;
          const inside = folders.some((folder) => cwd === folder || cwd.startsWith(`${folder}${path.sep}`));
          if (inside || names.has(folderName(cwd))) found.add(item.id);
        }
      });
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
