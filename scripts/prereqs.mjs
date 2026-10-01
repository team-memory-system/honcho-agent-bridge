// What a computer needs before setup, for the features chosen on it, and the one
// program installed from here for the user: Cloudflare WARP.
//
// A computer takes any combination of three features:
//   server  the memory server runs here (Docker and Ollama).
//   sync    this computer's agent conversations go to the user's server.
//   chat    ask a teammate's shared bridge.
//
// Everyone needs Node (this runs in it) and Git (the plugin marketplace install and
// `server prepare` both clone with it). Every feature also needs Cloudflare WARP,
// joined to the team and connected: the team's servers and shared bridges are
// reached through it. `remote` is still accepted, for older callers, but no longer
// changes what is needed.
//
// checkPrereqs installs and starts nothing: each check runs one short read-only
// command through an injectable `run`, and a missing program is `ok: false`, never
// a throw.
//
// macOS: /usr/bin/git is a stub until the Command Line Tools are installed, and
// running it then opens Apple's install dialog. So when the git found is that stub,
// `xcode-select -p` (which opens nothing) is asked first.
//
// WARP: `warp-cli -j status` gives {status, reason}; `warp-cli -j registration show`
// gives {id, device_id, public_key, account: {type, id, organization}, ...}. Only
// status, account.type and account.organization are read; the identifiers never
// leave this module.
//
// installWarp (`prereqs install warp`) gets WARP onto this computer. The only
// thing the user sees is the OS's own password or approval prompt; nothing here
// runs sudo or holds a password. What it rests on (checked 2026-10-01):
//   macOS    https://downloads.cloudflareclient.com/v1/download/macos/ga redirects
//            to the current pkg (2026.7.1376.0, 153 MB). `pkgutil --check-signature`
//            on it reports "signed by a developer certificate issued by Apple for
//            distribution" with the leaf "1. Developer ID Installer: Cloudflare Inc.
//            (68WVV388M8)". Only with that signature is the pkg, saved in
//            ~/Downloads, installed: osascript's `do shell script ... with
//            administrator privileges` shows macOS's password dialog and runs
//            `installer -pkg <pkg> -target /`. The path reaches the script as an
//            argument and the shell through `quoted form of`, never spliced into
//            either. Cancelling the dialog is error -128. Without a dialog to show
//            (no GUI session, Apple events refused) the pkg is opened in macOS's
//            Installer instead (`open`), which asks for the password itself.
//   Windows  .../download/windows/ga redirects to the current msi. Only with a
//            Valid Authenticode signature by Cloudflare is it run as
//            `msiexec /i <msi> /qn /norestart` through a "runas" start, so UAC is
//            the only prompt. Declining UAC is Win32 error 1223; msiexec's 3010
//            is installed, restart needed. When elevation cannot be started at
//            all, `msiexec /i` opens its own wizard instead.
//   Linux    not installed here: Cloudflare publishes a package repository.
// A download that fails its signature check is deleted and never opened. A
// finished install deletes the installer; a cancelled one keeps it.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dockerProbe, installedServerDir } from "./server-manager.mjs";
import {
  defaultRun,
  downloadFile,
  findOnPath,
  locateOllama,
  ollamaRuntimeDir,
  resolveDockerCli,
  runCommand,
} from "./runtime-installer.mjs";

export const FEATURES = Object.freeze(["server", "sync", "chat"]);
export const MIN_NODE_MAJOR = 18;
const COMMAND_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 10_000;
const MAC_STUB_GIT = "/usr/bin/git";

const WARP_DOWNLOAD_URL = "https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/warp/download-warp/";
const WARP_JOIN_NOTE = "설치한 뒤 `warp-cli registration new <팀 이름>`으로 팀에 가입하고(브라우저에서 로그인), `warp-cli connect`로 연결하세요.";

// The official installers, as installWarp downloads and checks them.
export const WARP_INSTALLERS = Object.freeze({
  darwin: Object.freeze({ url: "https://downloads.cloudflareclient.com/v1/download/macos/ga", file: "Cloudflare_WARP.pkg" }),
  win32: Object.freeze({ url: "https://downloads.cloudflareclient.com/v1/download/windows/ga", file: "Cloudflare_WARP.msi" }),
});
const CLOUDFLARE_TEAM_ID = "68WVV388M8";
const SILENT_INSTALL_TIMEOUT_MS = 600_000;
const MAC_PASSWORD_PROMPT = "팀 메모리가 Cloudflare WARP를 설치하려고 합니다.";
const WARP_INSTALLED_MESSAGE = Object.freeze({
  darwin: "Cloudflare WARP를 설치했습니다. 다음은 팀에 가입하는 단계입니다. macOS가 VPN 구성을 추가해도 되는지 물으면 '허용'을 누르세요.",
  win32: "Cloudflare WARP를 설치했습니다. 다음은 팀에 가입하는 단계입니다.",
});
const WARP_RESTART_MESSAGE = "Cloudflare WARP를 설치했습니다. Windows를 다시 시작해야 설치가 끝납니다. 다시 시작한 뒤 팀에 가입하는 단계로 넘어갑니다.";
const WARP_CANCELLED_MESSAGE = Object.freeze({
  darwin: "설치를 취소했습니다. 다시 하려면 '설치'를 한 번 더 누르거나 에이전트에게 다시 설치해 달라고 한 뒤, 암호 창에 Mac 암호를 넣으세요.",
  win32: "설치를 취소했습니다. 다시 하려면 '설치'를 한 번 더 누르거나 에이전트에게 다시 설치해 달라고 한 뒤, Windows가 변경을 허용할지 물으면 '예'를 누르세요.",
});
// The wizard, when the silent install could not ask for the password or approval.
const WARP_INSTALLER_MESSAGE = Object.freeze({
  darwin: "Cloudflare WARP 설치 창을 열었습니다. 창에서 '계속'과 '설치'를 차례로 누르고, Mac 암호를 물으면 넣어서 설치를 끝내세요. 끝나면 에이전트에게 알려 주세요. 이 앱에서는 '다시 확인'을 누르면 됩니다.",
  win32: "Cloudflare WARP 설치 창을 열었습니다. 창의 안내대로 설치를 진행하고, Windows가 변경을 허용할지 물으면 '예'를 눌러 설치를 끝내세요. 끝나면 에이전트에게 알려 주세요. 이 앱에서는 '다시 확인'을 누르면 됩니다.",
});

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

function parseJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
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

// ------------------------------------------------------------------ warp

function warpInstall({ platform, brew }) {
  const install = { url: WARP_DOWNLOAD_URL };
  // `prereqs install warp` (installWarp) can put it on this computer.
  if (Object.hasOwn(WARP_INSTALLERS, platform)) install.auto = true;
  if (platform === "darwin" && brew) install.command = "brew install --cask cloudflare-warp";
  if (platform === "win32") install.command = "winget install --id Cloudflare.Warp -e";
  install.note = WARP_JOIN_NOTE;
  return install;
}

function locateWarpCli({ platform, env, which, fileExists }) {
  const onPath = which("warp-cli", env, platform);
  if (onPath) return onPath;
  const candidates = [];
  if (platform === "darwin" || platform === "linux") candidates.push("/usr/local/bin/warp-cli");
  if (platform === "win32") {
    candidates.push(path.win32.join(env.ProgramFiles || "C:\\Program Files", "Cloudflare", "Cloudflare WARP", "warp-cli.exe"));
  }
  return candidates.find((candidate) => fileExists(candidate)) || null;
}

async function warpItem({ needed, platform, env, run, which, fileExists, brew }) {
  const base = { key: "warp", label: "Cloudflare WARP", needed };
  const install = warpInstall({ platform, brew });
  const cli = locateWarpCli({ platform, env, which, fileExists });
  if (!cli) return { ...base, ok: false, detail: "Cloudflare WARP가 설치되어 있지 않습니다.", install };
  const options = { env, timeout: COMMAND_TIMEOUT_MS };
  const [statusResult, registrationResult, versionResult] = await Promise.all([
    runCommand(run, cli, ["-j", "status"], options),
    runCommand(run, cli, ["-j", "registration", "show"], options),
    runCommand(run, cli, ["--version"], options),
  ]);
  const version = firstMatch(versionResult.stdout, /(\d+(?:\.\d+)+)/);
  const withVersion = version ? { version } : {};
  const registration = registrationResult.ok ? parseJson(registrationResult.stdout) : null;
  const account = registration && typeof registration.account === "object" ? registration.account : null;
  const team = account?.type === "team" ? plain(account.organization) : "";
  if (account?.type !== "team") {
    return {
      ...base,
      ok: false,
      ...withVersion,
      detail: "WARP는 설치되어 있지만 팀(Cloudflare Zero Trust)에 등록되어 있지 않습니다.",
      install,
    };
  }
  const label = team || "(이름 없음)";
  const status = statusResult.ok ? parseJson(statusResult.stdout) : null;
  const state = plain(status?.status, 40);
  if (state !== "Connected") {
    return {
      ...base,
      ok: false,
      ...withVersion,
      detail: `팀 ${label}에 등록되어 있지만 연결되어 있지 않습니다${state ? ` (상태: ${state})` : ""}. \`warp-cli connect\`로 연결하세요.`,
      install,
    };
  }
  return { ...base, ok: true, ...withVersion, detail: `팀 ${label}에 연결되어 있습니다.`, install };
}

// ------------------------------------------------------------------ all

/**
 * What this computer has and lacks for `features`. WARP is required for any
 * feature; `remote` (sync to a server on another computer) is accepted and echoed
 * back but changes nothing. The top-level `ok` is true when every `required` item
 * is ok; "app-installs" items are installed by server prepare when missing.
 */
export async function checkPrereqs({
  features = [],
  remote = false,
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
  if (chosen.size) checks.push(warpItem({ ...context, needed: "required" }));
  const items = await Promise.all(checks);
  return {
    ok: items.every((item) => item.needed !== "required" || item.ok),
    platform,
    arch,
    features: parsed.features,
    remote: remote === true,
    items,
  };
}

// ------------------------------------------------------------------ warp install

function firstLine(text) {
  return String(text || "").replace(/\0/g, "").trim().split(/\r?\n/)[0].slice(0, 200);
}

function powershellPath(env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** The pkg's signer, as pkgutil reports it: Apple-issued, Cloudflare's Team ID. */
async function verifyWarpPkg(run, env, file) {
  const checked = await runCommand(run, "/usr/sbin/pkgutil", ["--check-signature", file], { env, timeout: 120_000 });
  const text = `${checked.stdout}\n${checked.stderr}`;
  const signer = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^1\.\s/.test(line)) || "";
  if (!checked.ok) return { ok: false, reason: `pkgutil: ${firstLine(checked.stdout) || firstLine(checked.stderr) || checked.error || `exit ${checked.code}`}` };
  if (!/Status: signed by a developer certificate issued by Apple/.test(text)) return { ok: false, reason: "Apple이 발급한 인증서로 서명되지 않았습니다" };
  if (!signer.includes("Developer ID Installer: Cloudflare") || !signer.includes(`(${CLOUDFLARE_TEAM_ID})`)) {
    return { ok: false, reason: `서명한 곳: ${signer.replace(/^1\.\s*/, "").slice(0, 120) || "알 수 없음"}` };
  }
  return { ok: true, verified: `pkgutil --check-signature: ${signer.replace(/^1\.\s*/, "")}` };
}

/** The msi's Authenticode signature: Valid, and signed by Cloudflare. */
async function verifyWarpMsi(run, env, file) {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; Write-Output ([string]$s.Status); Write-Output ([string]$s.SignerCertificate.Subject)`;
  const checked = await runCommand(run, powershellPath(env), ["-NoProfile", "-NonInteractive", "-Command", script], { env, timeout: 120_000 });
  const [status = "", subject = ""] = checked.stdout.replace(/\0/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!checked.ok || status !== "Valid") return { ok: false, reason: `서명 상태: ${status || firstLine(checked.stderr) || checked.error || "알 수 없음"}` };
  if (!/(?:^|,\s*)(?:CN|O)="?Cloudflare\b/i.test(subject)) return { ok: false, reason: `서명한 곳: ${subject.slice(0, 120) || "알 수 없음"}` };
  return { ok: true, verified: `Authenticode Valid: ${subject}` };
}

/**
 * Hand a checked installer to the OS's own wizard: macOS's Installer through
 * `open` (which returns once the window is up), or `msiexec /i` on Windows, left
 * running on its own since it lasts as long as the install does. The fallback for
 * when the silent install cannot ask for the password or approval.
 */
export function openInstaller(file, { platform = process.platform, env = process.env, spawnImpl = nodeSpawn } = {}) {
  const windows = platform === "win32";
  const command = windows ? msiexecPath(env) : "/usr/bin/open";
  const args = windows ? ["/i", file] : [file];
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(command, args, { detached: windows, stdio: "ignore", env }); }
    catch (error) { resolve({ ok: false, error: String(error?.message || error) }); return; }
    child.once("error", (error) => resolve({ ok: false, error: String(error?.message || error) }));
    if (windows) {
      child.once("spawn", () => { child.unref?.(); resolve({ ok: true }); });
    } else {
      child.once("exit", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `open exited with ${code}` }));
    }
  });
}

function msiexecPath(env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "msiexec.exe");
}

/**
 * osascript's arguments for the silent macOS install. The pkg path is argv's
 * first item: AppleScript never parses it, and `quoted form of` hands it to the
 * shell as one single-quoted word.
 */
export function macInstallArgs(file) {
  return [
    "-e", "on run argv",
    "-e", `do shell script "/usr/sbin/installer -pkg " & quoted form of (item 1 of argv) & " -target /" with prompt "${MAC_PASSWORD_PROMPT}" with administrator privileges`,
    "-e", "end run",
    file,
  ];
}

// A "runas" start failed before msiexec ran; the Win32 error code follows.
const START_FAILED = "start-failed";

/**
 * PowerShell that starts `msiexec /i <msi> /qn /norestart` elevated, waits, and
 * exits with msiexec's code. Process.Start is used rather than Start-Process so a
 * refused start keeps its Win32 code (1223 when UAC is declined) whatever the
 * Windows display language. Windows paths cannot hold a double quote, so quoting
 * the path for msiexec's command line is safe; psQuote covers PowerShell.
 */
export function windowsInstallScript(file, env = process.env) {
  return [
    "$i = New-Object System.Diagnostics.ProcessStartInfo",
    `$i.FileName = ${psQuote(msiexecPath(env))}`,
    `$i.Arguments = ${psQuote(`/i "${file}" /qn /norestart`)}`,
    "$i.Verb = 'runas'",
    "$i.UseShellExecute = $true",
    `try { $p = [System.Diagnostics.Process]::Start($i) } catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; Write-Output ('${START_FAILED} ' + [string]$e.NativeErrorCode + ' ' + $e.Message); exit 1 }`,
    "$p.WaitForExit()",
    "exit $p.ExitCode",
  ].join("; ");
}

// Only what the program printed: `error` repeats the command line, script included.
function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`.replace(/\0/g, "");
}

/**
 * The silent install: macOS's password dialog or Windows's UAC prompt, and
 * nothing else. `{ outcome: "installed" | "restart" | "cancelled" | "unavailable"
 * | "failed", reason }`; "unavailable" means the prompt could not be shown, so
 * the wizard is the way.
 */
async function silentInstall(run, env, platform, file) {
  if (platform === "darwin") {
    const result = await runCommand(run, "/usr/bin/osascript", macInstallArgs(file), { env, timeout: SILENT_INSTALL_TIMEOUT_MS });
    if (result.ok) return { outcome: "installed" };
    const text = outputOf(result);
    if (/\(-128\)|User cancel+ed/i.test(text)) return { outcome: "cancelled" };
    return { outcome: "unavailable", reason: firstLine(result.stderr) || firstLine(result.stdout) || result.error || `osascript exit ${result.code}` };
  }
  const result = await runCommand(run, powershellPath(env), ["-NoProfile", "-NonInteractive", "-Command", windowsInstallScript(file, env)], { env, timeout: SILENT_INSTALL_TIMEOUT_MS });
  const started = new RegExp(`^${START_FAILED} (-?\\d*) ?(.*)$`, "m").exec(result.stdout.replace(/\0/g, ""));
  if (started) {
    if (started[1] === "1223") return { outcome: "cancelled" };
    return { outcome: "unavailable", reason: `elevation ${started[1] || "?"}: ${started[2].trim().slice(0, 200)}` };
  }
  // PowerShell itself would not start (spawn's own error code, no output).
  if (!result.ok && result.code === -1 && /^E[A-Z]+$/.test(result.error) && !result.stdout.trim()) {
    return { outcome: "unavailable", reason: `powershell: ${result.error}` };
  }
  if (result.code === 0) return { outcome: "installed" };
  if (result.code === 3010 || result.code === 1641) return { outcome: "restart" };
  if (result.code === 1223 || result.code === 1602) return { outcome: "cancelled" };
  return { outcome: "failed", reason: result.code === -1 ? "설치가 10분 안에 끝나지 않았거나 멈췄습니다" : `msiexec 종료 코드 ${result.code}` };
}

/**
 * Put Cloudflare WARP on this computer: download the official installer, check
 * that Cloudflare signed it, and install it behind the OS's password or approval
 * prompt. Already installed is `{ ok, installed: true, changed: false }`; a
 * finished install is `installed: true, changed: true` with the team join as its
 * `nextAction`; a declined prompt is `{ ok: false, cancelled: true }`. When no
 * prompt can be shown, the wizard opens: `installed: false, changed: true`.
 */
export async function installWarp({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  run = defaultRun,
  fetchImpl = globalThis.fetch,
  which = findOnPath,
  fileExists = defaultFileExists,
  homeDir = env.HONCHO_AGENT_BRIDGE_USER_HOME || env.HOME || env.USERPROFILE || os.homedir(),
  downloadDir = path.join(homeDir, "Downloads"),
  opener = openInstaller,
  timeoutMs = 1_500_000,
  idleTimeoutMs = 120_000,
} = {}) {
  const base = { item: "warp", platform, arch };
  const cli = locateWarpCli({ platform, env, which, fileExists });
  if (cli) return { ok: true, ...base, installed: true, changed: false, detail: "Cloudflare WARP가 이미 설치되어 있습니다." };
  const installer = WARP_INSTALLERS[platform];
  if (!installer) {
    return {
      ok: false,
      ...base,
      installed: false,
      changed: false,
      url: WARP_DOWNLOAD_URL,
      error: `이 운영체제에서는 앱이 Cloudflare WARP를 설치하지 않습니다. Cloudflare 안내(${WARP_DOWNLOAD_URL})대로 Cloudflare 패키지 저장소를 추가해서 직접 설치하세요.`,
    };
  }
  const file = path.join(downloadDir, installer.file);
  let download;
  try { download = await downloadFile({ url: installer.url, target: file, fetchImpl, timeoutMs, idleTimeoutMs }); }
  catch (error) {
    return { ok: false, ...base, installed: false, changed: false, error: `Cloudflare WARP 설치 파일을 내려받지 못했습니다: ${error.message}` };
  }
  const signature = platform === "darwin" ? await verifyWarpPkg(run, env, file) : await verifyWarpMsi(run, env, file);
  if (!signature.ok) {
    await fsp.rm(file, { force: true }).catch(() => {});
    return {
      ok: false,
      ...base,
      installed: false,
      changed: false,
      error: `내려받은 파일이 Cloudflare가 서명한 설치 파일인지 확인되지 않아 지웠고, 설치하지 않았습니다 (${signature.reason}).`,
    };
  }
  const checked = { bytes: download.bytes, sha256: download.sha256, verified: signature.verified };

  const silent = await silentInstall(run, env, platform, file);
  if (silent.outcome === "installed" || silent.outcome === "restart") {
    await fsp.rm(file, { force: true }).catch(() => {});
    const restart = silent.outcome === "restart";
    const found = locateWarpCli({ platform, env, which, fileExists });
    return {
      ok: true,
      ...base,
      installed: true,
      changed: true,
      method: "silent",
      cli: found,
      ...(restart ? { restartRequired: true } : {}),
      ...checked,
      nextAction: { kind: "warp-team-join", message: restart ? WARP_RESTART_MESSAGE : WARP_INSTALLED_MESSAGE[platform] },
    };
  }
  if (silent.outcome === "cancelled") {
    return { ok: false, ...base, installed: false, changed: false, cancelled: true, file, error: WARP_CANCELLED_MESSAGE[platform] };
  }
  if (silent.outcome === "failed") {
    return { ok: false, ...base, installed: false, changed: false, file, error: `Cloudflare WARP를 설치하지 못했습니다 (${silent.reason}). 다시 해 보고, 같으면 내려받은 파일을 직접 열어서 설치하세요: ${file}` };
  }

  // The prompt could not be shown here: the OS's own wizard asks instead.
  let opened;
  try { opened = await opener(file, { platform, env }); }
  catch (error) { opened = { ok: false, error: String(error?.message || error) }; }
  if (opened?.ok === false) {
    return {
      ok: false,
      ...base,
      installed: false,
      changed: false,
      file,
      silentError: silent.reason,
      error: `설치 창을 열지 못했습니다 (${opened.error || "알 수 없는 이유"}). 내려받은 파일을 직접 열어서 설치하세요: ${file}`,
    };
  }
  return {
    ok: true,
    ...base,
    installed: false,
    changed: true,
    method: "wizard",
    file,
    silentError: silent.reason,
    ...checked,
    nextAction: { kind: "warp-installer", message: WARP_INSTALLER_MESSAGE[platform] },
  };
}
