// Sharing a personal server: the gate, mcp and tunnel run in Compose under the share
// profile; the .env gets the tokens and Access settings, owner-only; the Cloudflare
// half is made by the API (a local fake here) or by an invite; the host tunnel of
// older versions is removed; and no secret reaches a command, a result or share.json.
// Every OS call goes to fakes.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyPublicResponse,
  LAUNCHD_LABEL,
  MCP_SETTINGS,
  normalizePublicUrl,
  RUN_KEY,
  RUN_VALUE,
  shareDisable,
  shareEnable,
  shareJoin,
  shareRotate,
  shareStatus,
  shareSummary,
  shareToken,
  SYSTEMD_UNIT,
} from "../scripts/share-manager.mjs";
import { decodeInvite, encodeInvite, teammateAdd } from "../scripts/team-access.mjs";
import { serverStatus } from "../scripts/server-manager.mjs";
import { formatJson } from "../scripts/redact.mjs";
import { ACCOUNT_ID, API_TOKEN, startFakeCloudflare, TEAM_DOMAIN } from "./fake-cloudflare.mjs";

const TUNNEL_TOKEN = "eyJhIjoiYWNjb3VudC10YWciLCJ0IjoidHVubmVsLWlkIiwicyI6InNlY3JldCJ9";
const PUBLIC_URL = "https://memory.example.com";
const CONFIG = { user: { peerId: "owner_peer" }, honcho: { workspaceId: "memory" } };

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function response(status, { headers = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), body: { cancel: async () => {} } };
}

async function fixture(t, { platform = "darwin", profiles = "debug", env = { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, config = CONFIG, cloudflare = null, name = "owner" } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `honcho-agent-bridge-share-${name}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "app", "server");
  await fsp.mkdir(path.join(serverDirectory, "gate"), { recursive: true });
  await fsp.writeFile(path.join(serverDirectory, "compose.yaml"), "name: honcho-agent-bridge\n");
  await fsp.writeFile(path.join(serverDirectory, "gate", "gate.mjs"), "// gate\n");
  const envLines = ["POSTGRES_PASSWORD=db-secret", "EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-4b-honcho-8192"];
  if (profiles) envLines.push(`COMPOSE_PROFILES=${profiles}`);
  await fsp.writeFile(path.join(serverDirectory, ".env"), `${envLines.join("\n")}\n`, { mode: 0o600 });
  const runtime = path.join(root, "app", "runtime");
  const home = path.join(root, "home");
  const calls = [];
  const state = { launchdLoaded: false, windowsRun: false, services: {} };
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "/bin/launchctl") {
      if (args[0] === "print") return state.launchdLoaded ? { code: 0, stdout: "state = running\npid = 42\n" } : { code: 113, stdout: "", stderr: "not found" };
      if (args[0] === "bootout") { state.launchdLoaded = false; return { code: 0, stdout: "", stderr: "" }; }
    }
    if (String(command).endsWith("reg.exe")) {
      if (args[0] === "query") return state.windowsRun ? { code: 0, stdout: RUN_VALUE, stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
      if (args[0] === "delete" && args[1] === RUN_KEY) state.windowsRun = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const composeRunner = async (directory, args) => {
    calls.push({ command: "docker compose", directory, args });
    if (args[0] === "up") for (const service of args.filter((item) => ["gate", "mcp", "tunnel"].includes(item))) state.services[service] = "running";
    if (args[0] === "stop") for (const service of args.slice(1)) state.services[service] = "exited";
    if (args[0] === "rm") for (const service of args.slice(2)) delete state.services[service];
    if (args[0] === "ps") {
      return { stdout: Object.entries(state.services).map(([Service, State]) => JSON.stringify({ Service, State })).join("\n"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const fetches = [];
  let publicAnswer = () => response(200);
  const fetchImpl = async (url, options = {}) => {
    fetches.push({ url, options });
    if (url.startsWith("http://127.0.0.1:")) return response(200);
    return publicAnswer(url, options);
  };
  const options = {
    serverDirectory,
    homeDir: home,
    platform,
    filePlatform: process.platform,
    uid: 501,
    env: { SystemRoot: "C:\\Windows", ...env },
    config,
    run,
    composeRunner,
    fetchImpl,
    sleep: async () => {},
    portInUse: async (port) => port === 8010,
    gateWaitMs: 0,
    ...(cloudflare ? { apiBaseUrl: cloudflare.baseUrl } : {}),
  };
  return {
    root,
    home,
    serverDirectory,
    runtime,
    envFile: path.join(serverDirectory, ".env"),
    shareFile: path.join(runtime, "share.json"),
    teamFile: path.join(runtime, "team-access.json"),
    apiTokenFile: path.join(runtime, "cloudflare", "api-token"),
    oldDir: path.join(runtime, "cloudflared"),
    calls,
    fetches,
    state,
    options,
    readEnv: async () => parseEnv(await fsp.readFile(path.join(serverDirectory, ".env"), "utf8")),
    setPublicAnswer(fn) { publicAnswer = fn; },
  };
}

async function mode(target) {
  return (await fsp.stat(target)).mode & 0o777;
}

function composeLines(calls) {
  return calls.filter((call) => call.command === "docker compose").map((call) => call.args.join(" "));
}

function assertNoSecret(value, secrets, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) if (secret) assert.equal(text.includes(secret), false, `${label} holds a secret`);
}

async function cloudflareFake(t, options) {
  const server = await startFakeCloudflare(options);
  t.after(() => server.close());
  return server;
}

// ------------------------------------------------------------ by hand

test("enable by hand writes the tunnel and team settings to the .env and starts gate, mcp and tunnel in Compose", async (t) => {
  const f = await fixture(t);
  const first = await shareEnable({ ...f.options, publicUrl: `${PUBLIC_URL}/` });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.publicUrl, PUBLIC_URL);
  assert.equal(first.gateTokenCreated, true);
  assert.equal(first.gate.port, 8011, "8010 was busy");
  assert.equal(first.gate.healthy, true);
  assert.deepEqual(first.mcp, { configured: false, missing: ["HONCHO_ACCESS_TEAM_DOMAIN", "HONCHO_ACCESS_AUD"] }, "/mcp stays off by hand");

  const environment = await f.readEnv();
  assert.equal(environment.HONCHO_TUNNEL_TOKEN, TUNNEL_TOKEN);
  assert.match(environment.HONCHO_GATE_TOKEN, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  assert.match(environment.HONCHO_TEAM_MCP_TOKEN, /^[A-Za-z0-9_-]{43}$/, "made even by hand, so mcp never restarts forever");
  assert.notEqual(environment.HONCHO_TEAM_MCP_TOKEN, environment.HONCHO_GATE_TOKEN);
  assert.equal(environment.HONCHO_TEAM_WORKSPACE, "memory");
  assert.equal(environment.HONCHO_TEAM_PEER, "owner_peer");
  assert.equal("HONCHO_ACCESS_AUD" in environment, false);
  assert.equal(environment.COMPOSE_PROFILES, "debug,share", "other profiles are kept");
  assert.equal(environment.HONCHO_GATE_PORT, "8011");
  assert.equal(environment.POSTGRES_PASSWORD, "db-secret");
  if (process.platform !== "win32") assert.equal(await mode(f.envFile), 0o600);

  assert.deepEqual(composeLines(f.calls), ["up -d gate mcp tunnel"]);
  assert.equal(f.calls.some((call) => call.command === "/bin/launchctl" && call.args[0] === "bootstrap"), false, "no host autostart any more");
  await assert.rejects(fsp.access(path.join(f.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)));

  const saved = JSON.parse(await fsp.readFile(f.shareFile, "utf8"));
  assert.equal(saved.publicUrl, PUBLIC_URL);
  assert.equal(saved.host, "memory.example.com");
  assert.ok(saved.enabledAt);

  // A second enable with no tunnel token keeps the saved one and every made token.
  const second = await shareEnable({ ...f.options, env: {}, publicUrl: PUBLIC_URL });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.gateTokenCreated, false);
  assert.equal(second.tunnel.tokenUpdated, false);
  const again = await f.readEnv();
  assert.equal(again.HONCHO_GATE_TOKEN, environment.HONCHO_GATE_TOKEN);
  assert.equal(again.HONCHO_TEAM_MCP_TOKEN, environment.HONCHO_TEAM_MCP_TOKEN);
  assert.equal(again.HONCHO_TUNNEL_TOKEN, TUNNEL_TOKEN);
  assert.equal(again.COMPOSE_PROFILES, "debug,share", "share is not added twice");

  const newToken = `${TUNNEL_TOKEN}Zm9v`;
  const third = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: newToken }, publicUrl: PUBLIC_URL });
  assert.equal(third.tunnel.tokenUpdated, true);
  assert.equal((await f.readEnv()).HONCHO_TUNNEL_TOKEN, newToken);

  const secrets = [TUNNEL_TOKEN, newToken, environment.HONCHO_GATE_TOKEN, environment.HONCHO_TEAM_MCP_TOKEN];
  assertNoSecret(f.calls, secrets, "a command");
  for (const result of [first, second, third]) assertNoSecret(result, secrets, "a result");
  assertNoSecret(await fsp.readFile(f.shareFile, "utf8"), secrets, "share.json");

  assert.deepEqual(await shareSummary({ serverDirectory: f.serverDirectory }), { enabled: true, publicUrl: PUBLIC_URL });
  assert.deepEqual(await shareToken(f.options), { ok: true, token: environment.HONCHO_GATE_TOKEN });
});

test("enable needs a tunnel token the first time, an https host, a personal server and a peer", async (t) => {
  const f = await fixture(t, { env: {} });
  const missing = await shareEnable({ ...f.options, publicUrl: PUBLIC_URL });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /HONCHO_TUNNEL_TOKEN/);
  assert.equal(f.calls.length, 0, "nothing ran");

  for (const bad of ["http://memory.example.com", "https://memory.example.com/v3", "https://memory.example.com/?a=1", "https://u:p@memory.example.com", "https://memory", ""]) {
    assert.equal(normalizePublicUrl(bad).ok, false, bad);
    const refused = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, publicUrl: bad });
    assert.equal(refused.ok, false, bad);
  }
  assert.equal(normalizePublicUrl("https://Memory.Example.com:8443").url, "https://memory.example.com:8443");

  for (const config of [null, { user: { peerId: "" } }, { user: {} }]) {
    const nobody = await shareEnable({ ...f.options, config, env: { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, publicUrl: PUBLIC_URL });
    assert.equal(nobody.ok, false);
    assert.match(nobody.error, /no Honcho peer/);
  }
  assert.equal(f.calls.length, 0, "an empty peer turns nothing on");
  assert.equal(/HONCHO_TEAM_PEER|COMPOSE_PROFILES=.*share/.test(await fsp.readFile(f.envFile, "utf8")), false);

  await fsp.writeFile(f.envFile, "EMBEDDING_MODEL_CONFIG__MODEL=text-embedding-3-small\n");
  const portable = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, publicUrl: PUBLIC_URL });
  assert.equal(portable.ok, false);
  assert.match(portable.error, /personal/);

  await fsp.rm(f.serverDirectory, { recursive: true });
  const none = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, publicUrl: PUBLIC_URL });
  assert.equal(none.ok, false);
  assert.match(none.error, /No personal memory server/);
});

// --------------------------------------------------------- --cloudflare

test("enable --cloudflare makes the Cloudflare half once, writes the .env and keeps every secret out of what it says", async (t) => {
  const cf = await cloudflareFake(t);
  const f = await fixture(t, { env: { CLOUDFLARE_API_TOKEN: API_TOKEN }, cloudflare: cf });
  const enabled = await shareEnable({ ...f.options, cloudflare: true, zone: "example.com", email: "Owner@Example.com" });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.equal(enabled.publicUrl, "https://memory.example.com");
  assert.equal(enabled.host, "memory.example.com");
  assert.deepEqual(enabled.mcp, { configured: true, missing: [] });
  assert.deepEqual(enabled.cloudflare.changes, { tunnel: "created", ingress: "updated", dns: "created", peopleApp: "created", bypassApp: "created" });

  const tunnel = cf.state.tunnels[0];
  assert.equal(tunnel.name, "team-memory-memory");
  const peopleApp = cf.state.apps.find((app) => app.domain === "memory.example.com");
  const environment = await f.readEnv();
  assert.equal(environment.HONCHO_TUNNEL_TOKEN, cf.state.tunnelTokens[tunnel.id]);
  assert.equal(environment.HONCHO_ACCESS_TEAM_DOMAIN, TEAM_DOMAIN);
  assert.equal(environment.HONCHO_ACCESS_AUD, peopleApp.aud);
  assert.match(environment.HONCHO_TEAM_MCP_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.match(environment.HONCHO_GATE_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(environment.HONCHO_TEAM_WORKSPACE, "memory");
  assert.equal(environment.HONCHO_TEAM_PEER, "owner_peer");
  assert.equal(environment.COMPOSE_PROFILES, "debug,share");
  assert.deepEqual(composeLines(f.calls), ["up -d gate mcp tunnel"]);
  assert.deepEqual(cf.state.policies.find((item) => item.name === "Team Memory people").include, [{ email: { email: "owner@example.com" } }]);

  const share = JSON.parse(await fsp.readFile(f.shareFile, "utf8"));
  assert.deepEqual(Object.keys(share).sort(), ["aud", "enabledAt", "host", "publicUrl", "teamDomain", "tunnel", "tunnelId"]);
  assert.equal(share.tunnelId, tunnel.id);
  assert.equal(share.aud, peopleApp.aud);
  assert.equal(share.teamDomain, TEAM_DOMAIN);
  const team = JSON.parse(await fsp.readFile(f.teamFile, "utf8"));
  assert.equal(team.accountId, ACCOUNT_ID);
  assert.equal(team.ownerEmail, "owner@example.com");
  assert.equal(team.owner.host, "memory.example.com");
  assert.equal((await fsp.readFile(f.apiTokenFile, "utf8")).trim(), API_TOKEN, "kept for teammates commands");
  if (process.platform !== "win32") {
    assert.equal(await mode(f.apiTokenFile), 0o600);
    assert.equal(await mode(f.envFile), 0o600);
  }

  const secrets = [API_TOKEN, environment.HONCHO_TUNNEL_TOKEN, environment.HONCHO_GATE_TOKEN, environment.HONCHO_TEAM_MCP_TOKEN];
  assertNoSecret(enabled, secrets, "the result");
  assertNoSecret(formatJson(enabled), secrets, "the printed result");
  assertNoSecret(f.calls, secrets, "a command");
  assertNoSecret(await fsp.readFile(f.shareFile, "utf8"), secrets, "share.json");
  assertNoSecret(await fsp.readFile(f.teamFile, "utf8"), secrets, "team-access.json");

  // Again, from the saved API token and the saved email and zone: Cloudflare is only read.
  const writes = cf.writes().length;
  f.calls.length = 0;
  const again = await shareEnable({ ...f.options, env: {}, cloudflare: true });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(cf.writes().length, writes, "nothing in Cloudflare changes on a second run");
  assert.equal(again.gateTokenCreated, false);
  assert.equal(again.tunnel.tokenUpdated, false);
  const kept = await f.readEnv();
  assert.equal(kept.HONCHO_TEAM_MCP_TOKEN, environment.HONCHO_TEAM_MCP_TOKEN);
  assert.equal(kept.HONCHO_GATE_TOKEN, environment.HONCHO_GATE_TOKEN);
  for (const request of cf.requests) assert.equal(request.authorization, `Bearer ${API_TOKEN}`);
});

test("enable by hand on another host clears the Access settings Cloudflare left, so /mcp does not check the old host's tag", async (t) => {
  const cf = await cloudflareFake(t);
  const f = await fixture(t, { env: { CLOUDFLARE_API_TOKEN: API_TOKEN }, cloudflare: cf });
  const enabled = await shareEnable({ ...f.options, cloudflare: true, zone: "example.com", email: "owner@example.com" });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.equal((await f.readEnv()).HONCHO_ACCESS_TEAM_DOMAIN, TEAM_DOMAIN);

  // The same host by hand keeps them: it is still behind the same Access application.
  const same = await shareEnable({ ...f.options, env: {}, publicUrl: "https://memory.example.com" });
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.deepEqual(same.mcp, { configured: true, missing: [] });

  const moved = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, publicUrl: "https://memory2.example.com" });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const environment = await f.readEnv();
  assert.equal(environment.HONCHO_ACCESS_TEAM_DOMAIN || "", "");
  assert.equal(environment.HONCHO_ACCESS_AUD || "", "");
  assert.equal(environment.HONCHO_TUNNEL_TOKEN, TUNNEL_TOKEN);
  assert.deepEqual(moved.mcp, { configured: false, missing: ["HONCHO_ACCESS_TEAM_DOMAIN", "HONCHO_ACCESS_AUD"] });
  assert.equal(JSON.parse(await fsp.readFile(f.shareFile, "utf8")).host, "memory2.example.com");
});

test("enable --cloudflare asks for what it cannot know, and changes nothing until Cloudflare has answered", async (t) => {
  const cf = await cloudflareFake(t, {
    idps: [{ id: "g1", name: "Google", type: "google" }, { id: "g2", name: "Workspace", type: "google-apps" }],
  });
  const f = await fixture(t, { env: {}, cloudflare: cf });
  const noToken = await shareEnable({ ...f.options, cloudflare: true, email: "owner@example.com" });
  assert.match(noToken.error, /CLOUDFLARE_API_TOKEN/);

  const env = { CLOUDFLARE_API_TOKEN: API_TOKEN };
  const noEmail = await shareEnable({ ...f.options, env, cloudflare: true });
  assert.match(noEmail.error, /--email <owner email> is needed/);
  assert.match((await shareEnable({ ...f.options, env, cloudflare: true, email: "not-an-email" })).error, /--email takes/);
  assert.match((await shareEnable({ ...f.options, env, cloudflare: true, email: "owner@example.com", name: "Not A Name" })).error, /--name takes/);
  assert.match((await shareEnable({ ...f.options, env, cloudflare: true, email: "owner@example.com", publicUrl: PUBLIC_URL })).error, /leave out --public-url/);
  assert.equal(cf.requests.length, 0, "no call before the local checks pass");

  const several = await shareEnable({ ...f.options, env, cloudflare: true, email: "owner@example.com" });
  assert.equal(several.ok, false);
  assert.match(several.error, /2 Google logins; choose one with --idp/);
  const wrongToken = await shareEnable({ ...f.options, env: { CLOUDFLARE_API_TOKEN: `${API_TOKEN}x` }, cloudflare: true, email: "owner@example.com", idp: "g1" });
  assert.match(wrongToken.error, /HTTP 403/);
  assert.equal(wrongToken.error.includes(API_TOKEN), false);
  assert.equal((await fsp.readFile(f.apiTokenFile, "utf8")).trim(), API_TOKEN, "the token that worked is kept, the wrong one is not");
  assert.equal(f.calls.length, 0, "nothing local ran");
  assert.equal(/share/.test((await f.readEnv()).COMPOSE_PROFILES || ""), false);

  const chosen = await shareEnable({ ...f.options, env, cloudflare: true, email: "owner@example.com", idp: "Workspace", name: "team" });
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  assert.equal(chosen.host, "team.example.com");
  assert.deepEqual(cf.state.apps.find((app) => app.domain === "team.example.com").allowed_idps, ["g2"]);
});

// ----------------------------------------------------------------- join

test("join turns a teammate's server on from the owner's invite, with no API token", async (t) => {
  const cf = await cloudflareFake(t);
  const owner = await fixture(t, { env: { CLOUDFLARE_API_TOKEN: API_TOKEN }, cloudflare: cf });
  assert.equal((await shareEnable({ ...owner.options, cloudflare: true, zone: "example.com", email: "owner@example.com" })).ok, true);
  const inviteFile = path.join(owner.root, "alice.invite");
  const added = await teammateAdd({ ...owner.options, env: {}, email: "alice@example.com", share: "alice", inviteOut: inviteFile });
  assert.equal(added.ok, true, JSON.stringify(added));

  const mate = await fixture(t, { env: {}, config: { user: { peerId: "alice_peer" } }, profiles: "", name: "mate" });
  const requestsBefore = cf.requests.length;
  const joined = await shareJoin({ ...mate.options, inviteFile });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(cf.requests.length, requestsBefore, "a teammate never calls Cloudflare");
  assert.equal(joined.publicUrl, "https://memory-alice.example.com");
  assert.deepEqual(joined.team.map((item) => item.host), ["memory.example.com", "memory-alice.example.com"]);
  assert.deepEqual(joined.mcp, { configured: true, missing: [] });

  const tunnel = cf.state.tunnels.find((item) => item.name === "team-memory-alice");
  const app = cf.state.apps.find((item) => item.domain === "memory-alice.example.com");
  const environment = await mate.readEnv();
  assert.equal(environment.HONCHO_TUNNEL_TOKEN, cf.state.tunnelTokens[tunnel.id]);
  assert.equal(environment.HONCHO_ACCESS_TEAM_DOMAIN, TEAM_DOMAIN);
  assert.equal(environment.HONCHO_ACCESS_AUD, app.aud);
  assert.equal(environment.HONCHO_TEAM_PEER, "alice_peer");
  assert.equal(environment.HONCHO_TEAM_WORKSPACE, "memory");
  assert.match(environment.HONCHO_TEAM_MCP_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(environment.COMPOSE_PROFILES, "share");
  assert.deepEqual(composeLines(mate.calls), ["up -d gate mcp tunnel"]);
  const share = JSON.parse(await fsp.readFile(mate.shareFile, "utf8"));
  assert.equal(share.joined, true);
  assert.equal(share.tunnelId, tunnel.id);
  assert.equal(share.host, "memory-alice.example.com");
  await assert.rejects(fsp.access(mate.apiTokenFile), "a teammate keeps no API token");
  const secrets = [environment.HONCHO_TUNNEL_TOKEN, environment.HONCHO_GATE_TOKEN, environment.HONCHO_TEAM_MCP_TOKEN, (await fsp.readFile(inviteFile, "utf8")).trim()];
  assertNoSecret(joined, secrets, "the result");
  assertNoSecret(mate.calls, secrets, "a command");
  assertNoSecret(await fsp.readFile(mate.shareFile, "utf8"), secrets, "share.json");

  // The code can come from the environment too.
  const code = (await fsp.readFile(inviteFile, "utf8")).trim();
  const fromEnv = await shareJoin({ ...mate.options, env: { HONCHO_SHARE_INVITE: code } });
  assert.equal(fromEnv.ok, true, JSON.stringify(fromEnv));
  assert.equal(fromEnv.tunnel.tokenUpdated, false);
});

test("join refuses a bad invite, a missing one and an empty peer before anything runs", async (t) => {
  const f = await fixture(t, { env: {}, profiles: "" });
  const good = encodeInvite({ host: "memory-bob.example.com", tunnelToken: TUNNEL_TOKEN, teamDomain: TEAM_DOMAIN, aud: "a".repeat(64), team: [] });
  const broken = `${good.slice(0, -6)}!!!!!!`;
  for (const [options, pattern] of [
    [{}, /needs --invite-file/],
    [{ inviteFile: path.join(f.root, "missing.invite") }, /could not be read \(ENOENT\)/],
    [{ invite: broken }, /not valid/],
    [{ invite: "tm2.abc" }, /does not start with tm1\./],
    [{ invite: good, config: { user: {} } }, /no Honcho peer/],
  ]) {
    const result = await shareJoin({ ...f.options, ...options });
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
    assert.equal(result.error.includes(TUNNEL_TOKEN), false);
    assert.equal(result.error.includes(good.slice(4, 40)), false, "the code is never quoted");
  }
  assert.equal(f.calls.length, 0);
  assert.equal("HONCHO_TUNNEL_TOKEN" in (await f.readEnv()), false);
});

// -------------------------------------------------------------- disable

test("disable stops the tunnel first, then mcp and the gate, keeps the tokens and leaves Cloudflare alone", async (t) => {
  const cf = await cloudflareFake(t);
  const f = await fixture(t, { env: { CLOUDFLARE_API_TOKEN: API_TOKEN }, cloudflare: cf });
  assert.equal((await shareEnable({ ...f.options, cloudflare: true, zone: "example.com", email: "owner@example.com" })).ok, true);
  const before = await f.readEnv();
  const requests = cf.requests.length;
  f.calls.length = 0;

  const disabled = await shareDisable(f.options);
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.keptTunnelToken, true);
  assert.equal(disabled.cloudflareKept, true);
  assert.match(disabled.note, /left as they are/);
  assert.equal(cf.requests.length, requests, "Cloudflare is not called");
  assert.deepEqual(composeLines(f.calls), ["stop tunnel", "stop mcp gate", "rm -f gate mcp tunnel"]);

  const environment = await f.readEnv();
  assert.equal(environment.COMPOSE_PROFILES, "debug");
  for (const key of ["HONCHO_GATE_TOKEN", "HONCHO_TUNNEL_TOKEN", "HONCHO_TEAM_MCP_TOKEN", "HONCHO_ACCESS_AUD"]) assert.equal(environment[key], before[key], key);
  assert.deepEqual(await shareSummary({ serverDirectory: f.serverDirectory }), { enabled: false, publicUrl: "https://memory.example.com" });
  assert.equal(JSON.parse(await fsp.readFile(f.shareFile, "utf8")).tunnel, false);
});

test("disable removes COMPOSE_PROFILES when share was the only profile", async (t) => {
  const f = await fixture(t, { profiles: "" });
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  assert.equal((await f.readEnv()).COMPOSE_PROFILES, "share");
  assert.equal((await shareDisable(f.options)).ok, true);
  const text = await fsp.readFile(f.envFile, "utf8");
  assert.equal(/^COMPOSE_PROFILES=/m.test(text), false);
  assert.match(text, /^HONCHO_GATE_TOKEN=/m);
});

test("rotate replaces the gate token and recreates only the gate", async (t) => {
  const f = await fixture(t);
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  const before = (await f.readEnv()).HONCHO_GATE_TOKEN;
  f.calls.length = 0;
  const rotated = await shareRotate(f.options);
  assert.equal(rotated.ok, true);
  assert.equal(rotated.restarted, true);
  const after = (await f.readEnv()).HONCHO_GATE_TOKEN;
  assert.notEqual(after, before);
  assert.match(after, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(composeLines(f.calls), ["up -d --no-deps gate"]);
  assertNoSecret(f.calls, [after], "a command");
});

// --------------------------------------------- the old host tunnel

async function oldHostTunnel(f, platform) {
  await fsp.mkdir(f.oldDir, { recursive: true });
  await fsp.writeFile(path.join(f.oldDir, "tunnel-token"), TUNNEL_TOKEN, { mode: 0o600 });
  await fsp.writeFile(path.join(f.oldDir, platform === "win32" ? "cloudflared.exe" : "cloudflared"), "binary", { mode: 0o755 });
  if (platform === "darwin") {
    const plist = path.join(f.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await fsp.mkdir(path.dirname(plist), { recursive: true });
    await fsp.writeFile(plist, "<plist/>");
    f.state.launchdLoaded = true;
    return plist;
  }
  if (platform === "linux") {
    const unit = path.join(f.home, ".config", "systemd", "user", SYSTEMD_UNIT);
    await fsp.mkdir(path.dirname(unit), { recursive: true });
    await fsp.writeFile(unit, "[Unit]\n");
    return unit;
  }
  f.state.windowsRun = true;
  const vbs = path.join(f.oldDir, "tunnel.vbs");
  await fsp.writeFile(vbs, "' old");
  return vbs;
}

test("enable removes the host tunnel of older versions and moves its token into the .env", async (t) => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const f = await fixture(t, { platform, env: {}, name: platform });
    const registration = await oldHostTunnel(f, platform);
    const enabled = await shareEnable({ ...f.options, publicUrl: PUBLIC_URL });
    assert.equal(enabled.ok, true, `${platform}: ${JSON.stringify(enabled)}`);
    assert.equal(enabled.hostTunnelRemoved, { darwin: "launchd", linux: "systemd", win32: "windows-run" }[platform]);
    await assert.rejects(fsp.access(registration), `${platform}: the autostart is gone`);
    await assert.rejects(fsp.access(f.oldDir), `${platform}: the old binary and token file are gone`);
    assert.equal((await f.readEnv()).HONCHO_TUNNEL_TOKEN, TUNNEL_TOKEN, `${platform}: the old token runs in Compose now`);
    const lines = f.calls.map((call) => `${path.win32.basename(path.basename(String(call.command)))} ${call.args.join(" ")}`);
    if (platform === "darwin") assert.ok(lines.includes(`launchctl bootout gui/501/${LAUNCHD_LABEL}`));
    if (platform === "linux") assert.ok(lines.includes(`systemctl --user disable --now ${SYSTEMD_UNIT}`));
    if (platform === "win32") {
      assert.ok(lines.includes(`reg.exe delete ${RUN_KEY} /v ${RUN_VALUE} /f`));
      const stop = f.calls.find((call) => /powershell/i.test(call.command));
      assert.ok(stop.args.at(-1).includes("Stop-Process") && stop.args.at(-1).includes(path.join(f.oldDir, "tunnel-token")), "only the old cloudflared is stopped");
    }
    const up = lines.indexOf("docker compose up -d gate mcp tunnel");
    assert.ok(up > 0, `${platform}: Compose starts after the old tunnel is gone`);
    assertNoSecret(f.calls, [TUNNEL_TOKEN], "a command");

    // Nothing left: a second run removes nothing and asks the OS nothing on macOS and Linux.
    f.calls.length = 0;
    assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).hostTunnelRemoved, null);
  }
});

test("disable and join remove the old host tunnel too", async (t) => {
  const f = await fixture(t, { env: {} });
  const plist = await oldHostTunnel(f, "darwin");
  const disabled = await shareDisable(f.options);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.hostTunnelRemoved, "launchd");
  await assert.rejects(fsp.access(plist));
  assert.equal(disabled.keptTunnelToken, true, "the old token is kept in the .env");

  const mate = await fixture(t, { env: {}, name: "mate" });
  const matePlist = await oldHostTunnel(mate, "darwin");
  const code = encodeInvite({ host: "memory-bob.example.com", tunnelToken: `${TUNNEL_TOKEN}new`, teamDomain: TEAM_DOMAIN, aud: "b".repeat(64), team: [{ name: "memory", host: "memory.example.com" }] });
  const joined = await shareJoin({ ...mate.options, invite: code });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.hostTunnelRemoved, "launchd");
  await assert.rejects(fsp.access(matePlist));
  assert.equal((await mate.readEnv()).HONCHO_TUNNEL_TOKEN, `${TUNNEL_TOKEN}new`, "the invite's token wins over the old one");
});

// --------------------------------------------------------------- status

test("status reports the services, whether /mcp is configured by setting name, and what the public check found", async (t) => {
  const f = await fixture(t);
  const off = await shareStatus(f.options);
  assert.equal(off.ok, true);
  assert.equal(off.installed, true);
  assert.equal(off.enabled, false);
  assert.equal(off.gate.port, 8011, "the port it will use");
  assert.equal(off.gate.localUrl, "http://127.0.0.1:8011");
  assert.equal(off.tunnel.tokenSaved, false);
  assert.deepEqual(off.mcp, { configured: false, missing: MCP_SETTINGS, running: false });
  assert.equal(off.publicUrl, null);
  assert.equal("publicCheck" in off, false, "the public check is opt-in");

  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  const environment = await f.readEnv();
  const on = await shareStatus(f.options);
  assert.equal(on.enabled, true);
  assert.equal(on.gate.running, true);
  assert.equal(on.tunnel.enabled, true);
  assert.equal(on.tunnel.running, true);
  assert.equal(on.tunnel.tokenSaved, true);
  assert.equal(on.tunnel.hostAutostart, false);
  assert.deepEqual(on.mcp, { configured: false, missing: ["HONCHO_ACCESS_TEAM_DOMAIN", "HONCHO_ACCESS_AUD"], running: true });
  assert.equal(on.publicUrl, PUBLIC_URL);

  await fsp.appendFile(f.envFile, `HONCHO_ACCESS_TEAM_DOMAIN=${TEAM_DOMAIN}\nHONCHO_ACCESS_AUD=${"c".repeat(64)}\n`);
  const configured = await shareStatus(f.options);
  assert.deepEqual(configured.mcp, { configured: true, missing: [], running: true });
  assertNoSecret(configured, [TUNNEL_TOKEN, environment.HONCHO_GATE_TOKEN, environment.HONCHO_TEAM_MCP_TOKEN, "c".repeat(64)], "status");

  const cases = [
    [() => response(200), "ok"],
    [() => response(401), "token"],
    [() => response(403), "access"],
    [() => response(302, { headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/memory.example.com" } }), "access"],
    [() => response(400, { headers: { "cf-mitigated": "challenge" } }), "access"],
    [() => response(530), "unreachable"],
    [() => response(502), "unreachable"],
    [() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, "unreachable"],
    [() => response(500), "error"],
    [() => response(302, { headers: { location: "https://elsewhere.example/" } }), "error"],
  ];
  for (const [answer, expected] of cases) {
    f.setPublicAnswer(answer);
    const checked = await shareStatus({ ...f.options, check: true });
    assert.equal(checked.publicCheck.state, expected, JSON.stringify(checked.publicCheck));
  }
  const publicCall = f.fetches.filter((item) => item.url === `${PUBLIC_URL}/health`).at(-1);
  assert.equal(publicCall.options.headers.Authorization, `Bearer ${environment.HONCHO_GATE_TOKEN}`);
  assert.equal(publicCall.options.redirect, "manual", "an Access login redirect is seen, not followed");

  assert.equal(classifyPublicResponse({ status: 200, headers: {} }), "ok");
  assert.equal(classifyPublicResponse({ status: 401, headers: { "Cf-Access-Domain": "x" } }), "access");
});

test("status says when the old host tunnel is still registered", async (t) => {
  const f = await fixture(t, { env: {} });
  await oldHostTunnel(f, "darwin");
  const status = await shareStatus(f.options);
  assert.equal(status.tunnel.hostAutostart, true);
  assert.equal(status.tunnel.tokenSaved, true, "the old token file still counts until it is moved");
  assert.match(status.issues.join("\n"), /older version is still set to start at login/);
});

test("server status says cheaply whether the server is shared", async (t) => {
  const f = await fixture(t);
  const inspect = () => serverStatus({
    profile: "portable",
    serverDirectory: f.serverDirectory,
    dockerInspector: async () => ({ installed: true, running: false }),
  });
  assert.deepEqual((await inspect()).share, { enabled: false, publicUrl: null });
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  assert.deepEqual((await inspect()).share, { enabled: true, publicUrl: PUBLIC_URL });
});

test("a share.json without the tunnel field still means the tunnel", async (t) => {
  const f = await fixture(t, { profiles: "share" });
  await fsp.mkdir(path.dirname(f.shareFile), { recursive: true });
  await fsp.writeFile(f.shareFile, JSON.stringify({ publicUrl: PUBLIC_URL, enabledAt: "2026-09-20T00:00:00.000Z" }));
  const before = await shareStatus(f.options);
  assert.equal(before.enabled, true);
  assert.equal(before.tunnel.enabled, true);
  assert.equal((await shareDisable(f.options)).ok, true);
  const saved = JSON.parse(await fsp.readFile(f.shareFile, "utf8"));
  assert.equal(saved.publicUrl, PUBLIC_URL);
  assert.equal("tunnel" in saved, false, "an older file is closed as it is");
  const after = await shareStatus(f.options);
  assert.equal(after.enabled, false);
  assert.equal(after.tunnel.enabled, false);
});

test("an invite decodes to exactly what was put in", () => {
  const invite = { host: "memory-bob.example.com", tunnelToken: TUNNEL_TOKEN, teamDomain: TEAM_DOMAIN, aud: "d".repeat(64), team: [{ name: "memory", host: "memory.example.com" }] };
  assert.deepEqual(decodeInvite(encodeInvite(invite)), { v: 1, ...invite });
});
