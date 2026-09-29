import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHAT_MODEL_PREFIXES,
  CHAT_THINKING_EFFORT,
  DEFAULT_GATEWAY_ROUTER_URL,
  DEFAULT_GATEWAY_UI_URL,
  dockerRouterUrl,
  PREFERRED_CHAT_MODELS,
} from "./gateway.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSONAL_MODEL_PREFIXES = CHAT_MODEL_PREFIXES;
const PERSONAL_MODEL_SUFFIXES = new Set([
  "TRANSPORT",
  "MODEL",
  "THINKING_EFFORT",
  "OVERRIDES__BASE_URL",
  "OVERRIDES__API_KEY_ENV",
]);
const SAFE_ENVIRONMENT_VALUE = new Map([
  ["LOG_LEVEL", /^(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)$/i],
  ["AUTH_USE_AUTH", /^(?:true|false|0|1)$/i],
  ["DERIVER_FLUSH_ENABLED", /^(?:true|false|0|1)$/i],
  ["DERIVER_WORKERS", /^\d{1,4}$/],
  ["HONCHO_API_PORT", /^\d{1,5}$/],
  ["HONCHO_DASHBOARD_PORT", /^\d{1,5}$/],
  ["HONCHO_IMAGE_TAG", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/],
]);

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else { result[key] = value; index += 1; }
  }
  return result;
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function safeBundleName(value) {
  const candidate = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate) || candidate === "." || candidate === "..") {
    throw new Error("Bundle name must be a single safe file name");
  }
  return candidate;
}

async function replaceableRelease(bundle, archive, packageName) {
  let stat;
  try { stat = await fsp.lstat(bundle); } catch (error) {
    if (error?.code === "ENOENT") stat = null;
    else throw error;
  }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-directory release path: ${bundle}`);
  }
  if (stat) {
    let manifest = null;
    try { manifest = JSON.parse(await fsp.readFile(path.join(bundle, "SOURCE_MANIFEST.json"), "utf8")); } catch {}
    if (manifest?.package?.name !== packageName) {
      throw new Error(`Refusing to replace an existing directory not owned by ${packageName}: ${bundle}`);
    }
  }

  let archiveStat;
  try { archiveStat = await fsp.lstat(archive); } catch (error) {
    if (error?.code === "ENOENT") archiveStat = null;
    else throw error;
  }
  if (archiveStat && (!archiveStat.isFile() || archiveStat.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-file release archive: ${archive}`);
  }
  if (archiveStat && !stat) {
    throw new Error(`Refusing to replace an archive without its owned release directory: ${archive}`);
  }
  return { bundleExists: Boolean(stat), archiveExists: Boolean(archiveStat) };
}

function transactionPath(target, label) {
  return `${target}.${label}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
}

async function operationExists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

async function swapReleaseArtifacts({ candidateBundle, candidateArchive, bundle, archive, existing }) {
  const savedBundle = transactionPath(bundle, "saved");
  const savedArchive = transactionPath(archive, "saved");
  const failedBundle = transactionPath(bundle, "failed");
  const failedArchive = transactionPath(archive, "failed");
  let bundleSaved = false;
  let archiveSaved = false;
  let bundleInstalled = false;
  let archiveInstalled = false;

  try {
    if (existing.bundleExists) {
      await fsp.rename(bundle, savedBundle);
      bundleSaved = true;
    }
    if (existing.archiveExists) {
      await fsp.rename(archive, savedArchive);
      archiveSaved = true;
    }
    await fsp.rename(candidateBundle, bundle);
    bundleInstalled = true;
    await fsp.rename(candidateArchive, archive);
    archiveInstalled = true;
  } catch (error) {
    const recoveryIssues = [];
    let failedBundleMoved = false;
    let failedArchiveMoved = false;
    if (archiveInstalled && await operationExists(archive)) {
      try { await fsp.rename(archive, failedArchive); failedArchiveMoved = true; }
      catch (recoveryError) { recoveryIssues.push(`new archive displacement failed: ${recoveryError.message}`); }
    }
    if (bundleInstalled && await operationExists(bundle)) {
      try { await fsp.rename(bundle, failedBundle); failedBundleMoved = true; }
      catch (recoveryError) { recoveryIssues.push(`new bundle displacement failed: ${recoveryError.message}`); }
    }
    if (archiveSaved && !(await operationExists(archive))) {
      try { await fsp.rename(savedArchive, archive); }
      catch (recoveryError) { recoveryIssues.push(`prior archive restoration failed: ${recoveryError.message}`); }
    }
    if (bundleSaved && !(await operationExists(bundle))) {
      try { await fsp.rename(savedBundle, bundle); }
      catch (recoveryError) { recoveryIssues.push(`prior bundle restoration failed: ${recoveryError.message}`); }
    }
    if (failedArchiveMoved && (!existing.archiveExists || await operationExists(archive))) {
      await fsp.rm(failedArchive, { force: true }).catch(() => {});
    }
    if (failedBundleMoved && (!existing.bundleExists || await operationExists(bundle))) {
      await fsp.rm(failedBundle, { recursive: true, force: true }).catch(() => {});
    }
    if (recoveryIssues.length) {
      throw new Error(`Release replacement failed: ${error.message}; recovery issues: ${recoveryIssues.join("; ")}`, { cause: error });
    }
    throw error;
  }

  const warnings = [];
  if (bundleSaved) {
    try { await fsp.rm(savedBundle, { recursive: true, force: true }); }
    catch (error) { warnings.push(`prior bundle cleanup failed: ${error.message}`); }
  }
  if (archiveSaved) {
    try { await fsp.rm(savedArchive, { force: true }); }
    catch (error) { warnings.push(`prior archive cleanup failed: ${error.message}`); }
  }
  return { warnings };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function excluded(sourceRoot, target) {
  const relative = path.relative(sourceRoot, target);
  const parts = relative.split(path.sep);
  const names = new Set([".git", ".venv", ".worktrees", ".bench", "node_modules", "__pycache__", ".pytest_cache", ".ruff_cache", "dist"]);
  if (parts.some(part => names.has(part))) return true;
  const base = path.basename(target);
  return base === ".env"
    || base === ".DS_Store"
    || /(?:token|secret|credential|api[_-]?key)\.txt$/i.test(base)
    || /\.(?:sqlite(?:3)?|db|dump|log)$/i.test(base)
    || /(?:^|[-_.])(?:backup|runtime-state)(?:[-_.]|$)/i.test(base);
}

function gitFiles(source) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached"],
    { cwd: source, encoding: "buffer" },
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

async function copyGitTree(source, destination) {
  for (const relative of gitFiles(source)) {
    const input = path.resolve(source, relative);
    if (path.relative(source, input).startsWith("..") || excluded(source, input)) continue;
    let stat;
    try { stat = await fsp.lstat(input); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const output = path.join(destination, relative);
    await fsp.mkdir(path.dirname(output), { recursive: true });
    if (stat.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(input), output);
    } else if (stat.isFile()) {
      await fsp.copyFile(input, output);
      await fsp.chmod(output, stat.mode & 0o777);
    }
  }
}

async function contentHash(directory, ignored = new Set()) {
  const files = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && !ignored.has(path.relative(directory, target))) files.push(target);
    }
  }
  await walk(directory);
  files.sort((left, right) => path.relative(directory, left).localeCompare(path.relative(directory, right)));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(directory, file));
    hash.update("\0");
    hash.update(await fsp.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function tarExecutable() {
  return process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

function createTarArchive({ stageRoot, bundleName, candidateArchive }) {
  execFileSync(tarExecutable(), ["--no-xattrs", "-czf", candidateArchive, "-C", stageRoot, bundleName], {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

async function validateCandidate({ candidateBundle, candidateArchive, bundleName, packageName, manifest }) {
  const writtenManifest = JSON.parse(await fsp.readFile(path.join(candidateBundle, "SOURCE_MANIFEST.json"), "utf8"));
  if (writtenManifest.package?.name !== packageName || writtenManifest.contentId !== manifest.contentId) {
    throw new Error("Generated release manifest does not match the requested package");
  }
  const actualContentId = await contentHash(candidateBundle, new Set(["SOURCE_MANIFEST.json"]));
  if (actualContentId !== manifest.contentId) throw new Error("Generated release content hash verification failed");
  const archiveStat = await fsp.lstat(candidateArchive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size === 0) {
    throw new Error("Generated release archive is empty or invalid");
  }
  const listing = execFileSync(tarExecutable(), ["-tzf", candidateArchive], { encoding: "utf8" });
  const manifestEntry = `${bundleName}/SOURCE_MANIFEST.json`;
  if (!listing.split(/\r?\n/).some(entry => entry.replace(/^\.\//, "") === manifestEntry)) {
    throw new Error("Generated release archive does not contain the source manifest");
  }
}

function sanitizedEnvironment(text) {
  const lines = text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return [];
    const [, key, value] = match;
    const validator = SAFE_ENVIRONMENT_VALUE.get(key);
    if (validator?.test(value)) return [line];
    if (/^DIALECTIC_LEVELS__(?:minimal|low|medium|high|max)__MAX_TOOL_ITERATIONS$/.test(key) && /^\d{1,4}$/.test(value)) {
      return [line];
    }
    return [];
  });
  return ["# Generated personal topology. Add secrets only in the installed private .env.", ...lines, ""].join("\n");
}

function withoutConflictingPersonalModelSettings(text) {
  return text.split(/\r?\n/).filter((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return true;
    for (const prefix of [...PERSONAL_MODEL_PREFIXES, "EMBEDDING_MODEL_CONFIG"]) {
      if (!match[1].startsWith(`${prefix}__`)) continue;
      const suffix = match[1].slice(prefix.length + 2);
      const allowed = prefix === "EMBEDDING_MODEL_CONFIG"
        ? new Set(["TRANSPORT", "MODEL", "OVERRIDES__BASE_URL", "OVERRIDES__API_KEY_ENV"])
        : PERSONAL_MODEL_SUFFIXES;
      return allowed.has(suffix);
    }
    return true;
  }).join("\n");
}

function replaceEnvironmentValues(text, values) {
  const seen = new Set();
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function personalEnvironment(text) {
  const sanitized = withoutConflictingPersonalModelSettings(sanitizedEnvironment(text));
  // Every chat model goes through the subscription gateway's router. These are its
  // defaults; `server prepare` writes the address, the key and the model the
  // installed gateway reports over them, so the owner's own endpoints are not copied.
  const routerUrl = dockerRouterUrl(DEFAULT_GATEWAY_ROUTER_URL);
  const embeddingBaseUrl = "http://host.docker.internal:11434/v1";
  const values = {
    LLM_OPENAI_API_KEY: "",
    LLM_OPENAI_COMPATIBLE_API_KEY: "",
    LLM_VLLM_API_KEY: "",
    EMBED_MESSAGES: "true",
    LLM_VLLM_BASE_URL: routerUrl,
    LLM_OPENAI_COMPATIBLE_BASE_URL: embeddingBaseUrl,
    EMBEDDING_MAX_INPUT_TOKENS: "8192",
    EMBEDDING_MAX_TOKENS_PER_REQUEST: "8192",
    EMBEDDING_VECTOR_DIMENSIONS: "1536",
    EMBEDDING_QUERY_INSTRUCTION: "Given a personal memory search query, retrieve relevant conversation passages that answer or contextualize the query",
    EMBEDDING_MODEL_CONFIG__TRANSPORT: "openai",
    EMBEDDING_MODEL_CONFIG__MODEL: "qwen3-embedding-honcho-8192",
    EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL: embeddingBaseUrl,
    EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV: "LLM_OPENAI_COMPATIBLE_API_KEY",
    VECTOR_STORE_TYPE: "pgvector",
    VECTOR_STORE_MIGRATED: "true",
    // Starlette's current TrustedHost parser does not accept bracketed IPv6
    // Host headers reliably, so keep the generated local profile on the
    // verified IPv4 and Compose service-name paths.
    TRUSTED_HOSTS: '["localhost","127.0.0.1","api"]',
  };
  for (const prefix of PERSONAL_MODEL_PREFIXES) {
    values[`${prefix}__TRANSPORT`] = "openai";
    values[`${prefix}__MODEL`] = PREFERRED_CHAT_MODELS[0];
    values[`${prefix}__THINKING_EFFORT`] = CHAT_THINKING_EFFORT;
    values[`${prefix}__OVERRIDES__BASE_URL`] = routerUrl;
    values[`${prefix}__OVERRIDES__API_KEY_ENV`] = "LLM_VLLM_API_KEY";
  }
  return replaceEnvironmentValues(sanitized, values);
}

function parseEnvironment(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function personalHostProfile(text) {
  const env = parseEnvironment(text);
  const embeddingUrl = env.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL
    || env.LLM_OPENAI_COMPATIBLE_BASE_URL
    || "";
  const embeddingModel = env.EMBEDDING_MODEL_CONFIG__MODEL || "";
  const ollamaEnabled = /(?:host\.docker\.internal|127\.0\.0\.1|localhost):11434(?:\/|$)/.test(embeddingUrl);
  return {
    format: 1,
    profile: "personal",
    // The gateway is its own program: `server prepare` fetches it from
    // gateway-source.json and runs its install. These are only where it is expected
    // to answer; it reports its real addresses itself.
    gateway: {
      uiUrl: DEFAULT_GATEWAY_UI_URL,
      routerUrl: DEFAULT_GATEWAY_ROUTER_URL,
    },
    ollama: {
      enabled: ollamaEnabled,
      baseUrl: "http://127.0.0.1:11434",
      baseModel: env.HONCHO_AGENT_BRIDGE_OLLAMA_BASE_MODEL || "qwen3-embedding:8b",
      model: embeddingModel || "qwen3-embedding-honcho-8192",
      contextLength: Number(env.EMBEDDING_MAX_INPUT_TOKENS || 8192),
      dimensions: Number(env.EMBEDDING_VECTOR_DIMENSIONS || 1536),
      keepAlive: -1,
    },
  };
}

export async function buildDistribution(args, {
  copyTree = copyGitTree,
  archiveBuilder = createTarArchive,
} = {}) {
  if (!args["honcho-source"]) throw new Error("--honcho-source is required");
  const honchoSource = path.resolve(args["honcho-source"]);
  const packageJson = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const packageDirty = git(ROOT, ["status", "--porcelain"]);
  if (packageDirty && !args["allow-dirty"]) {
    throw new Error("Honcho Agent Bridge source has uncommitted changes; commit them or pass --allow-dirty intentionally");
  }
  const outputRoot = path.resolve(args.output || path.join(path.dirname(ROOT), "honcho-agent-bridge-releases"));
  const bundleName = safeBundleName(args.name || `honcho-agent-bridge-${packageJson.version}`);
  const bundle = path.join(outputRoot, bundleName);
  const archive = `${bundle}.tar.gz`;
  for (const required of ["Dockerfile", "LICENSE", "src", "database/init.sql", "local-dashboard/Dockerfile"]) {
    if (!(await exists(path.join(honchoSource, required)))) throw new Error(`Honcho source is missing ${required}`);
  }
  const dirty = git(honchoSource, ["status", "--porcelain"]);
  if (dirty && !args["allow-dirty"]) throw new Error("Honcho source has uncommitted changes; commit them or pass --allow-dirty intentionally");

  const existing = await replaceableRelease(bundle, archive, packageJson.name);
  await fsp.mkdir(outputRoot, { recursive: true });
  const stageRoot = transactionPath(path.join(outputRoot, `.${bundleName}`), "stage");
  const candidateBundle = path.join(stageRoot, bundleName);
  const candidateArchive = path.join(stageRoot, `${bundleName}.tar.gz`);
  await fsp.mkdir(candidateBundle, { recursive: true });
  try {
    await copyTree(ROOT, candidateBundle);
    await fsp.mkdir(path.join(candidateBundle, "server", "honcho"), { recursive: true });
    await copyTree(honchoSource, path.join(candidateBundle, "server", "honcho"));
    // Older source checkouts may still contain the proxies. They now ship with the
    // subscription gateway.
    for (const name of ["codex-openai-proxy", "claude-print-proxy"]) {
      await fsp.rm(path.join(candidateBundle, "server", "honcho", name), { recursive: true, force: true });
    }
    await fsp.copyFile(path.join(honchoSource, "LICENSE"), path.join(candidateBundle, "HONCHO-LICENSE-AGPL-3.0.txt"));

    let hostProfile = null;
    if (args["env-source"]) {
      const source = await fsp.readFile(path.resolve(args["env-source"]), "utf8");
      const environment = personalEnvironment(source);
      await fsp.writeFile(path.join(candidateBundle, "server", "env.personal.example"), environment, "utf8");
      hostProfile = personalHostProfile(environment);
      await fsp.writeFile(
        path.join(candidateBundle, "server", "host-profile.personal.json"),
        `${JSON.stringify(hostProfile, null, 2)}\n`,
        "utf8",
      );
    }

    const manifest = {
      format: 1,
      generatedAt: new Date().toISOString(),
      package: { name: packageJson.name, version: packageJson.version },
      honchoAgentBridge: {
        commit: git(ROOT, ["rev-parse", "HEAD"]),
        branch: git(ROOT, ["branch", "--show-current"]),
        dirty: Boolean(packageDirty),
      },
      honcho: {
        commit: git(honchoSource, ["rev-parse", "HEAD"]),
        branch: git(honchoSource, ["branch", "--show-current"]),
        upstreamVersion: (await fsp.readFile(path.join(honchoSource, ".honcho-upstream-version"), "utf8").catch(() => "unknown")).trim(),
        dirty: Boolean(dirty),
      },
      hostServices: hostProfile,
      contentId: await contentHash(candidateBundle),
      excluded: ["user conversations", "database volumes", ".env", "API keys", "tokens", "credentials", ".git"],
    };
    await fsp.writeFile(path.join(candidateBundle, "SOURCE_MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await archiveBuilder({ stageRoot, bundleName, candidateArchive });
    await validateCandidate({ candidateBundle, candidateArchive, bundleName, packageName: packageJson.name, manifest });
    const replacement = await swapReleaseArtifacts({ candidateBundle, candidateArchive, bundle, archive, existing });
    return {
      ok: true,
      bundle,
      archive,
      manifest,
      ...(replacement.warnings.length ? { warnings: replacement.warnings } : {}),
    };
  } finally {
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  return buildDistribution(options(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
