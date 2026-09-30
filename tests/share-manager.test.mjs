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

async function fixture(t, { platform = "darwin", profiles = "debug", env = { HONCHO_TUNNEL_TOKEN: TUNNEL_TOKEN }, binary = "present" } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-share-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "app", "server");
  await fsp.mkdir(path.join(serverDirectory, "gate"), { recursive: true });
  await fsp.writeFile(path.join(serverDirectory, "compose.yaml"), "name: honcho-agent-bridge\n");
  await fsp.writeFile(path.join(serverDirectory, "gate", "gate.mjs"), "// gate\n");
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
  const state = { launchdLoaded: false, windowsRunning: false, versionOk: true };
  const run = async (command, args) => {
    calls.push({ command, args });
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
    sleep: async () => {},
    portInUse: async (port) => port === 8010,
    gateWaitMs: 0,
  };
  return {
    root,
    home,
    serverDirectory,
    envFile: path.join(serverDirectory, ".env"),
    tokenFile: path.join(runtime, "tunnel-token"),
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
