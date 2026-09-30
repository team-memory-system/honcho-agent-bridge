// The subscription gateway, as this repository sees it.
//
// The gateway (chenjingdev/subscription-gateway, AGPL-3.0) turns this
// user's own Codex and Claude logins into one OpenAI-compatible router, and Honcho
// sends every chat model there. It is its own program with its own lifecycle: it
// keeps its own logins, registers its own per-user autostart through its own
// `install`, and runs its own screen, adapters and router. This repository only
// fetches its source, runs its CLI, and reads what the CLI prints. Nothing here
// starts a router or registers anything with the OS.
//
// The CLI contract, one JSON object on stdout per call:
//   install       {"ok":true,"autostart":"launchd"|"windows-run"|"systemd","uiUrl","routerUrl"}
//   status        {"ok":true,"ui":{"url","ok"},"router":{"url","ok"},"autostart":{"kind","installed"},
//                  "accounts":[{"id","backend","loggedIn","serving"}],"models":[...]}
//   connect-info  {"ok":true,"ready":true|false,"baseUrl","apiKey","models":[...],"reason"}
//   open          {"ok":true,"url"}
//   any failure   a non-zero exit and {"ok":false,"error"}
//
// connect-info is the only output that carries a secret. Its apiKey never enters a
// result this module returns (it rides as a non-enumerable property), an error
// message, a log or a command line. The one place it is written is the installed
// private .env.
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { cloneSource, gitAvailable, readSourcePin } from "./source-pin.mjs";

const execFileAsync = promisify(execFile);

export const GATEWAY_SOURCE_PIN = "gateway-source.json";
// Written into the fetched tree. It is how a changed pin is noticed, and how a
// directory this bridge did not fetch is recognised and left alone.
const SOURCE_RECORD = ".honcho-agent-bridge-source.json";
export const DEFAULT_GATEWAY_UI_URL = "http://127.0.0.1:11450";
export const DEFAULT_GATEWAY_ROUTER_URL = "http://127.0.0.1:11400/v1";

// The first of these the gateway offers becomes every chat model.
export const PREFERRED_CHAT_MODELS = Object.freeze([
  "gpt-6-luna",
  "gpt-5.6-luna",
  "gpt-5.5",
  "claude-haiku-4-5",
  "claude-sonnet-5-5",
]);

// Every Honcho setting that makes a chat completion. Embeddings are not among
// them: they stay on Ollama.
export const CHAT_MODEL_PREFIXES = Object.freeze([
  "DERIVER_MODEL_CONFIG",
  "SUMMARY_MODEL_CONFIG",
  "DREAM_DEDUCTION_MODEL_CONFIG",
  "DREAM_INDUCTION_MODEL_CONFIG",
  ...["minimal", "low", "medium", "high", "max"].map((level) => `DIALECTIC_LEVELS__${level}__MODEL_CONFIG`),
]);
export const CHAT_THINKING_EFFORT = "low";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,199}$/;
const EMBEDDING_MODEL = /embed/i;
// The key lands in a .env that Compose both reads and interpolates, so it has to be
// one token with nothing Compose or a shell would reinterpret.
const ROUTER_KEY = /^[A-Za-z0-9._~+\/=-]{16,4096}$/;
const AUTOSTART_KIND = /^[a-z][a-z0-9-]{0,31}$/;
const ACCOUNT_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// A URL inside running text: only characters a URL can hold, and no parentheses,
// so it ends where the sentence goes on. The gateway writes Korean, where a
// particle follows a URL with no space: "화면(http://127.0.0.1:11450)에서".
const URL_IN_TEXT = /https?:\/\/[A-Za-z0-9\-._~:\/?#[\]@!$&*+,;=%]+/gi;

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

async function readJson(target) {
  try { return JSON.parse(await fsp.readFile(target, "utf8")); } catch { return null; }
}

/**
 * Where the gateway lives for an installed server: in the app directory beside
 * runtime/host. Not inside the server bundle, which `server prepare` swaps on every
 * update, and not in the plugin cache, which a plugin update replaces - the
 * gateway's own autostart points at these files.
 */
export function gatewayDirectory(serverDir) {
  return path.join(path.dirname(path.resolve(serverDir)), "runtime", "subscription-gateway");
}

export function gatewayCliPath(directory) {
  return path.join(directory, "gateway", "cli.mjs");
}

/** An http(s) URL on this machine without credentials, or "". */
export function loopbackUrl(value, { keepPath = false } = {}) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { return ""; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !LOOPBACK_HOSTS.has(url.hostname)) return "";
  return `${url.protocol}//${url.host}${keepPath ? url.pathname.replace(/\/+$/, "") : ""}`;
}

function publicPin(pin) {
  return { repo: pin.repo, ref: pin.ref, ...(pin.commit ? { commit: pin.commit } : {}) };
}

function sameSource(record, pin) {
  return record?.repo === pin.repo && record?.ref === pin.ref && (record?.commit || "") === (pin.commit || "");
}

/**
 * What `ensureGatewaySource` would do, without doing it:
 *   current   fetched by this bridge from the pin it names now
 *   stale     fetched by this bridge from another pin, so it will be replaced
 *   missing   not there yet, so it will be fetched
 *   external  there, but not fetched by this bridge: used as it is, never replaced
 */
export async function gatewaySourceProbe({ pinDirectory, directory, runner = execFileAsync } = {}) {
  const present = await exists(directory);
  const record = present ? await readJson(path.join(directory, SOURCE_RECORD)) : null;
  const pin = await readSourcePin(pinDirectory, GATEWAY_SOURCE_PIN);
  const base = {
    directory,
    present,
    ...(pin.ok ? { pin: publicPin(pin) } : {}),
    ...(typeof record?.head === "string" ? { commit: record.head } : {}),
  };
  if (present && !record) return { ...base, state: "external", fetchable: false };
  // A copy fetched earlier still runs; there is only nothing left to compare it with.
  if (!pin.ok) return { ...base, state: present ? "current" : "missing", fetchable: false, reason: pin.reason };
  if (present && sameSource(record, pin)) return { ...base, state: "current", fetchable: false };
  const state = present ? "stale" : "missing";
  if (!(await gitAvailable(runner))) {
    return { ...base, state, fetchable: false, reason: "git is not installed, so the subscription gateway source cannot be fetched" };
  }
  return { ...base, state, fetchable: true };
}

/**
 * Fetch the pinned gateway source into `directory`, or replace a copy fetched from
 * another pin. Idempotent: a current copy is left alone and git is not run.
 *
 * The clone is staged beside the target and renamed into place, so an interrupted
 * fetch never leaves a half-populated tree behind. Before a copy this installer
 * fetched is replaced, its own `gateway/cli.mjs uninstall` runs - through
 * `cliRunner`, with the `env` and `nodePath` the caller installs with - because
 * what it started runs from that folder, and on Windows a running process keeps a
 * folder from being renamed. The replaced copy is then kept as
 * `<directory>.previous` until the next replacement, and the caller installs the
 * new one. If the swap fails after the old copy uninstalled itself, the old copy is
 * put back and its own `install` runs again, best effort, so the gateway keeps
 * serving; the next attempt uninstalls it first again. A copy that is current, or
 * that this installer did not fetch, is never uninstalled.
 *
 * `runner` runs git; `fileSystem` is replaceable so tests can make the swap fail.
 */
export async function ensureGatewaySource({
  pinDirectory,
  directory,
  runner = execFileAsync,
  cliRunner,
  env,
  nodePath,
  fileSystem = fsp,
} = {}) {
  const probe = await gatewaySourceProbe({ pinDirectory, directory, runner });
  if (probe.state === "current" || probe.state === "external") {
    return { ok: true, fetched: false, updated: false, state: probe.state, directory };
  }
  if (!probe.fetchable) return { ok: false, fetched: false, updated: false, state: probe.state, directory, error: probe.reason };
  const staging = `${directory}.fetching`;
  const previous = `${directory}.previous`;
  let commit;
  try {
    await fsp.mkdir(path.dirname(directory), { recursive: true });
    await fsp.rm(staging, { recursive: true, force: true });
    commit = await cloneSource(probe.pin, staging, runner);
    const record = { ...probe.pin, head: commit, fetchedAt: new Date().toISOString() };
    await fsp.writeFile(path.join(staging, SOURCE_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      fetched: false,
      updated: false,
      state: probe.state,
      directory,
      error: String(error?.stderr || "").trim() || error?.message || String(error),
    };
  }
  // Only now that the new copy is on disk is the old one taken down. A failed
  // uninstall does not stop the swap; if the swap fails too, both are reported.
  const uninstall = probe.present && await exists(gatewayCliPath(directory))
    ? await gatewayUninstall({ directory, runner: cliRunner, env, nodePath })
    : null;
  let displaced = false;
  try {
    if (probe.present) {
      await fileSystem.rm(previous, { recursive: true, force: true });
      await fileSystem.rename(directory, previous);
      displaced = true;
    }
    await fileSystem.rename(staging, directory);
  } catch (error) {
    if (displaced && !(await exists(directory))) await fileSystem.rename(previous, directory).catch(() => {});
    await fileSystem.rm(staging, { recursive: true, force: true }).catch(() => {});
    const reasons = [
      `the gateway source could not be put in place (${error?.code || error?.message || error}); a gateway running from ${directory} can hold it open`,
    ];
    if (uninstall && !uninstall.ok) reasons.push(`before that, the old copy's uninstall failed: ${uninstall.error}`);
    // The old copy took itself down for a swap that did not happen: bring it back.
    let restore = null;
    if (uninstall?.ok) {
      restore = (await exists(gatewayCliPath(directory)))
        ? await gatewayInstall({ directory, runner: cliRunner, env, nodePath })
        : { ok: false, error: `the old copy could not be put back at ${directory}` };
      reasons.push(restore.ok
        ? "the old copy had uninstalled itself before the swap and was installed again"
        : `the old copy had uninstalled itself before the swap and could not be installed again: ${restore.error}`);
    }
    return {
      ok: false,
      fetched: false,
      updated: false,
      state: probe.state,
      directory,
      ...(uninstall ? { uninstall } : {}),
      ...(restore ? { restored: restore.ok, ...(restore.ok ? {} : { restoreError: restore.error }) } : {}),
      error: reasons.join("; "),
    };
  }
  return {
    ok: true,
    fetched: !probe.present,
    updated: probe.present,
    state: "current",
    directory,
    ...probe.pin,
    commit,
    ...(displaced ? { previous } : {}),
    ...(uninstall ? { uninstall } : {}),
  };
}

// ------------------------------------------------------------------ the CLI

async function runProcess(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: options.timeout || 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (error) {
    const exited = Number.isInteger(error?.code);
    return {
      code: exited ? error.code : null,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || ""),
      failure: exited ? "" : (error?.killed ? "timed out" : String(error?.code || "could not be started")),
    };
  }
}

function parseDocument(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const lastLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  for (const candidate of [text, lastLine]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

function sanitizeText(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|hch)-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]")
    .replace(URL_IN_TEXT, (match) => {
      // Sentence punctuation after a URL stays with the sentence.
      const [, candidate, trailing] = match.match(/^(.*?)([.,;:!?]*)$/);
      try {
        const url = new URL(candidate);
        // A URL with nothing to strip is left exactly as the sentence wrote it.
        if (!url.username && !url.password && !url.search && !url.hash) return match;
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return `${url.toString()}${trailing}`;
      } catch { return `[redacted-url]${trailing}`; }
    })
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Run one gateway CLI subcommand and return its parsed JSON. What a failed call
 * printed is reduced to its own `error` field; raw output is never passed on,
 * because one of these subcommands prints a key.
 *
 * `runner(command, args, { cwd, env, timeout })` resolves to `{ code, stdout }`
 * whatever the exit status; tests inject one in place of a real process.
 */
export async function runGatewayCli(directory, subcommand, {
  runner = runProcess,
  env = process.env,
  nodePath = process.execPath,
  timeout = 60_000,
} = {}) {
  const cli = gatewayCliPath(directory);
  if (!(await exists(cli))) {
    return {
      ok: false,
      installed: false,
      error: (await exists(directory))
        ? `${directory} has no gateway/cli.mjs`
        : `the subscription gateway is not installed at ${directory}`,
    };
  }
  let result;
  try { result = await runner(nodePath, [cli, subcommand], { cwd: directory, env, timeout }); }
  catch { return { ok: false, installed: true, error: `gateway ${subcommand} could not be run` }; }
  const document = parseDocument(result?.stdout);
  const exitedCleanly = result?.code === 0 || result?.code === undefined;
  if (exitedCleanly && document?.ok === true) return { ok: true, installed: true, document };
  const reported = typeof document?.error === "string" ? sanitizeText(document.error, [document.apiKey]) : "";
  const status = result?.failure || (Number.isInteger(result?.code) ? `exit ${result.code}` : "no exit status");
  return { ok: false, installed: true, error: reported || `gateway ${subcommand} failed (${status}) without saying why` };
}

function autostartKind(value) {
  return typeof value === "string" && AUTOSTART_KIND.test(value) ? value : null;
}

function accountField(value) {
  return typeof value === "string" && ACCOUNT_FIELD.test(value) ? value : null;
}

/** Model ids exactly as the gateway listed them, minus anything unsafe to write into a .env. */
export function modelList(value) {
  if (!Array.isArray(value)) return [];
  const models = new Set();
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (MODEL_ID.test(id)) models.add(id);
    if (models.size >= 500) break;
  }
  return [...models];
}

export async function gatewayInstall({ directory, runner, env, nodePath } = {}) {
  // Installing its npm dependencies is part of it, so it may take minutes.
  const run = await runGatewayCli(directory, "install", { runner, env, nodePath, timeout: 900_000 });
  if (!run.ok) return { ok: false, error: run.error };
  return {
    ok: true,
    autostart: autostartKind(run.document.autostart),
    uiUrl: loopbackUrl(run.document.uiUrl),
    routerUrl: loopbackUrl(run.document.routerUrl, { keepPath: true }),
  };
}

/** `ok` means the router answers, which is what Honcho needs. */
export async function gatewayStatus({ directory, runner, env, nodePath } = {}) {
  const run = await runGatewayCli(directory, "status", { runner, env, nodePath, timeout: 30_000 });
  if (!run.ok) return { ok: false, installed: run.installed, directory, error: run.error };
  const document = run.document;
  const accounts = (Array.isArray(document.accounts) ? document.accounts : []).slice(0, 100).map((account) => ({
    id: accountField(account?.id),
    backend: accountField(account?.backend),
    loggedIn: account?.loggedIn === true,
    serving: account?.serving === true,
  }));
  const router = { url: loopbackUrl(document.router?.url, { keepPath: true }), ok: document.router?.ok === true };
  return {
    ok: router.ok,
    installed: true,
    directory,
    ui: { url: loopbackUrl(document.ui?.url), ok: document.ui?.ok === true },
    router,
    autostart: { kind: autostartKind(document.autostart?.kind), installed: document.autostart?.installed === true },
    loggedIn: accounts.some((account) => account.loggedIn),
    accounts,
    models: modelList(document.models),
  };
}

/**
 * The router address, its key and the models it serves. The key is a
 * non-enumerable `apiKey` property: the caller that writes the private .env can
 * read it, and JSON.stringify, object spread and Object.keys never see it.
 */
export async function gatewayConnectInfo({ directory, runner, env, nodePath } = {}) {
  const run = await runGatewayCli(directory, "connect-info", { runner, env, nodePath, timeout: 60_000 });
  if (!run.ok) return { ok: false, ready: false, error: run.error };
  const document = run.document;
  const apiKey = typeof document.apiKey === "string" ? document.apiKey.trim() : "";
  const models = modelList(document.models);
  const reason = typeof document.reason === "string" ? sanitizeText(document.reason, [apiKey]) : "";
  if (document.ready !== true) {
    return { ok: true, ready: false, models, reason: reason || "no Codex or Claude login is connected in the gateway yet" };
  }
  const baseUrl = loopbackUrl(document.baseUrl, { keepPath: true });
  if (!baseUrl) return { ok: false, ready: false, models, error: "the gateway reported a router address that is not on this machine" };
  if (!ROUTER_KEY.test(apiKey)) return { ok: false, ready: false, models, error: "the gateway did not report a router key this installer can store" };
  const result = { ok: true, ready: true, baseUrl, models, ...(reason ? { reason } : {}) };
  Object.defineProperty(result, "apiKey", { value: apiKey, enumerable: false });
  return result;
}

/**
 * The gateway's own uninstall: its autostart removed and what it started stopped.
 * Its logins and state stay. `stopped` names what it stopped, when it says.
 */
export async function gatewayUninstall({ directory, runner, env, nodePath } = {}) {
  const run = await runGatewayCli(directory, "uninstall", { runner, env, nodePath, timeout: 120_000 });
  if (!run.ok) return { ok: false, error: run.error };
  const stopped = (Array.isArray(run.document.stopped) ? run.document.stopped : [])
    .filter((item) => typeof item === "string" && ACCOUNT_FIELD.test(item))
    .slice(0, 100);
  return { ok: true, stopped };
}

export async function gatewayOpen({ directory, runner, env, nodePath } = {}) {
  const run = await runGatewayCli(directory, "open", { runner, env, nodePath, timeout: 30_000 });
  if (!run.ok) return { ok: false, error: run.error };
  return { ok: true, url: loopbackUrl(run.document.url, { keepPath: true }) };
}

function publicSource(source) {
  if (!source || typeof source !== "object") return null;
  const fields = ["ok", "fetched", "updated", "state", "repo", "ref", "commit", "previous", "uninstall", "restored", "restoreError"];
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/** Fetch or update the gateway source, then run the gateway's own install. */
export async function prepareGateway({
  pinDirectory,
  directory,
  sourceFetcher = ensureGatewaySource,
  runner,
  env,
  nodePath,
} = {}) {
  let source;
  // A copy being replaced is uninstalled with the same runner, environment and node
  // that install the new one.
  try { source = await sourceFetcher({ pinDirectory, directory, cliRunner: runner, env, nodePath }); }
  catch (error) { source = { ok: false, error: error?.message || String(error) }; }
  if (!source?.ok) {
    return {
      ok: false,
      directory,
      source: publicSource(source),
      error: `The subscription gateway source could not be prepared: ${source?.error || "unknown error"}`,
    };
  }
  const installed = await gatewayInstall({ directory, runner, env, nodePath });
  if (!installed.ok) {
    return {
      ok: false,
      directory,
      source: publicSource(source),
      error: `The subscription gateway install failed: ${installed.error}`,
    };
  }
  return {
    ok: true,
    directory,
    source: publicSource(source),
    autostart: installed.autostart,
    uiUrl: installed.uiUrl,
    routerUrl: installed.routerUrl,
  };
}

/** What the user has to do when the gateway has no usable login yet, and where. */
export function gatewayLoginAction(uiUrl, then, reason = "") {
  const url = loopbackUrl(uiUrl, { keepPath: true }) || DEFAULT_GATEWAY_UI_URL;
  return {
    kind: "gateway-login",
    url,
    message: `${reason ? `${reason}. ` : ""}Open ${url} and log in with Codex and/or Claude in the gateway screen, then ${then}.`,
  };
}

// ------------------------------------------------------------- model and .env

/**
 * The chat model for every Honcho chat setting, and where it came from:
 *   override  `requested`, which the gateway has to offer
 *   kept      `installed`, the model the installed .env already uses, while the
 *             gateway still offers it
 *   default   the first of PREFERRED_CHAT_MODELS the gateway offers, otherwise the
 *             first model it lists that is not an embedding model
 * Keeping the installed model is what lets `server start`, which prepares again,
 * keep an earlier --model without being given it again. When nothing it offers can
 * chat, the result is `noChatModel` with a `reason`, not an error: the user has a
 * login to add.
 */
export function chooseChatModel(models, { requested = "", installed = "" } = {}) {
  const offered = modelList(models);
  const wanted = String(requested || "").trim();
  if (wanted) {
    if (offered.includes(wanted)) return { ok: true, model: wanted, source: "override", offered };
    return {
      ok: false,
      offered,
      error: `The gateway does not offer the model "${wanted.slice(0, 200)}". It offers: ${offered.join(", ") || "none yet"}`,
    };
  }
  const current = String(installed || "").trim();
  if (current && offered.includes(current)) return { ok: true, model: current, source: "kept", offered };
  const preferred = PREFERRED_CHAT_MODELS.find((model) => offered.includes(model));
  if (preferred) return { ok: true, model: preferred, source: "default", offered };
  // The router lists what Ollama serves as well, and an embedding model cannot chat.
  const chat = offered.find((model) => !EMBEDDING_MODEL.test(model));
  if (chat) return { ok: true, model: chat, source: "default", offered };
  return {
    ok: false,
    noChatModel: true,
    offered,
    reason: offered.length
      ? `The gateway offers no chat model, only embedding models (${offered.join(", ")})`
      : "The gateway offers no model yet",
  };
}

/** The chat model an installed .env uses now, or "". */
export function installedChatModel(environment = {}) {
  for (const prefix of CHAT_MODEL_PREFIXES) {
    const model = String(environment[`${prefix}__MODEL`] || "").trim();
    if (model) return model;
  }
  return "";
}

/** The router as the Honcho containers reach it. */
export function dockerRouterUrl(routerUrl) {
  const url = new URL(routerUrl);
  url.hostname = "host.docker.internal";
  return url.toString().replace(/\/+$/, "");
}

/**
 * The installed .env values that send every chat model through the gateway's
 * router. Embedding settings are not among them.
 */
export function gatewayEnvironment({ routerUrl, apiKey, model }) {
  if (!loopbackUrl(routerUrl)) throw new Error("The router address must be on this machine");
  if (!ROUTER_KEY.test(String(apiKey || ""))) throw new Error("The router key cannot be stored safely");
  if (!MODEL_ID.test(String(model || ""))) throw new Error("The chat model id cannot be stored safely");
  const baseUrl = dockerRouterUrl(routerUrl);
  const values = { LLM_VLLM_BASE_URL: baseUrl, LLM_VLLM_API_KEY: apiKey };
  for (const prefix of CHAT_MODEL_PREFIXES) {
    values[`${prefix}__TRANSPORT`] = "openai";
    values[`${prefix}__MODEL`] = model;
    values[`${prefix}__THINKING_EFFORT`] = CHAT_THINKING_EFFORT;
    values[`${prefix}__OVERRIDES__BASE_URL`] = baseUrl;
    values[`${prefix}__OVERRIDES__API_KEY_ENV`] = "LLM_VLLM_API_KEY";
  }
  return values;
}
