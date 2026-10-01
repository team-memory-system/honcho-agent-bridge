// The prerequisite check runs nothing real here: every command goes through a fake
// `run`, and PATH and the file system through fake `which` and `fileExists`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkPrereqs, installWarp, openInstaller, parseFeatures, WARP_INSTALLERS } from "../scripts/prereqs.mjs";
import { prereqsInstallInvocation, prereqsInvocation } from "../scripts/ui.mjs";

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

  const missing = await mac({ features: ["server"], which: { "warp-cli": MAC_WARP }, responses: warpResponses(MAC_WARP) });
  assert.deepEqual(missing.items.map((entry) => entry.key), ["node", "git", "docker", "ollama", "warp"]);
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

test("WARP is required for every feature, whatever remote says, and absent with none", async () => {
  assert.equal(item(await mac(), "warp"), undefined);
  assert.equal(item(await mac({ remote: true }), "warp"), undefined, "remote asks for nothing on its own");
  for (const features of [["server"], ["sync"], ["chat"], ["server", "sync"], ["sync", "chat"], ["server", "sync", "chat"]]) {
    for (const remote of [false, true]) {
      const label = `${features.join(",")} remote=${remote}`;
      const missing = await mac({ features, remote });
      assert.equal(item(missing, "warp").needed, "required", label);
      assert.equal(item(missing, "warp").ok, false, label);
      assert.equal(missing.ok, false, `${label}: WARP missing fails the check`);
      assert.equal(missing.remote, remote, label);
      const connected = await mac({ features, remote, which: { "warp-cli": MAC_WARP }, responses: warpResponses(MAC_WARP) });
      assert.equal(item(connected, "warp").ok, true, label);
    }
  }
  const windowsChat = await windows({ features: ["chat"] });
  assert.equal(item(windowsChat, "warp").needed, "required");
  assert.equal(windowsChat.ok, false);
});

for (const [platform, cli, run] of [
  ["macOS", MAC_WARP, mac],
  ["Windows", WIN_WARP, windows],
]) {
  test(`WARP on ${platform}: missing, not registered, team but disconnected, team and connected`, async () => {
    const options = { features: ["chat"] };
    const missing = await run({ ...options });
    const warpMissing = item(missing, "warp");
    assert.equal(warpMissing.ok, false);
    assert.equal(warpMissing.needed, "required");
    assert.match(warpMissing.detail, /설치되어 있지 않습니다/);
    assert.equal(warpMissing.install.url, "https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/warp/download-warp/");
    assert.equal(warpMissing.install.auto, true, "the plugin can install it here");
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

test("on Linux WARP is required but not installed by the plugin", async () => {
  const result = await checkPrereqs({
    features: ["sync"],
    platform: "linux",
    env: { PATH: "/usr/bin", HOME: "/home/test" },
    homeDir: "/home/test",
    serverDir: "/home/test/app/server",
    nodeVersion: "22.11.0",
    run: fakeRun({ "/usr/bin/git --version": { stdout: "git version 2.43.0\n" } }),
    which: fakeWhich({ git: "/usr/bin/git" }),
    fileExists: () => false,
  });
  const warp = item(result, "warp");
  assert.equal(warp.needed, "required");
  assert.equal(warp.install.auto, undefined);
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
  const usage = JSON.parse(stdout).usage;
  assert.ok(usage.includes("prereqs [--features server,sync,chat] [--remote]"));
  assert.ok(usage.includes("prereqs install warp"));
  await assert.rejects(execFileAsync(process.execPath, [CLI, "prereqs", "--features", "server,docker"]), (error) => {
    const output = JSON.parse(String(error.stdout));
    assert.equal(output.ok, false);
    assert.match(output.error, /unknown feature: docker/);
    return true;
  });
  // Only WARP is installed from here; nothing else is even tried.
  for (const args of [["docker"], [], ["warp", "docker"]]) {
    await assert.rejects(execFileAsync(process.execPath, [CLI, "prereqs", "install", ...args]), (error) => {
      const output = JSON.parse(String(error.stdout));
      assert.equal(output.ok, false);
      assert.match(output.error, /takes one program: warp/);
      return true;
    }, args.join(" "));
  }
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

test("the UI install route takes warp and nothing else", () => {
  assert.deepEqual(prereqsInstallInvocation({ item: "warp" }), { args: ["prereqs", "install", "warp"] });
  for (const body of [{}, null, { item: "docker" }, { item: "warp --force" }, { item: ["warp"] }, { item: "WARP" }]) {
    assert.match(prereqsInstallInvocation(body).error, /warp/, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------- installing WARP

// What `pkgutil --check-signature` printed for the real pkg on 2026-10-01.
function pkgutilSigned(file, signer = "Developer ID Installer: Cloudflare Inc. (68WVV388M8)", status = "signed by a developer certificate issued by Apple for distribution") {
  return [
    `Package "${path.basename(file)}":`,
    `   Status: ${status}`,
    "   Notarization: trusted by the Apple notary service",
    "   Signed with a trusted timestamp on: 2026-08-27 22:44:40 +0000",
    "   Certificate Chain:",
    `    1. ${signer}`,
    "       Expires: 2029-12-14 16:14:05 +0000",
    "    2. Developer ID Certification Authority",
    "    3. Apple Root CA",
    "",
  ].join("\n");
}

const INSTALLER_BYTES = Buffer.alloc(4096, 7);

/** A fetch that serves the installer bytes for one URL and records what was asked for. */
function installerFetch(url, requested = []) {
  return async (asked) => {
    requested.push(String(asked));
    if (String(asked) !== url) return new Response("not found", { status: 404 });
    return new Response(INSTALLER_BYTES);
  };
}

async function downloads(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-warp-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function macInstall(t, directory, { signature, calls = [], opened = [], requested = [], ...rest } = {}) {
  const file = path.join(directory, "Cloudflare_WARP.pkg");
  return installWarp({
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
    homeDir: "/Users/test",
    downloadDir: directory,
    which: () => null,
    fileExists: () => false,
    fetchImpl: installerFetch(WARP_INSTALLERS.darwin.url, requested),
    run: fakeRun({ [`/usr/sbin/pkgutil --check-signature ${file}`]: signature ?? { stdout: pkgutilSigned(file) } }, calls),
    opener: async (target, options) => { opened.push({ target, platform: options.platform, present: await exists(target), checked: calls.length }); },
    ...rest,
  });
}

test("macOS: the official pkg lands in Downloads, is checked by pkgutil, and is opened for the user", async (t) => {
  const directory = await downloads(t);
  const file = path.join(directory, "Cloudflare_WARP.pkg");
  const calls = [];
  const opened = [];
  const requested = [];
  const result = await macInstall(t, directory, { calls, opened, requested });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.installed, false);
  assert.equal(result.changed, true);
  assert.equal(result.file, file);
  assert.equal(result.bytes, INSTALLER_BYTES.length);
  assert.match(result.verified, /Developer ID Installer: Cloudflare Inc\. \(68WVV388M8\)/);
  assert.equal(result.nextAction.kind, "warp-installer");
  for (const word of [/설치 창을 열었습니다/, /계속/, /설치/, /Mac 암호/, /에이전트에게 알려/]) assert.match(result.nextAction.message, word);
  assert.deepEqual(requested, ["https://downloads.cloudflareclient.com/v1/download/macos/ga"]);
  assert.deepEqual(calls, [`/usr/sbin/pkgutil --check-signature ${file}`]);
  assert.deepEqual(opened, [{ target: file, platform: "darwin", present: true, checked: 1 }], "opened once, after the signature check");
  assert.equal((await fsp.readFile(file)).length, INSTALLER_BYTES.length, "the pkg stays for the installer to read");
  assert.ok(!calls.some((call) => /sudo|installer -pkg/.test(call)), "nothing installs it behind the user's back");
});

test("macOS: a pkg not signed by Cloudflare is refused, deleted and never opened", async (t) => {
  const directory = await downloads(t);
  const file = path.join(directory, "Cloudflare_WARP.pkg");
  for (const [label, signature] of [
    ["another developer", { stdout: pkgutilSigned(file, "Developer ID Installer: Example Corp (ABCDE12345)") }],
    ["a look-alike name with another Team ID", { stdout: pkgutilSigned(file, "Developer ID Installer: Cloudflare Fans LLC (ZZZZZ99999)") }],
    ["a certificate Apple did not issue", { stdout: pkgutilSigned(file, undefined, "signed by untrusted certificate") }],
    ["no signature", { code: 1, stdout: `Package "Cloudflare_WARP.pkg":\n   Status: no signature\n` }],
  ]) {
    const opened = [];
    const result = await macInstall(t, directory, { signature, opened });
    assert.equal(result.ok, false, label);
    assert.equal(result.changed, false, label);
    assert.match(result.error, /Cloudflare가 서명한 설치 파일인지 확인되지 않아 지웠고, 설치하지 않았습니다/, label);
    assert.deepEqual(opened, [], label);
    assert.equal(await exists(file), false, `${label}: the download is removed`);
    assert.equal(await exists(`${file}.part`), false, label);
  }
});

test("WARP already installed is reported as it is, with nothing downloaded or opened", async (t) => {
  const directory = await downloads(t);
  for (const [platform, found] of [
    ["darwin", { which: (tool) => (tool === "warp-cli" ? "/usr/local/bin/warp-cli" : null) }],
    ["darwin", { fileExists: (target) => target === MAC_WARP }],
    ["win32", { fileExists: (target) => target === WIN_WARP, env: { ProgramFiles: "C:\\Program Files" } }],
  ]) {
    const requested = [];
    const opened = [];
    const result = await installWarp({
      platform,
      env: {},
      downloadDir: directory,
      which: () => null,
      fileExists: () => false,
      fetchImpl: installerFetch("", requested),
      run: async () => { throw new Error("nothing is run"); },
      opener: async (target) => { opened.push(target); },
      ...found,
    });
    assert.equal(result.ok, true, platform);
    assert.equal(result.installed, true, platform);
    assert.equal(result.changed, false, platform);
    assert.equal(result.nextAction, undefined, platform);
    assert.deepEqual(requested, [], platform);
    assert.deepEqual(opened, [], platform);
  }
  assert.deepEqual(await fsp.readdir(directory), []);
});

test("Linux: the plugin does not install WARP and points to Cloudflare's package repository", async (t) => {
  const directory = await downloads(t);
  const requested = [];
  const result = await installWarp({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    downloadDir: directory,
    which: () => null,
    fileExists: () => false,
    fetchImpl: installerFetch("", requested),
    run: async () => { throw new Error("nothing is run"); },
    opener: async () => { throw new Error("nothing is opened"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.url, "https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/warp/download-warp/");
  assert.ok(result.error.includes(result.url));
  assert.match(result.error, /패키지 저장소/);
  assert.deepEqual(requested, []);
});

test("Windows: the msi runs with msiexec only with Cloudflare's valid Authenticode signature", async (t) => {
  const directory = await downloads(t);
  const file = path.join(directory, "Cloudflare_WARP.msi");
  const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" };
  const signed = (status, subject) => async (command, args) => {
    assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.ok(args[3].includes(`Get-AuthenticodeSignature -LiteralPath '${file}'`));
    assert.ok(args[3].includes("SignerCertificate.Subject"));
    return { code: 0, stdout: `${status}\r\n${subject}\r\n`, stderr: "" };
  };
  const install = (run, opened) => installWarp({
    platform: "win32",
    arch: "x64",
    env,
    downloadDir: directory,
    which: () => null,
    fileExists: () => false,
    fetchImpl: installerFetch(WARP_INSTALLERS.win32.url),
    run,
    opener: async (target, options) => { opened.push({ target, platform: options.platform }); },
  });

  const opened = [];
  const result = await install(signed("Valid", 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco, S=California, C=US'), opened);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.changed, true);
  assert.equal(result.nextAction.kind, "warp-installer");
  assert.match(result.nextAction.message, /'예'/);
  assert.deepEqual(opened, [{ target: file, platform: "win32" }]);

  for (const [status, subject] of [["Valid", "CN=Example Corp, O=Example Corp, C=US"], ["HashMismatch", 'CN="Cloudflare, Inc.", O="Cloudflare, Inc."'], ["NotSigned", ""]]) {
    const refused = [];
    const bad = await install(signed(status, subject), refused);
    assert.equal(bad.ok, false, status);
    assert.match(bad.error, /지웠고/, status);
    assert.deepEqual(refused, [], status);
    assert.equal(await exists(file), false, status);
  }
});

test("a failed download or an installer that does not open is an error, not an install", async (t) => {
  const directory = await downloads(t);
  const opened = [];
  const failed = await macInstall(t, directory, { fetchImpl: installerFetch("https://elsewhere.example/warp.pkg"), opened });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /내려받지 못했습니다: .*HTTP 404/);
  assert.deepEqual(opened, []);
  assert.deepEqual(await fsp.readdir(directory), []);

  const file = path.join(directory, "Cloudflare_WARP.pkg");
  for (const opener of [async () => ({ ok: false, error: "open exited with 1" }), async () => { throw new Error("spawn EACCES"); }]) {
    const result = await macInstall(t, directory, { opener });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.match(result.error, /설치 창을 열지 못했습니다/);
    assert.ok(result.error.includes(file), "says where the checked installer is");
    assert.equal(await exists(file), true, "a checked installer is kept to open by hand");
  }
});

test("the installer opens with open on macOS and msiexec /i on Windows, never elevated by us", async () => {
  const spawned = [];
  const fakeSpawn = (event, value) => (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    spawned.push({ command, args, detached: options.detached, child });
    setImmediate(() => child.emit(event, value));
    return child;
  };
  assert.deepEqual(await openInstaller("/Users/test/Downloads/Cloudflare_WARP.pkg", { platform: "darwin", env: {}, spawnImpl: fakeSpawn("exit", 0) }), { ok: true });
  assert.deepEqual(spawned.at(-1).command, "/usr/bin/open");
  assert.deepEqual(spawned.at(-1).args, ["/Users/test/Downloads/Cloudflare_WARP.pkg"]);
  assert.equal((await openInstaller("/x.pkg", { platform: "darwin", env: {}, spawnImpl: fakeSpawn("exit", 1) })).ok, false);

  const msi = "C:\\Users\\test\\Downloads\\Cloudflare_WARP.msi";
  assert.deepEqual(await openInstaller(msi, { platform: "win32", env: { SystemRoot: "C:\\Windows" }, spawnImpl: fakeSpawn("spawn") }), { ok: true });
  const windows = spawned.at(-1);
  assert.equal(windows.command, "C:\\Windows\\System32\\msiexec.exe");
  assert.deepEqual(windows.args, ["/i", msi]);
  assert.equal(windows.detached, true);
  assert.equal(windows.child.unrefed, true);
  const missing = await openInstaller(msi, { platform: "win32", env: {}, spawnImpl: fakeSpawn("error", new Error("spawn ENOENT")) });
  assert.deepEqual(missing, { ok: false, error: "spawn ENOENT" });
  assert.ok(!spawned.some((entry) => /sudo|runas/i.test(`${entry.command} ${entry.args.join(" ")}`)));
});
