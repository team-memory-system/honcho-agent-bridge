// `team make` against a local fake of Cloudflare, the Workers calls of the deploy
// answered by a stand-in: beside the hub's Access app it opens <hub>/guard alone
// behind the bypass policy, keeps both ids in team-access.json, and a second run
// finds the same apps again instead of making new ones.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BYPASS_POLICY_NAME, EVERYONE_POLICY_NAME, hubAppBody, hubGuardAppBody } from "../scripts/cloudflare-api.mjs";
import { teamMake } from "../scripts/team-hub.mjs";
import { API_TOKEN, startFakeCloudflare, ZONE } from "./fake-cloudflare.mjs";

const HUB_HOST = `team.${ZONE}`;
const GOOGLE_IDP = "idp-google-0001";

async function makeFixture(t) {
  const cf = await startFakeCloudflare();
  t.after(() => cf.close());
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "team-make-"));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const workers = [];
  // The fake knows Access, zones and tunnels; the deploy's Workers calls stop here.
  const cloudflareFetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (!pathname.includes("/workers/")) return fetch(url, init);
    workers.push(`${init.method || "GET"} ${pathname}`);
    return Response.json({ success: true, errors: [], messages: [], result: { id: "domain-0001" } });
  };
  const options = {
    name: "예시 팀",
    email: "admin@example.com",
    serverDirectory: path.join(tmp, "server"),
    runtimeDirectory: path.join(tmp, "runtime"),
    env: { CLOUDFLARE_API_TOKEN: API_TOKEN },
    apiBaseUrl: cf.baseUrl,
    cloudflareFetch,
    hubModules: async () => [{ name: "hub.mjs", content: "export default {};" }],
  };
  const state = async () => JSON.parse(await fsp.readFile(path.join(tmp, "runtime", "team-access.json"), "utf8"));
  const app = (domain) => cf.state.apps.find((item) => item.domain === domain) || null;
  const policy = (name) => cf.state.policies.filter((item) => item.name === name);
  return { cf, workers, options, state, app, policy };
}

test("team make opens <hub>/guard behind the bypass policy beside the hub app, and keeps both ids", async (t) => {
  const f = await makeFixture(t);
  const made = await teamMake(f.options);
  assert.equal(made.ok, true, made.error);
  assert.ok(f.workers.some((call) => call.startsWith("PUT ") && call.endsWith("/workers/scripts/team-memory-hub")), "the hub was deployed");

  const [bypass] = f.policy(BYPASS_POLICY_NAME);
  assert.deepEqual({ decision: bypass.decision, include: bypass.include }, { decision: "bypass", include: [{ everyone: {} }] });
  const [everyone] = f.policy(EVERYONE_POLICY_NAME);
  const guard = f.app(`${HUB_HOST}/guard`);
  assert.deepEqual({ ...guard, id: "i", aud: "a" }, { id: "i", aud: "a", ...hubGuardAppBody({ host: HUB_HOST, policyId: bypass.id }) });
  assert.equal(guard.name, "Team Memory hub team.example.com guard");
  const hub = f.app(HUB_HOST);
  assert.deepEqual({ ...hub, id: "i", aud: "a" }, { id: "i", aud: "a", ...hubAppBody({ host: HUB_HOST, idpId: GOOGLE_IDP, policyId: everyone.id }) });
  assert.equal(f.cf.state.apps.length, 2, "the hub app and its guard app, nothing else");

  const state = await f.state();
  assert.equal(state.bypassPolicyId, bypass.id);
  assert.equal(state.everyonePolicyId, everyone.id);
  assert.equal(state.hub.appId, hub.id);
  assert.equal(state.hub.guardAppId, guard.id);
  assert.equal(state.hub.aud, hub.aud);
  assert.equal(JSON.stringify(state).includes(API_TOKEN), false);

  // Again: the same apps and policies, and nothing in Access is written.
  const accessWrites = () => f.cf.writes().filter((call) => call.includes("/access/")).length;
  const writes = accessWrites();
  const again = await teamMake(f.options);
  assert.equal(again.ok, true, again.error);
  assert.equal(accessWrites(), writes);
  assert.equal(f.cf.state.apps.length, 2);
  assert.equal(f.policy(BYPASS_POLICY_NAME).length, 1);
  assert.deepEqual([(await f.state()).hub.guardAppId, (await f.state()).bypassPolicyId], [guard.id, bypass.id]);

  // Changed by hand: the app kept in the state is found by its id and put back.
  Object.assign(guard, { name: "renamed by hand", domain: `${HUB_HOST}/elsewhere`, destinations: [], policies: [] });
  assert.equal((await teamMake(f.options)).ok, true);
  assert.equal(f.cf.state.apps.length, 2);
  const restored = f.cf.state.apps.find((item) => item.id === guard.id);
  assert.deepEqual({ ...restored, id: "i", aud: "a" }, { id: "i", aud: "a", ...hubGuardAppBody({ host: HUB_HOST, policyId: bypass.id }) });
  assert.equal((await f.state()).hub.guardAppId, guard.id);
});

test("team make on another hub address makes that address's guard app, not the old one's", async (t) => {
  const f = await makeFixture(t);
  assert.equal((await teamMake(f.options)).ok, true);
  const first = (await f.state()).hub.guardAppId;
  const moved = await teamMake({ ...f.options, hubLabel: "crew" });
  assert.equal(moved.ok, true, moved.error);
  const guard = f.app(`crew.${ZONE}/guard`);
  assert.ok(guard);
  assert.notEqual(guard.id, first);
  assert.deepEqual(guard.destinations, [{ type: "public", uri: `crew.${ZONE}/guard` }]);
  const state = await f.state();
  assert.deepEqual([state.hub.host, state.hub.guardAppId], [`crew.${ZONE}`, guard.id]);
  assert.equal(f.policy(BYPASS_POLICY_NAME).length, 1, "one bypass policy for every app that needs it");
});
