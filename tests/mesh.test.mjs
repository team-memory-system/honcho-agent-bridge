// Cloudflare Mesh: the forwarder lets in only what arrived at a Mesh address, the
// address comes from warp-cli and the interfaces, the split tunnel and the Windows
// firewall rule are read the way they are printed, the supervisor keeps the
// forwarder up, and a computer that sends to a Mesh address is told what its WARP
// lacks. Every command goes to fakes.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  arrivedOverMesh,
  createMeshForwarder,
  handleConnection,
  isMeshAddress,
  meshIPv4 as forwarderMeshIPv4,
} from "../server/host/mesh-forwarder.mjs";
import {
  ensureWindowsFirewallRule,
  FIREWALL_RULE_NAME,
  firewallRuleCovers,
  ipv4Range,
  meshAddressFrom,
  meshClientCheck,
  meshIPv4,
  meshProblems,
  meshState,
  meshUrlAddress,
  parseSplitTunnel,
  splitTunnelReachesMesh,
  windowsFirewallAddScript,
  windowsFirewallRuleCommand,
} from "../scripts/mesh.mjs";
import { deriveHostTopology, hostStatus, resolveHostPaths } from "../scripts/host-manager.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const SUPERVISOR = path.join(ROOT, "server", "host", "supervisor.mjs");
const FORWARDER = path.join(ROOT, "server", "host", "mesh-forwarder.mjs");
const MAC_WARP = "/usr/local/bin/warp-cli";

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

async function readJsonFile(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// `warp-cli settings` as the client prints it (2026.4), with this repository's own
// example names in place of a real team's.
function settingsText(mode, entries) {
  return [
    "Merged configuration:",
    "(network policy)\tMode: WarpWithDnsOverHttps",
    "(network policy)\tWARP tunnel protocol: MASQUE",
    "(not set)\tMASQUE Protocol Settings: ",
    "  HTTP Version: MASQUE (HTTP/3 with HTTP/2 fallback)",
    `(network policy)\t${mode} mode, with hosts/ips:`,
    ...entries.map((entry) => `  ${entry}`),
    "(network policy)\tFallback domains:",
    "  home.arpa",
    "  intranet",
    "(user set)\tOrganization: acme-team",
    "",
  ].join("\n");
}

const INCLUDE_WITHOUT_MESH = settingsText("Include", [
  "172.64.128.0/20 (Cloudflare One Token CIDR)",
  "2606:4700:cf1::/48 (Cloudflare One CIDR)",
  "memory.example.com",
  "acme-team.cloudflareaccess.com",
]);
const INCLUDE_WITH_MESH = settingsText("Include", [
  "172.64.128.0/20 (Cloudflare One Token CIDR)",
  "100.96.0.0/12 (Mesh)",
  "memory.example.com",
]);
const EXCLUDE_DEFAULT = settingsText("Exclude", [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fd00::/8",
]);
const EXCLUDE_WITHOUT_CGNAT = settingsText("Exclude", ["10.0.0.0/8", "169.254.0.0/16", "192.168.0.0/16"]);

const INTERFACES = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.0.9", family: "IPv4", internal: false }],
  utun0: [
    { address: "100.96.0.1", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
};

function fakeWarp({ connected = true, team = "acme-team", iface = "utun0", settings = INCLUDE_WITH_MESH, network = true } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const line = args.join(" ");
    if (line === "-j status") return { code: 0, stdout: JSON.stringify({ status: connected ? "Connected" : "Disconnected", reason: "x" }) };
    if (line === "-j registration show") {
      return team
        ? { code: 0, stdout: JSON.stringify({ id: "secret-id", device_id: "secret-device", account: { type: "team", id: "secret-account", organization: team } }) }
        : { code: 0, stdout: JSON.stringify({ id: "secret-id", account: { type: "free" } }) };
    }
    if (line === "-j debug network") {
      return network
        ? { code: 0, stdout: JSON.stringify({ v4_iface: { name: "en0", address: "192.168.0.9" }, tunnel_iface: { index: 28, name: iface } }) }
        : { code: 1, stdout: "", stderr: "unrecognized subcommand" };
    }
    if (line === "settings") return { code: 0, stdout: settings };
    return { code: 0, stdout: "" };
  };
  return { run, calls, which: (tool) => (tool === "warp-cli" ? MAC_WARP : null), platform: "darwin", env: {}, interfaces: () => INTERFACES };
}

// ------------------------------------------------------------------ forwarder

test("a Mesh address is 100.96.0.0/12, plain or IPv4-mapped, and nothing else", () => {
  for (const check of [forwarderMeshIPv4, meshIPv4]) {
    assert.equal(check("100.96.0.1"), "100.96.0.1");
    assert.equal(check("100.111.255.254"), "100.111.255.254");
    assert.equal(check("::ffff:100.96.3.4"), "100.96.3.4");
    assert.equal(check("::FFFF:100.100.1.1"), "100.100.1.1");
    for (const other of ["100.95.255.255", "100.112.0.0", "100.64.0.1", "127.0.0.1", "::ffff:127.0.0.1", "192.168.0.9", "::1", "fe80::1", "", null, "100.96.0", "100.96.0.256", "x100.96.0.1"]) {
      assert.equal(check(other), null, String(other));
    }
  }
  assert.equal(isMeshAddress("::ffff:100.96.0.9"), true);
  assert.equal(arrivedOverMesh({ localAddress: "100.96.0.9" }), true);
  assert.equal(arrivedOverMesh({ localAddress: "::ffff:100.96.0.9" }), true, "a dual-stack listener reports the mapped form");
  assert.equal(arrivedOverMesh({ localAddress: "127.0.0.1" }), false);
  assert.equal(arrivedOverMesh({ localAddress: "192.168.0.9" }), false, "the LAN is not let in");
  assert.equal(arrivedOverMesh({}), false);
  assert.deepEqual(ipv4Range("100.96.0.0/12"), [1684013056, 1684013056 + 2 ** 20 - 1]);
  assert.equal(meshUrlAddress("http://100.96.0.1:8011"), "100.96.0.1");
  assert.equal(meshUrlAddress("https://100.96.0.1:8011"), null, "only the http address the forwarder serves");
  assert.equal(meshUrlAddress("http://127.0.0.1:8001"), null);
});

class FakeSocket extends EventEmitter {
  constructor(localAddress) {
    super();
    this.localAddress = localAddress;
    this.destroyed = false;
    this.piped = [];
  }
  destroy() { this.destroyed = true; }
  pipe(target) { this.piped.push(target); return target; }
}

test("a connection is piped to the gate only when it arrived at a Mesh address", () => {
  for (const localAddress of ["100.96.0.1", "::ffff:100.96.0.1"]) {
    const socket = new FakeSocket(localAddress);
    const opened = [];
    const upstream = new FakeSocket("127.0.0.1");
    const piped = handleConnection(socket, { targetPort: 8010, connect: (options) => { opened.push(options); return upstream; } });
    assert.equal(piped, true, localAddress);
    assert.deepEqual(opened, [{ host: "127.0.0.1", port: 8010 }]);
    assert.deepEqual(socket.piped, [upstream]);
    assert.deepEqual(upstream.piped, [socket]);
    assert.equal(socket.destroyed, false);
    // Either side going away takes the other with it.
    upstream.emit("close");
    assert.equal(socket.destroyed, true);
  }
  for (const localAddress of ["127.0.0.1", "::1", "192.168.0.9", "::ffff:10.0.0.2", "100.64.0.1", undefined]) {
    const socket = new FakeSocket(localAddress);
    const events = [];
    let opened = false;
    const piped = handleConnection(socket, { targetPort: 8010, connect: () => { opened = true; }, onEvent: (event) => events.push(event) });
    assert.equal(piped, false, String(localAddress));
    assert.equal(opened, false, "nothing reaches the gate");
    assert.equal(socket.destroyed, true, "destroyed at once");
    assert.deepEqual(events, ["rejected"]);
  }
  // A predicate that throws refuses.
  const socket = new FakeSocket("100.96.0.1");
  assert.equal(handleConnection(socket, { targetPort: 8010, accept: () => { throw new Error("x"); }, connect: () => assert.fail("not opened") }), false);
  assert.throws(() => createMeshForwarder({ targetPort: 0 }), /TCP port/);
});

async function startTarget(t) {
  const seen = [];
  const target = http.createServer((request, response) => {
    seen.push(request.url);
    response.end("gate answered");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => target.close(() => resolve())));
  return { port: target.address().port, seen };
}

function get(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: "/health", timeout: 3_000, agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", (error) => resolve({ error: error.code || error.message }));
    request.on("timeout", () => { request.destroy(); resolve({ error: "timeout" }); });
  });
}

test("the forwarder refuses loopback by default and pipes bytes as they are when let in", async (t) => {
  const target = await startTarget(t);
  const listen = async (options) => {
    const server = createMeshForwarder({ targetPort: target.port, ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(() => resolve())));
    return server.address().port;
  };
  const refusing = await listen({});
  const refused = await get(refusing);
  assert.ok(refused.error, JSON.stringify(refused));
  assert.deepEqual(target.seen, [], "a loopback connection never reaches the gate");

  // The local address is all that decides, so a test predicate stands in for WARP.
  const seenBy = [];
  const letIn = await listen({ accept: (socket) => { seenBy.push(socket.localAddress); return true; } });
  const answered = await get(letIn);
  assert.deepEqual(answered, { status: 200, body: "gate answered" });
  assert.deepEqual(target.seen, ["/health"]);
  assert.ok(["127.0.0.1", "::ffff:127.0.0.1"].includes(seenBy[0]));
});

test("the forwarder program listens, writes its state, and removes it when stopped", async (t) => {
  const target = await startTarget(t);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-forwarder-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const port = await freePort();
  const stateFile = path.join(root, "mesh-forwarder.json");
  const child = spawn(process.execPath, [FORWARDER, "--port", String(port), "--target-port", String(target.port), "--state", stateFile], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  assert.equal(await waitUntil(async () => Boolean(await readJsonFile(stateFile))), true, output);
  const record = await readJsonFile(stateFile);
  assert.equal(record.pid, child.pid);
  assert.equal(record.port, port);
  assert.equal(record.targetPort, target.port);
  assert.ok((await get(port)).error, "loopback is refused by the real program too");
  assert.deepEqual(target.seen, []);
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
    await assert.rejects(fsp.access(stateFile), "a stopped forwarder leaves no state behind");
  }
  assert.match(output, /mesh-forwarder-listening/);

  const invalid = await execFileAsync(process.execPath, [FORWARDER, "--port", "8011", "--target-port", "8011"]).catch((error) => error);
  assert.equal(invalid.code, 1);
  assert.match(String(invalid.stdout), /mesh-forwarder-invalid/);
});

// ------------------------------------------------------------------ address

test("the Mesh address is the 100.96.0.0/12 IPv4 of the interface warp-cli names", () => {
  const network = { v4_iface: { name: "en0" }, tunnel_iface: { index: 28, name: "utun0" } };
  assert.deepEqual(meshAddressFrom({ network, interfaces: INTERFACES }), { ip: "100.96.0.1", iface: "utun0", source: "warp-cli" });
  // Windows names the adapter; Node 18.0-18.3 reported the family as a number.
  assert.deepEqual(
    meshAddressFrom({ network: { tunnel_iface: { name: "CloudflareWARP" } }, interfaces: { CloudflareWARP: [{ address: "100.96.7.8", family: 4, internal: false }] } }),
    { ip: "100.96.7.8", iface: "CloudflareWARP", source: "warp-cli" },
  );
  // A WARP interface without a Mesh address (no virtual IP for this account) has none,
  // even when another overlay holds an address in the same range.
  const tailscale = { ...INTERFACES, utun0: [{ address: "172.16.0.2", family: "IPv4" }], utun3: [{ address: "100.101.2.3", family: "IPv4" }] };
  assert.deepEqual(meshAddressFrom({ network, interfaces: tailscale }), { ip: null, iface: "utun0", source: "warp-cli" });
  // An older warp-cli names no interface: the interfaces are searched.
  assert.deepEqual(meshAddressFrom({ network: null, interfaces: INTERFACES }), { ip: "100.96.0.1", iface: "utun0", source: "interfaces" });
  assert.deepEqual(meshAddressFrom({ network: null, interfaces: { en0: INTERFACES.en0 } }), { ip: null, iface: null, source: null });
});

test("meshState reads warp-cli and the interfaces, and never passes on an identifier", async () => {
  const warp = fakeWarp();
  const found = await meshState(warp);
  assert.deepEqual(found.warp, { installed: true, connected: true, team: "acme-team", iface: "utun0" });
  assert.equal(found.ip, "100.96.0.1");
  assert.deepEqual(warp.calls.sort(), [
    `${MAC_WARP} -j debug network`,
    `${MAC_WARP} -j registration show`,
    `${MAC_WARP} -j status`,
    `${MAC_WARP} settings`,
  ]);
  const state = await meshState(fakeWarp({ settings: INCLUDE_WITHOUT_MESH }));
  assert.deepEqual(state.splitTunnel, { ok: false, mode: "include" });
  assert.equal(JSON.stringify(state).includes("secret"), false);

  // An address on a WARP that is not connected reaches nothing.
  const disconnected = await meshState(fakeWarp({ connected: false }));
  assert.deepEqual([disconnected.ip, disconnected.iface, disconnected.warp.connected], [null, "utun0", false]);
  // Without a team there is no Mesh address on the WARP interface.
  const teamless = await meshState(fakeWarp({ team: "", iface: "utun9" }));
  assert.deepEqual([teamless.ip, teamless.warp.team], [null, ""]);
  const missing = await meshState({ platform: "darwin", env: {}, which: () => null, fileExists: () => false, run: async () => assert.fail("nothing to run") });
  assert.deepEqual(missing.warp, { installed: false, connected: false, team: "", iface: null });
  assert.equal(missing.ip, null);
});

test("the split tunnel is read from warp-cli settings: Include needs 100.96.0.0/12, Exclude must not cover it", () => {
  const include = parseSplitTunnel(INCLUDE_WITHOUT_MESH);
  assert.deepEqual(include, { mode: "include", entries: ["172.64.128.0/20", "2606:4700:cf1::/48", "memory.example.com", "acme-team.cloudflareaccess.com"] });
  assert.deepEqual(splitTunnelReachesMesh(include), { ok: false, mode: "include" });
  assert.deepEqual(splitTunnelReachesMesh(parseSplitTunnel(INCLUDE_WITH_MESH)), { ok: true, mode: "include" });
  // A wider range that holds all of it is enough; a part of it is not.
  assert.equal(splitTunnelReachesMesh(parseSplitTunnel(settingsText("Include", ["100.64.0.0/10"]))).ok, true);
  assert.equal(splitTunnelReachesMesh(parseSplitTunnel(settingsText("Include", ["100.96.0.0/16"]))).ok, false);

  assert.deepEqual(splitTunnelReachesMesh(parseSplitTunnel(EXCLUDE_DEFAULT)), { ok: false, mode: "exclude", blocking: "100.64.0.0/10" });
  assert.deepEqual(splitTunnelReachesMesh(parseSplitTunnel(EXCLUDE_WITHOUT_CGNAT)), { ok: true, mode: "exclude" });
  assert.equal(splitTunnelReachesMesh(parseSplitTunnel(settingsText("Exclude", ["100.100.0.1"]))).ok, false, "one address inside is in the way too");
  assert.deepEqual(splitTunnelReachesMesh(parseSplitTunnel("Merged configuration:\n(default)\tAlways On: true\n")), { ok: null, mode: null });
  assert.deepEqual(parseSplitTunnel(settingsText("Exclude", [])), { mode: "exclude", entries: [] });
});

test("what keeps Mesh from this computer is named, server side and client side", () => {
  const ready = { warp: { installed: true, connected: true, team: "acme-team" }, ip: "100.96.0.1", splitTunnel: { ok: true, mode: "include" } };
  assert.deepEqual(meshProblems(ready), []);
  const codes = (state, role) => meshProblems(state, { role }).map((item) => item.code);
  assert.deepEqual(codes({ warp: { installed: false } }), ["warp-missing"]);
  assert.deepEqual(codes({ ...ready, warp: { installed: true, team: "" } }), ["warp-not-team"]);
  assert.deepEqual(codes({ ...ready, warp: { installed: true, team: "t", connected: false }, ip: null }), ["warp-disconnected"]);
  assert.deepEqual(codes({ ...ready, ip: null }), ["no-mesh-ip"]);
  assert.deepEqual(codes({ ...ready, ip: null }, "client"), [], "a sender needs no address of its own");
  assert.deepEqual(codes({ ...ready, splitTunnel: { ok: false, mode: "include" } }), ["split-tunnel-include"]);
  const exclude = meshProblems({ ...ready, splitTunnel: { ok: false, mode: "exclude", blocking: "100.64.0.0/10" } });
  assert.equal(exclude[0].code, "split-tunnel-exclude");
  assert.match(exclude[0].message, /100\.64\.0\.0\/10/);
});

test("meshClientCheck answers only for an http Mesh address", async () => {
  assert.equal(await meshClientCheck("http://127.0.0.1:8001", { run: async () => assert.fail("no warp-cli for a local server") }), null);
  assert.equal(await meshClientCheck("https://memory.example.com", { run: async () => assert.fail("nor for a public one") }), null);
  const check = await meshClientCheck("http://100.96.0.9:8011", fakeWarp({ settings: EXCLUDE_DEFAULT }));
  assert.equal(check.ip, "100.96.0.9");
  assert.equal(check.splitTunnelOk, false);
  assert.deepEqual(check.problems.map((item) => item.code), ["split-tunnel-exclude"]);
});

// ------------------------------------------------------------- Windows firewall

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("the Windows firewall rule is added through one elevated PowerShell, only when missing", async () => {
  assert.equal(
    windowsFirewallRuleCommand(8011).split("; ").at(-1),
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Direction Inbound -Protocol TCP -LocalPort 8011 -RemoteAddress 100.96.0.0/12 -Action Allow | Out-Null`,
  );
  assert.throws(() => windowsFirewallRuleCommand("8011; Remove-Item"), /TCP port/);
  const script = windowsFirewallAddScript(8011, { SystemRoot: "C:\\Windows" });
  assert.match(script, /\$i\.Verb = 'runas'/);
  assert.match(script, /\$i\.FileName = 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe'/);
  assert.ok(script.includes("-Command \"$ErrorActionPreference = ''Stop''; Get-NetFirewallRule -DisplayName ''Team Memory Mesh'' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName ''Team Memory Mesh'' -Direction Inbound -Protocol TCP -LocalPort 8011 -RemoteAddress 100.96.0.0/12 -Action Allow | Out-Null\""),
    "the rule reaches the elevated PowerShell quoted once for the outer one");
  assert.match(script, /\[System\.Diagnostics\.Process\]::Start\(\$i\)/);
  assert.match(script, /NativeErrorCode/);

  // Windows prints the CIDR back as a mask.
  assert.equal(firewallRuleCovers("rule TCP 8011 100.96.0.0/255.240.0.0\r\n", 8011), true);
  assert.equal(firewallRuleCovers("rule TCP 8011 100.96.0.0/12", 8011), true);
  assert.equal(firewallRuleCovers("rule TCP 8012 100.96.0.0/12", 8011), false, "a rule for an older port does not count");
  assert.equal(firewallRuleCovers("rule UDP 8011 100.96.0.0/12", 8011), false);
  assert.equal(firewallRuleCovers("rule TCP 8011 Any", 8011), false);

  const run = (answers) => {
    const calls = [];
    return {
      calls,
      run: async (command, args) => {
        const script = args.at(-1);
        calls.push({ command, kind: script.includes("runas") ? "elevate" : "check" });
        return answers.shift() || { code: 0, stdout: "" };
      },
    };
  };
  const base = { port: 8011, env: { SystemRoot: "C:\\Windows" }, platform: "win32" };
  const present = run([{ code: 0, stdout: "rule TCP 8011 100.96.0.0/255.240.0.0\n" }]);
  assert.deepEqual(await ensureWindowsFirewallRule({ ...base, run: present.run }), { ok: true, changed: false, name: FIREWALL_RULE_NAME, port: 8011 });
  assert.deepEqual(present.calls.map((call) => call.kind), ["check"], "no prompt when the rule is there");
  assert.equal(present.calls[0].command, POWERSHELL);

  const added = run([{ code: 0, stdout: "" }, { code: 0, stdout: "" }]);
  assert.deepEqual(await ensureWindowsFirewallRule({ ...base, run: added.run }), { ok: true, changed: true, name: FIREWALL_RULE_NAME, port: 8011 });
  assert.deepEqual(added.calls.map((call) => call.kind), ["check", "elevate"]);

  const declined = run([{ code: 0, stdout: "" }, { code: 1, stdout: "start-failed 1223 The operation was canceled by the user.\r\n" }]);
  assert.deepEqual(await ensureWindowsFirewallRule({ ...base, run: declined.run }), { ok: false, changed: false, cancelled: true, name: FIREWALL_RULE_NAME, port: 8011 });
  const failed = run([{ code: 0, stdout: "" }, { code: 1, stdout: "" }]);
  assert.match((await ensureWindowsFirewallRule({ ...base, run: failed.run })).error, /exit 1/);
});

// ------------------------------------------------------------------ supervisor

test("the host config names the Mesh files, and host status reports the forwarder", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-mesh-host-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDir = path.join(root, "app", "server");
  const paths = resolveHostPaths({ installedServerDir: serverDir, platform: "darwin", env: {}, homeDir: root });
  assert.equal(paths.meshForwarderFile, path.join(serverDir, "host", "mesh-forwarder.mjs"));
  assert.equal(paths.shareStateFile, path.join(root, "app", "runtime", "share.json"), "the file share-manager writes");
  assert.equal(paths.meshStateFile, path.join(root, "app", "runtime", "host", "mesh-forwarder.json"));
  const topology = deriveHostTopology({ environment: {}, paths: { ...paths, homeDir: root, env: {} }, platform: "darwin" });
  assert.deepEqual(topology.mesh, { shareStateFile: paths.shareStateFile, forwarderFile: paths.meshForwarderFile, stateFile: paths.meshStateFile });

  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(paths.configFile, JSON.stringify({
    format: 1,
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434", model: "unused" },
    state: { configFile: paths.configFile, pidFile: paths.pidFile, logDir: paths.logDir },
    supervisorFile: paths.supervisorFile,
    mesh: topology.mesh,
  }));
  await fsp.writeFile(paths.shareStateFile, JSON.stringify({ mesh: { enabled: true, port: 8012, gatePort: 8011 } }));
  await fsp.writeFile(paths.meshStateFile, JSON.stringify({ pid: process.pid, port: 8012, targetPort: 8011 }));
  const options = {
    installedServerDir: serverDir,
    platform: "darwin",
    env: {},
    homeDir: root,
    gatewayRunner: async () => ({ code: 1, stdout: "", stderr: "" }),
    autostartRunner: async () => ({ code: 113, stdout: "", stderr: "not found" }),
    fetchImpl: async () => { throw new Error("offline"); },
  };
  const status = await hostStatus(options);
  assert.deepEqual(status.mesh, { enabled: true, port: 8012, running: true, pid: process.pid, supported: true });
  await fsp.writeFile(paths.meshStateFile, JSON.stringify({ pid: process.pid, port: 9999 }));
  assert.equal((await hostStatus(options)).mesh.running, false, "a forwarder on another port is not this one");
});

test("the supervisor runs the forwarder while Mesh is on, restarts it when it dies, and stops it when Mesh goes off", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-supervisor-mesh-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  await fsp.mkdir(state, { recursive: true });
  const configFile = path.join(state, "host-config.json");
  const pidFile = path.join(state, "pid.json");
  const shareStateFile = path.join(root, "share.json");
  const stateFile = path.join(state, "mesh-forwarder.json");
  const port = await freePort();
  await fsp.writeFile(shareStateFile, JSON.stringify({ mesh: { enabled: true, port, gatePort: 8010 } }));
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    profile: "personal",
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434" },
    state: { configFile, pidFile, logDir: path.join(state, "logs") },
    supervisorFile: SUPERVISOR,
    mesh: { shareStateFile, forwarderFile: FORWARDER, stateFile, checkIntervalMs: 100 },
  }));
  const child = spawn(process.execPath, [SUPERVISOR, "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    const record = await readJsonFile(stateFile);
    if (record?.pid && processAlive(record.pid)) process.kill(record.pid, "SIGKILL");
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  assert.equal(await waitUntil(async () => (await readJsonFile(stateFile))?.port === port), true, output);
  const first = await readJsonFile(stateFile);
  assert.ok(processAlive(first.pid));
  assert.equal(first.targetPort, 8010);

  process.kill(first.pid, "SIGKILL");
  assert.equal(await waitUntil(async () => {
    const record = await readJsonFile(stateFile);
    return Boolean(record && record.pid !== first.pid && processAlive(record.pid));
  }), true, `restarted after it died: ${output}`);
  assert.match(output, /mesh-forwarder-exited/);
  const second = await readJsonFile(stateFile);

  await fsp.writeFile(shareStateFile, JSON.stringify({ mesh: { enabled: false, port, gatePort: 8010 } }));
  assert.equal(await waitUntil(() => !processAlive(second.pid)), true, `stopped when Mesh went off: ${output}`);
  assert.equal(await waitUntil(async () => !(await readJsonFile(stateFile))), true, "and its state went with it");
  assert.match(output, /mesh-forwarder-stop/);

  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
    await assert.rejects(fsp.access(pidFile));
  }
});

test("a mesh section with a relative path turns off only the forwarder", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-supervisor-badmesh-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "host-config.json");
  await fsp.writeFile(configFile, JSON.stringify({
    format: 1,
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434" },
    state: { configFile, pidFile: path.join(root, "pid.json"), logDir: path.join(root, "logs") },
    supervisorFile: SUPERVISOR,
    mesh: { shareStateFile: "share.json", forwarderFile: FORWARDER, stateFile: path.join(root, "f.json") },
  }));
  // With no Ollama and no usable mesh section there is nothing to keep, so it exits by itself.
  const { stdout } = await execFileAsync(process.execPath, [SUPERVISOR, "--config", configFile], { timeout: 5_000 });
  assert.match(stdout, /mesh-config-invalid/);
  assert.match(stdout, /supervisor-started/, "the supervisor itself still started");
});

// ------------------------------------------------------------------ client side

async function fakeWarpCli(root, { settings = INCLUDE_WITHOUT_MESH } = {}) {
  const bin = path.join(root, "bin");
  await fsp.mkdir(bin, { recursive: true });
  const settingsFile = path.join(root, "warp-settings.txt");
  await fsp.writeFile(settingsFile, settings);
  const log = path.join(root, "warp-cli.log");
  await fsp.writeFile(path.join(bin, "warp-cli"), [
    "#!/bin/sh",
    `echo "$*" >> '${log}'`,
    "case \"$*\" in",
    "  \"-j status\") echo '{\"status\":\"Connected\",\"reason\":\"x\"}' ;;",
    "  \"-j registration show\") echo '{\"account\":{\"type\":\"team\",\"organization\":\"acme-team\"}}' ;;",
    "  \"-j debug network\") echo '{\"tunnel_iface\":{\"index\":9,\"name\":\"utun-test\"}}' ;;",
    `  "settings") cat '${settingsFile}' ;;`,
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  return { bin, log };
}

async function runCli(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 60_000 });
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(String(error.stdout || "{}"));
  }
}

test("setup plan and doctor say what this computer's WARP lacks for a Mesh address", { skip: process.platform === "win32" && "the fake warp-cli is a shell script" }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-mesh-client-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const appHome = path.join(root, "app");
  const home = path.join(root, "user");
  const warp = await fakeWarpCli(root);
  const env = {
    HONCHO_AGENT_BRIDGE_HOME: appHome,
    HONCHO_AGENT_BRIDGE_USER_HOME: home,
    HOME: home,
    USERPROFILE: home,
    HONCHO_API_TOKEN: "",
    PATH: `${warp.bin}${path.delimiter}${process.env.PATH}`,
  };
  // Nothing listens there: the address is in the Mesh range and nothing routes it
  // here. An unanswered connect keeps each CLI alive for its full connect timeout,
  // so the plan and doctor run side by side.
  // Doctor gets its own app home, so the plan's detect does not probe the address too.
  const url = "http://100.111.255.254:8011";
  const doctorHome = path.join(root, "doctor-app");
  await fsp.mkdir(doctorHome, { recursive: true });
  await fsp.writeFile(path.join(doctorHome, "config.json"), JSON.stringify({
    version: 1,
    user: { peerId: "user_test" },
    honcho: { baseUrl: url, workspaceId: "memory" },
    agents: { claude: true },
  }));
  const [plan, doctor] = await Promise.all([
    runCli(["setup", "plan", "--agents", "claude", "--user-peer", "user_test", "--honcho-url", url], env),
    runCli(["doctor"], { ...env, HONCHO_AGENT_BRIDGE_HOME: doctorHome }),
  ]);
  const meshWarnings = plan.warnings.filter((line) => line.includes("Cloudflare Mesh address"));
  assert.equal(meshWarnings.length, 1, JSON.stringify(plan.warnings));
  assert.match(meshWarnings[0], /Include mode without 100\.96\.0\.0\/12/);

  const health = doctor.checks.find((check) => check.name === "honcho-health");
  assert.equal(health.ok, false);
  assert.ok(health.error, JSON.stringify(health));
  assert.deepEqual(health.mesh.problems, ["split-tunnel-include"]);
  assert.match(health.hints[0], /Include mode without 100\.96\.0\.0\/12/);

  // Any other address: no Mesh warning, and warp-cli is not asked.
  await fsp.rm(warp.log, { force: true });
  const local = await runCli(["setup", "plan", "--agents", "claude", "--user-peer", "user_test", "--honcho-url", "http://127.0.0.1:9"], env);
  assert.equal(local.warnings.some((line) => line.includes("Mesh")), false);
  await assert.rejects(fsp.access(warp.log), "warp-cli is not asked about any other address");
});

test("server share takes --mesh and --tunnel as flags only", async () => {
  const env = { HONCHO_AGENT_BRIDGE_SERVER_DIR: path.join(os.tmpdir(), "honcho-agent-bridge-no-such-server") };
  const help = await runCli(["help"], env);
  assert.ok(help.usage.some((line) => line.startsWith("server share enable --mesh")));
  assert.match((await runCli(["server", "share", "enable", "--mesh", "--public-url", "https://memory.example.com"], env)).error, /--mesh needs no --public-url/);
  assert.match((await runCli(["server", "share", "enable", "--mesh=yes"], env)).error, /--mesh takes no value/);
  assert.match((await runCli(["server", "share", "enable", "--mesh", "--port", "80a"], env)).error, /--port takes a TCP port/);
  assert.match((await runCli(["server", "share", "enable", "--mesh", "--port", "80"], env)).error, /--port takes a TCP port/);
  assert.match((await runCli(["server", "share", "disable", "--mesh", "--tunnel"], env)).error, /each close one way in/);
  assert.match((await runCli(["server", "share", "enable", "--mesh"], env)).error, /No personal memory server/);
});
