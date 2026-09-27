import { spawn } from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const privateValues = new Set();
let stopping = false;
let ollamaChild = null;
const timers = new Set();

/**
 * One entry per managed proxy: the child, its pending restart, and how long the
 * next restart waits. Keyed by service name so the Codex proxy, the Claude proxy
 * and the router each back off on their own schedule.
 */
const proxyRuntime = new Map();

function runtimeFor(name) {
  let entry = proxyRuntime.get(name);
  if (!entry) {
    entry = { child: null, restartTimer: null, restartDelay: 1_000 };
    proxyRuntime.set(name, entry);
  }
  return entry;
}

/** The proxies this config asks for, oldest config shape included. */
function proxyServices(config) {
  if (config.proxies && typeof config.proxies === "object") {
    return Object.entries(config.proxies)
      .map(([name, service]) => ({ name, ...service }))
      .filter((service) => service.enabled);
  }
  return config.proxy?.enabled ? [{ name: "codex", ...config.proxy }] : [];
}

/**
 * What each proxy expects in its environment. The shared secret is the only value
 * that is a secret, and it is added by name so a service never sees another's.
 */
function proxyEnvironment(service) {
  const environment = { HOST: "127.0.0.1", PORT: String(service.port) };
  if (service.secretEnv && service.sharedSecret) environment[service.secretEnv] = service.sharedSecret;
  if (service.name === "codex") {
    environment.CODEX_AUTH_PATH = service.authPath;
    environment.DEFAULT_CODEX_MODEL = service.defaultModel;
  }
  if (service.name === "claude") {
    environment.CLAUDE_BIN = service.claudeBin || "claude";
    if (service.defaultModel) environment.CLAUDE_PROXY_MODEL = service.defaultModel;
  }
  if (service.name === "router" && service.configPath) environment.ROUTER_CONFIG = service.configPath;
  return environment;
}

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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readJson(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

function validateConfig(config, configFile) {
  if (!config || config.format !== 1) throw new Error("Unsupported host runtime config");
  const services = proxyServices(config);
  const paths = [config?.state?.pidFile, config?.supervisorFile];
  for (const service of services) paths.push(service.entrypoint);
  if (!services.length && config?.proxy?.entrypoint) paths.push(config.proxy.entrypoint);
  for (const target of paths) {
    if (!target || !path.isAbsolute(target)) throw new Error("Host runtime config contains an invalid path");
  }
  const endpoints = [config.ollama?.baseUrl, ...services.map((service) => service.baseUrl)].filter(Boolean);
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    if (url.username || url.password || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("Managed host services must use a credential-free loopback URL");
    }
  }
  // The Codex proxy is what Honcho itself calls, so a missing secret there is a
  // broken install rather than an open door. The others may legitimately run without.
  const codex = services.find((service) => service.name === "codex");
  if (codex && !codex.sharedSecret) throw new Error("Codex proxy shared secret is missing");
  for (const service of services) {
    if (service.sharedSecret) privateValues.add(String(service.sharedSecret));
  }
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

function startProxyService(config, service) {
  const runtime = runtimeFor(service.name);
  if (stopping || !service.enabled || runtime.child) return;
  const child = spawn(process.execPath, [service.entrypoint], {
    cwd: service.sourceDir,
    env: safeEnvironment(proxyEnvironment(service)),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  runtime.child = child;
  pipeLines(child.stdout, `${service.name}-proxy`);
  pipeLines(child.stderr, `${service.name}-proxy-error`);
  child.once("spawn", () => {
    log("proxy-started", { service: service.name, pid: child.pid, port: service.port, model: service.defaultModel });
    runtime.restartDelay = 1_000;
  });
  child.once("error", (error) => log("proxy-error", { service: service.name, message: error?.message || error }));
  child.once("exit", (code, signal) => {
    runtime.child = null;
    log("proxy-exited", { service: service.name, code, signal });
    if (stopping) return;
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = null;
      startProxyService(config, service);
    }, runtime.restartDelay);
    runtime.restartDelay = Math.min(runtime.restartDelay * 2, 30_000);
  });
}

function startProxies(config) {
  for (const service of proxyServices(config)) startProxyService(config, service);
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
  for (const runtime of proxyRuntime.values()) {
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
  }
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
  await Promise.all([
    ...[...proxyRuntime.values()].map((runtime) => stopChild(runtime.child)),
    stopChild(ollamaChild),
  ]);
  await removeOwnPid(config);
  process.exit(0);
}

async function main() {
  const configFile = path.resolve(option("--config") || "");
  if (!configFile) throw new Error("--config is required");
  const config = validateConfig(await readJson(configFile), configFile);
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
    shutdown(config, "uncaught-exception");
  });
  process.on("unhandledRejection", (error) => log("unhandled-rejection", { message: error?.message || error }));

  startProxies(config);
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
