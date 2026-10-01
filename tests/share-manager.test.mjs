// Sharing a personal server: the gate token is made once and kept, the tunnel
// token only ever sits in an owner-only file, the autostart is per user on every
// platform, and turning sharing off keeps both tokens. Every OS call goes to fakes.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  classifyPublicResponse,
  cloudflaredAsset,
  CLOUDFLARED_DOWNLOAD_BASE,
  ensureCloudflared,
  extractTarEntry,
  LAUNCHD_LABEL,
  normalizePublicUrl,
  RUN_KEY,
  RUN_VALUE,
  shareDisable,
  shareEnable,
  shareEnableMesh,
  shareRotate,
  shareStatus,
  shareSummary,
  shareToken,
  SYSTEMD_UNIT,
} from "../scripts/share-manager.mjs";
import { serverStatus } from "../scripts/server-manager.mjs";

const TUNNEL_TOKEN = "eyJhIjoiYWNjb3VudC10YWciLCJ0IjoidHVubmVsLWlkIiwicyI6InNlY3JldCJ9";
const PUBLIC_URL = "https://memory.example.com";

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function tarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

function fakeTgz(binary) {
  return zlib.gzipSync(Buffer.concat([tarEntry("LICENSE", Buffer.from("license")), tarEntry("cloudflared", binary), Buffer.alloc(1024)]));
}

function response(status, { headers = {}, body = "" } = {}) {
  const map = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: map,
    body: { cancel: async () => {} },
    arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body)),
  };
}

async function readJsonFile(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

// What this computer's WARP reports in the Mesh tests unless a test changes it.
function readyMesh() {
  return {
    warp: { installed: true, connected: true, team: "acme-team", iface: "utun4" },
    ip: "100.96.3.4",
    iface: "utun4",
    splitTunnel: { ok: true, mode: "include" },
  };
}

async function fixture(t, { platform = "darwin", profiles = "debug", env = { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, binary = "present", meshForwarder = true, hostConfig = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-share-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "app", "server");
  await fsp.mkdir(path.join(serverDirectory, "gate"), { recursive: true });
  await fsp.writeFile(path.join(serverDirectory, "compose.yaml"), "name: honcho-agent-bridge\n");
  await fsp.writeFile(path.join(serverDirectory, "gate", "gate.mjs"), "// gate\n");
  if (meshForwarder) {
    await fsp.mkdir(path.join(serverDirectory, "host"), { recursive: true });
    await fsp.writeFile(path.join(serverDirectory, "host", "mesh-forwarder.mjs"), "// forwarder\n");
  }
  // The host supervisor's files, as host-manager names them.
  const hostRuntime = path.join(root, "app", "runtime", "host");
  const host = {
    pidFile: path.join(hostRuntime, "supervisor.pid.json"),
    configFile: path.join(hostRuntime, "host-config.json"),
    forwarderFile: path.join(hostRuntime, "mesh-forwarder.json"),
  };
  const shareFile = path.join(root, "app", "runtime", "share.json");
  if (hostConfig) {
    await fsp.mkdir(hostRuntime, { recursive: true });
    await fsp.writeFile(host.configFile, JSON.stringify({
      format: 1,
      mesh: { shareStateFile: shareFile, forwarderFile: path.join(serverDirectory, "host", "mesh-forwarder.mjs"), stateFile: host.forwarderFile },
    }));
  }
  const envLines = ["POSTGRES_PASSWORD=db-secret", "EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-4b-honcho-8192"];
  if (profiles) envLines.push(`COMPOSE_PROFILES=${profiles}`);
  await fsp.writeFile(path.join(serverDirectory, ".env"), `${envLines.join("\n")}\n`, { mode: 0o600 });
  const runtime = path.join(root, "app", "runtime", "cloudflared");
  const binaryPath = path.join(runtime, platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (binary === "present") {
    await fsp.mkdir(runtime, { recursive: true });
    await fsp.writeFile(binaryPath, "#!/bin/sh\n", { mode: 0o755 });
  }
  const home = path.join(root, "home");
  const calls = [];
  const state = { launchdLoaded: false, windowsRunning: false, versionOk: true, firewallPort: null, firewallAnswer: null, mesh: readyMesh(), hostStart: null };
  const run = async (command, args) => {
    calls.push({ command, args });
    const script = String(args.at(-1) || "");
    if (/powershell/i.test(command) && script.includes("New-NetFirewallRule")) {
      const answer = state.firewallAnswer || { code: 0, stdout: "" };
      if (answer.code === 0) state.firewallPort = Number(/-LocalPort (\d+)/.exec(script)[1]);
      return { stdout: "", stderr: "", ...answer };
    }
    if (/powershell/i.test(command) && script.includes("Get-NetFirewallRule")) {
      return { code: 0, stdout: state.firewallPort ? `rule TCP ${state.firewallPort} 100.96.0.0/255.240.0.0\r\n` : "", stderr: "" };
    }
    if (args[0] === "--version") {
      return state.versionOk ? { code: 0, stdout: "cloudflared version 2026.9.1 (built 2026-09-20)\n", stderr: "" } : { code: 1, stdout: "", stderr: "bad" };
    }
    if (command === "/bin/launchctl") {
      if (args[0] === "print") return state.launchdLoaded ? { code: 0, stdout: "state = running\npid = 42\n" } : { code: 113, stdout: "", stderr: "not found" };
      if (args[0] === "bootstrap") { state.launchdLoaded = true; return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "bootout") { state.launchdLoaded = false; return { code: 0, stdout: "", stderr: "" }; }
    }
    if (/powershell/i.test(command)) {
      const stopping = args.at(-1).includes("Stop-Process");
      const output = state.windowsRunning ? "4242\n" : "";
      if (stopping) state.windowsRunning = false;
      return { code: 0, stdout: output, stderr: "" };
    }
    if (command === "systemctl" && args[1] === "is-active") return { code: 0, stdout: "active\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const composeRunner = async (directory, args) => {
    calls.push({ command: "docker compose", directory, args });
    if (args[0] === "ps") return { stdout: `${JSON.stringify({ Service: "gate", State: "running" })}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const spawnImpl = (command, args, options) => {
    calls.push({ command: "spawn", file: command, args, detached: options?.detached });
    state.windowsRunning = true;
    return { on() {}, unref() {} };
  };
  const fetches = [];
  let publicAnswer = () => response(200);
  const fetchImpl = async (url, options = {}) => {
    fetches.push({ url, options });
    if (url.startsWith("http://127.0.0.1:")) return response(200);
    if (url.startsWith(CLOUDFLARED_DOWNLOAD_BASE)) {
      const asset = url.slice(CLOUDFLARED_DOWNLOAD_BASE.length);
      return response(200, { body: asset.endsWith(".tgz") ? fakeTgz(Buffer.from("MACHO-BINARY")) : Buffer.from("PLAIN-BINARY") });
    }
    return publicAnswer(url, options);
  };
  // A stand-in for the host supervisor: while its PID file names a live process, the
  // forwarder runs exactly when share.json turns Mesh on. It acts whenever the code
  // under test waits.
  const syncForwarder = async () => {
    const supervisor = await readJsonFile(host.pidFile);
    if (!supervisor) return;
    const share = await readJsonFile(shareFile);
    if (share?.mesh?.enabled === true) {
      await fsp.writeFile(host.forwarderFile, JSON.stringify({ pid: process.pid, port: share.mesh.port, targetPort: share.mesh.gatePort }));
    } else {
      await fsp.rm(host.forwarderFile, { force: true });
    }
  };
  const hostStarts = [];
  const hostRuntimeFake = {
    start: async (startOptions) => {
      hostStarts.push(startOptions);
      if (state.hostStart) return state.hostStart;
      await fsp.mkdir(hostRuntime, { recursive: true });
      await fsp.writeFile(host.pidFile, JSON.stringify({ pid: process.pid }));
      return { ok: true, running: true, started: true };
    },
  };
  const options = {
    serverDirectory,
    homeDir: home,
    platform,
    filePlatform: process.platform,
    arch: "arm64",
    uid: 501,
    env: { SystemRoot: "C:\\Windows", ...env },
    run,
    composeRunner,
    spawnImpl,
    fetchImpl,
    which: () => null,
    fileExists: () => false,
    sleep: syncForwarder,
    portInUse: async (port) => port === 8010,
    gateWaitMs: 0,
    meshProbe: async () => structuredClone(state.mesh),
    hostRuntime: hostRuntimeFake,
    meshWaitMs: 2_000,
  };
  return {
    root,
    home,
    serverDirectory,
    envFile: path.join(serverDirectory, ".env"),
    tokenFile: path.join(runtime, "tunnel-token"),
    shareFile,
    host,
    hostStarts,
    binaryPath,
    runtime,
    calls,
    fetches,
    state,
    options,
    setPublicAnswer(fn) { publicAnswer = fn; },
  };
}

async function mode(target) {
  return (await fsp.stat(target)).mode & 0o777;
}

function commandsText(calls) {
  return JSON.stringify(calls);
}

test("enable makes the gate token once, merges the profile and keeps the tunnel token out of every command", async (t) => {
  const f = await fixture(t);
  const first = await shareEnable({ ...f.options, publicUrl: `${PUBLIC_URL}/` });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.publicUrl, PUBLIC_URL);
  assert.equal(first.gateTokenCreated, true);
  assert.equal(first.gate.port, 8011, "8010 was busy");
  assert.equal(first.gate.healthy, true);

  const environment = parseEnv(await fsp.readFile(f.envFile, "utf8"));
  assert.match(environment.HONCHO_GATE_TOKEN, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  assert.equal(environment.COMPOSE_PROFILES, "debug,share", "other profiles are kept");
  assert.equal(environment.HONCHO_GATE_PORT, "8011");
  assert.equal(environment.POSTGRES_PASSWORD, "db-secret");
  assert.equal(await fsp.readFile(f.tokenFile, "utf8"), TUNNEL_TOKEN);
  if (process.platform !== "win32") {
    assert.equal(await mode(f.tokenFile), 0o600);
    assert.equal(await mode(f.envFile), 0o600);
  }

  assert.ok(f.calls.some((call) => call.command === "docker compose" && call.args.join(" ") === "up -d gate"));
  const plistPath = path.join(f.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const bootstrap = f.calls.find((call) => call.command === "/bin/launchctl" && call.args[0] === "bootstrap");
  assert.deepEqual(bootstrap.args, ["bootstrap", "gui/501", plistPath]);
  const plist = await fsp.readFile(plistPath, "utf8");
  for (const part of [f.binaryPath, "tunnel", "--no-autoupdate", "run", "--token-file", f.tokenFile]) {
    assert.ok(plist.includes(`<string>${part}</string>`), part);
  }
  assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\t<true\/>/);
  assert.ok(plist.includes(path.join(f.runtime, "logs", "tunnel.log")));

  const saved = JSON.parse(await fsp.readFile(path.join(f.root, "app", "runtime", "share.json"), "utf8"));
  assert.equal(saved.publicUrl, PUBLIC_URL);
  assert.ok(saved.enabledAt);

  // A second enable with no tunnel token keeps the saved one and the gate token.
  const second = await shareEnable({ ...f.options, env: { SystemRoot: "C:\\Windows" }, publicUrl: PUBLIC_URL });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.gateTokenCreated, false);
  assert.equal(second.tunnel.tokenUpdated, false);
  const again = parseEnv(await fsp.readFile(f.envFile, "utf8"));
  assert.equal(again.HONCHO_GATE_TOKEN, environment.HONCHO_GATE_TOKEN);
  assert.equal(again.COMPOSE_PROFILES, "debug,share", "share is not added twice");
  assert.equal(await fsp.readFile(f.tokenFile, "utf8"), TUNNEL_TOKEN);
  assert.equal(f.calls.filter((call) => call.args[0] === "bootstrap").length, 1, "an unchanged running tunnel is left alone");

  // A new tunnel token is only read at start, so the running tunnel is restarted.
  const newToken = `${TUNNEL_TOKEN}Zm9v`;
  const third = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: newToken }, publicUrl: PUBLIC_URL });
  assert.equal(third.tunnel.tokenUpdated, true);
  assert.equal(await fsp.readFile(f.tokenFile, "utf8"), newToken);
  const restartedWith = f.calls.slice(-2).map((call) => call.args[0]);
  assert.deepEqual(restartedWith, ["bootout", "bootstrap"]);
  assert.equal(commandsText(f.calls).includes(newToken), false);

  const recorded = commandsText(f.calls);
  assert.equal(recorded.includes(TUNNEL_TOKEN), false, "the tunnel token is never an argument");
  assert.equal(recorded.includes(environment.HONCHO_GATE_TOKEN), false, "nor is the gate token");
  assert.equal(plist.includes(TUNNEL_TOKEN), false);
  assert.equal(JSON.stringify(first).includes(TUNNEL_TOKEN), false);
  assert.equal(JSON.stringify(first).includes(environment.HONCHO_GATE_TOKEN), false);

  assert.deepEqual(await shareSummary({ serverDirectory: f.serverDirectory }), { enabled: true, publicUrl: PUBLIC_URL });
  const token = await shareToken(f.options);
  assert.deepEqual(token, { ok: true, token: environment.HONCHO_GATE_TOKEN });
});

test("enable needs a tunnel token the first time, an https host, and a personal server", async (t) => {
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

  await fsp.writeFile(f.envFile, "EMBEDDING_MODEL_CONFIG__MODEL=text-embedding-3-small\n");
  const portable = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, publicUrl: PUBLIC_URL });
  assert.equal(portable.ok, false);
  assert.match(portable.error, /personal/);

  await fsp.rm(f.serverDirectory, { recursive: true });
  const none = await shareEnable({ ...f.options, env: { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, publicUrl: PUBLIC_URL });
  assert.equal(none.ok, false);
  assert.match(none.error, /No personal memory server/);
});

test("disable closes the tunnel and the gate, and keeps both tokens", async (t) => {
  const f = await fixture(t);
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  const gateToken = parseEnv(await fsp.readFile(f.envFile, "utf8")).HONCHO_GATE_TOKEN;
  f.calls.length = 0;

  const disabled = await shareDisable(f.options);
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.keptTunnelToken, true);
  const order = f.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
  const bootout = order.findIndex((line) => line.startsWith("/bin/launchctl bootout gui/501/team-memory-system.tunnel"));
  const stop = order.indexOf("docker compose stop gate");
  assert.ok(bootout >= 0 && stop > bootout, "the public way in closes first");
  assert.ok(order.includes("docker compose rm -f gate"));
  await assert.rejects(fsp.access(path.join(f.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)));

  const environment = parseEnv(await fsp.readFile(f.envFile, "utf8"));
  assert.equal(environment.COMPOSE_PROFILES, "debug");
  assert.equal(environment.HONCHO_GATE_TOKEN, gateToken, "the gate token is kept");
  assert.equal(await fsp.readFile(f.tokenFile, "utf8"), TUNNEL_TOKEN, "the tunnel token is kept");
  assert.deepEqual(await shareSummary({ serverDirectory: f.serverDirectory }), { enabled: false, publicUrl: PUBLIC_URL });
});

test("disable removes COMPOSE_PROFILES when share was the only profile", async (t) => {
  const f = await fixture(t, { profiles: "" });
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  assert.equal(parseEnv(await fsp.readFile(f.envFile, "utf8")).COMPOSE_PROFILES, "share");
  assert.equal((await shareDisable(f.options)).ok, true);
  const text = await fsp.readFile(f.envFile, "utf8");
  assert.equal(/^COMPOSE_PROFILES=/m.test(text), false);
  assert.match(text, /^HONCHO_GATE_TOKEN=/m);
});

test("rotate replaces the gate token and recreates only the gate", async (t) => {
  const f = await fixture(t);
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  const before = parseEnv(await fsp.readFile(f.envFile, "utf8")).HONCHO_GATE_TOKEN;
  f.calls.length = 0;
  const rotated = await shareRotate(f.options);
  assert.equal(rotated.ok, true);
  assert.equal(rotated.restarted, true);
  const after = parseEnv(await fsp.readFile(f.envFile, "utf8")).HONCHO_GATE_TOKEN;
  assert.notEqual(after, before);
  assert.match(after, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.calls.map((call) => call.args.join(" ")), ["up -d --no-deps gate"]);
  assert.equal(commandsText(f.calls).includes(after), false);
});

test("Windows registers a hidden wscript under HKCU Run and starts it now", async (t) => {
  const f = await fixture(t, { platform: "win32" });
  const enabled = await shareEnable({ ...f.options, publicUrl: PUBLIC_URL });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  const vbsPath = path.join(f.runtime, "tunnel.vbs");
  const added = f.calls.find((call) => call.command.endsWith("reg.exe") && call.args[0] === "add");
  assert.deepEqual(added.args, [
    "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d",
    `"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "${vbsPath}"`, "/f",
  ]);
  const spawned = f.calls.find((call) => call.command === "spawn");
  assert.equal(spawned.file, "C:\\Windows\\System32\\wscript.exe");
  assert.deepEqual(spawned.args, ["//B", "//NoLogo", vbsPath]);
  assert.equal(spawned.detached, true);
  const raw = await fsp.readFile(vbsPath);
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], "UTF-16 so any path survives");
  const vbs = raw.subarray(2).toString("utf16le");
  assert.match(vbs, /shell\.Run .*tunnel --no-autoupdate --logfile .*run --token-file .*, 0, False/);
  assert.ok(vbs.includes(f.tokenFile));
  assert.equal(vbs.includes(TUNNEL_TOKEN), false);

  // Already running from the same script: not started twice.
  f.calls.length = 0;
  assert.equal((await shareEnable({ ...f.options, env: {}, publicUrl: PUBLIC_URL })).ok, true);
  assert.equal(f.calls.some((call) => call.command === "spawn"), false);

  f.calls.length = 0;
  assert.equal((await shareDisable(f.options)).ok, true);
  const lines = f.calls.map((call) => `${path.win32.basename(call.command)} ${call.args.join(" ")}`);
  assert.ok(lines.includes(`reg.exe delete ${RUN_KEY} /v ${RUN_VALUE} /f`));
  assert.ok(f.calls.some((call) => /powershell/i.test(call.command) && call.args.at(-1).includes("Stop-Process") && call.args.at(-1).includes(f.tokenFile)),
    "only the cloudflared started with this token file is stopped");
  await assert.rejects(fsp.access(vbsPath));
  assert.equal(commandsText(f.calls).includes(TUNNEL_TOKEN), false);
});

test("Linux registers a systemd --user unit", async (t) => {
  const f = await fixture(t, { platform: "linux" });
  const enabled = await shareEnable({ ...f.options, publicUrl: PUBLIC_URL });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  const systemctl = f.calls.filter((call) => call.command === "systemctl").map((call) => call.args.join(" "));
  assert.deepEqual(systemctl, [
    "--user show-environment",
    "--user daemon-reload",
    `--user enable ${SYSTEMD_UNIT}`,
    `--user restart ${SYSTEMD_UNIT}`,
  ]);
  const unit = await fsp.readFile(path.join(f.home, ".config", "systemd", "user", SYSTEMD_UNIT), "utf8");
  assert.ok(unit.includes(`ExecStart="${f.binaryPath}" "tunnel" "--no-autoupdate" "run" "--token-file" "${f.tokenFile}"`));
  assert.match(unit, /Restart=always/);
  assert.ok(unit.includes(`StandardOutput=append:${path.join(f.runtime, "logs", "tunnel.log")}`));
  assert.equal(unit.includes(TUNNEL_TOKEN), false);

  f.calls.length = 0;
  assert.equal((await shareDisable(f.options)).ok, true);
  assert.ok(f.calls.some((call) => call.command === "systemctl" && call.args.join(" ") === `--user disable --now ${SYSTEMD_UNIT}`));
});

test("cloudflared is downloaded for this platform when it is nowhere, and verified", async (t) => {
  assert.deepEqual(cloudflaredAsset("darwin", "arm64"), { name: "cloudflared-darwin-arm64.tgz", archive: "tgz" });
  assert.deepEqual(cloudflaredAsset("darwin", "x64"), { name: "cloudflared-darwin-amd64.tgz", archive: "tgz" });
  assert.deepEqual(cloudflaredAsset("win32", "x64"), { name: "cloudflared-windows-amd64.exe", archive: null });
  assert.deepEqual(cloudflaredAsset("linux", "arm64"), { name: "cloudflared-linux-arm64", archive: null });
  assert.throws(() => cloudflaredAsset("linux", "ia32"));
  assert.equal(extractTarEntry(zlib.gunzipSync(fakeTgz(Buffer.from("x".repeat(700)))), "cloudflared").toString(), "x".repeat(700));

  const mac = await fixture(t, { binary: "absent" });
  const found = await ensureCloudflared(mac.options);
  assert.equal(found.source, "downloaded");
  assert.equal(found.version, "2026.9.1");
  assert.equal(await fsp.readFile(mac.binaryPath, "utf8"), "MACHO-BINARY");
  if (process.platform !== "win32") assert.equal(await mode(mac.binaryPath) & 0o111, 0o111, "executable");
  assert.equal(mac.fetches[0].url, `${CLOUDFLARED_DOWNLOAD_BASE}cloudflared-darwin-arm64.tgz`);
  assert.ok(mac.calls.some((call) => call.command === mac.binaryPath && call.args[0] === "--version"));

  const windows = await fixture(t, { platform: "win32", binary: "absent" });
  await ensureCloudflared({ ...windows.options, arch: "x64" });
  assert.equal(await fsp.readFile(windows.binaryPath, "utf8"), "PLAIN-BINARY");
  assert.equal(windows.fetches[0].url, `${CLOUDFLARED_DOWNLOAD_BASE}cloudflared-windows-amd64.exe`);

  const onPath = await fixture(t, { binary: "absent" });
  const existing = await ensureCloudflared({ ...onPath.options, which: () => "/opt/homebrew/bin/cloudflared" });
  assert.equal(existing.source, "path");
  assert.equal(onPath.fetches.length, 0, "nothing downloaded");

  const broken = await fixture(t, { binary: "absent" });
  broken.state.versionOk = false;
  await assert.rejects(ensureCloudflared(broken.options), /did not run/);
  await assert.rejects(fsp.access(broken.binaryPath), "a binary that does not run is not kept");
});

test("status reports the gate port it will use, the saved token and what the public check found", async (t) => {
  const f = await fixture(t);
  const off = await shareStatus(f.options);
  assert.equal(off.ok, true);
  assert.equal(off.installed, true);
  assert.equal(off.enabled, false);
  assert.equal(off.gate.port, 8011, "the port it will use");
  assert.equal(off.gate.localUrl, "http://127.0.0.1:8011");
  assert.equal(off.tunnel.tokenSaved, false);
  assert.equal(off.tunnel.installed, true);
  assert.equal(off.publicUrl, null);
  assert.equal("publicCheck" in off, false, "the public check is opt-in");

  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  const gateToken = parseEnv(await fsp.readFile(f.envFile, "utf8")).HONCHO_GATE_TOKEN;
  const on = await shareStatus(f.options);
  assert.equal(on.enabled, true);
  assert.equal(on.gate.running, true);
  assert.equal(on.tunnel.autostart, true);
  assert.equal(on.tunnel.running, true);
  assert.equal(on.tunnel.tokenSaved, true);
  assert.equal(on.publicUrl, PUBLIC_URL);

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
  assert.equal(publicCall.options.headers.Authorization, `Bearer ${gateToken}`);
  assert.equal(publicCall.options.redirect, "manual", "an Access login redirect is seen, not followed");

  assert.equal(classifyPublicResponse({ status: 200, headers: {} }), "ok");
  assert.equal(classifyPublicResponse({ status: 401, headers: { "Cf-Access-Domain": "x" } }), "access");
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

// ------------------------------------------------------------------ Mesh

const MESH_ADDRESS = "http://100.96.3.4:8012";

test("enable --mesh needs no domain or tunnel token, opens the gate and has the supervisor run the forwarder", async (t) => {
  const f = await fixture(t, { env: {} });
  const enabled = await shareEnableMesh(f.options);
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.gateTokenCreated, true);
  assert.equal(enabled.gate.port, 8011, "8010 was busy");
  assert.equal(enabled.mesh.enabled, true);
  assert.equal(enabled.mesh.port, 8012, "the first free port from 8011 that is not the gate's");
  assert.equal(enabled.mesh.address, MESH_ADDRESS);
  assert.deepEqual(enabled.mesh.warp, { installed: true, connected: true, team: "acme-team", iface: "utun4" });
  assert.equal(enabled.mesh.splitTunnelOk, true);
  assert.equal(enabled.mesh.forwarder.running, true);
  assert.deepEqual(enabled.mesh.problems, []);
  assert.equal("warnings" in enabled, false, JSON.stringify(enabled.warnings));
  assert.match(enabled.note, /Allow all Cloudflare One traffic to reach enrolled devices/);
  assert.ok(enabled.next.includes(`--honcho-url ${MESH_ADDRESS}`));
  assert.deepEqual(enabled.host, { running: true, started: true }, "the supervisor was not running, so it was started");
  assert.equal(f.hostStarts[0].skipPrepare, true);
  assert.equal(f.hostStarts[0].installedServerDir, f.serverDirectory);

  const environment = parseEnv(await fsp.readFile(f.envFile, "utf8"));
  assert.match(environment.HONCHO_GATE_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(environment.COMPOSE_PROFILES, "debug,share");
  assert.equal(environment.HONCHO_GATE_PORT, "8011");
  const saved = JSON.parse(await fsp.readFile(f.shareFile, "utf8"));
  assert.equal(saved.tunnel, false, "the tunnel was not on");
  assert.deepEqual({ ...saved.mesh, enabledAt: undefined }, { enabled: true, port: 8012, gatePort: 8011, enabledAt: undefined, lastAddress: MESH_ADDRESS });

  assert.ok(f.calls.some((call) => call.command === "docker compose" && call.args.join(" ") === "up -d gate"));
  assert.equal(f.calls.some((call) => call.args[0] === "--version"), false, "cloudflared is not needed");
  assert.equal(f.calls.some((call) => call.command === "/bin/launchctl"), false, "no tunnel autostart");
  assert.equal(JSON.stringify(f.calls).includes(environment.HONCHO_GATE_TOKEN), false);
  assert.equal(JSON.stringify(enabled).includes(environment.HONCHO_GATE_TOKEN), false);

  // Again: the same port, so the address the other computers have keeps working.
  const again = await shareEnableMesh(f.options);
  assert.equal(again.mesh.port, 8012);
  assert.equal(again.gateTokenCreated, false);
  assert.deepEqual(again.host, { running: true, started: false });
  assert.equal(f.hostStarts.length, 1);
  assert.equal(JSON.parse(await fsp.readFile(f.shareFile, "utf8")).mesh.enabledAt, saved.mesh.enabledAt);

  assert.deepEqual(await shareSummary({ serverDirectory: f.serverDirectory }), { enabled: true, publicUrl: null, mesh: { enabled: true, port: 8012 } });
  assert.deepEqual((await serverStatus({
    profile: "portable",
    serverDirectory: f.serverDirectory,
    dockerInspector: async () => ({ installed: true, running: false }),
  })).share, { enabled: true, publicUrl: null, mesh: { enabled: true, port: 8012 } });
});

test("enable --mesh says what this computer's WARP lacks, and still turns on", async (t) => {
  const f = await fixture(t, { env: {} });
  f.state.mesh = { ...readyMesh(), splitTunnel: { ok: false, mode: "include" } };
  const include = await shareEnableMesh(f.options);
  assert.equal(include.ok, true);
  assert.deepEqual(include.mesh.problems, ["split-tunnel-include"]);
  assert.match(include.warnings[0], /Include mode without 100\.96\.0\.0\/12/);

  f.state.mesh = { warp: { installed: true, connected: false, team: "acme-team", iface: "utun4" }, ip: null, iface: "utun4", splitTunnel: { ok: false, mode: "exclude", blocking: "100.64.0.0/10" } };
  const offline = await shareEnableMesh(f.options);
  assert.equal(offline.ok, true);
  assert.equal(offline.mesh.address, null);
  assert.deepEqual(offline.mesh.problems, ["warp-disconnected", "split-tunnel-exclude"]);
  assert.match(offline.next, /Connect WARP/);
  assert.equal(JSON.parse(await fsp.readFile(f.shareFile, "utf8")).mesh.lastAddress, MESH_ADDRESS, "no address does not forget the last one");

  f.state.mesh = { warp: { installed: false, connected: false, team: "", iface: null }, ip: null, iface: null, splitTunnel: { ok: null, mode: null } };
  assert.deepEqual((await shareEnableMesh(f.options)).mesh.problems, ["warp-missing"]);
});

test("status shows both ways in and points out a changed Mesh address once", async (t) => {
  const f = await fixture(t);
  const off = await shareStatus(f.options);
  assert.equal(off.enabled, false);
  assert.equal(off.tunnel.enabled, false);
  assert.equal(off.mesh.enabled, false);
  assert.equal(off.mesh.ip, "100.96.3.4", "WARP's state is shown before Mesh is on");
  assert.deepEqual(off.mesh.problems, []);

  assert.equal((await shareEnableMesh(f.options)).ok, true);
  const mesh = await shareStatus(f.options);
  assert.equal(mesh.enabled, true);
  assert.equal(mesh.tunnel.enabled, false);
  assert.equal(mesh.mesh.enabled, true);
  assert.equal(mesh.mesh.address, MESH_ADDRESS);
  assert.equal(mesh.mesh.forwarder.running, true);
  assert.equal("warnings" in mesh, false, JSON.stringify(mesh.warnings));

  f.state.mesh.ip = "100.96.9.9";
  const moved = await shareStatus(f.options);
  assert.deepEqual(moved.mesh.addressChanged, { from: MESH_ADDRESS, to: "http://100.96.9.9:8012" });
  assert.ok(moved.mesh.problems.includes("address-changed"));
  assert.ok(moved.warnings.some((line) => line.includes(`changed from ${MESH_ADDRESS} to http://100.96.9.9:8012`)));
  const shown = await shareStatus(f.options);
  assert.equal("addressChanged" in shown.mesh, false, "said once, then it is the address");
  assert.equal(shown.mesh.lastAddress, "http://100.96.9.9:8012");

  // The tunnel too: both are on, and each is reported.
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  const both = await shareStatus(f.options);
  assert.equal(both.tunnel.enabled, true);
  assert.equal(both.mesh.enabled, true);
  assert.equal(both.publicUrl, PUBLIC_URL);
  const saved = JSON.parse(await fsp.readFile(f.shareFile, "utf8"));
  assert.equal(saved.tunnel, true);
  assert.equal(saved.mesh.enabled, true, "turning the tunnel on keeps Mesh");
});

test("status --check goes through this computer's own Mesh address, and says what only the account can open", async (t) => {
  const f = await fixture(t, { env: {} });
  assert.equal((await shareEnableMesh(f.options)).ok, true);
  const gateToken = parseEnv(await fsp.readFile(f.envFile, "utf8")).HONCHO_GATE_TOKEN;
  const checked = await shareStatus({ ...f.options, check: true });
  assert.equal(checked.mesh.check.state, "ok");
  assert.deepEqual(checked.mesh.check.local, { forwarder: true, gate: true });
  assert.match(checked.mesh.check.note, /only this computer's forwarder and gate/);
  assert.match(checked.mesh.check.note, /Networking -> Mesh/);
  assert.equal("publicCheck" in checked, false, "a server shared over Mesh only has no public address to check");
  const call = f.fetches.filter((item) => item.url === `${MESH_ADDRESS}/health`).at(-1);
  assert.equal(call.options.headers.Authorization, `Bearer ${gateToken}`);

  // macOS sends a request to its own WARP address into the tunnel: with the
  // forwarder and the gate up, that is not a failure here.
  f.setPublicAnswer((url) => {
    if (url.startsWith(MESH_ADDRESS)) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    return response(200);
  });
  const hairpin = await shareStatus({ ...f.options, check: true });
  assert.equal(hairpin.mesh.check.state, "local-only");
  assert.match(hairpin.mesh.check.detail, /Try from another computer/);
  f.setPublicAnswer(() => response(401));
  assert.equal((await shareStatus({ ...f.options, check: true })).mesh.check.state, "token");
});

test("disable --mesh keeps the gate for the tunnel, and closes it as before when the tunnel is off", async (t) => {
  const f = await fixture(t);
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  assert.equal((await shareEnableMesh(f.options)).ok, true);
  f.calls.length = 0;

  const meshOff = await shareDisable({ ...f.options, only: "mesh" });
  assert.equal(meshOff.ok, true, JSON.stringify(meshOff));
  assert.deepEqual(meshOff.mesh, { enabled: false, forwarderStopped: true });
  assert.equal(meshOff.gateKept, true);
  assert.equal(f.calls.some((call) => call.command === "docker compose"), false, "the gate stays for the tunnel");
  assert.equal(f.calls.some((call) => call.args[0] === "bootout"), false, "and so does the tunnel");
  await assert.rejects(fsp.access(f.host.forwarderFile), "the supervisor stopped the forwarder");
  assert.equal(parseEnv(await fsp.readFile(f.envFile, "utf8")).COMPOSE_PROFILES, "debug,share");
  const status = await shareStatus(f.options);
  assert.equal(status.tunnel.enabled, true);
  assert.equal(status.mesh.enabled, false);

  // Mesh on again, then the tunnel off alone.
  assert.equal((await shareEnableMesh(f.options)).ok, true);
  f.calls.length = 0;
  const tunnelOff = await shareDisable({ ...f.options, only: "tunnel" });
  assert.equal(tunnelOff.ok, true);
  assert.equal(tunnelOff.gateKept, true);
  assert.ok(f.calls.some((call) => call.command === "/bin/launchctl" && call.args[0] === "bootout"));
  assert.equal(f.calls.some((call) => call.command === "docker compose"), false);
  const meshOnly = await shareStatus(f.options);
  assert.equal(meshOnly.tunnel.enabled, false);
  assert.equal(meshOnly.mesh.enabled, true);
  assert.equal(meshOnly.enabled, true);

  // Mesh off with the tunnel off already: everything closes, as plain disable did.
  f.calls.length = 0;
  const last = await shareDisable({ ...f.options, only: "mesh" });
  assert.equal(last.ok, true);
  assert.equal(last.enabled, false);
  assert.equal(last.gateStopped, true);
  assert.deepEqual(last.mesh, { enabled: false, forwarderStopped: true });
  const lines = f.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
  assert.ok(lines.includes("docker compose stop gate"));
  assert.ok(lines.includes("docker compose rm -f gate"));
  assert.equal(parseEnv(await fsp.readFile(f.envFile, "utf8")).COMPOSE_PROFILES, "debug");
  assert.deepEqual(await shareSummary({ serverDirectory: f.serverDirectory }), { enabled: false, publicUrl: PUBLIC_URL, mesh: { enabled: false, port: 8012 } });
});

test("plain disable closes both ways in, the tunnel first", async (t) => {
  const f = await fixture(t);
  assert.equal((await shareEnable({ ...f.options, publicUrl: PUBLIC_URL })).ok, true);
  assert.equal((await shareEnableMesh(f.options)).ok, true);
  const gateToken = parseEnv(await fsp.readFile(f.envFile, "utf8")).HONCHO_GATE_TOKEN;
  f.calls.length = 0;
  const disabled = await shareDisable(f.options);
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.deepEqual(disabled.mesh, { enabled: false, forwarderStopped: true });
  const order = f.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
  assert.ok(order.findIndex((line) => line.startsWith("/bin/launchctl bootout")) < order.indexOf("docker compose stop gate"));
  const status = await shareStatus(f.options);
  assert.equal(status.enabled, false);
  assert.equal(status.tunnel.enabled, false);
  assert.equal(status.mesh.enabled, false);
  assert.equal(parseEnv(await fsp.readFile(f.envFile, "utf8")).HONCHO_GATE_TOKEN, gateToken, "the gate token is kept");

  // Mesh alone afterwards: the tunnel it closed stays closed.
  assert.equal((await shareEnableMesh(f.options)).ok, true);
  const meshOnly = await shareStatus(f.options);
  assert.equal(meshOnly.tunnel.enabled, false);
  assert.equal(meshOnly.mesh.enabled, true);
  assert.equal(meshOnly.mesh.port, 8012, "the port the other computers had");
});

test("a share.json from before Mesh still means the tunnel", async (t) => {
  const f = await fixture(t, { profiles: "share" });
  await fsp.mkdir(path.dirname(f.shareFile), { recursive: true });
  await fsp.writeFile(f.shareFile, JSON.stringify({ publicUrl: PUBLIC_URL, enabledAt: "2026-09-20T00:00:00.000Z" }));
  const before = await shareStatus(f.options);
  assert.equal(before.tunnel.enabled, true);
  assert.equal(before.mesh.enabled, false);
  assert.equal((await shareEnableMesh(f.options)).ok, true);
  const saved = JSON.parse(await fsp.readFile(f.shareFile, "utf8"));
  assert.equal(saved.tunnel, true);
  assert.equal(saved.publicUrl, PUBLIC_URL);
  const after = await shareStatus(f.options);
  assert.equal(after.tunnel.enabled, true);
  assert.equal(after.mesh.enabled, true);
});

test("enable --mesh refuses an older server, the gate's port and a taken port", async (t) => {
  const old = await fixture(t, { meshForwarder: false });
  const refused = await shareEnableMesh(old.options);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /predates Mesh sharing; run server prepare --profile personal again/);
  assert.equal(old.calls.length, 0, "nothing ran");

  const f = await fixture(t);
  assert.match((await shareEnableMesh({ ...f.options, port: 8011 })).error, /the gate's own port/);
  assert.match((await shareEnableMesh({ ...f.options, port: 80 })).error, /1024 to 65535/);
  assert.match((await shareEnableMesh({ ...f.options, port: 9000, meshPortInUse: async (port) => port === 9000 })).error, /taken by another program/);
  assert.equal(f.calls.length, 0, "nothing ran for a refused port");
  const chosen = await shareEnableMesh({ ...f.options, port: 9001 });
  assert.equal(chosen.mesh.port, 9001);
  assert.equal(chosen.mesh.address, "http://100.96.3.4:9001");
  // The port it already has is never refused as taken by its own forwarder.
  const kept = await shareEnableMesh({ ...f.options, port: 9001, meshPortInUse: async () => true });
  assert.equal(kept.ok, true, JSON.stringify(kept));
});

test("enable --mesh reports a supervisor that would not start and a host config from before Mesh", async (t) => {
  const f = await fixture(t);
  f.state.hostStart = { ok: false, running: false, issues: ["Host runtime config was not generated"] };
  const down = await shareEnableMesh({ ...f.options, meshWaitMs: 0 });
  assert.equal(down.ok, true);
  assert.deepEqual(down.host, { running: false, started: false, issues: ["Host runtime config was not generated"] });
  assert.deepEqual(down.mesh.problems, ["host-down"]);
  assert.match(down.warnings[0], /run host start/);

  const old = await fixture(t);
  await fsp.writeFile(old.host.configFile, JSON.stringify({ format: 1 }));
  const stale = await shareEnableMesh({ ...old.options, meshWaitMs: 0, sleep: async () => {} });
  assert.deepEqual(stale.mesh.problems, ["host-config-old"]);

  // The supervisor runs, but the forwarder cannot listen: something else has the port.
  const taken = await fixture(t);
  const first = await shareEnableMesh(taken.options);
  assert.equal(first.mesh.port, 8012);
  await fsp.rm(taken.host.forwarderFile);
  const blocked = await shareStatus({ ...taken.options, meshPortInUse: async (port) => port === 8012 });
  assert.deepEqual(blocked.mesh.problems, ["port-taken"]);
  assert.match(blocked.warnings[0], /--port <port>/);
  assert.deepEqual((await shareStatus(taken.options)).mesh.problems, ["forwarder-down"]);
});

test("Windows: enable --mesh adds the firewall rule behind one prompt, and says when it was declined", async (t) => {
  const f = await fixture(t, { platform: "win32", env: {} });
  const elevations = () => f.calls.filter((call) => /powershell/i.test(call.command) && call.args.at(-1).includes("runas")).length;
  f.state.firewallAnswer = { code: 1, stdout: "start-failed 1223 The operation was canceled by the user.\r\n" };
  const declined = await shareEnableMesh(f.options);
  assert.equal(declined.ok, true, JSON.stringify(declined));
  assert.deepEqual(declined.mesh.firewall, { ok: false, name: "Team Memory Mesh", cancelled: true });
  assert.ok(declined.mesh.problems.includes("firewall-missing"));
  assert.ok(declined.warnings.some((line) => /declined/.test(line)));
  assert.equal(elevations(), 1);

  f.state.firewallAnswer = null;
  const added = await shareEnableMesh(f.options);
  assert.deepEqual(added.mesh.firewall, { ok: true, name: "Team Memory Mesh", added: true });
  assert.equal(added.mesh.problems.includes("firewall-missing"), false);
  assert.equal(f.state.firewallPort, 8012);
  assert.equal(elevations(), 2);

  const again = await shareEnableMesh(f.options);
  assert.deepEqual(again.mesh.firewall, { ok: true, name: "Team Memory Mesh" });
  assert.equal(elevations(), 2, "a rule that is there is not asked for again");
  const status = await shareStatus(f.options);
  assert.equal(status.mesh.firewall.ok, true);
  f.state.firewallPort = null;
  assert.ok((await shareStatus(f.options)).mesh.problems.includes("firewall-missing"), "status sees a rule that went away");
});
