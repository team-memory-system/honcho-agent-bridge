import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installPaths } from "./config.mjs";
import { hostPrepare, hostStart, hostStatus, hostStop } from "./host-manager.mjs";
import { securePrivateFile } from "./private-file-permissions.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_HOST_RUNTIME = Object.freeze({
  prepare: hostPrepare,
  start: hostStart,
  status: hostStatus,
  stop: hostStop,
});
const VERIFY_EMBEDDING_DIMENSIONS = 1536;
const VERIFY_MINIMUM_PROMPT_TOKENS = 2048;
const VERIFY_EMBEDDING_INPUT = "verify\n".repeat(3000);
const CONTAINER_HOST_PROBE_SCRIPT = `import json
import urllib.error
import urllib.request

def probe(url):
    try:
        response = urllib.request.urlopen(url, timeout=5)
        status = getattr(response, "status", None)
        response.close()
        return {"ok": status is not None and 200 <= status < 300, "status": status}
    except urllib.error.HTTPError as error:
        return {"ok": False, "status": error.code}
    except Exception:
        return {"ok": False, "status": None}

print(json.dumps({
    "ollama": probe("http://host.docker.internal:11434/api/version"),
    "proxy": probe("http://host.docker.internal:11435/health"),
}))`;

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function sourceServerDir() {
  return path.resolve(process.env.AGENT_MEMORY_SERVER_SOURCE || path.join(PLUGIN_ROOT, "server"));
}

export function installedServerDir(config = null) {
  return path.resolve(process.env.AGENT_MEMORY_SERVER_DIR || config?.paths?.serverDir || path.join(installPaths(config).appHome, "server"));
}

async function dockerProbe() {
  try {
    const { stdout: version } = await execFileAsync("docker", ["compose", "version", "--short"], { timeout: 5_000 });
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5_000 });
    return { installed: true, running: true, composeVersion: version.trim() };
  } catch (error) {
    const message = String(error?.stderr || error?.message || error).trim();
    return { installed: !/ENOENT|not found/i.test(message), running: false, error: message };
  }
}

async function bundleProbe(directory = sourceServerDir()) {
  const required = ["compose.yaml", ".env.example", "honcho/Dockerfile", "honcho/LICENSE", "honcho/local-dashboard/Dockerfile"];
  const missing = [];
  for (const item of required) if (!(await exists(path.join(directory, item)))) missing.push(item);
  return { ok: missing.length === 0, directory, missing };
}

export async function dockerCliEnvironment(directory, {
  platform = process.platform,
  env = process.env,
} = {}) {
  const result = { ...env, COMPOSE_PROJECT_NAME: "agent-memory" };
  if (platform !== "win32") return result;
  const configDirectory = path.join(path.dirname(path.resolve(directory)), "runtime", "docker-cli");
  const configFile = path.join(configDirectory, "config.json");
  // A non-empty auth map suppresses Docker CLI's Windows default credential
  // helper discovery while still representing an anonymous Docker Hub pull.
  const anonymousConfig = '{"auths":{"https://index.docker.io/v1/":{}}}\n';
  await fsp.mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const existing = await fsp.readFile(configFile, "utf8").catch(() => "");
  if (existing !== anonymousConfig) await fsp.writeFile(configFile, anonymousConfig, { mode: 0o600 });
  result.DOCKER_CONFIG = configDirectory;
  return result;
}

async function compose(directory, args, options = {}) {
  const env = await dockerCliEnvironment(directory);
  return execFileAsync("docker", ["compose", "--project-directory", directory, ...args], {
    cwd: directory,
    timeout: options.timeout || 900_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
}

function replaceEnvironment(text, values) {
  const seen = new Set();
  const lines = text.split(/\r?\n/).map(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function parseEnvironment(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function localEndpointConfigured(environment, port) {
  return Object.entries(environment).some(([key, value]) =>
    /(?:BASE_URL|ENDPOINT)$/.test(key)
      && new RegExp(`(?:host\\.docker\\.internal|127\\.0\\.0\\.1|localhost):${port}(?:/|$)`).test(value),
  );
}

function isSecretEnvironmentKey(key) {
  return /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(key)
    && !key.endsWith("_API_KEY_ENV");
}

function isPersonalModelConfigKey(key) {
  return /^(?:EMBEDDING_MODEL_CONFIG|DERIVER_MODEL_CONFIG|SUMMARY_MODEL_CONFIG|DREAM_(?:DEDUCTION|INDUCTION)_MODEL_CONFIG|DIALECTIC_LEVELS__(?:minimal|low|medium|high|max)__MODEL_CONFIG)__/.test(key);
}

function isManagedPersonalTopologyKey(key) {
  if (["LLM_VLLM_BASE_URL", "LLM_OPENAI_COMPATIBLE_BASE_URL"].includes(key)) return true;
  if (/^EMBEDDING_(?:MAX_INPUT_TOKENS|MAX_TOKENS_PER_REQUEST|VECTOR_DIMENSIONS|QUERY_INSTRUCTION)$/.test(key)) return true;
  if (/^EMBEDDING_MODEL_CONFIG__(?:TRANSPORT|MODEL|OVERRIDES__(?:BASE_URL|API_KEY_ENV))$/.test(key)) return true;
  return /^(?:DERIVER_MODEL_CONFIG|SUMMARY_MODEL_CONFIG|DREAM_(?:DEDUCTION|INDUCTION)_MODEL_CONFIG|DIALECTIC_LEVELS__(?:minimal|low|medium|high|max)__MODEL_CONFIG)__(?:TRANSPORT|MODEL|THINKING_EFFORT|OVERRIDES__(?:BASE_URL|API_KEY_ENV))$/.test(key);
}

function mergePersonalProfileEnvironment(currentText, profileText) {
  const current = parseEnvironment(currentText);
  const profile = parseEnvironment(profileText);
  const values = {};
  for (const [key, value] of Object.entries(profile)) {
    if (isSecretEnvironmentKey(key)) continue;
    if (isManagedPersonalTopologyKey(key) || !(key in current)) values[key] = value;
  }
  const withoutConflictingModelKeys = currentText.split(/\r?\n/).filter((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !isPersonalModelConfigKey(match[1])) return true;
    return isManagedPersonalTopologyKey(match[1]);
  }).join("\n");
  return replaceEnvironment(withoutConflictingModelKeys, values);
}

async function initializeEnvironment(directory, profile = "portable", privateFileOptions = {}) {
  const target = path.join(directory, ".env");
  const candidate = profile === "personal" ? path.join(directory, "env.personal.example") : path.join(directory, ".env.example");
  if (await exists(target)) {
    const original = await fsp.readFile(target, "utf8");
    const candidateExists = await exists(candidate);
    const profileText = candidateExists ? await fsp.readFile(candidate, "utf8") : "";
    const currentEnvironment = parseEnvironment(original);
    const generatedValues = {};
    if (!String(currentEnvironment.POSTGRES_PASSWORD || "").trim()) {
      generatedValues.POSTGRES_PASSWORD = crypto.randomBytes(24).toString("base64url");
    }
    if (profile === "personal" && candidateExists) {
      const templateEnvironment = parseEnvironment(profileText);
      if (localEndpointConfigured(templateEnvironment, 11434) && !String(currentEnvironment.LLM_OPENAI_COMPATIBLE_API_KEY || "").trim()) {
        generatedValues.LLM_OPENAI_COMPATIBLE_API_KEY = "ollama-local";
      }
      if (localEndpointConfigured(templateEnvironment, 11435) && !String(currentEnvironment.LLM_VLLM_API_KEY || "").trim()) {
        generatedValues.LLM_VLLM_API_KEY = crypto.randomBytes(32).toString("base64url");
      }
    }
    const current = replaceEnvironment(original, generatedValues);
    const merged = profile === "personal" && candidateExists
      ? mergePersonalProfileEnvironment(current, profileText)
      : current;
    const updated = merged !== original;
    if (updated) {
      const temporary = `${target}.tmp-${process.pid}`;
      await fsp.writeFile(temporary, merged, { mode: 0o600 });
      try {
        await securePrivateFile(temporary, privateFileOptions);
        await fsp.rename(temporary, target);
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    } else {
      await securePrivateFile(target, privateFileOptions);
    }
    return { created: false, updated, path: target, profile: "existing" };
  }
  if (!(await exists(candidate))) throw new Error(`Environment profile is unavailable: ${profile}`);
  let text = await fsp.readFile(candidate, "utf8");
  const values = { POSTGRES_PASSWORD: crypto.randomBytes(24).toString("base64url") };
  const templateEnvironment = parseEnvironment(text);
  if (profile === "personal" && localEndpointConfigured(templateEnvironment, 11434)) {
    values.LLM_OPENAI_COMPATIBLE_API_KEY = templateEnvironment.LLM_OPENAI_COMPATIBLE_API_KEY || "ollama-local";
  }
  if (profile === "personal" && localEndpointConfigured(templateEnvironment, 11435)) {
    values.LLM_VLLM_API_KEY = templateEnvironment.LLM_VLLM_API_KEY || crypto.randomBytes(32).toString("base64url");
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^LLM_[A-Z0-9_]*API_KEY$/.test(key) && value) values[key] = value;
  }
  text = replaceEnvironment(text, values);
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, text, { mode: 0o600 });
  try {
    await securePrivateFile(temporary, privateFileOptions);
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { created: true, path: target, profile };
}

export async function serverPlan({ profile = "portable" } = {}) {
  const [docker, bundle] = await Promise.all([dockerProbe(), bundleProbe()]);
  const issues = [];
  const warnings = [];
  if (!docker.installed) issues.push("Docker CLI is not installed");
  else if (!docker.running) issues.push("Docker is installed but the engine is not running");
  if (!bundle.ok) issues.push(`The bundled Honcho source is incomplete: ${bundle.missing.join(", ")}`);
  const profilePath = profile === "personal" ? "env.personal.example" : ".env.example";
  if (!(await exists(path.join(bundle.directory, profilePath)))) issues.push(`The ${profile} environment profile is not included`);
  if (profile === "personal") {
    const hostAssets = ["host-profile.personal.json", "host/supervisor.mjs", "host/qwen3-embedding-8192.Modelfile"];
    const missingHostAssets = [];
    for (const asset of hostAssets) if (!(await exists(path.join(bundle.directory, asset)))) missingHostAssets.push(asset);
    if (missingHostAssets.length) issues.push(`The personal host runtime is incomplete: ${missingHostAssets.join(", ")}`);
  }
  if (profile === "portable" && !process.env.LLM_OPENAI_API_KEY && !(await exists(path.join(bundle.directory, ".env")))) {
    warnings.push("No OpenAI key was supplied; add the required LLM key to server/.env before memory processing");
  }
  return {
    ok: issues.length === 0,
    ready: issues.length === 0,
    mode: "local-docker",
    profile,
    docker,
    bundle,
    installDirectory: installedServerDir(),
    apiUrl: "http://127.0.0.1:8001",
    dashboardUrl: "http://127.0.0.1:4173",
    issues,
    warnings,
  };
}

async function missingLlmSecrets(environmentPath) {
  const text = await fsp.readFile(environmentPath, "utf8");
  const environment = parseEnvironment(text);
  const required = new Set();
  for (const [key, transport] of Object.entries(environment)) {
    if (!key.endsWith("MODEL_CONFIG__TRANSPORT") || transport !== "openai") continue;
    const prefix = key.slice(0, -"TRANSPORT".length);
    required.add(environment[`${prefix}OVERRIDES__API_KEY_ENV`] || "LLM_OPENAI_API_KEY");
  }
  return [...required].filter(key => !String(environment[key] || "").trim()).sort();
}

export async function copyServerBundle(source, destination, privateFileOptions = {}) {
  if (path.resolve(source) === path.resolve(destination)) return { changed: false, source, destination };
  const temporary = `${destination}.tmp-${process.pid}`;
  const previous = `${destination}.previous`;
  const currentEnvironment = await fsp.readFile(path.join(destination, ".env")).catch(() => null);
  await fsp.rm(temporary, { recursive: true, force: true });
  await fsp.cp(source, temporary, { recursive: true, filter: item => path.basename(item) !== ".env" });
  if (currentEnvironment) {
    const temporaryEnvironment = path.join(temporary, ".env");
    await fsp.writeFile(temporaryEnvironment, currentEnvironment, { mode: 0o600 });
    try {
      await securePrivateFile(temporaryEnvironment, privateFileOptions);
    } catch (error) {
      await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  if (await exists(destination)) {
    await fsp.rm(previous, { recursive: true, force: true });
    await fsp.rename(destination, previous);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.rename(temporary, destination);
  return { changed: true, source, destination, previous: (await exists(previous)) ? previous : null };
}

export async function serverPrepare({
  profile = "portable",
  hostRuntime = DEFAULT_HOST_RUNTIME,
  preparedPlan = null,
  serverDirectory = null,
  platform = process.platform,
  env = process.env,
  privateFileRunner,
} = {}) {
  const plan = preparedPlan || await serverPlan({ profile });
  if (!plan.ready) return plan;
  const installed = path.resolve(serverDirectory || installedServerDir());
  let hostStoppedForUpdate = false;
  if (profile === "personal" && await exists(installed)) {
    let existingHost;
    try { existingHost = await hostRuntime.status({ profile, installedServerDir: installed }); }
    catch {
      return {
        ok: false,
        ready: false,
        mode: "local-docker",
        profile,
        issues: ["The existing host runtime could not be inspected safely before the server update"],
        hostStoppedForUpdate: false,
      };
    }
    if (existingHost.running || existingHost.supervisor?.processAlive) {
      const stopped = await hostRuntime.stop({ profile, installedServerDir: installed });
      if (!stopped.ok || !stopped.stopped) {
        return {
          ok: false,
          ready: false,
          mode: "local-docker",
          profile,
          issues: ["The existing host runtime could not be stopped safely before the server update"],
          host: stopped,
          hostStoppedForUpdate: false,
        };
      }
      hostStoppedForUpdate = true;
    }
  }
  const privateFileOptions = { platform, env, ...(privateFileRunner ? { run: privateFileRunner } : {}) };
  const installation = await copyServerBundle(plan.bundle.directory, installed, privateFileOptions);
  const environment = await initializeEnvironment(installed, profile, privateFileOptions);
  const missingSecretFields = await missingLlmSecrets(environment.path);
  const host = profile === "personal"
    ? await hostRuntime.prepare({ profile, installedServerDir: installed })
    : null;
  const hostReady = host ? Boolean(host.ok && host.ready) : true;
  const ready = missingSecretFields.length === 0 && hostReady;
  const result = {
    ok: host ? Boolean(host.ok) : true,
    ready,
    mode: "local-docker",
    profile,
    installation,
    environment,
    missingSecretFields,
    next: missingSecretFields.length
      ? `Fill the listed fields in ${environment.path}, then run server start`
      : (hostReady ? "Run server start" : "Resolve the reported host-service issues, then run server prepare again"),
  };
  if (host) result.host = host;
  if (profile === "personal") result.hostStoppedForUpdate = hostStoppedForUpdate;
  return result;
}

async function waitForHealth(url, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return { ok: true, status: response.status, elapsedMs: Date.now() - started };
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error?.message || String(error); }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return { ok: false, error: lastError || "health check timed out", elapsedMs: Date.now() - started };
}

export async function serverStart({
  profile = "portable",
  build = true,
  hostRuntime = DEFAULT_HOST_RUNTIME,
  preparedServer = null,
  serverDirectory = null,
  composeRunner = compose,
  healthWaiter = waitForHealth,
} = {}) {
  const installed = path.resolve(serverDirectory || installedServerDir());
  const prepared = preparedServer || await serverPrepare({ profile, hostRuntime, serverDirectory: installed });
  if (!prepared.ok || !prepared.ready) return prepared;
  const host = profile === "personal"
    ? await hostRuntime.start({ profile, installedServerDir: installed, skipPrepare: true })
    : null;
  if (host && !host.ok) {
    return {
      ok: false,
      ready: false,
      mode: "local-docker",
      profile,
      installation: prepared.installation,
      environment: prepared.environment,
      host,
      next: "Resolve the reported host-service issue before starting Honcho containers",
    };
  }
  const args = ["up", "-d", "--remove-orphans"];
  if (build) args.push("--build");
  let composeResult;
  try {
    composeResult = await composeRunner(installed, args);
  } catch (error) {
    if (host) await hostRuntime.stop({ profile, installedServerDir: installed }).catch(() => {});
    throw error;
  }
  const health = await healthWaiter("http://127.0.0.1:8001/health");
  const result = {
    ok: health.ok,
    mode: "local-docker",
    profile,
    installation: prepared.installation,
    environment: prepared.environment,
    health,
    apiUrl: "http://127.0.0.1:8001",
    dashboardUrl: "http://127.0.0.1:4173",
    compose: { stdout: composeResult.stdout.trim(), stderr: composeResult.stderr.trim() },
  };
  if (host) result.host = host;
  return result;
}

export async function serverStatus({
  profile = "portable",
  hostRuntime = DEFAULT_HOST_RUNTIME,
  serverDirectory = null,
  dockerInspector = dockerProbe,
  composeRunner = compose,
  healthWaiter = waitForHealth,
} = {}) {
  const directory = path.resolve(serverDirectory || installedServerDir());
  const [docker, host] = await Promise.all([
    dockerInspector(),
    profile === "personal" ? hostRuntime.status({ profile, installedServerDir: directory }) : Promise.resolve(null),
  ]);
  if (!docker.running || !(await exists(path.join(directory, "compose.yaml")))) {
    const result = { ok: false, installed: await exists(directory), running: false, directory, docker };
    if (host) result.host = host;
    return result;
  }
  try {
    const { stdout } = await composeRunner(directory, ["ps", "--format", "json"], { timeout: 10_000 });
    const services = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const health = await healthWaiter("http://127.0.0.1:8001/health", 2_500);
    const containersRunning = services.some(item => item.State === "running");
    const result = {
      ok: health.ok && (!host || host.ok),
      installed: true,
      running: containersRunning && (!host || host.running),
      directory,
      docker,
      health,
      services,
    };
    if (host) result.host = host;
    return result;
  } catch (error) {
    const result = { ok: false, installed: true, running: false, directory, docker, error: String(error?.stderr || error?.message || error) };
    if (host) result.host = host;
    return result;
  }
}

export async function serverStop({
  profile = "portable",
  hostRuntime = DEFAULT_HOST_RUNTIME,
  serverDirectory = null,
  composeRunner = compose,
} = {}) {
  const directory = path.resolve(serverDirectory || installedServerDir());
  const composeFileExists = await exists(path.join(directory, "compose.yaml"));
  if (profile !== "personal") {
    if (!composeFileExists) return { ok: true, stopped: false, reason: "server is not installed" };
    const { stdout, stderr } = await composeRunner(directory, ["stop"], { timeout: 120_000 });
    return { ok: true, stopped: true, preservedVolumes: true, directory, stdout: stdout.trim(), stderr: stderr.trim() };
  }

  let composeResult = null;
  let composeError = null;
  if (composeFileExists) {
    try { composeResult = await composeRunner(directory, ["stop"], { timeout: 120_000 }); }
    catch (error) { composeError = String(error?.stderr || error?.message || error); }
  }
  const host = await hostRuntime.stop({ profile, installedServerDir: directory });
  return {
    ok: !composeError && Boolean(host.ok),
    stopped: Boolean(host.stopped) && (!composeFileExists || Boolean(composeResult)),
    containersStopped: Boolean(composeResult),
    host,
    preservedVolumes: true,
    directory,
    ...(composeResult ? { stdout: composeResult.stdout.trim(), stderr: composeResult.stderr.trim() } : {}),
    ...(composeError ? { error: composeError } : {}),
    ...(!composeFileExists ? { reason: "Honcho containers were not installed; host services were still stopped" } : {}),
  };
}

async function discardBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

function statusSummary(status) {
  if (!status || typeof status !== "object") {
    return { ok: false, installed: false, running: false, error: "Server status returned no result" };
  }
  return {
    ok: Boolean(status.ok && status.running),
    installed: Boolean(status.installed),
    running: Boolean(status.running),
    docker: {
      installed: Boolean(status.docker?.installed),
      running: Boolean(status.docker?.running),
    },
    host: {
      running: Boolean(status.host?.running),
      proxyHealthy: Boolean(status.host?.proxy?.healthy),
      ollamaHealthy: Boolean(status.host?.ollama?.healthy),
      embeddingResident: Boolean(status.host?.ollama?.resident),
    },
  };
}

async function verifyOllamaEmbedding({ fetchImpl, model, timeoutMs }) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, "http://127.0.0.1:11434/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model,
        input: VERIFY_EMBEDDING_INPUT,
        truncate: false,
        dimensions: VERIFY_EMBEDDING_DIMENSIONS,
        keep_alive: -1,
      }),
    }, timeoutMs);
  } catch {
    return {
      ok: false,
      status: null,
      model,
      promptEvalCount: null,
      minimumPromptTokens: VERIFY_MINIMUM_PROMPT_TOKENS,
      vectorLength: null,
      expectedVectorLength: VERIFY_EMBEDDING_DIMENSIONS,
      error: "Ollama embedding request failed",
    };
  }
  if (!response.ok) {
    await discardBody(response);
    return {
      ok: false,
      status: response.status ?? null,
      model,
      promptEvalCount: null,
      minimumPromptTokens: VERIFY_MINIMUM_PROMPT_TOKENS,
      vectorLength: null,
      expectedVectorLength: VERIFY_EMBEDDING_DIMENSIONS,
      error: "Ollama rejected the long embedding probe",
    };
  }
  let document = null;
  try { document = await response.json(); } catch {}
  const vector = Array.isArray(document?.embeddings?.[0]) ? document.embeddings[0] : null;
  const promptEvalCount = Number.isInteger(document?.prompt_eval_count) ? document.prompt_eval_count : null;
  const vectorLength = vector?.length ?? null;
  const promptLongEnough = promptEvalCount !== null && promptEvalCount > VERIFY_MINIMUM_PROMPT_TOKENS;
  const dimensionsMatch = vectorLength === VERIFY_EMBEDDING_DIMENSIONS;
  return {
    ok: promptLongEnough && dimensionsMatch,
    status: response.status ?? null,
    model,
    promptEvalCount,
    minimumPromptTokens: VERIFY_MINIMUM_PROMPT_TOKENS,
    promptLongEnough,
    vectorLength,
    expectedVectorLength: VERIFY_EMBEDDING_DIMENSIONS,
    dimensionsMatch,
    truncate: false,
  };
}

async function verifyContainerHostAccess({ directory, composeRunner }) {
  let result;
  try {
    result = await composeRunner(directory, [
      "exec",
      "-T",
      "api",
      "python",
      "-c",
      CONTAINER_HOST_PROBE_SCRIPT,
    ], { timeout: 30_000 });
  } catch {
    return {
      ok: false,
      ollama: { ok: false, status: null },
      proxy: { ok: false, status: null },
      error: "Docker API-container host connectivity probe failed",
    };
  }
  let document = null;
  try {
    const line = String(result?.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
    document = line ? JSON.parse(line) : null;
  } catch {}
  const ollama = {
    ok: Boolean(document?.ollama?.ok),
    status: Number.isInteger(document?.ollama?.status) ? document.ollama.status : null,
  };
  const proxy = {
    ok: Boolean(document?.proxy?.ok),
    status: Number.isInteger(document?.proxy?.status) ? document.proxy.status : null,
  };
  return {
    ok: ollama.ok && proxy.ok,
    ollama,
    proxy,
    ...(!document ? { error: "Docker API-container host connectivity probe returned no valid result" } : {}),
  };
}

async function verifyHonchoHealth({ fetchImpl, timeoutMs }) {
  try {
    const response = await fetchWithTimeout(fetchImpl, "http://127.0.0.1:8001/health", {
      method: "GET",
      headers: { Accept: "application/json" },
    }, timeoutMs);
    const result = { ok: Boolean(response.ok), status: response.status ?? null };
    await discardBody(response);
    return result;
  } catch {
    return { ok: false, status: null, error: "Honcho health request failed" };
  }
}

async function verifyLiveCompletion({ directory, fetchImpl, model, port, timeoutMs }) {
  let environment;
  try { environment = parseEnvironment(await fsp.readFile(path.join(directory, ".env"), "utf8")); }
  catch {
    return { ok: false, model };
  }
  const secretName = String(environment.DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV || "LLM_VLLM_API_KEY").trim();
  const secret = String(environment[secretName] || "").trim();
  if (!secret) {
    return { ok: false, model };
  }
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply OK" }],
        max_completion_tokens: 32,
        reasoning_effort: "high",
        stream: false,
      }),
    }, timeoutMs);
  } catch {
    return { ok: false, model };
  }
  const result = { ok: Boolean(response.ok), model };
  await discardBody(response);
  return result;
}

/**
 * Exercise the production-shaped personal topology without returning response
 * bodies, vectors, prompts, or credentials. A live Codex request is opt-in.
 */
export async function serverVerify({
  profile = "personal",
  liveCompletion = false,
  serverDirectory = null,
  statusInspector = serverStatus,
  composeRunner = compose,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 120_000,
} = {}) {
  const directory = path.resolve(serverDirectory || installedServerDir());
  if (profile !== "personal") {
    return {
      ok: false,
      profile,
      liveCompletion: Boolean(liveCompletion),
      issues: ["Server verification currently requires --profile personal"],
    };
  }

  let rawStatus = null;
  try { rawStatus = await statusInspector({ profile, serverDirectory: directory }); } catch {}
  const status = statusSummary(rawStatus);
  const embeddingModel = rawStatus?.host?.ollama?.model || "qwen3-embedding-honcho-8192";
  const completionModel = rawStatus?.host?.proxy?.model || "gpt-5.6-sol";
  const proxyPort = Number(rawStatus?.host?.proxy?.port || 11435);
  const safeProxyPort = Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort <= 65_535 ? proxyPort : 11435;

  const [embedding, containerHost, honcho, completion] = await Promise.all([
    verifyOllamaEmbedding({ fetchImpl, model: embeddingModel, timeoutMs: requestTimeoutMs }),
    verifyContainerHostAccess({ directory, composeRunner }),
    verifyHonchoHealth({ fetchImpl, timeoutMs: Math.min(requestTimeoutMs, 30_000) }),
    liveCompletion
      ? verifyLiveCompletion({ directory, fetchImpl, model: completionModel, port: safeProxyPort, timeoutMs: requestTimeoutMs })
      : Promise.resolve({ ok: true, skipped: true }),
  ]);

  const checks = { status, embedding, containerHost, honcho, completion };
  return {
    ok: Object.values(checks).every((check) => check.ok),
    profile,
    liveCompletion: Boolean(liveCompletion),
    checks,
  };
}
