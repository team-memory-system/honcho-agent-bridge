// 기억 다시 정리 (rederive.mjs). The rebuild itself runs against the server's Docker
// stack; what is checked here is what decides it without one: the schema it makes,
// the admin token it signs, when the model counts as refusing, the time left, the
// second api and deriver in compose.yaml, and what it says with no server or an old
// one installed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { adminHeaders, etaFrom, nextSchemaName, refusing, rederiveFlow, rederivePaths, rederiveStart, rederiveStatus, serverOf } from "../scripts/rederive.mjs";
import { callsText, bytesText, lastDetail, lastLine, rebuildLine, rebuildNote, rebuildPercent } from "../ui/lib/rederive.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sandbox(t, { env = null, compose = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rederive-"));
  const serverDir = path.join(dir, "server");
  await fsp.mkdir(serverDir, { recursive: true });
  if (env !== null) await fsp.writeFile(path.join(serverDir, ".env"), env);
  if (compose !== null) await fsp.writeFile(path.join(serverDir, "compose.yaml"), compose);
  const config = { paths: { serverDir, dataDir: path.join(dir, "data"), appHome: dir } };
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return { dir, serverDir, config };
}

test("a rebuild's schema is named by the minute it started, in a name Postgres takes bare", () => {
  const name = nextSchemaName(new Date(2026, 9, 13, 3, 40));
  assert.equal(name, "mem_202610130340");
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/);
});

test("with auth on, the copy signs an admin token with the server's own secret, as Honcho's create_admin_jwt does", () => {
  assert.deepEqual(adminHeaders({ AUTH_USE_AUTH: "false", AUTH_JWT_SECRET: "s" }), {});
  assert.deepEqual(adminHeaders({ AUTH_USE_AUTH: "true" }), {});
  const { authorization } = adminHeaders({ AUTH_USE_AUTH: "true", AUTH_JWT_SECRET: "secret" });
  const [head, body, signature] = authorization.replace(/^Bearer /, "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url").toString()), { t: "", ad: true });
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  assert.equal(signature, crypto.createHmac("sha256", "secret").update(`${head}.${body}`).digest("base64url"));
});

test("the model counts as refusing only when errors grow and nothing goes through, poll after poll", () => {
  // Errors growing while the frontier moves: some refused, the rest goes on.
  assert.equal(refusing([{ done: 10, errored: 0 }, { done: 12, errored: 6 }, { done: 15, errored: 12 }]), false);
  // Nothing moves and nothing fails: the deriver is just slow.
  assert.equal(refusing([{ done: 10, errored: 0 }, { done: 10, errored: 0 }, { done: 10, errored: 0 }]), false);
  // Two polls of only refusals.
  assert.equal(refusing([{ done: 10, errored: 0 }, { done: 10, errored: 8 }, { done: 10, errored: 20 }]), true);
  // One is not enough.
  assert.equal(refusing([{ done: 10, errored: 0 }, { done: 10, errored: 8 }]), false);
});

test("the time left goes by the last hour's pace", () => {
  assert.equal(etaFrom([{ t: 0, done: 0 }], 100), null);
  assert.equal(etaFrom([{ t: 0, done: 0 }, { t: 60_000, done: 0 }], 100), null);
  // 50 in two minutes, 50 left: two minutes more.
  assert.equal(etaFrom([{ t: 0, done: 0 }, { t: 60_000, done: 10 }, { t: 120_000, done: 50 }], 100), 120);
  const old = { t: 0, done: 0 };
  const hour = 60 * 60_000;
  // Samples older than an hour are left out: the pace changed since.
  assert.equal(etaFrom([old, { t: 2 * hour, done: 1000 }, { t: 2 * hour + 60_000, done: 1001 }], 1101), 6000);
});

test("compose.yaml has the second api and deriver, over their own schema and namespace, on 127.0.0.1 only", async () => {
  const text = await fsp.readFile(path.join(ROOT, "server", "compose.yaml"), "utf8");
  for (const service of ["api-next", "deriver-next"]) {
    const block = text.split(new RegExp(`^  ${service}:`, "m"))[1].split(/^  [a-z][a-z-]*:/m)[0];
    assert.match(block, /profiles: \["rederive"\]/);
    assert.match(block, /DB_SCHEMA: \$\{HONCHO_NEXT_SCHEMA:-honcho_next\}/);
    assert.match(block, /NAMESPACE: \$\{HONCHO_NEXT_NAMESPACE:-honcho_next\}/);
  }
  assert.match(text, /"127\.0\.0\.1:\$\{HONCHO_NEXT_API_PORT:-8011\}:8000"/);
  // The api in use reads its schema from the private .env; it is never set here.
  const api = text.split(/^ {2}api:/m)[1].split(/^ {2}[a-z][a-z-]*:/m)[0];
  assert.doesNotMatch(api, /DB_SCHEMA/);
});

test("the server here: the schema and namespace in use, its address, and whether it has the second api yet", async (t) => {
  const { config } = await sandbox(t, {
    env: "HONCHO_API_PORT=8123\nDERIVER_WORKERS=4\nDB_SCHEMA=mem_202610130340\nNAMESPACE=mem_202610130340\n",
    compose: "services:\n  api:\n    image: x\n",
  });
  const server = await serverOf(config);
  assert.equal(server.current, "mem_202610130340");
  assert.equal(server.namespace, "mem_202610130340");
  assert.equal(server.apiUrl, "http://127.0.0.1:8123");
  assert.equal(server.workers, 4);
  assert.equal(server.ready, false);
  const plain = await sandbox(t, { env: "POSTGRES_PASSWORD=x\n", compose: await fsp.readFile(path.join(ROOT, "server", "compose.yaml"), "utf8") });
  const fresh = await serverOf(plain.config);
  assert.equal(fresh.current, "public");
  assert.equal(fresh.namespace, "honcho");
  assert.equal(fresh.apiUrl, "http://127.0.0.1:8001");
  assert.equal(fresh.ready, true);
});

test("with no server on this computer there is nothing to rebuild, and the dashboard shows nothing", async (t) => {
  const { config } = await sandbox(t);
  assert.deepEqual(await rederiveStatus(config), { ok: true, here: false });
  assert.equal((await rederiveStart(config)).code, "no-server");
  assert.equal(await rederiveFlow(config), null);
});

test("a server installed before 기억 다시 정리 asks for 다시 준비 first", async (t) => {
  const { config } = await sandbox(t, { env: "POSTGRES_PASSWORD=x\n", compose: "services:\n  api:\n    image: x\n" });
  const started = await rederiveStart(config);
  assert.equal(started.ok, false);
  assert.equal(started.code, "not-ready");
});

test("the dashboard reads the job and the last switch from the status file alone", async (t) => {
  const { config } = await sandbox(t);
  const paths = rederivePaths(config);
  await fsp.mkdir(paths.dir, { recursive: true });
  const job = { kind: "build", phase: "derive", startedAt: "2026-10-12T05:40:00Z", pid: 999_999_999, totals: { conversations: 10, messages: 100 }, derive: { done: 31, total: 100, at: Date.parse("2024-03-05T00:00:00Z"), etaSec: 57_600 } };
  await fsp.writeFile(paths.status, JSON.stringify({ version: 1, job, last: null, previous: null }));
  const flow = await rederiveFlow(config);
  assert.equal(flow.running, false);
  assert.equal(flow.job.phase, "derive");
  assert.equal(rebuildLine(flow.job), "2024년 3월 대화까지 · 31% · 약 16시간 남음");
  assert.equal(rebuildPercent(flow.job), 31);
  assert.equal(rebuildNote(flow.job), "다 만들면 새 기억으로 바꿉니다. 그때까지 지금 기억을 씁니다.");
});

test("the screens' words for a rebuild", () => {
  assert.equal(rebuildLine({ kind: "build", phase: "copy", copied: { conversations: 1200 }, totals: { conversations: 26640 } }), "대화를 옮기는 중 · 1,200 / 26,640");
  assert.equal(rebuildLine({ kind: "build", phase: "swap" }), "새 기억으로 바꾸는 중");
  assert.equal(rebuildLine({ kind: "undo", phase: "copy" }), "이전 기억으로 되돌리는 중");
  assert.match(rebuildNote({ kind: "build", phase: "derive", derive: { paused: { until: new Date(Date.now() + 3_600_000).toISOString() } } }), /^모델 사용 한도에 걸려 쉬는 중입니다\. .+에 이어서 합니다\.$/);
  assert.equal(rebuildNote({ kind: "build", phase: "derive", error: "x" }), "멈췄습니다. 다시 시도를 누르면 멈춘 곳부터 이어서 합니다.");
  assert.equal(callsText(41_200), "약 4만 번");
  assert.equal(callsText(3_240), "약 3,200번");
  assert.equal(bytesText(12.4 * 1024 ** 3), "약 12GB");
  assert.equal(bytesText(1.44 * 1024 ** 3), "약 1.4GB");
  assert.equal(bytesText(380 * 1024 ** 3, { about: false }), "380GB");
  const last = { kind: "build", swappedAt: new Date(2026, 9, 13, 3, 40).toISOString(), conversations: 26640, hours: 22.2, calls: 41200 };
  assert.match(lastLine(last), /^10월 13일 03:40에 새 기억으로 바꿈$|^2026년 10월 13일 03:40에 새 기억으로 바꿈$/);
  assert.equal(lastDetail(last), "대화 26,640개 · 22시간 걸림 · 모델 호출 약 4만 번");
});
