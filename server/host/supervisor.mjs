// Keeps the personal profile's embedding model resident in Ollama.
//
// `host start` registers a per-user login autostart for this (launchd, the HKCU
// Run key or systemd --user; see host-manager.mjs) and starts it; every copy finds
// the running one through the PID file, and a second copy exits 0 at once. It
// starts `ollama serve` when nothing answers on the configured address - at start,
// and again on every service check (`serviceCheckIntervalMs`, 15 s by default) -
// and warms the Qwen3 alias on an interval so an embedding after an idle stretch
// does not wait for a model load. The subscription gateway is not supervised here:
// it has its own lifecycle and registers its own autostart.
//
// At login this can start before Ollama's own app or service, and before Docker;
// it never exits for that. It does not use Docker at all. An Ollama this app did
// not download gets `startupGraceMs` (60 s) to come up by itself before this starts
// `ollama serve`, and a failed warmup is retried with backoff (`warmRetryMs`, 5 s, doubling, up to
// the warm interval) instead of waiting out the whole interval.
//
// Exit codes are what the autostarts restart on: 0 for a deliberate stop (SIGTERM,
// SIGINT, SIGHUP), for "another supervisor already runs", and for a missing or
// invalid config, which no restart can fix; 1 for a crash. launchd's KeepAlive
// {SuccessfulExit: false} and systemd's Restart=on-failure restart only the 1.
//
// `--log <file>` appends the JSON log lines to that file (owner-only, rotated to
// <file>.1 past 10 MB) instead of stdout.
//
// Mesh sharing (share-manager.mjs, `server share enable --mesh`): when the config
// names `mesh` files, this reads the share state file (`mesh.shareStateFile`)
// every `mesh.checkIntervalMs` (2 s by default) and, while it says
// `mesh.enabled` with a port and the gate's port, runs mesh-forwarder.mjs as a
// child with them. A forwarder that exits is started again with backoff (1 s,
// doubling, up to 60 s); turning Mesh off, or a change of port, stops it. It
// runs whether or not Ollama is managed.
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

let stopping = false;
let ollamaChild = null;
let meshChild = null;
const timers = new Set();

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function sanitize(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|hch)-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch { return "[redacted-url]"; }
    })
    .slice(0, 2_000);
}

const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const logFile = option("--log") ? path.resolve(option("--log")) : "";
let logBytes = -1;

function writeLogLine(line) {
  if (!logFile) {
    process.stdout.write(line);
    return;
  }
  try {
    if (logBytes < 0) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      try { logBytes = fs.statSync(logFile).size; } catch { logBytes = 0; }
    }
    if (logBytes > 0 && logBytes + line.length > LOG_LIMIT_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
      logBytes = 0;
    }
    fs.appendFileSync(logFile, line, { mode: 0o600 });
    logBytes += Buffer.byteLength(line);
  } catch {
    // A log that cannot be written never stops the supervisor.
  }
}

function log(event, detail = {}) {
  const clean = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, typeof value === "string" ? sanitize(value) : value]));
  writeLogLine(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...clean })}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readJson(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

function validateConfig(config, configFile) {
  if (!config || config.format !== 1) throw new Error("Unsupported host runtime config");
  for (const target of [config?.state?.pidFile, config?.supervisorFile]) {
    if (!target || !path.isAbsolute(target)) throw new Error("Host runtime config contains an invalid path");
  }
  if (config.mesh) {
    // A bad mesh section turns only the forwarder off, never the Ollama keep-alive.
    const targets = [config.mesh.shareStateFile, config.mesh.forwarderFile, config.mesh.stateFile];
    if (!targets.every((target) => typeof target === "string" && path.isAbsolute(target))) {
      log("mesh-config-invalid", { message: "Host runtime config contains an invalid mesh path" });
      delete config.mesh;
    }
  }
  if (config.ollama?.baseUrl) {
    const url = new URL(config.ollama.baseUrl);
    if (url.username || url.password || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("Managed host services must use a credential-free loopback URL");
    }
  }
  config.state.configFile = path.resolve(config.state.configFile || configFile);
  return config;
}

async function acquirePid(config) {
  await fsp.mkdir(path.dirname(config.state.pidFile), { recursive: true });
  const previous = await readJson(config.state.pidFile);
  if (previous && processAlive(previous.pid)) return { acquired: false, owner: previous.pid };
  await fsp.rm(config.state.pidFile, { force: true });
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    configFile: config.state.configFile,
    supervisorFile: config.supervisorFile,
  };
  try {
    const handle = await fsp.open(config.state.pidFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.close();
    return { acquired: true, record };
  } catch (error) {
    if (error?.code === "EEXIST") {
      const owner = await readJson(config.state.pidFile);
      return { acquired: false, owner: owner?.pid || null };
    }
    throw error;
  }
}

function safeEnvironment(extra = {}) {
  const names = new Set([
    "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "LANG", "LC_ALL", "TZ",
  ]);
  const output = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (names.has(key) || /^(?:OLLAMA|CUDA|HIP|ROCM|HSA|GGML)_/i.test(key)) output[key] = value;
  }
  return { ...output, ...extra };
}

function pipeLines(stream, source) {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) if (line.trim()) log("child-output", { source, message: line });
    if (pending.length > 16_384) {
      log("child-output", { source, message: pending.slice(0, 16_384) });
      pending = "";
    }
  });
}

async function request(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status };
  } catch (error) { return { ok: false, error: error?.message || String(error) }; }
  finally { clearTimeout(timer); }
}

async function embeddingRequest(config, input, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.ollama.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.ollama.model,
        input,
        dimensions: config.ollama.dimensions,
        keep_alive: config.ollama.keepAlive,
        truncate: false,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    const vector = data?.embeddings?.[0];
    return {
      ok: response.ok && Array.isArray(vector) && vector.length === config.ollama.dimensions,
      status: response.status,
      dimensions: Array.isArray(vector) ? vector.length : null,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), dimensions: null };
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaHealthy(config) {
  return (await request(`${config.ollama.baseUrl}/api/version`, {}, 2_000)).ok;
}

function startOllama(config) {
  if (stopping || ollamaChild || !config.ollama.manageService) return;
  let child;
  try {
    child = spawn(config.ollama.executable, ["serve"], {
      env: safeEnvironment({ OLLAMA_HOST: new URL(config.ollama.baseUrl).host }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    log("ollama-error", { message: error?.message || error });
    return;
  }
  ollamaChild = child;
  pipeLines(child.stdout, "ollama");
  pipeLines(child.stderr, "ollama-error");
  child.once("spawn", () => log("ollama-started", { pid: child.pid }));
  // A spawn that fails (the executable is missing, say, on a volume not mounted
  // yet) emits "error" and no "exit"; the next service check tries again.
  child.once("error", (error) => {
    if (ollamaChild === child) ollamaChild = null;
    log("ollama-error", { message: error?.message || error });
  });
  child.once("exit", (code, signal) => {
    if (ollamaChild === child) ollamaChild = null;
    log("ollama-exited", { code, signal });
  });
}

function startupGrace(config) {
  const value = Number(config.ollama?.startupGraceMs);
  return Number.isInteger(value) && value >= 0 ? value : 60_000;
}

/** Waits for Ollama's API, polling with backoff, for at most `timeoutMs`. */
async function waitForOllama(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  while (!stopping && Date.now() < deadline) {
    if (await ollamaHealthy(config)) return true;
    await sleep(Math.max(0, Math.min(delay, deadline - Date.now())));
    delay = Math.min(delay * 2, 5_000);
  }
  return !stopping && ollamaHealthy(config);
}

function serviceCheckInterval(config) {
  const value = Number(config.ollama?.serviceCheckIntervalMs);
  return Number.isInteger(value) && value >= 100 ? value : 15_000;
}

let checking = false;

/**
 * Between warmups, start `ollama serve` again whenever the API stops answering. The
 * app's own Ollama download has no service of its own, so this is what brings it
 * back after it exits.
 */
async function keepOllamaServing(config) {
  if (stopping || checking || ollamaChild) return;
  checking = true;
  try {
    if (!(await ollamaHealthy(config)) && !stopping && !ollamaChild) {
      log("ollama-not-answering", { baseUrl: config.ollama.baseUrl });
      startOllama(config);
    }
  } finally {
    checking = false;
  }
}

async function warmEmbedding(config) {
  if (stopping || !config.ollama.enabled) return false;
  if (!(await ollamaHealthy(config))) {
    startOllama(config);
    for (let attempt = 0; attempt < 20 && !stopping; attempt += 1) {
      await sleep(500);
      if (await ollamaHealthy(config)) break;
    }
  }
  if (stopping) return false;
  const result = await embeddingRequest(config, "memory warmup");
  if (result.ok) log("embedding-resident", { model: config.ollama.model, dimensions: result.dimensions });
  else log("embedding-warmup-failed", {
    model: config.ollama.model,
    expectedDimensions: config.ollama.dimensions,
    actualDimensions: result.dimensions,
    status: result.status || null,
    message: result.error || "embedding response did not match the configured dimensions",
  });
  return result.ok;
}

function firstWarmRetry(config) {
  const value = Number(config.ollama?.warmRetryMs);
  return Number.isInteger(value) && value >= 100 ? value : 5_000;
}

let warmRetryMs = 0;

/** Warms now, then again after the warm interval, or sooner with backoff after a failure. */
async function warmLoop(config) {
  const ok = await warmEmbedding(config);
  if (stopping) return;
  const interval = config.ollama.warmIntervalMs;
  warmRetryMs = ok ? 0 : Math.min(warmRetryMs ? warmRetryMs * 2 : firstWarmRetry(config), interval);
  const next = ok ? interval : warmRetryMs;
  if (!ok) log("embedding-warmup-retry", { inMs: next });
  const timer = setTimeout(() => {
    timers.delete(timer);
    warmLoop(config);
  }, next);
  timers.add(timer);
}

// ------------------------------------------------------------------ mesh

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** {port, gatePort} while the share state turns Mesh on, else null. */
async function wantedMesh(config) {
  const state = await readJson(config.mesh.shareStateFile);
  const mesh = state?.mesh;
  if (mesh?.enabled !== true || !validPort(mesh.port) || !validPort(mesh.gatePort) || mesh.port === mesh.gatePort) return null;
  return { port: mesh.port, gatePort: mesh.gatePort };
}

let meshRestartAt = 0;
let meshBackoffMs = 0;
let meshChecking = false;

function stopMesh(reason) {
  const child = meshChild;
  if (!child) return;
  child.stoppedOnPurpose = true;
  log("mesh-forwarder-stop", { reason, pid: child.pid || null });
  try { child.kill(); } catch {}
}

function startMesh(config, wanted) {
  let child;
  try {
    child = spawn(process.execPath, [
      config.mesh.forwarderFile,
      "--port", String(wanted.port),
      "--target-port", String(wanted.gatePort),
      "--state", config.mesh.stateFile,
    ], { env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    log("mesh-forwarder-error", { message: error?.message || error });
    return;
  }
  child.wanted = wanted;
  child.startedAt = Date.now();
  meshChild = child;
  pipeLines(child.stdout, "mesh-forwarder");
  pipeLines(child.stderr, "mesh-forwarder-error");
  child.once("error", (error) => log("mesh-forwarder-error", { message: error?.message || error }));
  child.once("exit", (code, signal) => {
    if (meshChild === child) meshChild = null;
    // A forwarder killed hard (Windows has no SIGTERM) leaves its state behind.
    readJson(config.mesh.stateFile).then((record) => {
      if (record?.pid === child.pid) return fsp.rm(config.mesh.stateFile, { force: true });
      return null;
    }).catch(() => {});
    if (child.stoppedOnPurpose || stopping) {
      meshBackoffMs = 0;
      meshRestartAt = 0;
      return;
    }
    // One that ran a while had nothing wrong with its start; begin the backoff again.
    meshBackoffMs = Date.now() - child.startedAt > 30_000 ? 1_000 : Math.min(meshBackoffMs ? meshBackoffMs * 2 : 1_000, 60_000);
    meshRestartAt = Date.now() + meshBackoffMs;
    log("mesh-forwarder-exited", { code, signal, restartInMs: meshBackoffMs });
  });
}

async function keepMeshForwarding(config) {
  if (stopping || meshChecking) return;
  meshChecking = true;
  try {
    const wanted = await wantedMesh(config);
    if (stopping) return;
    if (!wanted) { stopMesh("mesh sharing is off"); return; }
    const running = meshChild?.wanted;
    if (running && (running.port !== wanted.port || running.gatePort !== wanted.gatePort)) {
      stopMesh("the ports changed");
      return;
    }
    if (!meshChild && Date.now() >= meshRestartAt) startMesh(config, wanted);
  } finally {
    meshChecking = false;
  }
}

function meshCheckInterval(config) {
  const value = Number(config.mesh?.checkIntervalMs);
  return Number.isInteger(value) && value >= 100 ? value : 2_000;
}

async function removeOwnPid(config) {
  const record = await readJson(config.state.pidFile);
  if (record?.pid === process.pid) await fsp.rm(config.state.pidFile, { force: true });
}

async function shutdown(config, reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  log("supervisor-stopping", { reason });
  for (const timer of timers) clearTimeout(timer);
  const forwarder = meshChild;
  stopMesh("the supervisor is stopping");
  if (forwarder && forwarder.exitCode === null && forwarder.signalCode === null) {
    await Promise.race([
      once(forwarder, "exit").catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
  }
  const child = ollamaChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([
      once(child, "exit").catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        once(child, "exit").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  }
  await removeOwnPid(config);
  process.exit(exitCode);
}

async function main() {
  const configOption = option("--config");
  let config;
  try {
    if (!configOption) throw new Error("--config is required");
    const configFile = path.resolve(configOption);
    config = validateConfig(await readJson(configFile), configFile);
  } catch (error) {
    // Exit 0: no restart can fix a missing or invalid config, so an autostart must
    // not loop on it. `host start` writes the config again.
    log("supervisor-config-invalid", { message: error?.message || error });
    return;
  }
  const pid = await acquirePid(config);
  if (!pid.acquired) {
    log("supervisor-already-running", { pid: pid.owner });
    return;
  }
  log("supervisor-started", { pid: process.pid, profile: config.profile });

  process.on("SIGINT", () => shutdown(config, "SIGINT"));
  process.on("SIGTERM", () => shutdown(config, "SIGTERM"));
  process.on("SIGHUP", () => shutdown(config, "SIGHUP"));
  process.on("uncaughtException", (error) => {
    log("uncaught-exception", { message: error?.message || error });
    shutdown(config, "uncaught-exception", 1);
  });
  process.on("unhandledRejection", (error) => log("unhandled-rejection", { message: error?.message || error }));

  if (config.mesh) {
    // First, so a Mesh address answers while Ollama is still given its startup grace.
    await keepMeshForwarding(config);
    const checker = setInterval(() => keepMeshForwarding(config), meshCheckInterval(config));
    timers.add(checker);
  }

  if (config.ollama?.enabled) {
    // At login, Ollama's own app or service may still be starting; give it time
    // before starting a second `ollama serve` on its port. The app's own copy has
    // nothing else to start it, so it gets no grace.
    if (config.ollama.manageService && !config.ollama.owned && !(await ollamaHealthy(config))) {
      log("ollama-waiting", { baseUrl: config.ollama.baseUrl, graceMs: startupGrace(config) });
      await waitForOllama(config, startupGrace(config));
    }
    await warmLoop(config);
    if (config.ollama.manageService) {
      const checker = setInterval(() => keepOllamaServing(config), serviceCheckInterval(config));
      timers.add(checker);
    }
  }
}

main().catch((error) => {
  log("supervisor-fatal", { message: error?.message || error });
  process.exitCode = 1;
});
