// The prerequisite check runs nothing real here: every command goes through a fake
// `run`, and PATH and the file system through fake `which` and `fileExists`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkPrereqs, parseFeatures } from "../scripts/prereqs.mjs";
import { prereqsInvocation } from "../scripts/ui.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "cli.mjs");

const MAC_WARP = "/usr/local/bin/warp-cli";
const WIN_WARP = "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe";
const SECRET_IDS = {
  id: "11111111-2222-3333-4444-555555555555",
  device_id: "66666666-7777-8888-9999-000000000000",
  public_key: "c2VjcmV0LXB1YmxpYy1rZXktdmFsdWU=",
  account: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

function registration(type, organization = "acme-team") {
  return JSON.stringify({
    id: SECRET_IDS.id,
    device_id: SECRET_IDS.device_id,
    public_key: SECRET_IDS.public_key,
    managed: true,
    account: { type, id: SECRET_IDS.account, organization },
    alternate_networks: [],
  });
}

/**
 * `responses` maps "<command> <args>" to a result, or to a function of nothing.
 * Anything else is a missing program (ENOENT), the way execFile reports it.
 */
function fakeRun(responses, calls = []) {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const answer = responses[key];
    if (answer === undefined) return { code: -1, stdout: "", stderr: "", error: "ENOENT" };
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
}

function fakeWhich(found) {
  return (tool) => found[tool] || null;
}

function fakeFiles(present) {
  return (target) => present.includes(target);
}

const MAC_GIT = {
  "xcode-select -p": { stdout: "/Library/Developer/CommandLineTools\n" },
  "/usr/bin/git --version": { stdout: "git version 2.39.5 (Apple Git-154)\n" },
};

function mac({ responses = {}, which = {}, files = [], calls, ...rest } = {}) {
  return checkPrereqs({
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
    homeDir: "/Users/test",
    serverDir: "/Users/test/app/server",
    nodeVersion: "22.11.0",
    run: fakeRun({ ...MAC_GIT, ...responses }, calls),
    which: fakeWhich({ git: "/usr/bin/git", ...which }),
    fileExists: fakeFiles(files),
    ...rest,
  });
}

function windows({ responses = {}, which = {}, files = [], calls, ...rest } = {}) {
  return checkPrereqs({
    platform: "win32",
    arch: "x64",
    env: { Path: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    homeDir: "C:\\Users\\test",
    serverDir: "C:\\Users\\test\\app\\server",
    nodeVersion: "20.18.0",
    run: fakeRun({ "C:\\Program Files\\Git\\cmd\\git.exe --version": { stdout: "git version 2.47.0.windows.1\n" }, ...responses }, calls),
    which: fakeWhich({ git: "C:\\Program Files\\Git\\cmd\\git.exe", ...which }),
    fileExists: fakeFiles(files),
    ...rest,
  });
}

function item(result, key) {
  return result.items.find((entry) => entry.key === key);
}

function warpResponses(cli, { status = "Connected", type = "team", registered = true } = {}) {
  return {
    [`${cli} -j status`]: { stdout: JSON.stringify({ status, reason: status === "Connected" ? "NetworkHealthy" : "Manual" }) },
    [`${cli} -j registration show`]: registered
      ? { stdout: registration(type) }
      : { code: 1, stdout: "", stderr: "Error: Missing registration. Try running: \"warp-cli registration new\"\n" },
    [`${cli} --version`]: { stdout: "warp-cli 2026.4.1350.0\n" },
  };
}

function assertNoIdentifiers(result) {
  const text = JSON.stringify(result);
  for (const value of Object.values(SECRET_IDS)) assert.ok(!text.includes(value), `leaked ${value}`);
  assert.ok(!/device_id|public_key/.test(text));
}

test("features are the three names, each once", () => {
  assert.deepEqual(parseFeatures("server, sync,server"), { features: ["server", "sync"], invalid: [] });
  assert.deepEqual(parseFeatures(""), { features: [], invalid: [] });
  assert.deepEqual(parseFeatures("chat,docker").invalid, ["docker"]);
});

test("node and git are always reported, and nothing else without a feature", async () => {
  const result = await mac();
  assert.equal(result.ok, true);
  assert.equal(result.platform, "darwin");
  assert.equal(result.arch, "arm64");
  assert.deepEqual(result.items.map((entry) => entry.key), ["node", "git"]);
  assert.deepEqual(item(result, "node"), {
    key: "node",
    label: "Node.js",
    needed: "required",
    ok: true,
    version: "22.11.0",
    detail: item(result, "node").detail,
    install: { url: "https://nodejs.org/ko/download" },
  });
  const git = item(result, "git");
  assert.equal(git.ok, true);
  assert.equal(git.version, "2.39.5");
  assert.deepEqual(git.install, {
    url: "https://git-scm.com/download/mac",
    command: "xcode-select --install",
    note: git.install.note,
  });
});

test("an old Node is required and fails the check", async () => {
  const result = await mac({ nodeVersion: "16.20.2" });
  assert.equal(item(result, "node").ok, false);
  assert.equal(result.ok, false);
});

test("git missing fails the check on macOS and Windows", async () => {
  const noGit = await mac({ which: { git: null } });
  assert.equal(item(noGit, "git").ok, false);
  assert.equal(noGit.ok, false);
  assert.match(item(noGit, "git").detail, /Git/);

  // The macOS stub at /usr/bin/git is not run without the Command Line Tools: running
  // it would open Apple's install dialog.
  const calls = [];
  const stub = await mac({ responses: { "xcode-select -p": { code: 2, stderr: "xcode-select: error: unable to get active developer directory" } }, calls });
  assert.equal(item(stub, "git").ok, false);
  assert.equal(stub.ok, false);
  assert.match(item(stub, "git").detail, /Command Line Tools/);
  assert.ok(!calls.includes("/usr/bin/git --version"));

  const win = await windows({ which: { git: null } });
  const git = item(win, "git");
  assert.equal(git.ok, false);
  assert.equal(win.ok, false);
  assert.deepEqual({ url: git.install.url, command: git.install.command }, {
    url: "https://git-scm.com/download/win",
    command: "winget install --id Git.Git -e",
  });
});

test("Docker and Ollama are checked only with server, and the app installs them", async () => {
  for (const features of [["sync"], ["chat"], ["sync", "chat"]]) {
    const calls = [];
    const result = await mac({ features, calls, which: { docker: "/usr/local/bin/docker", ollama: "/usr/local/bin/ollama", "warp-cli": MAC_WARP }, responses: warpResponses(MAC_WARP) });
    assert.ok(!item(result, "docker") && !item(result, "ollama"), features.join(","));
    assert.ok(!calls.some((call) => /docker|ollama/.test(call)), features.join(","));
  }

  const missing = await mac({ features: ["server"] });
  assert.deepEqual(missing.items.map((entry) => entry.key), ["node", "git", "docker", "ollama"]);
  for (const key of ["docker", "ollama"]) {
    assert.equal(item(missing, key).needed, "app-installs");
    assert.equal(item(missing, key).ok, false);
    assert.match(item(missing, key).detail, /앱이 설치/);
  }
  assert.equal(missing.ok, true, "what the app installs does not block setup");

  const present = await mac({
    features: ["server"],
    which: { docker: "/usr/local/bin/docker", ollama: "/opt/homebrew/bin/ollama" },
    responses: {
      "/usr/local/bin/docker compose version --short": { stdout: "2.40.3\n" },
      "/usr/local/bin/docker info --format {{.ServerVersion}}": { stdout: "28.5.1\n" },
      "/opt/homebrew/bin/ollama --version": { stdout: "ollama version is 0.34.2\n" },
    },
  });
  assert.equal(item(present, "docker").ok, true);
  assert.equal(item(present, "docker").version, "2.40.3");
  assert.equal(item(present, "ollama").ok, true);
  assert.equal(item(present, "ollama").version, "0.34.2");

  // Installed but the engine is down: still not ok, and the app starts it.
  const stopped = await mac({
    features: ["server"],
    which: { docker: "/usr/local/bin/docker" },
    responses: {
      "/usr/local/bin/docker compose version --short": { stdout: "2.40.3\n" },
      "/usr/local/bin/docker info --format {{.ServerVersion}}": { code: 1, stderr: "Cannot connect to the Docker daemon" },
    },
  });
  assert.equal(item(stopped, "docker").ok, false);
  assert.match(item(stopped, "docker").detail, /시작/);

  // Docker Desktop's own CLI and the Windows Ollama install are found off PATH.
  const win = await windows({
    features: ["server"],
    files: [
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Users\\test\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
    ],
    responses: {
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe compose version --short": { stdout: "2.40.3\n" },
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe info --format {{.ServerVersion}}": { stdout: "28.5.1\n" },
      "C:\\Users\\test\\AppData\\Local\\Programs\\Ollama\\ollama.exe --version": { stdout: "ollama version is 0.34.2\n" },
    },
  });
  assert.equal(item(win, "docker").ok, true);
  assert.equal(item(win, "docker").needed, "app-installs");
  assert.equal(item(win, "ollama").ok, true);
});

test("WARP is required for sync to another computer, optional for chat, and absent otherwise", async () => {
  assert.equal(item(await mac({ features: ["sync"] }), "warp"), undefined);
  assert.equal(item(await mac({ features: ["server", "sync"] }), "warp"), undefined);
  assert.equal(item(await mac({ remote: true }), "warp"), undefined, "remote means nothing without sync");
  assert.equal(item(await mac({ features: ["sync"], remote: true }), "warp").needed, "required");
  assert.equal(item(await mac({ features: ["chat"] }), "warp").needed, "optional");
  assert.equal(item(await mac({ features: ["chat", "sync"], remote: true }), "warp").needed, "required");

  // Optional WARP missing does not fail the check; required WARP missing does.
  assert.equal((await mac({ features: ["chat"] })).ok, true);
  assert.equal((await mac({ features: ["sync"], remote: true })).ok, false);
});

for (const [platform, cli, run] of [
  ["macOS", MAC_WARP, mac],
  ["Windows", WIN_WARP, windows],
]) {
  test(`WARP on ${platform}: missing, not registered, team but disconnected, team and connected`, async () => {
    const options = { features: ["sync"], remote: true };
    const missing = await run({ ...options });
    const warpMissing = item(missing, "warp");
    assert.equal(warpMissing.ok, false);
    assert.match(warpMissing.detail, /설치되어 있지 않습니다/);
    assert.equal(warpMissing.install.url, "https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/warp/download-warp/");
    assert.match(warpMissing.install.note, /warp-cli registration new <팀 이름>/);
    assert.match(warpMissing.install.note, /warp-cli connect/);
    if (platform === "Windows") assert.equal(warpMissing.install.command, "winget install --id Cloudflare.Warp -e");

    // Found at its install location even off PATH.
    const unregistered = await run({ ...options, files: [cli], responses: warpResponses(cli, { registered: false, status: "Disconnected" }) });
    assert.equal(item(unregistered, "warp").ok, false);
    assert.match(item(unregistered, "warp").detail, /팀.*등록되어 있지 않습니다/);
    assert.equal(item(unregistered, "warp").version, "2026.4.1350.0");

    const consumer = await run({ ...options, files: [cli], responses: warpResponses(cli, { type: "free" }) });
    assert.equal(item(consumer, "warp").ok, false, "a personal WARP account is not the team");
    assert.match(item(consumer, "warp").detail, /등록되어 있지 않습니다/);

    const disconnected = await run({ ...options, files: [cli], responses: warpResponses(cli, { status: "Disconnected" }) });
    assert.equal(item(disconnected, "warp").ok, false);
    assert.equal(disconnected.ok, false);
    assert.match(item(disconnected, "warp").detail, /acme-team.*연결되어 있지 않습니다/);

    const connected = await run({ ...options, files: [cli], responses: warpResponses(cli) });
    assert.equal(item(connected, "warp").ok, true);
    assert.equal(connected.ok, true);
    assert.match(item(connected, "warp").detail, /acme-team에 연결되어 있습니다/);

    for (const result of [missing, unregistered, consumer, disconnected, connected]) assertNoIdentifiers(result);
  });
}

test("WARP on PATH is used first, and brew is offered on macOS only when brew exists", async () => {
  const calls = [];
  const onPath = await mac({ features: ["chat"], calls, which: { "warp-cli": "/opt/homebrew/bin/warp-cli" }, responses: warpResponses("/opt/homebrew/bin/warp-cli") });
  assert.equal(item(onPath, "warp").ok, true);
  assert.ok(calls.includes("/opt/homebrew/bin/warp-cli -j status"));
  assert.equal(item(onPath, "warp").install.command, undefined);

  const withBrew = await mac({ features: ["chat"], files: ["/opt/homebrew/bin/brew"] });
  assert.equal(item(withBrew, "warp").install.command, "brew install --cask cloudflare-warp");
});

test("a command that throws or hangs up is a failed check, never a throw", async () => {
  const result = await checkPrereqs({
    features: ["server", "sync", "chat"],
    remote: true,
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    homeDir: "/Users/test",
    serverDir: "/Users/test/app/server",
    run: async () => { throw new Error("spawn failed"); },
    which: () => "/usr/local/bin/tool",
    fileExists: () => false,
  });
  assert.equal(result.ok, false);
  for (const key of ["git", "docker", "warp"]) assert.equal(item(result, key).ok, false, key);
});

test("the CLI refuses unknown features and lists prereqs in its help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "help"]);
  assert.ok(JSON.parse(stdout).usage.includes("prereqs [--features server,sync,chat] [--remote]"));
  await assert.rejects(execFileAsync(process.execPath, [CLI, "prereqs", "--features", "server,docker"]), (error) => {
    const output = JSON.parse(String(error.stdout));
    assert.equal(output.ok, false);
    assert.match(output.error, /unknown feature: docker/);
    return true;
  });
});

test("the UI route takes only the three feature names", () => {
  const ok = prereqsInvocation(new URLSearchParams("features=server,sync&remote=1"));
  assert.deepEqual(ok, { args: ["prereqs", "--features=server,sync", "--remote"] });
  assert.deepEqual(prereqsInvocation(new URLSearchParams("")), { args: ["prereqs", "--features="] });
  assert.deepEqual(prereqsInvocation(new URLSearchParams("features=chat&remote=0")), { args: ["prereqs", "--features=chat"] });
  assert.match(prereqsInvocation(new URLSearchParams("features=server,--remote")).error, /unknown feature/);
  assert.match(prereqsInvocation(new URLSearchParams("features=sync;rm")).error, /unknown feature/);
  assert.match(prereqsInvocation(new URLSearchParams("features=sync&features=chat")).error, /once/);
  assert.match(prereqsInvocation(new URLSearchParams("features=sync&remote=yes")).error, /remote/);
});
