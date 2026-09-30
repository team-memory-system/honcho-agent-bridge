// Keeps the personal profile's embedding model resident in Ollama.
//
// `host start` spawns this detached and finds it again through its PID file. It
// starts `ollama serve` when nothing answers on the configured address - at start,
// and again on every service check (`serviceCheckIntervalMs`, 15 s by default) -
// and warms the Qwen3 alias on an interval so an embedding after an idle stretch
// does not wait for a model load. Nothing registers this with the OS, so after a
// reboot it, and the `ollama serve` it started, stay down until `host start` runs. The subscription gateway is not supervised here: it has
// its own lifecycle and registers its own autostart.
import { spawn } from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";

let stopping = false;
let ollamaChild = null;
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
  for (const target of [config?.state?.pidFile, config?.supervisorFile]) {
    if (!target || !path.isAbsolute(target)) throw new Error("Host runtime config contains an invalid path");
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
  ollamaChild = spawn(config.ollama.executable, ["serve"], {
    env: safeEnvironment({ OLLAMA_HOST: new URL(config.ollama.baseUrl).host }),
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
  for (const timer of timers) clearInterval(timer);
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

  if (config.ollama?.enabled) {
    await warmEmbedding(config);
    const warmer = setInterval(() => warmEmbedding(config), config.ollama.warmIntervalMs);
    timers.add(warmer);
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
