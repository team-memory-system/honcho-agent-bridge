// Setup installs this plugin into Claude Code or Codex when it collects from a host
// that lacks it: the source each host's record gives, the CLI it finds (the Codex
// desktop app's own one too), the calls it makes through a fake client runner, and
// the CLI end to end against stand-ins for claude and codex on PATH.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  DEFAULT_MARKETPLACE,
  DEFAULT_SOURCE,
  hostCli,
  hostPluginPlan,
  installHostPlugins,
  manualCommands,
  PLUGIN_INSTALL_TIMEOUT_MS,
  pluginSource,
} from "../scripts/host-plugins.mjs";
import { clientCommand } from "../scripts/team-access.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const CHECKOUT = "/srv/checkouts/honcho-agent-bridge";

async function home(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-host-plugins-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "home");
  await fsp.mkdir(path.join(dir, ".claude", "plugins"), { recursive: true });
  await fsp.mkdir(path.join(dir, ".codex"), { recursive: true });
  return { root, home: dir };
}

/** Claude Code's two files as `claude plugin install` leaves them. */
async function claudeRecord(dir, source, name = "honcho-agent-bridge") {
  await fsp.writeFile(path.join(dir, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify({
    "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
    [name]: { source, installLocation: "/elsewhere", lastUpdated: "2026-10-06T00:00:00.000Z" },
  }));
  await fsp.writeFile(path.join(dir, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { [`honcho-agent-bridge@${name}`]: [{ scope: "user", version: "0.4.2" }] },
  }));
}

/** ~/.codex/config.toml as `codex plugin marketplace add` and `codex plugin add` leave it. */
async function codexRecord(dir, table, name = "honcho-agent-bridge") {
  await fsp.writeFile(path.join(dir, ".codex", "config.toml"), [
    'model = "gpt-5"',
    "",
    "[marketplaces.openai-bundled]",
    'source_type = "local"',
    'source = "/somewhere/else"',
    "",
    `[marketplaces.${name}]`,
    'last_updated = "2026-10-05T13:22:00Z"',
    ...table,
    "",
    `[plugins."honcho-agent-bridge@${name}"]`,
    "enabled = true",
    "",
  ].join("\n"));
}

async function executable(file, text = "#!/bin/sh\nexit 0\n") {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, { mode: 0o755 });
  return file;
}

test("Codex gets the source of Claude Code's record: a GitHub repo with its ref, a git URL, a directory", async (t) => {
  const f = await home(t);
  await claudeRecord(f.home, { source: "github", repo: "team-memory-system/honcho-agent-bridge", ref: "main" });
  assert.deepEqual(await pluginSource("codex", { home: f.home }), {
    source: "team-memory-system/honcho-agent-bridge", ref: "main", marketplace: "honcho-agent-bridge", from: "claude",
  });
  await claudeRecord(f.home, { source: "git", url: "https://git.example.com/team/bridge.git" }, "team-tools");
  assert.deepEqual(await pluginSource("codex", { home: f.home }), {
    source: "https://git.example.com/team/bridge.git", marketplace: "team-tools", from: "claude",
  });
  await claudeRecord(f.home, { source: "directory", path: CHECKOUT });
  assert.deepEqual(await pluginSource("codex", { home: f.home }), { source: CHECKOUT, marketplace: "honcho-agent-bridge", from: "claude" });
  assert.deepEqual(manualCommands("codex", await pluginSource("codex", { home: f.home })), [
    `codex plugin marketplace add ${CHECKOUT}`,
    "codex plugin add honcho-agent-bridge@honcho-agent-bridge",
  ]);
});

test("Claude Code gets the source of Codex's record, the ref after #", async (t) => {
  const f = await home(t);
  await codexRecord(f.home, ['source_type = "git"', 'source = "https://github.com/team-memory-system/honcho-agent-bridge.git"', 'ref = "main"']);
  const git = await pluginSource("claude", { home: f.home });
  assert.deepEqual(git, {
    source: "https://github.com/team-memory-system/honcho-agent-bridge.git", ref: "main", marketplace: "honcho-agent-bridge", from: "codex",
  });
  assert.deepEqual(manualCommands("claude", git), [
    "claude plugin marketplace add https://github.com/team-memory-system/honcho-agent-bridge.git#main",
    "claude plugin install honcho-agent-bridge@honcho-agent-bridge --scope user",
  ]);
  await codexRecord(f.home, ['source_type = "local"', `source = '${CHECKOUT}'`], "local-bridge");
  assert.deepEqual(await pluginSource("claude", { home: f.home }), { source: CHECKOUT, marketplace: "local-bridge", from: "codex" });
});

test("without a usable record the source is the GitHub repository, and an unsafe path is never passed on", async (t) => {
  const f = await home(t);
  const fallback = { source: DEFAULT_SOURCE, marketplace: DEFAULT_MARKETPLACE, from: "default" };
  assert.deepEqual(await pluginSource("codex", { home: f.home }), fallback);
  assert.deepEqual(await pluginSource("claude", { home: f.home }), fallback);
  for (const source of [
    { source: "directory", path: "/Users/someone/My Plugins/honcho-agent-bridge" },
    { source: "directory", path: "/tmp/bridge&calc" },
    { source: "directory", path: "relative/checkout" },
    { source: "github", repo: "--upload-pack=evil/x" },
    { source: "github", repo: "team-memory-system/honcho-agent-bridge", ref: "main & calc" },
    { source: "url", url: "https://example.com/marketplace.json" },
  ]) {
    await claudeRecord(f.home, source);
    assert.deepEqual(await pluginSource("codex", { home: f.home }), fallback, JSON.stringify(source));
  }
  await codexRecord(f.home, ['source_type = "local"', 'source = "C:\\\\Users\\\\me\\\\bridge"']);
  assert.deepEqual(await pluginSource("claude", { home: f.home }), fallback, "a Windows path with backslashes does not pass the guard");
  assert.deepEqual(manualCommands("codex", fallback), [
    "codex plugin marketplace add team-memory-system/honcho-agent-bridge",
    "codex plugin add honcho-agent-bridge@honcho-agent-bridge",
  ]);
});

test("Codex's CLI is the one on PATH, else the desktop app's: CODEX_CLI_PATH, then config.toml, then the app bundle", async (t) => {
  const f = await home(t);
  const empty = path.join(f.root, "empty-bin");
  await fsp.mkdir(empty);
  const base = { home: f.home, platform: "linux", appClis: [] };
  assert.equal(await hostCli("codex", { ...base, env: { PATH: empty } }), null);

  const fromEnv = await executable(path.join(f.root, "env-app", "codex"));
  assert.equal(await hostCli("codex", { ...base, env: { PATH: empty, CODEX_CLI_PATH: fromEnv } }), fromEnv);

  const fromConfig = await executable(path.join(f.root, "config-app", "codex"));
  await fsp.writeFile(path.join(f.home, ".codex", "config.toml"), `[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = '${fromConfig}'\n`);
  assert.equal(await hostCli("codex", { ...base, env: { PATH: empty, CODEX_CLI_PATH: path.join(f.root, "gone", "codex") } }), fromConfig);

  await fsp.rm(fromConfig);
  const bundle = await executable(path.join(f.root, "Codex.app", "Contents", "Resources", "codex"));
  assert.equal(await hostCli("codex", { ...base, env: { PATH: empty }, appClis: [path.join(f.root, "nothing"), bundle] }), bundle);

  const onPath = await executable(path.join(f.root, "bin", "codex"));
  assert.equal(await hostCli("codex", { ...base, env: { PATH: path.dirname(onPath), CODEX_CLI_PATH: fromEnv } }), onPath);
  assert.equal(await hostCli("claude", { ...base, env: { PATH: empty, CODEX_CLI_PATH: fromEnv } }), null, "only Codex has the app fallback");
});

test("the plan installs where the plugin is missing, leaves a turned-off one off, and names the commands when there is no CLI", async (t) => {
  const f = await home(t);
  const bin = path.join(f.root, "bin");
  await executable(path.join(bin, "codex"));
  const options = { home: f.home, env: { PATH: bin }, platform: "linux", appClis: [] };
  const plan = await hostPluginPlan({ codex: true, claude: true }, { ...options, statuses: { codex: { installed: false }, claude: { installed: false } } });
  assert.deepEqual(plan.map((entry) => [entry.agent, entry.state]), [["codex", "install"], ["claude", "missing-cli"]]);
  assert.equal(plan[0].cli, path.join(bin, "codex"));
  assert.deepEqual(plan[1].commands, [
    "claude plugin marketplace add team-memory-system/honcho-agent-bridge",
    "claude plugin install honcho-agent-bridge@honcho-agent-bridge --scope user",
  ]);
  const installed = await hostPluginPlan({ codex: true, claude: true }, { ...options, statuses: { codex: { installed: true, enabled: true }, claude: { installed: true, enabled: false } } });
  assert.deepEqual(installed, [{ agent: "codex", state: "enabled" }, { agent: "claude", state: "disabled" }]);
  assert.deepEqual(await hostPluginPlan({ codex: false, claude: false }, options), []);
});

/** A client runner that records each call and answers from `answers`, keyed by the call's first words. */
function fakeRunner(answers = {}) {
  const calls = [];
  const runner = async (client, args, options) => {
    calls.push([client, ...args, options]);
    const answer = answers[[client, ...args.slice(0, 2)].join(" ")];
    return typeof answer === "function" ? answer() : answer || { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

test("apply adds the marketplace, then the plugin, with the CLI found and a 180 s limit; a host that has it is skipped", async (t) => {
  const f = await home(t);
  const bin = path.join(f.root, "bin");
  for (const client of ["codex", "claude"]) await executable(path.join(bin, client));
  await claudeRecord(f.home, { source: "directory", path: CHECKOUT });
  const options = { home: f.home, env: { PATH: bin }, platform: "linux", appClis: [] };
  const entries = await hostPluginPlan({ codex: true, claude: true }, { ...options, statuses: { codex: { installed: false }, claude: { installed: true, enabled: true } } });
  const { calls, runner } = fakeRunner();
  const results = await installHostPlugins(entries, { ...options, clientRunner: runner });
  assert.deepEqual(results, [{ agent: "codex", action: "installed" }, { agent: "claude", action: "already" }]);
  const limits = { binary: path.join(bin, "codex"), timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS };
  assert.equal(PLUGIN_INSTALL_TIMEOUT_MS, 180_000);
  assert.deepEqual(calls, [
    ["codex", "plugin", "marketplace", "add", CHECKOUT, limits],
    ["codex", "plugin", "add", "honcho-agent-bridge@honcho-agent-bridge", limits],
  ]);

  // Claude Code from Codex's record, the ref after #, on a computer where Claude Code has no marketplace yet.
  await fsp.rm(path.join(f.home, ".claude", "plugins"), { recursive: true });
  await codexRecord(f.home, ['source_type = "git"', 'source = "https://github.com/team-memory-system/honcho-agent-bridge.git"', 'ref = "main"']);
  const reverse = await hostPluginPlan({ codex: true, claude: true }, { ...options, statuses: { codex: { installed: true, enabled: true }, claude: { installed: false } } });
  const second = fakeRunner();
  assert.deepEqual(await installHostPlugins(reverse, { ...options, clientRunner: second.runner }), [
    { agent: "codex", action: "already" },
    { agent: "claude", action: "installed" },
  ]);
  const claudeLimits = { binary: path.join(bin, "claude"), timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS };
  assert.deepEqual(second.calls, [
    ["claude", "plugin", "marketplace", "add", "https://github.com/team-memory-system/honcho-agent-bridge.git#main", claudeLimits],
    ["claude", "plugin", "install", "honcho-agent-bridge@honcho-agent-bridge", "--scope", "user", claudeLimits],
  ]);
});

test("a marketplace the host already has is not added again, and 'already added' is not a failure", async (t) => {
  const f = await home(t);
  const bin = path.join(f.root, "bin");
  for (const client of ["codex", "claude"]) await executable(path.join(bin, client));
  const options = { home: f.home, env: { PATH: bin }, platform: "linux", appClis: [] };
  // Claude Code knows the marketplace (from another source) but has no plugin from it.
  await fsp.writeFile(path.join(f.home, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify({
    "honcho-agent-bridge": { source: { source: "github", repo: "someone/fork" } },
  }));
  const entries = await hostPluginPlan({ claude: true }, { ...options, statuses: { claude: { installed: false } } });
  const first = fakeRunner();
  assert.deepEqual(await installHostPlugins(entries, { ...options, clientRunner: first.runner }), [{ agent: "claude", action: "installed" }]);
  assert.deepEqual(first.calls.map((call) => call.slice(0, 3)), [["claude", "plugin", "install"]]);

  const codex = await hostPluginPlan({ codex: true }, { ...options, statuses: { codex: { installed: false } } });
  const second = fakeRunner({ "codex plugin marketplace": { code: 1, stdout: "", stderr: "Marketplace `honcho-agent-bridge` is already added from https://github.com/team-memory-system/honcho-agent-bridge.git#main." } });
  assert.deepEqual(await installHostPlugins(codex, { ...options, clientRunner: second.runner }), [{ agent: "codex", action: "installed" }]);
  assert.equal(second.calls.length, 2);
});

test("a Codex clone left with no table in config.toml goes, and the marketplace is added again", async (t) => {
  const f = await home(t);
  const bin = path.join(f.root, "bin");
  await executable(path.join(bin, "codex"));
  const options = { home: f.home, env: { PATH: bin }, platform: "linux", appClis: [] };
  const clone = path.join(f.home, ".codex", ".tmp", "marketplaces", "honcho-agent-bridge");
  await fsp.mkdir(path.join(clone, ".git"), { recursive: true });
  await fsp.mkdir(path.join(f.home, ".codex", ".tmp", "marketplaces", "other", ".git"), { recursive: true });
  const refused = { code: 1, stdout: "", stderr: "Error: marketplace 'honcho-agent-bridge' is already added from a different source; remove it before adding this source" };
  let adds = 0;
  const { calls, runner } = fakeRunner({ "codex plugin marketplace": () => (adds++ ? { code: 0, stdout: "Added marketplace", stderr: "" } : refused) });
  const entries = await hostPluginPlan({ codex: true }, { ...options, statuses: { codex: { installed: false } } });
  assert.deepEqual(await installHostPlugins(entries, { ...options, clientRunner: runner }), [{ agent: "codex", action: "installed" }]);
  assert.deepEqual(calls.map((call) => call.slice(1, 3)), [["plugin", "marketplace"], ["plugin", "marketplace"], ["plugin", "add"]]);
  await assert.rejects(fsp.access(clone));
  await fsp.access(path.join(f.home, ".codex", ".tmp", "marketplaces", "other", ".git"));

  // With a table of that name in config.toml the marketplace is someone's own: not added, its clone kept.
  await codexRecord(f.home, ['source_type = "git"', 'source = "https://github.com/someone/fork.git"']);
  await fsp.mkdir(path.join(clone, ".git"), { recursive: true });
  const own = fakeRunner();
  assert.deepEqual(await installHostPlugins(entries, { ...options, clientRunner: own.runner }), [{ agent: "codex", action: "installed" }]);
  assert.deepEqual(own.calls.map((call) => call.slice(1, 3)), [["plugin", "add"]]);
  await fsp.access(path.join(clone, ".git"));

  // A clone that is not a git clone is not touched, and the refusal is a failure.
  await fsp.writeFile(path.join(f.home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  await fsp.rm(path.join(clone, ".git"), { recursive: true });
  const notGit = fakeRunner({ "codex plugin marketplace": refused });
  const failed = await installHostPlugins(entries, { ...options, clientRunner: notGit.runner });
  assert.equal(failed[0].action, "failed");
  assert.match(failed[0].error, /different source/);
  assert.deepEqual(notGit.calls.map((call) => call.slice(1, 3)), [["plugin", "marketplace"]]);
  await fsp.access(clone);
});

test("a failed install or a missing CLI is reported, never thrown", async (t) => {
  const f = await home(t);
  const bin = path.join(f.root, "bin");
  await executable(path.join(bin, "codex"));
  const options = { home: f.home, env: { PATH: bin }, platform: "linux", appClis: [] };
  const entries = await hostPluginPlan({ codex: true, claude: true }, { ...options, statuses: { codex: { installed: false }, claude: { installed: false } } });
  const { calls, runner } = fakeRunner({
    "codex plugin marketplace": { code: 1, stdout: "", stderr: "Error: failed to clone https://github.com/team-memory-system/honcho-agent-bridge.git\nmore" },
  });
  assert.deepEqual(await installHostPlugins(entries, { ...options, clientRunner: runner }), [
    { agent: "codex", action: "failed", error: "Error: failed to clone https://github.com/team-memory-system/honcho-agent-bridge.git" },
    { agent: "claude", action: "missing-cli", error: "Claude Code (claude) was not found on this computer" },
  ]);
  assert.equal(calls.length, 1, "the plugin is not added after its marketplace failed");

  const timedOut = fakeRunner({ "codex plugin add": { code: -1, stdout: "", stderr: "", timedOut: true } });
  assert.deepEqual(await installHostPlugins(entries.slice(0, 1), { ...options, clientRunner: timedOut.runner }), [
    { agent: "codex", action: "failed", error: "did not finish within 180 s" },
  ]);
  const thrown = fakeRunner({ "codex plugin marketplace": () => { throw new Error("A client argument holds characters a name or an https address never has"); } });
  assert.deepEqual(await installHostPlugins(entries.slice(0, 1), { ...options, clientRunner: thrown.runner }), [
    { agent: "codex", action: "failed", error: "A client argument holds characters a name or an https address never has" },
  ]);
  const gone = fakeRunner({ "codex plugin marketplace": { missing: true } });
  assert.equal((await installHostPlugins(entries.slice(0, 1), { ...options, clientRunner: gone.runner }))[0].action, "missing-cli");
});

test("on Windows an npm .cmd shim runs through cmd.exe with the install arguments as plain text", () => {
  const env = { ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd";
  assert.deepEqual(clientCommand(shim, ["plugin", "marketplace", "add", "team-memory-system/honcho-agent-bridge", "--ref", "main"], "win32", env), {
    command: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", `""${shim}" plugin marketplace add team-memory-system/honcho-agent-bridge --ref main"`],
    extra: { windowsVerbatimArguments: true },
  });
  const claude = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
  assert.equal(
    clientCommand(claude, ["plugin", "marketplace", "add", "https://github.com/team-memory-system/honcho-agent-bridge.git#main"], "win32", env).args[3],
    `""${claude}" plugin marketplace add https://github.com/team-memory-system/honcho-agent-bridge.git#main"`,
  );
  const app = "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\0123abcd\\codex.exe";
  assert.deepEqual(clientCommand(app, ["plugin", "add", "honcho-agent-bridge@honcho-agent-bridge"], "win32", env), {
    command: app, args: ["plugin", "add", "honcho-agent-bridge@honcho-agent-bridge"], extra: {},
  });
  assert.throws(() => clientCommand(shim, ["plugin", "marketplace", "add", "x & calc"], "win32", env), /characters/);
  assert.throws(() => clientCommand("C:\\odd&dir\\codex.cmd", ["plugin", "list"], "win32", env), /cmd\.exe would read as commands/);
});

// ------------------------------------------------------------------ the CLI

async function cli(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(String(error.stdout || "{}"));
  }
}

/**
 * Stand-ins for claude and codex that log their arguments and edit the files the
 * real ones do; `failing` exits 1 on any call, as a clone that cannot reach GitHub.
 */
async function shims(root, { clients = ["codex", "claude"], failing = [] } = {}) {
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  const shim = (client) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(client)}, ...args]) + "\\n");
if (${JSON.stringify(failing.includes(client))}) {
  process.stderr.write("fatal: unable to access the marketplace repository: Could not resolve host\\n");
  process.exit(1);
}
const home = process.env.HOME;
if (${JSON.stringify(client)} === "codex") {
  const file = path.join(home, ".codex", "config.toml");
  const add = args[1] === "marketplace"
    ? "\\n[marketplaces.honcho-agent-bridge]\\nsource_type = \\"local\\"\\nsource = \\"" + args[3] + "\\"\\n"
    : "\\n[plugins.\\"" + args[2] + "\\"]\\nenabled = true\\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, add);
} else {
  const dir = path.join(home, ".claude", "plugins");
  fs.mkdirSync(dir, { recursive: true });
  const read = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  if (args[1] === "marketplace") {
    const known = read(path.join(dir, "known_marketplaces.json"));
    known["honcho-agent-bridge"] = { source: { source: "directory", path: args[3] } };
    fs.writeFileSync(path.join(dir, "known_marketplaces.json"), JSON.stringify(known));
  } else {
    const installed = read(path.join(dir, "installed_plugins.json"));
    installed.plugins = { ...(installed.plugins || {}), [args[2]]: [{ scope: "user" }] };
    fs.writeFileSync(path.join(dir, "installed_plugins.json"), JSON.stringify(installed));
    const settingsFile = path.join(home, ".claude", "settings.json");
    const settings = read(settingsFile);
    settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [args[2]]: true };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
  }
}
`;
  for (const client of clients) await executable(path.join(bin, client), shim(client));
  return { bin, calls: async () => (await fsp.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

function cliEnv(root, bin) {
  const dir = path.join(root, "home");
  return {
    PATH: bin,
    HOME: dir,
    USERPROFILE: dir,
    HONCHO_AGENT_BRIDGE_USER_HOME: dir,
    HONCHO_AGENT_BRIDGE_HOME: path.join(root, "app"),
    HONCHO_API_TOKEN: "",
    CLAUDE_PLUGIN_ROOT: "",
    CODEX_PLUGIN_ROOT: "",
    CODEX_CLI_PATH: "",
    CODEX_HOME: "",
    CLAUDE_CONFIG_DIR: "",
  };
}

const SETUP = ["--agents", "codex,claude", "--user-peer", "user_test", "--honcho-url", "http://127.0.0.1:9"];

test("setup plans and runs the Codex install from Claude Code's record, and Codex then has the plugin", { skip: process.platform === "win32" }, async (t) => {
  const f = await home(t);
  await claudeRecord(f.home, { source: "directory", path: CHECKOUT });
  await fsp.writeFile(path.join(f.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "honcho-agent-bridge@honcho-agent-bridge": true } }));
  const { bin, calls } = await shims(f.root);
  const env = cliEnv(f.root, bin);

  const plan = await cli(["setup", "plan", ...SETUP], env);
  assert.equal(plan.ready, true, JSON.stringify(plan));
  assert.deepEqual(plan.operations.filter((op) => op.type === "install-plugin"), [
    { type: "install-plugin", agent: "codex", source: CHECKOUT, marketplace: "honcho-agent-bridge" },
  ]);
  assert.equal(plan.warnings.some((line) => /plugin/.test(line)), false, plan.warnings.join("\n"));
  assert.deepEqual(await calls(), [], "planning runs no client");

  const applied = await cli(["setup", "apply", ...SETUP], env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.plugins, [{ agent: "codex", action: "installed" }, { agent: "claude", action: "already" }]);
  assert.deepEqual(await calls(), [
    ["codex", "plugin", "marketplace", "add", CHECKOUT],
    ["codex", "plugin", "add", "honcho-agent-bridge@honcho-agent-bridge"],
  ]);
  assert.deepEqual(applied.nextSteps.map((step) => step.action), ["approve-hook", "reload-plugins"]);
  assert.match(applied.nextSteps[0].message, /installed the Honcho Agent Bridge plugin in Codex\. Open a new Codex session/);
  const doctor = await cli(["doctor"], env);
  assert.equal(doctor.checks.find((check) => check.name === "codex-plugin").enabled, true);

  // Again: both have it, so nothing runs.
  const again = await cli(["setup", "apply", ...SETUP], env);
  assert.deepEqual(again.plugins, [{ agent: "codex", action: "already" }, { agent: "claude", action: "already" }]);
  assert.equal((await calls()).length, 2);
});

test("a failed Claude Code install leaves setup done, rolls nothing back, and hands over the commands", { skip: process.platform === "win32" }, async (t) => {
  const f = await home(t);
  await codexRecord(f.home, ['source_type = "git"', 'source = "https://github.com/team-memory-system/honcho-agent-bridge.git"', 'ref = "main"']);
  const { bin, calls } = await shims(f.root, { failing: ["claude"] });
  const env = cliEnv(f.root, bin);

  const applied = await cli(["setup", "apply", ...SETUP], env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.plugins, [
    { agent: "codex", action: "already" },
    { agent: "claude", action: "failed", error: "fatal: unable to access the marketplace repository: Could not resolve host" },
  ]);
  assert.deepEqual(await calls(), [["claude", "plugin", "marketplace", "add", "https://github.com/team-memory-system/honcho-agent-bridge.git#main"]]);
  const manual = applied.nextSteps.find((step) => step.action === "install-plugin");
  assert.deepEqual(manual.commands, [
    "claude plugin marketplace add https://github.com/team-memory-system/honcho-agent-bridge.git#main",
    "claude plugin install honcho-agent-bridge@honcho-agent-bridge --scope user",
  ]);
  assert.equal(manual.agent, "claude");
  assert.deepEqual(applied.nextSteps.map((step) => step.action), ["install-plugin", "approve-hook", "reload-plugins"]);
  // Setup itself stayed: its configuration, runtime and Codex hook are there.
  const config = JSON.parse(await fsp.readFile(path.join(f.root, "app", "config.json"), "utf8"));
  assert.deepEqual(config.agents, { codex: true, claude: true });
  await fsp.access(path.join(f.root, "app", "runtime", "collector", "cli.mjs"));
  assert.match(await fsp.readFile(path.join(f.home, ".codex", "hooks.json"), "utf8"), /--managed-by honcho-agent-bridge/);
});

test("setup warns with the commands when a host's CLI is missing, and about a plugin that is turned off", { skip: process.platform === "win32" }, async (t) => {
  const f = await home(t);
  // Codex has the plugin but turned off; there is no claude anywhere.
  await fsp.writeFile(path.join(f.home, ".codex", "config.toml"), '[plugins."honcho-agent-bridge@honcho-agent-bridge"]\nenabled = false\n');
  const { bin, calls } = await shims(f.root, { clients: ["codex"] });
  const env = cliEnv(f.root, bin);

  const plan = await cli(["setup", "plan", ...SETUP], env);
  assert.equal(plan.operations.some((op) => op.type === "install-plugin"), false);
  assert.deepEqual(plan.warnings.filter((line) => /plugin/.test(line)), [
    "codex collection is enabled, but the Honcho Agent Bridge plugin was not detected as enabled in codex",
    "claude collection is enabled, but the Honcho Agent Bridge plugin is not installed in claude and the claude command was not found; install it by running claude plugin marketplace add team-memory-system/honcho-agent-bridge, then claude plugin install honcho-agent-bridge@honcho-agent-bridge --scope user",
  ]);
  const applied = await cli(["setup", "apply", ...SETUP], env);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.plugins, [
    { agent: "codex", action: "already" },
    { agent: "claude", action: "missing-cli", error: "Claude Code (claude) was not found on this computer" },
  ]);
  assert.equal(applied.nextSteps[0].action, "install-plugin");
  assert.deepEqual(await calls(), []);
  assert.match(await fsp.readFile(path.join(f.home, ".codex", "config.toml"), "utf8"), /enabled = false/, "a turned-off plugin stays off");
});

test("the setup steps translate the missing-CLI warning and show the commands after apply", async () => {
  const collect = await fsp.readFile(path.join(ROOT, "ui", "lib", "collect.js"), "utf8");
  const warnings = collect.slice(collect.indexOf("const WARNINGS = ["), collect.indexOf("];", collect.indexOf("const WARNINGS = [")));
  const pattern = new RegExp(warnings.match(/\[\/(.*?command was not found.*?)\/,/)[1]);
  const match = pattern.exec("claude collection is enabled, but the Honcho Agent Bridge plugin is not installed in claude and the claude command was not found; install it by running claude plugin marketplace add team-memory-system/honcho-agent-bridge, then claude plugin install honcho-agent-bridge@honcho-agent-bridge --scope user");
  assert.deepEqual([match[1], match[2], match[3]], [
    "claude",
    "claude plugin marketplace add team-memory-system/honcho-agent-bridge",
    "claude plugin install honcho-agent-bridge@honcho-agent-bridge --scope user",
  ]);
  // After apply, an agent the plugin could not go into gets the commands as its 할 일.
  assert.match(collect, /step\.action === "install-plugin"/);
  assert.match(collect, /터미널에서 차례로 실행하세요/);
});
