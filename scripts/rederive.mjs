// 기억 다시 정리: the memory made again from the server's own conversations, in the
// order they started, beside the one in use, and put in its place when it is ready.
//
// Honcho keeps its tables in one Postgres schema, DB_SCHEMA in the server's private
// .env (`public` until the first rebuild), and its cache under NAMESPACE. A rebuild:
//   1. starts a second api and deriver (compose services api-next and deriver-next)
//      over a new schema mem_<yyyymmddhhmm> with a namespace of its own, on
//      127.0.0.1:<port>;
//   2. copies the workspaces, peers and sessions, then each conversation's messages,
//      conversation by conversation in the order they started, with their own times
//      and metadata, through that api, so its deriver forms the memory in that order;
//      conclusions a person or an agent wrote directly come along, never the ones the
//      deriver drew from messages, which it draws again;
//   3. waits until the new deriver has gone through every conversation and the
//      messages have their embeddings, copying what came into the memory in use
//      meanwhile. When the model refuses for a while (a subscription's limit), it
//      stops the new deriver, waits, and gives the refused work back to it;
//   4. opens the new memory to the projects opened to teammates (scopes), as the
//      memory in use had them;
//   5. switches: the api and deriver restart over the new schema, about a minute
//      without memory search (hooks keep their turns and send them after), and what
//      came in during the switch is copied last.
// The schema before stays KEEP_DAYS days: 되돌리기 (undo) switches back the same way,
// copying what came in since; 이전 기억 지우기 (drop) drops it; after KEEP_DAYS it is
// dropped on its own.
//
// <dataDir>/rederive/status.json keeps the job going (its phase and progress), the
// last one's outcome, and the schema before. A job that stopped half way (a restart)
// is carried on when the app next asks how it goes.
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installPaths, loadConfig, readJson } from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { securePrivateFile } from "./private-file-permissions.mjs";
import {
  compose,
  installedServerDir,
  installedServerModel,
  portInUse,
  readEnvironmentFile,
  replaceEnvironment,
  withServerLifecycleLock,
} from "./server-manager.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const KEEP_DAYS = 7;
const DAY_MS = 86_400_000;
const POLL_MS = 30_000;
// While the new memory forms, what came into the one in use is copied this often.
const CATCH_UP_MS = 10 * 60_000;
const STATUS_EVERY_MS = 2_000;
const MESSAGES_PER_POST = 100;
// One read of messages from the database: this many, or about this many tokens.
const MESSAGES_PER_READ = 2_000;
const TOKENS_PER_READ = 1_000_000;
// Sessions named in one read: the SQL goes on the command line, which Windows keeps under 32K characters.
const SESSIONS_PER_READ = 150;
const NEXT_PORT = 8011;
const SQL_BUFFER = 512 * 1024 * 1024;
// The queue work the new memory waits for. Dreams go on after the switch.
const DRAIN_TYPES = ["representation", "summary", "scope_backfill"];
// The estimate shown before a rebuild: one deriver call per this many tokens of a
// conversation (REPRESENTATION_BATCH_TARGET_INPUT_TOKENS), a summary per 20 and per
// 60 messages, and about this many seconds a call takes on a subscription model.
const TOKENS_PER_CALL = 1024;
const SECONDS_PER_CALL = 8;
// The model refusing: errors that grow while nothing goes through, this many polls in a row.
const REFUSED_POLLS = 2;
const PAUSE_STEPS_MS = [15, 30, 60, 120, 240].map((minutes) => minutes * 60_000);
// Without any progress this long, the rebuild gives up and says why.
const GIVE_UP_MS = 3 * DAY_MS;
// Refused work given back at the end, at most this many times.
const END_RETRIES = 3;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SCOPE_PREFIX = "scope.";

// ------------------------------------------------------------------ files

export function rederivePaths(config) {
  const { dataDir } = installPaths(config);
  const dir = path.join(dataDir, "rederive");
  return {
    dir,
    status: path.join(dir, "status.json"),
    lock: path.join(dir, "run.lock"),
    stop: path.join(dir, "stop"),
    log: path.join(dataDir, "logs", "rederive.log"),
    pastStatus: path.join(dataDir, "past", "status.json"),
  };
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readStatus(paths) {
  return (await readJson(paths.status, null)) || { version: 1 };
}

async function saveStatus(paths, patch) {
  const status = { ...(await readStatus(paths)), ...patch, version: 1 };
  await writeJson(paths.status, status);
  return status;
}

async function log(paths, line) {
  await fsp.mkdir(path.dirname(paths.log), { recursive: true }).catch(() => {});
  await fsp.appendFile(paths.log, `${new Date().toISOString()} ${line}\n`).catch(() => {});
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function exists(filePath) {
  return fsp.access(filePath).then(() => true, () => false);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** `mem_<yyyymmddhhmm>` in this computer's time. */
export function nextSchemaName(date = new Date()) {
  const two = (value) => String(value).padStart(2, "0");
  return `mem_${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}`;
}

// ------------------------------------------------------------------ the server here

/**
 * The memory server this computer's app installed: its folder, the private .env, the
 * schema and namespace in use, its API address and headers. null without one.
 */
export async function serverOf(config) {
  const directory = installedServerDir(config);
  const envPath = path.join(directory, ".env");
  if (!(await exists(envPath))) return null;
  const env = await readEnvironmentFile(envPath);
  const compose = await fsp.readFile(path.join(directory, "compose.yaml"), "utf8").catch(() => "");
  return {
    directory,
    envPath,
    env,
    current: SCHEMA_NAME.test(env.DB_SCHEMA || "") ? env.DB_SCHEMA : "public",
    namespace: env.NAMESPACE || "honcho",
    apiUrl: `http://127.0.0.1:${Number(env.HONCHO_API_PORT) || 8001}`,
    headers: adminHeaders(env),
    workers: Math.max(1, Number(env.DERIVER_WORKERS) || 1),
    // A server installed before 기억 다시 정리 has no second api until 다시 준비.
    ready: /^ {2}api-next:/m.test(compose) && /^ {2}deriver-next:/m.test(compose),
  };
}

/** With AUTH_USE_AUTH on, an admin token signed with the server's own secret (Honcho's create_admin_jwt). */
export function adminHeaders(env) {
  if (String(env?.AUTH_USE_AUTH || "").toLowerCase() !== "true" || !env?.AUTH_JWT_SECRET) return {};
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ t: "", ad: true })}`;
  const signature = crypto.createHmac("sha256", env.AUTH_JWT_SECRET).update(body).digest("base64url");
  return { authorization: `Bearer ${body}.${signature}` };
}

async function writeEnvironment(server, values) {
  const original = await fsp.readFile(server.envPath, "utf8");
  const text = replaceEnvironment(original, values);
  if (text !== original) {
    const temporary = `${server.envPath}.tmp-${process.pid}`;
    await fsp.writeFile(temporary, text, { mode: 0o600 });
    try {
      await securePrivateFile(temporary);
      await fsp.rename(temporary, server.envPath);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  Object.assign(server.env, values);
}

async function healthy(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return true;
    } catch {}
    if (Date.now() >= until) return false;
    await sleep(2_000);
  }
}

async function freePort(server) {
  const taken = new Set([server.env.HONCHO_API_PORT, server.env.HONCHO_DASHBOARD_PORT, server.env.HONCHO_GATE_PORT, 8010].map(Number));
  for (let port = NEXT_PORT; port < NEXT_PORT + 200; port += 1) {
    if (taken.has(port)) continue;
    if (!(await portInUse(port))) return port;
  }
  throw new Error("no free port for the second api");
}

// ------------------------------------------------------------------ the database

const ident = (name) => {
  if (!SCHEMA_NAME.test(String(name))) throw new Error(`not a schema name: ${name}`);
  return `"${name}"`;
};
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function psql(server, sql, { timeoutMs = 1_800_000 } = {}) {
  const result = await compose(server.directory, ["exec", "-T", "database", "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    timeout: timeoutMs,
    exec: (file, args, options) => execFileAsync(file, args, { ...options, maxBuffer: SQL_BUFFER }),
  });
  return String(result.stdout || "").trim();
}

async function rows(server, sql, options) {
  const text = await psql(server, `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`, options);
  return JSON.parse(text || "[]");
}

async function one(server, sql, options) {
  return (await rows(server, sql, options))[0] || null;
}

async function schemaReady(server, schema) {
  const row = await one(server, `SELECT to_regclass(${literal(`${ident(schema)}.messages`)}) IS NOT NULL AS ready`);
  return Boolean(row?.ready);
}

async function dropSchema(server, schema) {
  if (schema === "public") {
    // Honcho's tables only: the extensions' types stay, and the audit log has a schema of its own.
    await psql(server, `DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename); END LOOP; END $$;`);
    return;
  }
  await psql(server, `DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
}

const notScope = (alias) => `coalesce(${alias}.internal_metadata->>'kind', '') <> 'scope'`;

/** Every session of `schema` with its messages' count and tokens, in the order the conversations started. */
function sessionsSql(schema) {
  const s = ident(schema);
  return `SELECT s.workspace_name AS w, s.name AS s, s.metadata AS md, s.configuration AS cfg,
      m.start, coalesce(m.n, 0)::bigint AS n, coalesce(m.tokens, 0)::bigint AS tokens
    FROM ${s}.sessions s
    LEFT JOIN (SELECT workspace_name, session_name, min(created_at) AS start, min(id) AS first_id, count(*) AS n, sum(token_count) AS tokens
      FROM ${s}.messages GROUP BY workspace_name, session_name) m
      ON m.workspace_name = s.workspace_name AND m.session_name = s.name
    ORDER BY m.start NULLS LAST, m.first_id NULLS LAST, s.workspace_name, s.name`;
}

function countsSql(schema) {
  const s = ident(schema);
  return `SELECT s.workspace_name AS w, s.name AS s, coalesce(m.n, 0)::bigint AS n FROM ${s}.sessions s
    LEFT JOIN (SELECT workspace_name, session_name, count(*) AS n FROM ${s}.messages GROUP BY workspace_name, session_name) m
      ON m.workspace_name = s.workspace_name AND m.session_name = s.name`;
}

/**
 * How many conversations went in after a newer one: by the order they reached the
 * server (their first message's id), one that started before a conversation that
 * reached it earlier. `conversations` counts those with any message.
 */
function lateSql(schema) {
  const s = ident(schema);
  return `WITH firsts AS (SELECT min(id) AS first_id, min(created_at) AS start FROM ${s}.messages GROUP BY workspace_name, session_name),
    ordered AS (SELECT start, max(start) OVER (ORDER BY first_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before FROM firsts)
    SELECT count(*) FILTER (WHERE before IS NOT NULL AND start < before)::bigint AS late, count(*)::bigint AS conversations FROM ordered`;
}

/** What the estimate is made of: conversations, messages, tokens and the deriver calls they take. */
function sizeSql(schema) {
  const s = ident(schema);
  return `SELECT count(*)::bigint AS conversations, coalesce(sum(n), 0)::bigint AS messages, coalesce(sum(tokens), 0)::bigint AS tokens,
      coalesce(sum(ceil(tokens / ${TOKENS_PER_CALL}.0) + floor(n / 20.0) + floor(n / 60.0)), 0)::bigint AS calls,
      (SELECT coalesce(sum(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass)), 0)::bigint FROM pg_tables WHERE schemaname = ${literal(schema)}) AS bytes
    FROM (SELECT count(*) AS n, coalesce(sum(token_count), 0) AS tokens FROM ${s}.messages GROUP BY workspace_name, session_name) t`;
}

async function freeBytes(server) {
  try {
    const result = await compose(server.directory, ["exec", "-T", "database", "df", "-Pk", "/var/lib/postgresql/data"], { timeout: 60_000 });
    const line = String(result.stdout || "").trim().split(/\r?\n/).at(-1) || "";
    const available = Number(line.split(/\s+/)[3]);
    return Number.isFinite(available) ? available * 1024 : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the api the copy goes through

function honchoCaller(base, headers) {
  return async function call(method, apiPath, body) {
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await fetch(`${base}${apiPath}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });
        const text = await response.text();
        if (response.ok) return text ? JSON.parse(text) : null;
        lastError = new Error(`HTTP ${response.status} ${method} ${apiPath}: ${text.slice(0, 300)}`);
        // Refused for what was sent: asking again would get the same answer.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) throw Object.assign(lastError, { final: true });
      } catch (error) {
        if (error?.final) throw error;
        lastError = error;
      }
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
    }
    throw lastError;
  };
}

const quote = encodeURIComponent;

/** Only what a session's peer config may hold (SessionPeerConfig). */
function peerConfig(value) {
  const config = {};
  for (const key of ["observe_me", "observe_others"]) if (typeof value?.[key] === "boolean") config[key] = value[key];
  return config;
}

// ------------------------------------------------------------------ the copy

/**
 * Brings `to` level with `from`: the workspaces, peers and webhooks it lacks, then
 * every conversation in the order it started, each from the message it lacks on;
 * with `conclusions`, the conclusions written directly since `conclusionsSince`.
 * Copying again copies only what came since, so it is also how a stopped copy carries
 * on. `call` is the api over `to`.
 */
async function syncInto(server, { from, to, call, progress = async () => {}, stopped = async () => false, conclusionsSince = undefined }) {
  const f = ident(from);
  const t = ident(to);
  const key = (w, s) => `${w}\u0000${s}`;
  // conversations and messages: in `to` once copied, the ones there before included; sent: the messages this copy posted.
  const done = { conversations: 0, messages: 0, conclusions: 0, created: 0, sent: 0 };

  const workspaces = await rows(server, `SELECT name AS w, metadata AS md, configuration AS cfg FROM ${f}.workspaces ORDER BY created_at`);
  const haveWorkspaces = new Set((await rows(server, `SELECT name AS w FROM ${t}.workspaces`)).map((row) => row.w));
  for (const workspace of workspaces) {
    if (haveWorkspaces.has(workspace.w)) continue;
    await call("POST", "/v3/workspaces", { id: workspace.w, metadata: workspace.md || {}, configuration: workspace.cfg || {} });
  }
  const peers = await rows(server, `SELECT p.workspace_name AS w, p.name AS p, p.metadata AS md, p.configuration AS cfg FROM ${f}.peers p WHERE ${notScope("p")} ORDER BY p.created_at`);
  const havePeers = new Set((await rows(server, `SELECT workspace_name AS w, name AS p FROM ${t}.peers`)).map((row) => key(row.w, row.p)));
  for (const peer of peers) {
    if (havePeers.has(key(peer.w, peer.p))) continue;
    await call("POST", `/v3/workspaces/${quote(peer.w)}/peers`, { id: peer.p, metadata: peer.md || {}, configuration: peer.cfg || {} });
  }
  const hooks = await rows(server, `SELECT workspace_name AS w, url FROM ${f}.webhook_endpoints`);
  const haveHooks = new Set((await rows(server, `SELECT workspace_name AS w, url FROM ${t}.webhook_endpoints`)).map((row) => key(row.w, row.url)));
  for (const hook of hooks) {
    if (!haveHooks.has(key(hook.w, hook.url))) await call("POST", `/v3/workspaces/${quote(hook.w)}/webhooks`, { url: hook.url });
  }

  const sessions = await rows(server, sessionsSql(from));
  const have = new Map((await rows(server, countsSql(to))).map((row) => [key(row.w, row.s), Number(row.n)]));
  const members = new Map();
  for (const row of await rows(server, `SELECT sp.workspace_name AS w, sp.session_name AS s, sp.peer_name AS p, sp.configuration AS cfg
      FROM ${f}.session_peers sp JOIN ${f}.peers p ON p.workspace_name = sp.workspace_name AND p.name = sp.peer_name
      WHERE sp.left_at IS NULL AND ${notScope("p")}`)) {
    const id = key(row.w, row.s);
    if (!members.has(id)) members.set(id, {});
    members.get(id)[row.p] = peerConfig(row.cfg);
  }
  const totals = { conversations: sessions.filter((session) => Number(session.n) > 0).length, messages: sessions.reduce((sum, session) => sum + Number(session.n), 0) };
  let lastReport = 0;
  const report = async (force = false) => {
    if (!force && Date.now() - lastReport < STATUS_EVERY_MS) return;
    lastReport = Date.now();
    await progress({ ...done, totals });
  };

  // Conversations still to copy, each from the message `to` lacks on.
  const todo = [];
  for (const session of sessions) {
    const id = key(session.w, session.s);
    const already = have.has(id) ? have.get(id) : null;
    const total = Number(session.n);
    if (already !== null && already >= total) {
      if (total > 0) {
        done.conversations += 1;
        done.messages += total;
      }
      continue;
    }
    todo.push({ ...session, id, total, already });
  }
  await report(true);

  const send = async (session, messages) => {
    for (let index = 0; index < messages.length; index += MESSAGES_PER_POST) {
      const batch = messages.slice(index, index + MESSAGES_PER_POST);
      await call("POST", `/v3/workspaces/${quote(session.w)}/sessions/${quote(session.s)}/messages`, {
        messages: batch.map((message) => ({ content: message.c ?? "", peer_id: message.p, metadata: message.md || {}, created_at: message.at })),
      });
      done.messages += batch.length;
      done.sent += batch.length;
      await report();
    }
  };
  const open = async (session) => {
    if (session.already !== null) return;
    await call("POST", `/v3/workspaces/${quote(session.w)}/sessions`, {
      id: session.s,
      metadata: session.md || {},
      configuration: session.cfg || {},
      peers: members.get(session.id) || {},
    });
    done.created += 1;
  };

  let index = 0;
  while (index < todo.length) {
    if (await stopped()) return { stopped: true, ...done, totals };
    const session = todo[index];
    if (session.already !== null || session.total > MESSAGES_PER_READ) {
      // One conversation, read on from where `to` stops, a part at a time.
      await open(session);
      let offset = session.already || 0;
      done.messages += offset;
      while (offset < session.total) {
        if (await stopped()) return { stopped: true, ...done, totals };
        const part = await rows(server, `SELECT peer_name AS p, content AS c, metadata AS md, created_at AS at FROM ${f}.messages
          WHERE workspace_name = ${literal(session.w)} AND session_name = ${literal(session.s)} ORDER BY id OFFSET ${offset} LIMIT ${MESSAGES_PER_READ}`);
        if (!part.length) break;
        await send(session, part);
        offset += part.length;
      }
      if (session.total > 0) done.conversations += 1;
      index += 1;
      continue;
    }
    // New conversations, read together up to MESSAGES_PER_READ messages or TOKENS_PER_READ tokens.
    const group = [];
    let count = 0;
    let tokens = 0;
    while (index < todo.length) {
      const next = todo[index];
      if (next.already !== null || next.total > MESSAGES_PER_READ) break;
      if (group.length && (group.length >= SESSIONS_PER_READ || count + next.total > MESSAGES_PER_READ || tokens + Number(next.tokens) > TOKENS_PER_READ)) break;
      group.push(next);
      count += next.total;
      tokens += Number(next.tokens);
      index += 1;
    }
    const withMessages = group.filter((session) => session.total > 0);
    const read = withMessages.length
      ? await rows(server, `SELECT workspace_name AS w, session_name AS s, peer_name AS p, content AS c, metadata AS md, created_at AS at FROM ${f}.messages
          WHERE (workspace_name, session_name) IN (VALUES ${withMessages.map((session) => `(${literal(session.w)}, ${literal(session.s)})`).join(", ")})
          ORDER BY id`)
      : [];
    const bySession = new Map();
    for (const message of read) {
      const id = key(message.w, message.s);
      if (!bySession.has(id)) bySession.set(id, []);
      bySession.get(id).push(message);
    }
    for (const session of group) {
      if (await stopped()) return { stopped: true, ...done, totals };
      await open(session);
      const messages = bySession.get(session.id) || [];
      if (messages.length) {
        await send(session, messages);
        done.conversations += 1;
      }
    }
  }

  if (conclusionsSince !== undefined) {
    const since = conclusionsSince ? `AND d.created_at > ${literal(conclusionsSince)}` : "";
    const written = await rows(server, `SELECT d.workspace_name AS w, d.observer AS o, d.observed AS d, d.session_name AS s, d.content AS c, d.created_at AS at
      FROM ${f}.documents d WHERE d.deleted_at IS NULL AND d.level = 'explicit' AND d.internal_metadata = '{}'::jsonb
        AND d.observer NOT LIKE 'scope.%' AND d.observed NOT LIKE 'scope.%' ${since} ORDER BY d.created_at`);
    const sessionsThere = new Set((await rows(server, `SELECT workspace_name AS w, name AS s FROM ${t}.sessions`)).map((row) => key(row.w, row.s)));
    const byWorkspace = new Map();
    for (const conclusion of written) {
      if (!byWorkspace.has(conclusion.w)) byWorkspace.set(conclusion.w, []);
      byWorkspace.get(conclusion.w).push(conclusion);
    }
    for (const [workspace, list] of byWorkspace) {
      for (let at = 0; at < list.length; at += 100) {
        const batch = list.slice(at, at + 100);
        await call("POST", `/v3/workspaces/${quote(workspace)}/conclusions`, {
          conclusions: batch.map((conclusion) => ({
            content: conclusion.c,
            observer_id: conclusion.o,
            observed_id: conclusion.d,
            ...(conclusion.s && sessionsThere.has(key(workspace, conclusion.s)) ? { session_id: conclusion.s } : {}),
          })),
        });
        done.conclusions += batch.length;
      }
    }
    done.conclusionsAt = written.at(-1)?.at || conclusionsSince || null;
  }
  await report(true);
  return { stopped: false, ...done, totals };
}

/** The projects opened to teammates: each scope of `from`, and its sessions, in `to`. */
async function syncScopes(server, { from, to, call }) {
  const f = ident(from);
  const t = ident(to);
  const scopes = await rows(server, `SELECT p.workspace_name AS w, p.name AS p, p.metadata AS md FROM ${f}.peers p WHERE p.internal_metadata->>'kind' = 'scope'`);
  const members = await rows(server, `SELECT sp.workspace_name AS w, sp.peer_name AS p, sp.session_name AS s FROM ${f}.session_peers sp
    JOIN ${f}.peers p ON p.workspace_name = sp.workspace_name AND p.name = sp.peer_name
    WHERE p.internal_metadata->>'kind' = 'scope' AND sp.left_at IS NULL`);
  const already = new Set((await rows(server, `SELECT sp.workspace_name AS w, sp.peer_name AS p, sp.session_name AS s FROM ${t}.session_peers sp
    JOIN ${t}.peers p ON p.workspace_name = sp.workspace_name AND p.name = sp.peer_name
    WHERE p.internal_metadata->>'kind' = 'scope' AND sp.left_at IS NULL`)).map((row) => `${row.w}\u0000${row.p}\u0000${row.s}`));
  const sessions = new Set((await rows(server, `SELECT workspace_name AS w, name AS s FROM ${t}.sessions`)).map((row) => `${row.w}\u0000${row.s}`));
  let added = 0;
  for (const scope of scopes) {
    const id = scope.p.slice(SCOPE_PREFIX.length);
    await call("POST", `/v3/workspaces/${quote(scope.w)}/scopes`, { id, metadata: scope.md || {} });
    const wanted = members
      .filter((row) => row.w === scope.w && row.p === scope.p && sessions.has(`${row.w}\u0000${row.s}`) && !already.has(`${row.w}\u0000${row.p}\u0000${row.s}`))
      .map((row) => row.s);
    for (let at = 0; at < wanted.length; at += 100) {
      const batch = wanted.slice(at, at + 100);
      await call("POST", `/v3/workspaces/${quote(scope.w)}/scopes/${quote(id)}/sessions`, { session_ids: batch });
      added += batch.length;
    }
  }
  return { scopes: scopes.length, added };
}

/**
 * How far the deriver of `schema` has got. The messages went in in the order their
 * conversations started, so its frontier is the first message still waiting: `before`
 * counts the messages ahead of it, and `at` is when that message's conversation started.
 */
async function deriveState(server, schema) {
  const s = ident(schema);
  const types = DRAIN_TYPES.map(literal).join(", ");
  const row = await one(server, `WITH frontier AS (
      SELECT m.id, m.workspace_name, m.session_name FROM ${s}.queue q JOIN ${s}.messages m ON m.id = q.message_id
      WHERE NOT q.processed AND q.task_type = 'representation' ORDER BY m.id LIMIT 1)
    SELECT
      (SELECT count(*) FROM ${s}.messages)::bigint AS messages,
      (SELECT count(*) FROM ${s}.messages WHERE id < coalesce((SELECT id FROM frontier), 9223372036854775807))::bigint AS before,
      (SELECT min(m.created_at) FROM ${s}.messages m JOIN frontier f ON m.workspace_name = f.workspace_name AND m.session_name = f.session_name) AS at,
      (SELECT count(*) FROM ${s}.queue WHERE NOT processed AND task_type IN (${types}))::bigint AS work,
      (SELECT count(*) FROM ${s}.queue WHERE processed AND error IS NOT NULL AND task_type IN (${types}))::bigint AS errored,
      (SELECT count(*) FROM ${s}.message_embeddings WHERE sync_state = 'pending')::bigint AS embedding`);
  const number = (value) => Number(value || 0);
  return {
    messages: number(row?.messages),
    before: number(row?.before),
    work: number(row?.work),
    errored: number(row?.errored),
    embedding: number(row?.embedding),
    at: row?.at ? Date.parse(row.at) : null,
  };
}

/** The work the model refused, given back to the deriver. */
async function giveBack(server, schema) {
  const types = DRAIN_TYPES.map(literal).join(", ");
  await psql(server, `UPDATE ${ident(schema)}.queue SET processed = false, error = NULL WHERE processed AND error IS NOT NULL AND task_type IN (${types})`);
}

/**
 * Whether the model has been refusing: errors grew and nothing went through, this
 * many polls in a row. `history` is the polls so far, newest last.
 */
export function refusing(history, polls = REFUSED_POLLS) {
  if (history.length < polls + 1) return false;
  const recent = history.slice(-(polls + 1));
  for (let index = 1; index < recent.length; index += 1) {
    const before = recent[index - 1];
    const now = recent[index];
    if (now.done > before.done || now.errored <= before.errored) return false;
  }
  return true;
}

/** Seconds left by the pace of the last hour of `samples` ({t, done}). */
export function etaFrom(samples, total) {
  if (samples.length < 2) return null;
  const last = samples.at(-1);
  const first = samples.find((sample) => last.t - sample.t <= 60 * 60_000) || samples[0];
  const rate = (last.done - first.done) / Math.max(1, (last.t - first.t) / 1000);
  if (!(rate > 0)) return null;
  return Math.max(0, Math.round((total - last.done) / rate));
}

// ------------------------------------------------------------------ the job

/** The estimate 처음부터 다시 정리 shows before it starts. */
export async function rederiveEstimate(config) {
  const server = await serverOf(config);
  if (!server) return { ok: false, code: "no-server", error: "this computer runs no memory server" };
  const size = await one(server, sizeSql(server.current));
  const calls = Number(size?.calls || 0);
  const paths = rederivePaths(config);
  const status = await readStatus(paths);
  return {
    ok: true,
    conversations: Number(size?.conversations || 0),
    messages: Number(size?.messages || 0),
    tokens: Number(size?.tokens || 0),
    calls,
    seconds: Math.round((calls * SECONDS_PER_CALL) / server.workers),
    diskBytes: Number(size?.bytes || 0),
    freeBytes: await freeBytes(server),
    model: await installedServerModel(server.directory),
    keepDays: KEEP_DAYS,
    // Starting again drops the memory kept from the last switch first.
    dropsPrevious: status.previous ? { schema: status.previous.schema, keepUntil: status.previous.keepUntil, rebuilt: Boolean(status.previous.rebuilt) } : null,
  };
}

async function pastRunning(paths) {
  const past = await readJson(paths.pastStatus, null);
  return Boolean(past?.running && alive(Number(past.running.pid)));
}

function spawnRun(config) {
  const installed = path.join(installPaths(config).runtimeDir, "cli.mjs");
  const cli = fs.existsSync(installed) ? installed : path.join(SCRIPT_DIR, "cli.mjs");
  const child = spawn(process.execPath, [cli, "rederive", "run"], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

/** 처음부터 다시 정리: a new schema, filled in the order the conversations started. */
export async function rederiveStart(config) {
  const paths = rederivePaths(config);
  const server = await serverOf(config);
  if (!server) return { ok: false, code: "no-server", error: "this computer runs no memory server" };
  if (!server.ready) return { ok: false, code: "not-ready", error: "the installed server has no second api yet: run server prepare (다시 준비) first" };
  const status = await readStatus(paths);
  if (status.job) return { ok: false, code: "busy", error: "a rebuild is going already" };
  if (await pastRunning(paths)) return { ok: false, code: "past-running", error: "past conversations are going in: rebuild once they are in" };
  if (!(await healthy(server.apiUrl, 10_000))) return { ok: false, code: "server-down", error: "the memory server does not answer: start it first" };
  if (status.previous) {
    await dropSchema(server, status.previous.schema);
    await log(paths, `dropped ${status.previous.schema} before a new rebuild`);
  }
  const size = await one(server, sizeSql(server.current));
  const schema = nextSchemaName();
  const job = {
    kind: "build",
    schema,
    namespace: schema,
    from: server.current,
    fromNamespace: server.namespace,
    port: await freePort(server),
    startedAt: new Date().toISOString(),
    phase: "start",
    totals: { conversations: Number(size?.conversations || 0), messages: Number(size?.messages || 0), calls: Number(size?.calls || 0) },
    copied: { conversations: 0, messages: 0 },
    derive: null,
    conclusionsAt: null,
    swapStep: 0,
    pid: null,
  };
  await fsp.rm(paths.stop, { force: true });
  await saveStatus(paths, { job, previous: null });
  await log(paths, `start build ${schema} from ${server.current}`);
  job.pid = spawnRun(config);
  await saveStatus(paths, { job });
  return { ok: true, schema, startedAt: job.startedAt };
}

/** 되돌리기: back to the memory before the last switch, with what came in since. */
export async function rederiveUndo(config) {
  const paths = rederivePaths(config);
  const server = await serverOf(config);
  if (!server) return { ok: false, code: "no-server", error: "this computer runs no memory server" };
  const status = await readStatus(paths);
  if (status.job) return { ok: false, code: "busy", error: "a rebuild is going already" };
  if (!status.previous) return { ok: false, code: "no-previous", error: "there is no memory from before to go back to" };
  if (!(await schemaReady(server, status.previous.schema))) return { ok: false, code: "no-previous", error: "the memory from before is gone" };
  if (!(await healthy(server.apiUrl, 10_000))) return { ok: false, code: "server-down", error: "the memory server does not answer: start it first" };
  const job = {
    kind: "undo",
    schema: status.previous.schema,
    namespace: status.previous.namespace || (status.previous.schema === "public" ? "honcho" : status.previous.schema),
    from: server.current,
    fromNamespace: server.namespace,
    port: await freePort(server),
    startedAt: new Date().toISOString(),
    phase: "start",
    totals: null,
    copied: { conversations: 0, messages: 0 },
    derive: null,
    conclusionsAt: status.previous.swappedAt || null,
    swapStep: 0,
    pid: null,
    // Going back to the memory a rebuild made, after going back from it.
    toRebuilt: Boolean(status.previous.rebuilt),
  };
  await fsp.rm(paths.stop, { force: true });
  await saveStatus(paths, { job });
  await log(paths, `start undo to ${job.schema} from ${server.current}`);
  job.pid = spawnRun(config);
  await saveStatus(paths, { job });
  return { ok: true, schema: job.schema };
}

/** 이전 기억 지우기, or the drop due after KEEP_DAYS. */
export async function rederiveDrop(config) {
  const paths = rederivePaths(config);
  const server = await serverOf(config);
  if (!server) return { ok: false, code: "no-server", error: "this computer runs no memory server" };
  const status = await readStatus(paths);
  if (status.job) return { ok: false, code: "busy", error: "a rebuild is going" };
  if (!status.previous) return { ok: true, dropped: null };
  if (status.previous.schema === server.current) return { ok: false, error: "that is the memory in use" };
  await dropSchema(server, status.previous.schema);
  await log(paths, `dropped ${status.previous.schema}`);
  await saveStatus(paths, { previous: null, last: status.last ? { ...status.last, previousDroppedAt: new Date().toISOString() } : status.last });
  return { ok: true, dropped: status.previous.schema };
}

/** Stops the second api and deriver and takes their settings out of the .env. */
async function removeNext(server) {
  await compose(server.directory, ["--profile", "rederive", "rm", "-s", "-f", "api-next", "deriver-next"], { timeout: 600_000 }).catch(() => {});
  await writeEnvironment(server, { HONCHO_NEXT_SCHEMA: "", HONCHO_NEXT_NAMESPACE: "", HONCHO_NEXT_API_PORT: "" });
}

/**
 * 그만두기: ends the job before it switches. A rebuild's new schema is dropped; going
 * back keeps the memory it was going back to. The switch itself is not stopped.
 */
export async function rederiveStop(config) {
  const paths = rederivePaths(config);
  const status = await readStatus(paths);
  const job = status.job;
  if (!job) return { ok: true, stopped: false };
  if (job.phase === "swap") return { ok: false, code: "switching", error: "the switch is going and finishes in a minute" };
  await fsp.mkdir(paths.dir, { recursive: true });
  await fsp.writeFile(paths.stop, new Date().toISOString());
  // A job running ends itself after the step it is on, and cleans up.
  if (alive(Number(job.pid))) return { ok: true, stopping: true };
  const server = await serverOf(config);
  if (server) await abandon(server, paths, job);
  return { ok: true, stopped: true };
}

/** 다시 시도: a job that stopped on an error goes on from the phase it was at. */
export async function rederiveResume(config) {
  const paths = rederivePaths(config);
  const status = await readStatus(paths);
  const job = status.job;
  if (!job) return { ok: false, code: "idle", error: "no rebuild to carry on" };
  if (alive(Number(job.pid))) return { ok: true, running: true };
  job.error = null;
  job.pid = spawnRun(config);
  await saveStatus(paths, { job });
  return { ok: true, running: true };
}

async function abandon(server, paths, job) {
  await removeNext(server);
  if (job.kind === "build" && job.schema !== server.current) await dropSchema(server, job.schema).catch(() => {});
  const status = await readStatus(paths);
  await saveStatus(paths, { job: null, last: { kind: job.kind, startedAt: job.startedAt, finishedAt: new Date().toISOString(), cancelled: true } });
  await fsp.rm(paths.stop, { force: true });
  await log(paths, `stopped ${job.kind} ${job.schema}`);
  return status;
}

/**
 * Runs the job in status.json from the phase it is at: start, copy, derive, scopes,
 * swap. Each phase can run again, so a job stopped half way carries on here.
 */
export async function rederiveRun(config) {
  const paths = rederivePaths(config);
  const server = await serverOf(config);
  if (!server) return { ok: false, error: "this computer runs no memory server" };
  await fsp.mkdir(paths.dir, { recursive: true });
  const lock = await acquireFileLock(paths.lock, { attempts: 1, staleMs: 30 * DAY_MS, reclaimDeadImmediately: true });
  if (!lock) return { ok: false, code: "busy", error: "the job runs already" };
  const job = (await readStatus(paths)).job;
  if (!job) {
    await releaseFileLock(lock);
    return { ok: true, idle: true };
  }
  job.pid = process.pid;
  job.error = null;
  const save = async (patch = {}) => {
    Object.assign(job, patch);
    await saveStatus(paths, { job });
  };
  const stopped = () => exists(paths.stop);
  const nextUrl = () => `http://127.0.0.1:${job.port}`;
  const callNext = honchoCaller(nextUrl(), server.headers);
  try {
    await save();
    if (await stopped()) {
      await abandon(server, paths, job);
      return { ok: true, stopped: true };
    }

    // The second api and deriver, until the switch has left them.
    if (["start", "copy", "derive", "scopes"].includes(job.phase) || (job.phase === "swap" && (job.swapStep || 0) < 2)) {
      await log(paths, `${job.kind} ${job.schema}: phase ${job.phase}`);
      await writeEnvironment(server, { HONCHO_NEXT_SCHEMA: job.schema, HONCHO_NEXT_NAMESPACE: job.namespace, HONCHO_NEXT_API_PORT: String(job.port) });
      await compose(server.directory, ["--profile", "rederive", "up", "-d", "api-next", "deriver-next"], { timeout: 1_800_000 });
      if (!(await healthy(nextUrl(), 15 * 60_000))) throw new Error("the second api did not start");
      if (job.phase === "start") await save({ phase: "copy" });
    }

    if (job.phase === "copy") {
      const result = await syncInto(server, {
        from: job.from,
        to: job.schema,
        call: callNext,
        stopped,
        conclusionsSince: job.conclusionsAt,
        progress: async ({ conversations, messages, totals }) => save({ copied: { conversations, messages }, totals: { ...(job.totals || {}), ...totals, calls: job.totals?.calls || 0 } }),
      });
      if (result.stopped) {
        await abandon(server, paths, job);
        return { ok: true, stopped: true };
      }
      await save({ phase: "derive", conclusionsAt: result.conclusionsAt || job.conclusionsAt, copied: { conversations: result.conversations, messages: result.messages } });
      await log(paths, `copied ${result.sent} messages and ${result.conclusions} conclusions; ${result.conversations} conversations, ${result.messages} messages in place`);
    }

    if (job.phase === "derive") {
      const outcome = await deriveWait(server, paths, job, save, stopped, callNext);
      if (outcome === "stopped") {
        await abandon(server, paths, job);
        return { ok: true, stopped: true };
      }
      await save({ phase: "scopes" });
    }

    if (job.phase === "scopes") {
      const scoped = await syncScopes(server, { from: job.from, to: job.schema, call: callNext });
      await log(paths, `scopes ${scoped.scopes}, sessions added ${scoped.added}`);
      if (scoped.added) {
        // Each session added is copied into its scope by the deriver (scope_backfill).
        for (;;) {
          if (await stopped()) {
            await abandon(server, paths, job);
            return { ok: true, stopped: true };
          }
          const state = await deriveState(server, job.schema);
          if (!state.work) break;
          await sleep(5_000);
        }
      }
      await save({ phase: "swap", swapStep: 0 });
    }

    if (job.phase === "swap") await swap(server, paths, job, save, callNext);
    return { ok: true, ...(await readStatus(paths)).last };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    await log(paths, `error: ${message}`);
    await save({ error: message, failedAt: new Date().toISOString() }).catch(() => {});
    return { ok: false, error: message };
  } finally {
    await releaseFileLock(lock);
  }
}

/**
 * Waits for the new deriver to go through every conversation and for the messages'
 * embeddings, catching up with the memory in use every CATCH_UP_MS. A model refusing
 * for REFUSED_POLLS polls stops the new deriver for a while, then gives the refused
 * work back; whatever stayed refused at the end is given back END_RETRIES times.
 */
async function deriveWait(server, paths, job, save, stopped, callNext) {
  const history = [];
  const samples = [];
  let lastCatchUp = Date.now();
  let lastProgressAt = Date.now();
  let pauseStep = 0;
  let endRetries = 0;
  for (;;) {
    if (await stopped()) return "stopped";
    if (Date.now() - lastCatchUp >= CATCH_UP_MS) {
      const caught = await syncInto(server, { from: job.from, to: job.schema, call: callNext, stopped, conclusionsSince: job.conclusionsAt });
      if (caught.stopped) return "stopped";
      if (caught.conclusionsAt) await save({ conclusionsAt: caught.conclusionsAt });
      lastCatchUp = Date.now();
    }
    const state = await deriveState(server, job.schema);
    const total = Math.max(Number(job.totals?.messages || 0), state.messages);
    const done = state.before;
    const now = Date.now();
    history.push({ done, errored: state.errored });
    if (history.length > 20) history.shift();
    samples.push({ t: now, done });
    while (samples.length > 2 && now - samples[0].t > 2 * 60 * 60_000) samples.shift();
    if (samples.length < 2 || done > samples.at(-2).done) {
      lastProgressAt = now;
      pauseStep = 0;
    }
    await save({ derive: { done, total, at: state.at, etaSec: etaFrom(samples, total), errored: state.errored, paused: null } });

    if (!state.work && !state.embedding) {
      if (state.errored && endRetries < END_RETRIES) {
        endRetries += 1;
        await log(paths, `giving back ${state.errored} refused work items (end, ${endRetries})`);
        await giveBack(server, job.schema);
        await sleep(POLL_MS);
        continue;
      }
      // A last catch-up, then the switch copies what comes in during it.
      const caught = await syncInto(server, { from: job.from, to: job.schema, call: callNext, stopped, conclusionsSince: job.conclusionsAt });
      if (caught.stopped) return "stopped";
      if (caught.conclusionsAt) await save({ conclusionsAt: caught.conclusionsAt });
      const after = await deriveState(server, job.schema);
      if (!after.work && !after.embedding) {
        await save({ derive: { done: after.messages, total: after.messages, at: null, etaSec: 0, errored: after.errored, paused: null }, unrefused: after.errored });
        return "done";
      }
      await sleep(POLL_MS);
      continue;
    }

    if (now - lastProgressAt > GIVE_UP_MS) throw new Error("the model has not answered for three days");
    if (refusing(history)) {
      const wait = PAUSE_STEPS_MS[Math.min(pauseStep, PAUSE_STEPS_MS.length - 1)];
      pauseStep += 1;
      const until = new Date(Date.now() + wait).toISOString();
      await log(paths, `the model refuses: pausing the new deriver until ${until}`);
      await compose(server.directory, ["--profile", "rederive", "stop", "deriver-next"], { timeout: 600_000 });
      await save({ derive: { ...job.derive, paused: { until } } });
      while (Date.now() < Date.parse(until)) {
        if (await stopped()) return "stopped";
        await sleep(10_000);
      }
      await giveBack(server, job.schema);
      await compose(server.directory, ["--profile", "rederive", "up", "-d", "deriver-next"], { timeout: 600_000 });
      history.length = 0;
      await save({ derive: { ...job.derive, paused: null } });
      continue;
    }
    await sleep(POLL_MS);
  }
}

/**
 * What a switch leaves on record: the conversations and messages the new memory holds,
 * the turns copied in while it was made included, and how long it took.
 */
export function switchRecord(job, size, finishedAt) {
  return {
    kind: job.kind,
    startedAt: job.startedAt,
    finishedAt,
    swappedAt: finishedAt,
    schema: job.schema,
    conversations: Number(size?.conversations) || job.copied?.conversations || job.totals?.conversations || 0,
    messages: Number(size?.messages) || job.derive?.total || job.totals?.messages || 0,
    calls: job.totals?.calls || 0,
    hours: Math.max(0, (Date.parse(finishedAt) - Date.parse(job.startedAt)) / 3_600_000),
    unrefused: job.unrefused || 0,
    ...(job.kind === "undo" ? { toRebuilt: Boolean(job.toRebuilt) } : {}),
  };
}

/**
 * The memory kept after a switch, for KEEP_DAYS: the one left. `rebuilt` when that is
 * the memory a rebuild made, left by going back to the one before it.
 */
export function keptRecord(job, finishedAt) {
  return {
    schema: job.from,
    namespace: job.fromNamespace,
    swappedAt: finishedAt,
    keepUntil: new Date(Date.parse(finishedAt) + KEEP_DAYS * DAY_MS).toISOString(),
    rebuilt: job.kind === "undo" && !job.toRebuilt,
  };
}

/**
 * The switch, a step at a time so a stop half way carries on: copy what came in,
 * point the .env at the new schema, restart the api and deriver over it, remove the
 * second pair, and copy what came into the old schema until the api left it.
 */
async function swap(server, paths, job, save, callNext) {
  const from = job.swapStep || 0;
  const stepDone = (step) => save({ swapStep: step });
  const copy = async (call) => {
    const result = await syncInto(server, { from: job.from, to: job.schema, call, conclusionsSince: job.conclusionsAt });
    if (result.conclusionsAt) await save({ conclusionsAt: result.conclusionsAt });
  };
  if (from <= 0) {
    await copy(callNext);
    await stepDone(1);
  }
  if (from <= 2) {
    await log(paths, `switching to ${job.schema}`);
    let switched = false;
    for (let tries = 0; !switched; tries += 1) {
      try {
        await withServerLifecycleLock(server.directory, "rederive switch", async () => {
          await writeEnvironment(server, { DB_SCHEMA: job.schema, NAMESPACE: job.namespace });
          await stepDone(2);
          await compose(server.directory, ["up", "-d", "--no-deps", "--force-recreate", "api", "deriver"], { timeout: 1_800_000 });
        });
        switched = true;
      } catch (error) {
        if (error?.code !== "HONCHO_AGENT_BRIDGE_SERVER_LIFECYCLE_BUSY" || tries > 60) throw error;
        await sleep(10_000);
      }
    }
    if (!(await healthy(server.apiUrl, 15 * 60_000))) throw new Error("the memory server did not answer after the switch");
    await stepDone(3);
  }
  if (from <= 3) {
    await removeNext(server);
    await stepDone(4);
  }
  if (from <= 4) {
    // Turns that reached the old schema between the last copy and the restart.
    await copy(honchoCaller(server.apiUrl, server.headers));
    await stepDone(5);
  }
  const finishedAt = new Date().toISOString();
  const size = await one(server, `SELECT count(DISTINCT (workspace_name, session_name))::bigint AS conversations, count(*)::bigint AS messages FROM ${ident(job.schema)}.messages`).catch(() => null);
  const last = switchRecord(job, size, finishedAt);
  await saveStatus(paths, {
    job: null,
    last,
    previous: keptRecord(job, finishedAt),
  });
  await fsp.rm(paths.stop, { force: true });
  await log(paths, `switched to ${job.schema}; ${job.from} kept until ${KEEP_DAYS} days from now`);
}

// ------------------------------------------------------------------ what the screens show

/** The job as the screens show it: what it is doing and how far it has got. */
function jobView(job, stopping) {
  if (!job) return null;
  return {
    kind: job.kind,
    phase: job.phase,
    startedAt: job.startedAt,
    totals: job.totals || null,
    copied: job.copied || null,
    derive: job.derive || null,
    error: job.error || null,
    stopping,
    ...(job.kind === "undo" ? { toRebuilt: Boolean(job.toRebuilt) } : {}),
  };
}

/**
 * 서버 → 기억 서버's 기억 다시 정리: the job going (carried on when it stopped half
 * way), the last one, the memory kept from before (dropped once due), and how many
 * conversations went in after a newer one (`order`, read when asked).
 */
export async function rederiveStatus(config, { order = false } = {}) {
  const paths = rederivePaths(config);
  const server = await serverOf(config);
  if (!server) return { ok: true, here: false };
  const status = await readStatus(paths);
  const job = status.job || null;
  const running = Boolean(job && alive(Number(job.pid)));
  const stopping = Boolean(job) && (await exists(paths.stop));
  if (job && !running && !job.error && Date.now() - (Date.parse(status.resumedAt || "") || 0) > 60_000) {
    await saveStatus(paths, { resumedAt: new Date().toISOString() });
    spawnRun(config);
  }
  if (!job && status.previous && Date.parse(status.previous.keepUntil) <= Date.now()) {
    const dropped = await rederiveDrop(config).catch(() => null);
    if (dropped?.ok) status.previous = null;
  }
  let late = null;
  if (order) {
    try {
      const row = await one(server, lateSql(server.current));
      late = { late: Number(row?.late || 0), conversations: Number(row?.conversations || 0) };
    } catch (error) {
      late = { error: String(error?.message || error).slice(0, 300) };
    }
  }
  return {
    ok: true,
    here: true,
    ready: server.ready,
    current: server.current,
    job: jobView(job, stopping),
    running,
    last: status.last || null,
    previous: status.previous || null,
    order: late,
  };
}

/** The dashboard's view, asked every few seconds: only the status file. null with no server here or nothing to show. */
export async function rederiveFlow(config) {
  const paths = rederivePaths(config);
  const status = await readJson(paths.status, null);
  if (!status || (!status.job && !status.last)) return null;
  return {
    job: jobView(status.job || null, false),
    running: Boolean(status.job && alive(Number(status.job.pid))),
    last: status.last || null,
    previous: status.previous || null,
  };
}

// ------------------------------------------------------------------ the command

/** `rederive <action>`: status [--order], estimate, start, run, stop, resume, undo, drop. */
export async function rederiveCommand(action, options = {}) {
  const config = await loadConfig();
  if (action === "status") return rederiveStatus(config, { order: options.order === true || options.order === "true" });
  if (action === "estimate") return rederiveEstimate(config);
  if (action === "start") return rederiveStart(config);
  if (action === "run") return rederiveRun(config);
  if (action === "stop") return rederiveStop(config);
  if (action === "resume") return rederiveResume(config);
  if (action === "undo") return rederiveUndo(config);
  if (action === "drop") return rederiveDrop(config);
  return { ok: false, error: `Unknown rederive action: ${action}. Expected status, estimate, start, run, stop, resume, undo or drop.` };
}
