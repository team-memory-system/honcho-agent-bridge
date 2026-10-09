// The setup UI can install hooks and start services, so the checks that matter are:
// it only listens to a browser on this machine, it runs the same CLI a terminal
// would, and an uploaded ChatGPT export actually lands in Honcho.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { createUiServer, rejectUnsafeRequest, shareEnableInvocation, shareJoinInvocation, teammateInvocation } from "../scripts/ui.mjs";
import { fixtureZip } from "./chatgpt-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server;
let port;
let honcho;
let honchoRequests = [];
let workdir;

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const selected = probe.address().port;
  await new Promise((resolve) => probe.close(() => resolve()));
  return selected;
}

function send(pathname, { method = "GET", body, headers = {}, raw } = {}) {
  const payload = raw ?? (body === undefined ? "" : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host: headers.host ?? `127.0.0.1:${port}`,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, body: parsed });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

before(async () => {
  workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-ui-"));
  honcho = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    honchoRequests.push({ url: request.url, body: raw ? JSON.parse(raw) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url.endsWith("/messages/list")) response.end(JSON.stringify({ items: [], total: 0 }));
    else response.end(JSON.stringify({ ok: true }));
  });
  const honchoPort = await availablePort();
  await new Promise((resolve, reject) => { honcho.once("error", reject); honcho.listen(honchoPort, "127.0.0.1", resolve); });
  process.env.HONCHO_BASE_URL = `http://127.0.0.1:${honchoPort}`;
  process.env.HONCHO_WORKSPACE_ID = "memory";
  process.env.HONCHO_USER_NAME = "user_test";
  process.env.HONCHO_AGENT_HOOK_STATE = path.join(workdir, "state.json");
  process.env.HONCHO_AGENT_HOOK_LOG = path.join(workdir, "collector.log");

  port = await availablePort();
  server = createUiServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (honcho) await new Promise((resolve) => honcho.close(() => resolve()));
  if (workdir) await fsp.rm(workdir, { recursive: true, force: true });
});

test("the page and its assets are served, and nothing above the ui directory is", async () => {
  const page = await send("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.text, /팀 메모리/);

  assert.equal((await send("/styles.css")).status, 200);
  assert.equal((await send("/app.js")).status, 200);
  assert.equal((await send("/../package.json")).status, 404);
  assert.equal((await send("/../../etc/passwd")).status, 404);
});

test("only a same-origin browser on this machine may drive the UI", async () => {
  assert.equal((await send("/api/status", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await send("/api/setup/plan", { method: "POST", body: {}, headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal(
    (await send("/api/setup/plan", { method: "POST", raw: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status,
    415,
    "a form post is what a cross-site page can send without a preflight",
  );
  assert.equal((await send("/", { method: "POST", body: {} })).status, 405);
  assert.equal((await send("/api/nope")).status, 404);
  // An image on another site sends a GET with no Origin, so nothing that changes
  // this computer may run on one.
  for (const route of ["/api/setup/apply", "/api/setup/plan", "/api/server/prepare", "/api/server/start", "/api/server/stop",
    "/api/server/verify", "/api/host/start", "/api/gateway/open", "/api/targets/add", "/api/teammates/add"]) {
    assert.equal((await send(route)).status, 405, `${route} must not run on a GET`);
    assert.equal((await send(route, { method: "HEAD" })).status, 405, `${route} must not run on a HEAD`);
  }
});

test("the host and origin checks are decided by the request, not by the route", () => {
  const base = { method: "GET", headers: { host: "127.0.0.1:1" } };
  assert.equal(rejectUnsafeRequest(base), null);
  assert.equal(rejectUnsafeRequest({ ...base, headers: { host: "127.0.0.1:1", origin: "http://127.0.0.1:1" } }), null);
  assert.equal(rejectUnsafeRequest({ ...base, headers: { host: "10.0.0.1:1" } }).status, 403);
  assert.equal(rejectUnsafeRequest({ ...base, headers: { host: "localhost:1", origin: "http://localhost:2" } }).status, 403);
  assert.equal(rejectUnsafeRequest({ method: "POST", headers: { host: "127.0.0.1:1" } }).status, 415);
});

test("status runs the same detect and doctor a terminal would", async () => {
  const response = await send("/api/status");
  assert.equal(response.status, 200);
  assert.equal(response.body.detect.ok, true);
  assert.equal(typeof response.body.detect.paths.configPath, "string");
  assert.ok(Array.isArray(response.body.doctor.checks), "doctor reports its checks");
});

test("an uploaded ChatGPT export reaches Honcho, and re-uploading it adds nothing", async () => {
  honchoRequests = [];
  const exported = JSON.stringify([
    {
      conversation_id: "conv-ui",
      title: "업로드 테스트",
      create_time: 1_700_000_000,
      current_node: "a1",
      mapping: {
        root: { id: "root", parent: null, children: [], message: null },
        u1: { id: "u1", parent: "root", children: [], message: { id: "u1", author: { role: "user" }, create_time: 1_700_000_000, content: { content_type: "text", parts: ["웹에서 물어본 질문"] } } },
        a1: { id: "a1", parent: "u1", children: [], message: { id: "a1", author: { role: "assistant" }, create_time: 1_700_000_001, content: { content_type: "text", parts: ["웹에서 받은 답"] } } },
      },
    },
  ]);

  const first = await send("/api/import/chatgpt", { method: "POST", raw: exported });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(first.body.conversations, 1);
  assert.equal(first.body.imported_sessions, 1);
  assert.equal(first.body.new_messages, 2);
  assert.equal(first.body.uploaded_bytes, Buffer.byteLength(exported));

  const write = honchoRequests.find((entry) => entry.url?.endsWith("/messages"));
  assert.deepEqual(write.body.messages.map((message) => message.content), ["웹에서 물어본 질문", "웹에서 받은 답"]);

  const writesBefore = honchoRequests.filter((entry) => entry.url?.endsWith("/messages")).length;
  const second = await send("/api/import/chatgpt", { method: "POST", raw: exported });
  assert.equal(second.body.new_messages, 0);
  assert.equal(honchoRequests.filter((entry) => entry.url?.endsWith("/messages")).length, writesBefore);
});

test("the export zip itself can be uploaded, numbered shards and all", async () => {
  honchoRequests = [];
  const uploaded = await send("/api/import/chatgpt", { method: "POST", raw: fixtureZip() });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.ok, true, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.conversations, 7, "both conversations-00N.json shards are read");
  assert.equal(uploaded.body.imported_sessions, 5);
  assert.equal(uploaded.body.new_messages, 16);
  assert.ok(honchoRequests.some((entry) => entry.url?.endsWith("/messages")));
});

test("an empty or unreadable upload is reported instead of silently succeeding", async () => {
  const empty = await send("/api/import/chatgpt", { method: "POST", raw: "", headers: { "content-type": "application/json", "content-length": "0" } });
  assert.equal(empty.body.ok, false);

  const garbage = await send("/api/import/chatgpt", { method: "POST", raw: "{not json" });
  assert.equal(garbage.body.ok, false);
  assert.match(String(garbage.body.error), /invalid JSON|not a ChatGPT export/);
});

test("the UI never leaves an uploaded export behind", async () => {
  const before = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith("honcho-bridge-upload-"));
  await send("/api/import/chatgpt", { method: "POST", raw: JSON.stringify([]) });
  const after = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith("honcho-bridge-upload-"));
  assert.deepEqual(after, before, "the spooled copy of someone's conversations is removed");
});

test("the UI serves its pages from an installed runtime, where everything is one directory", async (t) => {
  const installed = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-runtime-"));
  t.after(() => fsp.rm(installed, { recursive: true, force: true }));
  // `installRuntime` flattens scripts/ into one directory and copies ui/ inside it.
  await fsp.cp(path.join(ROOT, "scripts"), installed, { recursive: true });
  await fsp.cp(path.join(ROOT, "ui"), path.join(installed, "ui"), { recursive: true });

  const { createUiServer: createInstalled } = await import(`file://${path.join(installed, "ui.mjs")}`);
  const installedServer = createInstalled();
  const installedPort = await availablePort();
  await new Promise((resolve, reject) => { installedServer.once("error", reject); installedServer.listen(installedPort, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => installedServer.close(() => resolve())));

  const page = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: installedPort, path: "/", method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(page.status, 200);
  assert.match(page.text, /팀 메모리/);
});

test("the setup form's fields reach the CLI under the names it actually reads", async () => {
  // `parseOptions` ignores an unknown flag in silence, so a wrong name here would
  // look like a working form that quietly configures nothing.
  const response = await send("/api/setup/plan", {
    method: "POST",
    body: { userPeer: "ui-probe", workspace: "memory-ui", honchoUrl: "http://127.0.0.1:8123", agents: "codex", nonsense: "dropped" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.config.user.peerId, "ui-probe");
  assert.equal(response.body.config.honcho.workspaceId, "memory-ui");
  assert.equal(response.body.config.honcho.baseUrl, "http://127.0.0.1:8123");
  assert.deepEqual(response.body.config.agents, { codex: true, claude: false });
  assert.deepEqual(response.body.issues, [], JSON.stringify(response.body.issues));
});

test("every option the setup steps send is one the server accepts", async () => {
  // The steps build one draft and send it whole (ui/lib/collect.js); nothing in that
  // module touches the page until it is called, so it runs here as it does there.
  const { setupBody } = await import("../ui/lib/collect.js");
  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const accepted = server.match(/const SETUP_OPTIONS = new Set\(\[([\s\S]*?)\]\)/)[1]
    .match(/"([^"]+)"/g)
    .map((quoted) => quoted.slice(1, -1));
  // Secret fields are read too, but into the environment, never onto the command line.
  const secrets = server.match(/const SETUP_SECRET_FIELDS = Object\.freeze\(\{([\s\S]*?)\}\)/)[1]
    .match(/(\w+):/g)
    .map((key) => key.slice(0, -1));
  const projects = [{ path: "/w/a", name: "a", count: 1 }, { path: "/w/b", name: "b", count: 2 }];
  const draft = (changes) => ({
    server: "remote", remoteUrl: "https://memory.example.com", apiToken: "t", accessClientId: "i", accessClientSecret: "s",
    userPeer: "me", workspace: "work", agents: new Set(["claude", "codex"]), projects, checked: new Set(["/w/a"]), rest: "take", ...changes,
  });
  const sent = new Set();
  for (const body of [
    setupBody(draft({}), {}),
    setupBody(draft({ rest: "skip" }), {}),
    setupBody(draft({ checked: new Set(["/w/a", "/w/b"]) }), {}),
  ]) for (const key of Object.keys(body)) sent.add(key);
  for (const key of sent) assert.ok(accepted.includes(key) || secrets.includes(key), `the steps send "${key}", which the server drops`);
  for (const key of ["takeFolders", "skipFolders", "restFolders", "allFolders", "automation", ...secrets]) assert.ok(sent.has(key), `the steps never send "${key}"`);
  // 자동 실행 대화도 수집 is sent either way, so turning it off is saved too.
  assert.equal(setupBody(draft({}), {}).automation, "skip");
  assert.equal(setupBody(draft({ automation: true }), {}).automation, "take");
  assert.equal(setupBody(draft({ automation: true, checked: new Set(["/w/a", "/w/b"]) }), {}).automation, "take");
  // This computer's own server takes no token: one typed for another server stays behind.
  const local = setupBody(draft({ server: "here" }), { localServer: { apiUrl: "http://127.0.0.1:8001" } });
  assert.equal(local.honchoUrl, "http://127.0.0.1:8001");
  for (const key of secrets) assert.equal(key in local, false, `${key} goes to this computer's server`);
});

test("a first setup ticks no folder, and 수정 shows what the computer collects now", async () => {
  const { tickedFolders } = await import("../ui/lib/collect.js");
  const projects = [{ path: "/w/a" }, { path: "/w/b" }, { path: "/w/new" }];
  const ticked = (saved, options) => [...tickedFolders(projects, saved, options)].sort();
  assert.deepEqual(ticked(null), [], "a first setup leaves every folder for the person to pick");
  assert.deepEqual(ticked(null, { edit: true }), ["/w/a", "/w/b", "/w/new"], "a computer that never chose collects every folder");
  assert.deepEqual(ticked({ take: ["/w/a"], skip: ["/w/b"], rest: "take" }), ["/w/a", "/w/new"], "a folder made later goes by the rest");
  assert.deepEqual(ticked({ take: ["/w/a"], skip: ["/w/b"], rest: "skip" }, { edit: true }), ["/w/a"]);
});

test("the projects step shows the folders as a tree, a folder that only leads to one other joined to it", async () => {
  const { folderTree, openAtFirst } = await import("../ui/lib/folder-tree.js");
  const items = [
    { path: "/Users/me/dev/app", display: "~/dev/app" },
    { path: "/private/tmp", display: "/private/tmp", temp: true },
    { path: "/Users/me", display: "~" },
    { path: "/Users/me/dev/lib", display: "~/dev/lib" },
    { path: "/Users/me/.claude/plugins/cache/x/0.3.10", display: "~/.claude/plugins/cache/x/0.3.10" },
    { path: "/private/var/folders/ab/cd/T", display: "/private/var/folders/ab/cd/T", temp: true },
  ];
  // [label, the folder's own item, how many items are at or under it, the folders inside]
  const shape = (nodes) => nodes.map((node) => [node.label, node.item?.path || null, node.items.length, ...(node.children.length ? [shape(node.children)] : [])]);
  assert.deepEqual(shape(folderTree(items)), [
    ["~", "/Users/me", 4, [
      ["dev", null, 2, [["app", "/Users/me/dev/app", 1], ["lib", "/Users/me/dev/lib", 1]]],
      [".claude/plugins/cache/x/0.3.10", "/Users/me/.claude/plugins/cache/x/0.3.10", 1],
    ]],
    ["/private", null, 2, [["tmp", "/private/tmp", 1], ["var/folders/ab/cd/T", "/private/var/folders/ab/cd/T", 1]]],
  ]);
  assert.deepEqual([...openAtFirst(items)], ["~", "/private"], "the top of each tree is open at first");
  assert.deepEqual(shape(folderTree([{ path: "C:\\work\\a\\b", display: "C:\\work\\a\\b" }, { path: "C:\\work\\c", display: "C:\\work\\c" }])),
    [["C:\\work", null, 2, [["a\\b", "C:\\work\\a\\b", 1], ["c", "C:\\work\\c", 1]]]], "a Windows path keeps its own separator");
});

test("the 프로젝트 폴더 line names the folders collected, never the hundreds left out", async () => {
  const { folderSummary } = await import("../ui/lib/collect.js");
  const skipped = Array.from({ length: 297 }, (_, index) => `/Users/me/dev/skipped-${index}`);
  assert.deepEqual(
    folderSummary({ take: ["/Users/me/dev/cmux-remote", "/Users/me/dev/flypiano"], skip: skipped, rest: "take" }),
    ["cmux-remote · flypiano", "새로 생기는 폴더도 수집"],
  );
  assert.deepEqual(folderSummary({ take: [], skip: skipped, rest: "take" }), ["없음", "새로 생기는 폴더도 수집"]);
  assert.deepEqual(folderSummary({ take: ["/Users/me/dev/a"], skip: [], rest: "skip" }), ["a", "고른 폴더만 수집"]);
  assert.deepEqual(folderSummary(null), ["모든 폴더", "새로 생기는 폴더도 수집"]);
  assert.deepEqual(folderSummary(null, true), ["모든 폴더", "새로 생기는 폴더도 수집 · 자동 실행 대화도 수집"]);
  const many = Array.from({ length: 8 }, (_, index) => `/Users/me/dev/p${index}`);
  assert.equal(folderSummary({ take: many, skip: ["/x"], rest: "skip" })[0], "p0 · p1 · p2 · p3 · p4 · p5 외 2개");
});

test("files the UI writes are restricted before any bytes reach them", async (t) => {
  // Windows ignores a POSIX creation mode, so `mode: 0o600` on its own protects
  // nothing there. The one file this UI writes is a whole chat history, so it goes
  // through the installer's own restriction rather than a bare fs call.
  const source = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  assert.match(source, /securePrivateFile/, "the spooled export is restricted");
  assert.equal(
    /fs\.rename\(/.test(source), false,
    "a bare rename would publish the file before its ACL is applied",
  );

  const spooled = JSON.stringify([]);
  const before = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith("honcho-bridge-upload-"));
  assert.deepEqual(before, [], "no earlier upload is still around");

  // On POSIX the restriction is observable directly.
  const probe = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-bridge-modeprobe-"));
  t.after(() => fsp.rm(probe, { recursive: true, force: true }));
  const target = path.join(probe, "conversations.json");
  await fsp.writeFile(target, spooled, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") {
    const mode = (await fsp.stat(target)).mode & 0o777;
    assert.equal(mode, 0o600, "owner-only");
  }
});

test("the host buttons drive the host lifecycle, not the Docker stack", async () => {
  // Starting the gateway and Ollama must not also bring Docker up, and must go
  // through the same `host start` a terminal would use - so the supervisor it
  // launches is detached and outlives this UI process.
  const source = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const routes = source.match(/const HOST_ROUTES = \{([\s\S]*?)\n\};/)[1];
  assert.match(routes, /"host", "status"/);
  assert.match(routes, /"host", "start"/);
  assert.match(routes, /"gateway", "open"/);
  assert.equal(/"server",/.test(routes), false, "a host button must not start the whole stack");
  assert.equal(/proxies|llmProxyRoot/.test(source), false, "there is no proxy source location to edit any more");

  const cli = await fsp.readFile(path.join(ROOT, "scripts", "cli.mjs"), "utf8");
  for (const subcommand of ["plan", "prepare", "start", "status", "stop", "open"]) {
    assert.match(cli, new RegExp(`subcommand === "${subcommand}"`), `${subcommand} is dispatched`);
  }
  assert.match(cli, /command === "host"/);
  assert.match(cli, /command === "gateway"/);

  // Every host action the screens call has a route to go to.
  const screens = await uiSources();
  const hostCalls = [...new Set([...screens.matchAll(/"\/api\/host\/([a-z]+)"/g)].map((match) => match[1]))];
  assert.ok(hostCalls.includes("start") && hostCalls.includes("status"), "the host controls were not found");
  for (const action of hostCalls) assert.match(routes, new RegExp(`"/api/host/${action}"`));
  assert.match(screens, /"\/api\/gateway\/open"/);
  assert.equal(/id="proxy-config"|llmProxyRoot/.test(screens), false);
});

async function uiSources() {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (/\.(js|html)$/.test(entry.name)) files.push(await fsp.readFile(target, "utf8"));
    }
  }
  await walk(path.join(ROOT, "ui"));
  return files.join("\n");
}

test("every server route the screens call exists", async () => {
  const screens = await uiSources();
  // The team's routes run in the app's process, from team-app.mjs (ui.mjs sends them there).
  const server = (await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8"))
    + (await fsp.readFile(path.join(ROOT, "scripts", "team-app.mjs"), "utf8"));
  const called = new Set([...screens.matchAll(/["`](\/api\/[a-z/-]+)/g)].map((match) => match[1].replace(/\/$/, "")));
  assert.ok(called.size >= 15, `only ${called.size} routes were found`);
  const relayed = ["/api/honcho/", "/api/dashboard/", "/api/gw/"];
  for (const route of called) {
    if (relayed.some((prefix) => route.startsWith(prefix) || `${route}/` === prefix)) continue;
    // The target routes are made from one table: `/api/targets/${action}` for each key of TARGET_TIMEOUTS.
    const family = /^\/api\/targets\/([a-z]+)$/.exec(route);
    const served = server.includes(`"${route}"`)
      || (family && server.includes("`/api/targets/${action}`") && new RegExp(`TARGET_TIMEOUTS = \\{[^}]*\\b${family[1]}:`).test(server));
    assert.ok(served, `the page calls ${route}, which ui.mjs does not serve`);
  }
});

test("the share form's tunnel token goes to the CLI through its environment, never its arguments", async (t) => {
  const secret = "eyJhIjoidHVubmVsLXRva2VuLWZyb20tdGhlLWZvcm0ifQ";
  const invocation = shareEnableInvocation({ publicUrl: " https://memory.example.com ", tunnelToken: ` ${secret} ` });
  assert.deepEqual(invocation.args, ["server", "share", "enable", "--public-url", "https://memory.example.com"]);
  assert.equal(invocation.env.HONCHO_TUNNEL_TOKEN, secret);
  assert.equal(JSON.stringify(invocation.args).includes(secret), false);

  const previous = process.env.HONCHO_TUNNEL_TOKEN;
  process.env.HONCHO_TUNNEL_TOKEN = "inherited-tunnel-token";
  t.after(() => {
    if (previous === undefined) delete process.env.HONCHO_TUNNEL_TOKEN;
    else process.env.HONCHO_TUNNEL_TOKEN = previous;
  });
  const blank = shareEnableInvocation({ publicUrl: "https://memory.example.com", tunnelToken: "" });
  assert.equal("HONCHO_TUNNEL_TOKEN" in blank.env, false, "a blank field keeps the saved token instead of an inherited one");

  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const routes = server.match(/const SHARE_ROUTES = \{([\s\S]*?)\n\};/)[1];
  for (const action of ["status", "enable", "join", "disable", "token", "rotate"]) {
    assert.match(routes, new RegExp(`"/api/server/share/${action}"`), action);
  }
  assert.match(routes, /runCli\(args, \{ timeout: 900_000, env \}\)/);
});

test("the Cloudflare API token and the invite go to the CLI through its environment, never its arguments", async (t) => {
  const apiToken = "cf-api-token-from-the-form-5b1d";
  const cloudflare = shareEnableInvocation({ cloudflare: true, apiToken: ` ${apiToken} `, name: "memory", zone: "example.com", email: "owner@example.com" });
  assert.deepEqual(cloudflare.args, ["server", "share", "enable", "--cloudflare", "--name=memory", "--zone=example.com", "--email=owner@example.com"]);
  assert.equal(cloudflare.env.CLOUDFLARE_API_TOKEN, apiToken);
  assert.equal(JSON.stringify(cloudflare.args).includes(apiToken), false);
  // A value that looks like an option stays the value of its own option.
  assert.deepEqual(shareEnableInvocation({ cloudflare: true, name: "--public-url" }).args, ["server", "share", "enable", "--cloudflare", "--name=--public-url"]);

  const invite = "tm1.eyJob3N0IjoibWVtb3J5LWFsaWNlLmV4YW1wbGUuY29tIn0";
  const join = shareJoinInvocation({ invite: ` ${invite} ` });
  assert.deepEqual(join.args, ["server", "share", "join"]);
  assert.equal(join.env.HONCHO_SHARE_INVITE, invite);

  const saved = { api: process.env.CLOUDFLARE_API_TOKEN, invite: process.env.HONCHO_SHARE_INVITE };
  process.env.CLOUDFLARE_API_TOKEN = "inherited-api-token";
  process.env.HONCHO_SHARE_INVITE = "tm1.inherited";
  t.after(() => {
    if (saved.api === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = saved.api;
    if (saved.invite === undefined) delete process.env.HONCHO_SHARE_INVITE; else process.env.HONCHO_SHARE_INVITE = saved.invite;
  });
  assert.equal("CLOUDFLARE_API_TOKEN" in shareEnableInvocation({ cloudflare: true }).env, false, "a blank field keeps the saved token instead of an inherited one");
  assert.equal("HONCHO_SHARE_INVITE" in shareJoinInvocation({}).env, false);
});

test("the team routes check every name, email and address before the CLI sees it", () => {
  assert.deepEqual(teammateInvocation("list"), ["teammates", "list"]);
  assert.deepEqual(teammateInvocation("connected"), ["teammates", "connected"]);
  assert.deepEqual(teammateInvocation("remove", { email: " alice@example.com " }), ["teammates", "remove", "alice@example.com"]);
  assert.equal(teammateInvocation("remove", { email: "--share=x" }), null);
  assert.equal(teammateInvocation("remove", { email: "-a@example.com" }), null);
  assert.deepEqual(teammateInvocation("unshare", { name: "Alice" }), ["teammates", "unshare", "alice"]);
  assert.equal(teammateInvocation("unshare", { name: "--all" }), null);
  assert.deepEqual(teammateInvocation("disconnect", { name: "team-alice" }), ["teammates", "disconnect", "alice"]);
  for (const address of ["memory-alice.example.com", "https://memory-alice.example.com", "https://memory-alice.example.com/mcp"]) {
    assert.deepEqual(teammateInvocation("connect", { name: "alice", address }), ["teammates", "connect", "alice", "memory-alice.example.com"], address);
  }
  for (const address of ["http://memory-alice.example.com/mcp", "https://memory-alice.example.com:8443/mcp", "https://memory-alice.example.com/other", "https://u:p@memory-alice.example.com/mcp", "--url=x", ""]) {
    assert.equal(teammateInvocation("connect", { name: "alice", address }), null, address);
  }
  assert.equal(teammateInvocation("connect", { name: "a b", address: "memory-alice.example.com" }), null);
  assert.equal(teammateInvocation("add", { email: "alice@example.com" }), null, "add is not a CLI route");
});

test("the team routes answer a same-origin POST only, and the shared-bridge routes are gone", async () => {
  for (const route of ["/api/teammates", "/api/teammates/add", "/api/teammates/remove", "/api/teammates/unshare", "/api/teammates/connected", "/api/teammates/connect", "/api/teammates/disconnect", "/api/teammates/codex-login", "/api/teammates/codex-login-status", "/api/bridge/disconnect", "/api/server/share/join"]) {
    const read = await send(route);
    assert.equal(read.status, 405, route);
    const crossSite = await send(route, { method: "POST", body: {}, headers: { origin: "http://evil.example" } });
    assert.equal(crossSite.status, 403, route);
  }
  const bad = await send("/api/teammates/connect", { method: "POST", body: { name: "alice", address: "http://memory-alice.example.com" } });
  assert.equal(bad.body.ok, false);
  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  for (const route of ["/api/bridge/status", "/api/bridge/connect", "/api/bridge/test"]) {
    assert.equal(server.includes(`"${route}"`), false, route);
    assert.equal((await send(route, { method: "POST", body: {} })).status, 404, route);
  }
});

test("sharing has the six share routes, and the screen closes it with a plain disable", async () => {
  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  const routes = server.match(/const SHARE_ROUTES = \{([\s\S]*?)\n\};/)[1];
  assert.deepEqual([...routes.matchAll(/"\/api\/server\/share\/([^"]+)"/g)].map((match) => match[1]), ["status", "enable", "join", "disable", "token", "rotate"]);
  assert.match(routes, /"\/api\/server\/share\/disable": async \(\) => runCli\(\["server", "share", "disable"\]/);
  const screen = await fsp.readFile(path.join(ROOT, "ui", "views", "share.js"), "utf8");
  assert.match(screen, /cli\("\/api\/server\/share\/disable", \{\}\)/);
});

test("the gate token is read with a same-origin POST only", async (t) => {
  const serverDir = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-ui-share-"));
  t.after(() => fsp.rm(serverDir, { recursive: true, force: true }));
  const gateToken = "ui-share-gate-token-0c9d4e1a";
  await fsp.writeFile(path.join(serverDir, ".env"), `HONCHO_GATE_TOKEN=${gateToken}\n`);
  const previous = process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR;
  process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR = serverDir;
  t.after(() => {
    if (previous === undefined) delete process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR;
    else process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR = previous;
  });

  const read = await send("/api/server/share/token");
  assert.equal(read.status, 405, "a GET, which a cross-site page can make, does not answer");
  assert.equal(read.text.includes(gateToken), false);
  const crossSite = await send("/api/server/share/token", { method: "POST", body: {}, headers: { origin: "http://evil.example" } });
  assert.equal(crossSite.status, 403);
  const shown = await send("/api/server/share/token", { method: "POST", body: {} });
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, { ok: true, token: gateToken });
});

test("the prerequisite route validates its features before running the CLI", async () => {
  for (const query of ["features=server,docker", "features=sync%20--force", "features=sync&features=server"]) {
    const response = await send(`/api/app/prereqs?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.ok, false, query);
  }
  const posted = await send("/api/app/prereqs", { method: "POST", body: {} });
  assert.equal(posted.status, 405);
  // With no feature only Node and Git are checked; this runs the same CLI a terminal would.
  const response = await send("/api/app/prereqs?features=");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map((item) => item.key), ["node", "git"]);
  assert.equal(response.body.platform, process.platform);
});

test("the app installs no prerequisite itself: the install route is gone", async () => {
  const response = await send("/api/app/prereqs/install", { method: "POST", body: {} });
  assert.equal(response.status, 404);
  const server = await fsp.readFile(path.join(ROOT, "scripts", "ui.mjs"), "utf8");
  assert.equal(server.includes("/api/app/prereqs/install"), false);
});

test("every screen a link opens exists, and so does every window of 기억 설정 it names", async () => {
  const screens = await uiSources();
  const shell = await fsp.readFile(path.join(ROOT, "ui", "app.js"), "utf8");
  const views = shell.match(/const VIEWS = \{([^}]*)\}/)[1].split(",").map((name) => name.trim().split(":")[0].trim()).filter(Boolean);
  // `start` opens first setup's window over whatever screen is on.
  views.push("start");
  const settings = await fsp.readFile(path.join(ROOT, "ui", "views", "settings.js"), "utf8");
  const windows = [...settings.match(/const windows = \{([\s\S]*?)\n    \};/)[1].matchAll(/^\s+([a-z]+): \(\)/gm)].map((match) => match[1]).sort();
  assert.deepEqual(windows, ["collect", "import", "tools"]);
  const tabs = await fsp.readFile(path.join(ROOT, "ui", "lib", "tabs.js"), "utf8");
  const tabbed = [...tabs.match(/const TABS = \{([\s\S]*?)\n\};/)[1].matchAll(/\["([a-z]+)", "/g)].map((match) => match[1]);
  assert.deepEqual(tabbed, ["memory", "ask", "server", "models", "share"]);
  const moved = Object.fromEntries([...shell.match(/const MOVED = \{([\s\S]*?)\n\};/)[1].matchAll(/"?([a-z/]+)"?: "([a-z/]+)"/g)].map((match) => [match[1], match[2]]));

  const links = [
    ...screens.matchAll(/go\("([a-z/]+)"\)/g),
    ...screens.matchAll(/href: "#\/([a-z/]+)"/g),
    ...screens.matchAll(/fix: \[[^\]]*"([a-z/]+)"\]/g),
    // The screen first setup's last button opens: ["대시보드 열기", "dashboard"].
    ...screens.matchAll(/\["[^"\n]*열기", "([a-z]+)"\]/g),
  ].map((match) => match[1]);
  assert.ok(links.length >= 12, `only ${links.length} links were found`);
  for (const link of [...links, ...tabbed, ...Object.values(moved)]) {
    const [view, page] = link.split("/");
    assert.ok(views.includes(view), `a link opens #/${link}, which no screen serves`);
    if (view === "computer" && page) assert.ok(windows.includes(page), `#/${link} is not one of 기억 설정's windows`);
  }
  // Addresses from before the menus were regrouped, of a page that moved menus, or
  // of a page that became a window, as an older skill or a saved link opens them.
  for (const old of ["connect", "connect/collect", "connect/share", "connect/targets", "team/targets", "computer/share", "tools", "tools/shared", "tools/audit",
    "computer/targets", "team/audit", "team/memories", "team/share"]) {
    assert.ok(moved[old], `#/${old} no longer leads anywhere`);
  }
  // What the setup skill opens with `ui open --screen`.
  for (const screen of ["dashboard", "start", "server", "models", "share", "backup", "team", "admin", "computer"]) {
    assert.ok(views.includes(screen), `--screen ${screen} opens nothing`);
  }
});

test("a teammate's screens never name Cloudflare; only the admin's do", async () => {
  const strings = (code) => [...code.replace(/^\s*\/\/.*$/gm, "").matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2]);
  const read = (file) => fsp.readFile(path.join(ROOT, "ui", file), "utf8");
  // From a declaration to the next top-level function or export.
  const part = (source, start) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `no ${start}`);
    const ends = [source.indexOf("\nfunction ", from + 1), source.indexOf("\nexport ", from + 1)].filter((at) => at > 0);
    return source.slice(from, ends.length ? Math.min(...ends) : undefined);
  };
  for (const file of ["views/team.js", "lib/team.js"]) {
    assert.equal(strings(await read(file)).some((text) => /cloudflare/i.test(text)), false, `${file} names Cloudflare`);
  }
  const share = await read("views/share.js");
  for (const start of ["const PUBLIC_STATES", "function mcpLine", "function shareOn", "function inviteForm"]) {
    assert.equal(strings(part(share, start)).some((text) => /cloudflare/i.test(text)), false, `share.js ${start} names Cloudflare`);
  }
  // The cards everyone sees while sharing is off.
  const off = part(share, "function shareOff");
  const from = off.indexOf('class: "choices three"');
  const cards = off.slice(from, off.indexOf("\n    body,", from));
  assert.ok(from >= 0 && strings(cards).length >= 6, "the share cards were not found");
  assert.equal(strings(cards).some((text) => /cloudflare/i.test(text)), false, "the share cards name Cloudflare");
  // First setup: joining a team never names it; making one does. Its steps are
  // functions inside openSetup, each up to the next one.
  const setup = await read("views/setup.js");
  const step = (name) => {
    const from = setup.indexOf(`  function ${name}(`);
    assert.ok(from >= 0, `setup.js has no ${name}`);
    return setup.slice(from, setup.indexOf("\n  function ", from + 1));
  };
  assert.equal(strings(step("teamStep")).some((text) => /cloudflare/i.test(text)), false, "팀에 들어가기 names Cloudflare");
  assert.equal(strings(step("matesStep")).some((text) => /cloudflare/i.test(text)), false, "the 팀원 step names Cloudflare");
  assert.ok(strings(step("makeStep")).some((text) => /cloudflare/i.test(text)), "새 팀 만들기 says it needs a Cloudflare token");
});

test("a token typed into the setup steps goes to the setup routes alone, never to an address or a log", async () => {
  const read = (file) => fsp.readFile(path.join(ROOT, "ui", file), "utf8");
  const collect = await read("lib/collect.js");
  // The whole draft goes to plan, then to apply, and nowhere else.
  const apply = collect.slice(collect.indexOf("export async function applySetup"), collect.indexOf("\n}\n", collect.indexOf("export async function applySetup")));
  assert.deepEqual([...apply.matchAll(/post\("(\/api\/[a-z/]+)", body\)/g)].map((match) => match[1]), ["/api/setup/plan", "/api/setup/apply"]);
  // Another server's token goes only to target add, which keeps it on this computer.
  const targets = collect.slice(collect.indexOf("export async function applyTargets"));
  assert.match(targets, /post\("\/api\/targets\/add", body\)/);
  for (const file of ["lib/collect.js", "views/setup.js", "views/settings.js", "views/admin.js"]) {
    const source = await read(file);
    for (const secret of ["apiToken", "accessClientId", "accessClientSecret"]) {
      assert.equal(new RegExp(`(go|location|history|console|savePrefs|localStorage)[^\\n]*${secret}`).test(source), false, `${file}: ${secret} must not reach a URL, a log or saved preferences`);
    }
  }
});
