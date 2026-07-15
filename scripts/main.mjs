import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configEnvironment, installPaths, loadConfig } from "./config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_RUNNER = path.join(SCRIPT_DIR, "queue.mjs");
const COLLECTOR = path.join(SCRIPT_DIR, "collector.mjs");
const DEFAULT_PROVIDERS = ["codex", "claude", "agy"];
const RUNTIME_CONFIG = await loadConfig();

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function utcNow() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const passthrough = [];
  let provider = process.env.HONCHO_AGENT_PROVIDER || "codex";
  let transcript = "";

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--provider") {
      provider = argv[++index] || provider;
    } else if (item === "--transcript" || item === "--transcript-path") {
      transcript = argv[++index] || "";
    } else {
      passthrough.push(item);
    }
  }

  if (transcript) passthrough.push("--rollout", transcript);
  return { provider: provider.trim().toLowerCase(), passthrough };
}

async function readHookInput() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try {
    const input = JSON.parse(raw);
    return input && typeof input === "object" ? input : {};
  } catch {
    return {};
  }
}

function normalizeHookInput(input) {
  const normalized = { ...input };
  if (!normalized.transcript_path && typeof input.transcriptPath === "string") {
    normalized.transcript_path = input.transcriptPath;
  }
  if (!normalized.conversation_id && typeof input.conversationId === "string") {
    normalized.conversation_id = input.conversationId;
  }
  if (!normalized.artifact_directory_path && typeof input.artifactDirectoryPath === "string") {
    normalized.artifact_directory_path = input.artifactDirectoryPath;
  }
  if (!normalized.workspace_paths && Array.isArray(input.workspacePaths)) {
    normalized.workspace_paths = input.workspacePaths;
  }
  return normalized;
}

function providerEnv(provider) {
  const configuredEnv = configEnvironment(RUNTIME_CONFIG, provider);
  const effectiveEnv = { ...process.env, ...configuredEnv };
  const configuredDataDir = RUNTIME_CONFIG ? installPaths(RUNTIME_CONFIG).dataDir : "";
  const baseSpool = expandHome(
    effectiveEnv.HONCHO_AGENT_GATE_SPOOL ||
      (configuredDataDir ? path.join(configuredDataDir, "spool") : "~/.hermes/spool/agent-honcho"),
  );
  return {
    ...effectiveEnv,
    HONCHO_AGENT_PROVIDER: provider,
    HONCHO_CODEX_IMPORTER: effectiveEnv.HONCHO_AGENT_IMPORTER || COLLECTOR,
    HONCHO_CODEX_GATE_SPOOL: effectiveEnv.HONCHO_CODEX_GATE_SPOOL || path.join(baseSpool, provider),
    HONCHO_CODEX_GATE_LOG:
      effectiveEnv.HONCHO_CODEX_GATE_LOG ||
      (configuredDataDir
        ? path.join(configuredDataDir, "logs", `${provider}-gate.log`)
        : expandHome(`~/.hermes/logs/${provider}-honcho-turn-gate.log`)),
    HONCHO_CODEX_IMPORTER_TRIGGER: effectiveEnv.HONCHO_AGENT_IMPORTER_TRIGGER || "hook_gate",
    HONCHO_GATE_PASS_HOOK_INPUT: "1",
  };
}

function runGate(provider, passthrough, hookInput) {
  const result = spawnSync(process.execPath, [QUEUE_RUNNER, ...passthrough], {
    encoding: "utf8",
    env: providerEnv(provider),
    input: JSON.stringify(hookInput),
  });
  return {
    provider,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error ? result.error.message : "",
  };
}

function printIfUseful(results) {
  const quiet = process.env.HONCHO_AGENT_GATE_QUIET === "1";
  if (quiet) return;

  const visible = results
    .map((item) => item.stdout || item.stderr)
    .filter(Boolean)
    .join("\n");
  if (visible) {
    process.stdout.write(`${visible}\n`);
    return;
  }

  if (process.env.HONCHO_CODEX_GATE_QUIET === "0") {
    process.stdout.write(`${JSON.stringify({ ok: results.every((item) => item.status === 0), results })}\n`);
  }
}

async function logAggregate(results) {
  const logPath = expandHome(process.env.HONCHO_AGENT_GATE_LOG || "~/.hermes/logs/agent-honcho-turn-gate.log");
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await fsp.appendFile(logPath, `${utcNow()} ${JSON.stringify({ results })}\n`, "utf8");
}

const { provider, passthrough } = parseArgs(process.argv.slice(2));
const hookInput = normalizeHookInput(await readHookInput());
const providers = provider === "all" ? DEFAULT_PROVIDERS : [provider];
const results = providers.map((item) => runGate(item, passthrough, hookInput));
await logAggregate(results).catch(() => {});
printIfUseful(results);
process.exitCode = results.every((item) => item.status === 0 && !item.error) ? 0 : 1;
