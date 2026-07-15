import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(ROOT, "scripts", "build-distribution.mjs");

test("distribution includes source and topology but excludes state and secrets", async (t) => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-distribution-"));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const honcho = path.join(temporary, "honcho");
  await fsp.mkdir(path.join(honcho, "src"), { recursive: true });
  await fsp.mkdir(path.join(honcho, "database"), { recursive: true });
  await fsp.mkdir(path.join(honcho, "local-dashboard", "public"), { recursive: true });
  await fsp.mkdir(path.join(honcho, "codex-openai-proxy"), { recursive: true });
  await fsp.mkdir(path.join(honcho, ".bench"), { recursive: true });
  await fsp.writeFile(path.join(honcho, "Dockerfile"), "FROM scratch\n");
  await fsp.writeFile(path.join(honcho, "LICENSE"), "AGPL test license\n");
  await fsp.writeFile(path.join(honcho, "src", "main.py"), "# source\n");
  await fsp.writeFile(path.join(honcho, "database", "init.sql"), "CREATE EXTENSION vector;\n");
  await fsp.writeFile(path.join(honcho, "local-dashboard", "Dockerfile"), "FROM scratch\n");
  await fsp.writeFile(path.join(honcho, "local-dashboard", "server.mjs"), "// dashboard\n");
  await fsp.writeFile(path.join(honcho, "codex-openai-proxy", "package.json"), '{"private":true}\n');
  await fsp.writeFile(path.join(honcho, "codex-openai-proxy", "server.mjs"), "// proxy\n");
  await fsp.writeFile(path.join(honcho, ".honcho-upstream-version"), "v3.0.11\n");
  await fsp.writeFile(path.join(honcho, ".env"), "MUST_NOT_COPY=private\n");
  await fsp.writeFile(path.join(honcho, ".bench", "messages.sqlite3"), "private benchmark data\n");
  await execFileAsync("git", ["init"], { cwd: honcho });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: honcho });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: honcho });
  await execFileAsync("git", ["add", "."], { cwd: honcho });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: honcho });
  const environment = path.join(temporary, "source.env");
  await fsp.writeFile(environment, [
    "LLM_OPENAI_API_KEY=sk-private-value",
    "AUTH_JWT_SECRET=private-secret",
    "EMBEDDING_MAX_INPUT_TOKENS=2048",
    "EMBEDDING_VECTOR_DIMENSIONS=1536",
    "LLM_OPENAI_COMPATIBLE_BASE_URL=http://localhost:9998/v1",
    "LLM_VLLM_BASE_URL=http://localhost:9999/v1",
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_OPENAI_API_KEY",
    "EMBEDDING_MODEL=qwen3-embedding:8b",
    "EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192",
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://host.docker.internal:11434/v1",
    "DERIVER_MODEL_CONFIG__MODEL=gpt-old",
    "DERIVER_MODEL_CONFIG__THINKING_BUDGET_TOKENS=9000",
    "DERIVER_MODEL_CONFIG__FALLBACK__MODEL=external-model",
    "DERIVER_MODEL_CONFIG__OVERRIDES__PROVIDER_PARAMS__EXTRA_HEADERS__AUTHORIZATION=Basic private-header",
    "DERIVER_MODEL_CONFIG__OVERRIDES__BASE_URL=http://localhost:9999/v1",
    "DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_VLLM_API_KEY",
    "DIALECTIC_LEVELS__minimal__MAX_TOOL_ITERATIONS=7",
    "DIALECTIC_LEVELS__minimal__MODEL_CONFIG__OVERRIDES__API_KEY=must-not-survive",
    "",
  ].join("\n"));
  const output = path.join(temporary, "output");
  const { stdout } = await execFileAsync(process.execPath, [
    BUILDER,
    "--honcho-source", honcho,
    "--env-source", environment,
    "--output", output,
    "--name", "release",
  ], { maxBuffer: 10 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  const bundle = path.join(output, "release");
  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(path.join(bundle, "HONCHO-LICENSE-AGPL-3.0.txt"), "utf8"), "AGPL test license\n");
  assert.equal(await fsp.stat(`${bundle}.tar.gz`).then(() => true), true);
  assert.equal(await fsp.access(path.join(bundle, "server", "honcho", ".env")).then(() => true, () => false), false);
  assert.equal(await fsp.access(path.join(bundle, "server", "honcho", ".git")).then(() => true, () => false), false);
  assert.equal(await fsp.access(path.join(bundle, "server", "honcho", ".bench")).then(() => true, () => false), false);
  const profile = await fsp.readFile(path.join(bundle, "server", "env.personal.example"), "utf8");
  assert.match(profile, /^LLM_OPENAI_API_KEY=$/m);
  assert.equal(profile.includes("AUTH_JWT_SECRET"), false);
  assert.match(profile, /^EMBEDDING_MAX_INPUT_TOKENS=8192$/m);
  assert.match(profile, /^EMBEDDING_MAX_TOKENS_PER_REQUEST=8192$/m);
  assert.match(profile, /^EMBEDDING_VECTOR_DIMENSIONS=1536$/m);
  assert.match(profile, /^EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-honcho-8192$/m);
  assert.match(profile, /^EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http:\/\/host\.docker\.internal:11434\/v1$/m);
  assert.match(profile, /^EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_OPENAI_COMPATIBLE_API_KEY$/m);
  assert.match(profile, /^EMBEDDING_QUERY_INSTRUCTION=Given a personal memory search query,/m);
  assert.match(profile, /^EMBED_MESSAGES=true$/m);
  assert.match(profile, /^VECTOR_STORE_TYPE=pgvector$/m);
  assert.match(profile, /^VECTOR_STORE_MIGRATED=true$/m);
  assert.match(profile, /^LLM_OPENAI_COMPATIBLE_BASE_URL=http:\/\/host\.docker\.internal:11434\/v1$/m);
  assert.match(profile, /^LLM_VLLM_BASE_URL=http:\/\/host\.docker\.internal:11435\/v1$/m);
  const codexPrefixes = [
    "DERIVER_MODEL_CONFIG",
    "SUMMARY_MODEL_CONFIG",
    "DREAM_DEDUCTION_MODEL_CONFIG",
    "DREAM_INDUCTION_MODEL_CONFIG",
    ...["minimal", "low", "medium", "high", "max"].map((level) => `DIALECTIC_LEVELS__${level}__MODEL_CONFIG`),
  ];
  for (const prefix of codexPrefixes) {
    assert.match(profile, new RegExp(`^${prefix}__TRANSPORT=openai$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__MODEL=gpt-5\\.6-sol$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__THINKING_EFFORT=high$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__OVERRIDES__BASE_URL=http://host\\.docker\\.internal:11435/v1$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__OVERRIDES__API_KEY_ENV=LLM_VLLM_API_KEY$`, "m"));
  }
  assert.match(profile, /^DIALECTIC_LEVELS__minimal__MAX_TOOL_ITERATIONS=7$/m);
  assert.equal(profile.includes("must-not-survive"), false);
  assert.equal(profile.includes("private-header"), false);
  assert.equal(profile.includes("THINKING_BUDGET_TOKENS"), false);
  assert.equal(profile.includes("__FALLBACK__"), false);
  assert.equal(profile.includes("localhost:999"), false);
  assert.equal(profile.includes("private-value"), false);
  const hostProfile = JSON.parse(await fsp.readFile(path.join(bundle, "server", "host-profile.personal.json"), "utf8"));
  assert.equal(hostProfile.codexProxy.enabled, true);
  assert.equal(hostProfile.codexProxy.defaultModel, "gpt-5.6-sol");
  assert.equal(hostProfile.ollama.enabled, true);
  assert.equal(hostProfile.ollama.model, "qwen3-embedding-honcho-8192");
  assert.equal(hostProfile.ollama.dimensions, 1536);
  assert.equal(hostProfile.ollama.contextLength, 8192);
  assert.equal(hostProfile.ollama.keepAlive, -1);
  assert.equal(JSON.stringify(hostProfile).includes("private-value"), false);
  const manifest = JSON.parse(await fsp.readFile(path.join(bundle, "SOURCE_MANIFEST.json"), "utf8"));
  assert.equal(manifest.honcho.upstreamVersion, "v3.0.11");
  assert.equal(manifest.honcho.dirty, false);
  assert.equal(manifest.hostServices.codexProxy.enabled, true);
});
