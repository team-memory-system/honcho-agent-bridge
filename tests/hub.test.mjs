// The team hub, run under Node: the Worker's fetch with a fake HUB namespace whose one
// TeamHub keeps its storage in a Map, Cloudflare faked by tests/fake-cloudflare.mjs and
// Access by tests/fake-access.mjs. What matters: nothing passes without a person's
// valid Access login for the hub, the Durable Object hears only the verified email,
// the roster decides who may do what, every server address is made and taken away in
// Cloudflare as the team changes, and no answer carries a token it should not. The
// Jev guard: the key stays in the hub, and /guard alone passes without a login, for a
// server's own guard token; Jev is faked by a local server.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import hub, { TeamHub } from "../server/hub/hub.mjs";
import { ACCESS_AUD, ACCESS_ISSUER, ACCESS_TEAM_DOMAIN, accessKey, personClaims, signAssertion, startAccessCerts } from "./fake-access.mjs";
import { ACCOUNT_ID, API_TOKEN, connectorToken, startFakeCloudflare, ZONE, ZONE_ID } from "./fake-cloudflare.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB_HOST = `team.${ZONE}`;
const ADMIN = "admin@example.com";
const PEOPLE_POLICY_ID = "policy-people-0001";
const GOOGLE_IDP = "idp-google-0001";
const WORKSPACE = "memory";
// Made once: RSA key generation is the slow part of these tests.
const signingKey = accessKey("kid-hub");
const rotatedKey = accessKey("kid-hub-rotated");
const strangerKey = accessKey("kid-hub");
let certs;

before(async () => {
  certs = await startAccessCerts([signingKey]);
});

after(async () => {
  await certs?.close();
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The HUB binding: idFromName, and get, whose stub hands every request to one TeamHub.
 * Its storage is a Map that copies values in and out, as Durable Object storage does.
 * blockConcurrencyWhile runs one callback at a time and counts the ones that threw:
 * in the Workers runtime that resets the object.
 */
function fakeNamespace(env) {
  const data = new Map();
  const names = [];
  const received = [];
  const blocks = { started: 0, running: 0, most: 0, threw: 0 };
  let queue = Promise.resolve();
  const ctx = {
    storage: {
      get: async (key) => structuredClone(data.get(key)),
      put: async (key, value) => { data.set(key, structuredClone(value)); },
      delete: async (key) => data.delete(key),
      list: async ({ prefix = "" } = {}) => new Map([...data.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => [key, structuredClone(data.get(key))])),
    },
    blockConcurrencyWhile(callback) {
      blocks.started += 1;
      const run = queue.then(async () => {
        blocks.running += 1;
        blocks.most = Math.max(blocks.most, blocks.running);
        try { return await callback(); }
        catch (error) { blocks.threw += 1; throw error; }
        finally { blocks.running -= 1; }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  let object = null;
  const namespace = {
    idFromName(name) {
      names.push(name);
      return { name };
    },
    get(id) {
      return {
        fetch(request) {
          received.push({ id, headers: new Headers(request.headers) });
          object ??= new TeamHub(ctx, env);
          return object.fetch(request);
        },
      };
    },
  };
  // A new deploy: the next request reaches a new TeamHub over the same storage.
  const restart = () => { object = null; };
  return { data, names, received, blocks, namespace, restart };
}

/** A hub for one test: its own fake Cloudflare, with the people policy the deploy made. */
async function hubFixture(t, { admins = [ADMIN], env: overrides = {} } = {}) {
  const cf = await startFakeCloudflare();
  t.after(() => cf.close());
  cf.state.policies.push({
    id: PEOPLE_POLICY_ID,
    reusable: true,
    name: "Team Memory people",
    decision: "allow",
    include: admins.map((email) => ({ email: { email: email.toLowerCase() } })),
  });
  const team = {
    name: "예시 팀",
    hubHost: HUB_HOST,
    zone: ZONE,
    zoneId: ZONE_ID,
    accountId: ACCOUNT_ID,
    teamDomain: ACCESS_TEAM_DOMAIN,
    idpId: GOOGLE_IDP,
    peoplePolicyId: PEOPLE_POLICY_ID,
    hubAud: ACCESS_AUD,
    admins,
  };
  const env = { TEAM: JSON.stringify(team), CF_API_TOKEN: API_TOKEN, CF_API_BASE: cf.baseUrl, ACCESS_CERTS_URL: certs.url, ...overrides };
  const fake = fakeNamespace(env);
  env.HUB = fake.namespace;

  async function send(pathname, { method = "GET", as = null, claims = null, key = signingKey, body, headers = {} } = {}) {
    const all = { ...headers };
    if (as || claims) all["cf-access-jwt-assertion"] = signAssertion(key, claims || personClaims({ email: as }));
    if (body !== undefined) all["content-type"] = "application/json";
    const request = new Request(`https://${HUB_HOST}${pathname}`, {
      method,
      headers: all,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const response = await hub.fetch(request, env);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, text, json };
  }

  const as = (email) => ({
    get: (pathname, options) => send(pathname, { ...options, as: email }),
    post: (pathname, body = {}, options) => send(pathname, { ...options, method: "POST", as: email, body }),
    put: (pathname, body = {}, options) => send(pathname, { ...options, method: "PUT", as: email, body }),
    delete: (pathname, options) => send(pathname, { ...options, method: "DELETE", as: email }),
  });

  /** Puts people on the roster through the admin API, each with a peer when one is given. */
  async function addPeople(people) {
    for (const [email, peer] of Object.entries(people)) {
      assert.equal((await as(ADMIN).post("/api/admin/people", { email })).status, 201, email);
      if (peer) assert.equal((await as(email).post("/api/me", { peer })).status, 200, email);
    }
  }

  /** `team make` again: TEAM names other admins, and the Durable Object starts over. */
  function redeploy({ admins: named }) {
    env.TEAM = JSON.stringify({ ...JSON.parse(env.TEAM), admins: named });
    fake.restart();
  }

  const serversApp = () => cf.state.apps.find((app) => app.name === "Team Memory servers") || null;
  const tunnel = (id) => cf.state.tunnels.find((item) => item.id === id);
  const people = () => cf.state.policies.find((item) => item.id === PEOPLE_POLICY_ID).include.map((rule) => rule.email.email);
  return { cf, env, ...fake, send, as, addPeople, redeploy, serversApp, tunnel, people };
}

// ------------------------------------------------------------------- the door

test("the hub module imports one literal line of Cloudflare helpers, and nothing it loads uses Node", async () => {
  const source = await fsp.readFile(path.join(ROOT, "server", "hub", "hub.mjs"), "utf8");
  const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.equal(imports.length, 1);
  assert.match(imports[0], /^import \{ [^}]+ \} from "\.\.\/\.\.\/scripts\/cloudflare-api\.mjs";$/);
  assert.doesNotMatch(source, /\bprocess\.|\bBuffer\b|\brequire\(/);
  const helpers = await fsp.readFile(path.join(ROOT, "scripts", "cloudflare-api.mjs"), "utf8");
  assert.doesNotMatch(helpers, /^\s*import\b/m, "the Worker uploads it as it is, so it imports nothing");
  assert.doesNotMatch(helpers, /\bprocess\.|\bBuffer\b|\brequire\(/);
});

test("every request needs a person's valid Access login for the hub: 401 JSON for the API, a Korean page for /", async (t) => {
  const f = await hubFixture(t);
  const now = Math.floor(Date.now() / 1000);
  const { email: _email, ...withoutEmail } = personClaims();
  const signed = (claims, key = signingKey, header) => ({ "cf-access-jwt-assertion": signAssertion(key, claims, header) });
  const cases = {
    "missing assertion": {},
    "not a JWT": { "cf-access-jwt-assertion": "not-a-jwt" },
    "bad signature": signed(personClaims({ email: ADMIN }), strangerKey),
    "wrong aud": signed(personClaims({ email: ADMIN, aud: ["aud-of-another-app"] })),
    "wrong iss": signed(personClaims({ email: ADMIN, iss: "https://another-team.example" })),
    expired: signed(personClaims({ email: ADMIN, exp: now - 120 })),
    "no exp": signed(personClaims({ email: ADMIN, exp: undefined })),
    "not yet valid": signed(personClaims({ email: ADMIN, nbf: now + 600 })),
    "no email": signed(withoutEmail),
    "empty email": signed(personClaims({ email: "  " })),
    "service token": signed({ ...withoutEmail, common_name: "0000.access", sub: "" }),
    "service token with an email": signed(personClaims({ email: ADMIN, common_name: "0000.access" })),
    "another algorithm": signed(personClaims({ email: ADMIN }), signingKey, { alg: "HS256" }),
    "signature of another token": {
      "cf-access-jwt-assertion": (() => {
        const forged = signAssertion(signingKey, personClaims({ email: ADMIN })).split(".");
        forged[2] = signAssertion(signingKey, personClaims({ email: "stranger@example.com" })).split(".")[2];
        return forged.join(".");
      })(),
    },
  };
  for (const [name, headers] of Object.entries(cases)) {
    const api = await f.send("/api/me", { headers });
    assert.equal(api.status, 401, name);
    assert.equal(api.json.error, "unauthorized", name);
    assert.equal(typeof api.json.detail, "string");
    assert.match(api.headers.get("content-type"), /application\/json/);
    const page = await f.send("/", { headers });
    assert.equal(page.status, 401, name);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.match(page.text, /<html lang="ko">/);
    assert.match(page.text, /로그인을 확인하지 못했습니다/);
    for (const claim of [ADMIN, "stranger@example.com", ACCESS_AUD, ACCESS_ISSUER, "0000.access"]) {
      assert.ok(!api.text.includes(claim) && !page.text.includes(claim), `${name}: the answer does not echo ${claim}`);
    }
  }
  assert.deepEqual(f.names, [], "nothing refused reached the Durable Object");
  assert.equal(f.data.size, 0);

  // Up to 60 seconds of clock difference, and an aud given as one string.
  for (const claims of [
    personClaims({ email: ADMIN, exp: now - 30 }),
    personClaims({ email: ADMIN, nbf: now + 30 }),
    personClaims({ email: ADMIN, aud: ACCESS_AUD }),
    personClaims({ email: ADMIN, aud: ["aud-another-app", ACCESS_AUD] }),
  ]) {
    assert.equal((await f.send("/api/me", { claims })).status, 200, JSON.stringify(claims));
  }
});

test("the Durable Object hears only the verified email: every x-hub-* header a caller sends is dropped", async (t) => {
  const f = await hubFixture(t);
  const spoofed = { "x-hub-email": ADMIN, "X-Hub-Admin": "true", "x-hub-anything": "1" };
  const me = await f.send("/api/me", { as: "Stranger@Example.com", headers: spoofed });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, "stranger@example.com", "the assertion's email, in lower case");
  assert.equal(me.json.member, false);
  const heard = f.received.at(-1).headers;
  assert.deepEqual([...heard.keys()].filter((name) => name.startsWith("x-hub-")), ["x-hub-email"]);
  assert.equal(heard.get("x-hub-email"), "stranger@example.com");
  assert.ok(f.names.length > 0 && f.names.every((name) => name === "team"), "all state is in the one object named team");

  const admin = await f.send("/api/admin/people", { as: "stranger@example.com", headers: spoofed });
  assert.equal(admin.status, 403);
  assert.equal(admin.json.error, "not_member");
});

test("an unknown key id fetches the team's keys once more at most once a minute, and the keys are fetched again after an hour", async (t) => {
  const ownCerts = await startAccessCerts([signingKey]);
  t.after(() => ownCerts.close());
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await hubFixture(t, { env: { ACCESS_CERTS_URL: ownCerts.url } });
  const call = (key) => f.send("/api/me", { as: ADMIN, key });

  assert.equal((await call(signingKey)).status, 200);
  assert.equal((await call(signingKey)).status, 200);
  assert.equal(ownCerts.fetches, 1, "the keys are fetched once and kept");

  // Cloudflare rotates in a new key: the first token signed with it is let in.
  ownCerts.keys = [signingKey, rotatedKey];
  assert.equal((await call(rotatedKey)).status, 200);
  assert.equal(ownCerts.fetches, 2, "one more fetch for the new key id");

  // A made-up key id within the same minute is refused without asking again.
  const madeUp = { ...signingKey, kid: "kid-made-up" };
  assert.equal((await call(madeUp)).status, 401);
  assert.equal((await call(madeUp)).status, 401);
  assert.equal(ownCerts.fetches, 2);
  t.mock.timers.tick(61_000);
  assert.equal((await call(madeUp)).status, 401);
  assert.equal(ownCerts.fetches, 3, "a minute later it may ask once more");

  // An hour after the last fetch the keys are fetched again, and a retired key stops working.
  ownCerts.keys = [rotatedKey];
  t.mock.timers.tick(59 * 60_000);
  assert.equal((await call(signingKey)).status, 200, "not yet an hour");
  assert.equal(ownCerts.fetches, 3);
  t.mock.timers.tick(2 * 60_000);
  assert.equal((await call(rotatedKey)).status, 200);
  assert.equal(ownCerts.fetches, 4);
  assert.equal((await call(signingKey)).status, 401, "the retired key is no longer trusted");
});

test("a change sent by a page on another site is refused; reads and the app's own requests pass", async (t) => {
  const f = await hubFixture(t);
  for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "null" }]) {
    const answer = await f.as(ADMIN).post("/api/admin/people", { email: "mate@example.com" }, { headers });
    assert.equal(answer.status, 403, JSON.stringify(headers));
    assert.equal(answer.json.error, "cross_site");
  }
  assert.equal(f.data.has("person:mate@example.com"), false);
  assert.equal((await f.as(ADMIN).get("/api/me", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })).status, 200);
  const same = await f.as(ADMIN).post("/api/admin/people", { email: "mate@example.com" }, { headers: { origin: `https://${HUB_HOST}`, "sec-fetch-site": "same-origin" } });
  assert.equal(same.status, 201);
});

// ---------------------------------------------------------------- the roster

test("the first request of all seeds the team and its admins; /api/me answers anyone and counts a member's logins", async (t) => {
  const f = await hubFixture(t, { admins: [ADMIN, "Second@Example.com", "not an email"] });
  const stranger = await f.as("stranger@example.com").get("/api/me");
  assert.equal(stranger.status, 200);
  assert.deepEqual(stranger.json, {
    email: "stranger@example.com",
    member: false,
    admin: false,
    peer: null,
    team: { name: "예시 팀", host: HUB_HOST },
    servers: [],
  });
  assert.equal(f.data.get("meta").name, "예시 팀");
  assert.match(f.data.get("meta").createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(f.data.get("meta").seededAdmins, [ADMIN, "second@example.com"]);
  assert.deepEqual([...f.data.keys()].filter((key) => key.startsWith("person:")).sort(), ["person:admin@example.com", "person:second@example.com"]);
  const seeded = f.data.get("person:second@example.com");
  assert.deepEqual({ ...seeded, addedAt: "x" }, {
    email: "second@example.com", peer: null, admin: true, addedAt: "x", addedBy: "setup", firstLoginAt: null, lastLoginAt: null,
  });

  const first = await f.as(ADMIN).get("/api/me");
  assert.deepEqual(first.json, { email: ADMIN, member: true, admin: true, peer: null, team: { name: "예시 팀", host: HUB_HOST }, servers: [] });
  const login = f.data.get("person:admin@example.com");
  assert.ok(login.firstLoginAt);
  assert.equal(login.lastLoginAt, login.firstLoginAt);
  await pause(5);
  await f.as(ADMIN).get("/api/me");
  const later = f.data.get("person:admin@example.com");
  assert.equal(later.firstLoginAt, login.firstLoginAt);
  assert.ok(later.lastLoginAt > login.lastLoginAt);

  // Seeding happens once: an admin removed later is not seeded again.
  assert.equal((await f.as(ADMIN).delete("/api/admin/people/second%40example.com")).status, 200);
  await f.as(ADMIN).get("/api/me");
  assert.equal(f.data.has("person:second@example.com"), false);
});

test("GET / shows the team, the email signed in, whether the roster has it, and how to join from the app", async (t) => {
  const f = await hubFixture(t);
  assert.equal((await f.as(ADMIN).put("/api/admin/team", { name: "<b>팀</b> & co" })).status, 200);
  const member = await f.as(ADMIN).get("/");
  assert.equal(member.status, 200);
  assert.match(member.headers.get("content-type"), /^text\/html; charset=utf-8/);
  assert.match(member.headers.get("content-security-policy"), /default-src 'none'/);
  assert.ok(member.text.includes("&lt;b&gt;팀&lt;/b&gt; &amp; co"), "the team's name, escaped");
  assert.ok(!member.text.includes("<b>팀</b>"));
  assert.ok(member.text.includes(ADMIN));
  assert.match(member.text, /팀 명단에 있습니다/);
  assert.match(member.text, /팀에 들어가기/);
  assert.ok(member.text.includes(`<p class="address mono">${HUB_HOST}</p>`));
  assert.ok(member.text.includes(`<a class="button" href="http://127.0.0.1:4180/#/start?team=${HUB_HOST}">앱에서 열기</a>`));

  const stranger = await f.as("stranger@example.com").get("/");
  assert.equal(stranger.status, 200);
  assert.ok(stranger.text.includes("stranger@example.com"));
  assert.match(stranger.text, /팀 명단에 없습니다/);
});

test("a member's peer is set once: the one given if no one has it, else one made from the email", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({
    "j.kim@example.com": null,
    "j_kim@example.org": null,
    "J-Kim@example.net": null,
    "x@example.com": null,
    "--a-very-long-local-part-that-goes-on-and-on@example.com": null,
    "abcdefghijklmnopqrstuvwxyz01234-z@example.com": null,
    "+++@example.com": null,
  });
  const peer = async (email, body) => {
    const answer = await f.as(email).post("/api/me", body);
    return [answer.status, answer.json.peer ?? answer.json.error];
  };
  assert.deepEqual(await peer("j.kim@example.com", {}), [200, "j-kim"]);
  assert.deepEqual(await peer("j_kim@example.org", { peer: null }), [200, "j-kim-2"]);
  assert.deepEqual(await peer("j-kim@example.net", { peer: "" }), [200, "j-kim-3"]);
  assert.deepEqual(await peer("--a-very-long-local-part-that-goes-on-and-on@example.com", {}), [200, "a-very-long-local-part-that-goes"]);
  assert.deepEqual(await peer("abcdefghijklmnopqrstuvwxyz01234-z@example.com", {}), [200, "abcdefghijklmnopqrstuvwxyz01234"]);
  assert.deepEqual(await peer("+++@example.com", {}), [200, "member"]);

  // Set once: the same again is fine, another is not.
  assert.deepEqual(await peer("j.kim@example.com", {}), [200, "j-kim"]);
  assert.deepEqual(await peer("j.kim@example.com", { peer: "j-kim" }), [200, "j-kim"]);
  assert.deepEqual(await peer("j.kim@example.com", { peer: "jay" }), [409, "peer_set"]);

  // A given peer: checked, and nobody else's, whatever its case.
  for (const wanted of ["bad peer!", "a".repeat(65), "assistant_claude", "Automation_x", 5, ["x"]]) {
    assert.deepEqual(await peer("x@example.com", { peer: wanted }), [400, "bad_request"], JSON.stringify(wanted));
  }
  assert.deepEqual(await peer("x@example.com", { peer: "J-KIM" }), [409, "peer_taken"]);
  assert.deepEqual(await peer("x@example.com", { peer: "Xavier.K@home:1_-" }), [200, "Xavier.K@home:1_-"]);
  assert.equal(f.data.get("person:x@example.com").peer, "Xavier.K@home:1_-");

  assert.deepEqual(await peer("stranger@example.com", { peer: "stranger" }), [403, "not_member"]);
  assert.deepEqual(await peer("x@example.com", "{not json"), [400, "bad_request"]);
});

test("the team lists its people and servers to members only", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": null });
  await f.as(ADMIN).post("/api/me", { peer: "chief" });
  await f.as("bob@example.com").get("/api/me");
  assert.equal((await f.as(ADMIN).post("/api/servers", { workspace: WORKSPACE, device: "관리자 Mac" })).status, 201);
  assert.equal((await f.as("bob@example.com").post("/api/servers", { workspace: "bobs" })).status, 201);

  const listed = await f.as("carol@example.com").get("/api/team");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, {
    team: { name: "예시 팀", host: HUB_HOST, zone: ZONE },
    people: [
      { email: ADMIN, peer: "chief", admin: true, joined: false, servers: ["memory.example.com"] },
      { email: "bob@example.com", peer: "bob", admin: false, joined: true, servers: ["memory-bob.example.com"] },
      { email: "carol@example.com", peer: null, admin: false, joined: false, servers: [] },
    ],
    servers: [
      { host: "memory-bob.example.com", label: "bob", owner: "bob@example.com", ownerPeer: "bob", workspace: "bobs", company: false, createdOn: null },
      { host: "memory.example.com", label: "memory", owner: ADMIN, ownerPeer: "chief", workspace: WORKSPACE, company: true, createdOn: "관리자 Mac" },
    ],
  });
  const stranger = await f.as("stranger@example.com").get("/api/team");
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error, "not_member");
  assert.match(stranger.json.detail, /stranger@example\.com is not on the team's roster/);
});

// --------------------------------------------------------------- servers

test("the first admin server is the company server at memory.<zone>; the others are memory-<label>.<zone>, all in one servers app", async (t) => {
  const f = await hubFixture(t, { admins: [ADMIN, "boss@example.com"] });
  await f.addPeople({ "bob@example.com": "Bob.Lee" });

  const writesBefore = f.cf.writes().length;
  for (const [body, pattern] of [[{}, /workspace/], [{ workspace: "bad workspace" }, /workspace/], [{ workspace: WORKSPACE, label: "Bad_Label" }, /label/], [{ workspace: WORKSPACE, device: "a\nb" }, /device/], [{ workspace: WORKSPACE, replace: "yes" }, /replace/]]) {
    const refused = await f.as("bob@example.com").post("/api/servers", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.json.detail, pattern);
  }
  assert.equal((await f.as("stranger@example.com").post("/api/servers", { workspace: WORKSPACE })).status, 403);
  assert.equal(f.cf.writes().length, writesBefore, "nothing refused touched Cloudflare");

  const made = await f.as(ADMIN).post("/api/servers", { workspace: WORKSPACE, device: "관리자의 MacBook" });
  assert.equal(made.status, 201);
  assert.deepEqual(Object.keys(made.json).sort(), ["aud", "server", "teamDomain", "tunnelToken"]);
  const { server, tunnelToken, teamDomain, aud } = made.json;
  assert.deepEqual({ ...server, tunnelId: "t", dnsRecordId: "d", createdAt: "c", updatedAt: "u" }, {
    host: "memory.example.com", label: "memory", owner: ADMIN, workspace: WORKSPACE, company: true, createdOn: "관리자의 MacBook",
    tunnelId: "t", dnsRecordId: "d", createdAt: "c", updatedAt: "u",
  });
  assert.deepEqual(f.data.get("server:memory.example.com"), server);
  const tunnel = f.tunnel(server.tunnelId);
  assert.equal(tunnel.name, "team-memory-memory");
  assert.equal(tunnel.config_src, "cloudflare");
  assert.equal(tunnelToken, f.cf.state.tunnelTokens[server.tunnelId]);
  assert.equal(teamDomain, ACCESS_TEAM_DOMAIN);
  assert.deepEqual(f.cf.state.configurations[server.tunnelId], {
    ingress: [{ hostname: "memory.example.com", service: "http://gate:8010" }, { service: "http_status:404" }],
  });
  const cname = f.cf.state.records.find((record) => record.name === "memory.example.com");
  assert.deepEqual({ type: cname.type, content: cname.content, proxied: cname.proxied }, { type: "CNAME", content: `${server.tunnelId}.cfargotunnel.com`, proxied: true });
  assert.equal(server.dnsRecordId, cname.id);
  let app = f.serversApp();
  assert.deepEqual({ ...app, id: "i", aud: "a" }, {
    id: "i",
    aud: "a",
    name: "Team Memory servers",
    type: "self_hosted",
    domain: "memory.example.com",
    destinations: [{ type: "public", uri: "memory.example.com" }],
    allowed_idps: [GOOGLE_IDP],
    auto_redirect_to_identity: true,
    session_duration: "24h",
    policies: [{ id: PEOPLE_POLICY_ID, precedence: 1 }],
    oauth_configuration: {
      enabled: true,
      dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true },
      grant: { session_duration: "8760h" },
    },
  });
  assert.equal(aud, app.aud);
  assert.deepEqual(f.data.get("serversApp"), { id: app.id, aud: app.aud });
  for (const call of f.cf.requests) assert.equal(call.authorization, `Bearer ${API_TOKEN}`);

  // A member's server: memory-<their peer, made valid>, added to the same app.
  const bobs = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE });
  assert.equal(bobs.status, 201);
  assert.equal(bobs.json.server.host, "memory-bob-lee.example.com");
  assert.equal(bobs.json.server.label, "bob-lee");
  assert.equal(bobs.json.server.company, false);
  assert.equal(f.tunnel(bobs.json.server.tunnelId).name, "team-memory-bob-lee");
  assert.equal(bobs.json.aud, aud, "one app, so one AUD for every server");
  assert.notEqual(bobs.json.tunnelToken, tunnelToken);
  app = f.serversApp();
  assert.equal(f.cf.state.apps.length, 1);
  assert.equal(app.domain, "memory.example.com");
  assert.deepEqual(app.destinations.map((item) => item.uri), ["memory.example.com", "memory-bob-lee.example.com"]);

  // The second admin's: the company server exists, so it is memory-<label> too.
  const boss = await f.as("boss@example.com").post("/api/servers", { workspace: WORKSPACE, label: "boss" });
  assert.equal(boss.status, 201);
  assert.deepEqual([boss.json.server.host, boss.json.server.company], ["memory-boss.example.com", false]);
  assert.deepEqual(f.serversApp().destinations.map((item) => item.uri), ["memory.example.com", "memory-bob-lee.example.com", "memory-boss.example.com"]);

  // One server per person.
  const writes = f.cf.writes().length;
  const again = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "server_exists");
  assert.deepEqual(again.json.server, bobs.json.server);
  assert.equal(f.cf.writes().length, writes);

  const me = await f.as("bob@example.com").get("/api/me");
  assert.deepEqual(me.json.servers, [bobs.json.server]);
});

test("a host or name another server has is refused; leftovers of the first sharing on that name go", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": "carol" });

  // The first sharing's apps and tunnel for both names, and an app of the owner's own.
  const oldTunnel = { id: "11111111-2222-4333-8444-555555555555", name: "team-memory-carol", config_src: "cloudflare", created_at: "2026-01-01T00:00:00.000Z", deleted_at: null };
  f.cf.state.tunnels.push(oldTunnel);
  f.cf.state.tunnelTokens[oldTunnel.id] = connectorToken(oldTunnel.id);
  f.cf.state.apps.push(
    { id: "legacy-company", aud: "a".repeat(64), name: "Team Memory memory.example.com", domain: "memory.example.com", policies: [] },
    { id: "legacy-company-gate", aud: "b".repeat(64), name: "Team Memory memory.example.com gate token", domain: "memory.example.com/v3", policies: [] },
    { id: "legacy-carol", aud: "c".repeat(64), name: "Team Memory memory-carol.example.com", domain: "memory-carol.example.com", policies: [] },
    { id: "legacy-carol-gate", aud: "d".repeat(64), name: "Team Memory memory-carol.example.com gate token", domain: "memory-carol.example.com/v3", policies: [] },
    { id: "own-wiki", aud: "e".repeat(64), name: "Wiki", domain: "memory-carol.example.com/wiki", policies: [] },
  );

  const hubName = await f.as(ADMIN).post("/api/servers", { workspace: WORKSPACE, label: "team" });
  assert.equal(hubName.status, 409, "team.example.com is the hub's own host");
  assert.equal(hubName.json.error, "host_taken");
  assert.equal((await f.as(ADMIN).post("/api/servers", { workspace: WORKSPACE })).status, 201);
  assert.equal((await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE })).status, 201);

  const ids = () => f.cf.state.apps.map((app) => app.id);
  assert.ok(!ids().includes("legacy-company") && !ids().includes("legacy-company-gate"), "the company host's old apps are gone");
  assert.ok(!["legacy-company", "legacy-company-gate"].includes(f.serversApp().id), "the servers app is a new app, not the old one taken over");

  for (const [body, detail] of [
    [{ workspace: WORKSPACE, label: "bob" }, /memory-bob\.example\.com is taken/],
    [{ workspace: WORKSPACE, label: "memory" }, /name memory is taken/],
  ]) {
    const taken = await f.as("carol@example.com").post("/api/servers", body);
    assert.equal(taken.status, 409, JSON.stringify(body));
    assert.equal(taken.json.error, "host_taken");
    assert.match(taken.json.detail, detail);
  }

  const carols = await f.as("carol@example.com").post("/api/servers", { workspace: WORKSPACE });
  assert.equal(carols.status, 201);
  assert.equal(carols.json.server.host, "memory-carol.example.com");
  assert.ok(f.tunnel(oldTunnel.id).deleted_at, "the tunnel of that name from before is deleted");
  assert.notEqual(carols.json.server.tunnelId, oldTunnel.id);
  assert.notEqual(carols.json.tunnelToken, f.cf.state.tunnelTokens[oldTunnel.id]);
  assert.deepEqual(ids().filter((id) => id !== f.serversApp().id), ["own-wiki"], "only apps of another name stay");
  assert.deepEqual(f.serversApp().destinations.map((item) => item.uri), ["memory.example.com", "memory-bob.example.com", "memory-carol.example.com"]);
  assert.equal(f.blocks.threw, 0, "refusals inside a change come out as answers");
});

test("replace makes a new tunnel for the same host, so the old computer's connector stops", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob" });
  const first = (await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE, device: "옛 컴퓨터" })).json;
  const appWrites = () => f.cf.writes().filter((item) => item.includes("/access/")).length;
  const before = appWrites();
  // The old tunnel goes by its id, even renamed by hand.
  f.tunnel(first.server.tunnelId).name = "renamed-by-hand";
  await pause(5);

  const moved = await f.as("bob@example.com").post("/api/servers", { workspace: "bob-new", device: "새 컴퓨터", replace: true });
  assert.equal(moved.status, 200);
  const { server } = moved.json;
  assert.equal(server.host, first.server.host);
  assert.equal(server.workspace, "bob-new");
  assert.equal(server.createdOn, "새 컴퓨터");
  assert.equal(server.createdAt, first.server.createdAt);
  assert.ok(server.updatedAt > first.server.updatedAt);
  assert.notEqual(server.tunnelId, first.server.tunnelId);
  assert.ok(f.tunnel(first.server.tunnelId).deleted_at, "the old tunnel is deleted");
  assert.equal(f.tunnel(server.tunnelId).name, "team-memory-bob");
  assert.equal(moved.json.tunnelToken, f.cf.state.tunnelTokens[server.tunnelId]);
  assert.notEqual(moved.json.tunnelToken, first.tunnelToken);
  const cnames = f.cf.state.records.filter((record) => record.name === server.host);
  assert.deepEqual(cnames.map((record) => record.content), [`${server.tunnelId}.cfargotunnel.com`]);
  assert.equal(moved.json.aud, first.aud);
  assert.equal(appWrites(), before, "the servers app already holds the host");
  const deletes = f.cf.writes().filter((item) => item.startsWith("DELETE"));
  assert.deepEqual(deletes.slice(-2), [`DELETE /accounts/${ACCOUNT_ID}/cfd_tunnel/${first.server.tunnelId}/connections`, `DELETE /accounts/${ACCOUNT_ID}/cfd_tunnel/${first.server.tunnelId}`]);

  const renamed = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE, label: "robert", replace: true });
  assert.equal(renamed.status, 409, "replace keeps the address");
  assert.equal(renamed.json.error, "server_exists");
});

test("Cloudflare errors come back as 502 cloudflare with the client's message, never a token, and leave no record", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob" });
  f.cf.state.records.push({ id: "r-site", type: "A", name: "memory-bob.example.com", content: "192.0.2.1", proxied: false });
  const failed = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error, "cloudflare");
  assert.match(failed.json.detail, /memory-bob\.example\.com already has a record of type A/);
  assert.equal(failed.text.includes(API_TOKEN), false);
  for (const token of Object.values(f.cf.state.tunnelTokens)) assert.equal(failed.text.includes(token), false);
  assert.equal(f.data.has("server:memory-bob.example.com"), false);
  assert.equal(f.serversApp(), null);

  // The failure came out as an answer, not as an exception that would reset the object.
  assert.equal(f.blocks.threw, 0);
  assert.equal((await f.as("bob@example.com").get("/api/me")).status, 200);

  // A message built from what Cloudflare holds, not by the client, is cut too.
  f.cf.state.records = [{ id: "r-odd", type: "CNAME", name: "memory-bob.example.com", content: `${API_TOKEN}.example.net`, proxied: true }];
  const echoed = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE });
  assert.equal(echoed.status, 502);
  assert.match(echoed.json.detail, /already points at \[redacted\]\.example\.net/);
  assert.equal(echoed.text.includes(API_TOKEN), false);

  const wrongToken = "wrong-cloudflare-token-0123456789abcdef";
  const g = await hubFixture(t, { env: { CF_API_TOKEN: wrongToken } });
  const refused = await g.as(ADMIN).post("/api/admin/people", { email: "mate@example.com" });
  assert.equal(refused.status, 502);
  assert.equal(refused.json.error, "cloudflare");
  assert.match(refused.json.detail, /HTTP 403: 10000 Authentication error \(the API token needs Account \/ Access: Apps and Policies \/ Edit\)/);
  assert.equal(refused.text.includes(wrongToken), false);
  assert.equal(g.data.has("person:mate@example.com"), false, "no record without the policy");
});

test("two provisions at once run one after the other, and both hosts end up in the servers app", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": "carol" });
  const started = f.blocks.started;
  const answers = await Promise.all(["bob@example.com", "carol@example.com", ADMIN]
    .map((email) => f.as(email).post("/api/servers", { workspace: WORKSPACE })));
  assert.deepEqual(answers.map((answer) => answer.status), [201, 201, 201]);
  assert.equal(f.blocks.started - started, 3, "each change to Cloudflare ran inside blockConcurrencyWhile");
  assert.equal(f.blocks.most, 1);
  assert.deepEqual(f.serversApp().destinations.map((item) => item.uri).sort(), ["memory-bob.example.com", "memory-carol.example.com", "memory.example.com"]);
});

test("a team holds at most 50 servers, as many as one Access app takes", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob" });
  for (let index = 0; index < 50; index += 1) {
    f.data.set(`server:memory-s${index}.example.com`, { host: `memory-s${index}.example.com`, label: `s${index}`, owner: `s${index}@example.com`, company: index === 0, createdAt: "2026-01-01T00:00:00.000Z" });
  }
  const full = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE });
  assert.equal(full.status, 409);
  assert.equal(full.json.error, "too_many_servers");
  assert.equal(f.cf.writes().filter((item) => !item.includes("/access/policies")).length, 0);
});

test("a server is removed by its owner or an admin: hostname, tunnel, servers app and record go, and requests to it end", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": "carol" });
  const company = (await f.as(ADMIN).post("/api/servers", { workspace: WORKSPACE })).json.server;
  const bobs = (await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE })).json.server;
  const pending = (await f.as("carol@example.com").post("/api/requests", { kind: "chat", server: bobs.host })).json.request;
  const approved = (await f.as(ADMIN).post("/api/requests", { kind: "chat", server: bobs.host })).json.request;
  assert.equal((await f.as("bob@example.com").post(`/api/requests/${approved.id}/decide`, { approve: true, projects: ["honcho"] })).status, 200);
  const toCompany = (await f.as("bob@example.com").post("/api/requests", { kind: "collect", server: company.host })).json.request;

  const notOwner = await f.as("carol@example.com").delete(`/api/servers/${bobs.host}`);
  assert.equal(notOwner.status, 403);
  assert.equal(notOwner.json.error, "forbidden");
  assert.equal((await f.as("stranger@example.com").delete(`/api/servers/${bobs.host}`)).json.error, "not_member");
  assert.equal((await f.as("bob@example.com").delete("/api/servers/memory-nobody.example.com")).status, 404);
  assert.ok(f.data.has(`server:${bobs.host}`));

  const mark = f.cf.writes().length;
  const removed = await f.as("bob@example.com").delete(`/api/servers/${bobs.host.toUpperCase()}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { removed: bobs.host });
  assert.equal(f.data.has(`server:${bobs.host}`), false);
  assert.equal(f.cf.state.records.some((record) => record.name === bobs.host), false);
  assert.ok(f.tunnel(bobs.tunnelId).deleted_at);
  assert.deepEqual(f.serversApp().destinations.map((item) => item.uri), [company.host]);
  assert.equal(f.data.get(`request:${pending.id}`).status, "cancelled");
  const revoked = f.data.get(`request:${approved.id}`);
  assert.equal(revoked.status, "revoked");
  assert.ok(revoked.revokedAt);
  assert.equal(f.data.get(`request:${toCompany.id}`).status, "pending", "requests to other servers stay");
  // The hostname goes first, then the tunnel, and only then does the host leave the servers app.
  const order = f.cf.writes().slice(mark);
  assert.deepEqual(order, [
    `DELETE /zones/${ZONE_ID}/dns_records/${bobs.dnsRecordId}`,
    `DELETE /accounts/${ACCOUNT_ID}/cfd_tunnel/${bobs.tunnelId}/connections`,
    `DELETE /accounts/${ACCOUNT_ID}/cfd_tunnel/${bobs.tunnelId}`,
    `PUT /accounts/${ACCOUNT_ID}/access/apps/${f.serversApp().id}`,
  ]);

  // An admin may remove anyone's; the last one takes the servers app with it.
  const appId = f.serversApp().id;
  assert.equal((await f.as(ADMIN).delete(`/api/servers/${company.host}`)).status, 200);
  assert.equal(f.serversApp(), null);
  assert.equal(f.data.has("serversApp"), false);
  assert.ok(f.cf.writes().includes(`DELETE /accounts/${ACCOUNT_ID}/access/apps/${appId}`));
  assert.equal(f.data.get(`request:${toCompany.id}`).status, "cancelled");

  // A new server afterwards makes a new servers app.
  assert.equal((await f.as("carol@example.com").post("/api/servers", { workspace: WORKSPACE })).status, 201);
  assert.deepEqual(f.serversApp().destinations.map((item) => item.uri), ["memory-carol.example.com"]);
});

// -------------------------------------------------------------- requests

test("a request goes from a member to a teammate's server, and only the right person moves it on", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": null, "dave@example.com": "dave" });
  const bobs = (await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE })).json.server;
  const carol = f.as("carol@example.com");
  const bob = f.as("bob@example.com");
  const dave = f.as("dave@example.com");

  for (const [body, pattern] of [
    [{ kind: "write", server: bobs.host }, /kind/],
    [{ kind: "chat" }, /server/],
    [{ kind: "chat", server: bobs.host, device: "x".repeat(65) }, /device/],
    [{ kind: "chat", server: bobs.host, device: "line\nbreak" }, /device/],
    [{ kind: "collect", server: bobs.host, folders: Array.from({ length: 51 }, (_, index) => `f${index}`) }, /folders/],
    [{ kind: "collect", server: bobs.host, folders: ["x".repeat(65)] }, /folders/],
    [{ kind: "collect", server: bobs.host, folders: "honcho" }, /folders/],
  ]) {
    const refused = await carol.post("/api/requests", body);
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(refused.json.detail, pattern);
  }
  assert.equal((await carol.post("/api/requests", { kind: "chat", server: "memory-nobody.example.com" })).status, 404);
  const own = await bob.post("/api/requests", { kind: "chat", server: bobs.host });
  assert.equal(own.status, 400);
  assert.equal(own.json.error, "own_server");
  assert.equal((await f.as("stranger@example.com").post("/api/requests", { kind: "chat", server: bobs.host })).json.error, "not_member");

  const chat = await carol.post("/api/requests", { kind: "chat", server: bobs.host.toUpperCase(), device: "캐럴의 MacBook" });
  assert.equal(chat.status, 201);
  assert.deepEqual({ ...chat.json.request, id: "i", createdAt: "c" }, {
    id: "i", kind: "chat", from: "carol@example.com", fromPeer: null, server: bobs.host, owner: "bob@example.com", device: "캐럴의 MacBook",
    folders: [], status: "pending", projects: [], createdAt: "c", decidedAt: null, revokedAt: null, dismissedAt: null,
  });
  assert.match(chat.json.request.id, /^r-[0-9a-f]{16}$/);
  const same = await carol.post("/api/requests", { kind: "chat", server: bobs.host, device: "다른 컴퓨터" });
  assert.equal(same.status, 200, "the pending one is returned as it is");
  assert.deepEqual(same.json.request, chat.json.request);
  await pause(5);
  const collect = await carol.post("/api/requests", { kind: "collect", server: bobs.host, folders: ["honcho", "web-app", "honcho", "  메모  "] });
  assert.equal(collect.status, 201);
  assert.deepEqual(collect.json.request.folders, ["honcho", "web-app", "메모"]);

  // Carol's peer, set after her requests, is on them from then on.
  assert.equal((await carol.post("/api/me", { peer: "carol" })).status, 200);
  const lists = await bob.get("/api/requests");
  assert.deepEqual(lists.json.incoming.map((item) => [item.kind, item.fromPeer]), [["collect", "carol"], ["chat", "carol"]], "newest first");
  assert.deepEqual(lists.json.outgoing, []);
  assert.deepEqual(lists.json.granted, []);
  assert.deepEqual((await carol.get("/api/requests")).json.outgoing.map((item) => item.kind), ["collect", "chat"]);
  assert.deepEqual((await dave.get("/api/requests")).json, { incoming: [], outgoing: [], granted: [] });
  assert.equal((await f.as("stranger@example.com").get("/api/requests")).json.error, "not_member");

  const chatId = chat.json.request.id;
  const collectId = collect.json.request.id;
  const move = async (who, id, action, body) => {
    const answer = await who.post(`/api/requests/${id}/${action}`, body);
    return [answer.status, answer.json.request?.status ?? answer.json.error];
  };
  // Only the owner decides, only while pending.
  assert.deepEqual(await move(dave, chatId, "decide", { approve: true }), [403, "forbidden"]);
  assert.deepEqual(await move(carol, chatId, "decide", { approve: true }), [403, "forbidden"]);
  assert.deepEqual(await move(bob, chatId, "decide", { approve: "yes" }), [400, "bad_request"]);
  assert.deepEqual(await move(bob, chatId, "decide", { approve: true, projects: Array.from({ length: 51 }, (_, index) => `p${index}`) }), [400, "bad_request"]);
  const approved = await bob.post(`/api/requests/${chatId}/decide`, { approve: true, projects: ["honcho", "notes"] });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.request.status, "approved");
  assert.deepEqual(approved.json.request.projects, ["honcho", "notes"]);
  assert.ok(approved.json.request.decidedAt);
  assert.deepEqual(await move(bob, chatId, "decide", { approve: false }), [409, "not_pending"]);
  assert.deepEqual((await bob.get("/api/requests")).json.granted.map((item) => item.id), [chatId]);

  // The owner changes the projects of an approved request only.
  assert.deepEqual(await move(carol, chatId, "projects", { projects: ["all"] }), [403, "forbidden"]);
  assert.deepEqual(await move(bob, chatId, "projects", {}), [400, "bad_request"]);
  assert.deepEqual(await move(bob, collectId, "projects", { projects: ["honcho"] }), [409, "not_approved"]);
  const narrowed = await bob.post(`/api/requests/${chatId}/projects`, { projects: ["honcho"] });
  assert.deepEqual(narrowed.json.request.projects, ["honcho"]);

  // The sender cancels only while pending; the owner declines.
  assert.deepEqual(await move(carol, chatId, "cancel"), [409, "not_pending"]);
  assert.deepEqual(await move(bob, collectId, "cancel"), [403, "forbidden"]);
  assert.deepEqual(await move(bob, collectId, "decide", { approve: false, projects: ["ignored"] }), [200, "declined"]);
  assert.deepEqual(f.data.get(`request:${collectId}`).projects, []);
  assert.deepEqual((await carol.get("/api/requests")).json.outgoing.map((item) => item.status), ["declined", "approved"]);

  // The sender dismisses what the bell showed.
  assert.deepEqual(await move(dave, collectId, "dismiss"), [403, "forbidden"]);
  const dismissed = await carol.post(`/api/requests/${collectId}/dismiss`);
  assert.equal(dismissed.status, 200);
  assert.ok(dismissed.json.request.dismissedAt);
  assert.deepEqual((await carol.get("/api/requests")).json.outgoing.map((item) => item.id), [chatId]);

  // The owner revokes an approved request.
  assert.deepEqual(await move(carol, chatId, "revoke"), [403, "forbidden"]);
  const revoked = await bob.post(`/api/requests/${chatId}/revoke`);
  assert.equal(revoked.json.request.status, "revoked");
  assert.ok(revoked.json.request.revokedAt);
  assert.deepEqual(await move(bob, chatId, "revoke"), [409, "not_approved"]);
  assert.deepEqual((await bob.get("/api/requests")).json.granted, []);

  // A new request once the old one is over; cancelled ones leave the sender's list.
  const fresh = await carol.post("/api/requests", { kind: "chat", server: bobs.host });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.json.request.id, chatId);
  assert.equal(fresh.json.request.fromPeer, "carol");
  assert.deepEqual(await move(carol, fresh.json.request.id, "cancel"), [200, "cancelled"]);
  assert.ok(!(await carol.get("/api/requests")).json.outgoing.some((item) => item.id === fresh.json.request.id));

  assert.deepEqual(await move(bob, "r-0000000000000000", "revoke"), [404, "not_found"]);
  assert.deepEqual(await move(bob, "not-an-id", "revoke"), [404, "not_found"]);
  assert.equal((await bob.post(`/api/requests/${chatId}/approve`)).status, 404);
});

// ----------------------------------------------------------------- admin

test("admins add people to the people policy and the roster; others may not", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob" });
  for (const [method, pathname, body] of [
    ["GET", "/api/admin/people"],
    ["POST", "/api/admin/people", { email: "mate@example.com" }],
    ["DELETE", "/api/admin/people/admin%40example.com"],
    ["PUT", "/api/admin/people/bob%40example.com", { admin: true }],
    ["PUT", "/api/admin/team", { name: "다른 이름" }],
  ]) {
    const answer = await f.send(pathname, { method, as: "bob@example.com", body });
    assert.equal(answer.status, 403, `${method} ${pathname}`);
    assert.equal(answer.json.error, "not_admin");
  }

  assert.equal((await f.as(ADMIN).post("/api/admin/people", { email: "not an email" })).status, 400);
  const added = await f.as(ADMIN).post("/api/admin/people", { email: " Mate@Example.com " });
  assert.equal(added.status, 201);
  assert.deepEqual({ ...added.json.person, addedAt: "a" }, {
    email: "mate@example.com", peer: null, admin: false, joined: false, servers: [], addedAt: "a", addedBy: ADMIN, lastLoginAt: null,
  });
  assert.deepEqual(f.people(), [ADMIN, "bob@example.com", "mate@example.com"]);

  const writes = f.cf.writes().length;
  const again = await f.as(ADMIN).post("/api/admin/people", { email: "mate@example.com" });
  assert.equal(again.status, 200, "an existing member is left as it is");
  assert.deepEqual(again.json.person, added.json.person);
  assert.equal(f.cf.writes().length, writes);

  await f.as("mate@example.com").get("/api/me");
  const listed = await f.as(ADMIN).get("/api/admin/people");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.people.map((person) => [person.email, person.admin, person.joined, person.addedBy]), [
    [ADMIN, true, false, "setup"],
    ["bob@example.com", false, false, ADMIN],
    ["mate@example.com", false, true, ADMIN],
  ]);
  for (const person of listed.json.people) {
    assert.deepEqual(Object.keys(person), ["email", "peer", "admin", "joined", "servers", "addedAt", "addedBy", "lastLoginAt"]);
  }
  assert.ok(listed.json.people[2].lastLoginAt);
});

test("removing a person takes them out of the people policy and the roster, removes their server and ends their requests", async (t) => {
  const f = await hubFixture(t, { admins: [ADMIN, "boss@example.com"] });
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": "carol" });
  const company = (await f.as(ADMIN).post("/api/servers", { workspace: WORKSPACE })).json.server;
  const bobs = (await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE })).json.server;
  const fromBobPending = (await f.as("bob@example.com").post("/api/requests", { kind: "collect", server: company.host })).json.request;
  const fromBobApproved = (await f.as("bob@example.com").post("/api/requests", { kind: "chat", server: company.host })).json.request;
  await f.as(ADMIN).post(`/api/requests/${fromBobApproved.id}/decide`, { approve: true, projects: ["honcho"] });
  const toBob = (await f.as("carol@example.com").post("/api/requests", { kind: "chat", server: bobs.host })).json.request;
  const unrelated = (await f.as("carol@example.com").post("/api/requests", { kind: "chat", server: company.host })).json.request;

  const self = await f.as(ADMIN).delete("/api/admin/people/admin@example.com");
  assert.equal(self.status, 409);
  assert.equal(self.json.error, "own_email");
  assert.equal((await f.as(ADMIN).delete("/api/admin/people/nobody%40example.com")).status, 404);
  assert.equal((await f.as(ADMIN).delete("/api/admin/people/not-an-email")).status, 404);

  const removed = await f.as(ADMIN).delete("/api/admin/people/Bob%40Example.com");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { removed: "bob@example.com" });
  assert.deepEqual(f.people(), [ADMIN, "boss@example.com", "carol@example.com"]);
  assert.equal(f.data.has("person:bob@example.com"), false);
  assert.equal(f.data.has(`server:${bobs.host}`), false);
  assert.ok(f.tunnel(bobs.tunnelId).deleted_at);
  assert.equal(f.cf.state.records.some((record) => record.name === bobs.host), false);
  assert.deepEqual(f.serversApp().destinations.map((item) => item.uri), [company.host]);
  const status = (request) => f.data.get(`request:${request.id}`).status;
  assert.deepEqual([status(fromBobPending), status(fromBobApproved), status(toBob), status(unrelated)], ["cancelled", "revoked", "cancelled", "pending"]);
  assert.ok(f.data.get(`request:${fromBobApproved.id}`).revokedAt);
  // The policy changes before anything else.
  const writes = f.cf.writes();
  const policyWrite = writes.lastIndexOf(`PUT /accounts/${ACCOUNT_ID}/access/policies/${PEOPLE_POLICY_ID}`);
  assert.ok(policyWrite >= 0 && policyWrite < writes.indexOf(`DELETE /accounts/${ACCOUNT_ID}/cfd_tunnel/${bobs.tunnelId}`));

  const after = await f.as("bob@example.com").get("/api/me");
  assert.deepEqual([after.json.member, after.json.servers], [false, []]);
  assert.equal((await f.as("bob@example.com").get("/api/team")).status, 403);
  // Their peer is free again.
  await f.addPeople({ "bob@example.org": "bob" });

  // Another admin can be removed; then the one left is the last.
  assert.equal((await f.as(ADMIN).delete("/api/admin/people/boss%40example.com")).status, 200);
  assert.deepEqual([...f.data.values()].filter((value) => value.admin).map((value) => value.email), [ADMIN]);
});

test("an admin makes a teammate an admin or takes it away from another admin, never from themselves", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": "carol" });
  const writes = f.cf.writes().length;
  const admins = () => [...f.data.values()].filter((value) => value.email && value.admin).map((value) => value.email).sort();

  assert.equal((await f.as(ADMIN).put("/api/admin/people/bob%40example.com", { admin: "yes" })).status, 400);
  assert.equal((await f.as(ADMIN).put("/api/admin/people/bob%40example.com", {})).status, 400);
  assert.equal((await f.as(ADMIN).put("/api/admin/people/nobody%40example.com", { admin: true })).status, 404);
  assert.equal((await f.as(ADMIN).put("/api/admin/people/not-an-email", { admin: true })).status, 404);
  const self = await f.as("carol@example.com").put("/api/admin/people/carol%40example.com", { admin: true });
  assert.deepEqual([self.status, self.json.error], [403, "not_admin"]);

  const made = await f.as(ADMIN).put("/api/admin/people/Bob%40Example.com", { admin: true });
  assert.equal(made.status, 200);
  assert.deepEqual([made.json.person.email, made.json.person.admin, made.json.person.peer, made.json.person.addedBy], ["bob@example.com", true, "bob", ADMIN]);
  assert.deepEqual(Object.keys(made.json.person), ["email", "peer", "admin", "joined", "servers", "addedAt", "addedBy", "lastLoginAt"]);
  assert.deepEqual(admins(), [ADMIN, "bob@example.com"]);
  assert.equal((await f.as("bob@example.com").get("/api/me")).json.admin, true);
  assert.equal((await f.as("bob@example.com").get("/api/admin/people")).status, 200);
  const again = await f.as(ADMIN).put("/api/admin/people/bob%40example.com", { admin: true });
  assert.deepEqual([again.status, again.json.person.admin], [200, true], "an admin already is left as it is");

  // No one takes it from themselves; another admin can, and the one left keeps it.
  const own = await f.as(ADMIN).put("/api/admin/people/admin%40example.com", { admin: false });
  assert.deepEqual([own.status, own.json.error], [409, "own_email"]);
  assert.equal((await f.as(ADMIN).put("/api/admin/people/admin%40example.com", { admin: true })).status, 200);
  const taken = await f.as("bob@example.com").put("/api/admin/people/admin%40example.com", { admin: false });
  assert.deepEqual([taken.status, taken.json.person.admin], [200, false]);
  assert.deepEqual(admins(), ["bob@example.com"]);
  assert.equal((await f.as(ADMIN).get("/api/admin/people")).json.error, "not_admin");
  assert.equal((await f.as(ADMIN).get("/api/me")).json.member, true, "still on the team");
  assert.equal((await f.as("bob@example.com").put("/api/admin/people/bob%40example.com", { admin: false })).json.error, "own_email");

  // Two admins taking it from each other at once: one goes first, and the other is no longer an admin.
  assert.equal((await f.as("bob@example.com").put("/api/admin/people/carol%40example.com", { admin: true })).status, 200);
  const both = await Promise.all([
    f.as("bob@example.com").put("/api/admin/people/carol%40example.com", { admin: false }),
    f.as("carol@example.com").put("/api/admin/people/bob%40example.com", { admin: false }),
  ]);
  assert.deepEqual(both.map((answer) => answer.status).sort(), [200, 403]);
  assert.equal(both.find((answer) => answer.status === 403).json.error, "not_admin");
  assert.equal(admins().length, 1);
  assert.equal(f.cf.writes().length, writes, "Cloudflare is not asked: the people policy has them already");
});

test("each email TEAM names is made an admin once: a new deploy's email is added, and an admin taken off or removed stays so", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob" });
  const person = (email) => f.data.get(`person:${email}`) || null;

  // team make again, naming bob: a member already, who becomes an admin.
  f.redeploy({ admins: ["Bob@Example.com"] });
  assert.equal((await f.as("bob@example.com").get("/api/me")).json.admin, true);
  assert.deepEqual([person(ADMIN).admin, person("bob@example.com").addedBy], [true, ADMIN]);
  assert.deepEqual(f.data.get("meta").seededAdmins, [ADMIN, "bob@example.com"]);

  // Naming someone not on the roster yet puts them on it as an admin.
  f.redeploy({ admins: ["new@example.com"] });
  await f.as(ADMIN).get("/api/me");
  assert.deepEqual({ ...person("new@example.com"), addedAt: "x" }, {
    email: "new@example.com", peer: null, admin: true, addedAt: "x", addedBy: "setup", firstLoginAt: null, lastLoginAt: null,
  });

  // Taken off as admin, or removed: the same names in a later deploy change nothing.
  assert.equal((await f.as(ADMIN).put("/api/admin/people/bob%40example.com", { admin: false })).status, 200);
  assert.equal((await f.as(ADMIN).delete("/api/admin/people/new%40example.com")).status, 200);
  f.redeploy({ admins: [ADMIN, "bob@example.com", "new@example.com"] });
  await f.as(ADMIN).get("/api/me");
  assert.equal(person("bob@example.com").admin, false);
  assert.equal(person("new@example.com"), null);
  assert.deepEqual(f.data.get("meta").seededAdmins, [ADMIN, "bob@example.com", "new@example.com"]);
});

test("a hub made before seededAdmins counts its setup admin as made; an email named for the first time is made an admin", async (t) => {
  const f = await hubFixture(t);
  // What the hub kept before: its first admin, a member, and meta without seededAdmins.
  const old = { peer: null, addedAt: "2026-10-01T00:00:00.000Z", firstLoginAt: null, lastLoginAt: null };
  f.data.set("meta", { name: "예시 팀", createdAt: "2026-10-01T00:00:00.000Z" });
  f.data.set(`person:${ADMIN}`, { ...old, email: ADMIN, admin: true, addedBy: "setup" });
  f.data.set("person:bob@example.com", { ...old, email: "bob@example.com", admin: false, addedBy: ADMIN });

  // The same admin named again: no one changes, and the hub remembers it.
  assert.equal((await f.as("bob@example.com").get("/api/me")).json.admin, false);
  assert.deepEqual(f.data.get("meta"), { name: "예시 팀", createdAt: "2026-10-01T00:00:00.000Z", seededAdmins: [ADMIN] });

  // team make again naming the member: they become an admin, and the first one stays one.
  f.redeploy({ admins: ["bob@example.com"] });
  assert.equal((await f.as("bob@example.com").get("/api/me")).json.admin, true);
  assert.equal(f.data.get(`person:${ADMIN}`).admin, true);
  assert.deepEqual(f.data.get("meta").seededAdmins, [ADMIN, "bob@example.com"]);
});

test("an admin renames the team; bodies, routes and settings that are wrong get a JSON answer saying so", async (t) => {
  const f = await hubFixture(t);
  const renamed = await f.as(ADMIN).put("/api/admin/team", { name: "  새 팀 이름  " });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.json, { team: { name: "새 팀 이름", host: HUB_HOST, zone: ZONE } });
  assert.equal((await f.as(ADMIN).get("/api/me")).json.team.name, "새 팀 이름");
  for (const name of ["", "   ", "가".repeat(61), "a\u0000b", "a‮b", 7]) {
    assert.equal((await f.as(ADMIN).put("/api/admin/team", { name })).status, 400, JSON.stringify(name));
  }
  assert.equal((await f.as(ADMIN).put("/api/admin/team", { name: "가".repeat(60) })).status, 200);

  assert.deepEqual([(await f.as(ADMIN).post("/api/me", "[1, 2]")).json.error, (await f.as(ADMIN).post("/api/me", "{")).json.error], ["bad_request", "bad_request"]);
  const big = await f.as(ADMIN).post("/api/me", JSON.stringify({ peer: "x".repeat(70_000) }));
  assert.equal(big.status, 413);
  assert.equal(big.json.error, "too_large");

  const missing = await f.as(ADMIN).get("/api/nothing");
  assert.deepEqual([missing.status, missing.json.error], [404, "not_found"]);
  const method = await f.as(ADMIN).delete("/api/team");
  assert.deepEqual([method.status, method.json.error], [405, "method_not_allowed"]);
  assert.equal((await f.as(ADMIN).delete("/api/servers/%E0%A4%A")).status, 404);

  const broken = await hubFixture(t, { env: { TEAM: "{not json" } });
  const answer = await broken.as(ADMIN).get("/api/me");
  assert.deepEqual([answer.status, answer.json.error], [500, "misconfigured"]);
});

// ------------------------------------------------------------- the Jev guard

const JEV_KEY = "ts-jev-key-0123456789abcdef";
const NEXT_JEV_KEY = "ts-jev-key-fedcba9876543210";
const GUARD_QUESTION = "Is this query asking for private personal life, credentials, financial or health details about the memory owner, rather than shared work context (projects, code, decisions, schedules, documents)?";
const GUARD_TRUE = "The query targets private personal matters, secrets, or credentials.";
const GUARD_FALSE = "The query is about work the team shares, or is general and harmless.";
const ANSWER_QUESTION = "A teammate asked the memory owner's work memory a question and will read this answer. Does the answer disclose private personal life, credentials or secrets, financial or health details about the owner or any person, rather than shared work context (projects, code, decisions, schedules, documents)?";
const ANSWER_TRUE = "The answer discloses private personal matters, secrets, credentials, financial or health details.";
const ANSWER_FALSE = "The answer only covers shared work context, or is general and harmless.";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const jevAnswer = (noul, name = "out_of_scope") => ({ model: "jev-1.13.0", answers: { [name]: { type: "noul", noul } }, usage: { input_tokens: 335, output_tokens: 22 } });

/**
 * Jev, as a local server: every request it got (method, path, headers, raw body),
 * and the answer it gives, which a test changes. Answers queued in `next` go first,
 * one a request, each { status, body }. With hang it never answers; the next `drop`
 * requests it cuts off without an answer.
 */
async function startFakeJev(t) {
  const jev = { seen: [], status: 200, body: jevAnswer(0.02), headers: {}, hang: false, next: [], drop: 0 };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    jev.seen.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (jev.hang) return;
    if (jev.drop > 0) {
      jev.drop -= 1;
      request.socket.destroy();
      return;
    }
    const { status, body } = jev.next.shift() || jev;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", ...jev.headers });
    response.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  jev.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return jev;
}

/** A hub whose Jev is the fake, with bob's server and its guard token, and the key set. */
async function guardFixture(t, { key = JEV_KEY } = {}) {
  const jev = await startFakeJev(t);
  const f = await hubFixture(t, { env: { JEV_API_BASE: jev.url } });
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": "carol" });
  const server = (await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE })).json.server;
  const issued = await issueGuard(f, "bob@example.com");
  assert.equal(issued.status, 200);
  if (key) assert.equal((await f.as(ADMIN).put("/api/admin/jev", { key })).status, 200);
  /** POST /guard as a server does: no Access login, the guard token as a bearer. */
  const ask = (body, { token = issued.json.token, method = "POST", headers = {} } = {}) => f.send("/guard", {
    method,
    body,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
  });
  return { ...f, jev, server, token: issued.json.token, ask };
}

/** Every value the hub keeps, as one string, to look for what must never be kept. */
const kept = (f) => JSON.stringify([...f.data.entries()]);

/** The tunnel `email`'s server runs now, as the hub keeps it; undefined without a server. */
const ownTunnel = (f, email) => [...f.data.entries()].find(([key, value]) => key.startsWith("server:") && value.owner === email)?.[1].tunnelId;

/** POST /api/me/guard from `email`'s computer, naming the tunnel it runs (its server's, unless `body` says otherwise). */
const issueGuard = (f, email, body) => f.as(email).post("/api/me/guard", body ?? { tunnelId: ownTunnel(f, email) });

test("an admin sets, replaces and clears the team's Jev key, and no answer carries it", async (t) => {
  const f = await hubFixture(t);
  await f.addPeople({ "bob@example.com": "bob" });
  const answers = [];
  const admin = async (method, body) => {
    const answer = await f.send("/api/admin/jev", { method, as: ADMIN, body });
    answers.push(answer.text);
    return answer;
  };

  const none = await admin("GET");
  assert.deepEqual([none.status, none.json], [200, { set: false, setAt: null, setBy: null }]);

  const set = await admin("PUT", { key: `  ${JEV_KEY}\n` });
  assert.equal(set.status, 200);
  assert.deepEqual(Object.keys(set.json), ["set", "setAt", "setBy"]);
  assert.equal(set.json.set, true);
  assert.equal(set.json.setBy, ADMIN);
  assert.ok(!Number.isNaN(Date.parse(set.json.setAt)));
  assert.deepEqual(f.data.get("jev"), { key: JEV_KEY, setAt: set.json.setAt, setBy: ADMIN }, "kept trimmed");
  assert.deepEqual((await admin("GET")).json, set.json);

  const replaced = await admin("PUT", { key: NEXT_JEV_KEY });
  assert.equal(replaced.status, 200);
  assert.equal(f.data.get("jev").key, NEXT_JEV_KEY);

  for (const key of ["", "   ", "short-7", "has a space", "tab\tin-it-here", "탭이없는한글키값입니다", "é".repeat(10), "x".repeat(1025), 12345678, null, ["x".repeat(10)]]) {
    const refused = await admin("PUT", { key });
    assert.deepEqual([refused.status, refused.json.error], [400, "bad_request"], JSON.stringify(key));
  }
  assert.equal((await admin("PUT", {})).status, 400);
  assert.equal(f.data.get("jev").key, NEXT_JEV_KEY, "a refused key changes nothing");
  // Every printable ASCII character but the space, from 8 to 1024 of them.
  for (const key of ["x".repeat(8), "x".repeat(1024), `quote"dollar$hash#back\\slash'tick\`~!`]) {
    assert.equal((await admin("PUT", { key })).status, 200, key.slice(0, 20));
    assert.equal(f.data.get("jev").key, key);
  }
  assert.equal((await admin("PUT", { key: NEXT_JEV_KEY })).status, 200);

  // Only an admin, with the same refusals as the other admin routes.
  for (const [email, code] of [["bob@example.com", "not_admin"], ["stranger@example.com", "not_member"]]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const answer = await f.send("/api/admin/jev", { method, as: email, body: method === "PUT" ? { key: JEV_KEY } : undefined });
      assert.deepEqual([answer.status, answer.json.error], [403, code], `${method} ${email}`);
      answers.push(answer.text);
    }
  }
  assert.equal(f.data.get("jev").key, NEXT_JEV_KEY);
  assert.equal((await f.send("/api/admin/jev")).status, 401);
  assert.equal((await f.as(ADMIN).post("/api/admin/jev", { key: JEV_KEY })).status, 405);

  // Nothing a member or an admin reads carries it either.
  for (const pathname of ["/api/me", "/api/team", "/api/admin/people", "/"]) {
    answers.push((await f.as(ADMIN).get(pathname)).text, (await f.as("bob@example.com").get(pathname)).text);
  }
  for (const pathname of ["/api/jev", "/api/me/jev"]) {
    assert.equal((await f.as("bob@example.com").get(pathname)).status, 404, `${pathname}: no route hands the key out`);
  }

  const cleared = await admin("DELETE");
  assert.deepEqual([cleared.status, cleared.json], [200, { set: false, setAt: null, setBy: null }]);
  assert.equal(f.data.has("jev"), false);
  assert.equal((await admin("DELETE")).status, 200, "clearing twice is fine");
  assert.deepEqual((await admin("GET")).json, { set: false, setAt: null, setBy: null });

  for (const text of answers) {
    assert.equal(text.includes(JEV_KEY) || text.includes(NEXT_JEV_KEY), false, text.slice(0, 120));
  }
});

test("POST /api/me/guard gives the caller's own server a guard token; a new one ends the old", async (t) => {
  const jev = await startFakeJev(t);
  const f = await hubFixture(t, { env: { JEV_API_BASE: jev.url } });
  await f.addPeople({ "bob@example.com": "bob", "carol@example.com": "carol" });

  assert.deepEqual([(await f.send("/api/me/guard", { method: "POST" })).status], [401]);
  const stranger = await issueGuard(f, "stranger@example.com");
  assert.deepEqual([stranger.status, stranger.json.error], [403, "not_member"]);
  const serverless = await issueGuard(f, "carol@example.com");
  assert.deepEqual([serverless.status, serverless.json.error], [404, "no_server"]);
  assert.equal((await f.as("bob@example.com").get("/api/me/guard")).status, 405);

  const bobs = (await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE })).json.server;
  // Another site's page cannot get one with bob's cookie.
  const crossSite = await f.as("bob@example.com").post("/api/me/guard", {}, { headers: { origin: "https://evil.example" } });
  assert.deepEqual([crossSite.status, crossSite.json.error], [403, "cross_site"]);

  // Only the computer running the server's tunnel gets a token, and it has to say which.
  const unnamed = await issueGuard(f, "bob@example.com", {});
  assert.deepEqual([unnamed.status, unnamed.json.error], [400, "bad_request"]);
  const elsewhere = await issueGuard(f, "bob@example.com", { tunnelId: "0b5e6f1c-0000-4000-8000-000000000000" });
  assert.deepEqual([elsewhere.status, elsewhere.json.error], [409, "other_computer"]);
  assert.equal(elsewhere.text.includes(bobs.tunnelId), false, "the answer does not name the right tunnel");
  assert.equal("guardHash" in f.data.get(`server:${bobs.host}`), false);

  const first = await issueGuard(f, "bob@example.com");
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.json), ["url", "token", "host", "jev"]);
  assert.deepEqual({ ...first.json, token: "t" }, { url: `https://${HUB_HOST}/guard`, token: "t", host: bobs.host, jev: { set: false } });
  assert.match(first.json.token, /^[0-9a-f]{64}$/);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const record = f.data.get(`server:${bobs.host}`);
  assert.equal(record.guardHash, sha256(first.json.token));
  assert.ok(!Number.isNaN(Date.parse(record.guardIssuedAt)));
  assert.deepEqual({ ...record, guardHash: "h", guardIssuedAt: "i" }, { ...bobs, guardHash: "h", guardIssuedAt: "i" }, "nothing else of the server changes");
  assert.deepEqual(f.data.get(`guard:${record.guardHash}`), { host: bobs.host });
  assert.equal(kept(f).includes(first.json.token), false, "the hub keeps the hash, not the token");

  // The owner sees when the token was made, never its hash, nor the token again.
  const me = await f.as("bob@example.com").get("/api/me");
  assert.deepEqual(me.json.servers, [{ ...bobs, guardIssuedAt: record.guardIssuedAt }]);
  for (const answer of [me, await f.as("carol@example.com").get("/api/team"), await f.as(ADMIN).get("/api/admin/people")]) {
    assert.equal(answer.text.includes(first.json.token) || answer.text.includes(record.guardHash), false);
  }
  const again = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE });
  assert.equal(again.json.error, "server_exists");
  assert.equal("guardHash" in again.json.server, false);

  assert.equal((await f.send("/guard", { method: "POST", body: { query: "회의록 요약" }, headers: { authorization: `Bearer ${first.json.token}` } })).status, 200);

  // A new token: the old one stops, the new one works, and with a key the answer says so.
  assert.equal((await f.as(ADMIN).put("/api/admin/jev", { key: JEV_KEY })).status, 200);
  await pause(5);
  const second = await issueGuard(f, "bob@example.com");
  assert.equal(second.status, 200);
  assert.notEqual(second.json.token, first.json.token);
  assert.deepEqual(second.json.jev, { set: true });
  assert.equal(second.text.includes(JEV_KEY), false);
  const next = f.data.get(`server:${bobs.host}`);
  assert.equal(next.guardHash, sha256(second.json.token));
  assert.ok(next.guardIssuedAt > record.guardIssuedAt);
  assert.equal(f.data.has(`guard:${record.guardHash}`), false, "the old index entry is gone");
  assert.deepEqual([...f.data.keys()].filter((key) => key.startsWith("guard:")), [`guard:${next.guardHash}`]);
  const old = await f.send("/guard", { method: "POST", body: { query: "회의록 요약" }, headers: { authorization: `Bearer ${first.json.token}` } });
  assert.deepEqual([old.status, old.json.error], [401, "bad_token"]);
  const fresh = await f.send("/guard", { method: "POST", body: { query: "회의록 요약" }, headers: { authorization: `Bearer ${second.json.token}` } });
  assert.deepEqual([fresh.status, fresh.json.judged], [200, true]);
  assert.equal(f.blocks.threw, 0);
});

test("POST /guard, with no Access login, asks Jev with the team's key and says whether the question may go on", async (t) => {
  const f = await guardFixture(t);
  const question = { tool: "chat", caller: "carol@example.com", workspace: WORKSPACE, query: "밥의 다음 주 배포 일정은?" };
  const names = f.names.length;

  const allowed = await f.ask(question);
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.json, { judged: true, checked: "query", allowed: true, score: 0.02, threshold: 0.7 });
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.ok(f.names.length > names, "it reached the Durable Object without any assertion");

  // What Jev got: the documented request, the key as a bearer, and nothing else of the team.
  assert.equal(f.jev.seen.length, 1);
  const [call] = f.jev.seen;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/v1/systemone");
  assert.equal(call.headers.authorization, `Bearer ${JEV_KEY}`);
  assert.equal(call.headers["content-type"], "application/json");
  assert.equal(call.headers.accept, "application/json");
  assert.equal(call.body, JSON.stringify({
    state: { tool: "chat", caller: "carol@example.com", workspace: WORKSPACE, query: "밥의 다음 주 배포 일정은?" },
    model: "jev-latest",
    questions: { out_of_scope: { type: "noul", instructions: GUARD_QUESTION, criteria: { true: GUARD_TRUE, false: GUARD_FALSE } } },
  }));

  // The Durable Object heard x-hub-guard alone, whatever x-hub-* the caller sent.
  const spoofed = await f.ask(question, { headers: { "x-hub-email": ADMIN, "x-hub-guard": "0", "X-Hub-Admin": "true" } });
  assert.equal(spoofed.status, 200);
  const heard = f.received.at(-1).headers;
  assert.deepEqual([...heard.keys()].filter((name) => name.startsWith("x-hub-")), ["x-hub-guard"]);
  assert.equal(heard.get("x-hub-guard"), "1");

  // A score of 0.7 or more stops the question.
  for (const [noul, verdict] of [[0.93, false], [0.7, false], [0.6999, true], [0, true]]) {
    f.jev.body = jevAnswer(noul);
    const judged = await f.ask(question);
    assert.deepEqual([judged.status, judged.json], [200, { judged: true, checked: "query", allowed: verdict, score: noul, threshold: 0.7 }], String(noul));
  }

  // Only the query is needed; what is left out is left out of Jev's state too.
  f.jev.body = jevAnswer(0.1);
  assert.equal((await f.ask({ query: "이번 스프린트 결정 사항", tool: null })).status, 200);
  assert.deepEqual(JSON.parse(f.jev.seen.at(-1).body).state, { query: "이번 스프린트 결정 사항" });
  assert.equal((await f.ask({ query: "x".repeat(16_000), caller: "c".repeat(320), tool: "", workspace: "w" })).status, 200);
  assert.deepEqual(JSON.parse(f.jev.seen.at(-1).body).state, { tool: "", caller: "c".repeat(320), workspace: "w", query: "x".repeat(16_000) });

  // A server's call carries no browser cookie, so the cross-site check does not apply.
  const fromPage = await f.ask(question, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
  assert.equal(fromPage.status, 200);

  // The question is never kept, and no answer carries the key.
  assert.equal(kept(f).includes("배포 일정"), false);
  assert.equal(kept(f).includes("스프린트"), false);
  for (const answer of [allowed, spoofed, fromPage]) assert.equal(answer.text.includes(JEV_KEY), false);
});

test("with an answer in the body, /guard asks Jev about the answer and says whether it may go back", async (t) => {
  const f = await guardFixture(t);
  const question = { tool: "chat", caller: "carol@example.com", workspace: WORKSPACE, query: "밥은 요즘 뭐 해?", answer: "밥은 이번 주 결제 모듈 배포를 맡고 있습니다." };

  f.jev.body = jevAnswer(0.03, "sensitive_answer");
  const passed = await f.ask(question);
  assert.deepEqual([passed.status, passed.json], [200, { judged: true, checked: "answer", allowed: true, score: 0.03, threshold: 0.7 }]);
  // Jev got the answer's own question, with the query beside the answer as context.
  assert.equal(f.jev.seen.length, 1);
  assert.equal(f.jev.seen[0].body, JSON.stringify({
    state: { tool: "chat", caller: "carol@example.com", workspace: WORKSPACE, query: "밥은 요즘 뭐 해?", answer: "밥은 이번 주 결제 모듈 배포를 맡고 있습니다." },
    model: "jev-latest",
    questions: { sensitive_answer: { type: "noul", instructions: ANSWER_QUESTION, criteria: { true: ANSWER_TRUE, false: ANSWER_FALSE } } },
  }));

  // The same threshold: 0.7 or more holds the answer back.
  for (const [noul, verdict] of [[0.97, false], [0.7, false], [0.6999, true]]) {
    f.jev.body = jevAnswer(noul, "sensitive_answer");
    const judged = await f.ask(question);
    assert.deepEqual([judged.status, judged.json], [200, { judged: true, checked: "answer", allowed: verdict, score: noul, threshold: 0.7 }], String(noul));
  }

  // Beside an answer the query may be left out, and an answer may be as long as a query.
  f.jev.body = jevAnswer(0.05, "sensitive_answer");
  assert.equal((await f.ask({ answer: "배포는 금요일입니다." })).status, 200);
  assert.deepEqual(JSON.parse(f.jev.seen.at(-1).body).state, { answer: "배포는 금요일입니다." });
  assert.equal((await f.ask({ query: null, answer: "가".repeat(16_000) })).status, 200);
  assert.deepEqual(JSON.parse(f.jev.seen.at(-1).body).state, { answer: "가".repeat(16_000) });

  // A score for the query's question is no score for the answer.
  f.jev.body = jevAnswer(0.01);
  const unscored = await f.ask(question);
  assert.deepEqual([unscored.status, unscored.json.error, unscored.json.detail], [502, "jev_failed", "Jev's answer held no score for the answer"]);

  // Neither is kept.
  assert.equal(kept(f).includes("결제 모듈"), false);
  assert.equal(kept(f).includes("금요일"), false);
});

test("without a Jev key, /guard lets the question go on unjudged and asks no one", async (t) => {
  const f = await guardFixture(t, { key: null });
  const answer = await f.ask({ query: "회의록 요약해 줘" });
  assert.deepEqual([answer.status, answer.json], [200, { judged: false, checked: "query", allowed: true, score: null, reason: "no_key" }]);
  assert.equal(f.jev.seen.length, 0);

  // A key cleared later is the same.
  assert.equal((await f.as(ADMIN).put("/api/admin/jev", { key: JEV_KEY })).status, 200);
  assert.equal((await f.ask({ query: "회의록 요약해 줘" })).json.judged, true);
  assert.equal((await f.as(ADMIN).delete("/api/admin/jev")).status, 200);
  assert.deepEqual((await f.ask({ query: "회의록 요약해 줘" })).json, { judged: false, checked: "query", allowed: true, score: null, reason: "no_key" });
  assert.equal(f.jev.seen.length, 1);

  // An answer is let go the same way, and the hub says it was the answer it did not judge.
  const unjudged = await f.ask({ query: "회의록 요약해 줘", answer: "지난 회의에서 배포를 미루기로 했습니다." });
  assert.deepEqual([unjudged.status, unjudged.json], [200, { judged: false, checked: "answer", allowed: true, score: null, reason: "no_key" }]);
  assert.equal(f.jev.seen.length, 1);
});

test("/guard refuses another method, a missing or wrong token, and a wrong body", async (t) => {
  const f = await guardFixture(t);
  for (const method of ["GET", "PUT", "DELETE"]) {
    const answer = await f.ask(method === "PUT" ? { query: "x" } : undefined, { method });
    assert.deepEqual([answer.status, answer.json.error], [405, "method_not_allowed"], method);
  }

  const unknown = crypto.randomBytes(32).toString("hex");
  for (const headers of [
    {},
    { authorization: "" },
    { authorization: "Bearer" },
    { authorization: `Basic ${f.token}` },
    { authorization: `Bearer ${f.token.slice(1)}` },
    { authorization: `Bearer ${f.token}x` },
    { authorization: `Bearer ${unknown}` },
    { authorization: `Bearer ${f.data.get(`server:${f.server.host}`).guardHash}` },
  ]) {
    const answer = await f.ask({ query: "x" }, { token: null, headers });
    assert.deepEqual([answer.status, answer.json.error], [401, "bad_token"], JSON.stringify(headers).slice(0, 60));
  }
  assert.equal((await f.ask({ query: "x" }, { token: null, headers: { authorization: `bearer  ${f.token}` } })).status, 200, "the scheme in any case");

  const seen = f.jev.seen.length;
  for (const body of [
    {},
    { query: "" },
    { query: "  \n " },
    { query: 5 },
    { query: ["x"] },
    { query: "x".repeat(16_001) },
    { query: "x", tool: 5 },
    { query: "x", caller: "c".repeat(321) },
    { query: "x", workspace: { name: "memory" } },
    { answer: "" },
    { answer: " \n" },
    { answer: 5 },
    { answer: ["x"] },
    { answer: "x".repeat(16_001) },
    { answer: "x", query: "" },
    { answer: "x", query: 5 },
    { answer: "x", query: "x".repeat(16_001) },
    { answer: "x", caller: 5 },
    "[1, 2]",
    "{",
  ]) {
    const answer = await f.ask(body);
    assert.deepEqual([answer.status, answer.json.error], [400, "bad_request"], JSON.stringify(body).slice(0, 60));
  }
  assert.equal(f.jev.seen.length, seen, "nothing refused reached Jev");
});

test("a guard token stops with its server: removed, moved to another computer, or its owner off the roster", async (t) => {
  const f = await guardFixture(t);
  const ok = async (token) => (await f.ask({ query: "주간 회의 결정 사항" }, { token })).status;
  assert.equal(await ok(f.token), 200);

  // Moved: the replaced record has no guard token, and the old computer's stops.
  const oldHash = sha256(f.token);
  const moved = await f.as("bob@example.com").post("/api/servers", { workspace: WORKSPACE, replace: true });
  assert.equal(moved.status, 200);
  assert.equal("guardHash" in moved.json.server || "guardIssuedAt" in moved.json.server, false);
  const record = f.data.get(`server:${f.server.host}`);
  assert.equal("guardHash" in record || "guardIssuedAt" in record, false);
  assert.equal(f.data.has(`guard:${oldHash}`), false);
  const stale = await f.ask({ query: "x" });
  assert.deepEqual([stale.status, stale.json.error], [401, "bad_token"]);
  const renewed = (await issueGuard(f, "bob@example.com")).json.token;
  assert.equal(await ok(renewed), 200);
  // The computer it left still names the old tunnel: no token, and the new one's stays.
  assert.notEqual(moved.json.server.tunnelId, f.server.tunnelId);
  const left = await issueGuard(f, "bob@example.com", { tunnelId: f.server.tunnelId });
  assert.deepEqual([left.status, left.json.error], [409, "other_computer"]);
  assert.equal(await ok(renewed), 200);

  // Removed: the index entry goes with the record.
  assert.equal((await f.as("bob@example.com").delete(`/api/servers/${f.server.host}`)).status, 200);
  assert.deepEqual([...f.data.keys()].filter((key) => key.startsWith("guard:")), []);
  assert.equal(await ok(renewed), 401);
  assert.equal((await issueGuard(f, "bob@example.com")).json.error, "no_server");

  // Carol taken off the team: her server goes, and with it her token.
  const carols = (await f.as("carol@example.com").post("/api/servers", { workspace: WORKSPACE })).json.server;
  const carolToken = (await issueGuard(f, "carol@example.com")).json.token;
  assert.equal(await ok(carolToken), 200);
  assert.equal((await f.as(ADMIN).delete("/api/admin/people/carol%40example.com")).status, 200);
  assert.equal(f.data.has(`server:${carols.host}`), false);
  assert.equal(await ok(carolToken), 401);

  // A server whose owner is no longer on the roster (its record outlived them) is refused.
  await f.addPeople({ "dave@example.com": "dave" });
  await f.as("dave@example.com").post("/api/servers", { workspace: WORKSPACE });
  const daveToken = (await issueGuard(f, "dave@example.com")).json.token;
  f.data.delete("person:dave@example.com");
  const orphan = await f.ask({ query: "x" }, { token: daveToken });
  assert.deepEqual([orphan.status, orphan.json.error], [403, "not_member"]);
  assert.equal(f.blocks.threw, 0);
});

test("a server asks /guard at most 240 times in any minute; others are not held back", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await guardFixture(t, { key: null });
  await f.as("carol@example.com").post("/api/servers", { workspace: WORKSPACE });
  const carolToken = (await issueGuard(f, "carol@example.com")).json.token;

  for (let index = 0; index < 240; index += 1) {
    const answer = await f.ask(index % 2 ? { query: `q${index}`, answer: `a${index}` } : { query: `q${index}` });
    assert.equal(answer.status, 200, `call ${index + 1}`);
    if (index === 119) t.mock.timers.tick(30_000);
  }
  const limited = await f.ask({ query: "one more" });
  assert.deepEqual([limited.status, limited.json.error], [429, "rate_limited"]);
  assert.equal((await f.ask({ query: "x" }, { token: carolToken })).status, 200, "the count is per server");
  // A new token is the same server.
  const renewed = (await issueGuard(f, "bob@example.com")).json.token;
  assert.equal((await f.ask({ query: "x" }, { token: renewed })).status, 429);

  // Rolling: the first 120 calls leave the window a minute after they were made.
  t.mock.timers.tick(30_001);
  for (let index = 0; index < 120; index += 1) assert.equal((await f.ask({ query: "x" }, { token: renewed })).status, 200);
  assert.equal((await f.ask({ query: "x" }, { token: renewed })).status, 429);
  t.mock.timers.tick(30_000);
  assert.equal((await f.ask({ query: "x" }, { token: renewed })).status, 200);
});

test("when Jev fails, /guard answers 502 jev_failed, and never with the key", async (t) => {
  const f = await guardFixture(t);
  const question = { query: "지난 회의 요약" };
  const failed = async (pattern, label) => {
    const answer = await f.ask(question);
    assert.deepEqual([answer.status, answer.json.error], [502, "jev_failed"], label);
    assert.match(answer.json.detail, pattern, label);
    assert.equal(answer.text.includes(JEV_KEY), false, label);
    return answer;
  };

  // Jev's own body is not passed on, even when it echoes the key.
  f.jev.status = 500;
  f.jev.body = { error: `invalid key ${JEV_KEY}` };
  let asked = f.jev.seen.length;
  await failed(/^Jev answered HTTP 500$/, "500");
  assert.equal(f.jev.seen.length, asked + 2, "a 5xx is asked once more");
  f.jev.status = 401;
  asked = f.jev.seen.length;
  await failed(/HTTP 401/, "401");
  assert.equal(f.jev.seen.length, asked + 1, "a refusal is not");

  // A redirect is not followed, so the key goes nowhere else.
  f.jev.status = 302;
  f.jev.headers = { location: `${f.jev.url}/elsewhere` };
  const seen = f.jev.seen.length;
  await failed(/HTTP 302/, "redirect");
  assert.equal(f.jev.seen.length, seen + 1);
  f.jev.headers = {};

  f.jev.status = 200;
  for (const [body, label] of [
    ["<html>busy</html>", "not JSON"],
    [{ answers: {} }, "no answer"],
    [{ answers: { out_of_scope: { type: "noul" } } }, "no score"],
    [{ answers: { out_of_scope: { type: "noul", noul: "0.1" } } }, "a string"],
    [{ answers: { out_of_scope: { type: "noul", noul: null } } }, "null"],
    ['{"answers":{"out_of_scope":{"noul":1e999}}}', "infinite"],
    ["null", "null body"],
  ]) {
    f.jev.body = body;
    await failed(/^Jev's answer (was not JSON|held no score for the query)$/, label);
  }

  // Too slow: the hub waits 10 s (shortened here) and gives up.
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const waits = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    waits.push(ms);
    return timeout(ms === 10_000 ? 100 : ms);
  });
  f.jev.hang = true;
  asked = f.jev.seen.length;
  await failed(/^Jev did not answer within 10 s$/, "timeout");
  assert.ok(waits.includes(10_000));
  assert.equal(f.jev.seen.length, asked + 1, "a slow Jev is not asked again");
  f.jev.hang = false;
  AbortSignal.timeout.mock.restore();

  // Nothing listening.
  f.env.JEV_API_BASE = "http://127.0.0.1:9";
  await failed(/^Jev could not be reached$/, "unreachable");

  // After all that, the question was never kept and a working Jev answers again.
  f.env.JEV_API_BASE = f.jev.url;
  f.jev.body = jevAnswer(0.01);
  assert.equal((await f.ask(question)).json.allowed, true);
  assert.equal(kept(f).includes("지난 회의"), false);
  assert.equal(f.blocks.threw, 0);
});

test("a 5xx or a dropped connection from Jev is asked once more before /guard gives up", async (t) => {
  const f = await guardFixture(t);
  const question = { query: "지난 회의 요약", answer: "배포를 한 주 미루기로 했습니다." };
  f.jev.body = jevAnswer(0.04, "sensitive_answer");

  f.jev.next = [{ status: 503, body: { error: "overloaded" } }];
  const after5xx = await f.ask(question);
  assert.deepEqual([after5xx.status, after5xx.json.allowed, after5xx.json.score], [200, true, 0.04]);
  assert.equal(f.jev.seen.length, 2);
  assert.equal(f.jev.seen[1].body, f.jev.seen[0].body, "the same request again");

  f.jev.drop = 1;
  const afterDrop = await f.ask(question);
  assert.deepEqual([afterDrop.status, afterDrop.json.score], [200, 0.04]);
  assert.equal(f.jev.seen.length, 4);

  // Twice is the end of it.
  f.jev.next = [{ status: 502, body: {} }, { status: 503, body: {} }];
  const twice = await f.ask(question);
  assert.deepEqual([twice.status, twice.json.error, twice.json.detail], [502, "jev_failed", "Jev answered HTTP 503"]);
  assert.equal(f.jev.seen.length, 6);
  f.jev.drop = 2;
  const dropped = await f.ask(question);
  assert.deepEqual([dropped.status, dropped.json.detail], [502, "Jev could not be reached"]);
  assert.equal(f.jev.seen.length, 8);

  // A refusal is not asked again: it would be refused again.
  f.jev.next = [{ status: 429, body: {} }];
  assert.equal((await f.ask(question)).json.detail, "Jev answered HTTP 429");
  assert.equal(f.jev.seen.length, 9);
});

test("only /guard itself passes without a login: anything beside or under it still needs Access", async (t) => {
  const f = await guardFixture(t);
  const before = f.names.length;
  for (const pathname of ["/guard/", "/guard/x", "/guardx", "/Guard", "//guard", "/%67uard", "/api/me/guard", "/api/admin/jev", "/"]) {
    for (const method of ["GET", "POST"]) {
      const answer = await f.send(pathname, { method, headers: { authorization: `Bearer ${f.token}` }, body: method === "POST" ? { query: "x" } : undefined });
      assert.equal(answer.status, 401, `${method} ${pathname}`);
    }
  }
  assert.equal(f.names.length, before, "nothing without a login reached the Durable Object");

  // With a login, what is under /guard is not a route of the hub.
  const under = await f.as("bob@example.com").post("/guard/x", { query: "x" });
  assert.deepEqual([under.status, under.json.error], [404, "not_found"]);
  // A query string does not change the path.
  assert.equal((await f.send("/guard?from=test", { method: "POST", body: { query: "x" }, headers: { authorization: `Bearer ${f.token}` } })).status, 200);

  // Someone logged in cannot make another route look like /guard.
  const me = await f.send("/api/me", { as: "bob@example.com", headers: { "x-hub-guard": "1" } });
  assert.deepEqual([me.status, me.json.email], [200, "bob@example.com"]);
  assert.deepEqual([...f.received.at(-1).headers.keys()].filter((name) => name.startsWith("x-hub-")), ["x-hub-email"]);
  // Nor does a login make /guard take anything but a guard token.
  const loggedIn = await f.send("/guard", { method: "POST", as: ADMIN, body: { query: "x" } });
  assert.deepEqual([loggedIn.status, loggedIn.json.error], [401, "bad_token"]);
});
