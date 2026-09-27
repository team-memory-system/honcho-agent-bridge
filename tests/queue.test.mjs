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
const QUEUE = path.join(ROOT, "scripts", "queue.mjs");

test("queue never reclaims an old lock while its owner process is alive", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-queue-lock-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const spool = path.join(directory, "spool");
  const lockPath = path.join(spool, "drain.lock");
  await fsp.mkdir(spool, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, nonce: "test-owner", created_at: "2026-01-01T00:00:00.000Z" });
  await fsp.writeFile(lockPath, owner);
  const old = new Date(Date.now() - 600_000);
  await fsp.utimes(lockPath, old, old);
  const env = {
    ...process.env,
    HONCHO_CODEX_GATE_SPOOL: spool,
    HONCHO_CODEX_GATE_LOG: path.join(directory, "queue.log"),
    HONCHO_CODEX_GATE_LOCK_STALE_MS: "1",
    HONCHO_CODEX_GATE_QUIET: "0",
  };

  await assert.rejects(
    execFileAsync(process.execPath, [QUEUE, "--drain"], { env }),
    (error) => String(error.stdout || "").includes("drain already running"),
  );
  assert.equal(await fsp.readFile(lockPath, "utf8"), owner);
});

test("only one queue process can reclaim and enter through the same dead stale lock", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-queue-reclaim-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const spool = path.join(directory, "spool");
  const pending = path.join(spool, "pending");
  const lockPath = path.join(spool, "drain.lock");
  const transcript = path.join(directory, "transcript.jsonl");
  const importer = path.join(directory, "importer.mjs");
  const calls = path.join(directory, "calls.log");
  await fsp.mkdir(pending, { recursive: true });
  await fsp.writeFile(transcript, "{}\n");
  await fsp.writeFile(
    path.join(pending, "one.json"),
    JSON.stringify({ transcript_path: transcript, created_at: new Date().toISOString() }),
  );
  await fsp.writeFile(
    importer,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, "called\\n");
const end = Date.now() + 300;
while (Date.now() < end) {}
console.log(JSON.stringify({ ok: true }));
`,
  );
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_999, nonce: "dead-owner" }));
  const old = new Date(Date.now() - 600_000);
  await fsp.utimes(lockPath, old, old);
  const env = {
    ...process.env,
    HONCHO_CODEX_GATE_SPOOL: spool,
    HONCHO_CODEX_GATE_LOG: path.join(directory, "queue.log"),
    HONCHO_CODEX_GATE_LOCK_STALE_MS: "1",
    HONCHO_CODEX_GATE_QUIET: "0",
    HONCHO_CODEX_IMPORTER: importer,
  };

  const results = await Promise.allSettled([
    execFileAsync(process.execPath, [QUEUE, "--drain"], { env }),
    execFileAsync(process.execPath, [QUEUE, "--drain"], { env }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await fsp.readFile(calls, "utf8")).trim().split(/\r?\n/).length, 1);
  assert.deepEqual(await fsp.readdir(pending), []);
});

test("queue recovers an orphaned reclaim guard", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-orphan-guard-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const spool = path.join(directory, "spool");
  const lockPath = path.join(spool, "drain.lock");
  const guardPath = `${lockPath}.reclaim`;
  await fsp.mkdir(spool, { recursive: true });
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_998, nonce: "dead-main" }));
  await fsp.writeFile(guardPath, JSON.stringify({ pid: 999_999_997, nonce: "dead-reclaimer" }));
  const old = new Date(Date.now() - 600_000);
  await fsp.utimes(lockPath, old, old);
  const env = {
    ...process.env,
    HONCHO_CODEX_GATE_SPOOL: spool,
    HONCHO_CODEX_GATE_LOG: path.join(directory, "queue.log"),
    HONCHO_CODEX_GATE_LOCK_STALE_MS: "1",
    HONCHO_CODEX_GATE_QUIET: "0",
  };

  const result = JSON.parse((await execFileAsync(process.execPath, [QUEUE, "--drain"], { env })).stdout);
  assert.equal(result.ok, true);
  await assert.rejects(fsp.access(lockPath));
  await assert.rejects(fsp.access(guardPath));
});

test("queue never expires a reclaim guard whose owner is still alive", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-live-guard-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const spool = path.join(directory, "spool");
  const lockPath = path.join(spool, "drain.lock");
  const guardPath = `${lockPath}.reclaim`;
  await fsp.mkdir(spool, { recursive: true });
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 999_999_996, nonce: "dead-main" }));
  const liveGuard = JSON.stringify({ pid: process.pid, nonce: "live-reclaimer" });
  await fsp.writeFile(guardPath, liveGuard);
  const old = new Date(Date.now() - 600_000);
  await fsp.utimes(lockPath, old, old);
  await fsp.utimes(guardPath, old, old);
  const env = {
    ...process.env,
    HONCHO_CODEX_GATE_SPOOL: spool,
    HONCHO_CODEX_GATE_LOG: path.join(directory, "queue.log"),
    HONCHO_CODEX_GATE_LOCK_STALE_MS: "1",
    HONCHO_CODEX_GATE_QUIET: "0",
  };

  await assert.rejects(
    execFileAsync(process.execPath, [QUEUE, "--drain"], { env }),
    (error) => String(error.stdout || "").includes("drain already running"),
  );
  assert.equal(await fsp.readFile(guardPath, "utf8"), liveGuard);
});
