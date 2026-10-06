// What a computer needs before setup, for the features chosen on it.
//
// Two features:
//   server  the memory server runs here (Docker and Ollama).
//   sync    this computer's agent conversations go to the user's server.
// The start screen asks for both when the server goes on this computer, and for
// sync alone when the server is on another of the user's computers.
//
// Everyone needs Node (this runs in it) and Git (the plugin marketplace install and
// `server prepare` both clone with it).
//
// checkPrereqs installs and starts nothing: each check runs one short read-only
// command through an injectable `run`, and a missing program is `ok: false`, never
// a throw.
//
// macOS: /usr/bin/git is a stub until the Command Line Tools are installed, and
// running it then opens Apple's install dialog. So when the git found is that stub,
// `xcode-select -p` (which opens nothing) is asked first.
import fs from "node:fs";
import os from "node:os";

import { dockerProbe, installedServerDir } from "./server-manager.mjs";
import {
  defaultRun,
  findOnPath,
  locateOllama,
  ollamaRuntimeDir,
  resolveDockerCli,
  runCommand,
} from "./runtime-installer.mjs";

export const FEATURES = Object.freeze(["server", "sync"]);
export const MIN_NODE_MAJOR = 18;
const COMMAND_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 10_000;
const MAC_STUB_GIT = "/usr/bin/git";

/**
 * `"server,sync"` (or an array) as a list of known features, each once.
 * Anything else is returned in `invalid` so the caller can refuse it.
 */
export function parseFeatures(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const features = [];
  const invalid = [];
  for (const item of raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)) {
    if (!FEATURES.includes(item)) invalid.push(item);
    else if (!features.includes(item)) features.push(item);
  }
  return { features, invalid };
}

function defaultFileExists(target) {
  try { fs.accessSync(target); return true; } catch { return false; }
}

function firstMatch(text, pattern) {
  const match = pattern.exec(String(text || ""));
  return match ? match[1] : "";
}

/** A short, plain value from a program's output, safe to show on a screen. */
function plain(value, max = 100) {
  return typeof value === "string" ? value.replace(/[^\p{L}\p{N} ._@-]/gu, "").trim().slice(0, max) : "";
}

function hasBrew({ platform, env, which, fileExists }) {
  if (platform !== "darwin") return false;
  return Boolean(which("brew", env, platform)) || fileExists("/opt/homebrew/bin/brew") || fileExists("/usr/local/bin/brew");
}

// ------------------------------------------------------------------ node

function nodeItem({ platform, nodeVersion, brew }) {
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  const install = { url: "https://nodejs.org/ko/download" };
  if (platform === "win32") install.command = "winget install --id OpenJS.NodeJS.LTS -e";
  else if (platform === "darwin" && brew) install.command = "brew install node";
  return {
    key: "node",
    label: "Node.js",
    needed: "required",
    ok,
    version: String(nodeVersion),
    detail: ok
      ? `Node.js ${nodeVersion} 사용 중입니다.`
      : `Node.js ${nodeVersion}: 버전이 너무 낮습니다. ${MIN_NODE_MAJOR} 이상이 필요합니다.`,
    install,
  };
}

// ------------------------------------------------------------------ git

function gitInstall(platform) {
  if (platform === "darwin") {
    return {
      url: "https://git-scm.com/download/mac",
      command: "xcode-select --install",
      note: "Command Line Tools 설치 창이 뜨면 '설치'를 누르세요. 끝나면 다시 확인하세요.",
    };
  }
  if (platform === "win32") {
    return {
      url: "https://git-scm.com/download/win",
      command: "winget install --id Git.Git -e",
      note: "설치한 뒤 이 앱과 터미널을 다시 열어야 Git이 PATH에 잡힙니다.",
    };
  }
  return { url: "https://git-scm.com/download/linux" };
}

async function gitItem({ platform, env, run, which }) {
  const base = { key: "git", label: "Git", needed: "required" };
  const install = gitInstall(platform);
  const missing = (detail) => ({ ...base, ok: false, detail, install });
  const found = which("git", env, platform);
  if (platform === "darwin") {
    if (!found) return missing("Git이 없습니다. 플러그인 설치와 서버 준비가 Git으로 소스를 내려받습니다.");
    if (found === MAC_STUB_GIT) {
      const tools = await runCommand(run, "xcode-select", ["-p"], { env, timeout: COMMAND_TIMEOUT_MS });
      if (!tools.ok) return missing("macOS의 Git은 Command Line Tools가 있어야 동작하는데, 아직 설치되어 있지 않습니다.");
    }
  }
  const result = await runCommand(run, found || "git", ["--version"], { env, timeout: GIT_TIMEOUT_MS });
  const version = firstMatch(result.stdout, /git version (\S+)/);
  if (!result.ok || !version) return missing("Git이 없거나 실행되지 않습니다. 플러그인 설치와 서버 준비가 Git으로 소스를 내려받습니다.");
  return { ...base, ok: true, version, detail: `Git ${version} 설치되어 있습니다.`, install };
}

// ------------------------------------------------------------------ docker

/** The app installs Docker Desktop and Ollama on macOS and Windows only. */
function appInstalls(platform) {
  return platform === "darwin" || platform === "win32";
}

function dockerInstall(platform) {
  if (platform === "darwin") {
    return {
      url: "https://docs.docker.com/desktop/setup/install/mac-install/",
      note: "서버 준비 단계에서 앱이 Docker Desktop을 내려받아 설치합니다. 첫 실행 때 Docker 약관 동의와 macOS 암호를 물어봅니다. 직원 250명 이상이거나 연매출 1천만 달러 이상인 회사는 Docker 유료 구독이 필요합니다.",
    };
  }
  if (platform === "win32") {
    return {
      url: "https://docs.docker.com/desktop/setup/install/windows-install/",
      note: "서버 준비 단계에서 앱이 Docker Desktop을 설치합니다. Windows가 관리자 승인을 묻고, WSL 2 때문에 재시작이 필요할 수 있습니다. 직원 250명 이상이거나 연매출 1천만 달러 이상인 회사는 Docker 유료 구독이 필요합니다.",
    };
  }
  return { url: "https://docs.docker.com/engine/install/", note: "Docker Engine과 Compose 플러그인을 직접 설치하세요." };
}

/** dockerProbe's exec: resolves with {stdout}, rejects on a non-zero exit. */
function execThrough(run) {
  return async (command, args, options = {}) => {
    const result = await runCommand(run, command, args, { ...options, timeout: options.timeout || COMMAND_TIMEOUT_MS });
    if (result.ok) return { stdout: result.stdout, stderr: result.stderr };
    const error = new Error(result.stderr.trim() || result.error || `${command} exited with ${result.code}`);
    error.stderr = result.stderr.trim() || result.error;
    throw error;
  };
}

async function dockerItem({ platform, env, run, which, fileExists, dockerInspector }) {
  const managed = appInstalls(platform);
  const base = { key: "docker", label: "Docker", needed: managed ? "app-installs" : "required" };
  const install = dockerInstall(platform);
  let probe;
  try {
    probe = await dockerInspector({
      platform,
      env,
      resolver: (options) => resolveDockerCli({ ...options, which, fileExists }),
      exec: execThrough(run),
    });
  } catch (error) {
    probe = { installed: false, running: false, error: String(error?.message || error) };
  }
  if (probe.running) {
    const version = plain(probe.composeVersion, 40);
    return {
      ...base,
      ok: true,
      ...(version ? { version } : {}),
      detail: `Docker 엔진이 응답합니다${version ? ` (Compose ${version})` : ""}.`,
      install,
    };
  }
  const detail = probe.installed
    ? managed
      ? "Docker는 설치되어 있지만 엔진이 응답하지 않습니다. 서버 준비 단계에서 앱이 Docker Desktop을 시작합니다."
      : "Docker는 설치되어 있지만 엔진이 응답하지 않습니다. Docker 엔진을 시작하세요."
    : managed
      ? "Docker Desktop이 없습니다. 서버 준비 단계에서 앱이 설치합니다."
      : "Docker가 없습니다. 이 운영체제에서는 직접 설치해야 합니다.";
  return { ...base, ok: false, detail, install };
}

// ------------------------------------------------------------------ ollama

function ollamaInstall(platform) {
  if (platform === "darwin") return { url: "https://ollama.com/download/mac", note: "서버 준비 단계에서 앱이 공식 릴리스를 내려받아 설치합니다. 관리자 권한은 필요 없습니다." };
  if (platform === "win32") return { url: "https://ollama.com/download/windows", note: "서버 준비 단계에서 앱이 공식 릴리스를 내려받아 설치합니다. 관리자 권한은 필요 없습니다." };
  return { url: "https://ollama.com/download/linux", command: "curl -fsSL https://ollama.com/install.sh | sh" };
}

const OLLAMA_SOURCE = Object.freeze({ path: "PATH", app: "Ollama 앱", runtime: "이 앱이 설치한 사본" });

async function ollamaItem({ platform, env, run, which, fileExists, homeDir, serverDir }) {
  const managed = appInstalls(platform);
  const base = { key: "ollama", label: "Ollama", needed: managed ? "app-installs" : "required" };
  const install = ollamaInstall(platform);
  const found = locateOllama({ platform, env, homeDir, ollamaDir: ollamaRuntimeDir(serverDir), which, fileExists });
  if (!found) {
    return {
      ...base,
      ok: false,
      detail: managed ? "Ollama가 없습니다. 서버 준비 단계에서 앱이 설치합니다." : "Ollama가 없습니다. 직접 설치하세요.",
      install,
    };
  }
  const result = await runCommand(run, found.path, ["--version"], { env, timeout: COMMAND_TIMEOUT_MS });
  const version = firstMatch(`${result.stdout}\n${result.stderr}`, /(\d+\.\d+\.\d+[\w.-]*)/);
  return {
    ...base,
    ok: true,
    ...(version ? { version } : {}),
    detail: `Ollama${version ? ` ${version}` : ""} 설치되어 있습니다 (${OLLAMA_SOURCE[found.source] || found.source}).`,
    install,
  };
}

// ------------------------------------------------------------------ all

/**
 * What this computer has and lacks for `features`. The top-level `ok` is true
 * when every `required` item is ok; "app-installs" items are installed by server
 * prepare when missing.
 */
export async function checkPrereqs({
  features = [],
  platform = process.platform,
  arch = process.arch,
  run = defaultRun,
  env = process.env,
  which = findOnPath,
  fileExists = defaultFileExists,
  homeDir = env.HONCHO_AGENT_BRIDGE_USER_HOME || env.HOME || env.USERPROFILE || os.homedir(),
  serverDir = installedServerDir(),
  nodeVersion = process.versions.node,
  dockerInspector = dockerProbe,
} = {}) {
  const parsed = parseFeatures(features);
  if (parsed.invalid.length) throw new TypeError(`unknown feature: ${parsed.invalid.join(", ")} (expected ${FEATURES.join(", ")})`);
  const chosen = new Set(parsed.features);
  const brew = hasBrew({ platform, env, which, fileExists });
  const context = { platform, env, run, which, fileExists, brew, homeDir, serverDir, dockerInspector };

  const checks = [nodeItem({ platform, nodeVersion, brew }), gitItem(context)];
  if (chosen.has("server")) checks.push(dockerItem(context), ollamaItem(context));
  const items = await Promise.all(checks);
  return {
    ok: items.every((item) => item.needed !== "required" || item.ok),
    platform,
    arch,
    features: parsed.features,
    items,
  };
}
