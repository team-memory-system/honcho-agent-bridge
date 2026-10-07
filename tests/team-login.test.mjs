// The page's side of the team login (ui/lib/team.js), against a stand-in for the
// app's routes and the browser's windows. What matters: 브라우저 다시 열기 starts a
// new login and the wait follows it; a callback that failed ends the wait at once;
// 다른 계정으로 로그인 signs the browser out of Access on both of its domains in one
// tab; a login to do again is said in Korean, with which one; the screens and the
// bell offer 다시 로그인 for a login that ended or that the hub refuses; and a set-up
// computer whose login ended stays set up.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "team.example.com";
const LOGOUTS = [`https://${HUB}/cdn-cgi/access/logout`, "https://example-team.cloudflareaccess.com/cdn-cgi/access/logout"];

/** A window the page opened: where it was sent, in order. */
function fakeTab() {
  const tab = { closed: false, visited: [], document: { write() {} }, close() { tab.closed = true; } };
  tab.location = { set href(value) { tab.visited.push(value); } };
  return tab;
}

/**
 * The app's routes as the page sees them. `status()` answers /api/team/status each
 * time it is asked; every POST is recorded, and /api/team/login hands out a new
 * login (its id and address) each time.
 */
function fakeApp({ status = () => ({ hubLogin: { signedIn: false } }), routes = {} } = {}) {
  const posts = [];
  const opened = [];
  let logins = 0;
  globalThis.window = {
    open(url, target, features) {
      const tab = fakeTab();
      opened.push({ url, features, tab });
      return tab;
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const answer = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url === "/api/team/status") return answer(status());
    const body = init.body ? JSON.parse(init.body) : {};
    posts.push({ url, body });
    if (url === "/api/team/login") {
      logins += 1;
      return answer({ ok: true, id: `id-${logins}`, url: `https://example-team.cloudflareaccess.com/authorize?state=s${logins}`, logouts: LOGOUTS, kind: body.kind, host: HUB });
    }
    if (routes[url]) return answer(routes[url](body));
    return answer({ ok: true });
  };
  return { posts, opened };
}

const saved = { window: globalThis.window, fetch: globalThis.fetch };
afterEach(() => {
  globalThis.window = saved.window;
  globalThis.fetch = saved.fetch;
});

const team = () => import("../ui/lib/team.js");

test("브라우저 다시 열기 starts a new login in a new window, and the wait follows that one", async () => {
  let asked = 0;
  const signedIn = { signedIn: true, loggedInAt: "2026-10-07T00:00:00.000Z" };
  const page = fakeApp({
    status: () => {
      asked += 1;
      // The first login's callback failed (it was spent); then the new one finishes.
      if (asked === 1) return { hubLogin: { signedIn: false } };
      if (asked === 2) return { hubLogin: { signedIn: false }, failed: [{ id: "id-1", kind: "hub", error: "refused", detail: "Consent request is malformed" }] };
      return { hubLogin: signedIn, failed: [{ id: "id-1", kind: "hub", error: "refused", detail: "Consent request is malformed" }] };
    },
  });
  const { teamLogin } = await team();
  const tab = fakeTab();
  const flow = teamLogin({ kind: "hub", hub: HUB, tab });
  while (!tab.visited.length) await new Promise((resolve) => setTimeout(resolve, 5));
  flow.reopen();
  const status = await flow.done;
  assert.deepEqual(status.hubLogin, signedIn);
  const starts = page.posts.filter((item) => item.url === "/api/team/login");
  assert.equal(starts.length, 2, "a new login, not the same address again");
  assert.deepEqual(tab.visited, ["https://example-team.cloudflareaccess.com/authorize?state=s1"]);
  // The new window was opened in the click (blank), then sent to the new login.
  assert.equal(page.opened.length, 1);
  assert.equal(page.opened[0].url, "");
  assert.deepEqual(page.opened[0].tab.visited, ["https://example-team.cloudflareaccess.com/authorize?state=s2"]);
  assert.deepEqual(flow.logouts(), LOGOUTS);
});

test("a callback that failed ends the wait at once, with the reason, instead of after ten minutes", async () => {
  fakeApp({ status: () => ({ hubLogin: { signedIn: false }, failed: [{ id: "id-1", kind: "hub", error: "refused", detail: "Consent request is malformed" }] }) });
  const { teamLogin } = await team();
  const began = Date.now();
  await assert.rejects(teamLogin({ kind: "hub", hub: HUB, tab: fakeTab() }).done, (error) => {
    assert.match(error.message, /^로그인이 거절됐습니다 \(Consent request is malformed\)\. 다시 로그인을 누르세요\.$/);
    return true;
  });
  assert.ok(Date.now() - began < 5_000);
});

test("다른 계정으로 로그인 forgets this computer's login, then signs out of both Access domains in the one tab", async () => {
  const page = fakeApp();
  const { switchAccount } = await team();
  const tab = fakeTab();
  await switchAccount(tab, LOGOUTS, { pause: 0 });
  assert.deepEqual(page.posts.map((item) => item.url), ["/api/team/logout"]);
  assert.deepEqual(tab.visited, LOGOUTS, "the application's domain, then the team domain");
  // A tab the person closed is left alone.
  const closed = fakeTab();
  closed.closed = true;
  await switchAccount(closed, LOGOUTS, { pause: 0 });
  assert.deepEqual(closed.visited, []);
});

test("the same email after switching means Google chose the same account", async () => {
  const { sameAccountAgain, GOOGLE_ADD_ACCOUNT } = await team();
  assert.equal(sameAccountAgain("Other@example.com", "other@example.com"), true);
  assert.equal(sameAccountAgain("other@example.com", "me@example.com"), false);
  assert.equal(sameAccountAgain(null, "me@example.com"), false, "only after 다른 계정으로 로그인");
  assert.equal(GOOGLE_ADD_ACCOUNT, "https://accounts.google.com/AddSession");
  // The 명단에 없음 screen says so and links there; the switch goes through both logouts.
  const setup = await fsp.readFile(path.join(ROOT, "ui", "views", "setup.js"), "utf8");
  const step = setup.slice(setup.indexOf("  function loginStep("), setup.indexOf("\n  function ", setup.indexOf("  function loginStep(") + 1));
  assert.match(step, /login\.sameAccount \? notice\("warn", "Google이 같은 계정을 다시 골랐습니다/);
  assert.match(step, /href: GOOGLE_ADD_ACCOUNT/);
  assert.match(step, /switchAccount\(tab, logouts\)/);
  assert.equal(/cdn-cgi|window\.open/.test(step), false, "no logout of its own, and no second window in one click");
});

test("a login to do again is said in Korean with which login, never the route's English", async () => {
  fakeApp({
    routes: {
      "/api/team/directory": () => ({ ok: false, error: "Log in to the team first (hub)", code: "login_needed", kind: "hub", host: HUB }),
      "/api/team/register": () => ({ ok: false, error: "The team login has ended (servers); log in again", code: "login_needed", kind: "servers", host: "memory.example.com" }),
    },
  });
  const { teamCall, teamDirectory } = await team();
  await assert.rejects(teamDirectory(), (error) => {
    assert.equal(error.message, "팀 로그인이 끝났습니다. 다시 로그인하세요.");
    assert.deepEqual([error.code, error.kind, error.host], ["login_needed", "hub", HUB]);
    return true;
  });
  await assert.rejects(teamCall("/api/team/register", { host: "memory.example.com" }), (error) => {
    assert.equal(error.message, "팀 서버 로그인이 끝났습니다. 다시 로그인하세요.");
    assert.equal(error.kind, "servers");
    return true;
  });
});

test("a login that ended is found in the status, said plainly, and offered again on the screens", async () => {
  const { endedLogins, loginEndedText } = await team();
  const status = {
    hubLogin: { signedIn: false, ended: { at: "2026-10-07T00:00:00.000Z", email: "me@example.com", host: HUB } },
    serversLogin: { signedIn: true, host: "memory.example.com" },
  };
  assert.deepEqual(endedLogins(status), [{ kind: "hub", email: "me@example.com", host: HUB, at: "2026-10-07T00:00:00.000Z" }]);
  assert.deepEqual(endedLogins({ hubLogin: { signedIn: true }, serversLogin: { signedIn: false } }), []);
  assert.deepEqual(endedLogins(null), []);
  assert.equal(loginEndedText(endedLogins(status)[0]), "me@example.com 계정의 팀 로그인이 끝났습니다. 다시 로그인하세요.");

  const read = (file) => fsp.readFile(path.join(ROOT, "ui", file), "utf8");
  // The 팀 page and the admin's: a failed load offers 다시 로그인 instead of the error's words.
  for (const file of ["views/team.js", "views/admin.js"]) assert.match(await read(file), /teamErrorNotice\(error, \{ onDone: draw \}\)/, file);
  assert.match(await read("views/team.js"), /loginNotice\(\{ \.\.\.ended, onDone: draw \}\)/);
  // The bell lists a login that ended once this computer is in a team.
  assert.match(await read("app.js"), /watchRequests\(\);\n\s*watchTeamLogin\(/);
  const lib = await read("lib/team.js");
  assert.match(lib, /bellSource\(async \(\) => \{[\s\S]*?loginsToRedo\(status, error\)[\s\S]*?end: reloginButton\(\{ \.\.\.item, onDone \}\)/);
  // 다시 로그인 runs the same browser login for the login that ended, then the screen again.
  assert.match(lib, /await relogin\(\{ kind, host, tab \}\);\n\s*await loadContext\(\);\n\s*refreshBell\(\);\n\s*await onDone\?\.\(\);/);
});

test("다시 로그인 logs in to the login that ended and, for the hub, asks who this is again", async () => {
  let asked = 0;
  const page = fakeApp({
    status: () => {
      asked += 1;
      return asked < 3
        ? { hub: HUB, hubLogin: { signedIn: false, ended: { email: "me@example.com", host: HUB } }, serversLogin: { signedIn: false } }
        : { hub: HUB, hubLogin: { signedIn: true, loggedInAt: "2026-10-07T00:00:00.000Z" }, serversLogin: { signedIn: false } };
    },
    routes: { "/api/team/me": () => ({ ok: true, email: "me@example.com", member: true }) },
  });
  const { relogin } = await team();
  const tab = fakeTab();
  await relogin({ kind: "hub", tab });
  assert.deepEqual(page.posts.map((item) => item.url), ["/api/team/login", "/api/team/me"]);
  assert.deepEqual(page.posts[0].body, { kind: "hub", hub: HUB, host: "" });
  assert.equal(tab.visited.length, 1);
});

test("a set-up computer whose hub login ended stays set up: no full setup again, 다시 로그인 where it lands", async () => {
  const { joinedTeam } = await team();
  const ended = { at: "2026-10-07T00:00:00.000Z", email: "me@example.com", host: HUB };
  // A teammate who chose 쌓지 않기: no server here, nothing configured, no teammate connected yet.
  assert.equal(joinedTeam({ hub: HUB, signedIn: false, loginEnded: ended }, "join"), true);
  assert.equal(joinedTeam({ hub: HUB, signedIn: true, loginEnded: null }, "join"), true);
  assert.equal(joinedTeam({ hub: HUB, signedIn: false, loginEnded: null }, "join"), false, "never logged in, or signed out: setup");
  assert.equal(joinedTeam({ hub: HUB, signedIn: false, loginEnded: ended }, undefined), false, "setup never finished in this browser");
  assert.equal(joinedTeam({ hub: null, signedIn: false, loginEnded: ended }, "join"), false);

  const read = (file) => fsp.readFile(path.join(ROOT, "ui", file), "utf8");
  const shell = await read("app.js");
  // "Setup done" asks joinedTeam, so the page shown is the one it was on.
  assert.match(shell, /function teamJoined\(\) \{\n\s*return joinedTeam\(app\.context\?\.team, app\.prefs\.mode\);/);
  assert.match(shell, /teamConnected\(\) \|\| teamJoined\(\)/);
  // The dashboard, where such a teammate lands, says so on top with 다시 로그인.
  const dashboard = await read("views/dashboard.js");
  assert.match(dashboard, /context\.team\?\.hub && !context\.team\.signedIn \? context\.team\.loginEnded : null/);
  assert.match(dashboard, /loginNotice\(\{ kind: "hub", email: gone\.email \|\| "", host: gone\.host \|\| "", onDone: draw \}\)/);
});

test("requests the hub refuses with login_needed put 다시 로그인 on the bell; other failures keep the last answer", async () => {
  let answer = () => ({ ok: true, incoming: [{ id: "r-1" }], outgoing: [] });
  fakeApp({ routes: { "/api/team/requests": () => answer() } });
  const { app } = await import("../ui/lib/state.js");
  const { loadRequests, requestsLoginRefused } = await import("../ui/lib/requests.js");
  const { loginsToRedo } = await team();
  // The context still says signed in: the login refreshes, but the hub turns it down.
  app.context = { team: { hub: HUB, signedIn: true } };
  const signedIn = { hubLogin: { signedIn: true, loggedInAt: "2026-10-07T00:00:00.000Z" }, serversLogin: { signedIn: false } };

  assert.equal((await loadRequests({ fresh: true })).incoming.length, 1);
  assert.equal(await requestsLoginRefused(), null);
  assert.deepEqual(loginsToRedo(signedIn, null), [], "nothing to do again");

  answer = () => ({ ok: false, error: `${HUB} no longer takes this computer's login; log in again`, code: "login_needed", kind: "hub", host: HUB });
  assert.equal(await loadRequests({ fresh: true }), null, "no stale requests to press");
  const refused = await requestsLoginRefused();
  assert.deepEqual([refused.code, refused.kind, refused.host], ["login_needed", "hub", HUB]);
  assert.deepEqual(loginsToRedo(signedIn, refused), [{ kind: "hub", email: "", host: HUB, at: null }]);
  // A login that also ended in the status is offered once.
  const both = { ...signedIn, hubLogin: { signedIn: false, ended: { at: "2026-10-07T00:00:00.000Z", email: "me@example.com", host: HUB } } };
  assert.deepEqual(loginsToRedo(both, refused).map((item) => [item.kind, item.email]), [["hub", "me@example.com"]]);

  // Logged in again: the requests come back and 다시 로그인 goes.
  answer = () => ({ ok: true, incoming: [{ id: "r-1" }], outgoing: [] });
  assert.equal((await loadRequests({ fresh: true })).incoming.length, 1);
  assert.equal(await requestsLoginRefused(), null);
  // Any other failure stays as it was: the last answer, and no 다시 로그인.
  answer = () => ({ ok: false, error: "HTTP 502 from team.example.com", status: 502 });
  assert.equal((await loadRequests({ fresh: true })).incoming.length, 1, "the last answer stays");
  assert.equal(await requestsLoginRefused(), null);
  assert.deepEqual(loginsToRedo(signedIn, await requestsLoginRefused()), []);

  // The bell asks the requests for it.
  assert.match(await fsp.readFile(path.join(ROOT, "ui", "app.js"), "utf8"), /watchTeamLogin\(\{ onDone: \(\) => show\(\{ force: true \}\), refused: requestsLoginRefused \}\)/);
  app.context = null;
});
