// Filling the scope of each project opened to a teammate. What matters: a session
// the collector tagged with the project goes in, so do the project's sessions sent
// before the tag (by their folder here, or a folder of the same name elsewhere),
// nothing else does, and a second run sends only what is new.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scopeStatePath, syncScopes } from "../scripts/scope-sync.mjs";

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

test("an opened project's scope gets its tagged sessions and its earlier ones, once each", async (t) => {
  const config = await tempConfig(t);
  const here = path.join(os.tmpdir(), "dev", "honcho");
  const sessions = [
    { id: "tagged", metadata: { project_id: HONCHO.id, cwd: "/elsewhere" } },
    { id: "here-before-tags", metadata: { cwd: path.join(here, "server") } },
    { id: "same-name-other-computer", metadata: { cwd: "C:\\Users\\x\\dev\\Honcho" } },
    { id: "unrelated", metadata: { cwd: "/home/me/dev/notes" } },
    { id: "other-project", metadata: { project_id: OTHER.id, cwd: path.join(here, "x") } },
    { id: "no-folder", metadata: {} },
  ];
  // Enough sessions to need a second page of the listing.
  for (let index = 0; index < 150; index += 1) sessions.push({ id: `bulk-${index}`, metadata: { project_id: HONCHO.id } });
  const fake = fakeHoncho(sessions);
  const local = [{ path: here, name: "honcho", scope: HONCHO.id }];

  const first = await syncScopes({ config, projects: [HONCHO, { id: "bad", name: "x" }], fetchImpl: fake.fetchImpl, local });
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
  const second = await syncScopes({ config, projects: [HONCHO], fetchImpl: fake.fetchImpl, local });
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
