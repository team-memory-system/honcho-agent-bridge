import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installPaths } from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import {
  chooseChatModel,
  DEFAULT_GATEWAY_ROUTER_URL,
  DEFAULT_GATEWAY_UI_URL,
  ensureGatewaySource,
  gatewayConnectInfo,
  gatewayDirectory,
  gatewayEnvironment,
  gatewayLoginAction,
  gatewaySourceProbe,
  installedChatModel,
  loopbackUrl,
  prepareGateway,
} from "./gateway.mjs";
import {
  DEFAULT_EMBEDDING_ALIAS,
  EMBEDDING_ALIASES,
  embeddingAliasBase,
  hostPrepare,
  hostStart,
  hostStatus,
  hostStop,
} from "./host-manager.mjs";
import { securePrivateFile, writePrivateFileAtomic } from "./private-file-permissions.mjs";
import {
  clearDockerFirstRun,
  DOCKER_LICENSE_WARNING,
  dockerDesktopDownload,
  dockerFirstRunAction,
  dockerFirstRunPending,
  dockerPathEnvironment,
  launchDockerDesktop,
  locateOllama,
  ollamaDownload,
  ollamaRuntimeDir,
  prepareRuntime,
  resolveDockerCli,
  runtimeRoot,
} from "./runtime-installer.mjs";
import { cloneSource, gitAvailable, readSourcePin } from "./source-pin.mjs";
import { prepareHonchoTree } from "./honcho-source.mjs";

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
 * endpoint the environment never configured is not a failure: requiring one
 * unconditionally is what once made `server verify` impossible to pass on an
 * install that had none.
 */
function containerHostTargets(environment) {
  const ollama = containerHostHealthUrl(
    environment.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL || environment.LLM_OPENAI_COMPATIBLE_BASE_URL,
    "/api/version",
  );
  // The gateway's router answers /health without a key.
  const router = containerHostHealthUrl(
    environment.DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL || environment.LLM_VLLM_BASE_URL,
    "/health",
  );
  const targets = {};
  if (ollama) targets.ollama = ollama;
  if (router) targets.router = router;
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

export async function withServerLifecycleLock(directory, operation, callback) {
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

/**
 * Whether Docker's CLI and engine answer. The CLI is the one on PATH, else the one
 * inside Docker Desktop (see resolveDockerCli), so a just-installed Docker Desktop
 * is seen before its first run links the CLI onto PATH.
 */
export async function dockerProbe({
  platform = process.platform,
  env = process.env,
  resolver = resolveDockerCli,
  exec = execFileAsync,
} = {}) {
  const cli = resolver({ platform, env });
  if (!cli) return { installed: false, running: false, error: "docker was not found on PATH or inside Docker Desktop" };
  const runEnv = dockerPathEnvironment(cli, env, platform);
  const found = { cli: cli.path, cliSource: cli.source };
  try {
    const { stdout: version } = await exec(cli.path, ["compose", "version", "--short"], { timeout: 5_000, env: runEnv });
    await exec(cli.path, ["info", "--format", "{{.ServerVersion}}"], { timeout: 5_000, env: runEnv });
    return { installed: true, running: true, composeVersion: String(version).trim(), ...found };
  } catch (error) {
    const message = String(error?.stderr || error?.message || error).trim();
    return { installed: !/ENOENT/i.test(message), running: false, error: message, ...found };
  }
}

/** The Docker Desktop app this installer can start, or "" when there is none. */
export async function dockerDesktopApp({ platform = process.platform, env = process.env, home = process.env.HOME || "" } = {}) {
  const candidates = platform === "darwin"
    ? ["/Applications/Docker.app", path.join(home, "Applications", "Docker.app")]
    : platform === "win32"
      ? [
        path.join(env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
        ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Programs", "DockerDesktop", "Docker Desktop.exe")] : []),
      ]
      : [];
  for (const candidate of candidates) if (candidate && await exists(candidate)) return candidate;
  return "";
}

/**
 * Start Docker Desktop when it is installed but not running, and wait for its
 * engine. A teammate's first install usually finds it closed.
 */
export async function ensureDockerRunning({
  platform = process.platform,
  inspector = dockerProbe,
  appFinder = dockerDesktopApp,
  launcher = launchDockerDesktop,
  timeoutMs = 180_000,
  intervalMs = 3_000,
} = {}) {
  const first = await inspector();
  if (first.running || !first.installed) return { ...first, started: false };
  const app = await appFinder({ platform });
  if (!app) return { ...first, started: false };
  launcher(app, platform);
  const deadline = Date.now() + timeoutMs;
  let latest = first;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latest = await inspector();
    if (latest.running) return { ...latest, started: true, app };
  }
  return { ...latest, started: false, app, error: `Docker Desktop was started but its engine did not answer within ${Math.round(timeoutMs / 1000)} seconds` };
}

const DEFAULT_API_PORT = 8001;
const DEFAULT_DASHBOARD_PORT = 4173;
export const DEFAULT_GATE_PORT = 8010;
const PORT_SEARCH_SPAN = 20;

/** True when something on this machine already answers or holds 127.0.0.1:port. */
export async function portInUse(port) {
  const answers = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  if (answers) return true;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(false)));
  });
}

async function firstFreePort(start, inUse) {
  for (let port = start; port < start + PORT_SEARCH_SPAN; port += 1) {
    if (!(await inUse(port))) return port;
  }
  throw new Error(`No free port between ${start} and ${start + PORT_SEARCH_SPAN - 1} on 127.0.0.1`);
}

/**
 * Ports for a new install. 8001 is a common port (another Honcho, an SSH tunnel),
 * so a busy default moves to the next free one instead of failing at compose up.
 */
export async function chooseServerPorts({ inUse = portInUse } = {}) {
  const api = await firstFreePort(DEFAULT_API_PORT, inUse);
  const dashboard = await firstFreePort(DEFAULT_DASHBOARD_PORT, inUse);
  return { api, dashboard };
}

/**
 * The port the share gate publishes on 127.0.0.1: 8010, or the next free one. It is
 * chosen the first time sharing is turned on and kept in the .env from then on.
 */
export async function chooseGatePort({ inUse = portInUse } = {}) {
  return firstFreePort(DEFAULT_GATE_PORT, inUse);
}

/** The ports an installed server uses, as its private .env says. */
export async function installedServerPorts(directory = installedServerDir()) {
  const environmentPath = path.join(directory, ".env");
  const installed = await exists(environmentPath);
  const environment = installed ? await readEnvironmentFile(environmentPath) : {};
  return {
    installed,
    api: Number(environment.HONCHO_API_PORT) || DEFAULT_API_PORT,
    dashboard: Number(environment.HONCHO_DASHBOARD_PORT) || DEFAULT_DASHBOARD_PORT,
  };
}

/** The chat model the installed server's .env points every chat setting at. */
export async function installedServerModel(directory = installedServerDir()) {
  try {
    return installedChatModel(await readEnvironmentFile(path.join(directory, ".env"))) || "";
  } catch {
    return "";
  }
}

function serverUrls(ports) {
  return { apiUrl: `http://127.0.0.1:${ports.api}`, dashboardUrl: `http://127.0.0.1:${ports.dashboard}` };
}

/** Port values to write into the private .env: kept when installed, chosen when new. */
async function portEnvironment(installed, portChooser) {
  const current = await installedServerPorts(installed);
  const ports = current.installed ? current : await portChooser();
  return { HONCHO_API_PORT: String(ports.api), HONCHO_DASHBOARD_PORT: String(ports.dashboard) };
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
  const prepared = `${probe.directory}.prepared`;
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.rm(prepared, { recursive: true, force: true });
  try {
    // The wrapper needs Git long enough to initialize and verify its official
    // upstream submodule. Only the prepared flat source is installed.
    const commit = await cloneSource(pin, staging, runner, { keepGit: true });
    await prepareHonchoTree(staging, prepared, { runner });
    await fsp.rename(prepared, probe.directory);
    return { ok: true, fetched: true, directory: probe.directory, repo: pin.repo, ref: pin.ref, commit };
  } catch (error) {
    return { ok: false, fetched: false, directory: probe.directory, error: error?.stderr?.trim() || error?.message || String(error) };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(prepared, { recursive: true, force: true }).catch(() => {});
  }
}

export async function dockerCliEnvironment(directory, {
  platform = process.platform,
  env = process.env,
  cli = null,
} = {}) {
  const result = { ...dockerPathEnvironment(cli, env, platform), COMPOSE_PROJECT_NAME: "honcho-agent-bridge" };
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

export async function compose(directory, args, options = {}) {
  // The docker on PATH, else Docker Desktop's own copy (see resolveDockerCli).
  const cli = options.dockerCli === undefined ? resolveDockerCli() : options.dockerCli;
  const env = await dockerCliEnvironment(directory, { cli });
  // Which optional services run (the share gate) is the installed .env's to say,
  // not whatever the shell that started this happened to export.
  const profiles = (await readEnvironmentFile(path.join(directory, ".env"))).COMPOSE_PROFILES;
  if (profiles) env.COMPOSE_PROFILES = profiles;
  else delete env.COMPOSE_PROFILES;
  return (options.exec || execFileAsync)(cli?.path || "docker", ["compose", "--project-directory", directory, ...args], {
    cwd: directory,
    timeout: options.timeout || 900_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
}

export function replaceEnvironment(text, values) {
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

export function parseEnvironment(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

export async function readEnvironmentFile(target) {
  try { return parseEnvironment(await fsp.readFile(target, "utf8")); }
  catch { return {}; }
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
  // The vectors already in this install's database were made by the embedding
  // alias it names, so a known alias is kept even when the template names another.
  if (embeddingAliasBase(current.EMBEDDING_MODEL_CONFIG__MODEL)) {
    values.EMBEDDING_MODEL_CONFIG__MODEL = current.EMBEDDING_MODEL_CONFIG__MODEL;
  }
  const withoutConflictingModelKeys = currentText.split(/\r?\n/).filter((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !isPersonalModelConfigKey(match[1])) return true;
    return isManagedPersonalTopologyKey(match[1]);
  }).join("\n");
  return replaceEnvironment(withoutConflictingModelKeys, values);
}

/**
 * Create or update the private .env. `overrides` are applied last, over the profile
 * template and anything already there: for the personal profile they are the
 * gateway's router address, its key and the chosen chat model.
 */
async function initializeEnvironment(directory, profile = "portable", privateFileOptions = {}, overrides = {}) {
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
    }
    const current = replaceEnvironment(original, generatedValues);
    const profiled = profile === "personal" && candidateExists
      ? mergePersonalProfileEnvironment(current, profileText)
      : current;
    const merged = Object.keys(overrides).length ? replaceEnvironment(profiled, overrides) : profiled;
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
  for (const [key, value] of Object.entries(process.env)) {
    if (/^LLM_[A-Z0-9_]*API_KEY$/.test(key) && value) values[key] = value;
  }
  text = replaceEnvironment(text, { ...values, ...overrides });
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

/** Where the bundled host profile expects the gateway to answer. */
async function gatewayAddresses(bundleDirectory) {
  let profile = null;
  try { profile = JSON.parse(await fsp.readFile(path.join(bundleDirectory, "host-profile.personal.json"), "utf8")); }
  catch {}
  return {
    uiUrl: loopbackUrl(profile?.gateway?.uiUrl, { keepPath: true }) || DEFAULT_GATEWAY_UI_URL,
    routerUrl: loopbackUrl(profile?.gateway?.routerUrl, { keepPath: true }) || DEFAULT_GATEWAY_ROUTER_URL,
  };
}

/**
 * The embedding alias prepare is going to make ready: the known alias an installed
 * .env already names (its vectors were made by it), otherwise the bundled profile's.
 */
async function plannedEmbedding(bundleDirectory, installDirectory) {
  let profile = null;
  try { profile = JSON.parse(await fsp.readFile(path.join(bundleDirectory, "host-profile.personal.json"), "utf8")); }
  catch {}
  const installed = (await readEnvironmentFile(path.join(installDirectory, ".env"))).EMBEDDING_MODEL_CONFIG__MODEL;
  const model = embeddingAliasBase(installed) ? installed : (profile?.ollama?.model || DEFAULT_EMBEDDING_ALIAS);
  const baseModel = embeddingAliasBase(model) || profile?.ollama?.baseModel || EMBEDDING_ALIASES[DEFAULT_EMBEDDING_ALIAS];
  const contextLength = Number(profile?.ollama?.contextLength) || 8192;
  return { model, baseModel, contextLength };
}

/** What `server prepare --profile personal` is going to do, in order. */
function personalOperations({ honchoSource, gateway, bundle, installDirectory, embedding }) {
  const operations = [];
  if (!honchoSource.present && honchoSource.fetchable) {
    operations.push({ type: "fetch-honcho-source", repo: honchoSource.pin.repo, ref: honchoSource.pin.commit || honchoSource.pin.ref });
  }
  if (gateway.source.fetchable) {
    operations.push({
      type: gateway.source.state === "stale" ? "update-gateway-source" : "fetch-gateway-source",
      repo: gateway.source.pin.repo,
      ref: gateway.source.pin.commit || gateway.source.pin.ref,
      directory: gateway.directory,
    });
  }
  operations.push(
    {
      type: "gateway-install",
      directory: gateway.directory,
      uiUrl: gateway.uiUrl,
      note: "the gateway's own install: its npm dependencies, its own per-user autostart, and its screen",
    },
    {
      type: "gateway-connect",
      uiUrl: gateway.uiUrl,
      note: "asks the gateway for its router and key; stops here until a Codex or Claude login is connected in the gateway screen",
    },
    {
      type: "write-environment",
      target: path.join(installDirectory, ".env"),
      note: "the router address, its key and the chosen chat model for every chat setting; embeddings stay on Ollama",
    },
    { type: "install-bundle", source: bundle.directory, destination: installDirectory },
    {
      type: "prepare-ollama",
      model: embedding.model,
      baseModel: embedding.baseModel,
      note: `${embedding.baseModel} and its ${embedding.contextLength}-token alias ${embedding.model}`,
    },
  );
  return operations;
}

/**
 * What the personal profile has to download before anything else: Docker Desktop
 * when neither its CLI nor its app is here, and Ollama when no copy is found. Each
 * is null when it is already here, and `unavailable` when there is no download for
 * this machine.
 */
export async function personalRuntimeNeeds({
  platform = process.platform,
  arch = os.arch(),
  env = process.env,
  installDirectory = installedServerDir(),
  docker,
  dockerAppFinder = dockerDesktopApp,
  ollamaLocator = null,
} = {}) {
  const runtimeDir = runtimeRoot(installDirectory);
  const ollamaDir = ollamaRuntimeDir(installDirectory);
  let dockerNeed = null;
  let dockerApp = "";
  if (!docker.running) dockerApp = await dockerAppFinder({ platform, env });
  if (!docker.installed && !dockerApp) {
    const download = dockerDesktopDownload({ platform, arch, env, runtimeDir });
    dockerNeed = download
      ? {
        type: "install-docker-desktop",
        url: download.url,
        destination: download.destination,
        download: download.download,
        note: platform === "win32"
          ? "Windows asks for administrator approval (UAC) to install it; Docker's first-run window may follow"
          : "copied into /Applications; Docker's first-run window then asks to accept its terms and, for the recommended settings, your macOS password",
      }
      : { unavailable: true };
  }
  const found = await (ollamaLocator
    ? ollamaLocator({ platform, env, ollamaDir })
    : locateOllama({ platform, env, homeDir: env.HONCHO_AGENT_BRIDGE_USER_HOME || env.HOME || env.USERPROFILE || os.homedir(), ollamaDir }));
  let ollamaNeed = null;
  if (!found) {
    const download = ollamaDownload({ platform, arch, ollamaDir });
    ollamaNeed = download
      ? { type: "install-ollama", url: download.url, destination: download.destination, checksums: download.checksums }
      : { unavailable: true };
  }
  return { runtimeDir, dockerApp, docker: dockerNeed, ollama: ollamaNeed, ollamaFound: found || null };
}

export async function serverPlan({
  profile = "portable",
  platform = process.platform,
  arch = os.arch(),
  env = process.env,
  dockerInspector = dockerProbe,
  dockerAppFinder = dockerDesktopApp,
  ollamaLocator = null,
  bundleInspector = bundleProbe,
  honchoSourceInspector = honchoSourceProbe,
  gatewaySourceInspector = null,
  portChooser = chooseServerPorts,
} = {}) {
  requireServerProfile(profile);
  const [docker, bundle, honchoSource] = await Promise.all([dockerInspector(), bundleInspector(), honchoSourceInspector()]);
  const issues = [];
  const warnings = [];
  // The personal profile gets Docker Desktop and Ollama itself on macOS and
  // Windows; a missing one is then an operation, not an issue.
  const installsRuntime = profile === "personal" && (platform === "darwin" || platform === "win32");
  const runtime = installsRuntime
    ? await personalRuntimeNeeds({ platform, arch, env, installDirectory: installedServerDir(), docker, dockerAppFinder, ollamaLocator })
    : null;
  const dockerApp = runtime
    ? runtime.dockerApp
    : (docker.installed && !docker.running ? await dockerAppFinder({ platform }) : "");
  const runtimeOperations = [];
  if (runtime?.docker && !runtime.docker.unavailable) {
    runtimeOperations.push(runtime.docker);
    warnings.push(`Docker Desktop is not installed; server prepare downloads it from ${runtime.docker.url} and installs it (${runtime.docker.note})`);
    warnings.push(DOCKER_LICENSE_WARNING);
  } else if (!docker.installed && !(runtime && dockerApp)) {
    issues.push(runtime?.docker?.unavailable
      ? `Docker CLI is not installed, and Docker Desktop has no download for ${platform} on ${arch}`
      : "Docker CLI is not installed");
  } else if (!docker.running && dockerApp) warnings.push(`Docker Desktop is not running; server prepare starts it (${dockerApp}) and waits for its engine`);
  else if (!docker.running) issues.push("Docker is installed but the engine is not running");
  if (runtime?.ollama?.unavailable) {
    issues.push(`Ollama is not installed, and this app has no Ollama download for ${platform} on ${arch}; install Ollama so that it is on PATH`);
  } else if (runtime?.ollama) {
    runtimeOperations.push(runtime.ollama);
    warnings.push(`Ollama is not installed; server prepare downloads it from ${runtime.ollama.url} into ${runtime.ollama.destination} and checks it against ${runtime.ollama.checksums}`);
  }
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
  const installDirectory = installedServerDir();
  let gateway = null;
  if (profile === "personal") {
    if (platform === "linux") {
      issues.push("The personal host profile currently requires macOS or Windows; use the portable profile on native Linux");
    }
    const hostAssets = ["host-profile.personal.json", "host/supervisor.mjs"];
    const missingHostAssets = [];
    for (const asset of hostAssets) if (!(await exists(path.join(bundle.directory, asset)))) missingHostAssets.push(asset);
    if (missingHostAssets.length) issues.push(`The personal host runtime is incomplete: ${missingHostAssets.join(", ")}`);

    // Every chat model goes through the subscription gateway. Prepare fetches and
    // installs it and then asks it for the router key, so nothing here needs a key.
    const directory = gatewayDirectory(installDirectory);
    const source = await (gatewaySourceInspector
      ? gatewaySourceInspector()
      : gatewaySourceProbe({ pinDirectory: bundle.directory, directory }));
    if (source.state === "missing" && !source.fetchable) {
      issues.push(`The subscription gateway cannot be installed: ${source.reason}`);
    } else if (source.state === "stale" && !source.fetchable) {
      issues.push(`The subscription gateway source cannot be updated: ${source.reason}`);
    } else if (source.fetchable) {
      const verb = source.state === "stale" ? "replaced from" : "downloaded from";
      warnings.push(`Subscription gateway source will be ${verb} ${source.pin.repo} (${source.pin.commit || source.pin.ref}) into ${directory}`);
    }
    if (source.state === "external") {
      warnings.push(`${directory} was not fetched by this installer; it is used as it is and never replaced`);
    }
    gateway = { directory, source, ...(await gatewayAddresses(bundle.directory)) };
  }
  if (profile === "portable" && !process.env.LLM_OPENAI_API_KEY && !(await exists(path.join(bundle.directory, ".env")))) {
    warnings.push("No OpenAI key was supplied; add the required LLM key to server/.env before memory processing");
  }
  const installedPorts = await installedServerPorts(installDirectory);
  let ports = installedPorts;
  if (!installedPorts.installed) {
    try {
      ports = await portChooser();
      if (ports.api !== DEFAULT_API_PORT) warnings.push(`Port ${DEFAULT_API_PORT} is already used by another program; the Honcho API will use ${ports.api}`);
      if (ports.dashboard !== DEFAULT_DASHBOARD_PORT) warnings.push(`Port ${DEFAULT_DASHBOARD_PORT} is already used by another program; the dashboard will use ${ports.dashboard}`);
    } catch (error) {
      issues.push(operationError(error));
    }
  }
  const operations = gateway
    ? personalOperations({ honchoSource, gateway, bundle, installDirectory, embedding: await plannedEmbedding(bundle.directory, installDirectory) })
    : null;
  if (operations && dockerApp && !docker.running) operations.unshift({ type: "start-docker-desktop", app: dockerApp });
  // Downloads come first: nothing else can run without them.
  if (operations && runtimeOperations.length) operations.unshift(...runtimeOperations);
  return {
    ok: issues.length === 0,
    ready: issues.length === 0,
    mode: "local-docker",
    profile,
    docker,
    bundle,
    installDirectory,
    honchoSource,
    ...(gateway ? { gateway, operations } : {}),
    ...(runtime ? { ollama: runtime.ollamaFound } : {}),
    ...serverUrls(ports),
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
        // The gateway is not part of the bundle and the update never touched it.
        hostPreparation = await hostRuntime.prepare({ profile, installedServerDir: installed, skipGateway: true });
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

/**
 * Install the gateway and ask it how Honcho reaches its router. The result is either
 * the values the new bundle's .env needs, or a result to stop with. A gateway with
 * no login yet is not a failure: logging in is the user's next step.
 *
 * `values` carries the router key; it goes to initializeEnvironment and nowhere else.
 */
async function connectGateway({ plan, installed, model, sourceFetcher, runner, env }) {
  const directory = gatewayDirectory(installed);
  const stopped = { ok: false, ready: false, mode: "local-docker", profile: "personal" };
  const prepared = await prepareGateway({ pinDirectory: plan.bundle.directory, directory, sourceFetcher, runner, env });
  const report = {
    directory,
    ...(prepared.source ? { source: prepared.source } : {}),
    ...(prepared.autostart ? { autostart: prepared.autostart } : {}),
    uiUrl: prepared.uiUrl || plan.gateway?.uiUrl || DEFAULT_GATEWAY_UI_URL,
  };
  if (!prepared.ok) {
    return {
      stop: { ...stopped, gateway: report, issues: [prepared.error], next: "Resolve the gateway problem above, then run server prepare again" },
    };
  }
  const connection = await gatewayConnectInfo({ directory, runner, env });
  if (!connection.ok) {
    return {
      stop: {
        ...stopped,
        gateway: report,
        issues: [`The subscription gateway did not say how to reach its router: ${connection.error}`],
        next: "Check the gateway screen, then run server prepare again",
      },
    };
  }
  report.models = connection.models;
  if (!connection.ready) {
    const nextAction = gatewayLoginAction(report.uiUrl, "run server prepare --profile personal again");
    return {
      stop: { ...stopped, ok: true, gateway: { ...report, reason: connection.reason }, nextAction, next: nextAction.message },
    };
  }
  // The model the installed .env already uses is kept while the gateway offers it,
  // so `server start`, which prepares again, does not undo an earlier --model.
  const previous = await readEnvironmentFile(path.join(installed, ".env"));
  const choice = chooseChatModel(connection.models, { requested: model, installed: installedChatModel(previous) });
  if (choice.noChatModel) {
    // Ready, but with nothing that can chat: the fix is the same login step.
    const nextAction = gatewayLoginAction(report.uiUrl, "run server prepare --profile personal again", choice.reason);
    return {
      stop: { ...stopped, ok: true, gateway: { ...report, reason: choice.reason }, nextAction, next: nextAction.message },
    };
  }
  if (!choice.ok) {
    return {
      stop: {
        ...stopped,
        gateway: report,
        issues: [choice.error],
        next: "Choose one of the models the gateway offers with --model, or leave --model out",
      },
    };
  }
  return {
    values: gatewayEnvironment({ routerUrl: connection.baseUrl, apiKey: connection.apiKey, model: choice.model }),
    model: choice.model,
    modelSource: choice.source,
    report: {
      ...report,
      routerUrl: connection.baseUrl,
      routerKeyUpdated: previous.LLM_VLLM_API_KEY !== connection.apiKey,
    },
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
  gatewaySourceFetcher = ensureGatewaySource,
  gatewayRunner,
  model = "",
  dockerStarter = ensureDockerRunning,
  portChooser = chooseServerPorts,
  arch = os.arch(),
  dockerInspector = dockerProbe,
  dockerAppFinder = dockerDesktopApp,
  ollamaLocator = null,
  runtimeInstaller = prepareRuntime,
  runtimeOptions = {},
  shareOptions = {},
} = {}) {
  requireServerProfile(profile);
  const installedDirectory = path.resolve(serverDirectory || installedServerDir());
  // Docker Desktop and Ollama come first when this computer has neither: nothing
  // else prepare does is any use without them. A plan handed in says what to get;
  // otherwise the same check the plan makes is made here.
  let runtime = null;
  if (profile === "personal" && (platform === "darwin" || platform === "win32")) {
    let operations;
    if (preparedPlan) operations = (preparedPlan.operations || []).filter((item) => /^install-(?:docker-desktop|ollama)$/.test(item.type));
    else {
      const needs = await personalRuntimeNeeds({
        platform,
        arch,
        env,
        installDirectory: installedDirectory,
        docker: await dockerInspector(),
        dockerAppFinder,
        ollamaLocator,
      });
      operations = [needs.docker, needs.ollama].filter((item) => item && !item.unavailable);
    }
    if (operations.length) {
      runtime = await runtimeInstaller({
        operations,
        platform,
        arch,
        env,
        runtimeDir: runtimeRoot(installedDirectory),
        dockerInspector: () => dockerInspector({ platform, env }),
        ...runtimeOptions,
      });
      if (!runtime.ok || !runtime.ready) {
        return {
          ok: Boolean(runtime.ok),
          ready: false,
          mode: "local-docker",
          profile,
          runtime,
          actions: runtime.actions || [],
          ...(runtime.issues?.length ? { issues: runtime.issues } : {}),
          ...(runtime.nextAction ? { nextAction: runtime.nextAction, next: runtime.nextAction.message } : { next: "Resolve the issue above, then run server prepare --profile personal again" }),
        };
      }
    }
  }
  // Plan reports a closed Docker Desktop as something prepare fixes, not as a stop.
  const dockerStart = preparedPlan ? null : await dockerStarter({ platform });
  if (profile === "personal" && dockerStart && platform !== "linux") {
    const runtimeDir = runtimeRoot(installedDirectory);
    if (dockerStart.running) await clearDockerFirstRun(runtimeDir);
    else if (dockerStart.installed !== false && await dockerFirstRunPending(runtimeDir)) {
      // Docker Desktop was installed by an earlier prepare and its first-run window
      // is still waiting for the user. Nothing else changes until it is done.
      const nextAction = dockerFirstRunAction(dockerStart.app || (await dockerAppFinder({ platform, env })), platform);
      return { ok: true, ready: false, mode: "local-docker", profile, docker: dockerStart, nextAction, next: nextAction.message };
    }
  }
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
  const plan = preparedPlan || await serverPlan({ profile, portChooser, platform, arch, env, dockerInspector, dockerAppFinder, ollamaLocator });
  if (!plan.ready) return plan;
  const installed = path.resolve(serverDirectory || installedServerDir());
  const privateFileOptions = {
    platform,
    env,
    ...(privateFileRunner ? { run: privateFileRunner } : {}),
    ...(fileSystem ? { fileSystem } : {}),
  };
  // Decided before the bundle is copied: afterwards a new install has a .env too.
  const ports = await portEnvironment(installed, portChooser);

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
    const environment = await initializeEnvironment(installed, profile, privateFileOptions, ports);
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

  // The gateway comes first: the new bundle's .env needs the router key only the
  // installed gateway can give, and a gateway with no login yet stops prepare before
  // anything installed is touched.
  const gateway = await connectGateway({
    plan,
    installed,
    model,
    sourceFetcher: gatewaySourceFetcher,
    runner: gatewayRunner,
    env,
  });
  if (gateway.stop) return gateway.stop;

  const hadInstalledBundle = await exists(installed);
  const candidate = await prepareBundleCandidate(plan.bundle.directory, installed, privateFileOptions);
  let candidateEnvironment;
  let missingSecretFields;
  try {
    candidateEnvironment = await initializeEnvironment(candidate.path, profile, privateFileOptions, { ...gateway.values, ...ports });
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
      gateway: gateway.report,
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
    host = await hostRuntime.prepare({ profile, installedServerDir: installed, skipGateway: true });
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
      gateway: gateway.report,
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
  const share = committed.ok ? await settleShareFor(profile, installed, shareOptions, privateFileOptions) : null;
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
    chatModel: gateway.model,
    chatModelSource: gateway.modelSource,
    gateway: gateway.report,
    ...(committed.issues.length ? { issues: committed.issues, retainedPaths: committed.retainedPaths } : {}),
    next: committed.ok
      ? "Run server start"
      : "Remove the retained retired-backup path reported by cleanup before starting the server",
    host,
    hostStoppedForUpdate,
    ...(runtime ? { runtime } : {}),
    ...(share ? { share } : {}),
    ...(share?.warnings?.length ? { warnings: share.warnings } : {}),
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

// ----------------------------------------------------- sharing from 0.3.28
//
// A server shared under 0.3.28 has COMPOSE_PROFILES=share in its .env but none of
// the tunnel token, team MCP token or team peer the share services now need, and its
// cloudflared still starts on the host at login. Started like that, tunnel and mcp
// restart forever. Prepare and start therefore remove the old host tunnel (its token
// moves into the .env when the .env has none) and, while any of the three is still
// empty, take share out of COMPOSE_PROFILES and say how to turn it on again.

export const SHARE_REQUIRED_SETTINGS = Object.freeze(["HONCHO_TUNNEL_TOKEN", "HONCHO_TEAM_MCP_TOKEN", "HONCHO_TEAM_PEER"]);
const SHARE_PROFILE_NAME = "share";

function profileList(environment) {
  return String(environment.COMPOSE_PROFILES || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Returns null when the .env never shared and no old host tunnel is left. `shareOptions`
 * reach share-manager's removeHostTunnel (tests hand in their own runner and home).
 */
export async function settleShareProfile(directory, { shareOptions = {}, privateFileOptions = {} } = {}) {
  const envFile = path.join(directory, ".env");
  const before = await fsp.readFile(envFile, "utf8").catch(() => null);
  if (before === null) return null;
  const shared = profileList(parseEnvironment(before)).includes(SHARE_PROFILE_NAME);
  if (!shared && !(await exists(path.join(runtimeRoot(directory), "cloudflared")))) return null;
  const warnings = [];
  let hostTunnelRemoved = null;
  try {
    // share-manager imports this module, hence the import at call time.
    const { removeHostTunnel } = await import("./share-manager.mjs");
    hostTunnelRemoved = (await removeHostTunnel({ serverDirectory: directory, ...shareOptions })).removed;
  } catch (error) {
    warnings.push(`The host tunnel of an older version could not be removed: ${String(error?.message || error).split(/\r?\n/)[0]}`);
  }
  // The old token may have just moved into the .env.
  const text = await fsp.readFile(envFile, "utf8");
  const environment = parseEnvironment(text);
  const missing = SHARE_REQUIRED_SETTINGS.filter((key) => !String(environment[key] || "").trim());
  if (!shared || !missing.length) return { profileDropped: false, hostTunnelRemoved, ...(warnings.length ? { warnings } : {}) };
  const rest = profileList(environment).filter((item) => item !== SHARE_PROFILE_NAME);
  const updated = rest.length
    ? replaceEnvironment(text, { COMPOSE_PROFILES: rest.join(",") })
    : `${text.split(/\r?\n/).filter((line) => !line.startsWith("COMPOSE_PROFILES=")).join("\n").replace(/\n+$/, "")}\n`;
  await writePrivateFileAtomic(envFile, updated, privateFileOptions);
  return {
    profileDropped: true,
    missing,
    hostTunnelRemoved,
    warnings: [
      ...warnings,
      `Sharing was turned off: it was set up by an older version and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty. Turn it on again with server share enable (or server share join with the invite on a teammate's computer)`,
    ],
    next: "Turn sharing on again with server share enable, or server share join on a teammate's computer",
  };
}

async function settleShareFor(profile, directory, shareOptions, privateFileOptions) {
  if (profile !== "personal") return null;
  return settleShareProfile(directory, { shareOptions, privateFileOptions });
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
  honchoSourceFetcher,
  gatewaySourceFetcher,
  gatewayRunner,
  model,
  shareOptions = {},
} = {}) {
  requireServerProfile(profile);
  const installed = path.resolve(serverDirectory || installedServerDir());
  // Start prepares again. The installed chat model is kept; a --model given here
  // replaces it.
  const prepared = preparedServer || await serverPrepareUnlocked({
    profile,
    hostRuntime,
    preparedPlan,
    serverDirectory: installed,
    honchoSourceFetcher,
    gatewaySourceFetcher,
    gatewayRunner,
    model,
    shareOptions,
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
  // The prepare above settled the share profile; a start given a server prepared
  // elsewhere settles it here, so share never comes up half set.
  const share = preparedServer ? await settleShareFor(profile, installed, shareOptions) : prepared.share || null;
  const args = ["up", "-d", "--remove-orphans"];
  if (build) args.push("--build");
  const ports = await installedServerPorts(installed);
  let composeResult;
  try {
    composeResult = await composeRunner(installed, args);
  } catch (error) {
    if (host) await hostRuntime.stop({ profile, installedServerDir: installed }).catch(() => {});
    const detail = String(error?.stderr || error?.message || error);
    if (/address already in use|port is already allocated|ports are not available/i.test(detail)) {
      return {
        ok: false,
        ready: false,
        mode: "local-docker",
        profile,
        ...serverUrls(ports),
        issues: [`Port ${ports.api} or ${ports.dashboard} on 127.0.0.1 is taken by another program: ${detail.trim().split(/\r?\n/).at(-1)}`],
        next: `Stop the program on that port, or change HONCHO_API_PORT / HONCHO_DASHBOARD_PORT in ${path.join(installed, ".env")} and in setup's --honcho-url, then run server start again`,
      };
    }
    throw error;
  }
  const health = await healthWaiter(`${serverUrls(ports).apiUrl}/health`);
  const result = {
    ok: health.ok,
    mode: "local-docker",
    profile,
    installation: prepared.installation,
    environment: prepared.environment,
    health,
    ...serverUrls(ports),
    compose: { stdout: composeResult.stdout.trim(), stderr: composeResult.stderr.trim() },
    ...(share ? { share } : {}),
    ...(share?.warnings?.length ? { warnings: share.warnings } : {}),
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

/**
 * Whether this server is shared with the owner's other computers, read from files
 * only, so status stays cheap. share-manager imports this module, hence the
 * import at call time.
 */
async function shareSummaryFor(directory) {
  try {
    const { shareSummary } = await import("./share-manager.mjs");
    return await shareSummary({ serverDirectory: directory });
  } catch {
    return { enabled: false, publicUrl: null };
  }
}

export async function serverStatus(options = {}) {
  requireServerProfile(options.profile || "portable");
  const directory = path.resolve(options.serverDirectory || installedServerDir());
  const [result, share] = await Promise.all([
    serverStatusWithoutShare({ ...options, serverDirectory: directory }),
    shareSummaryFor(directory),
  ]);
  // The host supervisor's login autostart, which `server start` registers through
  // `host start`: {registered, kind}.
  return { ...result, ...(result.host?.autostart ? { autostart: result.host.autostart } : {}), share };
}

async function serverStatusWithoutShare({
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
    const urls = serverUrls(await installedServerPorts(directory));
    const health = await healthWaiter(`${urls.apiUrl}/health`, 2_500);
    const containersRunning = services.some(item => item.State === "running");
    const result = {
      ok: health.ok && (!host || host.ok),
      installed: true,
      running: containersRunning && (!host || host.running),
      directory,
      docker,
      health,
      ...urls,
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
      routerHealthy: Boolean(status.host?.gateway?.router?.ok),
      gatewayLoggedIn: Boolean(status.host?.gateway?.loggedIn),
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
    return { ok: true, ollama: skipped, router: skipped, skipped: true };
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
      router: targets.router ? { ok: false, status: null } : skipped,
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
  const router = reading("router");
  return {
    ok: ollama.ok && router.ok,
    ollama,
    router,
    ...(!document ? { error: "Docker API-container host connectivity probe returned no valid result" } : {}),
  };
}

async function verifyHonchoHealth({ directory, fetchImpl, timeoutMs }) {
  const { apiUrl } = serverUrls(await installedServerPorts(directory));
  try {
    const response = await fetchWithTimeout(fetchImpl, `${apiUrl}/health`, {
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

/**
 * The router Honcho is configured to call, as this machine reaches it. Only a local
 * address is accepted and only its port and path are kept, so the key read below is
 * never sent anywhere but this machine.
 */
function localRouterUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { return ""; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
  if (!["127.0.0.1", "localhost", "::1", "[::1]", "host.docker.internal"].includes(url.hostname)) return "";
  return `http://127.0.0.1:${url.port || (url.protocol === "https:" ? 443 : 80)}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * One real completion exactly as the deriver would make it: the installed router
 * address, key, model and effort. The key is read here, in process, and the
 * response body is discarded unread.
 */
async function verifyLiveCompletion({ directory, fetchImpl, timeoutMs }) {
  let environment;
  try { environment = parseEnvironment(await fsp.readFile(path.join(directory, ".env"), "utf8")); }
  catch {
    return { ok: false, model: null, error: "The installed server environment could not be read" };
  }
  const model = String(environment.DERIVER_MODEL_CONFIG__MODEL || "").trim() || null;
  const routerUrl = localRouterUrl(environment.DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL || environment.LLM_VLLM_BASE_URL);
  const secretName = String(environment.DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV || "LLM_VLLM_API_KEY").trim();
  const secret = String(environment[secretName] || "").trim();
  const effort = String(environment.DERIVER_MODEL_CONFIG__THINKING_EFFORT || "low").trim();
  if (!model || !routerUrl || !secret) {
    return { ok: false, model, error: "The installed environment names no local router, key and model to call" };
  }
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${routerUrl}/chat/completions`, {
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
        reasoning_effort: effort,
        stream: false,
      }),
    }, timeoutMs);
  } catch {
    return { ok: false, model };
  }
  const result = response.ok ? { ok: true, model } : { ok: false, model, status: response.status ?? null };
  await discardBody(response);
  return result;
}

/**
 * Exercise the production-shaped personal topology without returning response
 * bodies, vectors, prompts, or credentials. A live completion through the
 * gateway's router is opt-in.
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
  const embeddingModel = rawStatus?.host?.ollama?.model
    || (await readEnvironmentFile(path.join(directory, ".env"))).EMBEDDING_MODEL_CONFIG__MODEL
    || DEFAULT_EMBEDDING_ALIAS;

  const [embedding, containerHost, honcho, completion] = await Promise.all([
    verifyOllamaEmbedding({ fetchImpl, model: embeddingModel, timeoutMs: requestTimeoutMs }),
    verifyContainerHostAccess({ directory, composeRunner }),
    verifyHonchoHealth({ directory, fetchImpl, timeoutMs: Math.min(requestTimeoutMs, 30_000) }),
    liveCompletion
      ? verifyLiveCompletion({ directory, fetchImpl, timeoutMs: requestTimeoutMs })
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
