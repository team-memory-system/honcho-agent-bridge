// Opens the share gate to the owner's other computers over Cloudflare Mesh, when
// this server is shared without a domain.
//
// Every device enrolled in the same Cloudflare One account gets a stable IPv4 in
// 100.96.0.0/12 on its WARP interface, and Mesh traffic arrives on that interface.
// The gate publishes only 127.0.0.1, which Mesh cannot reach, so this listens on
// 0.0.0.0:<port> and pipes a connection to 127.0.0.1:<gate port> only when it
// arrived at a Mesh address of this computer (`socket.localAddress` in
// 100.96.0.0/12, or its IPv4-mapped IPv6 form). Every other connection - from the
// LAN, from loopback, from any other interface - is destroyed at once. Nothing
// here reads HTTP: the gate still checks the token and the paths.
//
// The host supervisor (supervisor.mjs) runs this as a child while Mesh sharing is
// on, and starts it again when it exits:
//   node mesh-forwarder.mjs --port <port> --target-port <gate port> [--state <file>]
// `--state` is written once it listens ({pid, port, targetPort, startedAt}) and
// removed on a deliberate stop, so status can tell it runs. Exit codes: 0 for a
// stop (SIGTERM, SIGINT, SIGHUP), 1 when it cannot listen. No dependencies.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MESH_CIDR = "100.96.0.0/12";
const MESH_BASE = (100 << 24 | 96 << 16) >>> 0;
const MESH_MASK = (0xffffffff << (32 - 12)) >>> 0;

function ipv4Number(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** The dotted IPv4 when `address` (plain or `::ffff:`-mapped) is in 100.96.0.0/12, else null. */
export function meshIPv4(address) {
  let text = String(address || "").trim().toLowerCase();
  if (text.startsWith("::ffff:")) text = text.slice("::ffff:".length);
  const value = ipv4Number(text);
  if (value === null || ((value & MESH_MASK) >>> 0) !== MESH_BASE) return null;
  return text;
}

export function isMeshAddress(address) {
  return meshIPv4(address) !== null;
}

/** The default test: the connection reached this computer at one of its Mesh addresses. */
export function arrivedOverMesh(socket) {
  return isMeshAddress(socket?.localAddress);
}

/**
 * One accepted connection: piped to the gate when `accept(socket)` says so,
 * destroyed at once otherwise. Returns true when it was piped.
 */
export function handleConnection(socket, {
  targetPort,
  targetHost = "127.0.0.1",
  accept = arrivedOverMesh,
  connect = net.connect,
  onEvent = () => {},
} = {}) {
  let allowed = false;
  try { allowed = accept(socket) === true; } catch { allowed = false; }
  if (!allowed) {
    onEvent("rejected", { localAddress: socket?.localAddress || "" });
    socket.destroy();
    return false;
  }
  const upstream = connect({ host: targetHost, port: targetPort });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", close);
  upstream.on("error", close);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.pipe(upstream);
  upstream.pipe(socket);
  return true;
}

/** A server, not yet listening, that hands every connection to handleConnection. */
export function createMeshForwarder(options = {}) {
  const port = Number(options.targetPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("targetPort must be a TCP port");
  const server = net.createServer((socket) => handleConnection(socket, { ...options, targetPort: port }));
  // The gate's own limits apply to each request; this only bounds open sockets.
  server.maxConnections = options.maxConnections ?? 256;
  return server;
}

// ------------------------------------------------------------------ main

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function log(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...detail })}\n`);
}

function portOption(name) {
  const value = Number(option(name));
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

function writeState(stateFile, record) {
  if (!stateFile) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  } catch (error) {
    log("mesh-forwarder-state-error", { message: String(error?.message || error) });
  }
}

function removeState(stateFile) {
  if (!stateFile) return;
  try {
    const record = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (record?.pid === process.pid) fs.rmSync(stateFile, { force: true });
  } catch {}
}

function main() {
  const port = portOption("--port");
  const targetPort = portOption("--target-port");
  const stateFile = option("--state") ? path.resolve(option("--state")) : "";
  if (!port || !targetPort || port === targetPort) {
    log("mesh-forwarder-invalid", { message: "--port and --target-port must be two different TCP ports" });
    process.exitCode = 1;
    return;
  }
  let rejected = 0;
  const server = createMeshForwarder({
    targetPort,
    onEvent: (event) => { if (event === "rejected") rejected += 1; },
  });
  server.on("error", (error) => {
    log("mesh-forwarder-error", { code: error?.code || "", message: String(error?.message || error) });
    removeState(stateFile);
    process.exit(1);
  });
  server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
    writeState(stateFile, { pid: process.pid, port, targetPort, startedAt: new Date().toISOString() });
    log("mesh-forwarder-listening", { port, targetPort });
  });
  const stop = (signal) => {
    log("mesh-forwarder-stopping", { signal, rejected });
    removeState(stateFile);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(signal));
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isMainModule()) main();
