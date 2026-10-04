import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectorEnv,
  compareSession,
  dedupe,
  ensureWorkspace,
  formatInZone,
  plan,
  run,
  sortSessions,
  uuidsInName,
  verify,
  zonedInstant,
} from "../scripts/rebuild-import.mjs";

const line = (value) => `${JSON.stringify(value)}\n`;
const quiet = () => {};

async function temporaryDirectory(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `rebuild-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function put(target, content) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
  return target;
}

async function readLines(filePath) {
  const text = await fsp.readFile(filePath, "utf8");
  return text.split("\n").filter(Boolean).map((item) => JSON.parse(item));
}

function claudeSession(id, { entrypoint = "cli", times = ["2026-09-02T01:00:00.000Z", "2026-09-02T01:00:05.000Z"], user = "hello" } = {}) {
  const rows = [{ type: "queue-operation", sessionId: id, timestamp: times[0] }];
  rows.push({
    type: "user",
    entrypoint,
    sessionId: id,
    uuid: `${id}-u`,
    timestamp: times[0],
    message: { role: "user", content: user },
  });
  rows.push({
    type: "assistant",
    entrypoint,
    sessionId: id,
    uuid: `${id}-a`,
    timestamp: times[1],
    message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  });
  return rows.map(line).join("");
}

function codexRollout(id, { times = ["2026-09-03T02:00:00.000Z", "2026-09-03T02:00:09.000Z"], source = "vscode", threadSource = "user", turns = 1 } = {}) {
  const rows = [
    {
      timestamp: times[0],
      type: "session_meta",
      payload: { id, timestamp: times[0], cwd: "/Users/me/dev/app", originator: "Codex Desktop", source, thread_source: threadSource },
    },
  ];
  for (let index = 0; index < turns; index += 1) {
    rows.push({ timestamp: times[0], type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `please do ${index}` }] } });
    rows.push({ timestamp: times[1], type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `done ${index}` }] } });
  }
  return rows.map(line).join("");
}

const id = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(-36);
const UUIDS = {
  cli: "11111111-1111-4111-8111-111111111111",
  sdk: "22222222-2222-4222-8222-222222222222",
  sub: "33333333-3333-4333-8333-333333333333",
  tool: "44444444-4444-4444-8444-444444444444",
  early: "55555555-5555-4555-8555-555555555555",
  late: "66666666-6666-4666-8666-666666666666",
  empty: "77777777-7777-4777-8777-777777777777",
  undated: "88888888-8888-4888-8888-888888888888",
  codexMain: "01a00000-0000-7000-8000-000000000001",
  codexSubagent: "01a00000-0000-7000-8000-000000000002",
  codexThreadSub: "01a00000-0000-7000-8000-000000000003",
  codexArchived: "01a00000-0000-7000-8000-000000000004",
  codexTagged: "01a00000-0000-7000-8000-000000000005",
  mbpClaude: "99999999-9999-4999-8999-999999999999",
};

async function fixture(t) {
  const dir = await temporaryDirectory(t, "plan");
  const claude = path.join(dir, "claude");
  const codex = path.join(dir, "codex");
  const mbp = path.join(dir, "mbp-claude");
  const project = path.join(claude, "-Users-me-dev-app");
  await put(path.join(project, `${UUIDS.cli}.jsonl`), claudeSession(UUIDS.cli));
  await put(path.join(project, `${UUIDS.sdk}.jsonl`), claudeSession(UUIDS.sdk, { entrypoint: "sdk-cli" }));
  await put(path.join(project, UUIDS.cli, "subagents", `agent-${UUIDS.sub}.jsonl`), claudeSession(UUIDS.sub));
  await put(path.join(project, UUIDS.cli, "tool-results", `${UUIDS.tool}.jsonl`), claudeSession(UUIDS.tool));
  // 2026-08-31T14:59:59Z is 23:59:59 KST on 8/31; 15:00:00Z is 00:00 KST on 9/01.
  await put(path.join(project, `${UUIDS.early}.jsonl`), claudeSession(UUIDS.early, { times: ["2026-08-31T14:59:59.000Z", "2026-08-31T15:10:00.000Z"] }));
  await put(path.join(project, `${UUIDS.late}.jsonl`), claudeSession(UUIDS.late, { times: ["2026-09-30T15:00:00.000Z", "2026-09-30T15:01:00.000Z"] }));
  await put(path.join(project, `${UUIDS.empty}.jsonl`), line({ type: "queue-operation", sessionId: UUIDS.empty, timestamp: "2026-09-05T00:00:00.000Z" }));
  await put(
    path.join(project, `${UUIDS.undated}.jsonl`),
    line({ type: "user", entrypoint: "cli", sessionId: UUIDS.undated, uuid: "u1", message: { role: "user", content: "no time" } }),
  );
  await put(
    path.join(codex, "2026", "09", "01", `rollout-2026-09-01T09-00-00-${UUIDS.codexMain}.jsonl`),
    codexRollout(UUIDS.codexMain, { times: ["2026-08-31T15:00:00.000Z", "2026-08-31T15:00:01.000Z"] }),
  );
  await put(
    path.join(codex, "2026", "09", "03", `rollout-2026-09-03T11-00-00-${UUIDS.codexSubagent}.jsonl`),
    codexRollout(UUIDS.codexSubagent, { source: { subagent: { thread_spawn: { parent_thread_id: UUIDS.codexMain } } } }),
  );
  await put(
    path.join(codex, "2026", "09", "03", `rollout-2026-09-03T11-01-00-${UUIDS.codexThreadSub}.jsonl`),
    codexRollout(UUIDS.codexThreadSub, { threadSource: "subagent" }),
  );
  await put(
    path.join(codex, "2026", "09", "04", `rollout-2026-09-04T11-00-00-${UUIDS.codexArchived}.pre-archive.jsonl`),
    codexRollout(UUIDS.codexArchived, { times: ["2026-09-04T02:00:00.000Z", "2026-09-04T02:00:01.000Z"] }),
  );
  await put(
    path.join(codex, "2026", "09", "04", `rollout-2026-09-04T12-00-00-${UUIDS.codexTagged}.mbp.jsonl`),
    codexRollout(UUIDS.codexTagged, { times: ["2026-09-04T03:00:00.000Z", "2026-09-04T03:00:01.000Z"] }),
  );
  await put(path.join(codex, "2026", "09", "04", "notes.jsonl"), "{}\n");
  await put(
    path.join(mbp, "2026", "09", "02", `${UUIDS.mbpClaude}.jsonl`),
    claudeSession(UUIDS.mbpClaude, { times: ["2026-09-02T00:30:00.000Z", "2026-09-02T00:31:00.000Z"] }),
  );
  const excludeIds = await put(path.join(dir, "archived.txt"), `${UUIDS.codexArchived}\nrollout-x-${UUIDS.codexTagged}.mbp.jsonl\n`);
  return {
    dir,
    out: path.join(dir, "out", "manifest.jsonl"),
    roots: [`claude:local:${claude}`, `codex:local:${codex}`, `claude:mbp:${mbp}`],
    excludeIds,
  };
}

function planOptions(f) {
  return {
    from: "2026-09-01",
    to: "2026-10-01",
    tz: "Asia/Seoul",
    roots: f.roots,
    excludeIds: f.excludeIds,
    out: f.out,
  };
}

test("KST window edges convert to UTC instants and back", () => {
  assert.equal(new Date(zonedInstant("2026-09-01", "Asia/Seoul")).toISOString(), "2026-08-31T15:00:00.000Z");
  assert.equal(new Date(zonedInstant("2026-10-01T00:00", "Asia/Seoul")).toISOString(), "2026-09-30T15:00:00.000Z");
  assert.equal(formatInZone(Date.parse("2026-08-31T15:00:00.000Z"), "Asia/Seoul"), "2026-09-01T00:00:00.000+09:00");
  assert.throws(() => zonedInstant("September", "Asia/Seoul"), /not a local date/);
});

test("uuidsInName finds the session uuid in plain, .pre-archive, device-tagged and _원본버전 names", () => {
  assert.deepEqual(uuidsInName(`rollout-2026-09-04T11-00-00-${UUIDS.codexArchived}.pre-archive.jsonl`), [UUIDS.codexArchived]);
  assert.deepEqual(uuidsInName(`/x/rollout-2026-09-04T12-00-00-${UUIDS.codexTagged.toUpperCase()}.mbp.jsonl`), [UUIDS.codexTagged]);
  assert.deepEqual(uuidsInName(`rollout-t-${UUIDS.codexMain}_${UUIDS.codexSubagent}.jsonl`), [UUIDS.codexMain, UUIDS.codexSubagent]);
});

test("plan classifies sessions and lists every exclusion with its reason", async (t) => {
  const f = await fixture(t);
  const result = await plan(planOptions(f), { log: quiet });
  const manifest = await readLines(f.out);
  assert.deepEqual(
    manifest.map((item) => item.session_id),
    [`codex-${UUIDS.codexMain}`, `claude-${UUIDS.mbpClaude}`, `claude-${UUIDS.cli}`],
  );
  const reasons = Object.fromEntries((await readLines(f.out.replace(/\.jsonl$/, ".exclusions.jsonl"))).map((item) => [path.basename(item.file), item.reason]));
  assert.equal(reasons[`${UUIDS.sdk}.jsonl`], "claude-sdk");
  assert.equal(reasons[`${UUIDS.early}.jsonl`], "outside-window");
  assert.equal(reasons[`${UUIDS.late}.jsonl`], "outside-window");
  assert.equal(reasons[`${UUIDS.empty}.jsonl`], "no-turns");
  assert.equal(reasons[`${UUIDS.undated}.jsonl`], "turn-without-created_at");
  assert.equal(reasons[`rollout-2026-09-03T11-00-00-${UUIDS.codexSubagent}.jsonl`], "codex-subagent");
  assert.equal(reasons[`rollout-2026-09-03T11-01-00-${UUIDS.codexThreadSub}.jsonl`], "codex-subagent");
  assert.equal(reasons[`rollout-2026-09-04T11-00-00-${UUIDS.codexArchived}.pre-archive.jsonl`], "archived");
  assert.equal(reasons[`rollout-2026-09-04T12-00-00-${UUIDS.codexTagged}.mbp.jsonl`], "archived");
  // Subagent and tool-result transcripts are never even read; notes.jsonl is not a rollout.
  assert.equal(Object.keys(reasons).some((name) => name.includes(UUIDS.sub) || name.includes(UUIDS.tool) || name === "notes.jsonl"), false);
  assert.equal(Object.keys(reasons).length, 9);

  const cli = manifest.find((item) => item.session_id === `claude-${UUIDS.cli}`);
  assert.equal(cli.machine, "local");
  assert.equal(cli.user, 1);
  assert.equal(cli.assistant, 1);
  assert.equal(cli.messages, 2);
  assert.equal(cli.start, "2026-09-02T01:00:00.000Z");
  assert.equal(cli.end, "2026-09-02T01:00:05.000Z");
  assert.equal(cli.start_local, "2026-09-02T10:00:00.000+09:00");
  const totals = result.table.at(-1);
  assert.equal(totals.sessions, 3);
  assert.equal(totals.user, 3);
  const summary = JSON.parse(await fsp.readFile(f.out.replace(/\.jsonl$/, ".summary.json"), "utf8"));
  assert.equal(summary.window.from_utc, "2026-08-31T15:00:00.000Z");
  assert.equal(summary.exclusions_by_reason["claude-sdk\tclaude\tlocal"], 1);
});

test("manifest order is by first turn across providers and machines, numbered from 1", async (t) => {
  const f = await fixture(t);
  await plan(planOptions(f), { log: quiet });
  const manifest = await readLines(f.out);
  assert.deepEqual(manifest.map((item) => item.seq), [1, 2, 3]);
  const starts = manifest.map((item) => Date.parse(item.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.deepEqual(manifest.map((item) => `${item.provider}:${item.machine}`), ["codex:local", "claude:mbp", "claude:local"]);

  const sorted = sortSessions([
    { provider: "codex", machine: "mbp", file: "b", start: "2026-09-02T00:00:00.000Z" },
    { provider: "claude", machine: "local", file: "a", start: "2026-09-02T00:00:00.000Z" },
    { provider: "codex", machine: "amd", file: "c", start: "2026-09-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(sorted.map((item) => item.file), ["c", "a", "b"]);
});

test("a duplicate Honcho session id keeps the copy with the most turns, this computer's first on a tie", () => {
  const sessions = [
    { session_id: "codex-a", machine: "mbp", file: "/mbp/a", turns: 4, provider: "codex", start: "s" },
    { session_id: "codex-a", machine: "local", file: "/local/a", turns: 3, provider: "codex", start: "s" },
    { session_id: "codex-b", machine: "mbp", file: "/mbp/b", turns: 2, provider: "codex", start: "s" },
    { session_id: "codex-b", machine: "local", file: "/local/b", turns: 2, provider: "codex", start: "s" },
  ];
  const { kept, dropped } = dedupe(sessions);
  assert.deepEqual(kept.map((item) => item.file).sort(), ["/local/b", "/mbp/a"]);
  assert.deepEqual(dropped.map((item) => [item.file, item.reason]).sort(), [["/local/a", "duplicate"], ["/mbp/b", "duplicate"]]);
});

test("plan makes no HTTP request", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalHttp = http.request;
  const originalHttps = https.request;
  globalThis.fetch = async (...args) => {
    calls.push(["fetch", String(args[0])]);
    throw new Error("plan must not fetch");
  };
  http.request = (...args) => {
    calls.push(["http", args[0]]);
    throw new Error("plan must not use http");
  };
  https.request = (...args) => {
    calls.push(["https", args[0]]);
    throw new Error("plan must not use https");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    http.request = originalHttp;
    https.request = originalHttps;
  });
  await plan(planOptions(f), { log: quiet });
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// run / verify
// ---------------------------------------------------------------------------

function fakeHoncho(workspaces = {}) {
  const calls = [];
  const request = async (method, apiPath, payload) => {
    calls.push({ method, apiPath, payload });
    if (method === "POST" && apiPath.startsWith("/v3/workspaces/list")) {
      const wanted = payload?.filters?.id;
      const items = Object.entries(workspaces)
        .filter(([name]) => name === wanted)
        .map(([name, configuration]) => ({ id: name, configuration, metadata: {} }));
      return { items, total: items.length, page: 1, size: 10, pages: 1 };
    }
    if (method === "POST" && apiPath === "/v3/workspaces") {
      workspaces[payload.id] ??= payload.configuration;
      return { id: payload.id, configuration: workspaces[payload.id], metadata: {} };
    }
    throw new Error(`unexpected request ${method} ${apiPath}`);
  };
  return { request, calls, workspaces };
}

async function runFixture(t, { sessions = 3, fail = "" } = {}) {
  const dir = await temporaryDirectory(t, "run");
  const manifest = path.join(dir, "manifest.jsonl");
  const items = [];
  for (let index = 1; index <= sessions; index += 1) {
    const provider = index % 2 ? "claude" : "codex";
    items.push({
      seq: index,
      provider,
      machine: "local",
      file: path.join(dir, "src", `${index}.jsonl`),
      session_id: `${provider}-${id(index)}`,
      start: `2026-09-0${index}T00:00:00.000Z`,
      end: `2026-09-0${index}T00:01:00.000Z`,
      messages: 2,
    });
  }
  await put(manifest, items.map(line).join(""));
  await put(manifest.replace(/\.jsonl$/, ".summary.json"), JSON.stringify({ char_limit: 24000 }));
  const record = path.join(dir, "collector-calls.jsonl");
  const collector = await put(
    path.join(dir, "fake-collector.mjs"),
    `import fs from "node:fs";
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("HONCHO_")));
fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv, env }) + "\\n");
const transcript = argv[argv.indexOf("--transcript") + 1];
const failing = (process.env.FAKE_FAIL || "").split(",").filter(Boolean);
if (failing.some((name) => transcript.endsWith("/" + name + ".jsonl"))) {
  console.error(JSON.stringify({ ok: false, error: "HTTP 500 for test" }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, new_messages: 2, honcho_message_total: 0 }));
}
`,
  );
  const env = {
    PATH: process.env.PATH,
    FAKE_RECORD: record,
    FAKE_FAIL: fail,
    HONCHO_AGENT_TARGET_FOLDERS: '["/somewhere"]',
    HONCHO_AGENT_TARGET_ID: "office",
    HONCHO_TARGET_API_TOKEN: "secret",
    HONCHO_AGENT_DRY_RUN: "1",
    HONCHO_USER_NAME: "user",
    HONCHO_API_BEARER_TOKEN: "kept",
  };
  const runDir = path.join(dir, "run");
  return { dir, manifest, record, collector, env, runDir, items };
}

test("run refuses the live memory workspace before any request", async (t) => {
  const r = await runFixture(t);
  const honcho = fakeHoncho();
  for (const workspace of ["memory", "Memory", " memory "]) {
    await assert.rejects(
      run({ manifest: r.manifest, workspace, runDir: r.runDir, collector: r.collector }, { log: quiet, env: r.env, request: honcho.request }),
      /refusing to import into the live workspace/,
    );
  }
  await assert.rejects(verify({ manifest: r.manifest, workspace: "memory" }, { log: quiet, request: honcho.request }), /refusing/);
  assert.deepEqual(honcho.calls, []);
  await assert.rejects(fsp.access(r.record));
});

test("the workspace is created with summaries off, and an existing one with another configuration is refused", async () => {
  const fresh = fakeHoncho();
  const created = await ensureWorkspace(fresh.request, "rebuild-pilot", { log: quiet });
  assert.equal(created.created, true);
  assert.deepEqual(fresh.calls.at(-1), { method: "POST", apiPath: "/v3/workspaces", payload: { id: "rebuild-pilot", configuration: { summary: { enabled: false } } } });

  const same = fakeHoncho({ "rebuild-pilot": { summary: { enabled: false, messages_per_short_summary: null } } });
  assert.equal((await ensureWorkspace(same.request, "rebuild-pilot", { log: quiet })).created, false);
  assert.equal(same.calls.some((call) => call.apiPath === "/v3/workspaces"), false);

  for (const configuration of [{}, { summary: { enabled: true } }, { summary: { enabled: false }, dream: { enabled: false } }]) {
    const other = fakeHoncho({ "rebuild-pilot": configuration });
    await assert.rejects(ensureWorkspace(other.request, "rebuild-pilot", { log: quiet }), /exists with configuration/);
    assert.equal(other.calls.some((call) => call.apiPath === "/v3/workspaces"), false, "never created or changed");
  }
});

test("run refuses to start when the existing workspace has summaries on", async (t) => {
  const r = await runFixture(t);
  const honcho = fakeHoncho({ "rebuild-pilot": { summary: { enabled: true } } });
  await assert.rejects(
    run({ manifest: r.manifest, workspace: "rebuild-pilot", runDir: r.runDir, collector: r.collector }, { log: quiet, env: r.env, request: honcho.request }),
    /exists with configuration/,
  );
  await assert.rejects(fsp.access(r.record));
});

test("the collector gets the rebuild environment, with every target variable and dry-run flag removed", async (t) => {
  const r = await runFixture(t, { sessions: 2 });
  const honcho = fakeHoncho();
  const result = await run(
    { manifest: r.manifest, workspace: "rebuild-pilot", runDir: r.runDir, collector: r.collector, tag: "rebuild-test", baseUrl: "http://127.0.0.1:9" },
    { log: quiet, env: r.env, request: honcho.request },
  );
  assert.deepEqual(result, { ok: 2, failed: 0, stopped: false, ledger: path.join(r.runDir, "ledger.jsonl") });
  const calls = await readLines(r.record);
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.deepEqual(first.argv, ["--provider", "claude", "--transcript", r.items[0].file, "--workspace", "rebuild-pilot"]);
  assert.deepEqual(second.argv.slice(0, 2), ["--provider", "codex"]);
  assert.deepEqual(first.env, {
    HONCHO_API_BEARER_TOKEN: "kept",
    HONCHO_BASE_URL: "http://127.0.0.1:9",
    HONCHO_WORKSPACE_ID: "rebuild-pilot",
    HONCHO_AGENT_PROVIDER: "claude",
    HONCHO_USER_NAME: "user_chen",
    HONCHO_AGENT_HOOK_STATE: path.join(r.runDir, "state", "claude.json"),
    HONCHO_AGENT_HOOK_LOG: path.join(r.runDir, "logs", "claude.log"),
    HONCHO_AGENT_IMPORT_TRIGGER: "rebuild-test",
    HONCHO_CODEX_DREAM_EVERY_MESSAGES: "0",
    HONCHO_AGENT_HTTP_TIMEOUT_SECONDS: "60",
    HONCHO_AGENT_MESSAGE_CHAR_LIMIT: "24000",
  });
  assert.equal(second.env.HONCHO_AGENT_HOOK_STATE, path.join(r.runDir, "state", "codex.json"));

  const env = collectorEnv({ HONCHO_AGENT_TARGET_X: "1", HONCHO_TARGET_CF_ACCESS_CLIENT_SECRET: "s", OTHER: "o" }, {
    provider: "codex",
    runDir: "/r",
    workspace: "w",
    tag: "t",
    baseUrl: "http://h",
  });
  assert.equal(env.OTHER, "o");
  assert.equal(Object.keys(env).some((key) => key.startsWith("HONCHO_AGENT_TARGET_") || key.startsWith("HONCHO_TARGET_")), false);
});

test("run resumes from the ledger and stops after three failures in a row", async (t) => {
  const r = await runFixture(t, { sessions: 6, fail: "3,4,5" });
  const honcho = fakeHoncho();
  const options = { manifest: r.manifest, workspace: "rebuild-pilot", runDir: r.runDir, collector: r.collector };
  const first = await run({ ...options, limit: 1 }, { log: quiet, env: r.env, request: honcho.request });
  assert.equal(first.ok, 1);

  const second = await run(options, { log: quiet, env: r.env, request: honcho.request });
  assert.deepEqual([second.ok, second.failed, second.stopped], [1, 3, true]);
  let ledger = await readLines(path.join(r.runDir, "ledger.jsonl"));
  assert.deepEqual(ledger.map((entry) => [entry.seq, entry.status]), [[1, "ok"], [2, "ok"], [3, "failed"], [4, "failed"], [5, "failed"]]);
  assert.match(ledger[2].error, /HTTP 500 for test/);
  assert.equal(ledger[0].workspace, "rebuild-pilot");

  // Once the server is back, the same command picks up the failed sessions and the rest.
  const third = await run(options, { log: quiet, env: { ...r.env, FAKE_FAIL: "" }, request: honcho.request });
  assert.deepEqual([third.ok, third.failed, third.stopped], [4, 0, false]);
  ledger = await readLines(path.join(r.runDir, "ledger.jsonl"));
  const sent = (await readLines(r.record)).map((call) => path.basename(call.argv[3]));
  assert.deepEqual(sent, ["1.jsonl", "2.jsonl", "3.jsonl", "4.jsonl", "5.jsonl", "3.jsonl", "4.jsonl", "5.jsonl", "6.jsonl"]);
  assert.equal(ledger.filter((entry) => entry.status === "ok").length, 6);

  const fourth = await run(options, { log: quiet, env: r.env, request: honcho.request });
  assert.deepEqual([fourth.ok, fourth.failed], [0, 0]);

  await assert.rejects(
    run({ ...options, workspace: "rebuild-other" }, { log: quiet, env: r.env, request: honcho.request }),
    /belongs to workspace "rebuild-pilot"/,
  );
});

test("verify compares message counts and first/last created_at with the manifest", async (t) => {
  const session = { seq: 1, session_id: "claude-a", start: "2026-09-01T00:00:00.000Z", end: "2026-09-01T00:05:00.000Z", messages: 2 };
  assert.deepEqual(compareSession(session, [{ created_at: "2026-09-01T00:00:00+00:00" }, { created_at: "2026-09-01T00:05:00.000000Z" }]), []);
  assert.equal(compareSession(session, [{ created_at: "2026-09-01T00:00:00Z" }]).length, 2);

  const dir = await temporaryDirectory(t, "verify");
  const manifest = await put(path.join(dir, "manifest.jsonl"), [session, { ...session, seq: 2, session_id: "codex-b" }].map(line).join(""));
  const calls = [];
  const request = async (method, apiPath) => {
    calls.push(method);
    if (apiPath.includes("/sessions/codex-b/")) {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    }
    return { items: [{ created_at: "2026-09-01T00:00:00Z" }, { created_at: "2026-09-01T00:05:00Z" }], total: 2 };
  };
  const report = await verify({ manifest, workspace: "rebuild-pilot" }, { log: quiet, request });
  assert.deepEqual([report.checked, report.matched, report.missing], [2, 1, 1]);
  assert.deepEqual([...new Set(calls)], ["POST"]);
});
