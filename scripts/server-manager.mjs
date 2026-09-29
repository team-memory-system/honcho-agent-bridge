import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installPaths } from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { hostPrepare, hostStart, hostStatus, hostStop } from "./host-manager.mjs";
import { securePrivateFile } from "./private-file-permissions.mjs";
import { cloneSource, gitAvailable, readSourcePin } from "./source-pin.mjs";

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
const SERVER_PROFILES = new Set(["personal", "portable"]);
function containerHostProbeScript(targets) {
  return `import json
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

targets = json.loads(${JSON.stringify(JSON.stringify(targets))})
print(json.dumps({name: probe(url) for name, url in targets.items()}))`;
}

/**
 * A health URL the API container can reach, or "" when the value is not a local
 * endpoint. Only loopback and the Docker host alias are ever probed, and only the
 * host and port are taken from the environment - never a path or credentials.
 */
function containerHostHealthUrl(value, healthPath) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try { url = new URL(raw); }
  catch { return ""; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password) return "";
  if (!["127.0.0.1", "localhost", "::1", "host.docker.internal"].includes(url.hostname)) return "";
  return `http://host.docker.internal:${url.port || (url.protocol === "https:" ? 443 : 80)}${healthPath}`;
}

/**
 * What this install actually expects to reach from inside the API container. An
 * endpoint the environment never configured is not a failure: requiring the Codex
 * proxy unconditionally is what made `server verify` impossible to pass on an
 * install that routes completions elsewhere, or has no proxy at all.
 */
function containerHostTargets(environment) {
  const ollama = containerHostHealthUrl(
    environment.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL || environment.LLM_OPENAI_COMPATIBLE_BASE_URL,
    "/api/version",
  );
  const proxy = containerHostHealthUrl(
    environment.DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL || environment.LLM_VLLM_BASE_URL,
    "/health",
  );
  const targets = {};
  if (ollama) targets.ollama = ollama;
  if (proxy) targets.proxy = proxy;
  return targets;
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function requireServerProfile(profile) {
  if (!SERVER_PROFILES.has(profile)) {
    throw new Error(`Unsupported server profile: ${profile}. Expected personal or portable.`);
  }
  return profile;
}

function sourceServerDir() {
  return path.resolve(process.env.HONCHO_AGENT_BRIDGE_SERVER_SOURCE || path.join(PLUGIN_ROOT, "server"));
}

export function installedServerDir(config = null) {
  return path.resolve(process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR || config?.paths?.serverDir || path.join(installPaths(config).appHome, "server"));
}

async function withServerLifecycleLock(directory, operation, callback) {
  const lockPath = `${path.resolve(directory)}.lifecycle.lock`;
  const lock = await acquireFileLock(lockPath, {
    attempts: 1,
    staleMs: 3_600_000,
    reclaimDeadImmediately: true,
  });
  if (!lock) {
    const error = new Error(`Server lifecycle operation is already running for ${path.resolve(directory)}`);
    error.code = "HONCHO_AGENT_BRIDGE_SERVER_LIFECYCLE_BUSY";
    error.operation = operation;
    throw error;
  }
  try { return await callback(); }
  finally { await releaseFileLock(lock); }
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

// A release bundle ships `honcho/` already filled. A plugin installed from the
// marketplace cannot: the Honcho source is AGPL and lives in its own repository,
// which is why `server/.gitignore` excludes the directory and why this package
// carries no Honcho code. `honcho-source.json` says where to get it instead.
const HONCHO_SOURCE_PIN = "honcho-source.json";

export async function honchoSourcePin(directory = sourceServerDir()) {
  return readSourcePin(directory, HONCHO_SOURCE_PIN);
}

export async function honchoSourceProbe(directory = sourceServerDir(), { runner = execFileAsync } = {}) {
  const target = path.join(directory, "honcho");
  const present = await exists(path.join(target, "Dockerfile"));
  if (present) return { present: true, directory: target, fetchable: false };
  const pin = await honchoSourcePin(directory);
  if (!pin.ok) return { present: false, directory: target, fetchable: false, reason: pin.reason };
  if (!(await gitAvailable(runner))) {
    return { present: false, directory: target, fetchable: false, pin, reason: "git is not installed, so the Honcho source cannot be fetched" };
  }
  return { present: false, directory: target, fetchable: true, pin };
}

// Clones into a sibling directory and renames, so an interrupted fetch never
// leaves a half-populated `honcho/` that bundleProbe would then accept.
export async function ensureHonchoSource(directory = sourceServerDir(), { runner = execFileAsync } = {}) {
  const probe = await honchoSourceProbe(directory, { runner });
  if (probe.present) return { ok: true, fetched: false, directory: probe.directory };
  if (!probe.fetchable) return { ok: false, fetched: false, directory: probe.directory, error: probe.reason };
  const { pin } = probe;
  const staging = `${probe.directory}.fetching`;
  await fsp.rm(staging, { recursive: true, force: true });
  try {
    const commit = await cloneSource(pin, staging, runner);
    await fsp.rename(staging, probe.directory);
    return { ok: true, fetched: true, directory: probe.directory, repo: pin.repo, ref: pin.ref, commit };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, fetched: false, directory: probe.directory, error: error?.stderr?.trim() || error?.message || String(error) };
  }
}

export async function dockerCliEnvironment(directory, {
  platform = process.platform,
  env = process.env,
} = {}) {
  const result = { ...env, COMPOSE_PROJECT_NAME: "honcho-agent-bridge" };
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

async function readEnvironmentFile(target) {
  try { return parseEnvironment(await fsp.readFile(target, "utf8")); }
  catch { return {}; }
}

async function managesCodexProxy() {
  const hostProfilePath = path.join(installedServerDir(), "host-profile.personal.json");
  try { return JSON.parse(await fsp.readFile(hostProfilePath, "utf8")).codexProxy?.enabled === true; }
  catch { return false; }
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
  if (["LLM_VLLM_BASE_URL", "LLM_OPENAI_COMPATIBLE_BASE_URL", "TRUSTED_HOSTS"].includes(key)) return true;
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
  const hostProfilePath = path.join(directory, "host-profile.personal.json");
  const managesProxy = profile === "personal" && await exists(hostProfilePath)
    && JSON.parse(await fsp.readFile(hostProfilePath, "utf8")).codexProxy?.enabled === true;
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
      if (managesProxy && localEndpointConfigured(templateEnvironment, 11435) && !String(currentEnvironment.LLM_VLLM_API_KEY || "").trim()) {
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
  if (managesProxy && localEndpointConfigured(templateEnvironment, 11435)) {
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

export async function serverPlan({
  profile = "portable",
  platform = process.platform,
  dockerInspector = dockerProbe,
  bundleInspector = bundleProbe,
  honchoSourceInspector = honchoSourceProbe,
} = {}) {
  requireServerProfile(profile);
  const [docker, bundle, honchoSource] = await Promise.all([dockerInspector(), bundleInspector(), honchoSourceInspector()]);
  const issues = [];
  const warnings = [];
  if (!docker.installed) issues.push("Docker CLI is not installed");
  else if (!docker.running) issues.push("Docker is installed but the engine is not running");
  if (!bundle.ok) {
    // Everything under honcho/ is fetched by prepare when a source pin is bundled,
    // so report the download instead of failing the plan over an absent directory.
    const onlyHonchoSource = bundle.missing.every(item => item.startsWith("honcho/"));
    if (onlyHonchoSource && honchoSource.fetchable) {
      warnings.push(`Honcho source will be downloaded from ${honchoSource.pin.repo} (${honchoSource.pin.commit || honchoSource.pin.ref})`);
    } else {
      const reason = onlyHonchoSource && honchoSource.reason ? ` (${honchoSource.reason})` : "";
      issues.push(`The bundled Honcho source is incomplete: ${bundle.missing.join(", ")}${reason}`);
    }
  }
  const profilePath = profile === "personal" ? "env.personal.example" : ".env.example";
  if (!(await exists(path.join(bundle.directory, profilePath)))) issues.push(`The ${profile} environment profile is not included`);
  if (profile === "personal") {
    if (platform === "linux") {
      issues.push("The personal host profile currently requires macOS or Windows; use the portable profile on native Linux");
    }
    const hostAssets = ["host-profile.personal.json", "host/supervisor.mjs", "host/qwen3-embedding-8192.Modelfile"];
    const missingHostAssets = [];
    for (const asset of hostAssets) if (!(await exists(path.join(bundle.directory, asset)))) missingHostAssets.push(asset);
    if (missingHostAssets.length) issues.push(`The personal host runtime is incomplete: ${missingHostAssets.join(", ")}`);
  }
  if (profile === "portable" && !process.env.LLM_OPENAI_API_KEY && !(await exists(path.join(bundle.directory, ".env")))) {
    warnings.push("No OpenAI key was supplied; add the required LLM key to server/.env before memory processing");
  }
  if (profile === "personal") {
    // A key is only invented for a proxy this install manages. When the proxy is
    // run elsewhere the key has to match that proxy's, so it can only be copied in
    // by hand — and saying nothing left Honcho calling the proxy with no key at all.
    const installedEnvironment = await readEnvironmentFile(path.join(installedServerDir(), ".env"));
    const templatePath = path.join(bundle.directory, profilePath);
    const template = await readEnvironmentFile(templatePath);
    const managed = await managesCodexProxy();
    const wantsProxy = localEndpointConfigured(template, 11435) || localEndpointConfigured(installedEnvironment, 11435);
    const hasSecret = Boolean(String(installedEnvironment.LLM_VLLM_API_KEY || "").trim());
    if (wantsProxy && !managed && !hasSecret) {
      warnings.push("Honcho is configured to reach a proxy this install does not manage; copy that proxy's shared secret into LLM_VLLM_API_KEY in server/.env");
    }
  }
  return {
    ok: issues.length === 0,
    ready: issues.length === 0,
    mode: "local-docker",
    profile,
    docker,
    bundle,
    installDirectory: installedServerDir(),
    honchoSource,
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

function transactionPath(target, label) {
  return `${target}.${label}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
}

function operationError(error) {
  return String(error?.message || error);
}

function errorWithRecovery(original, context, recovery) {
  const recoveryDetail = recovery?.issues?.length
    ? ` Rollback recovery also failed: ${recovery.issues.join("; ")}`
    : "";
  const wrapped = new Error(`${context}: ${operationError(original)}.${recoveryDetail}`, { cause: original });
  wrapped.code = "HONCHO_AGENT_BRIDGE_SERVER_UPDATE_FAILED";
  wrapped.rollback = recovery;
  return wrapped;
}

async function operationExists(fileSystem, target) {
  try { await fileSystem.access(target); return true; } catch { return false; }
}

function privateFileConfiguration(options = {}) {
  const { fileSystem = fsp, ...permissions } = options;
  return { fileSystem, permissions };
}

async function removeTransactionArtifact(fileSystem, target, label) {
  try {
    await fileSystem.rm(target, { recursive: true, force: true });
    return { ok: true, issues: [], retainedPaths: [] };
  } catch (error) {
    return {
      ok: false,
      issues: [`${label} cleanup failed: ${operationError(error)}`],
      retainedPaths: [target],
    };
  }
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

async function prepareBundleCandidate(source, destination, privateFileOptions = {}) {
  const { fileSystem, permissions } = privateFileConfiguration(privateFileOptions);
  const candidate = transactionPath(destination, "candidate");
  let currentEnvironment = null;
  try { currentEnvironment = await fileSystem.readFile(path.join(destination, ".env")); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
  }
  await fileSystem.rm(candidate, { recursive: true, force: true });
  try {
    await fileSystem.cp(source, candidate, { recursive: true, filter: item => path.basename(item) !== ".env" });
    if (currentEnvironment) {
      const candidateEnvironment = path.join(candidate, ".env");
      await fileSystem.writeFile(candidateEnvironment, currentEnvironment, { mode: 0o600 });
      await securePrivateFile(candidateEnvironment, permissions);
    }
    return { path: candidate, fileSystem, permissions };
  } catch (error) {
    const cleanup = await removeTransactionArtifact(fileSystem, candidate, "candidate bundle");
    if (!cleanup.ok) throw errorWithRecovery(error, "Server bundle candidate preparation failed", cleanup);
    throw error;
  }
}

async function beginBundleSwap(candidate, destination, fileSystem = fsp) {
  const previous = `${destination}.previous`;
  const savedPrevious = transactionPath(previous, "saved");
  const failedCandidate = transactionPath(destination, "failed");
  const hadDestination = await operationExists(fileSystem, destination);
  const hadPrevious = await operationExists(fileSystem, previous);
  let previousSaved = false;
  let currentMoved = false;

  try {
    await fileSystem.mkdir(path.dirname(destination), { recursive: true });
    if (hadPrevious) {
      await fileSystem.rename(previous, savedPrevious);
      previousSaved = true;
    }
    if (hadDestination) {
      await fileSystem.rename(destination, previous);
      currentMoved = true;
    }
    await fileSystem.rename(candidate, destination);
  } catch (error) {
    const issues = [];
    const retainedPaths = [];
    let restorationFailed = false;
    let displacedCandidate = false;
    if ((currentMoved || !hadDestination) && await operationExists(fileSystem, destination)) {
      try {
        await fileSystem.rename(destination, failedCandidate);
        displacedCandidate = true;
      } catch (restoreError) {
        issues.push(`candidate displacement failed: ${operationError(restoreError)}`);
        retainedPaths.push(destination);
        restorationFailed = true;
      }
    }
    if (currentMoved && !(await operationExists(fileSystem, destination))) {
      try { await fileSystem.rename(previous, destination); }
      catch (restoreError) {
        issues.push(`current bundle restoration failed: ${operationError(restoreError)}`);
        retainedPaths.push(previous);
        restorationFailed = true;
      }
    }
    if (previousSaved && !(await operationExists(fileSystem, previous))) {
      try { await fileSystem.rename(savedPrevious, previous); }
      catch (restoreError) {
        issues.push(`prior backup restoration failed: ${operationError(restoreError)}`);
        retainedPaths.push(savedPrevious);
        restorationFailed = true;
      }
    }
    if (displacedCandidate) {
      const cleanup = await removeTransactionArtifact(fileSystem, failedCandidate, "displaced candidate bundle");
      issues.push(...cleanup.issues);
      retainedPaths.push(...cleanup.retainedPaths);
    }
    const candidateCleanup = await removeTransactionArtifact(fileSystem, candidate, "candidate bundle");
    issues.push(...candidateCleanup.issues);
    retainedPaths.push(...candidateCleanup.retainedPaths);
    const recovery = {
      ok: issues.length === 0,
      restored: !restorationFailed,
      destination,
      previous,
      issues,
      retainedPaths: uniquePaths(retainedPaths),
    };
    if (!issues.length) throw error;
    throw errorWithRecovery(error, "Server bundle swap failed", recovery);
  }

  let finished = false;
  return {
    destination,
    previous,
    hadDestination,
    hadPrevious,
    async commit() {
      if (finished) return { ok: true, committed: true, destination, previous: hadDestination ? previous : null, issues: [], retainedPaths: [] };
      finished = true;
      const issues = [];
      const retainedPaths = [];
      if (previousSaved) {
        const cleanup = await removeTransactionArtifact(fileSystem, savedPrevious, "retired backup bundle");
        issues.push(...cleanup.issues);
        retainedPaths.push(...cleanup.retainedPaths);
      }
      return {
        ok: issues.length === 0,
        committed: true,
        destination,
        previous: hadDestination ? previous : null,
        issues,
        retainedPaths: uniquePaths(retainedPaths),
      };
    },
    async rollback() {
      if (finished) return {
        ok: false,
        restored: false,
        destination,
        previous,
        issues: ["bundle transaction is already finished"],
        retainedPaths: [destination],
      };
      finished = true;
      const issues = [];
      const retainedPaths = [];
      let restorationFailed = false;
      let newBundleMoved = false;
      if (await operationExists(fileSystem, destination)) {
        try {
          await fileSystem.rename(destination, failedCandidate);
          newBundleMoved = true;
        } catch (error) {
          issues.push(`candidate displacement failed: ${operationError(error)}`);
          retainedPaths.push(destination);
          restorationFailed = true;
        }
      }
      if (hadDestination && !(await operationExists(fileSystem, destination))) {
        try { await fileSystem.rename(previous, destination); }
        catch (error) {
          issues.push(`current bundle restoration failed: ${operationError(error)}`);
          retainedPaths.push(previous);
          restorationFailed = true;
        }
      }
      if (previousSaved && !(await operationExists(fileSystem, previous))) {
        try { await fileSystem.rename(savedPrevious, previous); }
        catch (error) {
          issues.push(`prior backup restoration failed: ${operationError(error)}`);
          retainedPaths.push(savedPrevious);
          restorationFailed = true;
        }
      }
      if (!hadDestination && await operationExists(fileSystem, destination)) {
        issues.push("fresh candidate installation could not be removed");
        retainedPaths.push(destination);
        restorationFailed = true;
      }
      if (newBundleMoved) {
        const oldRestored = !hadDestination || await operationExists(fileSystem, destination);
        if (oldRestored) {
          const cleanup = await removeTransactionArtifact(fileSystem, failedCandidate, "failed candidate bundle");
          issues.push(...cleanup.issues);
          retainedPaths.push(...cleanup.retainedPaths);
        }
        else {
          try {
            await fileSystem.rename(failedCandidate, destination);
            retainedPaths.push(destination);
          } catch (error) {
            issues.push(`candidate safety restoration failed: ${operationError(error)}`);
            retainedPaths.push(failedCandidate);
          }
          restorationFailed = true;
        }
      }
      return {
        ok: issues.length === 0,
        restored: !restorationFailed,
        removedFreshInstall: !hadDestination && !(await operationExists(fileSystem, destination)),
        destination,
        previous: hadPrevious ? previous : null,
        issues,
        retainedPaths: uniquePaths(retainedPaths),
      };
    },
  };
}

export async function copyServerBundle(source, destination, privateFileOptions = {}) {
  if (path.resolve(source) === path.resolve(destination)) return { changed: false, source, destination };
  const candidate = await prepareBundleCandidate(source, destination, privateFileOptions);
  const transaction = await beginBundleSwap(candidate.path, destination, candidate.fileSystem);
  const committed = await transaction.commit();
  return {
    ok: committed.ok,
    changed: true,
    source,
    destination,
    previous: transaction.hadDestination ? transaction.previous : null,
    ...(committed.issues.length ? { warnings: committed.issues } : {}),
    ...(!committed.ok ? { cleanup: committed, retainedPaths: committed.retainedPaths } : {}),
  };
}

async function recoverPersonalUpdate({
  transaction = null,
  bundleRecovery = null,
  previouslyRunning,
  hostRuntime,
  profile,
  installedServerDir: installed,
}) {
  const issues = [];
  let bundle = bundleRecovery || { ok: true, restored: true, destination: installed, issues: [], retainedPaths: [] };
  if (transaction) {
    try { bundle = await transaction.rollback(); }
    catch (error) {
      bundle = {
        ok: false,
        restored: false,
        destination: installed,
        issues: [operationError(error)],
        retainedPaths: [installed, `${installed}.previous`],
      };
    }
  }
  for (const issue of bundle.issues || []) issues.push(`bundle rollback: ${issue}`);

  let hostPreparation = null;
  let hostStartResult = null;
  if (previouslyRunning) {
    if (!bundle.restored) {
      issues.push("host recovery was skipped because the prior server bundle was not restored safely");
    } else {
      try {
        hostPreparation = await hostRuntime.prepare({ profile, installedServerDir: installed });
        if (!hostPreparation?.ok || !hostPreparation?.ready) {
          const detail = hostPreparation?.issues?.join("; ") || "the restored host runtime was not ready";
          issues.push(`host re-prepare: ${detail}`);
        }
      } catch (error) {
        issues.push(`host re-prepare: ${operationError(error)}`);
      }
      if (hostPreparation?.ok && hostPreparation?.ready) {
        try {
          hostStartResult = await hostRuntime.start({ profile, installedServerDir: installed, skipPrepare: true });
          if (!hostStartResult?.ok || hostStartResult?.running === false) {
            const detail = hostStartResult?.issues?.join("; ") || "the restored host runtime did not start";
            issues.push(`host restart: ${detail}`);
          }
        } catch (error) {
          issues.push(`host restart: ${operationError(error)}`);
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    restored: Boolean(bundle.restored),
    bundle,
    host: previouslyRunning ? { prepare: hostPreparation, start: hostStartResult } : null,
    issues,
    retainedPaths: uniquePaths(bundle.retainedPaths || []),
  };
}

async function serverPrepareUnlocked({
  profile = "portable",
  hostRuntime = DEFAULT_HOST_RUNTIME,
  preparedPlan = null,
  serverDirectory = null,
  platform = process.platform,
  env = process.env,
  privateFileRunner,
  fileSystem,
  honchoSourceFetcher = ensureHonchoSource,
} = {}) {
  requireServerProfile(profile);
  // The download happens here and never in `server plan`, which must not mutate.
  const honchoSource = await honchoSourceFetcher();
  if (!honchoSource.ok) {
    return {
      ok: false,
      ready: false,
      mode: "local-docker",
      profile,
      honchoSource,
      issues: [`The Honcho source could not be prepared: ${honchoSource.error}`],
      next: "Make the Honcho source repository reachable, or install a release bundle that already contains server/honcho",
    };
  }
  const plan = preparedPlan || await serverPlan({ profile });
  if (!plan.ready) return plan;
  const installed = path.resolve(serverDirectory || installedServerDir());
  const privateFileOptions = {
    platform,
    env,
    ...(privateFileRunner ? { run: privateFileRunner } : {}),
    ...(fileSystem ? { fileSystem } : {}),
  };

  if (profile !== "personal") {
    const installation = await copyServerBundle(plan.bundle.directory, installed, privateFileOptions);
    if (installation.ok === false) {
      const issues = installation.cleanup?.issues || installation.warnings || ["Server bundle cleanup failed"];
      const retainedPaths = uniquePaths(installation.retainedPaths || installation.cleanup?.retainedPaths || []);
      return {
        ok: false,
        ready: false,
        mode: "local-docker",
        profile,
        installation,
        missingSecretFields: [],
        issues,
        retainedPaths,
        next: "Remove the retained secret-bearing backup paths reported by cleanup before retrying",
      };
    }
    const environment = await initializeEnvironment(installed, profile, privateFileOptions);
    const missingSecretFields = await missingLlmSecrets(environment.path);
    return {
      ok: true,
      ready: missingSecretFields.length === 0,
      mode: "local-docker",
      profile,
      installation,
      environment,
      missingSecretFields,
      next: missingSecretFields.length
        ? `Fill the listed fields in ${environment.path}, then run server start`
        : "Run server start",
    };
  }

  const hadInstalledBundle = await exists(installed);
  const candidate = await prepareBundleCandidate(plan.bundle.directory, installed, privateFileOptions);
  let candidateEnvironment;
  let missingSecretFields;
  try {
    candidateEnvironment = await initializeEnvironment(candidate.path, profile, privateFileOptions);
    missingSecretFields = await missingLlmSecrets(candidateEnvironment.path);
  } catch (error) {
    const cleanup = await removeTransactionArtifact(candidate.fileSystem, candidate.path, "candidate bundle");
    if (!cleanup.ok) throw errorWithRecovery(error, "Personal server candidate validation failed", cleanup);
    throw error;
  }
  const environment = { ...candidateEnvironment, path: path.join(installed, ".env") };
  if (missingSecretFields.length) {
    const cleanup = await removeTransactionArtifact(candidate.fileSystem, candidate.path, "rejected candidate bundle");
    return {
      ok: cleanup.ok,
      ready: false,
      mode: "local-docker",
      profile,
      installation: { changed: false, source: plan.bundle.directory, destination: installed, candidateRejected: true },
      environment: { ...environment, installed: hadInstalledBundle, candidateInstalled: false },
      missingSecretFields,
      cleanup,
      ...(cleanup.issues.length ? { issues: cleanup.issues, retainedPaths: cleanup.retainedPaths } : {}),
      hostStoppedForUpdate: false,
      next: cleanup.ok
        ? `Provide the listed secret fields in the source or existing ${path.join(installed, ".env")}, then run server prepare again`
        : "Remove the retained secret-bearing candidate path reported by cleanup before retrying",
    };
  }

  let hostStoppedForUpdate = false;
  let previouslyRunning = false;
  if (hadInstalledBundle) {
    let existingHost;
    try { existingHost = await hostRuntime.status({ profile, installedServerDir: installed }); }
    catch {
      const cleanup = await removeTransactionArtifact(candidate.fileSystem, candidate.path, "candidate bundle");
      return {
        ok: false,
        ready: false,
        mode: "local-docker",
        profile,
        issues: [
          "The existing host runtime could not be inspected safely before the server update",
          ...cleanup.issues,
        ],
        cleanup,
        ...(cleanup.retainedPaths.length ? { retainedPaths: cleanup.retainedPaths } : {}),
        hostStoppedForUpdate: false,
      };
    }
    previouslyRunning = Boolean(existingHost.running || existingHost.supervisor?.processAlive);
    if (previouslyRunning) {
      let stopped;
      try { stopped = await hostRuntime.stop({ profile, installedServerDir: installed }); }
      catch (error) {
        const cleanup = await removeTransactionArtifact(candidate.fileSystem, candidate.path, "candidate bundle");
        return {
          ok: false,
          ready: false,
          mode: "local-docker",
          profile,
          issues: [
            `The existing host runtime could not be stopped safely before the server update: ${operationError(error)}`,
            ...cleanup.issues,
          ],
          cleanup,
          ...(cleanup.retainedPaths.length ? { retainedPaths: cleanup.retainedPaths } : {}),
          hostStoppedForUpdate: false,
        };
      }
      if (!stopped.ok || !stopped.stopped) {
        const cleanup = await removeTransactionArtifact(candidate.fileSystem, candidate.path, "candidate bundle");
        return {
          ok: false,
          ready: false,
          mode: "local-docker",
          profile,
          issues: [
            "The existing host runtime could not be stopped safely before the server update",
            ...cleanup.issues,
          ],
          host: stopped,
          cleanup,
          ...(cleanup.retainedPaths.length ? { retainedPaths: cleanup.retainedPaths } : {}),
          hostStoppedForUpdate: false,
        };
      }
      hostStoppedForUpdate = true;
    }
  }

  let transaction;
  try {
    transaction = await beginBundleSwap(candidate.path, installed, candidate.fileSystem);
  } catch (error) {
    const recovery = await recoverPersonalUpdate({
      bundleRecovery: error.rollback || { ok: true, restored: true, destination: installed, issues: [] },
      previouslyRunning,
      hostRuntime,
      profile,
      installedServerDir: installed,
    });
    throw errorWithRecovery(error, "Personal server bundle installation failed", recovery);
  }

  let host;
  try {
    host = await hostRuntime.prepare({ profile, installedServerDir: installed });
  } catch (error) {
    const recovery = await recoverPersonalUpdate({
      transaction,
      previouslyRunning,
      hostRuntime,
      profile,
      installedServerDir: installed,
    });
    throw errorWithRecovery(error, "Personal host preparation failed", recovery);
  }

  if (!host?.ok || !host?.ready) {
    const recovery = await recoverPersonalUpdate({
      transaction,
      previouslyRunning,
      hostRuntime,
      profile,
      installedServerDir: installed,
    });
    const originalIssues = host?.issues?.length ? host.issues : ["The candidate host runtime was not ready"];
    return {
      ok: false,
      ready: false,
      mode: "local-docker",
      profile,
      installation: { changed: false, source: plan.bundle.directory, destination: installed, rolledBack: true },
      environment: { ...environment, installed: hadInstalledBundle, candidateInstalled: false },
      missingSecretFields,
      host,
      rollback: recovery,
      ...(recovery.retainedPaths.length ? { retainedPaths: recovery.retainedPaths } : {}),
      issues: [
        ...originalIssues,
        ...recovery.issues.map(issue => `Rollback recovery: ${issue}`),
      ],
      hostStoppedForUpdate,
      next: recovery.ok
        ? "The previous server was restored; resolve the candidate host-service issue, then run server prepare again"
        : "The update failed and automatic recovery was incomplete; inspect the rollback report before retrying",
    };
  }

  const committed = await transaction.commit();
  const result = {
    ok: committed.ok,
    ready: committed.ok,
    mode: "local-docker",
    profile,
    installation: {
      changed: true,
      source: plan.bundle.directory,
      destination: installed,
      previous: transaction.hadDestination ? transaction.previous : null,
      ...(committed.issues.length ? { warnings: committed.issues } : {}),
      ...(!committed.ok ? { cleanup: committed, retainedPaths: committed.retainedPaths } : {}),
    },
    environment,
    missingSecretFields,
    ...(committed.issues.length ? { issues: committed.issues, retainedPaths: committed.retainedPaths } : {}),
    next: committed.ok
      ? "Run server start"
      : "Remove the retained retired-backup path reported by cleanup before starting the server",
    host,
    hostStoppedForUpdate,
  };
  return result;
}

export async function serverPrepare(options = {}) {
  const profile = options.profile || "portable";
  requireServerProfile(profile);
  const installed = path.resolve(options.serverDirectory || installedServerDir());
  return withServerLifecycleLock(installed, "prepare", () => serverPrepareUnlocked({
    ...options,
    profile,
    serverDirectory: installed,
  }));
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

async function serverStartUnlocked({
  profile = "portable",
  build = true,
  hostRuntime = DEFAULT_HOST_RUNTIME,
  preparedServer = null,
  preparedPlan = null,
  serverDirectory = null,
  composeRunner = compose,
  healthWaiter = waitForHealth,
} = {}) {
  requireServerProfile(profile);
  const installed = path.resolve(serverDirectory || installedServerDir());
  const prepared = preparedServer || await serverPrepareUnlocked({
    profile,
    hostRuntime,
    preparedPlan,
    serverDirectory: installed,
  });
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

export async function serverStart(options = {}) {
  const profile = options.profile || "portable";
  requireServerProfile(profile);
  const installed = path.resolve(options.serverDirectory || installedServerDir());
  return withServerLifecycleLock(installed, "start", () => serverStartUnlocked({
    ...options,
    profile,
    serverDirectory: installed,
  }));
}

export async function serverStatus({
  profile = "portable",
  hostRuntime = DEFAULT_HOST_RUNTIME,
  serverDirectory = null,
  dockerInspector = dockerProbe,
  composeRunner = compose,
  healthWaiter = waitForHealth,
} = {}) {
  requireServerProfile(profile);
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

async function serverStopUnlocked({
  profile = "portable",
  hostRuntime = DEFAULT_HOST_RUNTIME,
  serverDirectory = null,
  composeRunner = compose,
} = {}) {
  requireServerProfile(profile);
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

export async function serverStop(options = {}) {
  const profile = options.profile || "portable";
  requireServerProfile(profile);
  const installed = path.resolve(options.serverDirectory || installedServerDir());
  return withServerLifecycleLock(installed, "stop", () => serverStopUnlocked({
    ...options,
    profile,
    serverDirectory: installed,
  }));
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
  const environment = await readEnvironmentFile(path.join(directory, ".env"));
  const targets = containerHostTargets(environment);
  const skipped = { ok: true, status: null, skipped: true };
  if (!Object.keys(targets).length) {
    return { ok: true, ollama: skipped, proxy: skipped, skipped: true };
  }
  let result;
  try {
    result = await composeRunner(directory, [
      "exec",
      "-T",
      "api",
      "python",
      "-c",
      containerHostProbeScript(targets),
    ], { timeout: 30_000 });
  } catch {
    return {
      ok: false,
      ollama: targets.ollama ? { ok: false, status: null } : skipped,
      proxy: targets.proxy ? { ok: false, status: null } : skipped,
      error: "Docker API-container host connectivity probe failed",
    };
  }
  let document = null;
  try {
    const line = String(result?.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
    document = line ? JSON.parse(line) : null;
  } catch {}
  const reading = (name) => {
    if (!targets[name]) return skipped;
    return {
      ok: Boolean(document?.[name]?.ok),
      status: Number.isInteger(document?.[name]?.status) ? document[name].status : null,
    };
  };
  const ollama = reading("ollama");
  const proxy = reading("proxy");
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
  requireServerProfile(profile);
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
