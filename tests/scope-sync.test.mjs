// Filling the scope of each project opened to a teammate. What matters: a session
// the collector tagged with the project goes in, so do the project's sessions sent
// before the tag (by their folder's project here, or a folder of the same name
// elsewhere), each to one project only, never to one in a folder above it; nothing
// else does, and a second run sends only what is new. The window that opens projects
// lists exactly the ones the server would fill, with what they would get.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scopeSettled, scopeStatePath, serverProjects, syncScopes } from "../scripts/scope-sync.mjs";

const HONCHO = { id: "p-0123456789ab", name: "honcho" };
const OTHER = { id: "p-abcdef012345", name: "web-app" };

function fakeHoncho(sessions) {
  const scopes = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push(`${init.method || "GET"} ${target.pathname}`);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    let match = /^\/v3\/workspaces\/memory\/scopes$/.exec(target.pathname);
    if (match) {
      if (!scopes.has(body.id)) scopes.set(body.id, new Set());
      return json({ id: body.id, metadata: body.metadata || {} }, 201);
    }
    match = /^\/v3\/workspaces\/memory\/scopes\/([^/]+)\/sessions$/.exec(target.pathname);
    if (match) {
      const scope = scopes.get(decodeURIComponent(match[1]));
      if (!scope) return json({ detail: "Scope not found" }, 404);
      assert.ok(body.session_ids.length <= 100, "a batch is at most 100");
      for (const id of body.session_ids) scope.add(id);
      return new Response(null, { status: 204 });
    }
    if (target.pathname === "/v3/workspaces/memory/sessions/list") {
      const page = Number(target.searchParams.get("page"));
      const size = Number(target.searchParams.get("size"));
      const wanted = body.filters?.metadata?.project_id;
      const items = sessions.filter((session) => !wanted || session.metadata?.project_id === wanted);
      return json({ items: items.slice((page - 1) * size, page * size), total: items.length, page, size, pages: Math.max(1, Math.ceil(items.length / size)) });
    }
    return json({ detail: "not found" }, 404);
  };
  return { fetchImpl, scopes, calls };
}

async function tempConfig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-sync-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { version: 1, honcho: { baseUrl: "http://honcho.test", workspaceId: "memory" }, paths: { dataDir: path.join(dir, "data") } };
}

/** A home folder on disk (its real path), for the folders sessions ran in to be read as projects. */
async function tempHome(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "scope-sync-home-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  return home;
}

/** A repository at `folder`, with the folders inside it named in `inside`. */
async function repository(folder, ...inside) {
  await fs.mkdir(path.join(folder, ".git"), { recursive: true });
  for (const name of inside) await fs.mkdir(path.join(folder, name), { recursive: true });
  return folder;
}

test("an opened project's scope gets its tagged sessions and its earlier ones, once each", async (t) => {
  const config = await tempConfig(t);
  const home = await tempHome(t);
  const here = await repository(path.join(home, "dev", "honcho"), "server");
  const sessions = [
    { id: "tagged", metadata: { project_id: HONCHO.id, cwd: "/elsewhere" } },
    { id: "here-before-tags", metadata: { cwd: path.join(here, "server") } },
    { id: "same-name-other-computer", metadata: { cwd: "C:\\Users\\x\\dev\\Honcho" } },
    { id: "unrelated", metadata: { cwd: "/Users/me/dev/notes" } },
    { id: "other-project", metadata: { project_id: OTHER.id, cwd: path.join(here, "x") } },
    { id: "no-folder", metadata: {} },
  ];
  // Enough sessions to need a second page of the listing.
  for (let index = 0; index < 150; index += 1) sessions.push({ id: `bulk-${index}`, metadata: { project_id: HONCHO.id } });
  const fake = fakeHoncho(sessions);
  const local = [{ path: here, name: "honcho", scope: HONCHO.id }];

  const first = await syncScopes({ config, projects: [HONCHO, { id: "bad", name: "x" }], fetchImpl: fake.fetchImpl, local, home });
  assert.equal(first.ok, true);
  assert.equal(first.scopes.length, 1, "only a real scope id is synced");
  const members = fake.scopes.get(HONCHO.id);
  assert.ok(members.has("tagged"));
  assert.ok(members.has("here-before-tags"));
  assert.ok(members.has("same-name-other-computer"));
  assert.ok(!members.has("unrelated"));
  assert.ok(!members.has("other-project"), "a session tagged with another project stays out");
  assert.ok(!members.has("no-folder"));
  assert.equal(members.size, 153);
  assert.equal(first.scopes[0].added, 153);

  // Again: the earlier sessions are not looked for twice, and nothing is sent twice.
  sessions.push({ id: "new-turn", metadata: { project_id: HONCHO.id } });
  fake.calls.length = 0;
  const second = await syncScopes({ config, projects: [HONCHO], fetchImpl: fake.fetchImpl, local, home });
  assert.equal(second.scopes[0].added, 1);
  assert.equal(fake.calls.filter((call) => call.endsWith("/sessions/list")).length, 2, "two pages of the tagged listing, no full scan");
  const state = JSON.parse(await fs.readFile(scopeStatePath(config), "utf8"));
  assert.equal(state.scopes[HONCHO.id].legacyScanned, true);
  assert.equal(state.scopes[HONCHO.id].added.length, 154);
});

test("nothing opened, nothing asked", async (t) => {
  const config = await tempConfig(t);
  const fake = fakeHoncho([]);
  const result = await syncScopes({ config, projects: [], fetchImpl: fake.fetchImpl, local: [] });
  assert.deepEqual(result.scopes, []);
  assert.deepEqual(fake.calls, []);
});

test("the projects to open are the server's, counted as their scopes would fill, newest first", async (t) => {
  const config = await tempConfig(t);
  const home = await tempHome(t);
  const here = await repository(path.join(home, "dev", "honcho"), "server");
  const IDLE = { id: "p-111111111111", name: "idle" };
  const KEPT = { id: "p-222222222222", name: "kept" };
  const sessions = [
    { id: "tagged", metadata: { project_id: HONCHO.id, project_name: "honcho", cwd: "/elsewhere/honcho", last_imported_at: "2026-10-01T00:00:00.000Z" } },
    { id: "here-before-tags", metadata: { cwd: path.join(here, "server"), last_imported_at: "2026-09-01T00:00:00.000Z" } },
    { id: "same-name-other-computer", metadata: { cwd: "C:\\Users\\x\\dev\\Honcho" } },
    { id: "only-on-another-computer", metadata: { project_id: OTHER.id, project_name: "web-app", cwd: "/home/kim/dev/web-app/src", last_imported_at: "2026-10-05T00:00:00.000Z" } },
    { id: "unrelated", metadata: { cwd: "/Users/me/dev/notes" } },
    { id: "automation", metadata: { cwd: "/" } },
    { id: "no-folder", metadata: {} },
    { id: "odd-tag", metadata: { project_id: "x", cwd: path.join(here, "y") } },
  ];
  for (let index = 0; index < 250; index += 1) {
    sessions.push({ id: `bulk-${index}`, created_at: "2026-08-01T00:00:00Z", metadata: { project_id: HONCHO.id, project_name: "honcho" } });
  }
  const fake = fakeHoncho(sessions);
  // This computer's projects: one with sessions on the server, one with none there.
  const local = [{ path: here, name: "honcho", scope: HONCHO.id }, { path: path.join(home, "dev", "idle"), name: "idle", scope: IDLE.id }];

  const listed = await serverProjects({ config, keep: [KEPT, { id: "bad", name: "x" }], fetchImpl: fake.fetchImpl, local, home });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.projects.map((project) => [project.id, project.name, project.sessions, project.lastAt, project.folder]), [
    [OTHER.id, "web-app", 1, "2026-10-05T00:00:00.000Z", "/home/kim/dev/web-app/src"],
    [HONCHO.id, "honcho", 253, "2026-10-01T00:00:00.000Z", here],
    [KEPT.id, "kept", 0, null, null],
  ], "the idle project has nothing on the server; the kept one stays with none");
  assert.equal(fake.calls.filter((call) => call.endsWith("/sessions/list")).length, 3, "one listing of the workspace");
  assert.equal(fake.scopes.size, 0, "listing makes no scope");

  // What the window shows is what opening those projects puts in their scopes.
  await syncScopes({ config, projects: listed.projects, fetchImpl: fake.fetchImpl, local, home });
  for (const project of listed.projects) assert.equal(fake.scopes.get(project.id).size, project.sessions, project.name);
});

test("a session sent before the tag goes to its own folder's project only, never to one in a folder above it", async (t) => {
  const config = await tempConfig(t);
  const home = await tempHome(t);
  const repo = await repository(path.join(home, "dev", "repo"), "src");
  await fs.mkdir(path.join(home, "notes"));
  // This computer's projects: the home folder itself ("~") and a repository inside it.
  const HOME = { id: "p-333333333333", name: "~" };
  const REPO = { id: "p-444444444444", name: "repo" };
  const local = [{ path: home, name: "~", scope: HOME.id }, { path: repo, name: "repo", scope: REPO.id }];
  const sessions = [
    { id: "in-the-repo", metadata: { cwd: path.join(repo, "src") } },
    { id: "at-the-repo", metadata: { cwd: repo } },
    { id: "in-home", metadata: { cwd: home } },
    { id: "in-a-plain-folder-under-home", metadata: { cwd: path.join(home, "notes") } },
    { id: "repo-on-another-computer", metadata: { cwd: "/Users/kim/dev/repo" } },
    { id: "inside-it-on-another-computer", metadata: { cwd: "/Users/kim/dev/repo/src" } },
  ];
  const fake = fakeHoncho(sessions);

  const listed = await serverProjects({ config, fetchImpl: fake.fetchImpl, local, home });
  assert.deepEqual(listed.projects.map((project) => [project.name, project.sessions]).sort(), [["repo", 3], ["~", 1]]);

  // Opening the home folder's project gives it what ran in the home folder and nothing under it.
  await syncScopes({ config, projects: [HOME], fetchImpl: fake.fetchImpl, local, home });
  assert.deepEqual([...fake.scopes.get(HOME.id)], ["in-home"]);
  await syncScopes({ config, projects: [REPO], fetchImpl: fake.fetchImpl, local, home });
  assert.deepEqual([...fake.scopes.get(REPO.id)].sort(), ["at-the-repo", "in-the-repo", "repo-on-another-computer"]);
});

test("a server that cannot be read is an error, not an empty list", async (t) => {
  const config = await tempConfig(t);
  const fetchImpl = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };
  await assert.rejects(serverProjects({ config, fetchImpl, local: [] }), /fetch failed/);
});

test("a scope just filled is waited on until Honcho has copied its sessions, or until the time is up", async (t) => {
  const config = await tempConfig(t);
  const answers = [
    { backfill_status: { s1: { state: "pending" }, s2: { state: "completed", docs_copied: 4 } } },
    { backfill_status: { s1: { state: "pending" }, s2: { state: "completed", docs_copied: 4 } } },
    { backfill_status: { s1: { state: "completed", docs_copied: 2 }, s2: { state: "completed", docs_copied: 4 } } },
  ];
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push(`${init.method || "GET"} ${new URL(url).pathname}`);
    return new Response(JSON.stringify(answers[Math.min(asked.length - 1, answers.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const waits = [];
  assert.equal(await scopeSettled({ config, id: HONCHO.id, fetchImpl, wait: async (ms) => { waits.push(ms); } }), true);
  assert.deepEqual(asked, Array(3).fill(`GET /v3/workspaces/memory/scopes/${HONCHO.id}/status`));
  assert.deepEqual(waits, [1_500, 1_500]);

  // Still copying when the time is up: false, and the trial runs on what is there.
  const stuck = async () => new Response(JSON.stringify(answers[0]), { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await scopeSettled({ config, id: HONCHO.id, fetchImpl: stuck, timeoutMs: 0, wait: async () => {} }), false);
  // A scope with nothing to copy is settled at once; a name that is no project's is never asked.
  const empty = async () => new Response(JSON.stringify({ backfill_status: {} }), { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await scopeSettled({ config, id: HONCHO.id, fetchImpl: empty }), true);
  assert.equal(await scopeSettled({ config, id: "memory", fetchImpl: async () => assert.fail("asked") }), false);
});
