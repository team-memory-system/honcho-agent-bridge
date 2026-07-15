import { spawn } from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HEARTBEAT_MS = 5_000;
const DISABLED_POLL_MS = 2_000;
const privateValues = new Set();
let stopping = false;
let proxyChild = null;
let ollamaChild = null;
let proxyRestartTimer = null;
let proxyRestartDelay = 1_000;
const timers = new Set();

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function sanitize(value) {
  let cleaned = String(value ?? "");
  for (const secret of privateValues) if (secret) cleaned = cleaned.split(secret).join("[redacted]");
  return cleaned
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

function log(event, detail = {}) {
  const clean = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, typeof value === "string" ? sanitize(value) : value]));
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...clean })}\n`);
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readJson(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

async function writeJsonAtomic(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, target);
  await fsp.chmod(target, 0o600).catch(() => {});
}

function validateConfig(config, configFile) {
  if (!config || config.format !== 1) throw new Error("Unsupported host runtime config");
  for (const target of [config?.state?.pidFile, config?.state?.disabledFile, config?.proxy?.entrypoint, config?.supervisorFile]) {
    if (!target || !path.isAbsolute(target)) throw new Error("Host runtime config contains an invalid path");
  }
  for (const endpoint of [config.proxy?.baseUrl, config.ollama?.baseUrl].filter(Boolean)) {
    const url = new URL(endpoint);
    if (url.username || url.password || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("Managed host services must use a credential-free loopback URL");
    }
  }
  if (config.proxy?.enabled && !config.proxy.sharedSecret) throw new Error("Codex proxy shared secret is missing");
  if (config.proxy?.sharedSecret) privateValues.add(String(config.proxy.sharedSecret));
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
    heartbeatAt: new Date().toISOString(),
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

function safeEnvironment(extra = {}, allowOllama = false) {
  const names = new Set([
    "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "LANG", "LC_ALL", "TZ",
  ]);
  const output = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (names.has(key) || (allowOllama && /^(?:OLLAMA|CUDA|HIP|ROCM|HSA|GGML)_/i.test(key))) output[key] = value;
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

function startProxy(config) {
  if (stopping || !config.proxy.enabled || proxyChild) return;
  proxyChild = spawn(process.execPath, [config.proxy.entrypoint], {
    cwd: config.proxy.sourceDir,
    env: safeEnvironment({
      PORT: String(config.proxy.port),
      CODEX_AUTH_PATH: config.proxy.authPath,
      DEFAULT_CODEX_MODEL: config.proxy.defaultModel,
      CODEX_PROXY_SHARED_SECRET: config.proxy.sharedSecret,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  pipeLines(proxyChild.stdout, "codex-proxy");
  pipeLines(proxyChild.stderr, "codex-proxy-error");
  proxyChild.once("spawn", () => {
    log("proxy-started", { pid: proxyChild.pid, port: config.proxy.port, model: config.proxy.defaultModel });
    proxyRestartDelay = 1_000;
  });
  proxyChild.once("error", (error) => log("proxy-error", { message: error?.message || error }));
  proxyChild.once("exit", (code, signal) => {
    proxyChild = null;
    log("proxy-exited", { code, signal });
    if (stopping) return;
    proxyRestartTimer = setTimeout(() => {
      proxyRestartTimer = null;
      startProxy(config);
    }, proxyRestartDelay);
    proxyRestartDelay = Math.min(proxyRestartDelay * 2, 30_000);
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
  ollamaChild = spawn(config.ollama.executable, ["serve"], {
    env: safeEnvironment({ OLLAMA_HOST: new URL(config.ollama.baseUrl).host }, true),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  pipeLines(ollamaChild.stdout, "ollama");
  pipeLines(ollamaChild.stderr, "ollama-error");
  ollamaChild.once("spawn", () => log("ollama-started", { pid: ollamaChild.pid }));
  ollamaChild.once("error", (error) => log("ollama-error", { message: error?.message || error }));
  ollamaChild.once("exit", (code, signal) => {
    ollamaChild = null;
    log("ollama-exited", { code, signal });
  });
}

async function warmEmbedding(config) {
  if (stopping || !config.ollama.enabled) return;
  if (!(await ollamaHealthy(config))) {
    startOllama(config);
    for (let attempt = 0; attempt < 20 && !stopping; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await ollamaHealthy(config)) break;
    }
  }
  const result = await embeddingRequest(config, "memory warmup");
  if (result.ok) log("embedding-resident", { model: config.ollama.model, dimensions: result.dimensions });
  else log("embedding-warmup-failed", {
    model: config.ollama.model,
    expectedDimensions: config.ollama.dimensions,
    actualDimensions: result.dimensions,
    status: result.status || null,
    message: result.error || "embedding response did not match the configured dimensions",
  });
}

async function removeOwnPid(config) {
  const record = await readJson(config.state.pidFile);
  if (record?.pid === process.pid) await fsp.rm(config.state.pidFile, { force: true });
}

async function shutdown(config, reason) {
  if (stopping) return;
  stopping = true;
  log("supervisor-stopping", { reason });
  if (proxyRestartTimer) clearTimeout(proxyRestartTimer);
  for (const timer of timers) clearInterval(timer);
  const stopChild = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
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
  };
  await Promise.all([stopChild(proxyChild), stopChild(ollamaChild)]);
  await removeOwnPid(config);
  process.exit(0);
}

async function main() {
  const configFile = path.resolve(option("--config") || "");
  if (!configFile) throw new Error("--config is required");
  const config = validateConfig(await readJson(configFile), configFile);
  if (await exists(config.state.disabledFile)) {
    log("supervisor-disabled");
    return;
  }
  const pid = await acquirePid(config);
  if (!pid.acquired) {
    log("supervisor-already-running", { pid: pid.owner });
    return;
  }
  log("supervisor-started", { pid: process.pid, profile: config.profile });

  const heartbeat = setInterval(async () => {
    const record = await readJson(config.state.pidFile);
    if (record?.pid !== process.pid) return shutdown(config, "pid-ownership-lost");
    await writeJsonAtomic(config.state.pidFile, { ...record, heartbeatAt: new Date().toISOString() });
  }, HEARTBEAT_MS);
  timers.add(heartbeat);

  const disabledPoll = setInterval(async () => {
    if (await exists(config.state.disabledFile)) await shutdown(config, "disabled-marker");
  }, DISABLED_POLL_MS);
  timers.add(disabledPoll);

  process.on("SIGINT", () => shutdown(config, "SIGINT"));
  process.on("SIGTERM", () => shutdown(config, "SIGTERM"));
  process.on("SIGHUP", () => shutdown(config, "SIGHUP"));
  process.on("uncaughtException", (error) => {
    log("uncaught-exception", { message: error?.message || error });
    shutdown(config, "uncaught-exception");
  });
  process.on("unhandledRejection", (error) => log("unhandled-rejection", { message: error?.message || error }));

  startProxy(config);
  if (config.ollama.enabled) {
    await warmEmbedding(config);
    const warmer = setInterval(() => warmEmbedding(config), config.ollama.warmIntervalMs);
    timers.add(warmer);
  }
}

main().catch((error) => {
  log("supervisor-fatal", { message: error?.message || error });
  process.exitCode = 1;
});
