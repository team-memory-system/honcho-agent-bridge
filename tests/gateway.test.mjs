// The gateway is a separate program. These tests pin down what this repository does
// with it: where its source goes and when that source is replaced, how its CLI's
// answers are read, and that the one secret it prints goes nowhere but the caller
// that writes the private .env.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chooseChatModel,
  ensureGatewaySource,
  prepareGateway,
  gatewayConnectInfo,
  gatewayDirectory,
  gatewayEnvironment,
  gatewayInstall,
  gatewayOpen,
  gatewaySourceProbe,
  gatewayStatus,
  installedChatModel,
  modelList,
  PREFERRED_CHAT_MODELS,
} from "../scripts/gateway.mjs";

const REPO = "https://github.com/team-memory-system/subscription-gateway";
const ROUTER_KEY = "0123456789abcdef".repeat(4);

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

/** A git stand-in: clone writes a small tree with a .git directory in it. */
function fakeGit(calls, { failClone = false } = {}) {
  let clones = 0;
  return async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "--version") return { stdout: "git version 2.0\n", stderr: "" };
    if (args[0] === "clone") {
      if (failClone) {
        const error = new Error("clone failed");
        error.stderr = "fatal: unable to access the repository";
        throw error;
      }
      clones += 1;
      const target = args.at(-1);
      await fsp.mkdir(path.join(target, ".git"), { recursive: true });
      await fsp.mkdir(path.join(target, "gateway"), { recursive: true });
      await fsp.writeFile(path.join(target, "gateway", "cli.mjs"), `// clone ${clones}\n`);
      return { stdout: "", stderr: "" };
    }
    return { stdout: `${String(clones).repeat(40)}\n`, stderr: "" };
  };
}

async function gatewayFixture(t, pin = { repo: REPO, ref: "main" }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const pinDirectory = path.join(root, "app", "server");
  await fsp.mkdir(pinDirectory, { recursive: true });
  const writePin = (value) => fsp.writeFile(path.join(pinDirectory, "gateway-source.json"), JSON.stringify(value));
  await writePin(pin);
  return { root, pinDirectory, directory: gatewayDirectory(pinDirectory), writePin };
}

test("the gateway lives beside runtime/host, outside the server bundle that updates swap", () => {
  const server = path.join(os.tmpdir(), "HonchoAgentBridge", "server");
  assert.equal(gatewayDirectory(server), path.join(os.tmpdir(), "HonchoAgentBridge", "runtime", "subscription-gateway"));
});

// The old copy's CLI, answering `uninstall` the way the real one does.
function uninstallingCli(calls = []) {
  return async (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd, env: options?.env });
    return { code: 0, stdout: `${JSON.stringify({ ok: true, stopped: ["router"] })}\n` };
  };
}

test("the gateway source is fetched once, recorded, and replaced only when its pin changes", async (t) => {
  const { pinDirectory, directory, writePin } = await gatewayFixture(t);
  const calls = [];
  const runner = fakeGit(calls);
  const cliRunner = uninstallingCli();

  assert.equal((await gatewaySourceProbe({ pinDirectory, directory, runner })).state, "missing");
  const first = await ensureGatewaySource({ pinDirectory, directory, runner });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.fetched, true);
  assert.equal(first.commit, "1".repeat(40));
  const clone = calls.find((call) => call[1] === "clone");
  assert.equal(clone.at(-1), `${directory}.fetching`, "an interrupted fetch cannot look complete");
  assert.ok(clone.includes("--single-branch") && clone.includes("--depth"));
  assert.equal(await exists(path.join(directory, ".git")), false, "the clone's history is not kept");
  assert.equal(await exists(`${directory}.fetching`), false);

  calls.length = 0;
  const again = await ensureGatewaySource({ pinDirectory, directory, runner });
  assert.deepEqual(again, { ok: true, fetched: false, updated: false, state: "current", directory });
  assert.deepEqual(calls, [], "a current copy runs no git at all");

  // A changed pin replaces the copy and keeps the one the running gateway started from.
  await writePin({ repo: REPO, ref: "release-2" });
  assert.equal((await gatewaySourceProbe({ pinDirectory, directory, runner })).state, "stale");
  const updated = await ensureGatewaySource({ pinDirectory, directory, runner, cliRunner });
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.updated, true);
  assert.equal(updated.ref, "release-2");
  assert.equal(updated.previous, `${directory}.previous`);
  assert.equal(await fsp.readFile(path.join(directory, "gateway", "cli.mjs"), "utf8"), "// clone 2\n");
  assert.equal(await fsp.readFile(path.join(`${directory}.previous`, "gateway", "cli.mjs"), "utf8"), "// clone 1\n");
  assert.equal((await gatewaySourceProbe({ pinDirectory, directory, runner })).state, "current");

  // Pinning a commit checks that exact commit out of a full clone.
  calls.length = 0;
  const commit = "c".repeat(40);
  await writePin({ repo: REPO, ref: "release-2", commit });
  const pinned = await ensureGatewaySource({ pinDirectory, directory, runner, cliRunner });
  assert.equal(pinned.ok, true, pinned.error);
  const pinnedClone = calls.find((call) => call[1] === "clone");
  assert.equal(pinnedClone.includes("--depth"), false);
  assert.ok(calls.some((call) => call.includes("checkout") && call.includes(commit)));
});

test("a gateway directory this installer did not fetch is used as it is and never replaced", async (t) => {
  const { pinDirectory, directory } = await gatewayFixture(t);
  await fsp.mkdir(path.join(directory, "gateway"), { recursive: true });
  await fsp.writeFile(path.join(directory, "gateway", "cli.mjs"), "// somebody's own checkout\n");
  const calls = [];
  const probe = await gatewaySourceProbe({ pinDirectory, directory, runner: fakeGit(calls) });
  assert.equal(probe.state, "external");
  const result = await ensureGatewaySource({ pinDirectory, directory, runner: fakeGit(calls) });
  assert.equal(result.ok, true);
  assert.equal(result.fetched, false);
  assert.deepEqual(calls, []);
  assert.equal(await fsp.readFile(path.join(directory, "gateway", "cli.mjs"), "utf8"), "// somebody's own checkout\n");
});

test("a failed gateway update leaves the working copy and no staging behind", async (t) => {
  const { root, pinDirectory, directory, writePin } = await gatewayFixture(t);
  assert.equal((await ensureGatewaySource({ pinDirectory, directory, runner: fakeGit([]) })).ok, true);
  await writePin({ repo: REPO, ref: "release-2" });
  const uninstalls = [];
  const failed = await ensureGatewaySource({
    pinDirectory,
    directory,
    runner: fakeGit([], { failClone: true }),
    cliRunner: uninstallingCli(uninstalls),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /unable to access the repository/);
  assert.deepEqual(uninstalls, [], "a copy whose replacement never arrived keeps running");
  assert.equal(await fsp.readFile(path.join(directory, "gateway", "cli.mjs"), "utf8"), "// clone 1\n");
  const runtime = await fsp.readdir(path.dirname(directory));
  assert.deepEqual(runtime, ["subscription-gateway"], "no .fetching or .previous is left behind");

  // Without git there is nothing to fetch with, and the plan says so.
  await fsp.rm(path.join(root, "app", "runtime"), { recursive: true, force: true });
  const noGit = await gatewaySourceProbe({ pinDirectory, directory, runner: async () => { throw new Error("git not found"); } });
  assert.equal(noGit.state, "missing");
  assert.equal(noGit.fetchable, false);
  assert.match(noGit.reason, /git is not installed/);
});

test("replacing a copy runs the old copy's own uninstall first, then the swap, then the new copy's install", async (t) => {
  const { pinDirectory, directory, writePin } = await gatewayFixture(t);
  const git = fakeGit([]);
  assert.equal((await ensureGatewaySource({ pinDirectory, directory, runner: git })).ok, true);
  await writePin({ repo: REPO, ref: "release-2" });

  const env = { PATH: process.env.PATH, GATEWAY_HOME: path.join(pinDirectory, "gateway-home") };
  const nodePath = "/opt/stand-in/bin/node";
  const seen = [];
  const cliRunner = async (command, args, options) => {
    seen.push({
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      copyInPlace: await fsp.readFile(path.join(directory, "gateway", "cli.mjs"), "utf8"),
      newCopyStaged: await exists(path.join(`${directory}.fetching`, "gateway", "cli.mjs")),
      previousYet: await exists(`${directory}.previous`),
    });
    const answer = args[1] === "uninstall"
      ? { ok: true, stopped: ["router", "codex-1"] }
      : { ok: true, autostart: "launchd", uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" };
    return { code: 0, stdout: `${JSON.stringify(answer)}\n` };
  };

  const prepared = await prepareGateway({
    pinDirectory,
    directory,
    sourceFetcher: (options) => ensureGatewaySource({ ...options, runner: git }),
    runner: cliRunner,
    env,
    nodePath,
  });
  assert.equal(prepared.ok, true, prepared.error);
  assert.deepEqual(seen.map((call) => call.args[1]), ["uninstall", "install"]);
  const [uninstall, install] = seen;
  assert.deepEqual(uninstall.args, [path.join(directory, "gateway", "cli.mjs"), "uninstall"]);
  assert.equal(uninstall.copyInPlace, "// clone 1\n", "the old copy uninstalls itself, from where it is");
  assert.equal(uninstall.newCopyStaged, true, "only once the new copy is on disk");
  assert.equal(uninstall.previousYet, false, "and before the rename");
  assert.equal(install.copyInPlace, "// clone 2\n", "the new copy installs itself");
  for (const call of seen) {
    assert.equal(call.command, nodePath, "the same node for both");
    assert.equal(call.env, env, "the same environment for both");
    assert.equal(call.cwd, directory);
  }
  assert.deepEqual(prepared.source.uninstall, { ok: true, stopped: ["router", "codex-1"] });
  assert.equal(prepared.source.updated, true);
  assert.equal(await fsp.readFile(path.join(`${directory}.previous`, "gateway", "cli.mjs"), "utf8"), "// clone 1\n");
});

test("a current copy, a copy this installer did not fetch, and a copy without a CLI are never uninstalled", async (t) => {
  const calls = [];
  const cliRunner = uninstallingCli(calls);

  const current = await gatewayFixture(t);
  const git = fakeGit([]);
  assert.equal((await ensureGatewaySource({ pinDirectory: current.pinDirectory, directory: current.directory, runner: git, cliRunner })).fetched, true);
  const again = await ensureGatewaySource({ pinDirectory: current.pinDirectory, directory: current.directory, runner: git, cliRunner });
  assert.equal(again.state, "current");

  const external = await gatewayFixture(t);
  await fsp.mkdir(path.join(external.directory, "gateway"), { recursive: true });
  await fsp.writeFile(path.join(external.directory, "gateway", "cli.mjs"), "// somebody's own checkout\n");
  await external.writePin({ repo: REPO, ref: "release-2" });
  const untouched = await ensureGatewaySource({ pinDirectory: external.pinDirectory, directory: external.directory, runner: fakeGit([]), cliRunner });
  assert.equal(untouched.state, "external");
  assert.equal(await fsp.readFile(path.join(external.directory, "gateway", "cli.mjs"), "utf8"), "// somebody's own checkout\n");

  assert.deepEqual(calls, [], "neither was asked to uninstall");

  // A copy fetched before the gateway had a CLI has nothing to run; it is replaced as before.
  const old = await gatewayFixture(t);
  const oldGit = fakeGit([]);
  assert.equal((await ensureGatewaySource({ pinDirectory: old.pinDirectory, directory: old.directory, runner: oldGit })).ok, true);
  await fsp.rm(path.join(old.directory, "gateway"), { recursive: true, force: true });
  await old.writePin({ repo: REPO, ref: "release-2" });
  const replaced = await ensureGatewaySource({ pinDirectory: old.pinDirectory, directory: old.directory, runner: oldGit, cliRunner });
  assert.equal(replaced.updated, true, replaced.error);
  assert.equal("uninstall" in replaced, false);
  assert.deepEqual(calls, []);
});

test("a failed uninstall still lets the swap be tried, and a failed swap reports both", async (t) => {
  const renameFailure = (directory) => new Proxy(fsp, {
    get(target, property) {
      if (property !== "rename") return target[property];
      return async (from, to) => {
        if (path.resolve(from) === path.resolve(directory) && path.resolve(to) === path.resolve(`${directory}.previous`)) {
          throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
        }
        return fsp.rename(from, to);
      };
    },
  });
  const staleCopy = async () => {
    const fixture = await gatewayFixture(t);
    const git = fakeGit([]);
    assert.equal((await ensureGatewaySource({ ...fixture, runner: git })).ok, true);
    await fixture.writePin({ repo: REPO, ref: "release-2" });
    return { ...fixture, git };
  };

  // Uninstall fails, then the rename fails: both reasons, and the old copy stays.
  const failing = await staleCopy();
  const bothFailed = await ensureGatewaySource({
    pinDirectory: failing.pinDirectory,
    directory: failing.directory,
    runner: failing.git,
    cliRunner: async () => ({ code: 1, stdout: `${JSON.stringify({ ok: false, error: "launchctl bootout failed" })}\n` }),
    fileSystem: renameFailure(failing.directory),
  });
  assert.equal(bothFailed.ok, false);
  assert.match(bothFailed.error, /could not be put in place \(EBUSY\)/);
  assert.match(bothFailed.error, /before that, the old copy's uninstall failed: launchctl bootout failed/);
  assert.deepEqual(bothFailed.uninstall, { ok: false, error: "launchctl bootout failed" });
  assert.equal(await fsp.readFile(path.join(failing.directory, "gateway", "cli.mjs"), "utf8"), "// clone 1\n");
  assert.deepEqual(await fsp.readdir(path.dirname(failing.directory)), ["subscription-gateway"], "no staging or .previous left behind");

  // Uninstall fails, the swap works: the update goes ahead and says what happened.
  const partly = await staleCopy();
  const swapped = await ensureGatewaySource({
    pinDirectory: partly.pinDirectory,
    directory: partly.directory,
    runner: partly.git,
    cliRunner: async () => ({ code: 1, stdout: `${JSON.stringify({ ok: false, error: "launchctl bootout failed" })}\n` }),
  });
  assert.equal(swapped.ok, true, swapped.error);
  assert.deepEqual(swapped.uninstall, { ok: false, error: "launchctl bootout failed" });
  assert.equal(await fsp.readFile(path.join(partly.directory, "gateway", "cli.mjs"), "utf8"), "// clone 2\n");

  // Uninstall works, the swap fails: the old copy is back in place but no longer running.
  const stopped = await staleCopy();
  const down = await ensureGatewaySource({
    pinDirectory: stopped.pinDirectory,
    directory: stopped.directory,
    runner: stopped.git,
    cliRunner: uninstallingCli(),
    fileSystem: renameFailure(stopped.directory),
  });
  assert.equal(down.ok, false);
  assert.match(down.error, /uninstalled before the swap and is not running now/);
  assert.equal(await fsp.readFile(path.join(stopped.directory, "gateway", "cli.mjs"), "utf8"), "// clone 1\n");
});

async function installedGateway(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-gateway-cli-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "subscription-gateway");
  await fsp.mkdir(path.join(directory, "gateway"), { recursive: true });
  await fsp.writeFile(path.join(directory, "gateway", "cli.mjs"), "// stand-in; never executed\n");
  return directory;
}

function answering(document, code = 0) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return { code, stdout: `${JSON.stringify(document, null, 2)}\n` };
  };
  return { runner, calls };
}

test("connect-info's key reaches its caller and nothing else", async (t) => {
  const directory = await installedGateway(t);
  const { runner, calls } = answering({
    ok: true,
    ready: true,
    baseUrl: "http://127.0.0.1:11400/v1",
    apiKey: ROUTER_KEY,
    models: ["claude-sonnet-5-5", "gpt-6-luna"],
    reason: "",
  });
  const info = await gatewayConnectInfo({ directory, runner });
  assert.equal(info.ok, true);
  assert.equal(info.ready, true);
  assert.equal(info.baseUrl, "http://127.0.0.1:11400/v1");
  assert.deepEqual(info.models, ["claude-sonnet-5-5", "gpt-6-luna"]);
  assert.equal(info.apiKey, ROUTER_KEY, "the caller that writes the private .env can read it");
  assert.equal(JSON.stringify(info).includes(ROUTER_KEY), false);
  assert.equal(JSON.stringify({ ...info }).includes(ROUTER_KEY), false);
  assert.equal(Object.keys(info).includes("apiKey"), false);
  assert.deepEqual(calls[0].args.slice(1), ["connect-info"], "the key is asked for, never passed in");
  assert.equal(JSON.stringify(calls).includes(ROUTER_KEY), false);

  // A failure that echoes the key does not carry it any further.
  const leaky = answering({ ok: false, error: `router refused key ${ROUTER_KEY}` }, 1);
  const failed = await gatewayConnectInfo({ directory, runner: leaky.runner });
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes(ROUTER_KEY), false);

  // Unparseable output is never repeated, since it may be the key itself.
  const garbled = await gatewayConnectInfo({
    directory,
    runner: async () => ({ code: 0, stdout: `apiKey=${ROUTER_KEY}` }),
  });
  assert.equal(garbled.ok, false);
  assert.equal(JSON.stringify(garbled).includes(ROUTER_KEY), false);
});

test("connect-info refuses what it cannot store safely and passes on why it is not ready", async (t) => {
  const directory = await installedGateway(t);
  const notReady = await gatewayConnectInfo({
    directory,
    runner: answering({ ok: true, ready: false, models: [], reason: "no account is logged in" }).runner,
  });
  assert.deepEqual({ ...notReady }, { ok: true, ready: false, models: [], reason: "no account is logged in" });
  assert.equal(notReady.apiKey, undefined);

  const remote = await gatewayConnectInfo({
    directory,
    runner: answering({ ok: true, ready: true, baseUrl: "http://192.168.1.5:11400/v1", apiKey: ROUTER_KEY, models: ["gpt-6-luna"] }).runner,
  });
  assert.equal(remote.ok, false);
  assert.match(remote.error, /not on this machine/);

  for (const apiKey of [`${ROUTER_KEY}\nAUTH_USE_AUTH=false`, "short", "has space inside it", "${HOME}-looks-like-a-variable"]) {
    const unsafe = await gatewayConnectInfo({
      directory,
      runner: answering({ ok: true, ready: true, baseUrl: "http://127.0.0.1:11400/v1", apiKey, models: ["gpt-6-luna"] }).runner,
    });
    assert.equal(unsafe.ok, false, JSON.stringify(apiKey));
    assert.match(unsafe.error, /router key/);
  }
});

test("gateway CLI answers are read from its own JSON, and failures from its own error", async (t) => {
  const directory = await installedGateway(t);
  const installed = await gatewayInstall({
    directory,
    runner: answering({ ok: true, autostart: "windows-run", uiUrl: "http://127.0.0.1:11450/", routerUrl: "http://127.0.0.1:11400/v1" }).runner,
  });
  assert.deepEqual(installed, { ok: true, autostart: "windows-run", uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" });

  const failed = await gatewayInstall({
    directory,
    runner: answering({ ok: false, error: "npm install failed: Bearer secret-token https://user:pw@example.test/x?token=1" }, 1).runner,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /npm install failed/);
  assert.equal(/secret-token|user:pw|token=1/.test(failed.error), false);

  const silent = await gatewayInstall({ directory, runner: async () => ({ code: 3, stdout: "", stderr: "boom" }) });
  assert.match(silent.error, /gateway install failed \(exit 3\)/);

  // ok:true on stdout is not success when the process says otherwise.
  const contradictory = await gatewayOpen({ directory, runner: answering({ ok: true, url: "http://127.0.0.1:11450" }, 2).runner });
  assert.equal(contradictory.ok, false);

  const status = await gatewayStatus({
    directory,
    runner: answering({
      ok: true,
      ui: { url: "http://127.0.0.1:11450", ok: true },
      router: { url: "http://127.0.0.1:11400/v1", ok: false },
      autostart: { kind: "systemd", installed: true },
      accounts: [{ id: "claude-1", backend: "claude", loggedIn: true, serving: false, token: "must-not-pass" }],
      models: ["claude-haiku-4-5"],
    }).runner,
  });
  assert.equal(status.ok, false, "ok means the router answers");
  assert.equal(status.loggedIn, true);
  assert.deepEqual(status.accounts, [{ id: "claude-1", backend: "claude", loggedIn: true, serving: false }]);
  assert.equal(JSON.stringify(status).includes("must-not-pass"), false, "only the fields this repository knows are kept");

  const missing = await gatewayStatus({ directory: path.join(directory, "nowhere"), runner: async () => { throw new Error("must not run"); } });
  assert.equal(missing.installed, false);
  assert.match(missing.error, /not installed/);
});

test("the default runner reads a real CLI process: its JSON, its exit status, and nothing from stderr", async (t) => {
  const directory = await installedGateway(t);
  await fsp.writeFile(path.join(directory, "gateway", "cli.mjs"), `
const key = ${JSON.stringify(ROUTER_KEY)};
const subcommand = process.argv[2];
if (subcommand === "install") {
  console.log(JSON.stringify({ ok: true, autostart: "launchd", uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" }));
} else if (subcommand === "connect-info") {
  console.error("debug: loaded " + key);
  process.stdout.write(JSON.stringify({ ok: true, ready: true, baseUrl: "http://127.0.0.1:11400/v1", apiKey: key, models: ["gpt-6-luna"] }, null, 2));
} else {
  console.error("stderr mentions " + key);
  console.log(JSON.stringify({ ok: false, error: "unknown subcommand: " + subcommand }));
  process.exit(2);
}
`);
  const installed = await gatewayInstall({ directory });
  assert.deepEqual(installed, { ok: true, autostart: "launchd", uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" });

  const info = await gatewayConnectInfo({ directory });
  assert.equal(info.ready, true);
  assert.equal(info.apiKey, ROUTER_KEY);
  assert.equal(JSON.stringify(info).includes(ROUTER_KEY), false);

  const failed = await gatewayOpen({ directory });
  assert.deepEqual(failed, { ok: false, error: "unknown subcommand: open" });
});

test("the chat model is --model, else the installed one while offered, else the preference order", () => {
  assert.deepEqual(PREFERRED_CHAT_MODELS, ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.5", "claude-haiku-4-5", "claude-sonnet-5-5"]);
  const offered = ["claude-sonnet-5-5", "gpt-5.5", "gpt-6-luna"];
  const pick = (models, choice) => {
    const result = chooseChatModel(models, choice);
    return result.ok ? [result.model, result.source] : [result.ok, result.error];
  };

  // override: what was asked for, as long as the gateway offers it.
  assert.deepEqual(pick(offered, { requested: "claude-sonnet-5-5", installed: "gpt-5.5" }), ["claude-sonnet-5-5", "override"]);
  const refused = chooseChatModel(["gpt-6-luna"], { requested: "gpt-7" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /does not offer the model "gpt-7"\. It offers: gpt-6-luna/);

  // kept: the installed model wins over the preference order while it is offered.
  assert.deepEqual(pick(offered, { installed: "claude-sonnet-5-5" }), ["claude-sonnet-5-5", "kept"]);

  // default: nothing installed, or an installed model the gateway no longer offers.
  assert.deepEqual(pick(offered, {}), ["gpt-6-luna", "default"]);
  assert.deepEqual(pick(offered, { installed: "claude-opus-5-5" }), ["gpt-6-luna", "default"]);
  assert.deepEqual(pick(["claude-sonnet-5-5", "gpt-5.6-luna", "gpt-5.5"]), ["gpt-5.6-luna", "default"]);
  assert.deepEqual(pick(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]), ["claude-haiku-4-5", "default"]);
  assert.deepEqual(pick(["local-chat-1", "local-chat-2"]), ["local-chat-1", "default"]);

  // An id that could break a .env line is never offered, so it can never be chosen or kept.
  assert.deepEqual(modelList(["gpt-5.5\nAUTH_USE_AUTH=false", "gpt-5.5", "gpt-5.5", 7, "a b"]), ["gpt-5.5"]);
  assert.equal(chooseChatModel(["x\ny", "gpt-5.5"], { requested: "x\ny" }).ok, false);
  assert.deepEqual(pick(["x\ny", "gpt-5.5"], { installed: "x\ny" }), ["gpt-5.5", "default"]);
});

test("the fallback skips embedding models, and with nothing left there is a reason instead of a model", () => {
  const fallback = chooseChatModel(["qwen3-embedding-honcho-8192", "text-embedding-3-small", "local-chat-1"]);
  assert.deepEqual([fallback.model, fallback.source], ["local-chat-1", "default"]);
  // A preferred model still wins wherever it is listed.
  assert.equal(chooseChatModel(["qwen3-embedding:8b", "claude-haiku-4-5"]).model, "claude-haiku-4-5");

  const onlyEmbeddings = chooseChatModel(["qwen3-embedding:8b", "nomic-embed-text"]);
  assert.equal(onlyEmbeddings.ok, false);
  assert.equal(onlyEmbeddings.noChatModel, true);
  assert.equal(onlyEmbeddings.reason, "The gateway offers no chat model, only embedding models (qwen3-embedding:8b, nomic-embed-text)");

  const nothing = chooseChatModel([]);
  assert.deepEqual([nothing.ok, nothing.noChatModel, nothing.reason], [false, true, "The gateway offers no model yet"]);

  // Only the fallback skips them: asking for one by name still works.
  assert.deepEqual([chooseChatModel(["nomic-embed-text"], { requested: "nomic-embed-text" }).source], ["override"]);
});

test("the installed chat model is read from the first chat setting that names one", () => {
  assert.equal(installedChatModel({}), "");
  assert.equal(installedChatModel({ DERIVER_MODEL_CONFIG__MODEL: " gpt-5.5 ", SUMMARY_MODEL_CONFIG__MODEL: "gpt-6-luna" }), "gpt-5.5");
  assert.equal(installedChatModel({ EMBEDDING_MODEL_CONFIG__MODEL: "qwen3-embedding-honcho-8192", SUMMARY_MODEL_CONFIG__MODEL: "claude-haiku-4-5" }), "claude-haiku-4-5");
});

test("the gateway's values point every chat model at the router through the Docker host alias", () => {
  const values = gatewayEnvironment({ routerUrl: "http://127.0.0.1:11400/v1", apiKey: ROUTER_KEY, model: "gpt-6-luna" });
  assert.equal(values.LLM_VLLM_BASE_URL, "http://host.docker.internal:11400/v1");
  assert.equal(values.LLM_VLLM_API_KEY, ROUTER_KEY);
  const prefixes = [
    "DERIVER_MODEL_CONFIG",
    "SUMMARY_MODEL_CONFIG",
    "DREAM_DEDUCTION_MODEL_CONFIG",
    "DREAM_INDUCTION_MODEL_CONFIG",
    ...["minimal", "low", "medium", "high", "max"].map((level) => `DIALECTIC_LEVELS__${level}__MODEL_CONFIG`),
  ];
  for (const prefix of prefixes) {
    assert.equal(values[`${prefix}__MODEL`], "gpt-6-luna");
    assert.equal(values[`${prefix}__THINKING_EFFORT`], "low");
    assert.equal(values[`${prefix}__OVERRIDES__BASE_URL`], "http://host.docker.internal:11400/v1");
    assert.equal(values[`${prefix}__OVERRIDES__API_KEY_ENV`], "LLM_VLLM_API_KEY");
  }
  assert.equal(Object.keys(values).some((key) => key.startsWith("EMBEDDING") || key.includes("OPENAI_COMPATIBLE")), false, "embeddings stay on Ollama");
  assert.throws(() => gatewayEnvironment({ routerUrl: "http://127.0.0.1:11400/v1", apiKey: `${ROUTER_KEY}\nX=1`, model: "gpt-6-luna" }), /router key/);
  assert.throws(() => gatewayEnvironment({ routerUrl: "http://example.test/v1", apiKey: ROUTER_KEY, model: "gpt-6-luna" }), /on this machine/);
});
