// The team's email list and a teammate's shared server, through the owner's API token
// against a local fake of Cloudflare; the invite format; and the CLI, which never
// prints the API token, a tunnel token or an invite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { shareEnable } from "../scripts/share-manager.mjs";
import { EventEmitter } from "node:events";
import {
  codexLogin,
  codexLoginStatus,
  decodeInvite,
  encodeInvite,
  knownTeamServers,
  parseTeamAddresses,
  registeredTeamServers,
  teamAddress,
  teamAddressText,
  teammateAdd,
  teammateConnect,
  teammateDisconnect,
  teammateRemove,
  teammatesConnected,
  teammatesList,
  teammateUnshare,
  tunnelIdFromToken,
} from "../scripts/team-access.mjs";
import { API_TOKEN, connectorToken, startFakeCloudflare, TEAM_DOMAIN } from "./fake-cloudflare.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const TUNNEL_TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
const INVITE = { host: "memory-bob.example.com", tunnelToken: TUNNEL_TOKEN, teamDomain: TEAM_DOMAIN, aud: "e".repeat(64), team: [{ name: "memory", host: "memory.example.com" }] };

function code(value) {
  return `tm1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

test("an invite is tm1. and base64url JSON, and a wrong one is refused without quoting it", () => {
  const encoded = encodeInvite(INVITE);
  assert.match(encoded, /^tm1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(encoded.slice(4), "base64url").toString("utf8")), { v: 1, ...INVITE });
  assert.deepEqual(decodeInvite(`  ${encoded}\n`), { v: 1, ...INVITE }, "a pasted code with spaces and a newline still works");
  assert.deepEqual(decodeInvite(code({ v: 1, ...INVITE, extra: "ignored" })), { v: 1, ...INVITE });

  const cases = [
    ["", /empty/],
    ["tm2.abc", /does not start with tm1\./],
    ["tm1.not base64!", /characters an invite never has/],
    ["tm1.bm90IGpzb24", /cut off or changed/],
    [code([1, 2]), /holds no invite/],
    [code({ ...INVITE, v: 2 }), /another version/],
    [code({ ...INVITE, v: 1, host: "https://memory-bob.example.com" }), /server address/],
    [code({ ...INVITE, v: 1, host: "localhost" }), /server address/],
    [code({ ...INVITE, v: 1, tunnelToken: "short" }), /tunnel token/],
    [code({ ...INVITE, v: 1, tunnelToken: `${TUNNEL_TOKEN} rm -rf` }), /tunnel token/],
    [code({ ...INVITE, v: 1, teamDomain: "" }), /team domain/],
    [code({ ...INVITE, v: 1, aud: "x" }), /AUD tag/],
    [code({ ...INVITE, v: 1, team: "memory" }), /team list/],
    [code({ ...INVITE, v: 1, team: [{ name: "Bad Name", host: "memory.example.com" }] }), /team list has a wrong entry/],
    [`tm1.${"A".repeat(40_000)}`, /too long/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => decodeInvite(value), (error) => {
      assert.match(error.message, /^The invite code is not valid: /);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes(TUNNEL_TOKEN), false);
      if (value.length > 8) assert.equal(error.message.includes(value.slice(4, 24)), false, "the code is never quoted");
      return true;
    }, value.slice(0, 30));
  }
  assert.throws(() => encodeInvite({ ...INVITE, aud: "" }), /AUD tag/);

  const tunnelId = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  assert.equal(tunnelIdFromToken(connectorToken(tunnelId)), tunnelId);
  assert.equal(tunnelIdFromToken("not a token"), null);
});

async function ownerFixture(t) {
  const cf = await startFakeCloudflare();
  t.after(() => cf.close());
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "app", "server");
  await fsp.mkdir(path.join(serverDirectory, "gate"), { recursive: true });
  await fsp.writeFile(path.join(serverDirectory, "compose.yaml"), "name: honcho-agent-bridge\n");
  await fsp.writeFile(path.join(serverDirectory, "gate", "gate.mjs"), "// gate\n");
  await fsp.writeFile(path.join(serverDirectory, ".env"), "EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-4b-honcho-8192\n", { mode: 0o600 });
  const options = {
    serverDirectory,
    homeDir: path.join(root, "home"),
    platform: "darwin",
    uid: 501,
    env: {},
    config: { user: { peerId: "owner_peer" } },
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    composeRunner: async () => ({ stdout: "", stderr: "" }),
    fetchImpl: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
    sleep: async () => {},
    portInUse: async () => false,
    gateWaitMs: 0,
    apiBaseUrl: cf.baseUrl,
  };
  const enabled = await shareEnable({ ...options, env: { CLOUDFLARE_API_TOKEN: API_TOKEN }, cloudflare: true, zone: "example.com", email: "owner@example.com" });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  return { cf, root, serverDirectory, options, teamFile: path.join(root, "app", "runtime", "team-access.json") };
}

test("teammates add and remove edit the one email list; the owner's own email cannot be removed", async (t) => {
  const f = await ownerFixture(t);
  const people = () => f.cf.state.policies.find((item) => item.name === "Team Memory people").include.map((rule) => rule.email.email);

  const added = await teammateAdd({ ...f.options, email: " Mate@Example.com " });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.added, true);
  assert.deepEqual(people(), ["owner@example.com", "mate@example.com"]);
  const writes = f.cf.writes().length;
  assert.equal((await teammateAdd({ ...f.options, email: "mate@example.com" })).added, false);
  assert.equal(f.cf.writes().length, writes, "adding twice writes nothing");

  const listed = await teammatesList(f.options);
  assert.deepEqual(listed, {
    ok: true,
    owner: "owner@example.com",
    people: ["owner@example.com", "mate@example.com"],
    servers: [{ name: "memory", host: "memory.example.com" }],
    shared: [],
    addressText: "memory https://memory.example.com/mcp",
  });

  const removed = await teammateRemove({ ...f.options, email: "mate@example.com" });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(people(), ["owner@example.com"]);
  const owner = await teammateRemove({ ...f.options, email: "OWNER@example.com" });
  assert.equal(owner.ok, false);
  assert.match(owner.error, /lock the owner out/);
  assert.deepEqual(people(), ["owner@example.com"]);
  assert.match((await teammateAdd({ ...f.options, email: "not an email" })).error, /takes an email/);
  for (const request of f.cf.requests) assert.equal(request.authorization, `Bearer ${API_TOKEN}`, "the saved token is used");
});

test("teammates add --share makes the teammate's server in Cloudflare and writes the invite to an owner-only file; unshare removes it", async (t) => {
  const f = await ownerFixture(t);
  const inviteFile = path.join(f.root, "alice.invite");
  assert.match((await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice" })).error, /--share needs --invite-out/);
  assert.match((await teammateAdd({ ...f.options, email: "alice@example.com", share: "memory", inviteOut: inviteFile })).error, /name of this server/);
  assert.match((await teammateAdd({ ...f.options, email: "alice@example.com", share: "Alice!", inviteOut: inviteFile })).error, /short name/);

  const added = await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice", inviteOut: inviteFile });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.share.host, "memory-alice.example.com");
  assert.equal(added.inviteFile, inviteFile);
  assert.equal("invite" in added, false, "the invite only goes to the file");
  const tunnel = f.cf.state.tunnels.find((item) => item.name === "team-memory-alice");
  const app = f.cf.state.apps.find((item) => item.domain === "memory-alice.example.com");
  assert.ok(tunnel && app);
  assert.deepEqual(f.cf.state.configurations[tunnel.id].ingress[0], { hostname: "memory-alice.example.com", service: "http://gate:8010" });
  assert.ok(f.cf.state.records.some((record) => record.name === "memory-alice.example.com" && record.content === `${tunnel.id}.cfargotunnel.com`));
  assert.ok(f.cf.state.apps.some((item) => item.domain === "memory-alice.example.com/v3"));
  const peoplePolicy = f.cf.state.policies.find((item) => item.name === "Team Memory people");
  assert.deepEqual(app.policies, [{ id: peoplePolicy.id, precedence: 1 }], "the one people list guards every server");

  const text = await fsp.readFile(inviteFile, "utf8");
  if (process.platform !== "win32") assert.equal((await fsp.stat(inviteFile)).mode & 0o777, 0o600);
  const invite = decodeInvite(text);
  assert.deepEqual(invite, {
    v: 1,
    host: "memory-alice.example.com",
    tunnelToken: f.cf.state.tunnelTokens[tunnel.id],
    teamDomain: TEAM_DOMAIN,
    aud: app.aud,
    team: [{ name: "memory", host: "memory.example.com" }, { name: "alice", host: "memory-alice.example.com" }],
  });
  const team = await fsp.readFile(f.teamFile, "utf8");
  assert.equal(team.includes(invite.tunnelToken), false, "team-access.json holds ids only");
  assert.equal(JSON.stringify(added).includes(invite.tunnelToken), false);

  // For the app: handed back once instead of written.
  const forApp = await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice", returnInvite: true });
  assert.equal(decodeInvite(forApp.invite).host, "memory-alice.example.com");
  assert.equal(f.cf.state.tunnels.filter((item) => !item.deleted_at).length, 2, "the same tunnel again, not a new one");

  await fsp.writeFile(path.join(f.root, "notes"), "my notes\n");
  const refused = await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice", inviteOut: path.join(f.root, "notes") });
  assert.match(refused.error, /already exists and is not an invite/);
  assert.equal(await fsp.readFile(path.join(f.root, "notes"), "utf8"), "my notes\n");

  const listed = await teammatesList(f.options);
  assert.deepEqual(listed.shared, [{ name: "alice", host: "memory-alice.example.com", email: "alice@example.com" }]);
  assert.equal(listed.addressText, "memory https://memory.example.com/mcp\nalice https://memory-alice.example.com/mcp");
  assert.deepEqual(await knownTeamServers(f.options), [{ name: "alice", host: "memory-alice.example.com", url: "https://memory-alice.example.com/mcp", sources: ["team"] }], "the owner's own server is left out");
  const removed = await teammateRemove({ ...f.options, email: "alice@example.com" });
  assert.deepEqual(removed.stillShared, ["alice"], "taking the email off leaves the server to unshare");

  assert.match((await teammateUnshare({ ...f.options, name: "memory" })).error, /server share disable/);
  const unshared = await teammateUnshare({ ...f.options, name: "alice" });
  assert.equal(unshared.ok, true, JSON.stringify(unshared));
  assert.deepEqual(unshared.removed, { peopleApp: true, bypassApp: true, dnsRecords: 1, tunnel: true });
  assert.equal(f.cf.state.apps.some((item) => item.domain.startsWith("memory-alice.")), false);
  assert.equal(f.cf.state.records.some((record) => record.name === "memory-alice.example.com"), false);
  assert.ok(tunnel.deleted_at);
  assert.ok(f.cf.state.apps.some((item) => item.domain === "memory.example.com"), "the owner's server stays");
  assert.deepEqual((await teammatesList(f.options)).shared, []);
  assert.equal((await teammateUnshare({ ...f.options, name: "alice" })).ok, true, "unsharing twice is not an error");
});

test("teammates need the owner's Cloudflare sharing first", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-none-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = await teammatesList({ serverDirectory: path.join(root, "server"), env: { CLOUDFLARE_API_TOKEN: API_TOKEN } });
  assert.equal(result.ok, false);
  assert.match(result.error, /server share enable --cloudflare first/);
});

async function cli(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr, json: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr), json: JSON.parse(String(error.stdout || "{}")) };
  }
}

test("the CLI never prints the API token, a tunnel token or an invite, and refuses them as arguments", async (t) => {
  const f = await ownerFixture(t);
  const env = {
    HONCHO_AGENT_BRIDGE_SERVER_DIR: f.serverDirectory,
    HONCHO_AGENT_BRIDGE_HOME: path.join(f.root, "app"),
    HONCHO_CLOUDFLARE_API_BASE: f.cf.baseUrl,
    CLOUDFLARE_API_TOKEN: API_TOKEN,
    HONCHO_TUNNEL_TOKEN: "",
    HONCHO_SHARE_INVITE: "",
  };
  const inviteFile = path.join(f.root, "bob.invite");
  const added = await cli(["teammates", "add", "bob@example.com", "--share", "bob", "--invite-out", inviteFile], env);
  assert.equal(added.code, 0, added.stdout);
  assert.equal(added.json.ok, true);
  assert.equal(added.json.share.host, "memory-bob.example.com");
  const invite = (await fsp.readFile(inviteFile, "utf8")).trim();
  const { tunnelToken } = decodeInvite(invite);

  const listed = await cli(["teammates", "list"], { ...env, CLOUDFLARE_API_TOKEN: "" });
  assert.deepEqual(listed.json.people, ["owner@example.com", "bob@example.com"]);
  const removed = await cli(["teammates", "remove", "bob@example.com"], env);
  assert.equal(removed.json.removed, true);
  const unshared = await cli(["teammates", "unshare", "bob"], env);
  assert.equal(unshared.json.ok, true, unshared.stdout);

  const badInvite = path.join(f.root, "bad.invite");
  await fsp.writeFile(badInvite, `${invite.slice(0, -10)}$$$$$$$$$$\n`);
  const join = await cli(["server", "share", "join", "--invite-file", badInvite], env);
  assert.equal(join.json.ok, false);
  assert.match(join.json.error, /not valid/);

  const refusedFlags = [
    ["teammates", "add", "x@example.com", "--api-token", API_TOKEN],
    ["server", "share", "enable", "--cloudflare", "--api-token", API_TOKEN],
    ["server", "share", "join", "--invite", invite],
  ];
  const refused = [];
  for (const args of refusedFlags) {
    const result = await cli(args, env);
    assert.equal(result.json.ok, false);
    assert.match(result.json.error, /not the command line/);
    refused.push(result);
  }
  assert.match((await cli(["teammates", "add", "x@example.com", "--invite-out", inviteFile], env)).json.error, /goes with --share/);

  for (const result of [added, listed, removed, unshared, join, ...refused]) {
    for (const secret of [API_TOKEN, tunnelToken, invite, invite.slice(4, 40)]) {
      assert.equal(result.stdout.includes(secret), false, "stdout");
      assert.equal(result.stderr.includes(secret), false, "stderr");
    }
  }
});

// ------------------------------------------------------- the asking side

test("a team address is a host, https://host or https://host/mcp, and the 팀 주소 text reads back", () => {
  for (const value of ["memory-alice.example.com", " https://Memory-Alice.example.com ", "https://memory-alice.example.com/", "https://memory-alice.example.com/mcp", "https://memory-alice.example.com/mcp/"]) {
    assert.deepEqual(teamAddress(value), { ok: true, host: "memory-alice.example.com", url: "https://memory-alice.example.com/mcp" }, value);
  }
  for (const value of ["", "http://memory-alice.example.com/mcp", "https://memory-alice.example.com:8443/mcp", "https://memory-alice.example.com/mcp?x=1", "https://memory-alice.example.com/other", "https://user:pass@memory-alice.example.com/mcp", "localhost", "https://memory-alice.example.com/mcp#a"]) {
    assert.equal(teamAddress(value).ok, false, value);
  }

  const text = teamAddressText([{ name: "memory", host: "memory.example.com" }, { name: "alice", host: "memory-alice.example.com" }]);
  assert.equal(text, "memory https://memory.example.com/mcp\nalice https://memory-alice.example.com/mcp");
  const parsed = parseTeamAddresses(`${text}\n\n# a comment\nmemory-bob.example.com\nnot a line at all\nBad_Name https://memory-carol.example.com/mcp\nalice https://memory-alice.example.com`);
  assert.deepEqual(parsed.servers, [
    { name: "memory", host: "memory.example.com", url: "https://memory.example.com/mcp" },
    { name: "alice", host: "memory-alice.example.com", url: "https://memory-alice.example.com/mcp" },
    { name: "bob", host: "memory-bob.example.com", url: "https://memory-bob.example.com/mcp" },
  ]);
  assert.deepEqual(parsed.errors.map((item) => item.line), [6, 7]);
});

// Claude Code and Codex as their CLIs would leave their files, without running either.
// `codex mcp remove` takes the entry's sub-tables with it, as 0.154 and 0.160 do; with
// `keepsTools` it leaves them. `loginHelp` is what `codex mcp login --help` prints, or
// a function of the codex asked (null: the one on PATH). No desktop app's codex is
// looked at unless a test names some in `appCodexClis`.
async function clientFixture(t, { missing = [], keepsTools = false, loginHelp = "" } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-clients-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fsp.mkdir(path.join(home, ".codex"), { recursive: true });
  const claudeFile = path.join(home, ".claude.json");
  const codexFile = path.join(home, ".codex", "config.toml");
  await fsp.writeFile(claudeFile, JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "other" } } }, null, 2));
  await fsp.writeFile(codexFile, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
  const calls = [];
  const helpAsked = [];
  const clientRunner = async (client, args, { binary = null } = {}) => {
    calls.push([client, ...args]);
    if (missing.includes(client)) return { missing: true };
    if (args[0] === "--version") return { code: 0, stdout: `${client} 1.0.0\n`, stderr: "" };
    if (client === "claude") {
      const document = JSON.parse(await fsp.readFile(claudeFile, "utf8"));
      if (args[1] === "add") document.mcpServers[args[6]] = { type: args[3], url: args[7] };
      if (args[1] === "remove") delete document.mcpServers[args[2]];
      await fsp.writeFile(claudeFile, JSON.stringify(document, null, 2));
    } else if (args[1] === "login") {
      helpAsked.push(binary);
      return { code: 0, stdout: typeof loginHelp === "function" ? loginHelp(binary) : loginHelp, stderr: "" };
    } else {
      let text = await fsp.readFile(codexFile, "utf8");
      const name = args[2];
      const tables = keepsTools ? `\\[mcp_servers\\.${name}\\]` : `\\[mcp_servers\\.${name}(?:\\.[^\\]]+)?\\]`;
      const table = new RegExp(`\\n${tables}\\n[^\\[]*`);
      while (table.test(text)) text = text.replace(table, "\n");
      if (args[1] === "add") text += `\n[mcp_servers.${name}]\nurl = "${args[4]}"\n`;
      await fsp.writeFile(codexFile, text);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const serverDirectory = path.join(root, "app", "server");
  return { root, home, claudeFile, codexFile, calls, helpAsked, serverDirectory, options: { homeDir: home, env: {}, clientRunner, serverDirectory, appCodexClis: [] } };
}

test("teammates connect adds team-<name> to Claude Code and Codex with no token; the same address again changes nothing, another replaces it", async (t) => {
  const f = await clientFixture(t);
  const added = await teammateConnect({ ...f.options, name: "Alice", address: "memory-alice.example.com" });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.entry, "team-alice");
  assert.equal(added.url, "https://memory-alice.example.com/mcp");
  assert.deepEqual(added.clients, { claude: { ok: true, action: "added" }, codex: { ok: true, action: "added", approval: "set" } });
  assert.deepEqual(f.calls, [
    ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "team-alice", "https://memory-alice.example.com/mcp"],
    ["codex", "--version"],
  ], "Codex's entry is written here, since codex mcp add would start its own browser login");
  assert.match(added.login.claude, /\/mcp/);
  assert.equal(added.login.codex, "codex mcp login --no-browser team-alice");
  assert.equal(await fsp.readFile(f.codexFile, "utf8"), [
    'model = "gpt-5"', "", "[mcp_servers.other]", 'command = "other"', "",
    "[mcp_servers.team-alice]", 'url = "https://memory-alice.example.com/mcp"', "",
    "[mcp_servers.team-alice.tools.chat]", 'approval_mode = "approve"', "",
  ].join("\n"), "the entry as codex mcp add writes it, chat approved; nothing else changes");
  const claude = JSON.parse(await fsp.readFile(f.claudeFile, "utf8"));
  assert.deepEqual(claude.mcpServers["team-alice"], { type: "http", url: "https://memory-alice.example.com/mcp" }, "no header, no token");
  assert.deepEqual(claude.mcpServers.other, { type: "stdio", command: "other" });
  assert.deepEqual(await registeredTeamServers({ homeDir: f.home, env: {} }), {
    claude: { "team-alice": { url: "https://memory-alice.example.com/mcp", type: "http" } },
    codex: { "team-alice": { url: "https://memory-alice.example.com/mcp" } },
  });

  f.calls.length = 0;
  const again = await teammateConnect({ ...f.options, name: "alice", address: "https://memory-alice.example.com/mcp" });
  assert.deepEqual(again.clients, { claude: { ok: true, action: "unchanged" }, codex: { ok: true, action: "unchanged", approval: "unchanged" } });
  assert.deepEqual(f.calls, [["codex", "--version"]], "the same address adds or removes nothing");

  f.calls.length = 0;

  const moved = await teammateConnect({ ...f.options, name: "alice", address: "https://memory-alice2.example.com" });
  assert.deepEqual(moved.clients, { claude: { ok: true, action: "replaced" }, codex: { ok: true, action: "replaced", approval: "unchanged" } });
  assert.deepEqual(f.calls.map((call) => call.slice(0, 3).join(" ")), ["claude mcp remove", "claude mcp add", "codex --version"]);
  assert.equal((await registeredTeamServers({ homeDir: f.home, env: {} })).codex["team-alice"].url, "https://memory-alice2.example.com/mcp");
  assert.match(await fsp.readFile(f.codexFile, "utf8"), /\[mcp_servers\.team-alice\]\nurl = "https:\/\/memory-alice2\.example\.com\/mcp"\n\n\[mcp_servers\.team-alice\.tools\.chat\]\napproval_mode = "approve"\n$/, "the url changed in place");

  for (const [name, address] of [["a b", "memory-alice.example.com"], ["alice", "http://memory-alice.example.com"], ["alice", "--url=x"]]) {
    const refused = await teammateConnect({ ...f.options, name, address });
    assert.equal(refused.ok, false, `${name} ${address}`);
  }

  f.calls.length = 0;
  const gone = await teammateDisconnect({ ...f.options, name: "alice" });
  assert.deepEqual(gone.clients, { claude: { ok: true, action: "removed" }, codex: { ok: true, action: "removed" } });
  assert.deepEqual(f.calls, [["claude", "mcp", "remove", "team-alice", "--scope", "user"], ["codex", "mcp", "remove", "team-alice"]]);
  const absent = await teammateDisconnect({ ...f.options, name: "alice" });
  assert.deepEqual(absent.clients, { claude: { ok: true, action: "absent" }, codex: { ok: true, action: "absent" } });
  const codexText = await fsp.readFile(f.codexFile, "utf8");
  assert.doesNotMatch(codexText, /team-alice/, "the approval went with the entry");
  assert.match(codexText, /^model = "gpt-5"\n\n\[mcp_servers\.other\]\ncommand = "other"\n/, "other entries stay");
});

test("Codex's approval for chat: a mode the user set stays, a table left without its entry goes, and nothing is written without the entry", async (t) => {
  const f = await clientFixture(t);
  await teammateConnect({ ...f.options, name: "alice", address: "memory-alice.example.com" });
  const own = (await fsp.readFile(f.codexFile, "utf8")).replace('approval_mode = "approve"', 'approval_mode = "prompt"');
  await fsp.writeFile(f.codexFile, own);
  const kept = await teammateConnect({ ...f.options, name: "alice", address: "memory-alice.example.com" });
  assert.equal(kept.clients.codex.approval, "kept");
  assert.equal(await fsp.readFile(f.codexFile, "utf8"), own, "the user's own mode is not touched");
  await fsp.writeFile(f.codexFile, own.replace('approval_mode = "prompt"\n', "# mine\n"));
  assert.equal((await teammateConnect({ ...f.options, name: "alice", address: "memory-alice.example.com" })).clients.codex.approval, "set");
  assert.match(await fsp.readFile(f.codexFile, "utf8"), /\[mcp_servers\.team-alice\.tools\.chat\]\napproval_mode = "approve"\n# mine\n/);

  // A Codex whose remove left the table: Codex would read no config at all, so disconnect takes it away.
  const old = await clientFixture(t, { keepsTools: true });
  await teammateConnect({ ...old.options, name: "alice", address: "memory-alice.example.com" });
  const gone = await teammateDisconnect({ ...old.options, name: "alice" });
  assert.deepEqual(gone.clients.codex, { ok: true, action: "removed", approval: "removed" });
  assert.equal(await fsp.readFile(old.codexFile, "utf8"), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
  // One with more in it than connecting wrote is the user's.
  const theirs = 'model = "gpt-5"\n\n[mcp_servers.team-bob.tools.chat]\napproval_mode = "approve"\nenabled = false\n';
  await fsp.writeFile(old.codexFile, theirs);
  assert.deepEqual((await teammateDisconnect({ ...old.options, name: "bob" })).clients.codex, { ok: true, action: "absent" });
  assert.equal(await fsp.readFile(old.codexFile, "utf8"), theirs);

  // Another address changes only the url line; the rest of the entry stays.
  const more = await clientFixture(t);
  await fsp.appendFile(more.codexFile, '\n[mcp_servers.team-alice]\nurl = "https://memory-alice.example.com/mcp"  # theirs\nstartup_timeout_sec = 30\n');
  const moved = await teammateConnect({ ...more.options, name: "alice", address: "memory-alice2.example.com" });
  assert.deepEqual(moved.clients.codex, { ok: true, action: "replaced", approval: "set" });
  assert.match(await fsp.readFile(more.codexFile, "utf8"), /\[mcp_servers\.team-alice\]\nurl = "https:\/\/memory-alice2\.example\.com\/mcp"  # theirs\nstartup_timeout_sec = 30\n\n\[mcp_servers\.team-alice\.tools\.chat\]/);
  // An entry with no address is taken out by Codex and goes in anew.
  await fsp.writeFile(more.codexFile, 'model = "gpt-5"\n\n[mcp_servers.team-alice]\ncommand = "alice"\n');
  more.calls.length = 0;
  assert.equal((await teammateConnect({ ...more.options, name: "alice", address: "memory-alice.example.com" })).clients.codex.action, "replaced");
  assert.deepEqual(more.calls.filter((call) => call[0] === "codex"), [["codex", "--version"], ["codex", "mcp", "remove", "team-alice"]]);
  assert.doesNotMatch(await fsp.readFile(more.codexFile, "utf8"), /command/);
  // An entry kept as a key of [mcp_servers] is not touched: a second table would break the file.
  const inline = 'model = "gpt-5"\n\n[mcp_servers]\nteam-alice = { command = "alice" }\n';
  await fsp.writeFile(more.codexFile, inline);
  const refused = await teammateConnect({ ...more.options, name: "alice", address: "memory-alice.example.com" });
  assert.equal(refused.clients.codex.ok, false);
  assert.match(refused.clients.codex.error, /form this app does not change/);
  assert.equal(await fsp.readFile(more.codexFile, "utf8"), inline);
  // No config.toml yet: it is made, under CODEX_HOME when that is set.
  const fresh = path.join(more.root, "fresh-codex-home");
  const made = await teammateConnect({ ...more.options, env: { CODEX_HOME: fresh }, name: "dave", address: "memory-dave.example.com" });
  assert.equal(made.clients.codex.action, "added");
  assert.equal(await fsp.readFile(path.join(fresh, "config.toml"), "utf8"), '[mcp_servers.team-dave]\nurl = "https://memory-dave.example.com/mcp"\n\n[mcp_servers.team-dave.tools.chat]\napproval_mode = "approve"\n');

  // CODEX_HOME is where Codex keeps it; a config.toml that is a link stays one, its mode kept, CRLF kept.
  if (process.platform !== "win32") {
    const codexHome = path.join(f.root, "codex-home");
    const real = path.join(f.root, "dotfiles", "config.toml");
    await fsp.mkdir(codexHome, { recursive: true });
    await fsp.mkdir(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, 'model = "gpt-5"\r\n', { mode: 0o600 });
    await fsp.symlink(real, path.join(codexHome, "config.toml"));
    const env = { CODEX_HOME: codexHome };
    const runner = async () => ({ code: 0, stdout: "", stderr: "" });
    const linked = await teammateConnect({ ...f.options, env, clientRunner: runner, name: "carol", address: "memory-carol.example.com" });
    assert.equal(linked.clients.codex.approval, "set");
    assert.equal((await fsp.lstat(path.join(codexHome, "config.toml"))).isSymbolicLink(), true);
    assert.equal((await fsp.stat(real)).mode & 0o777, 0o600);
    assert.equal(await fsp.readFile(real, "utf8"), 'model = "gpt-5"\r\n\r\n[mcp_servers.team-carol]\r\nurl = "https://memory-carol.example.com/mcp"\r\n\r\n[mcp_servers.team-carol.tools.chat]\r\napproval_mode = "approve"\r\n');
  }
});

test("a missing client is named and the other is still connected; with neither, nothing is", async (t) => {
  const one = await clientFixture(t, { missing: ["codex"] });
  const codexBefore = await fsp.readFile(one.codexFile, "utf8");
  const result = await teammateConnect({ ...one.options, name: "alice", address: "memory-alice.example.com" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, ["codex"]);
  assert.equal(result.clients.claude.action, "added");
  assert.match(result.clients.codex.error, /Codex \(codex\) was not found/);
  assert.equal(await fsp.readFile(one.codexFile, "utf8"), codexBefore, "without a codex CLI its config is not written");

  const none = await clientFixture(t, { missing: ["claude", "codex"] });
  const nothing = await teammateConnect({ ...none.options, name: "alice", address: "memory-alice.example.com" });
  assert.equal(nothing.ok, false);
  assert.deepEqual(nothing.missing, ["claude", "codex"]);
  assert.match(nothing.error, /Neither Claude Code \(claude\) nor Codex \(codex\)/);
});

test("teammates connected lists the invite's team and the owner's, leaves this computer's own server out, and adds what the clients already have", async (t) => {
  const f = await clientFixture(t);
  const runtime = path.join(f.root, "app", "runtime");
  await fsp.mkdir(runtime, { recursive: true });
  await fsp.writeFile(path.join(runtime, "share.json"), JSON.stringify({
    host: "memory-bob.example.com",
    joined: true,
    team: [{ name: "memory", host: "memory.example.com" }, { name: "bob", host: "memory-bob.example.com" }, { name: "alice", host: "memory-alice.example.com" }],
  }));
  assert.deepEqual((await knownTeamServers({ serverDirectory: f.serverDirectory })).map((item) => [item.name, item.sources]), [["memory", ["invite"]], ["alice", ["invite"]]]);

  await teammateConnect({ ...f.options, name: "alice", address: "memory-alice.example.com" });
  await teammateConnect({ ...f.options, name: "carol", address: "memory-carol.example.com", clientRunner: async (client, args) => (client === "codex" ? { missing: true } : f.options.clientRunner(client, args)) });
  const listed = await teammatesConnected(f.options);
  assert.equal(listed.ok, true);
  assert.equal(listed.connected, 2);
  const byName = Object.fromEntries(listed.servers.map((item) => [item.name, item]));
  assert.deepEqual(Object.keys(byName), ["memory", "alice", "carol"]);
  assert.deepEqual(byName.memory.claude, { registered: false });
  assert.deepEqual(byName.alice.claude, { registered: true, url: "https://memory-alice.example.com/mcp", same: true });
  assert.deepEqual(byName.alice.codex, { registered: true, url: "https://memory-alice.example.com/mcp", same: true });
  assert.deepEqual(byName.carol.sources, []);
  assert.deepEqual(byName.carol.codex, { registered: false });
  assert.equal(byName.carol.entry, "team-carol");
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

// What Codex 0.160.1 printed for `codex mcp login --no-browser`, its query shortened.
const NO_BROWSER_HELP = "Usage: codex mcp login [OPTIONS] <NAME>\n\nOptions:\n      --no-browser\n          Print the authorization URL and accept the callback URL without opening a browser\n";
const NO_BROWSER_OUTPUT = "Authorize the MCP server by opening this URL in your browser:\nhttps://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A53299%2Fcallback%2Fx\n\nAfter signing in, copy the full URL from your browser's address bar.\nIf the callback page cannot load, paste that URL here anyway.\n\n";

test("Codex login runs codex mcp login --no-browser team-<name> and hands the page the address it printed; a Codex without the option opens its own browser", async (t) => {
  const f = await clientFixture(t, { loginHelp: NO_BROWSER_HELP });
  assert.match((await codexLogin({ ...f.options, name: "alice" })).error, /not in Codex yet/);
  await teammateConnect({ ...f.options, name: "alice", address: "memory-alice.example.com" });

  f.calls.length = 0;
  const spawned = [];
  const printing = fakeChild();
  const waiting = await codexLogin({ ...f.options, name: "alice", waitMs: 5_000, loginSpawner: (_ctx, args, binary) => {
    spawned.push([args, binary]);
    setImmediate(() => { printing.stdout.emit("data", NO_BROWSER_OUTPUT); printing.stderr.emit("data", "Callback URL (input hidden): "); });
    return printing;
  } });
  assert.deepEqual(f.calls, [["codex", "mcp", "login", "--help"]]);
  assert.deepEqual(spawned, [[["mcp", "login", "--no-browser", "team-alice"], null]], "the codex on PATH");
  assert.deepEqual(waiting, {
    entry: "team-alice",
    noBrowser: true,
    ok: true,
    state: "waiting",
    loginUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A53299%2Fcallback%2Fx",
  });
  printing.emit("exit", 0);

  const quick = fakeChild();
  const done = await codexLogin({ ...f.options, name: "alice", waitMs: 5_000, loginSpawner: () => { setImmediate(() => quick.emit("exit", 0)); return quick; } });
  assert.deepEqual(done, { entry: "team-alice", noBrowser: true, ok: true, state: "done" });

  const failing = fakeChild();
  const failed = await codexLogin({ ...f.options, name: "alice", waitMs: 5_000, loginSpawner: () => {
    setImmediate(() => { failing.stderr.emit("data", "Error: No OAuth callback URL received before input closed\n"); failing.emit("exit", 1); });
    return failing;
  } });
  assert.deepEqual(failed, { entry: "team-alice", noBrowser: true, ok: false, state: "failed", error: "Error: No OAuth callback URL received before input closed" });

  const silent = fakeChild();
  const quiet = await codexLogin({ ...f.options, name: "alice", waitMs: 10, loginSpawner: () => silent });
  assert.deepEqual(quiet, { entry: "team-alice", noBrowser: true, ok: true, state: "waiting", loginUrl: null });
  silent.emit("exit", 0);
  assert.equal((await codexLogin({ ...f.options, name: "alice", loginSpawner: () => null })).missing, true);

  // The codex on PATH is 0.154, without --no-browser: the ChatGPT app's codex that has it logs in instead.
  const OLD_HELP = "Usage: codex mcp login [OPTIONS] <NAME>\n\nOptions:\n      --scopes <SCOPE,SCOPE>\n";
  const apps = await clientFixture(t);
  const app = (name) => path.join(apps.root, "apps", name, "codex");
  for (const name of ["old", "new", "plain"]) {
    await fsp.mkdir(path.dirname(app(name)), { recursive: true });
    await fsp.writeFile(app(name), "#!/bin/sh\n", { mode: name === "plain" && process.platform !== "win32" ? 0o644 : 0o755 });
  }
  const helps = { [app("new")]: NO_BROWSER_HELP, [app("plain")]: NO_BROWSER_HELP };
  const appOptions = { ...apps.options, appCodexClis: [app("gone"), app("plain"), app("old"), app("new")] };
  const appRunner = async (client, args, options = {}) => (args[1] === "login" && args[2] === "--help"
    ? (apps.helpAsked.push(options.binary ?? null), { code: 0, stdout: helps[options.binary] ?? OLD_HELP, stderr: "" })
    : apps.options.clientRunner(client, args, options));
  await teammateConnect({ ...appOptions, name: "alice", address: "memory-alice.example.com" });
  const fromApp = [];
  const appLogin = await codexLogin({ ...appOptions, clientRunner: appRunner, name: "alice", waitMs: 5_000, loginSpawner: (_ctx, args, binary) => {
    fromApp.push([args, binary]);
    const child = fakeChild();
    setImmediate(() => child.stdout.emit("data", NO_BROWSER_OUTPUT));
    return child;
  } });
  assert.deepEqual(apps.helpAsked, process.platform === "win32" ? [null, app("plain")] : [null, app("old"), app("new")], "a missing or non-executable one is not asked");
  assert.deepEqual(fromApp, [[["mcp", "login", "--no-browser", "team-alice"], process.platform === "win32" ? app("plain") : app("new")]]);
  assert.equal(appLogin.noBrowser, true);
  assert.match(appLogin.loginUrl, /^https:\/\/team\.cloudflareaccess\.com\//);

  // None has --no-browser: today's login, which opens the default browser itself.
  const older = await clientFixture(t, { loginHelp: OLD_HELP });
  await teammateConnect({ ...older.options, name: "alice", address: "memory-alice.example.com" });
  const plain = [];
  const opening = fakeChild();
  const fallback = await codexLogin({ ...older.options, appCodexClis: [app("old")], name: "alice", waitMs: 5_000, loginSpawner: (_ctx, args, binary) => {
    plain.push(args);
    assert.equal(binary, null);
    setImmediate(() => opening.stdout.emit("data", "Authorize `team-alice` by opening this URL in your browser:\nhttps://login.example.com/authorize?client=team\n"));
    return opening;
  } });
  assert.deepEqual(older.helpAsked, [null, app("old")]);
  assert.deepEqual(plain, [["mcp", "login", "team-alice"]]);
  assert.deepEqual(fallback, { entry: "team-alice", noBrowser: false, ok: true, state: "waiting", loginUrl: "https://login.example.com/authorize?client=team" });
  opening.emit("exit", 0);
  // A help that fails to run counts as no option, too.
  const broken = await codexLogin({ ...older.options, name: "alice", waitMs: 10, clientRunner: async () => ({ code: 2, stdout: "--no-browser", stderr: "" }), loginSpawner: (_ctx, args) => { plain.push(args); return fakeChild(); } });
  assert.equal(broken.noBrowser, false);
  assert.deepEqual(plain.at(-1), ["mcp", "login", "team-alice"]);
});

test("the Codex login status: the login this app started while it runs and once when it ends, else what Codex holds, and nothing but the state", async (t) => {
  const f = await clientFixture(t, { loginHelp: NO_BROWSER_HELP });
  let auth = "not_logged_in";
  let listFails = false;
  const SECRET = "Bearer header-secret-0123";
  // `codex mcp list --json` as 0.154 and 0.160 print it: every server in config.toml, with its headers.
  const listing = async () => JSON.stringify([
    { name: "other", enabled: true, auth_status: "unsupported", transport: { type: "streamable_http", url: "https://other.example.com/mcp", http_headers: { Authorization: SECRET } } },
    ...((await fsp.readFile(f.codexFile, "utf8")).includes("[mcp_servers.team-alice]")
      ? [{ name: "team-alice", enabled: true, auth_status: auth, transport: { type: "streamable_http", url: "https://memory-alice.example.com/mcp", http_headers: null } }]
      : []),
  ]);
  const options = { ...f.options, clientRunner: async (client, args, more) => (args.join(" ") === "mcp list --json"
    ? (f.calls.push([client, ...args]), { code: listFails ? 1 : 0, stdout: await listing(), stderr: listFails ? "Error: config.toml is broken\n" : "" })
    : f.options.clientRunner(client, args, more)) };
  assert.match((await codexLoginStatus({ ...options, name: "Not A Name" })).error, /short name/);
  assert.match((await codexLoginStatus({ ...options, name: "alice" })).error, /not in Codex yet/);
  await teammateConnect({ ...options, name: "alice", address: "memory-alice.example.com" });

  // No login started here: what Codex holds.
  const needed = await codexLoginStatus({ ...options, name: "alice" });
  assert.deepEqual(needed, { ok: true, entry: "team-alice", state: "needed" });
  auth = "o_auth";
  const held = await codexLoginStatus({ ...options, name: "alice" });
  assert.deepEqual(held, { ok: true, entry: "team-alice", state: "done" });
  listFails = true;
  const broken = await codexLoginStatus({ ...options, name: "alice" });
  assert.deepEqual(broken, { ok: false, error: "Error: config.toml is broken" });
  for (const answer of [needed, held, broken]) assert.equal(JSON.stringify(answer).includes(SECRET), false);
  listFails = false;

  // A login started: waiting while it runs, without asking Codex; done once it ends, then Codex again.
  const first = fakeChild();
  const login = (child) => codexLogin({ ...options, name: "alice", waitMs: 5_000, loginSpawner: () => { setImmediate(() => child.stdout.emit("data", NO_BROWSER_OUTPUT)); return child; } });
  assert.equal((await login(first)).state, "waiting");
  f.calls.length = 0;
  assert.deepEqual(await codexLoginStatus({ ...options, name: "alice" }), { ok: true, entry: "team-alice", state: "waiting" });
  assert.deepEqual(f.calls, []);
  first.emit("exit", 0);
  auth = "not_logged_in";
  assert.deepEqual(await codexLoginStatus({ ...options, name: "alice" }), { ok: true, entry: "team-alice", state: "done" });
  assert.deepEqual(await codexLoginStatus({ ...options, name: "alice" }), { ok: true, entry: "team-alice", state: "needed" }, "read back once");

  // Starting again ends the login before it, whose end then changes nothing; the new one's failure is told once.
  const older = fakeChild();
  const newer = fakeChild();
  await login(older);
  await login(newer);
  assert.equal(older.killed, true);
  older.emit("exit", null);
  assert.deepEqual(await codexLoginStatus({ ...options, name: "alice" }), { ok: true, entry: "team-alice", state: "waiting" });
  newer.stderr.emit("data", "Error: OAuth provider returned `access_denied`\n");
  newer.emit("exit", 1);
  assert.deepEqual(await codexLoginStatus({ ...options, name: "alice" }), { ok: true, entry: "team-alice", state: "failed", error: "Error: OAuth provider returned `access_denied`" });
  assert.equal((await codexLoginStatus({ ...options, name: "alice" })).state, "needed");

  assert.equal((await codexLoginStatus({ ...options, name: "alice", clientRunner: async () => ({ missing: true }) })).missing, true);
});

test("the CLI connects, lists and disconnects through the real client commands on PATH", { skip: process.platform === "win32" }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-cli-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fsp.mkdir(path.join(home, ".codex"), { recursive: true });
  await fsp.mkdir(bin);
  const log = path.join(root, "calls.log");
  // Stand-ins for claude and codex that record their arguments and edit the same files the real ones do.
  const shim = (client) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(client)}, ...args]) + "\\n");
const home = process.env.HOME;
if (${JSON.stringify(client)} === "claude") {
  const file = path.join(home, ".claude.json");
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  doc.mcpServers = doc.mcpServers || {};
  if (args[1] === "add") doc.mcpServers[args[6]] = { type: args[3], url: args[7] };
  if (args[1] === "remove") delete doc.mcpServers[args[2]];
  fs.writeFileSync(file, JSON.stringify(doc));
} else {
  const file = path.join(home, ".codex", "config.toml");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const at = args[1] === "remove" ? text.indexOf("[mcp_servers." + args[2] + "]") : -1;
  if (at >= 0) fs.writeFileSync(file, text.slice(0, at));
}
`;
  for (const client of ["claude", "codex"]) await fsp.writeFile(path.join(bin, client), shim(client), { mode: 0o755 });
  const env = {
    PATH: bin,
    HOME: home,
    HONCHO_AGENT_BRIDGE_USER_HOME: home,
    HONCHO_AGENT_BRIDGE_HOME: path.join(root, "app"),
    HONCHO_AGENT_BRIDGE_SERVER_DIR: path.join(root, "app", "server"),
    CLAUDE_CONFIG_DIR: "",
    CODEX_HOME: "",
  };
  const connected = await cli(["teammates", "connect", "alice", "https://memory-alice.example.com/mcp"], env);
  assert.equal(connected.code, 0, connected.stdout + connected.stderr);
  assert.deepEqual(connected.json.clients, { claude: { ok: true, action: "added" }, codex: { ok: true, action: "added", approval: "set" } });
  assert.equal(await fsp.readFile(path.join(home, ".codex", "config.toml"), "utf8"),
    '[mcp_servers.team-alice]\nurl = "https://memory-alice.example.com/mcp"\n\n[mcp_servers.team-alice.tools.chat]\napproval_mode = "approve"\n');
  const calls = (await fsp.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, [
    ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "team-alice", "https://memory-alice.example.com/mcp"],
    ["codex", "--version"],
  ]);
  const listed = await cli(["teammates", "connected"], env);
  assert.equal(listed.json.connected, 1);
  assert.deepEqual(listed.json.clients, { claude: { name: "Claude Code", found: true }, codex: { name: "Codex", found: true } });
  assert.equal((await cli(["teammates", "connect", "alice", "memory-alice.example.com"], env)).json.clients.codex.action, "unchanged");
  const gone = await cli(["teammates", "disconnect", "alice"], env);
  assert.deepEqual(gone.json.clients, { claude: { ok: true, action: "removed" }, codex: { ok: true, action: "removed" } });
  assert.equal(await fsp.readFile(path.join(home, ".codex", "config.toml"), "utf8"), "");
  const bad = await cli(["teammates", "connect", "alice", "http://memory-alice.example.com"], env);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /https/);

  await fsp.rm(path.join(bin, "codex"));
  const half = await cli(["teammates", "connect", "bob", "memory-bob.example.com"], env);
  assert.equal(half.json.ok, true);
  assert.deepEqual(half.json.missing, ["codex"]);
});
