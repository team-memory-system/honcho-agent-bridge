import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { buildDistribution } from "../scripts/build-distribution.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(ROOT, "scripts", "build-distribution.mjs");
const SOURCE_CHECKOUT = await fsp.access(path.join(ROOT, ".git")).then(() => true, () => false);
const SOURCE_CHECKOUT_ONLY = {
  skip: SOURCE_CHECKOUT ? false : "release-builder tests require Git source provenance",
};

// The builder takes a honcho-selfhost wrapper and ships only what its preparer
// writes. The real preparer exports the pinned upstream with the patches applied;
// this one writes the files listed in the fixture's prepared.json.
const PREPARER = `import fs from "node:fs/promises";
import path from "node:path";
const output = path.resolve(process.argv[process.argv.indexOf("--output") + 1]);
const files = JSON.parse(await fs.readFile(new URL("../prepared.json", import.meta.url), "utf8"));
for (const [relative, text] of Object.entries(files)) {
  await fs.mkdir(path.dirname(path.join(output, relative)), { recursive: true });
  await fs.writeFile(path.join(output, relative), text);
}
`;

const PREPARED = {
  "Dockerfile": "FROM scratch\n",
  "LICENSE": "AGPL test license\n",
  "src/main.py": "# source\n",
  "database/init.sql": "CREATE EXTENSION vector;\n",
  "local-dashboard/Dockerfile": "FROM scratch\n",
  "local-dashboard/server.mjs": "// dashboard\n",
  ".honcho-source.json": `${JSON.stringify({
    format: 1,
    kind: "honcho-selfhost-source",
    upstream: { path: "upstream/honcho", repo: "https://github.com/plastic-labs/honcho", ref: "v3.0.11", commit: "a".repeat(40) },
    patches: [{ path: "patches/0001-selfhost-core.patch", sha256: "b".repeat(64) }],
  })}\n`,
};

async function createWrappedHoncho(root, prepared = {}) {
  const honcho = path.join(root, "honcho");
  await fsp.mkdir(path.join(honcho, "scripts"), { recursive: true });
  await fsp.mkdir(path.join(honcho, "local-dashboard"), { recursive: true });
  await fsp.writeFile(path.join(honcho, "selfhost-source.json"), '{"format":1}\n');
  await fsp.writeFile(path.join(honcho, "scripts", "prepare-source.mjs"), PREPARER);
  await fsp.writeFile(path.join(honcho, "prepared.json"), JSON.stringify({ ...PREPARED, ...prepared }));
  await fsp.writeFile(path.join(honcho, "LICENSE"), "AGPL test license\n");
  await fsp.writeFile(path.join(honcho, "local-dashboard", "Dockerfile"), "FROM scratch\n");
  await fsp.writeFile(path.join(honcho, ".honcho-upstream-version"), "v3.0.11\n");
  await execFileAsync("git", ["init"], { cwd: honcho });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: honcho });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: honcho });
  await execFileAsync("git", ["add", "."], { cwd: honcho });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: honcho });
  return honcho;
}

test("distribution includes source and topology but excludes state and secrets", SOURCE_CHECKOUT_ONLY, async (t) => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-distribution-"));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  // A preparer that left local state behind in its output: the builder's own
  // filter still keeps it out of the bundle.
  const honcho = await createWrappedHoncho(temporary, {
    ".env": "MUST_NOT_COPY=private\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    ".bench/messages.sqlite3": "private benchmark data\n",
  });
  // The wrapper checkout itself never ships, tracked or not.
  await fsp.writeFile(path.join(honcho, ".env"), "MUST_NOT_COPY=private\n");
  await fsp.writeFile(path.join(honcho, "notes.txt"), "UNTRACKED_CONFIDENTIAL_SENTINEL\n");
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
    "SUMMARY_SYSTEM_PROMPT=CONFIDENTIAL_PROMPT_SENTINEL",
    "EMBEDDING_CUSTOM_HEADER=Basic CONFIDENTIAL_HEADER_SENTINEL",
    "DREAM_WEBHOOK_URL=https://example.invalid/CONFIDENTIAL_WEBHOOK_SENTINEL",
    "",
  ].join("\n"));
  const output = path.join(temporary, "output");
  const { stdout } = await execFileAsync(process.execPath, [
    BUILDER,
    "--honcho-source", honcho,
    "--env-source", environment,
    "--output", output,
    "--name", "release",
    "--allow-dirty",
  ], { maxBuffer: 10 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  const bundle = path.join(output, "release");
  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(path.join(bundle, "HONCHO-LICENSE-AGPL-3.0.txt"), "utf8"), "AGPL test license\n");
  assert.equal(await fsp.stat(`${bundle}.tar.gz`).then(() => true), true);
  assert.equal(await fsp.access(path.join(bundle, "server", "honcho", ".env")).then(() => true, () => false), false);
  assert.equal(await fsp.access(path.join(bundle, "server", "honcho", ".git")).then(() => true, () => false), false);
  assert.equal(await fsp.access(path.join(bundle, "server", "honcho", ".bench")).then(() => true, () => false), false);
  assert.equal(await fsp.readFile(path.join(bundle, "server", "honcho", "local-dashboard", "server.mjs"), "utf8"), "// dashboard\n");
  for (const wrapperOnly of ["notes.txt", "prepared.json", "selfhost-source.json", path.join("scripts", "prepare-source.mjs")]) {
    assert.equal(await fsp.access(path.join(bundle, "server", "honcho", wrapperOnly)).then(() => true, () => false), false, wrapperOnly);
  }
  const profile = await fsp.readFile(path.join(bundle, "server", "env.personal.example"), "utf8");
  assert.match(profile, /^LLM_OPENAI_API_KEY=$/m);
  assert.equal(profile.includes("AUTH_JWT_SECRET"), false);
  assert.match(profile, /^EMBEDDING_MAX_INPUT_TOKENS=8192$/m);
  assert.match(profile, /^EMBEDDING_MAX_TOKENS_PER_REQUEST=8192$/m);
  assert.match(profile, /^EMBEDDING_VECTOR_DIMENSIONS=1536$/m);
  // The owner's own install runs the 8B alias; a new team install starts on 4B.
  assert.match(profile, /^EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-4b-honcho-8192$/m);
  assert.equal(profile.includes("qwen3-embedding-honcho-8192"), false);
  assert.match(profile, /^EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http:\/\/host\.docker\.internal:11434\/v1$/m);
  assert.match(profile, /^EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_OPENAI_COMPATIBLE_API_KEY$/m);
  assert.match(profile, /^EMBEDDING_QUERY_INSTRUCTION=Given a personal memory search query,/m);
  assert.match(profile, /^EMBED_MESSAGES=true$/m);
  assert.match(profile, /^VECTOR_STORE_TYPE=pgvector$/m);
  assert.match(profile, /^VECTOR_STORE_MIGRATED=true$/m);
  assert.match(profile, /^LLM_OPENAI_COMPATIBLE_BASE_URL=http:\/\/host\.docker\.internal:11434\/v1$/m);
  // Every chat model goes through the subscription gateway's router, whatever the
  // source environment pointed at: `server prepare` writes the installed gateway's
  // own address, key and model over these defaults.
  assert.match(profile, /^LLM_VLLM_BASE_URL=http:\/\/host\.docker\.internal:11400\/v1$/m);
  assert.match(profile, /^LLM_VLLM_API_KEY=$/m);
  const chatPrefixes = [
    "DERIVER_MODEL_CONFIG",
    "SUMMARY_MODEL_CONFIG",
    "DREAM_DEDUCTION_MODEL_CONFIG",
    "DREAM_INDUCTION_MODEL_CONFIG",
    ...["minimal", "low", "medium", "high", "max"].map((level) => `DIALECTIC_LEVELS__${level}__MODEL_CONFIG`),
  ];
  for (const prefix of chatPrefixes) {
    assert.match(profile, new RegExp(`^${prefix}__TRANSPORT=openai$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__MODEL=gpt-6-luna$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__THINKING_EFFORT=low$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__OVERRIDES__BASE_URL=http://host\\.docker\\.internal:11400/v1$`, "m"));
    assert.match(profile, new RegExp(`^${prefix}__OVERRIDES__API_KEY_ENV=LLM_VLLM_API_KEY$`, "m"));
  }
  assert.match(profile, /^DIALECTIC_LEVELS__minimal__MAX_TOOL_ITERATIONS=7$/m);
  assert.equal(profile.includes("must-not-survive"), false);
  assert.equal(profile.includes("private-header"), false);
  assert.equal(profile.includes("THINKING_BUDGET_TOKENS"), false);
  assert.equal(profile.includes("__FALLBACK__"), false);
  assert.equal(profile.includes("localhost:999"), false);
  assert.equal(profile.includes(":9999"), false, "the source environment's own endpoint is not copied");
  assert.equal(profile.includes("11435"), false);
  assert.equal(profile.includes("private-value"), false);
  assert.equal(profile.includes("CONFIDENTIAL_"), false);
  assert.match(profile, /^TRUSTED_HOSTS=\["localhost","127\.0\.0\.1","api"\]$/m);
  const hostProfileText = await fsp.readFile(path.join(bundle, "server", "host-profile.personal.json"), "utf8");
  const hostProfile = JSON.parse(hostProfileText);
  // The gateway ships from its own repository; the bundle records only where it is
  // expected to answer, and the pin that says where to fetch it.
  assert.deepEqual(hostProfile.gateway, { uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" });
  for (const gone of ["codexProxy", "claudeProxy", "router", "llmProxyRoot"]) assert.equal(gone in hostProfile, false, gone);
  assert.equal(hostProfileText.includes("11435"), false);
  const gatewayPin = JSON.parse(await fsp.readFile(path.join(bundle, "server", "gateway-source.json"), "utf8"));
  assert.equal(gatewayPin.repo, "https://github.com/team-memory-system/subscription-gateway");
  assert.equal(hostProfile.ollama.enabled, true);
  assert.equal(hostProfile.ollama.model, "qwen3-embedding-4b-honcho-8192");
  assert.equal(hostProfile.ollama.baseModel, "qwen3-embedding:4b");
  await assert.rejects(
    fsp.access(path.join(bundle, "server", "host", "qwen3-embedding-8192.Modelfile")),
    "the Modelfile is generated from the alias's base at prepare time, not bundled",
  );
  assert.equal(hostProfile.ollama.dimensions, 1536);
  assert.equal(hostProfile.ollama.contextLength, 8192);
  assert.equal(hostProfile.ollama.keepAlive, -1);
  assert.equal(JSON.stringify(hostProfile).includes("private-value"), false);
  const manifest = JSON.parse(await fsp.readFile(path.join(bundle, "SOURCE_MANIFEST.json"), "utf8"));
  assert.equal(typeof manifest.honchoAgentBridge.commit, "string");
  assert.equal(typeof manifest.honchoAgentBridge.dirty, "boolean");
  assert.equal(manifest.honcho.upstreamVersion, "v3.0.11");
  assert.equal(manifest.honcho.upstream.commit, "a".repeat(40));
  assert.deepEqual(manifest.honcho.patches.map((patch) => patch.path), ["patches/0001-selfhost-core.patch"]);
  assert.equal(manifest.honcho.dirty, true);
  assert.equal(manifest.hostServices.gateway.routerUrl, "http://127.0.0.1:11400/v1");

  const rerun = await execFileAsync(process.execPath, [
    BUILDER,
    "--honcho-source", honcho,
    "--env-source", environment,
    "--output", output,
    "--name", "release",
    "--allow-dirty",
  ], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(JSON.parse(rerun.stdout).ok, true, "a builder-owned release directory may be replaced");
});

test("failed environment, copy, and archive stages preserve the prior release byte-for-byte", SOURCE_CHECKOUT_ONLY, async (t) => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-distribution-rollback-"));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const honcho = await createWrappedHoncho(temporary);
  const output = path.join(temporary, "output");
  const bundle = path.join(output, "release");
  const archive = `${bundle}.tar.gz`;
  const packageJson = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const oldManifest = `${JSON.stringify({ package: { name: packageJson.name }, generation: "prior" }, null, 2)}\n`;
  const oldMarker = Buffer.from("PRIOR_RELEASE_BYTES\n");
  const oldArchive = Buffer.from("PRIOR_ARCHIVE_BYTES\0\u0001\u0002");
  await fsp.mkdir(bundle, { recursive: true });
  await fsp.writeFile(path.join(bundle, "SOURCE_MANIFEST.json"), oldManifest);
  await fsp.writeFile(path.join(bundle, "marker.bin"), oldMarker);
  await fsp.writeFile(archive, oldArchive);

  const args = {
    "honcho-source": honcho,
    output,
    name: "release",
    "allow-dirty": true,
  };
  const assertPriorRelease = async () => {
    assert.equal(await fsp.readFile(path.join(bundle, "SOURCE_MANIFEST.json"), "utf8"), oldManifest);
    assert.deepEqual(await fsp.readFile(path.join(bundle, "marker.bin")), oldMarker);
    assert.deepEqual(await fsp.readFile(archive), oldArchive);
    assert.deepEqual((await fsp.readdir(output)).sort(), ["release", "release.tar.gz"]);
  };

  await assert.rejects(
    buildDistribution({ ...args, "env-source": path.join(temporary, "missing.env") }),
    /ENOENT/,
  );
  await assertPriorRelease();

  await assert.rejects(
    buildDistribution(args, {
      copyTree: async () => { throw new Error("injected copy failure"); },
    }),
    /injected copy failure/,
  );
  await assertPriorRelease();

  await assert.rejects(
    buildDistribution(args, {
      archiveBuilder: async () => { throw new Error("injected archive failure"); },
    }),
    /injected archive failure/,
  );
  await assertPriorRelease();
});

test("distribution refuses unsafe names and unrelated existing directories", SOURCE_CHECKOUT_ONLY, async (t) => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-distribution-path-"));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, "output");
  const unrelated = path.join(output, "release");
  await fsp.mkdir(unrelated, { recursive: true });
  await fsp.writeFile(path.join(unrelated, "sentinel.txt"), "keep\n");

  await assert.rejects(
    execFileAsync(process.execPath, [
      BUILDER,
      "--honcho-source", temporary,
      "--output", output,
      "--name", "..",
      "--allow-dirty",
    ]),
    /Bundle name must be a single safe file name/,
  );
  assert.equal(await fsp.readFile(path.join(unrelated, "sentinel.txt"), "utf8"), "keep\n");

  await assert.rejects(
    execFileAsync(process.execPath, [
      BUILDER,
      "--honcho-source", temporary,
      "--output", output,
      "--name", "release",
      "--allow-dirty",
    ]),
  );
  assert.equal(await fsp.readFile(path.join(unrelated, "sentinel.txt"), "utf8"), "keep\n");
});
