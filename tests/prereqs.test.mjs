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

import {
  checkPrereqs,
  installWarp,
  macInstallArgs,
  mdmOrganizations,
  openInstaller,
  parseFeatures,
  WARP_INSTALLERS,
  warpMdmPath,
  warpMdmXml,
  windowsInstallScript,
} from "../scripts/prereqs.mjs";
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
  assert.ok(usage.includes("prereqs install warp --team <name>"));
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
  // A team name that is not one is refused before anything is looked at or downloaded.
  for (const args of [["--team", "Acme Team"], ["--team=ACME"], ["--team"], ["--team", "-acme"], ["--team=acme;rm"], [`--team=${"a".repeat(64)}`]]) {
    await assert.rejects(execFileAsync(process.execPath, [CLI, "prereqs", "install", "warp", ...args]), (error) => {
      const output = JSON.parse(String(error.stdout));
      assert.equal(output.ok, false);
      assert.match(output.error, /^팀 이름은 영어 소문자, 숫자, 하이픈/);
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

test("the UI install route takes warp and a team name, and nothing else", () => {
  assert.deepEqual(prereqsInstallInvocation({ item: "warp" }), { args: ["prereqs", "install", "warp"] });
  assert.deepEqual(prereqsInstallInvocation({ item: "warp", team: "acme-team" }), { args: ["prereqs", "install", "warp", "--team=acme-team"] });
  assert.deepEqual(prereqsInstallInvocation({ item: "warp", team: " acme-team " }), { args: ["prereqs", "install", "warp", "--team=acme-team"] });
  for (const body of [{}, null, { item: "docker" }, { item: "warp --force" }, { item: ["warp"] }, { item: "WARP" }]) {
    assert.match(prereqsInstallInvocation(body).error, /warp/, JSON.stringify(body));
  }
  for (const team of ["Acme", "acme team", "--force", "acme;rm", ["acme"], 7, "a".repeat(64)]) {
    assert.match(prereqsInstallInvocation({ item: "warp", team }).error, /^팀 이름은/, JSON.stringify(team));
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

const MAC_CANCELLED = { code: 1, stderr: "0:251: execution error: User canceled. (-128)\n" };
const MAC_NO_GUI = { code: 1, stderr: "0:251: execution error: No user interaction allowed. (-1713)\n" };
const MAC_NOT_AUTHORIZED = { code: 1, stderr: "0:251: execution error: Not authorized to send Apple events to System Events. (-1743)\n" };
const TEAM = "acme-team";
const MDM_FOR_TEAM = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>organization</key><string>acme-team</string><key>onboarding</key><false/></dict></plist>
`;

/** The installer folders installWarp left under `root`. */
async function leftovers(root) {
  return (await fsp.readdir(root)).filter((name) => name.startsWith("honcho-warp-"));
}

/**
 * A macOS install with every outside effect replaced: pkgutil answers `signature`,
 * osascript answers `osascript` (a finished install by default), and warp-cli is
 * at /usr/local/bin once osascript has succeeded. The installer goes under `root`
 * and the managed config's destination is `mdmPath` (by default absent, under
 * `root`). `seen` records the pkg pkgutil was given, and what the temp folder held
 * when osascript ran.
 */
function macInstall(root, { signature, osascript = { code: 0 }, calls = [], opened = [], requested = [], seen = {}, team = TEAM, mdmPath = path.join(root, "no-cloudflare", "mdm.xml"), ...rest } = {}) {
  let installed = false;
  return installWarp({
    team,
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
    tmpDir: root,
    mdmPath,
    which: () => null,
    fileExists: (target) => installed && target === MAC_WARP,
    fetchImpl: installerFetch(WARP_INSTALLERS.darwin.url, requested),
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/sbin/pkgutil") {
        assert.equal(args[0], "--check-signature");
        seen.pkg = args[1];
        return { code: 0, stdout: "", stderr: "", ...(signature ?? { stdout: pkgutilSigned(args[1]) }) };
      }
      if (command === "/usr/bin/osascript") {
        seen.folder = (await fsp.readdir(path.dirname(seen.pkg))).sort();
        const config = path.join(path.dirname(seen.pkg), "mdm.xml");
        seen.config = (await exists(config)) ? await fsp.readFile(config, "utf8") : null;
        const answer = { code: 0, stdout: "", stderr: "", ...osascript };
        if (answer.code === 0) installed = true;
        return answer;
      }
      return { code: -1, stdout: "", stderr: "", error: "ENOENT" };
    },
    opener: async (target, options) => { opened.push({ target, platform: options.platform, present: await exists(target) }); },
    ...rest,
  });
}

test("the managed config names the team and turns the client's first screen off", () => {
  assert.equal(warpMdmXml(TEAM), MDM_FOR_TEAM);
  assert.ok(warpMdmXml("a&b<c>\"d'").includes("<string>a&amp;b&lt;c&gt;&quot;d&apos;</string>"), "escaped, though team names cannot hold these");
  assert.deepEqual(mdmOrganizations(warpMdmXml("a&b<c>")), ["a&b<c>"]);
  assert.deepEqual(mdmOrganizations("<array><dict><key>organization</key>\n  <string> one </string></dict><dict><key>organization</key><string>two</string></dict></array>"), ["one", "two"]);
  assert.equal(warpMdmPath("darwin"), "/Library/Application Support/Cloudflare/mdm.xml");
  assert.equal(warpMdmPath("win32", { ProgramData: "C:\\ProgramData" }), "C:\\ProgramData\\Cloudflare\\mdm.xml");
});

test("macOS: one password dialog puts the team's config in place and installs the checked pkg", async (t) => {
  const root = await downloads(t);
  const mdmPath = path.join(root, "Library", "Cloudflare", "mdm.xml");
  const calls = [];
  const opened = [];
  const requested = [];
  const seen = {};
  const result = await macInstall(root, { calls, opened, requested, seen, mdmPath });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.installed, true);
  assert.equal(result.changed, true);
  assert.equal(result.method, "silent");
  assert.equal(result.team, TEAM);
  assert.equal(result.managedConfig, "written");
  assert.equal(result.cli, MAC_WARP, "warp-cli is looked for again after the install");
  assert.equal(result.bytes, INSTALLER_BYTES.length);
  assert.match(result.verified, /Developer ID Installer: Cloudflare Inc\. \(68WVV388M8\)/);
  assert.equal(result.nextAction.kind, "warp-team-login");
  for (const word of [/설치했습니다/, /브라우저에 팀 로그인 창이 열리니/, /VPN 구성/, /'허용'/, /warp-cli registration new acme-team/]) assert.match(result.nextAction.message, word);
  assert.deepEqual(requested, ["https://downloads.cloudflareclient.com/v1/download/macos/ga"]);

  // Downloaded into a fresh folder under the temp directory, which root can read.
  const folder = path.dirname(seen.pkg);
  assert.equal(path.dirname(folder), root);
  assert.match(path.basename(folder), /^honcho-warp-/);
  assert.equal(path.basename(seen.pkg), "Cloudflare_WARP.pkg");
  assert.deepEqual(seen.folder, ["Cloudflare_WARP.pkg", "mdm.xml"]);
  assert.equal(seen.config, MDM_FOR_TEAM, "written as the user before the admin call");

  assert.deepEqual(calls.map((call) => call.command), ["/usr/sbin/pkgutil", "/usr/bin/osascript"], "signature first, then the one admin call");
  const args = calls[1].args;
  assert.deepEqual(args, macInstallArgs(seen.pkg, { mdm: { source: path.join(folder, "mdm.xml"), destination: mdmPath } }));
  assert.deepEqual(args.slice(6), [path.join(folder, "mdm.xml"), path.dirname(mdmPath), mdmPath, seen.pkg], "config, its folder, its destination and the pkg, each its own argument");
  assert.equal(
    args[3],
    'do shell script "/bin/mkdir -p " & quoted form of (item 2 of argv) & " && /bin/cp " & quoted form of (item 1 of argv) & " " & quoted form of (item 3 of argv) & " && /bin/chmod 644 " & quoted form of (item 3 of argv) & " && " & "/usr/sbin/installer -pkg " & quoted form of (item 4 of argv) & " -target /" with prompt "팀 메모리가 Cloudflare WARP를 설치하려고 합니다." with administrator privileges',
  );
  assert.deepEqual(opened, [], "no wizard when the password dialog did the job");
  assert.deepEqual(await leftovers(root), [], "a finished install removes its folder");
  assert.ok(!calls.some((call) => /sudo/.test(call.command)), "macOS asks for the password, not this program");
});

test("macOS: by default the installer goes under the temp directory, never Downloads", async () => {
  const pkgs = [];
  const result = await installWarp({
    team: TEAM,
    platform: "darwin",
    env: { PATH: "/usr/bin", HOME: "/Users/test" },
    mdmPath: path.join(os.tmpdir(), "honcho-agent-bridge-no-such-dir", "mdm.xml"),
    which: () => null,
    fileExists: () => false,
    fetchImpl: installerFetch(WARP_INSTALLERS.darwin.url),
    run: async (command, args) => { pkgs.push(args[1]); return { code: 1, stdout: "Status: no signature\n", stderr: "" }; },
    opener: async () => { throw new Error("nothing is opened"); },
  });
  assert.equal(result.ok, false);
  assert.equal(path.dirname(path.dirname(pkgs[0])), path.resolve(os.tmpdir()));
  assert.ok(!/Downloads|Desktop|Documents/.test(pkgs[0]));
  assert.equal(await exists(path.dirname(pkgs[0])), false, "a refused download leaves no folder");
});

test("macOS: every path reaches osascript as its own argument, never inside the script", async (t) => {
  const root = path.join(await downloads(t), `O'Brien "WARP" $(touch pwned) dir`);
  await fsp.mkdir(root);
  const mdmPath = path.join(root, `Conf 'zz'`, "mdm.xml");
  const calls = [];
  const seen = {};
  const result = await macInstall(root, { calls, seen, mdmPath });
  assert.equal(result.ok, true, result.error);
  const args = calls.find((call) => call.command === "/usr/bin/osascript").args;
  assert.deepEqual(args.slice(0, 2), ["-e", "on run argv"]);
  assert.deepEqual(args.slice(4, 6), ["-e", "end run"]);
  assert.deepEqual(args.slice(6), [path.join(path.dirname(seen.pkg), "mdm.xml"), path.dirname(mdmPath), mdmPath, seen.pkg]);
  for (const piece of ["O'Brien", "'zz'", root]) assert.ok(!args[3].includes(piece), piece);
});

test("macOS: the admin script hands awkward paths to the shell as one word each", { skip: process.platform !== "darwin" }, async (t) => {
  // The real osascript and shell: mkdir, cp and chmod run for real into a test
  // folder, the installer is swapped for echo, and no password is asked.
  const root = await downloads(t);
  const weird = `O'Brien "WARP" $(touch pwned) dir`;
  const source = path.join(root, weird, "mdm.xml");
  await fsp.mkdir(path.dirname(source));
  await fsp.writeFile(source, MDM_FOR_TEAM);
  const destination = path.join(root, `Cloud 'flare' ${weird}`, "mdm.xml");
  const pkg = path.join(root, weird, "Cloudflare_WARP.pkg");
  const args = macInstallArgs(pkg, { mdm: { source, destination } });
  args[3] = args[3]
    .replace('"/usr/sbin/installer -pkg "', '"/bin/echo "')
    .replace(/ with prompt ".*" with administrator privileges$/, "");
  assert.ok(!args[3].includes("administrator"), "this check never asks for a password");
  const { stdout } = await execFileAsync("/usr/bin/osascript", args, { cwd: root });
  assert.equal(stdout.replace(/\n$/, ""), `${pkg} -target /`);
  assert.equal(await fsp.readFile(destination, "utf8"), MDM_FOR_TEAM);
  assert.equal((await fsp.stat(destination)).mode & 0o777, 0o644);
  assert.equal(await exists(path.join(root, "pwned")), false, "nothing in the paths ran");
});

test("macOS: a config already naming the team is kept, and only the pkg is installed", async (t) => {
  const root = await downloads(t);
  const mdmPath = path.join(root, "Cloudflare", "mdm.xml");
  await fsp.mkdir(path.dirname(mdmPath));
  const existing = "<plist><dict>\n  <key>organization</key>\n  <string>acme-team</string>\n  <key>service_mode</key><string>warp</string>\n</dict></plist>\n";
  await fsp.writeFile(mdmPath, existing);
  const calls = [];
  const seen = {};
  const result = await macInstall(root, { calls, seen, mdmPath });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.managedConfig, "kept");
  assert.equal(result.nextAction.kind, "warp-team-login");
  assert.deepEqual(calls[1].args, macInstallArgs(seen.pkg), "no copy: argv is the pkg alone");
  assert.deepEqual(seen.folder, ["Cloudflare_WARP.pkg"], "no config written to copy");
  assert.equal(await fsp.readFile(mdmPath, "utf8"), existing);
});

test("macOS: a config for another team, or for none, stops the install before anything is downloaded", async (t) => {
  const root = await downloads(t);
  const mdmPath = path.join(root, "Cloudflare", "mdm.xml");
  await fsp.mkdir(path.dirname(mdmPath));
  for (const [label, existing, pattern] of [
    ["another team", "<dict><key>organization</key><string>other-team</string><key>auth_client_secret</key><string>s3cr3t-value</string></dict>", /다른 팀\(other-team\)/],
    ["one of several", "<array><dict><key>organization</key><string>acme-team</string></dict><dict><key>organization</key><string>other-team</string></dict></array>", /다른 팀\(other-team\)/],
    ["no team", "<dict><key>service_mode</key><string>warp</string></dict>", /팀 이름이 없는 WARP 관리 설정/],
  ]) {
    await fsp.writeFile(mdmPath, existing);
    const calls = [];
    const requested = [];
    const result = await macInstall(root, { calls, requested, mdmPath });
    assert.equal(result.ok, false, label);
    assert.equal(result.changed, false, label);
    assert.match(result.error, pattern, label);
    assert.match(result.error, /설치하지 않았습니다/, label);
    assert.ok(!result.error.includes("s3cr3t") && !result.error.includes("auth_client"), `${label}: nothing but the team name is shown`);
    assert.deepEqual(requested, [], `${label}: nothing downloaded`);
    assert.deepEqual(calls, [], `${label}: nothing run`);
    assert.equal(await fsp.readFile(mdmPath, "utf8"), existing, `${label}: left as it was`);
  }
  assert.deepEqual(await leftovers(root), []);
});

test("macOS: cancelling the password dialog installs nothing, keeps the pkg and says how to try again", async (t) => {
  const root = await downloads(t);
  const opened = [];
  const result = await macInstall(root, { osascript: MAC_CANCELLED, opened });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.installed, false);
  assert.equal(result.changed, false);
  assert.equal(result.team, TEAM);
  assert.match(result.error, /^설치를 취소했습니다\. 다시 하려면 /);
  assert.deepEqual(opened, [], "a no is not answered with another window");
  assert.equal(await exists(result.file), true, "the checked pkg is kept");
  assert.equal(path.dirname(path.dirname(result.file)), root);
});

test("macOS: with no password dialog to show, the same pkg opens in macOS's Installer, and the team comes back", async (t) => {
  const root = await downloads(t);
  for (const [label, osascript, code] of [["no GUI session", MAC_NO_GUI, /-1713/], ["Apple events refused", MAC_NOT_AUTHORIZED, /-1743/]]) {
    const opened = [];
    const seen = {};
    const result = await macInstall(root, { osascript, opened, seen });
    assert.equal(result.ok, true, label);
    assert.equal(result.installed, false, label);
    assert.equal(result.changed, true, label);
    assert.equal(result.method, "wizard", label);
    assert.equal(result.team, TEAM, `${label}: for warp-cli registration new afterwards`);
    assert.equal(result.file, seen.pkg, `${label}: the very file that was checked`);
    assert.match(result.silentError, code, label);
    assert.equal(result.nextAction.kind, "warp-installer", label);
    for (const word of [/설치 창을 열었습니다/, /계속/, /Mac 암호/, /'1\.1\.1\.1'이 아니라 'Cloudflare One'/, /acme-team/, /에이전트에게 알려/]) assert.match(result.nextAction.message, word, label);
    assert.deepEqual(opened, [{ target: seen.pkg, platform: "darwin", present: true }], label);
  }
});

test("macOS: a pkg not signed by Cloudflare is refused, deleted and never installed or opened", async (t) => {
  const root = await downloads(t);
  for (const [label, signature] of [
    ["another developer", { stdout: pkgutilSigned("Cloudflare_WARP.pkg", "Developer ID Installer: Example Corp (ABCDE12345)") }],
    ["a look-alike name with another Team ID", { stdout: pkgutilSigned("Cloudflare_WARP.pkg", "Developer ID Installer: Cloudflare Fans LLC (ZZZZZ99999)") }],
    ["a certificate Apple did not issue", { stdout: pkgutilSigned("Cloudflare_WARP.pkg", undefined, "signed by untrusted certificate") }],
    ["no signature", { code: 1, stdout: `Package "Cloudflare_WARP.pkg":\n   Status: no signature\n` }],
  ]) {
    const calls = [];
    const opened = [];
    const result = await macInstall(root, { signature, calls, opened });
    assert.equal(result.ok, false, label);
    assert.equal(result.changed, false, label);
    assert.match(result.error, /Cloudflare가 서명한 설치 파일인지 확인되지 않아 지웠고, 설치하지 않았습니다/, label);
    assert.deepEqual(calls.map((call) => call.command), ["/usr/sbin/pkgutil"], label);
    assert.deepEqual(opened, [], label);
    assert.deepEqual(await leftovers(root), [], `${label}: the download and its folder are removed`);
  }
});

test("the team name is checked first; without one, only an installed WARP is answered", async (t) => {
  const root = await downloads(t);
  const notInstalled = { platform: "darwin", env: {}, tmpDir: root, which: () => null, fileExists: () => false };
  const installed = { ...notInstalled, fileExists: (target) => target === MAC_WARP };
  const never = {
    fetchImpl: async () => { throw new Error("nothing is downloaded"); },
    run: async () => { throw new Error("nothing is run"); },
    readText: async () => { throw new Error("nothing is read"); },
  };
  for (const team of ["Acme", "acme team", "-acme", "a".repeat(64), "acme;rm"]) {
    for (const where of [notInstalled, installed]) {
      const result = await installWarp({ ...where, ...never, team });
      assert.equal(result.ok, false, team);
      assert.match(result.error, /^팀 이름은 영어 소문자, 숫자, 하이픈/, team);
    }
  }
  const missing = await installWarp({ ...notInstalled, ...never });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /팀 이름이 필요합니다/);
  const already = await installWarp({ ...installed, ...never });
  assert.deepEqual({ ok: already.ok, installed: already.installed, changed: already.changed }, { ok: true, installed: true, changed: false });
  assert.deepEqual(await leftovers(root), []);
});

test("WARP already installed is reported as it is, with nothing downloaded or opened", async (t) => {
  const root = await downloads(t);
  for (const [platform, found] of [
    ["darwin", { which: (tool) => (tool === "warp-cli" ? "/usr/local/bin/warp-cli" : null) }],
    ["darwin", { fileExists: (target) => target === MAC_WARP }],
    ["win32", { fileExists: (target) => target === WIN_WARP, env: { ProgramFiles: "C:\\Program Files" } }],
  ]) {
    const requested = [];
    const opened = [];
    const result = await installWarp({
      team: TEAM,
      platform,
      env: {},
      tmpDir: root,
      which: () => null,
      fileExists: () => false,
      fetchImpl: installerFetch("", requested),
      run: async () => { throw new Error("nothing is run"); },
      readText: async () => { throw new Error("nothing is read"); },
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
  assert.deepEqual(await fsp.readdir(root), []);
});

test("Linux: the plugin does not install WARP and points to Cloudflare's package repository", async (t) => {
  const root = await downloads(t);
  const requested = [];
  const result = await installWarp({
    team: TEAM,
    platform: "linux",
    env: { PATH: "/usr/bin" },
    tmpDir: root,
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
  assert.deepEqual(await fsp.readdir(root), []);
});

const WIN_ENV = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData" };
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CLOUDFLARE_SUBJECT = 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco, S=California, C=US';

/**
 * A Windows install with every outside effect replaced: the signature check
 * answers `status`/`subject`, the elevated msiexec answers `install`, and
 * warp-cli is in Program Files once msiexec has exited 0 or 3010. `seen.msi` is
 * the file the signature check was given.
 */
function windowsInstall(root, { status = "Valid", subject = CLOUDFLARE_SUBJECT, install = { code: 0 }, scripts = [], opened = [], seen = {}, mdmPath = path.join(root, "no-programdata", "mdm.xml") } = {}) {
  let installed = false;
  return installWarp({
    team: TEAM,
    platform: "win32",
    arch: "x64",
    env: WIN_ENV,
    tmpDir: root,
    mdmPath,
    which: () => null,
    fileExists: (target) => installed && target === WIN_WARP,
    fetchImpl: installerFetch(WARP_INSTALLERS.win32.url),
    run: async (command, args) => {
      assert.equal(command, POWERSHELL);
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      scripts.push(args[3]);
      if (args[3].includes("Get-AuthenticodeSignature")) {
        seen.msi = /-LiteralPath '((?:[^']|'')*)'/.exec(args[3])[1].replace(/''/g, "'");
        return { code: 0, stdout: `${status}\r\n${subject}\r\n`, stderr: "" };
      }
      if (args[3].includes("System.Diagnostics.ProcessStartInfo")) {
        const answer = { code: 0, stdout: "", stderr: "", ...install };
        if (answer.code === 0 || answer.code === 3010) installed = true;
        return answer;
      }
      return { code: 1, stdout: "", stderr: "unexpected script" };
    },
    opener: async (target, options) => { opened.push({ target, platform: options.platform }); },
  });
}

test("Windows: a Cloudflare-signed msi installs quietly behind UAC with the team's properties", async (t) => {
  const root = path.join(await downloads(t), "O'Brien dir");
  await fsp.mkdir(root);
  const scripts = [];
  const opened = [];
  const seen = {};
  const result = await windowsInstall(root, { scripts, opened, seen });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.installed, true);
  assert.equal(result.changed, true);
  assert.equal(result.method, "silent");
  assert.equal(result.team, TEAM);
  assert.equal(result.managedConfig, "written");
  assert.equal(result.cli, WIN_WARP);
  assert.equal(result.restartRequired, undefined);
  assert.equal(result.nextAction.kind, "warp-team-login");
  assert.match(result.nextAction.message, /설치했습니다.*브라우저에 팀 로그인 창이 열리니/);
  assert.match(result.nextAction.message, /warp-cli registration new acme-team/);
  assert.doesNotMatch(result.nextAction.message, /VPN/);
  assert.deepEqual(opened, []);
  assert.equal(path.dirname(path.dirname(seen.msi)), root, "downloaded under the temp directory");
  assert.deepEqual(await leftovers(root), [], "a finished install removes its folder");

  assert.equal(scripts.length, 2, "the signature check, then the install");
  const install = scripts[1];
  assert.equal(install, windowsInstallScript(seen.msi, WIN_ENV, { team: TEAM }));
  assert.ok(install.includes("$i.FileName = 'C:\\Windows\\System32\\msiexec.exe'"));
  assert.ok(
    install.includes(`$i.Arguments = '/i "${seen.msi.replace(/'/g, "''")}" ORGANIZATION="acme-team" ONBOARDING="false" /qn /norestart'`),
    "Cloudflare's msi properties, PowerShell quoting outside, msiexec quoting inside",
  );
  assert.ok(install.includes("$i.Verb = 'runas'"), "Windows asks through UAC");
  assert.ok(install.includes("exit $p.ExitCode"));
});

test("Windows: a config naming the team is kept (no properties), another team's stops the install", async (t) => {
  const root = await downloads(t);
  const mdmPath = path.join(root, "ProgramData", "Cloudflare", "mdm.xml");
  await fsp.mkdir(path.dirname(mdmPath), { recursive: true });

  await fsp.writeFile(mdmPath, MDM_FOR_TEAM);
  const scripts = [];
  const kept = await windowsInstall(root, { scripts, mdmPath });
  assert.equal(kept.ok, true, kept.error);
  assert.equal(kept.managedConfig, "kept");
  assert.ok(!scripts[1].includes("ORGANIZATION"), "the msi does not rewrite a config that is already right");

  await fsp.writeFile(mdmPath, "<dict><key>organization</key><string>other-team</string></dict>");
  const refusedScripts = [];
  const refused = await windowsInstall(root, { scripts: refusedScripts, mdmPath });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /다른 팀\(other-team\)/);
  assert.deepEqual(refusedScripts, []);
  assert.deepEqual(await leftovers(root), []);
});

test("Windows: a declined UAC prompt is a cancel, 3010 is installed with a restart, other codes are errors", async (t) => {
  const root = await downloads(t);
  for (const stdout of ["start-failed 1223 The operation was canceled by the user.\r\n", "start-failed 1223 작업을 사용자가 취소했습니다.\r\n"]) {
    const opened = [];
    const cancelled = await windowsInstall(root, { install: { code: 1, stdout }, opened });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true, "known by its code, in any display language");
    assert.equal(cancelled.installed, false);
    assert.match(cancelled.error, /^설치를 취소했습니다\. 다시 하려면 .*'예'/);
    assert.deepEqual(opened, []);
    assert.equal(await exists(cancelled.file), true, "the checked msi is kept");
  }

  const restart = await windowsInstall(root, { install: { code: 3010 } });
  assert.equal(restart.ok, true);
  assert.equal(restart.installed, true);
  assert.equal(restart.restartRequired, true);
  assert.equal(restart.nextAction.kind, "warp-team-login");
  assert.match(restart.nextAction.message, /Windows를 다시 시작/);

  const opened = [];
  const failed = await windowsInstall(root, { install: { code: 1603, error: "Command failed: powershell.exe ... start-failed ..." }, opened });
  assert.equal(failed.ok, false);
  assert.equal(failed.cancelled, undefined);
  assert.match(failed.error, /종료 코드 1603/);
  assert.deepEqual(opened, [], "a failed install is not retried in a wizard");
  assert.equal(await exists(failed.file), true);
});

test("Windows: only when elevation cannot be started does msiexec's own wizard open", async (t) => {
  const root = await downloads(t);
  for (const [label, install] of [
    ["the runas start failed", { code: 1, stdout: "start-failed 1155 No application is associated with the specified file for this operation.\r\n" }],
    ["PowerShell would not start", { code: -1, error: "ENOENT" }],
  ]) {
    const opened = [];
    const seen = {};
    const result = await windowsInstall(root, { install, opened, seen });
    assert.equal(result.ok, true, label);
    assert.equal(result.installed, false, label);
    assert.equal(result.method, "wizard", label);
    assert.equal(result.team, TEAM, label);
    assert.equal(result.nextAction.kind, "warp-installer", label);
    assert.match(result.nextAction.message, /'Cloudflare One'.*acme-team/, label);
    assert.deepEqual(opened, [{ target: seen.msi, platform: "win32" }], label);
  }
});

test("Windows: an msi without Cloudflare's valid signature is refused, deleted and never run", async (t) => {
  const root = await downloads(t);
  for (const [status, subject] of [["Valid", "CN=Example Corp, O=Example Corp, C=US"], ["HashMismatch", CLOUDFLARE_SUBJECT], ["NotSigned", ""]]) {
    const scripts = [];
    const opened = [];
    const bad = await windowsInstall(root, { status, subject, scripts, opened });
    assert.equal(bad.ok, false, status);
    assert.match(bad.error, /지웠고/, status);
    assert.equal(scripts.length, 1, `${status}: only the signature check ran`);
    assert.deepEqual(opened, [], status);
    assert.deepEqual(await leftovers(root), [], status);
  }
});

test("a failed download or a wizard that does not open is an error, not an install", async (t) => {
  const root = await downloads(t);
  const opened = [];
  const failed = await macInstall(root, { fetchImpl: installerFetch("https://elsewhere.example/warp.pkg"), opened });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /내려받지 못했습니다: .*HTTP 404/);
  assert.deepEqual(opened, []);
  assert.deepEqual(await leftovers(root), []);

  for (const opener of [async () => ({ ok: false, error: "open exited with 1" }), async () => { throw new Error("spawn EACCES"); }]) {
    const result = await macInstall(root, { osascript: MAC_NO_GUI, opener });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.match(result.error, /설치 창을 열지 못했습니다/);
    assert.ok(result.error.includes(result.file), "says where the checked installer is");
    assert.equal(await exists(result.file), true, "a checked installer is kept to open by hand");
  }
});

test("the fallback wizard opens with open on macOS and msiexec /i on Windows", async () => {
  const spawned = [];
  const fakeSpawn = (event, value) => (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    spawned.push({ command, args, detached: options.detached, child });
    setImmediate(() => child.emit(event, value));
    return child;
  };
  assert.deepEqual(await openInstaller("/var/folders/xy/T/honcho-warp-1/Cloudflare_WARP.pkg", { platform: "darwin", env: {}, spawnImpl: fakeSpawn("exit", 0) }), { ok: true });
  assert.deepEqual(spawned.at(-1).command, "/usr/bin/open");
  assert.deepEqual(spawned.at(-1).args, ["/var/folders/xy/T/honcho-warp-1/Cloudflare_WARP.pkg"]);
  assert.equal((await openInstaller("/x.pkg", { platform: "darwin", env: {}, spawnImpl: fakeSpawn("exit", 1) })).ok, false);

  const msi = "C:\\Users\\test\\AppData\\Local\\Temp\\honcho-warp-1\\Cloudflare_WARP.msi";
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
