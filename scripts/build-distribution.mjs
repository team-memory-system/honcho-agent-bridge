import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERSONAL_MODEL_PREFIXES = [
  "DERIVER_MODEL_CONFIG",
  "SUMMARY_MODEL_CONFIG",
  "DREAM_DEDUCTION_MODEL_CONFIG",
  "DREAM_INDUCTION_MODEL_CONFIG",
  ...["minimal", "low", "medium", "high", "max"].map((level) => `DIALECTIC_LEVELS__${level}__MODEL_CONFIG`),
];
const PERSONAL_MODEL_SUFFIXES = new Set([
  "TRANSPORT",
  "MODEL",
  "THINKING_EFFORT",
  "OVERRIDES__BASE_URL",
  "OVERRIDES__API_KEY_ENV",
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

async function copyTree(source, destination) {
  await fsp.cp(source, destination, {
    recursive: true,
    filter: target => !excluded(source, target),
  });
}

async function contentHash(directory) {
  const files = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
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

function sanitizedEnvironment(text) {
  const allowed = /^(?:LOG_LEVEL|AUTH_USE_AUTH|EMBED_MESSAGES|EMBEDDING_[A-Z0-9_]*|DERIVER_[A-Z0-9_]*|DIALECTIC_[A-Za-z0-9_]*|SUMMARY_[A-Z0-9_]*|DREAM_[A-Z0-9_]*|VECTOR_STORE_[A-Z0-9_]*|HONCHO_(?:API_PORT|DASHBOARD_PORT|IMAGE_TAG)|LLM_(?:OPENAI|OPENAI_COMPATIBLE|VLLM)_(?:BASE_URL|API_KEY))$/;
  const lines = text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !allowed.test(match[1])) return [];
    const [, key, value] = match;
    if (key.endsWith("__OVERRIDES__API_KEY")) return [];
    if (/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(key)) return [`${key}=`];
    if (key.endsWith("BASE_URL")) {
      try {
        const url = new URL(value);
        if (!["host.docker.internal", "127.0.0.1", "localhost"].includes(url.hostname)) return [`${key}=`];
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return [`${key}=${url.toString().replace(/\/$/, "")}`];
      } catch { return [`${key}=`]; }
    }
    if (/\b(?:sk-|hch-|Bearer\s+)/i.test(value)) return [`${key}=`];
    return [line];
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

function personalEnvironment(text) {
  const sanitized = withoutConflictingPersonalModelSettings(sanitizedEnvironment(text));
  const proxyBaseUrl = "http://host.docker.internal:11435/v1";
  const embeddingBaseUrl = "http://host.docker.internal:11434/v1";
  const values = {
    EMBED_MESSAGES: "true",
    LLM_VLLM_BASE_URL: proxyBaseUrl,
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
  };
  for (const prefix of PERSONAL_MODEL_PREFIXES) {
    values[`${prefix}__TRANSPORT`] = "openai";
    values[`${prefix}__MODEL`] = "gpt-5.6-sol";
    values[`${prefix}__THINKING_EFFORT`] = "high";
    values[`${prefix}__OVERRIDES__BASE_URL`] = proxyBaseUrl;
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

function portFromUrl(value, fallback) {
  try { return Number(new URL(value).port || fallback); } catch { return fallback; }
}

function personalHostProfile(text) {
  const env = parseEnvironment(text);
  const embeddingUrl = env.EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL
    || env.LLM_OPENAI_COMPATIBLE_BASE_URL
    || "";
  const proxyUrl = env.DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL
    || env.LLM_VLLM_BASE_URL
    || "";
  const embeddingModel = env.EMBEDDING_MODEL_CONFIG__MODEL || "";
  const codexModel = env.DERIVER_MODEL_CONFIG__MODEL || "gpt-5.6-sol";
  const ollamaEnabled = /(?:host\.docker\.internal|127\.0\.0\.1|localhost):11434(?:\/|$)/.test(embeddingUrl);
  const codexProxyEnabled = /(?:host\.docker\.internal|127\.0\.0\.1|localhost):11435(?:\/|$)/.test(proxyUrl);
  return {
    format: 1,
    profile: "personal",
    codexProxy: {
      enabled: codexProxyEnabled,
      defaultModel: codexModel,
      port: portFromUrl(proxyUrl, 11435),
    },
    ollama: {
      enabled: ollamaEnabled,
      baseUrl: "http://127.0.0.1:11434",
      baseModel: env.AGENT_MEMORY_OLLAMA_BASE_MODEL || "qwen3-embedding:8b",
      model: embeddingModel || "qwen3-embedding-honcho-8192",
      contextLength: Number(env.EMBEDDING_MAX_INPUT_TOKENS || 8192),
      dimensions: Number(env.EMBEDDING_VECTOR_DIMENSIONS || 1536),
      keepAlive: -1,
    },
  };
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args["honcho-source"]) throw new Error("--honcho-source is required");
  const honchoSource = path.resolve(args["honcho-source"]);
  const packageJson = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const outputRoot = path.resolve(args.output || path.join(path.dirname(ROOT), "agent-memory-releases"));
  const bundleName = args.name || `agent-memory-${packageJson.version}`;
  const bundle = path.join(outputRoot, bundleName);
  for (const required of ["Dockerfile", "LICENSE", "src", "database/init.sql", "local-dashboard/Dockerfile"]) {
    if (!(await exists(path.join(honchoSource, required)))) throw new Error(`Honcho source is missing ${required}`);
  }
  const dirty = git(honchoSource, ["status", "--porcelain"]);
  if (dirty && !args["allow-dirty"]) throw new Error("Honcho source has uncommitted changes; commit them or pass --allow-dirty intentionally");

  await fsp.rm(bundle, { recursive: true, force: true });
  await fsp.mkdir(bundle, { recursive: true });
  await copyTree(ROOT, bundle);
  await fsp.mkdir(path.join(bundle, "server", "honcho"), { recursive: true });
  await copyTree(honchoSource, path.join(bundle, "server", "honcho"));
  await fsp.copyFile(path.join(honchoSource, "LICENSE"), path.join(bundle, "HONCHO-LICENSE-AGPL-3.0.txt"));

  let hostProfile = null;
  if (args["env-source"]) {
    const source = await fsp.readFile(path.resolve(args["env-source"]), "utf8");
    const environment = personalEnvironment(source);
    await fsp.writeFile(path.join(bundle, "server", "env.personal.example"), environment, "utf8");
    hostProfile = personalHostProfile(environment);
    if (hostProfile.codexProxy.enabled) {
      for (const required of ["package.json", "server.mjs"]) {
        if (!(await exists(path.join(honchoSource, "codex-openai-proxy", required)))) {
          throw new Error(`Personal profile requires codex-openai-proxy/${required}`);
        }
      }
    }
    await fsp.writeFile(
      path.join(bundle, "server", "host-profile.personal.json"),
      `${JSON.stringify(hostProfile, null, 2)}\n`,
      "utf8",
    );
  }

  const manifest = {
    format: 1,
    generatedAt: new Date().toISOString(),
    package: { name: packageJson.name, version: packageJson.version },
    honcho: {
      commit: git(honchoSource, ["rev-parse", "HEAD"]),
      branch: git(honchoSource, ["branch", "--show-current"]),
      upstreamVersion: (await fsp.readFile(path.join(honchoSource, ".honcho-upstream-version"), "utf8").catch(() => "unknown")).trim(),
      dirty: Boolean(dirty),
    },
    hostServices: hostProfile,
    contentId: await contentHash(bundle),
    excluded: ["user conversations", "database volumes", ".env", "API keys", "tokens", "credentials", ".git"],
  };
  await fsp.writeFile(path.join(bundle, "SOURCE_MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const archive = `${bundle}.tar.gz`;
  await fsp.rm(archive, { force: true });
  const tarExecutable = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  execFileSync(tarExecutable, ["--no-xattrs", "-czf", archive, "-C", outputRoot, bundleName], {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, bundle, archive, manifest }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
