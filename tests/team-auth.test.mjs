// Signing in to the team for programs: the browser logs in once through Access's
// Managed OAuth, and the app keeps refreshing a short token. What matters: the
// login only finishes for a state this app started, PKCE binds the code to it, a
// token is refreshed before it ends and by one process at a time, a refused
// refresh token means logging in again and is remembered as an ended login, a
// callback that failed is told to the page waiting for it, the hub's login is not
// the servers', and a server's device key goes only to that server.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  accessToken,
  DEVICE_HEADER,
  finishLogin,
  forgetDevice,
  readTeamAuth,
  registerDevice,
  setTeam,
  startLogin,
  teamAuthPaths,
  teamFetch,
  teamHeaders,
  teamHost,
  teamLoginStatus,
} from "../scripts/team-auth.mjs";
import { fakeTeam } from "./fake-team.mjs";

const HUB = "team.example.com";
const SERVER = "memory-me.example.com";
const OTHER = "memory-bob.example.com";
const REDIRECT = "http://127.0.0.1:4180/oauth/callback";

async function tempPaths(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "team-auth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return teamAuthPaths(null, { HONCHO_AGENT_TEAM_AUTH: path.join(dir, "state", "team-auth.json") });
}

function team(extra = {}) {
  const seen = [];
  const handle = (request, { email, url }) => {
    seen.push({ host: url.hostname, path: url.pathname, email, device: request.headers.get(DEVICE_HEADER.toLowerCase()) });
    if (url.pathname === "/team-memory/devices" && request.method === "POST") {
      // As the gate answers: the key is the whole header value.
      return new Response(JSON.stringify({ id: "d-0123456789abcdef", key: `d-0123456789abcdef.${"k".repeat(43)}`, name: "MacBook" }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true, email }), { status: 200 });
  };
  const fake = fakeTeam({
    hosts: {
      [HUB]: { app: "hub", handle },
      [SERVER]: { app: "servers", handle },
      [OTHER]: { app: "servers", handle },
    },
    ...extra,
  });
  return { ...fake, seen };
}

/** A whole browser login: start, the browser's round trip, then the callback. */
async function login(fake, paths, { host = HUB, kind = "hub" } = {}) {
  const started = await startLogin({ host, kind, redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
  const back = new URL(fake.browserLogin(started.url));
  return finishLogin({
    state: back.searchParams.get("state"),
    code: back.searchParams.get("code"),
    error: back.searchParams.get("error"),
    paths,
    fetchImpl: fake.fetch,
  });
}

test("a team host is a bare host name, from a host or an https address", () => {
  assert.equal(teamHost("Team.Example.com"), HUB);
  assert.equal(teamHost("https://team.example.com/"), HUB);
  assert.equal(teamHost("http://team.example.com"), null);
  assert.equal(teamHost("https://team.example.com:8443"), null);
  assert.equal(teamHost("localhost"), null);
  assert.equal(teamHost(""), null);
});

test("a browser login registers the app once, binds the code with PKCE and keeps the tokens", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  const started = await startLogin({ host: HUB, kind: "hub", redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
  const url = new URL(started.url);
  assert.equal(url.hostname, "example-team.cloudflareaccess.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), `https://${HUB}`);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  // Nothing secret travels in the address.
  assert.equal(url.searchParams.has("code_verifier"), false);

  const back = new URL(fake.browserLogin(started.url));
  const done = await finishLogin({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), paths, fetchImpl: fake.fetch });
  assert.deepEqual(done, { ok: true, kind: "hub", host: HUB });
  const auth = await readTeamAuth(paths);
  assert.match(auth.logins.hub.accessToken, /^oauth:/);
  assert.ok(auth.logins.hub.refreshToken);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(paths.authFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(paths.pendingFile)).mode & 0o777, 0o600);
  }

  // The same callback twice, or one this app never started, does nothing.
  await assert.rejects(
    finishLogin({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), paths, fetchImpl: fake.fetch }),
    /not started here/,
  );
  await assert.rejects(finishLogin({ state: "made-up", code: "x", paths, fetchImpl: fake.fetch }), /not started here/);

  // A second login reuses the registered client.
  await login(fake, paths);
  assert.equal(fake.state.registrations, 1);
});

test("a login the person refuses, or one that is not on the list, ends with the reason", async (t) => {
  const paths = await tempPaths(t);
  const fake = team({ people: { hub: null, servers: ["someone@example.com"] } });
  await assert.rejects(login(fake, paths, { host: SERVER, kind: "servers" }), /refused: access_denied/);
  assert.equal((await readTeamAuth(paths)).logins.servers, undefined);
});

test("the login only comes back to this app's own loopback callback", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  for (const redirectUri of ["https://evil.example/oauth/callback", "http://192.168.0.2:4180/oauth/callback", "http://127.0.0.1:4180/elsewhere"]) {
    await assert.rejects(startLogin({ host: HUB, kind: "hub", redirectUri, paths, fetchImpl: fake.fetch }), /loopback/);
  }
});

test("a token near its end is refreshed, once, and a refused refresh token means logging in again", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await login(fake, paths);
  const first = (await readTeamAuth(paths)).logins.hub.accessToken;
  assert.equal(await accessToken({ kind: "hub", paths, fetchImpl: fake.fetch }), first);
  assert.equal(fake.state.refreshes, 0);

  // Fourteen and a half minutes later, two collectors ask at once.
  const later = () => Date.now() + 14.5 * 60_000;
  const [one, two] = await Promise.all([
    accessToken({ kind: "hub", paths, fetchImpl: fake.fetch, now: later }),
    accessToken({ kind: "hub", paths, fetchImpl: fake.fetch, now: later }),
  ]);
  assert.equal(one, two);
  assert.notEqual(one, first);
  assert.equal(fake.state.refreshes, 1, "the second waited for the lock and took the first one's token");

  // Access forgets the refresh token: the login is dropped, and the next ask says so.
  fake.state.refresh.clear();
  await assert.rejects(accessToken({ kind: "hub", paths, fetchImpl: fake.fetch, force: true }), { code: "login_needed", kind: "hub" });
  assert.equal((await readTeamAuth(paths)).logins.hub, undefined);
  await assert.rejects(accessToken({ kind: "hub", paths, fetchImpl: fake.fetch }), { code: "login_needed", kind: "hub" });
});

test("a login Access stops refreshing is remembered as ended, with whose it was, until the next login", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths });
  await login(fake, paths);
  // The team moved to another Google login: Access refuses the old refresh token.
  fake.state.refresh.clear();
  await assert.rejects(teamFetch(`https://${HUB}/api/me`, {}, { paths, fetchImpl: fake.fetch, now: () => Date.now() + 20 * 60_000 }), { code: "login_needed", kind: "hub", host: HUB });
  const status = await teamLoginStatus({ paths });
  assert.equal(status.hubLogin.signedIn, false);
  assert.equal(status.hubLogin.ended.email, "me@example.com");
  assert.equal(status.hubLogin.ended.host, HUB);
  assert.ok(Date.parse(status.hubLogin.ended.at));
  assert.equal(status.serversLogin.ended, undefined, "only the login that ended");
  // Asked again, it still says which login and where, so the screens can offer it.
  await assert.rejects(teamFetch(`https://${HUB}/api/me`, {}, { paths, fetchImpl: fake.fetch }), { code: "login_needed", kind: "hub", host: HUB });

  await login(fake, paths);
  const again = await teamLoginStatus({ paths });
  assert.equal(again.hubLogin.signedIn, true);
  assert.equal(again.hubLogin.ended, undefined, "logging in again clears it");
});

test("Access down while refreshing keeps the login and says so, not that it ended", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await login(fake, paths);
  const down = async (input, init) => (new URL(typeof input === "string" ? input : input.url).pathname.endsWith("/token")
    ? new Response("{}", { status: 503 })
    : fake.fetch(input, init));
  await assert.rejects(accessToken({ kind: "hub", paths, fetchImpl: down, force: true }), { code: "login_failed", kind: "hub" });
  assert.ok((await readTeamAuth(paths)).logins.hub, "the login is kept for the next try");
  assert.equal((await teamLoginStatus({ paths })).hubLogin.ended, undefined);
});

test("a login names where to sign out of Access: the application's domain and the team domain", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  const started = await startLogin({ host: HUB, kind: "hub", redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
  // The team domain is the issuer of the host's OAuth metadata.
  assert.deepEqual(started.logouts, [`https://${HUB}/cdn-cgi/access/logout`, "https://example-team.cloudflareaccess.com/cdn-cgi/access/logout"]);
  assert.match(started.id, /^[A-Za-z0-9_-]{12}$/);
  assert.notEqual(started.id, started.state);
  assert.equal(new URL(started.url).searchParams.has(started.id), false);
});

test("a callback that failed is told under the login's id; starting again is a new login that works", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  const first = await startLogin({ host: HUB, kind: "hub", redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
  // The consent page reloaded: Access sends the browser back with an error, which spends the state.
  await assert.rejects(finishLogin({ state: first.state, error: "invalid_request", errorDescription: "Consent request is malformed", paths, fetchImpl: fake.fetch }), /Consent request is malformed/);
  let status = await teamLoginStatus({ paths });
  assert.deepEqual(status.failed.map(({ id, kind, error, detail }) => ({ id, kind, error, detail })), [
    { id: first.id, kind: "hub", error: "refused", detail: "Consent request is malformed" },
  ]);
  for (const secret of [first.state, "verifier"]) assert.equal(JSON.stringify(status).includes(secret), false);
  // The old address is spent for good.
  await assert.rejects(finishLogin({ state: first.state, code: "x", paths, fetchImpl: fake.fetch }), /not started here/);

  // 브라우저 다시 열기 starts a new login, with its own state and id.
  const second = await startLogin({ host: HUB, kind: "hub", redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
  assert.notEqual(second.state, first.state);
  assert.notEqual(second.id, first.id);
  const back = new URL(fake.browserLogin(second.url));
  await finishLogin({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), paths, fetchImpl: fake.fetch });
  status = await teamLoginStatus({ paths });
  assert.equal(status.hubLogin.signedIn, true);
  assert.equal(status.failed.some((item) => item.id === second.id), false);

  // A failure is kept ten minutes, then forgotten.
  assert.deepEqual((await teamLoginStatus({ paths, now: Date.now() + 11 * 60_000 })).failed, []);
});

test("the hub and the servers are two logins; one servers login reaches every server", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths });
  await login(fake, paths);
  // The hub's token is not good for a server.
  await assert.rejects(teamFetch(`https://${SERVER}/team-memory/whoami`, {}, { paths, fetchImpl: fake.fetch }), { code: "login_needed" });

  await login(fake, paths, { host: SERVER, kind: "servers" });
  assert.equal((await teamFetch(`https://${SERVER}/team-memory/whoami`, {}, { paths, fetchImpl: fake.fetch })).status, 200);
  assert.equal((await teamFetch(`https://${OTHER}/team-memory/whoami`, {}, { paths, fetchImpl: fake.fetch })).status, 200);
  assert.equal((await teamFetch(`https://${HUB}/api/me`, {}, { paths, fetchImpl: fake.fetch })).status, 200);
  assert.deepEqual(fake.seen.map((item) => item.host), [SERVER, OTHER, HUB]);
});

test("a token Access turns down is refreshed and the request sent again", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await setTeam({ hub: HUB }, { paths });
  await login(fake, paths);
  // Access stops taking the current token before its time (revoked, rotated keys).
  fake.state.access.clear();
  const response = await teamFetch(`https://${HUB}/api/me`, {}, { paths, fetchImpl: fake.fetch });
  assert.equal(response.status, 200);
  assert.equal(fake.state.refreshes, 1);
});

test("a device key is kept per server and sent to that server only", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths });
  await login(fake, paths, { host: SERVER, kind: "servers" });

  const registered = await registerDevice(SERVER, { name: "MacBook", paths, fetchImpl: fake.fetch });
  assert.equal(registered.id, "d-0123456789abcdef");
  assert.equal(fake.seen.at(-1).device, null, "registering sends no key of its own");
  // Asked again, the key it has is kept.
  assert.equal((await registerDevice(SERVER, { name: "MacBook", paths, fetchImpl: fake.fetch })).kept, true);

  await teamFetch(`https://${SERVER}/v3/workspaces/memory/sessions`, {}, { paths, fetchImpl: fake.fetch });
  assert.equal(fake.seen.at(-1).device, `d-0123456789abcdef.${"k".repeat(43)}`);
  await teamFetch(`https://${OTHER}/v3/workspaces/memory/sessions`, {}, { paths, fetchImpl: fake.fetch });
  assert.equal(fake.seen.at(-1).device, null, "another server never sees this server's key");

  const headers = await teamHeaders(`https://${SERVER}`, { paths, fetchImpl: fake.fetch });
  assert.match(headers.Authorization, /^Bearer oauth:/);
  assert.equal(headers[DEVICE_HEADER], `d-0123456789abcdef.${"k".repeat(43)}`);
  assert.deepEqual(await teamHeaders(`https://${OTHER}`, { paths, fetchImpl: fake.fetch }), {}, "no key, no team headers");
  assert.deepEqual(await teamHeaders("http://127.0.0.1:8001", { paths, fetchImpl: fake.fetch }), {});

  await forgetDevice(SERVER, { paths });
  assert.deepEqual(await teamHeaders(`https://${SERVER}`, { paths, fetchImpl: fake.fetch }), {});
});

test("another team's logins and device keys are dropped when the team changes", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths });
  await login(fake, paths);
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths });
  assert.ok((await readTeamAuth(paths)).logins.hub, "the same team keeps its login");
  await setTeam({ hub: "team.other.example", email: null }, { paths });
  const auth = await readTeamAuth(paths);
  assert.deepEqual(auth.logins, {});
  assert.equal(auth.email, null);
});

test("the login status names who is signed in and never a token", async (t) => {
  const paths = await tempPaths(t);
  const fake = team();
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths });
  await login(fake, paths);
  const status = await teamLoginStatus({ paths });
  assert.equal(status.hub, HUB);
  assert.equal(status.email, "me@example.com");
  assert.equal(status.hubLogin.signedIn, true);
  assert.equal(status.serversLogin.signedIn, false);
  assert.equal(JSON.stringify(status).includes("oauth:"), false);
  assert.equal(JSON.stringify(status).includes("refresh-"), false);
});
