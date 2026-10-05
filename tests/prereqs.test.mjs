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
    const result = await mac({ features, calls, which: { docker: "/usr/local/bin/docker", ollama: "/usr/local/bin/ollama" } });
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

test("sync and chat need only Node and Git, and run nothing else", async () => {
  for (const features of [["sync"], ["chat"], ["sync", "chat"]]) {
    const label = features.join(",");
    const calls = [];
    const result = await mac({ features, calls });
    assert.deepEqual(result.items.map((entry) => entry.key), ["node", "git"], label);
    assert.equal(result.ok, true, label);
    assert.deepEqual(calls, ["xcode-select -p", "/usr/bin/git --version"], label);
    const win = await windows({ features });
    assert.deepEqual(win.items.map((entry) => entry.key), ["node", "git"], label);
    assert.equal(win.ok, true, label);
  }
});

test("a command that throws or hangs up is a failed check, never a throw", async () => {
  const result = await checkPrereqs({
    features: ["server", "sync", "chat"],
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    homeDir: "/Users/test",
    serverDir: "/Users/test/app/server",
    run: async () => { throw new Error("spawn failed"); },
    which: () => "/usr/local/bin/tool",
    fileExists: () => false,
  });
  assert.equal(result.ok, false);
  for (const key of ["git", "docker"]) assert.equal(item(result, key).ok, false, key);
});

test("the CLI refuses unknown features and lists prereqs in its help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "help"]);
  const usage = JSON.parse(stdout).usage;
  assert.ok(usage.includes("prereqs [--features server,sync,chat]"));
  assert.ok(!usage.some((line) => line.startsWith("prereqs install")), "nothing is installed from prereqs");
  await assert.rejects(execFileAsync(process.execPath, [CLI, "prereqs", "--features", "server,docker"]), (error) => {
    const output = JSON.parse(String(error.stdout));
    assert.equal(output.ok, false);
    assert.match(output.error, /unknown feature: docker/);
    return true;
  });
});

test("the UI route takes only the three feature names", () => {
  assert.deepEqual(prereqsInvocation(new URLSearchParams("features=server,sync")), { args: ["prereqs", "--features=server,sync"] });
  assert.deepEqual(prereqsInvocation(new URLSearchParams("")), { args: ["prereqs", "--features="] });
  assert.match(prereqsInvocation(new URLSearchParams("features=server,--force")).error, /unknown feature/);
  assert.match(prereqsInvocation(new URLSearchParams("features=sync;rm")).error, /unknown feature/);
  assert.match(prereqsInvocation(new URLSearchParams("features=sync&features=chat")).error, /once/);
});
