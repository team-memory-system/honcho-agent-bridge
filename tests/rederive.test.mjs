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

import { adminHeaders, etaFor, etaFrom, keptRecord, nextSchemaName, refusing, rederiveFlow, rederivePaths, rederiveStart, rederiveStatus, serverOf, switchRecord } from "../scripts/rederive.mjs";
import { callsText, bytesText, keptName, keptNote, keptWhat, lastDetail, lastLine, lastTag, rebuildLine, rebuildNote, rebuildPercent, stopCause } from "../ui/lib/rederive.js";

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

test("the model counts as refusing only when refusals grow and it makes nothing, poll after poll", () => {
  // Refusals growing while observations are made: some refused, the rest goes on.
  assert.equal(refusing([{ made: 10, refused: 0 }, { made: 14, refused: 6 }, { made: 20, refused: 12 }]), false);
  // Nothing made and nothing refused: the deriver is just slow.
  assert.equal(refusing([{ made: 10, refused: 0 }, { made: 10, refused: 0 }, { made: 10, refused: 0 }]), false);
  // Two polls of only refusals. The frontier is not asked: on the MacBook (run8) a limit
  // moved it from 34 to 163 of 1,211 in four minutes, over refused messages, while the
  // observations stayed at 22.
  assert.equal(refusing([{ made: 22, refused: 8 }, { made: 22, refused: 20 }, { made: 22, refused: 27 }]), true);
  // One is not enough.
  assert.equal(refusing([{ made: 10, refused: 0 }, { made: 10, refused: 8 }]), false);
  // A poll with no new refusal in between: not yet.
  assert.equal(refusing([{ made: 22, refused: 37 }, { made: 22, refused: 37 }, { made: 22, refused: 39 }]), false);
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

test("the time left is the estimate from before the start until the pace says more", () => {
  // run8: 3 of 1,211 thirty seconds in, estimated at 11 minutes. The pace alone says over three hours.
  const first = [{ t: 0, done: 0 }, { t: 30_000, done: 3 }];
  assert.equal(etaFor(first, 1211, 660), 658);
  assert.ok(etaFrom(first, 1211) > 3 * 3600);
  // Ten minutes of pace, or a tenth of the messages: the pace.
  assert.equal(etaFor([{ t: 0, done: 0 }, { t: 600_000, done: 100 }], 1100, 660), 6000);
  assert.equal(etaFor([{ t: 0, done: 0 }, { t: 60_000, done: 200 }], 1000, 660), 240);
  // Nearly through by the estimate: still a minute, never less.
  assert.equal(etaFor([{ t: 0, done: 0 }, { t: 30_000, done: 99 }], 1000, 30), 60);
  // 되돌리기 has no estimate: the pace from the start, as before.
  assert.equal(etaFor(first, 1211, null), etaFrom(first, 1211));
  assert.equal(etaFor([], 1211, 660), null);
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
  // Switching to the rebuilt memory again: the screens get to know which way it goes.
  const again = { kind: "undo", phase: "copy", startedAt: "2026-10-12T05:40:00Z", pid: 999_999_999, toRebuilt: true };
  await fsp.writeFile(paths.status, JSON.stringify({ version: 1, job: again, last: null, previous: null }));
  const switching = (await rederiveFlow(config)).job;
  assert.equal(switching.toRebuilt, true);
  assert.equal(rebuildLine(switching), "그동안 들어온 대화를 옮기는 중");
  assert.equal(rebuildNote(switching), "다 옮기면 새 기억으로 다시 바꿉니다. 그때까지 지금 기억을 씁니다.");
});

test("the switch records what the new memory holds, the turns copied in while it was made included", () => {
  // The MacBook's run: 130 copied, one more conversation came in during the rebuild.
  const job = { kind: "build", startedAt: "2026-10-10T05:53:37Z", schema: "mem_202610101453", totals: { conversations: 130, messages: 1242, calls: 323 }, copied: { conversations: 130, messages: 1242 }, derive: { total: 1244 } };
  const last = switchRecord(job, { conversations: 131, messages: 1244 }, "2026-10-10T06:02:44Z");
  assert.equal(last.conversations, 131);
  assert.equal(last.messages, 1244);
  assert.equal(lastDetail(last), "대화 131개 · 9분 걸림 · 모델 호출 약 300번");
  // When the count cannot be read: what was copied.
  assert.equal(switchRecord(job, null, "2026-10-10T06:02:44Z").conversations, 130);
});

test("after 되돌리기 the memory kept is the one the rebuild made, and the screens call it so", () => {
  const at = "2026-10-10T06:07:03Z";
  // The rebuild's switch keeps the memory before it.
  const built = keptRecord({ kind: "build", from: "public", fromNamespace: "honcho" }, at);
  assert.equal(built.rebuilt, false);
  assert.equal(keptName(built), "이전 기억");
  assert.equal(keptWhat(built), "다시 정리하기 전의 기억입니다.");
  assert.match(keptNote(built), /^이전 기억은 .+까지 둡니다\. 되돌리려면 서버 → 기억 서버에서 되돌리기를 누르세요\.$/);
  // 되돌리기 keeps the rebuilt one: it is not "이전 기억" any more, but the 새 기억 the rebuild's window named.
  const back = { kind: "undo", from: "mem_202610101453", fromNamespace: "mem_202610101453", toRebuilt: false };
  const kept = keptRecord(back, at);
  assert.equal(kept.rebuilt, true);
  assert.equal(kept.schema, "mem_202610101453");
  assert.equal(keptName(kept), "새 기억");
  assert.equal(keptWhat(kept), "다시 정리해 만든 기억입니다.");
  assert.match(keptNote(kept), /^새 기억은 .+까지 둡니다\. 다시 바꾸려면 서버 → 기억 서버에서 새 기억으로 다시 바꾸기를 누르세요\.$/);
  assert.equal(lastTag(switchRecord(back, null, at)), "이전 기억으로 되돌림");
  // Switching to it again keeps the one before the rebuild once more.
  const again = { kind: "undo", from: "public", fromNamespace: "honcho", toRebuilt: true };
  assert.equal(keptRecord(again, at).rebuilt, false);
  assert.equal(lastTag(switchRecord(again, null, at)), "새 기억으로 다시 바꿈");
  assert.equal(rebuildLine({ kind: "undo", phase: "swap", toRebuilt: true }), "새 기억으로 다시 바꾸는 중");
  assert.equal(lastTag({ kind: "build" }), "새 기억으로 바꿈");
});

test("the screens' words for a rebuild", () => {
  assert.equal(rebuildLine({ kind: "build", phase: "copy", copied: { conversations: 1200 }, totals: { conversations: 26640 } }), "대화를 옮기는 중 · 1,200 / 26,640");
  assert.equal(rebuildLine({ kind: "build", phase: "swap" }), "새 기억으로 바꾸는 중");
  // Every message is through and the deriver finishes what it does with them.
  assert.equal(rebuildLine({ kind: "build", phase: "derive", derive: { done: 1244, total: 1244, at: null, etaSec: 0 } }), "마무리하는 중");
  // 되돌리기 and 다시 바꾸기: what came in since is copied and gone through first, then the switch.
  assert.equal(rebuildLine({ kind: "undo", phase: "start" }), "바꿀 준비하는 중");
  assert.equal(rebuildLine({ kind: "undo", phase: "copy", copied: { conversations: 128 }, totals: { conversations: 130 } }), "그동안 들어온 대화를 옮기는 중");
  assert.equal(rebuildLine({ kind: "undo", phase: "derive", derive: { done: 1190, total: 1244, at: Date.parse("2026-10-10T06:00:00Z"), etaSec: 180 } }), "옮긴 대화를 정리하는 중 · 95% · 약 3분 남음");
  assert.equal(rebuildLine({ kind: "undo", phase: "swap" }), "이전 기억으로 바꾸는 중");
  // Resting on a limit, the note says when it carries on: no time left in the line.
  const resting = { kind: "build", phase: "derive", derive: { done: 20, total: 1215, at: Date.parse("2025-10-20T00:00:00Z"), etaSec: 3600, paused: { until: "2026-10-10T13:30:10Z" } } };
  assert.equal(rebuildLine(resting), "2025년 10월 대화까지 · 1%");
  assert.equal(rebuildLine({ kind: "build", phase: "derive", error: "fetch failed", derive: { done: 412, total: 1191, at: Date.parse("2025-03-02T00:00:00Z"), etaSec: 420 } }), "2025년 3월 대화까지 · 34%");
  assert.equal(rebuildNote({ kind: "undo", phase: "derive" }), "다 옮기면 이전 기억으로 되돌립니다. 그때까지 지금 기억을 씁니다.");
  // The minute without memory search is the restart at the end, not the making.
  assert.equal(rebuildNote({ kind: "build", phase: "swap" }), "서버를 다시 켜는 동안 1분쯤 기억 검색이 멈춥니다.");
  assert.match(rebuildNote({ kind: "build", phase: "derive", derive: { paused: { until: new Date(Date.now() + 3_600_000).toISOString() } } }), /^모델 사용 한도에 걸려 쉬는 중입니다\. .+에 이어서 합니다\.$/);
  assert.equal(rebuildNote({ kind: "build", phase: "derive", error: "x" }), "멈췄습니다. 다시 시도를 누르면 멈춘 곳부터 이어서 합니다.");
  // Stopped on Docker being off, 다시 시도 alone would stop the same way: the note says what comes first.
  assert.equal(rebuildNote({ kind: "build", phase: "start", error: "Command failed: docker compose up -d\nCannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?" }),
    "멈췄습니다. Docker Desktop을 켠 뒤 다시 시도를 누르면 멈춘 곳부터 이어서 합니다.");
  assert.equal(callsText(41_200), "약 4만 번");
  assert.equal(callsText(3_240), "약 3,200번");
  assert.equal(bytesText(12.4 * 1024 ** 3), "약 12GB");
  assert.equal(bytesText(1.44 * 1024 ** 3), "약 1.4GB");
  assert.equal(bytesText(380 * 1024 ** 3, { about: false }), "380GB");
  const last = { kind: "build", swappedAt: new Date(2026, 9, 13, 3, 40).toISOString(), conversations: 26640, hours: 22.2, calls: 41200 };
  assert.match(lastLine(last), /^10월 13일 03:40에 새 기억으로 바꿈$|^2026년 10월 13일 03:40에 새 기억으로 바꿈$/);
  assert.equal(lastDetail(last), "대화 26,640개 · 22시간 걸림 · 모델 호출 약 4만 번");
});

test("a stopped job says why in a sentence, and keeps the words it stopped on for 오류 내용", () => {
  // run8: the second api was stopped under a copy, and the screen showed fetch failed as it came.
  assert.deepEqual(stopCause("fetch failed"), { text: "기억 서버가 응답하지 않았습니다.", first: "" });
  assert.equal(stopCause("connect ECONNREFUSED 127.0.0.1:18102").text, "기억 서버가 응답하지 않았습니다.");
  assert.equal(stopCause("The operation was aborted due to timeout").text, "기억 서버가 제때 답하지 않았습니다.");
  // The api's own answer goes by its status, whatever words come with it.
  assert.equal(stopCause("HTTP 500 POST /v3/workspaces/w/sessions/s/messages: Internal Server Error (timeout)").text, "기억 서버가 오류로 답했습니다.");
  assert.equal(stopCause("HTTP 422 POST /v3/workspaces/w/sessions/s/messages: {\"detail\":\"bad\"}").text, "기억 서버가 요청을 거절했습니다.");
  assert.equal(stopCause("the second api did not start").text, "새 기억을 만들 서버(api-next)가 15분 안에 켜지지 않았습니다.");
  assert.equal(stopCause("no free port for the second api").text, "새 기억을 만들 서버(api-next)에 줄 빈 포트가 없습니다.");
  assert.equal(stopCause("the memory server did not answer after the switch").text, "바꾼 뒤 기억 서버가 15분 안에 켜지지 않았습니다.");
  assert.deepEqual(stopCause("the model has not answered for three days"), { text: "모델이 사흘 동안 답하지 않았습니다.", first: "서버 → 모델에서 계정을 확인한 뒤" });
  assert.deepEqual(stopCause("ENOSPC: no space left on device, write"), { text: "디스크 공간이 모자랍니다.", first: "공간을 비운 뒤" });
  // Words it does not know have no sentence: the screen says so and shows them under 오류 내용.
  assert.deepEqual(stopCause("ERROR:  relation \"mem_x.queue\" does not exist"), { text: "", first: "" });
  assert.deepEqual(stopCause(null), { text: "", first: "" });
});
