import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hostPrepare, hostStart, resolveHostPaths } from "../scripts/host-manager.mjs";
import {
  checksumFor,
  DOCKER_LICENSE_WARNING,
  downloadFile,
  installDockerDesktop,
  installOllama,
  locateOllama,
  prepareRuntime,
  resolveDockerCli,
  windowsDockerInstallCommand,
} from "../scripts/runtime-installer.mjs";
import { compose, dockerProbe, serverPlan, serverPrepare } from "../scripts/server-manager.mjs";

// Nothing here downloads, mounts, copies into /Applications, elevates or starts
// Docker or Ollama: every one of those goes through a stand-in.

const OLLAMA_BASE = "https://github.com/ollama/ollama/releases/latest/download/";
const DOCKER_DMG = "https://desktop.docker.com/mac/main/arm64/Docker.dmg";
const DOCKER_EXE = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
const SPCTL_ACCEPTED = "/Volumes/Docker/Docker.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Docker Inc (9BNSXJN65R)\n";

async function tempRoot(t, name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `honcho-agent-bridge-${name}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** A fetch that serves fixed bodies by URL and records what was asked for. */
function fakeFetch(bodies, requested = []) {
  return async (url) => {
    requested.push(String(url));
    const body = bodies[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (typeof body === "function") return body();
    return new Response(body);
  };
}

function base(command) {
  return path.win32.basename(String(command));
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

// ---------------------------------------------------------------- plan

async function personalBundle(root) {
  const source = path.join(root, "source");
  await fsp.mkdir(path.join(source, "host"), { recursive: true });
  await fsp.writeFile(path.join(source, "compose.yaml"), "name: test\n");
  await fsp.writeFile(path.join(source, "host", "supervisor.mjs"), "// supervisor\n");
  await fsp.copyFile(new URL("../server/host-profile.personal.json", import.meta.url), path.join(source, "host-profile.personal.json"));
  await fsp.writeFile(path.join(source, "env.personal.example"), "POSTGRES_PASSWORD=\nEMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-4b-honcho-8192\n");
  return source;
}

function useServerDir(t, directory) {
  const previous = process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR;
  process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR;
    else process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR = previous;
  });
}

test("a personal plan on a computer with neither Docker nor Ollama installs both first, with Docker's terms, and has no issue", async (t) => {
  const root = await tempRoot(t, "runtime-plan");
  const source = await personalBundle(root);
  const installed = path.join(root, "app", "server");
  useServerDir(t, installed);
  const inspectors = {
    profile: "personal",
    env: { HOME: path.join(root, "home") },
    dockerInspector: async () => ({ installed: false, running: false, error: "docker was not found" }),
    dockerAppFinder: async () => "",
    ollamaLocator: () => null,
    bundleInspector: async () => ({ ok: true, directory: source, missing: [] }),
    honchoSourceInspector: async () => ({ present: true, fetchable: false }),
    gatewaySourceInspector: async () => ({ state: "current", present: true, fetchable: false }),
    portChooser: async () => ({ api: 8001, dashboard: 4173 }),
  };

  const mac = await serverPlan({ ...inspectors, platform: "darwin", arch: "arm64" });
  assert.equal(mac.ready, true, mac.issues.join(", "));
  assert.deepEqual(mac.issues, []);
  assert.deepEqual(mac.operations.slice(0, 2).map((item) => item.type), ["install-docker-desktop", "install-ollama"]);
  assert.deepEqual(
    { url: mac.operations[0].url, destination: mac.operations[0].destination },
    { url: DOCKER_DMG, destination: "/Applications/Docker.app" },
  );
  assert.deepEqual(
    { url: mac.operations[1].url, destination: mac.operations[1].destination },
    { url: `${OLLAMA_BASE}ollama-darwin.tgz`, destination: path.join(root, "app", "runtime", "ollama") },
  );
  assert.ok(mac.warnings.includes(DOCKER_LICENSE_WARNING));
  assert.match(DOCKER_LICENSE_WARNING, /fewer than 250 employees and less than \$10 million in annual revenue/);
  assert.equal(mac.operations.some((item) => item.type === "start-docker-desktop"), false);

  const intel = await serverPlan({ ...inspectors, platform: "darwin", arch: "x64" });
  assert.equal(intel.operations[0].url, "https://desktop.docker.com/mac/main/amd64/Docker.dmg");
  assert.equal(intel.operations[1].url, `${OLLAMA_BASE}ollama-darwin.tgz`, "one universal tgz");

  const windows = await serverPlan({ ...inspectors, platform: "win32", arch: "x64", env: { USERPROFILE: path.join(root, "home"), ProgramFiles: "C:\\Program Files" } });
  assert.equal(windows.ready, true, windows.issues.join(", "));
  assert.equal(windows.operations[0].url, DOCKER_EXE);
  assert.equal(windows.operations[0].destination, "C:\\Program Files\\Docker\\Docker");
  assert.match(windows.operations[0].note, /UAC/);
  assert.equal(windows.operations[1].url, `${OLLAMA_BASE}ollama-windows-amd64.zip`);
  const arm = await serverPlan({ ...inspectors, platform: "win32", arch: "arm64", env: { USERPROFILE: path.join(root, "home") } });
  assert.equal(arm.operations[0].url, "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe");
  assert.equal(arm.operations[1].url, `${OLLAMA_BASE}ollama-windows-arm64.zip`);

  // Found ones are not installed again; the portable profile still just needs Docker.
  const found = await serverPlan({
    ...inspectors,
    platform: "darwin",
    arch: "arm64",
    dockerInspector: async () => ({ installed: true, running: true }),
    ollamaLocator: () => ({ path: "/Applications/Ollama.app/Contents/Resources/ollama", source: "app" }),
  });
  assert.equal(found.operations.some((item) => /^install-(?:docker-desktop|ollama)$/.test(item.type)), false);
  assert.equal(found.warnings.includes(DOCKER_LICENSE_WARNING), false);
  await fsp.writeFile(path.join(source, ".env.example"), "HONCHO_API_PORT=8001\n");
  const portable = await serverPlan({ ...inspectors, profile: "portable", platform: "darwin", arch: "arm64" });
  assert.match(portable.issues.join(" "), /Docker CLI is not installed/);
});

test("the Ollama finder prefers PATH, then the Ollama apps, then the app's own copy", () => {
  const own = "/app/runtime/ollama/ollama";
  const on = (...present) => (target) => present.includes(target);
  assert.deepEqual(
    locateOllama({ platform: "darwin", env: {}, homeDir: "/Users/t", ollamaDir: "/app/runtime/ollama", which: () => "/opt/homebrew/bin/ollama", fileExists: on(own) }),
    { path: "/opt/homebrew/bin/ollama", source: "path", owned: false },
  );
  assert.deepEqual(
    locateOllama({ platform: "darwin", env: {}, homeDir: "/Users/t", ollamaDir: "/app/runtime/ollama", which: () => null, fileExists: on(own, "/Applications/Ollama.app/Contents/Resources/ollama") }),
    { path: "/Applications/Ollama.app/Contents/Resources/ollama", source: "app", owned: false },
  );
  assert.deepEqual(
    locateOllama({ platform: "darwin", env: {}, homeDir: "/Users/t", ollamaDir: "/app/runtime/ollama", which: () => null, fileExists: on(own) }),
    { path: own, source: "runtime", owned: true },
  );
  const windowsApp = "C:\\Users\\t\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
  assert.equal(
    locateOllama({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" }, homeDir: "C:\\Users\\t", ollamaDir: "/app/runtime/ollama", which: () => null, fileExists: on(windowsApp) }).path,
    windowsApp,
  );
  assert.equal(locateOllama({ platform: "darwin", env: {}, homeDir: "/Users/t", ollamaDir: "/app/runtime/ollama", which: () => null, fileExists: on() }), null);
});

// ---------------------------------------------------------------- downloads

test("a failed download leaves no .part file behind and names the URL", async (t) => {
  const root = await tempRoot(t, "runtime-part");
  const target = path.join(root, "downloads", "Docker.dmg");
  const broken = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4096).fill(7));
      controller.error(new Error("connection reset"));
    },
  }));
  await assert.rejects(
    downloadFile({ url: DOCKER_DMG, target, fetchImpl: fakeFetch({ [DOCKER_DMG]: broken }) }),
    (error) => error.message.includes(DOCKER_DMG) && /connection reset/.test(error.message),
  );
  assert.equal(await exists(`${target}.part`), false);
  assert.equal(await exists(target), false);

  await assert.rejects(downloadFile({ url: DOCKER_DMG, target, fetchImpl: fakeFetch({}) }), /Docker\.dmg could not be downloaded: HTTP 404/);
  assert.equal(await exists(`${target}.part`), false);

  // A body that stops sending is given up on, and cleaned up the same way.
  const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
  await assert.rejects(
    downloadFile({ url: DOCKER_DMG, target, fetchImpl: fakeFetch({ [DOCKER_DMG]: stalled }), idleTimeoutMs: 50 }),
    /no data arrived/,
  );
  assert.equal(await exists(`${target}.part`), false);

  // Through prepare, the same failure is an issue that names the URL.
  const prepared = await prepareRuntime({
    operations: [{ type: "install-docker-desktop" }],
    platform: "darwin",
    arch: "arm64",
    runtimeDir: path.join(root, "runtime"),
    fetchImpl: fakeFetch({ [DOCKER_DMG]: broken }),
    run: async () => { throw new Error("nothing may run after a failed download"); },
    launcher: () => { throw new Error("must not launch"); },
    dockerInspector: async () => ({ installed: false, running: false }),
  });
  assert.equal(prepared.ok, false);
  assert.match(prepared.issues[0], new RegExp(DOCKER_DMG.replace(/[.]/g, "\\.")));
  assert.deepEqual(await fsp.readdir(path.join(root, "runtime", "downloads")), []);
});

test("the checksum list is read the way Ollama publishes it", () => {
  const listing = `${"a".repeat(64)}  ./ollama-darwin.tgz\n${"B".repeat(64)}  ./ollama-windows-arm64.zip\n`;
  assert.equal(checksumFor(listing, "ollama-darwin.tgz"), "a".repeat(64));
  assert.equal(checksumFor(listing, "ollama-windows-arm64.zip"), "b".repeat(64));
  assert.equal(checksumFor(listing, "ollama-windows-amd64.zip"), "");
});

// ---------------------------------------------------------------- Ollama

/** A run that plays tar (writing an Ollama layout into -C) and the new binary. */
function ollamaRun(calls, { binary = "ollama", versionOk = true } = {}) {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (/tar(?:\.exe)?$/.test(base(command))) {
      const into = args[args.indexOf("-C") + 1];
      await fsp.writeFile(path.join(into, binary), "#!/bin/sh\n");
      await fsp.writeFile(path.join(into, "libggml-metal.dylib"), "lib");
      await fsp.mkdir(path.join(into, "mlx_metal_v3"), { recursive: true });
      await fsp.writeFile(path.join(into, "mlx_metal_v3", "mlx.metallib"), "lib");
      return { code: 0, stdout: "" };
    }
    if (args[0] === "--version") return versionOk ? { code: 0, stdout: "Warning: could not connect to a running Ollama instance\nWarning: client version is 0.35.0\n" } : { code: 1, stderr: "bad CPU type" };
    return { code: 0, stdout: "" };
  };
}

test("Ollama's zip is checked against sha256sum.txt and unpacked whole, and a mismatch deletes it", async (t) => {
  const root = await tempRoot(t, "runtime-ollama-zip");
  const archive = Buffer.from("pretend this is ollama-windows-arm64.zip");
  const url = `${OLLAMA_BASE}ollama-windows-arm64.zip`;
  const listing = (hash) => `${"0".repeat(64)}  ./ollama-darwin.tgz\n${hash}  ./ollama-windows-arm64.zip\n`;
  const ollamaDir = path.join(root, "runtime", "ollama");
  const calls = [];
  const installed = await installOllama({
    platform: "win32",
    arch: "arm64",
    env: { SystemRoot: "C:\\Windows" },
    ollamaDir,
    fetchImpl: fakeFetch({ [`${OLLAMA_BASE}sha256sum.txt`]: listing(sha256(archive)), [url]: archive }),
    run: ollamaRun(calls, { binary: "ollama.exe" }),
  });
  assert.equal(installed.ok, true, installed.issues?.join(", "));
  assert.equal(installed.executable, path.join(ollamaDir, "ollama.exe"));
  assert.equal(calls[0].command, "C:\\Windows\\System32\\tar.exe", "Windows' own bsdtar unpacks the zip");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-xf", path.join(root, "runtime", "downloads", "ollama-windows-arm64.zip")]);
  assert.deepEqual(calls[1].args, ["--version"]);
  assert.equal(installed.action.bytes, archive.length);
  assert.equal(installed.action.sha256, sha256(archive));
  assert.match(installed.action.verified, /SHA-256 matches ollama-windows-arm64\.zip in .*sha256sum\.txt/);
  assert.equal(installed.action.version, "0.35.0");
  await fsp.access(path.join(ollamaDir, "libggml-metal.dylib"));
  await fsp.access(path.join(ollamaDir, "mlx_metal_v3", "mlx.metallib"));
  assert.equal(await exists(path.join(root, "runtime", "downloads", "ollama-windows-arm64.zip")), false, "the archive is not kept");

  const mismatch = [];
  const rejected = await installOllama({
    platform: "win32",
    arch: "arm64",
    env: {},
    ollamaDir: path.join(root, "other", "ollama"),
    fetchImpl: fakeFetch({ [`${OLLAMA_BASE}sha256sum.txt`]: listing("f".repeat(64)), [url]: archive }),
    run: ollamaRun(mismatch),
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.issues[0], /does not match the SHA-256 in .*sha256sum\.txt; it was deleted/);
  assert.deepEqual(mismatch, [], "nothing from a mismatched download is unpacked or run");
  assert.deepEqual(await fsp.readdir(path.join(root, "other", "downloads")), [], "neither the file nor its .part is left");
  assert.equal(await exists(path.join(root, "other", "ollama")), false);

  const unlisted = await installOllama({
    platform: "win32",
    arch: "arm64",
    ollamaDir: path.join(root, "third", "ollama"),
    fetchImpl: fakeFetch({ [`${OLLAMA_BASE}sha256sum.txt`]: `${"0".repeat(64)}  ./ollama-darwin.tgz\n` }),
    run: ollamaRun([]),
  });
  assert.match(unlisted.issues[0], /does not list ollama-windows-arm64\.zip/);

  const broken = await installOllama({
    platform: "darwin",
    arch: "x64",
    ollamaDir: path.join(root, "fourth", "ollama"),
    fetchImpl: fakeFetch({ [`${OLLAMA_BASE}sha256sum.txt`]: `${sha256(archive)}  ./ollama-darwin.tgz\n`, [`${OLLAMA_BASE}ollama-darwin.tgz`]: archive }),
    run: ollamaRun([], { versionOk: false }),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.issues[0], /did not run \(ollama --version\): bad CPU type/);
  assert.equal(await exists(path.join(root, "fourth", "ollama")), false, "a copy that does not run is not installed");
});

function response(data = {}, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test("host prepare downloads Ollama's tgz when there is none, and uses that copy for serve, pull and create", async (t) => {
  const root = await tempRoot(t, "runtime-ollama-host");
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  await fsp.mkdir(path.join(serverDir, "host"), { recursive: true });
  await fsp.copyFile(new URL("../server/host-profile.personal.json", import.meta.url), path.join(serverDir, "host-profile.personal.json"));
  await fsp.copyFile(new URL("../server/host/supervisor.mjs", import.meta.url), path.join(serverDir, "host", "supervisor.mjs"));
  await fsp.writeFile(path.join(serverDir, ".env"), "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1\nEMBEDDING_MAX_INPUT_TOKENS=8192\nEMBEDDING_VECTOR_DIMENSIONS=1536\n");
  const ollamaDir = path.join(appHome, "runtime", "ollama");
  const executable = path.join(ollamaDir, "ollama");

  const archive = crypto.randomBytes(2048);
  const downloads = [];
  const calls = [];
  const models = new Set();
  const modelfiles = new Map();
  const unpack = ollamaRun(calls);
  let serving = false;
  const spawned = [];
  const options = {
    profile: "personal",
    installedServerDir: serverDir,
    platform: "darwin",
    arch: "arm64",
    env: { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome },
    homeDir,
    skipGateway: true,
    gatewaySourceInspector: async () => ({ state: "current", present: true, fetchable: false }),
    // Only this test's own directory is looked at, never this computer's Ollama.
    ollamaLocator: ({ ollamaDir: dir }) => (fs.existsSync(path.join(dir, "ollama")) ? { path: path.join(dir, "ollama"), source: "runtime", owned: true } : null),
    downloadFetch: fakeFetch({
      [`${OLLAMA_BASE}sha256sum.txt`]: `${sha256(archive)}  ./ollama-darwin.tgz\n`,
      [`${OLLAMA_BASE}ollama-darwin.tgz`]: archive,
    }, downloads),
    fetchImpl: async () => (serving ? response({ version: "0.35.0" }) : Promise.reject(new Error("ECONNREFUSED"))),
    spawnImpl: (command, args, spawnOptions) => {
      spawned.push({ command, args, spawnOptions });
      serving = true;
      return { unref() {} };
    },
    run: async (command, args, runOptions) => {
      if (command === "which") { calls.push({ command, args }); return { ok: false }; }
      if (command !== executable || args[0] === "--version") return unpack(command, args, runOptions);
      calls.push({ command, args: [...args] });
      if (args[0] === "list") return { ok: true, stdout: `NAME ID SIZE MODIFIED\n${[...models].map((model) => `${model} id 1 GB now`).join("\n")}\n` };
      if (args[0] === "pull") { models.add(args[1]); return { ok: true }; }
      if (args[0] === "create") {
        modelfiles.set(args[1], await fsp.readFile(args[args.indexOf("-f") + 1], "utf8"));
        models.add(args[1]);
        return { ok: true };
      }
      if (args[0] === "show") return { ok: true, stdout: modelfiles.get(args[2]) || "" };
      return { ok: true };
    },
  };

  const prepared = await hostPrepare(options);
  assert.equal(prepared.ready, true, prepared.issues?.join(", "));
  assert.deepEqual(downloads, [`${OLLAMA_BASE}sha256sum.txt`, `${OLLAMA_BASE}ollama-darwin.tgz`]);
  const install = prepared.actions.find((item) => item.type === "install-ollama");
  assert.equal(install.executable, executable);
  assert.equal(install.bytes, archive.length);
  assert.equal(install.sha256, sha256(archive));
  assert.equal(calls.find((call) => base(call.command) === "tar").command, "/usr/bin/tar");
  assert.equal(calls.find((call) => base(call.command) === "tar").args[0], "-xzf");
  if (process.platform !== "win32") assert.equal((await fsp.stat(executable)).mode & 0o111, 0o111, "the binary is executable");
  await fsp.access(path.join(ollamaDir, "libggml-metal.dylib"));

  assert.deepEqual(spawned.map((item) => [item.command, item.args]), [[executable, ["serve"]]], "our own copy is what serves");
  assert.equal(spawned[0].spawnOptions.env.OLLAMA_HOST, "127.0.0.1:11434");
  assert.equal("OLLAMA_MODELS" in spawned[0].spawnOptions.env, false, "models stay in Ollama's default directory");
  assert.deepEqual(calls.filter((call) => call.command === executable && ["pull", "create"].includes(call.args[0])).map((call) => call.args[0]), ["pull", "create"]);
  assert.deepEqual(prepared.actions.map((item) => item.type), ["install-ollama", "ollama-serve", "ollama-pull", "ollama-create", "write-host-config"]);

  const config = JSON.parse(await fsp.readFile(prepared.configFile, "utf8"));
  assert.equal(config.ollama.executable, executable);
  assert.equal(config.ollama.owned, true);
  assert.equal(config.ollama.manageService, true);
});

// ---------------------------------------------------------------- Docker, macOS

function macRun(calls, { ditto = { code: 0 }, team = "9BNSXJN65R" } = {}) {
  return async (command, args) => {
    calls.push(base(command) === "ditto" ? "ditto" : `${base(command)} ${args[0]}`);
    if (base(command) === "hdiutil") return { code: 0, stdout: "" };
    if (base(command) === "codesign" && args[0] === "--verify") return { code: 0 };
    if (base(command) === "codesign" && args[0] === "-dv") return { code: 0, stderr: `Executable=/Volumes/Docker/Docker.app/Contents/MacOS/Docker\nTeamIdentifier=${team}\n` };
    if (base(command) === "spctl") return { code: 0, stderr: SPCTL_ACCEPTED };
    if (base(command) === "ditto") return ditto;
    return { code: 1, stderr: `unexpected ${command}` };
  };
}

function macInstall(root, { calls, launched, engine, ditto, removed = [], team } = {}) {
  let probes = 0;
  return {
    operations: [{ type: "install-docker-desktop", url: DOCKER_DMG, destination: "/Applications/Docker.app" }],
    platform: "darwin",
    arch: "arm64",
    runtimeDir: path.join(root, "runtime"),
    tmpDir: root,
    fetchImpl: fakeFetch({ [DOCKER_DMG]: Buffer.alloc(8192, 1) }),
    run: macRun(calls, { ditto, team }),
    launcher: (app, platform, launchOptions) => { launched.push({ app, platform, ...launchOptions }); calls.push("open"); },
    dockerInspector: async () => { probes += 1; return { installed: true, running: engine(probes) }; },
    engineTimeoutMs: 30,
    enginePollMs: 1,
    sleep: async () => {},
    // /Applications is never looked at or changed here.
    dockerInstallOptions: { pathExists: async () => false, removeApp: (target) => { removed.push(target); } },
  };
}

test("macOS: Docker Desktop is downloaded, checked, copied, opened, and prepare waits for the engine", async (t) => {
  const root = await tempRoot(t, "runtime-docker-mac");
  const calls = [];
  const launched = [];
  const firstRun = await prepareRuntime(macInstall(root, { calls, launched, engine: () => false }));
  assert.deepEqual(calls, [
    "hdiutil attach",
    "codesign --verify",
    "codesign -dv",
    "spctl -a",
    "ditto",
    "hdiutil detach",
    "open",
  ]);
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.ready, false);
  assert.equal(firstRun.nextAction.kind, "docker-first-run");
  assert.equal(firstRun.nextAction.app, "/Applications/Docker.app");
  assert.match(firstRun.nextAction.message, /accept Docker's terms.*recommended settings.*password/);
  assert.deepEqual(launched, [{ app: "/Applications/Docker.app", platform: "darwin", foreground: true }], "opened in front for its first-run window");
  const action = firstRun.actions[0];
  assert.equal(action.type, "install-docker-desktop");
  assert.equal(action.bytes, 8192);
  assert.match(action.verified, /codesign --verify --deep --strict passed, TeamIdentifier=9BNSXJN65R.*spctl -a accepted/);
  assert.equal(await exists(path.join(root, "runtime", "downloads", "Docker.dmg")), false, "the disk image is not kept");
  await fsp.access(path.join(root, "runtime", "docker-desktop", "first-run.json"));

  const readyCalls = [];
  const ready = await prepareRuntime(macInstall(root, { calls: readyCalls, launched: [], engine: (probes) => probes >= 3 }));
  assert.equal(ready.ok, true);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.actions.map((item) => item.type), ["install-docker-desktop", "docker-engine"]);
  assert.equal(await exists(path.join(root, "runtime", "docker-desktop", "first-run.json")), false, "a running engine ends the first run");
});

test("macOS: the dmg's app is copied exactly as the Docker docs describe, and an unwritable /Applications is a clear issue", async (t) => {
  const root = await tempRoot(t, "runtime-docker-mac-copy");
  const seen = [];
  const run = macRun([]);
  const options = macInstall(root, { calls: [], launched: [], engine: () => true });
  const result = await installDockerDesktop({
    ...options,
    ...options.dockerInstallOptions,
    run: async (command, args) => { seen.push({ command, args }); return run(command, args); },
  });
  assert.equal(result.ok, true);
  const attach = seen.find((item) => base(item.command) === "hdiutil" && item.args[0] === "attach");
  const mount = attach.args[attach.args.indexOf("-mountpoint") + 1];
  assert.deepEqual(attach.args, ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, path.join(root, "runtime", "downloads", "Docker.dmg")]);
  assert.deepEqual(seen.find((item) => base(item.command) === "ditto").args, [path.join(mount, "Docker.app"), "/Applications/Docker.app"]);
  assert.deepEqual(seen.find((item) => base(item.command) === "spctl").args, ["-a", "-t", "exec", "-vv", path.join(mount, "Docker.app")]);
  assert.deepEqual(seen.at(-1).args, ["detach", mount]);

  const removed = [];
  const denied = await prepareRuntime(macInstall(root, {
    calls: [],
    launched: [],
    engine: () => true,
    removed,
    ditto: { code: 1, stderr: "ditto: /Applications/Docker.app: Permission denied" },
  }));
  assert.equal(denied.ok, false);
  assert.match(denied.issues[0], /could not be copied into \/Applications.*only administrators can.*no other install location/);
  assert.deepEqual(removed, [], "nothing in /Applications is removed after a permission error");

  const detached = [];
  const forged = await prepareRuntime({
    ...macInstall(root, { calls: detached, launched: [], engine: () => true, team: "ABCDE12345" }),
  });
  assert.equal(forged.ok, false);
  assert.match(forged.issues[0], /not signed by Docker Inc \(Team ID 9BNSXJN65R\)/);
  assert.equal(detached.includes("ditto"), false, "an app with another signer is never copied");
  assert.ok(detached.includes("hdiutil detach"), "the image is detached either way");
});

test("the Docker CLI inside Docker Desktop is used until its first run puts one on PATH", async (t) => {
  const appCli = "/Applications/Docker.app/Contents/Resources/bin/docker";
  const onPath = { value: null };
  const lookup = { platform: "darwin", env: { PATH: "/usr/bin:/bin" }, homeDir: "/Users/t", which: () => onPath.value, fileExists: (target) => target === appCli };
  assert.deepEqual(resolveDockerCli(lookup), { path: appCli, source: "docker-desktop" });
  onPath.value = "/usr/local/bin/docker";
  assert.deepEqual(resolveDockerCli(lookup), { path: "/usr/local/bin/docker", source: "path" }, "PATH wins once it has one");
  onPath.value = null;
  assert.equal(resolveDockerCli({ ...lookup, fileExists: () => false }), null);
  assert.equal(
    resolveDockerCli({ platform: "win32", env: { ProgramFiles: "C:\\Program Files" }, homeDir: "C:\\Users\\t", which: () => null, fileExists: (target) => target.endsWith("docker.exe") }).path,
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
  );

  // The probe runs that CLI, with its folder first on PATH for the helpers beside it.
  const probed = [];
  const probe = await dockerProbe({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    resolver: (options) => resolveDockerCli({ ...lookup, ...options, which: () => null }),
    exec: async (command, args, options) => { probed.push({ command, args, PATH: options.env.PATH }); return { stdout: "2.40.0\n" }; },
  });
  assert.equal(probe.running, true);
  assert.equal(probe.cli, appCli);
  assert.deepEqual(probed.map((item) => item.command), [appCli, appCli]);
  assert.equal(probed[0].PATH, "/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin");

  const missing = await dockerProbe({ resolver: () => null, exec: async () => { throw new Error("must not run"); } });
  assert.deepEqual([missing.installed, missing.running], [false, false]);

  // Every compose call goes through the same CLI.
  const root = await tempRoot(t, "runtime-docker-cli");
  const composed = [];
  await compose(root, ["ps"], {
    dockerCli: { path: appCli, source: "docker-desktop" },
    exec: async (command, args, options) => { composed.push({ command, args, env: options.env }); return { stdout: "", stderr: "" }; },
  });
  assert.equal(composed[0].command, appCli);
  assert.deepEqual(composed[0].args, ["compose", "--project-directory", root, "ps"]);
  assert.ok(composed[0].env.PATH.startsWith("/Applications/Docker.app/Contents/Resources/bin"));
  assert.equal(composed[0].env.COMPOSE_PROJECT_NAME, "honcho-agent-bridge");
});

test("server prepare stops at Docker's first run, changes nothing else, and picks up there next time", async (t) => {
  const root = await tempRoot(t, "runtime-prepare-first-run");
  const source = await personalBundle(root);
  const destination = path.join(root, "app", "server");
  const hostRuntime = new Proxy({}, { get: () => async () => { throw new Error("the host runtime must not be touched"); } });
  const calls = [];
  const launched = [];
  const install = macInstall(root, { calls, launched, engine: () => false });
  const { operations, dockerInspector, ...runtimeOptions } = install;
  runtimeOptions.runtimeDir = undefined;
  const result = await serverPrepare({
    profile: "personal",
    platform: "darwin",
    arch: "arm64",
    hostRuntime,
    serverDirectory: destination,
    preparedPlan: { ok: true, ready: true, bundle: { directory: source }, operations },
    honchoSourceFetcher: async () => { throw new Error("nothing is fetched before Docker is ready"); },
    gatewaySourceFetcher: async () => { throw new Error("the gateway is not installed before Docker is ready"); },
    dockerInspector,
    runtimeOptions: Object.fromEntries(Object.entries(runtimeOptions).filter(([, value]) => value !== undefined)),
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.equal(result.nextAction.kind, "docker-first-run");
  assert.equal(result.next, result.nextAction.message);
  assert.deepEqual(result.actions.map((item) => item.type), ["install-docker-desktop"]);
  assert.equal(await exists(destination), false, "no server bundle was installed");
  await fsp.access(path.join(root, "app", "runtime", "docker-desktop", "first-run.json"));

  // The next prepare finds Docker Desktop installed, its first run still pending.
  const again = await serverPrepare({
    profile: "personal",
    platform: "darwin",
    hostRuntime,
    serverDirectory: destination,
    dockerInspector: async () => ({ installed: true, running: false, cli: "/Applications/Docker.app/Contents/Resources/bin/docker" }),
    dockerAppFinder: async () => "/Applications/Docker.app",
    ollamaLocator: () => ({ path: "/somewhere/ollama", source: "path" }),
    runtimeInstaller: async () => { throw new Error("nothing is left to install"); },
    dockerStarter: async () => ({ installed: true, running: false, started: false, app: "/Applications/Docker.app" }),
    honchoSourceFetcher: async () => { throw new Error("nothing is fetched before Docker is ready"); },
  });
  assert.equal(again.ok, true);
  assert.equal(again.ready, false);
  assert.equal(again.nextAction.kind, "docker-first-run");
  assert.equal(again.nextAction.app, "/Applications/Docker.app");
});

// ---------------------------------------------------------------- Docker, Windows

function windowsRun(calls, { signature = "Valid\nCN=Docker Inc, O=Docker Inc, L=Palo Alto, S=California, C=US\n", install = { code: 0 }, wsl = { code: 0, stdout: "Default Version: 2\n" } } = {}) {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    const script = args.at(-1);
    if (base(command) === "powershell.exe" && script.includes("Get-AuthenticodeSignature")) return { code: 0, stdout: signature };
    if (base(command) === "powershell.exe" && script.includes("Start-Process")) return install;
    if (command === "wsl.exe") return wsl;
    return { code: 1, stderr: `unexpected ${command}` };
  };
}

function windowsInstall(root, calls, launched, runOptions) {
  return {
    platform: "win32",
    arch: "x64",
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
    runtimeDir: path.join(root, "runtime"),
    fetchImpl: fakeFetch({ [DOCKER_EXE]: Buffer.alloc(4096, 2) }),
    run: windowsRun(calls, runOptions),
    launcher: (app, platform, launchOptions) => launched.push({ app, platform, ...launchOptions }),
  };
}

test("Windows: the signed installer runs elevated with Docker's documented arguments", async (t) => {
  const root = await tempRoot(t, "runtime-docker-windows");
  const installer = path.join(root, "runtime", "downloads", "Docker Desktop Installer.exe");
  const command = windowsDockerInstallCommand("C:\\Users\\o'neil\\Docker Desktop Installer.exe", { SystemRoot: "C:\\Windows" });
  assert.equal(command.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(command.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(
    command.args[3],
    "$p = Start-Process -FilePath 'C:\\Users\\o''neil\\Docker Desktop Installer.exe' -ArgumentList 'install','--accept-license','--quiet' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
  );

  const calls = [];
  const launched = [];
  const result = await installDockerDesktop(windowsInstall(root, calls, launched));
  assert.equal(result.ok, true, result.issues?.join(", "));
  assert.match(calls[0].args.at(-1), /Get-AuthenticodeSignature -LiteralPath '.*Docker Desktop Installer\.exe'/, "the signature is checked before it runs");
  assert.equal(calls[1].args.at(-1), windowsDockerInstallCommand(installer, { SystemRoot: "C:\\Windows" }).args[3]);
  assert.deepEqual(calls[2], { command: "wsl.exe", args: ["--status"] });
  assert.deepEqual(launched, [{ app: "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe", platform: "win32", foreground: true }]);
  assert.match(result.action.verified, /Authenticode signature Valid, signer CN=Docker Inc/);
  assert.equal(result.action.elevated, true);

  const unsigned = [];
  const rejected = await installDockerDesktop(windowsInstall(root, unsigned, [], { signature: "NotSigned\n\n" }));
  assert.equal(rejected.ok, false);
  assert.match(rejected.issues[0], /Authenticode signature is not valid \(NotSigned\)/);
  assert.equal(unsigned.length, 1, "an unsigned installer never runs");

  const otherSigner = await installDockerDesktop(windowsInstall(root, [], [], { signature: "Valid\nCN=Someone, O=Someone Else\n" }));
  assert.match(otherSigner.issues[0], /not Docker Inc/);
});

test("Windows: a restart the installer or WSL asks for becomes a restart-required next step", async (t) => {
  const root = await tempRoot(t, "runtime-docker-windows-restart");
  const launched = [];
  const byExitCode = await installDockerDesktop(windowsInstall(root, [], launched, { install: { code: 3010 } }));
  assert.equal(byExitCode.ok, true);
  assert.equal(byExitCode.ready, false);
  assert.equal(byExitCode.nextAction.kind, "restart-required");
  assert.match(byExitCode.nextAction.message, /installer asked for a restart.*Restart Windows/);

  // wsl.exe writes UTF-16, which reaches us with NULs between the letters.
  const wslText = "WSL 2 requires an update. Please restart your computer.".split("").join("\0");
  const byWsl = await installDockerDesktop(windowsInstall(root, [], launched, { wsl: { code: 0, stdout: wslText } }));
  assert.equal(byWsl.nextAction.kind, "restart-required");
  const noWsl = await installDockerDesktop(windowsInstall(root, [], launched, { wsl: { code: 1, stderr: "not installed" } }));
  assert.equal(noWsl.nextAction.kind, "restart-required");
  assert.match(noWsl.nextAction.message, /WSL 2 is not ready yet/);
  assert.deepEqual(launched, [], "Docker Desktop is not started before the restart");
  await fsp.access(path.join(root, "runtime", "docker-desktop", "first-run.json"));

  const declined = await installDockerDesktop(windowsInstall(root, [], [], { install: { code: 1, stderr: "Start-Process : This command cannot be run due to the error: The operation was canceled by the user." } }));
  assert.equal(declined.ok, true);
  assert.equal(declined.nextAction.kind, "docker-install-approval");
  assert.match(declined.nextAction.message, /choose Yes in the Windows prompt/);

  const failed = await installDockerDesktop(windowsInstall(root, [], [], { install: { code: 1603, stderr: "Installation failed" } }));
  assert.equal(failed.ok, false);
  assert.match(failed.issues[0], /exit code 1603/);

  // Through prepare, the restart stops everything else, Ollama included.
  const stopped = await prepareRuntime({
    ...windowsInstall(root, [], [], { install: { code: 3010 } }),
    operations: [{ type: "install-docker-desktop" }, { type: "install-ollama", destination: path.join(root, "runtime", "ollama") }],
    ollamaInstaller: async () => { throw new Error("not before the restart"); },
    dockerInspector: async () => ({ installed: false, running: false }),
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.ready, false);
  assert.equal(stopped.nextAction.kind, "restart-required");
});

// ---------------------------------------------------------------- restarting our own ollama serve

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("the supervisor starts the app's own ollama serve again whenever it stops answering", { skip: process.platform === "win32" }, async (t) => {
  const root = await tempRoot(t, "runtime-supervisor-restart");
  // A stand-in `ollama serve`: it answers on OLLAMA_HOST and notes each start.
  const starts = path.join(root, "starts.txt");
  const server = path.join(root, "fake-ollama.cjs");
  await fsp.writeFile(server, `
const fs = require("node:fs");
const http = require("node:http");
if (process.argv[2] !== "serve") process.exit(2);
const [host, port] = process.env.OLLAMA_HOST.split(":");
fs.appendFileSync(${JSON.stringify(starts)}, process.pid + "\\n");
http.createServer((request, reply) => {
  reply.setHeader("content-type", "application/json");
  if (request.url === "/api/version") return reply.end(JSON.stringify({ version: "0.35.0" }));
  if (request.url === "/api/embed") return reply.end(JSON.stringify({ embeddings: [Array(1536).fill(0.1)] }));
  reply.statusCode = 404; reply.end("{}");
}).listen(Number(port), host);
`);
  const executable = path.join(root, "runtime", "ollama", "ollama");
  await fsp.mkdir(path.dirname(executable), { recursive: true });
  await fsp.writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)} "$@"\n`, { mode: 0o755 });

  const port = await freePort();
  const state = path.join(root, "state");
  await fsp.mkdir(state, { recursive: true });
  const configFile = path.join(state, "host-config.json");
  const pidFile = path.join(state, "pid.json");
  const supervisorFile = fileURLToPath(new URL("../server/host/supervisor.mjs", import.meta.url));
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    ollama: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}`,
      executable,
      owned: true,
      model: "qwen3-embedding-4b-honcho-8192",
      dimensions: 1536,
      keepAlive: -1,
      warmIntervalMs: 60_000,
      serviceCheckIntervalMs: 150,
      manageService: true,
    },
    state: { configFile, pidFile, logDir: path.join(state, "logs") },
    supervisorFile,
  }));
  const child = spawn(process.execPath, [supervisorFile, "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const startedPids = async () => (await fsp.readFile(starts, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGKILL");
    for (const pid of await startedPids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  });

  assert.equal(await waitUntil(() => output.includes("embedding-resident")), true, output);
  const [first] = await startedPids();
  assert.ok(first, "the supervisor started our ollama serve");
  process.kill(first, "SIGKILL");
  assert.equal(await waitUntil(async () => (await startedPids()).length >= 2), true, output);
  assert.match(output, /ollama-exited/);
  assert.match(output, /ollama-not-answering/);
  const [, second] = await startedPids();
  assert.equal(await waitUntil(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/version`)).ok; } catch { return false; }
  }), true, "the restarted serve answers");

  child.kill("SIGTERM");
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 5_000);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
  assert.equal(await waitUntil(() => !alive(second), 3_000), true, "stopping the supervisor stops the serve it started");
});

test("host start brings the app's own ollama serve back when the supervisor is already running", async (t) => {
  const root = await tempRoot(t, "runtime-host-start-restart");
  const homeDir = path.join(root, "user");
  const appHome = path.join(root, "app");
  const serverDir = path.join(appHome, "server");
  const env = { HOME: homeDir, HONCHO_AGENT_BRIDGE_HOME: appHome };
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "darwin", env, homeDir });
  const executable = path.join(paths.ollamaDir, "ollama");
  const writeConfig = async (owned) => {
    await fsp.mkdir(paths.runtimeDir, { recursive: true });
    await fsp.writeFile(paths.configFile, JSON.stringify({
      format: 1,
      profile: "personal",
      gateway: { directory: paths.gatewayDir, uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" },
      ollama: { enabled: true, owned, manageService: true, executable, baseUrl: "http://127.0.0.1:11434", model: "qwen3-embedding-4b-honcho-8192" },
      state: { configFile: paths.configFile, pidFile: paths.pidFile, logDir: paths.logDir },
      supervisorFile: paths.supervisorFile,
    }));
  };
  // A live supervisor: this test process's own PID.
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(paths.pidFile, JSON.stringify({ pid: process.pid, configFile: paths.configFile, supervisorFile: paths.supervisorFile }));
  await fsp.mkdir(path.join(paths.gatewayDir, "gateway"), { recursive: true });
  await fsp.writeFile(path.join(paths.gatewayDir, "gateway", "cli.mjs"), "// stand-in\n");
  const gatewayRunner = async () => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      ui: { url: "http://127.0.0.1:11450", ok: true },
      router: { url: "http://127.0.0.1:11400/v1", ok: true },
      accounts: [{ id: "codex-1", loggedIn: true }],
      models: ["gpt-6-luna"],
    }),
  });

  const start = async (owned) => {
    await writeConfig(owned);
    let serving = false;
    const spawned = [];
    const result = await hostStart({
      profile: "personal",
      installedServerDir: serverDir,
      platform: "darwin",
      env,
      homeDir,
      skipPrepare: true,
      startTimeoutMs: 1_000,
      statusPollMs: 10,
      gatewayRunner,
      // launchctl as a stand-in: nothing loaded yet, every change accepted.
      autostartRunner: async (command, args) => ({ code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "" }),
      uid: 501,
      fetchImpl: async (url) => {
        if (!serving) throw new Error("ECONNREFUSED");
        return String(url).endsWith("/api/ps") ? response({ models: [{ name: "qwen3-embedding-4b-honcho-8192" }] }) : response({ version: "0.35.0" });
      },
      spawnImpl: (command, args, spawnOptions) => {
        spawned.push({ command, args, spawnOptions });
        if (command === executable) serving = true;
        return { unref() {} };
      },
    });
    return { result, spawned };
  };

  const own = await start(true);
  assert.deepEqual(own.spawned.map((item) => [item.command, item.args]), [[executable, ["serve"]]], "only ollama serve; the supervisor was already running");
  assert.equal(own.spawned[0].spawnOptions.detached, true);
  assert.equal(own.spawned[0].spawnOptions.env.OLLAMA_HOST, "127.0.0.1:11434");
  assert.equal(own.result.ollamaRestarted, true);
  assert.equal(own.result.ok, true);

  const external = await start(false);
  assert.deepEqual(external.spawned, [], "an Ollama the app does not own is left to itself");
});
