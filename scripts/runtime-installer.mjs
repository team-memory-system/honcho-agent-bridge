// Getting Docker Desktop and Ollama onto a teammate's computer that has neither.
//
// Ollama is fully the app's: the standalone build from Ollama's GitHub release is
// unpacked into <app home>/runtime/ollama, checked against the release's own
// sha256sum.txt, and run from there. No admin rights are needed, and its models
// stay in Ollama's default model directory (~/.ollama/models).
//
// Docker Desktop needs the user where the OS insists on it:
//   macOS    the Docker.dmg is mounted, its Docker.app is checked (code signature,
//            Docker's Team ID, Gatekeeper) and copied to /Applications. Docker's own
//            first-run screen then asks to accept its terms and, for the recommended
//            settings, the macOS password.
//   Windows  the signed installer runs elevated, so Windows shows its administrator
//            prompt (UAC). WSL 2 may need a restart before the engine can run.
//
// Everything that touches the OS or the network goes through injectable functions
// (run, fetchImpl, launcher, inspector, sleep, which, fileExists), so tests never
// download, mount, copy into /Applications, elevate or start anything.
//
// What the download names and checks rest on (read 2026-10-01):
//   - Ollama docs/macos.mdx: the app's CLI is
//     "<install location>/Ollama.app/Contents/Resources/ollama"; models and config
//     live in ~/.ollama.
//   - Ollama docs/windows.mdx: the installer puts ollama.exe in
//     %LOCALAPPDATA%\Programs\Ollama; the standalone CLI is "ollama-windows-amd64.zip"
//     (arm64: "ollama-windows-arm64.zip", listed in the release assets), and
//     `ollama serve` runs it without the tray app. Models default to
//     %HOMEPATH%\.ollama.
//   - Ollama scripts/build_darwin.sh: ollama-darwin.tgz holds `ollama`, `llama-server`,
//     `llama-quantize`, and the *.so / *.dylib / *.metallib / mlx_metal_v*/ libraries
//     at its top level, so it is unpacked whole and the binary stays beside them.
//   - The release's sha256sum.txt lists "<sha256>  ./<asset>" for every asset,
//     ollama-darwin.tgz and both Windows zips included (v0.35.0 at the time).
//   - Docker docs, "Install Docker Desktop on Mac": the dmgs are
//     https://desktop.docker.com/mac/main/{arm64,amd64}/Docker.dmg, installed at
//     /Applications/Docker.app. No other location is documented, so a failure to
//     write /Applications is reported rather than retried in ~/Applications.
//   - Docker docs, "Install Docker Desktop on Windows": the installers are
//     https://desktop.docker.com/win/main/{amd64,arm64}/Docker%20Desktop%20Installer.exe,
//     `install --accept-license --quiet`, all-users install in
//     C:\Program Files\Docker\Docker; enabling WSL 2 needs admin rights once.
//   - Docker's install pages say "For checksums, see Release notes", but the 4.93.0
//     release notes (2026-09-28) list only per-build download links and no checksum,
//     and the unversioned .../main/... URLs used here have no published checksum at
//     all. So the Docker download is checked by its signature instead: on macOS
//     `codesign --verify --deep --strict`, TeamIdentifier 9BNSXJN65R (Docker Inc)
//     and `spctl -a`; on Windows a Valid Authenticode signature whose signer is
//     Docker Inc.
import { execFile, spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const OLLAMA_DOWNLOAD_BASE = "https://github.com/ollama/ollama/releases/latest/download/";
export const OLLAMA_CHECKSUMS_URL = `${OLLAMA_DOWNLOAD_BASE}sha256sum.txt`;
export const DOCKER_TEAM_ID = "9BNSXJN65R";
export const DOCKER_ENGINE_WAIT_MS = 180_000;

// Docker's terms, as https://docs.docker.com/subscription/desktop-license/ states
// them (read 2026-10-01): Docker Desktop is free for "Small businesses (fewer than
// 250 employees AND less than $10 million in annual revenue)", "Personal use",
// "Education" and "Non-commercial open source projects"; "Professional use in
// larger organizations" and "Government entities" need a paid Pro, Team or
// Business subscription.
export const DOCKER_LICENSE_WARNING = "Docker Desktop is free for personal use, education, non-commercial open source projects and small businesses (fewer than 250 employees and less than $10 million in annual revenue); larger companies and government entities need a paid Docker subscription";

// ------------------------------------------------------------------ helpers

async function defaultRun(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      env: options.env || process.env,
      cwd: options.cwd,
      timeout: options.timeout || 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      resolve({
        code: typeof error.code === "number" ? error.code : -1,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: typeof error.code === "string" ? error.code : String(error.message || error),
      });
    });
  });
}

/**
 * One shape for both runner styles in this repository: host-manager's
 * `{ ok, stdout, stderr }` and share-manager's `{ code, stdout, stderr }`.
 */
async function runCommand(run, command, args, options = {}) {
  let result;
  try { result = await run(command, args, options); }
  catch (error) { return { ok: false, code: -1, stdout: "", stderr: "", error: String(error?.message || error) }; }
  const code = typeof result?.code === "number" ? result.code : (result?.ok === false ? -1 : 0);
  const ok = result?.ok === false ? false : code === 0;
  return {
    ok,
    code,
    stdout: String(result?.stdout || ""),
    stderr: String(result?.stderr || ""),
    error: result?.error ? String(result.error) : "",
  };
}

function firstLine(text) {
  return String(text || "").replace(/\0/g, "").trim().split(/\r?\n/)[0].slice(0, 300);
}

function failureText(result, fallback) {
  return firstLine(result.stderr) || firstLine(result.stdout) || result.error || `${fallback} (exit ${result.code})`;
}

function defaultFileExists(target) {
  try { fs.accessSync(target); return true; } catch { return false; }
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
}

/** The first executable of that name on PATH, or null. */
export function findOnPath(tool, env = process.env, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? [`${tool}.exe`, tool] : [tool];
  const folders = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  for (const folder of folders) {
    for (const name of names) {
      const candidate = path.join(folder, name);
      try {
        fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if (!fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function cpuName(arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "amd64";
  return null;
}

/** Everything the app downloads or owns lives beside the installed server. */
export function runtimeRoot(serverDir) {
  return path.join(path.dirname(path.resolve(serverDir)), "runtime");
}

export function ollamaRuntimeDir(serverDir) {
  return path.join(runtimeRoot(serverDir), "ollama");
}

function ollamaBinaryName(platform) {
  return platform === "win32" ? "ollama.exe" : "ollama";
}

function downloadsDir(root) {
  return path.join(root, "downloads");
}

// ------------------------------------------------------------------ download

/**
 * Stream a URL to `target` through `<target>.part`, renamed only once the body has
 * been read to the end. A failure of any kind removes the .part file and names the
 * URL. The SHA-256 is computed on the way through.
 */
export async function downloadFile({
  url,
  target,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3_600_000,
  idleTimeoutMs = 120_000,
} = {}) {
  const part = `${target}.part`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rm(part, { force: true });
  const controller = new AbortController();
  let idle = null;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error(`no data arrived for ${Math.round(idleTimeoutMs / 1000)} seconds`)), idleTimeoutMs);
  };
  const overall = setTimeout(() => controller.abort(new Error(`it did not finish within ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
  try {
    arm();
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "error"}`);
    if (!response.body) throw new Error("the response had no body");
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const source = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : Readable.from(response.body);
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        arm();
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(source, meter, fs.createWriteStream(part, { flags: "wx", mode: 0o644 }), { signal: controller.signal });
    if (!bytes) throw new Error("the download was empty");
    await fsp.rename(part, target);
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    await fsp.rm(part, { force: true }).catch(() => {});
    const reason = controller.signal.aborted
      ? String(controller.signal.reason?.message || "the download was aborted")
      : String(error?.cause?.code || error?.message || error);
    const wrapped = new Error(`${url} could not be downloaded: ${reason}`);
    wrapped.url = url;
    throw wrapped;
  } finally {
    clearTimeout(idle);
    clearTimeout(overall);
  }
}

async function fetchText(fetchImpl, url, timeoutMs = 60_000) {
  let response;
  try { response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { throw new Error(`${url} could not be downloaded: ${error?.cause?.code || error?.message || error}`); }
  if (!response?.ok) throw new Error(`${url} could not be downloaded: HTTP ${response?.status ?? "error"}`);
  return response.text();
}

/** The SHA-256 a `sha256sum` listing gives for one file name, or "". */
export function checksumFor(listing, name) {
  for (const line of String(listing || "").split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(.+)$/);
    if (match && match[2].trim() === name) return match[1].toLowerCase();
  }
  return "";
}

// ------------------------------------------------------------------ Ollama

/** The standalone Ollama build for this machine, or null when Ollama makes none. */
export function ollamaAsset(platform = process.platform, arch = process.arch) {
  // One universal tgz for Apple Silicon and Intel Macs.
  if (platform === "darwin" && cpuName(arch)) return { name: "ollama-darwin.tgz", archive: "tgz" };
  if (platform === "win32" && cpuName(arch)) return { name: `ollama-windows-${cpuName(arch)}.zip`, archive: "zip" };
  return null;
}

/** What `install-ollama` downloads, or null when there is nothing for this machine. */
export function ollamaDownload({ platform = process.platform, arch = process.arch, ollamaDir } = {}) {
  const asset = ollamaAsset(platform, arch);
  if (!asset) return null;
  return {
    url: `${OLLAMA_DOWNLOAD_BASE}${asset.name}`,
    checksums: OLLAMA_CHECKSUMS_URL,
    asset: asset.name,
    destination: ollamaDir,
    executable: path.join(ollamaDir, ollamaBinaryName(platform)),
  };
}

/**
 * Where an Ollama already is, in the order it is preferred: on PATH, the macOS
 * app's CLI, the Windows installer's copy, then the app's own copy. Nothing is run.
 */
export function locateOllama({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  ollamaDir,
  which = findOnPath,
  fileExists = defaultFileExists,
} = {}) {
  const onPath = which("ollama", env, platform);
  if (onPath) return { path: onPath, source: "path", owned: false };
  const candidates = [];
  if (platform === "darwin") {
    candidates.push("/Applications/Ollama.app/Contents/Resources/ollama");
    candidates.push(path.join(homeDir, "Applications", "Ollama.app", "Contents", "Resources", "ollama"));
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.win32.join(homeDir, "AppData", "Local");
    candidates.push(path.win32.join(local, "Programs", "Ollama", "ollama.exe"));
  }
  for (const candidate of candidates) if (fileExists(candidate)) return { path: candidate, source: "app", owned: false };
  if (ollamaDir) {
    const own = path.join(ollamaDir, ollamaBinaryName(platform));
    if (fileExists(own)) return { path: own, source: "runtime", owned: true };
  }
  return null;
}

function systemTar(platform, env) {
  // bsdtar ships with macOS and with Windows 10 1803 and later, and reads zip too.
  return platform === "win32"
    ? path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "tar.exe")
    : "/usr/bin/tar";
}

/**
 * Download the standalone Ollama, verify it against the release's sha256sum.txt,
 * unpack it whole into `ollamaDir` and prove it runs. Returns the executable.
 */
export async function installOllama({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  ollamaDir,
  fetchImpl = globalThis.fetch,
  run = defaultRun,
  timeoutMs,
  idleTimeoutMs,
} = {}) {
  const planned = ollamaDownload({ platform, arch, ollamaDir });
  if (!planned) return { ok: false, issues: [`This app has no Ollama download for ${platform} on ${arch}`] };
  const root = path.dirname(ollamaDir);
  const archive = path.join(downloadsDir(root), planned.asset);
  const staging = `${ollamaDir}.extracting-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const cleanup = async () => {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(archive, { force: true }).catch(() => {});
  };

  let expected;
  try { expected = checksumFor(await fetchText(fetchImpl, planned.checksums), planned.asset); }
  catch (error) { return { ok: false, issues: [`Ollama's checksum list: ${error.message}`] }; }
  if (!expected) return { ok: false, issues: [`${planned.checksums} does not list ${planned.asset}, so the download cannot be verified`] };

  let download;
  try { download = await downloadFile({ url: planned.url, target: archive, fetchImpl, timeoutMs, idleTimeoutMs }); }
  catch (error) { return { ok: false, issues: [`Ollama: ${error.message}`] }; }
  if (download.sha256 !== expected) {
    await cleanup();
    return {
      ok: false,
      issues: [`The downloaded ${planned.asset} does not match the SHA-256 in ${planned.checksums}; it was deleted. Run prepare again.`],
    };
  }

  try {
    await fsp.mkdir(staging, { recursive: true });
    const args = planned.asset.endsWith(".tgz") ? ["-xzf", archive, "-C", staging] : ["-xf", archive, "-C", staging];
    const extracted = await runCommand(run, systemTar(platform, env), args, { env, timeout: 900_000 });
    if (!extracted.ok) throw new Error(`${planned.asset} could not be unpacked: ${failureText(extracted, "tar failed")}`);
    const stagedBinary = path.join(staging, ollamaBinaryName(platform));
    if (!(await exists(stagedBinary))) throw new Error(`${planned.asset} has no ${ollamaBinaryName(platform)} at its top level`);
    if (platform !== "win32") await fsp.chmod(stagedBinary, 0o755);
    const probed = await runCommand(run, stagedBinary, ["--version"], { env, timeout: 30_000 });
    if (!probed.ok) throw new Error(`The downloaded Ollama did not run (ollama --version): ${failureText(probed, "no output")}`);
    const version = (`${probed.stdout}\n${probed.stderr}`.match(/(\d+\.\d+\.\d+[^\s]*)/) || [])[1] || "unknown";
    await fsp.rm(ollamaDir, { recursive: true, force: true });
    await fsp.rename(staging, ollamaDir);
    const receipt = {
      asset: planned.asset,
      url: planned.url,
      sha256: download.sha256,
      bytes: download.bytes,
      version,
      installedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(ollamaDir, "honcho-agent-bridge-install.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    await fsp.rm(archive, { force: true }).catch(() => {});
    return {
      ok: true,
      executable: planned.executable,
      version,
      action: {
        type: "install-ollama",
        url: planned.url,
        destination: ollamaDir,
        executable: planned.executable,
        bytes: download.bytes,
        sha256: download.sha256,
        verified: `SHA-256 matches ${planned.asset} in ${planned.checksums}`,
        version,
        changed: true,
      },
    };
  } catch (error) {
    await cleanup();
    return { ok: false, issues: [String(error?.message || error)] };
  }
}

// ------------------------------------------------------------------ Docker

/** What `install-docker-desktop` downloads and where Docker Desktop ends up. */
export function dockerDesktopDownload({ platform = process.platform, arch = process.arch, env = process.env, runtimeDir } = {}) {
  const cpu = cpuName(arch);
  if (!cpu) return null;
  const folder = runtimeDir ? downloadsDir(runtimeDir) : "";
  if (platform === "darwin") {
    return {
      url: `https://desktop.docker.com/mac/main/${cpu}/Docker.dmg`,
      download: folder ? path.join(folder, "Docker.dmg") : "Docker.dmg",
      destination: "/Applications/Docker.app",
      app: "/Applications/Docker.app",
    };
  }
  if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    return {
      url: `https://desktop.docker.com/win/main/${cpu}/Docker%20Desktop%20Installer.exe`,
      download: folder ? path.join(folder, "Docker Desktop Installer.exe") : "Docker Desktop Installer.exe",
      destination: path.win32.join(programFiles, "Docker", "Docker"),
      app: path.win32.join(programFiles, "Docker", "Docker", "Docker Desktop.exe"),
    };
  }
  return null;
}

/**
 * The docker CLI to run: the one on PATH, else the one Docker Desktop ships.
 * Docker Desktop links its CLI into /usr/local/bin (or ~/.docker/bin) only during
 * its first run, and an app started from the Finder does not see a shell's PATH,
 * so the app's own copy is what works right after the install. Synchronous, so a
 * synchronous caller can use it too.
 */
export function resolveDockerCli({
  platform = process.platform,
  env = process.env,
  homeDir = env.HOME || env.USERPROFILE || os.homedir(),
  which = findOnPath,
  fileExists = defaultFileExists,
} = {}) {
  const onPath = which("docker", env, platform);
  if (onPath) return { path: onPath, source: "path" };
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(
      "/usr/local/bin/docker",
      path.join(homeDir, ".docker", "bin", "docker"),
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      path.join(homeDir, "Applications", "Docker.app", "Contents", "Resources", "bin", "docker"),
    );
  }
  if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const local = env.LOCALAPPDATA || path.win32.join(homeDir, "AppData", "Local");
    candidates.push(
      path.win32.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe"),
      path.win32.join(local, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
    );
  }
  for (const candidate of candidates) if (fileExists(candidate)) return { path: candidate, source: "docker-desktop" };
  return null;
}

/**
 * The environment a docker call runs with. A CLI that is not on PATH gets its own
 * folder put first on PATH, so the credential helpers beside it are found too.
 */
export function dockerPathEnvironment(cli, env = process.env, platform = process.platform) {
  const result = { ...env };
  if (!cli || cli.source === "path") return result;
  const key = pathKey(result);
  const delimiter = platform === "win32" ? ";" : ":";
  const folder = (platform === "win32" ? path.win32 : path).dirname(cli.path);
  const current = String(result[key] || "");
  if (!current.split(delimiter).includes(folder)) result[key] = current ? `${folder}${delimiter}${current}` : folder;
  return result;
}

/** Start Docker Desktop detached. The first run is started in front, for its dialog. */
export function launchDockerDesktop(app, platform = process.platform, { foreground = false, spawnImpl = nodeSpawn } = {}) {
  const [command, args] = platform === "darwin"
    ? ["/usr/bin/open", foreground ? ["-a", app] : ["-g", "-a", app]]
    : [app, []];
  const child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child?.on?.("error", () => {});
  child?.unref?.();
}

function firstRunMarker(runtimeDir) {
  return path.join(runtimeDir, "docker-desktop", "first-run.json");
}

/** True while Docker Desktop was installed by the app and its engine has not answered yet. */
export async function dockerFirstRunPending(runtimeDir) {
  return exists(firstRunMarker(runtimeDir));
}

export async function clearDockerFirstRun(runtimeDir) {
  await fsp.rm(firstRunMarker(runtimeDir), { force: true }).catch(() => {});
}

async function markDockerFirstRun(runtimeDir, app) {
  const marker = firstRunMarker(runtimeDir);
  await fsp.mkdir(path.dirname(marker), { recursive: true });
  await fsp.writeFile(marker, `${JSON.stringify({ app, installedAt: new Date().toISOString() })}\n`);
}

export function dockerFirstRunAction(app, platform = process.platform) {
  const steps = platform === "darwin"
    ? "In the Docker Desktop window, accept Docker's terms and choose the recommended settings (macOS asks for your password)"
    : "In the Docker Desktop window, accept Docker's terms and finish its first-run steps";
  return {
    kind: "docker-first-run",
    app,
    message: `${steps}, wait until Docker Desktop says the engine is running, then run prepare again.`,
  };
}

export function restartRequiredAction(reason = "") {
  return {
    kind: "restart-required",
    message: `${reason ? `${reason}. ` : ""}Restart Windows to finish setting up WSL 2 for Docker Desktop, then open the app and run prepare again.`,
  };
}

function approvalDeclinedAction() {
  return {
    kind: "docker-install-approval",
    message: "Windows asked for administrator approval to install Docker Desktop and it was not given. Run prepare again and choose Yes in the Windows prompt.",
  };
}

/** Poll the engine for a bounded time. */
export async function waitForDockerEngine({
  inspector,
  timeoutMs = DOCKER_ENGINE_WAIT_MS,
  pollMs = 3_000,
  sleep = defaultSleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = await inspector();
  while (!latest.running && Date.now() < deadline) {
    await sleep(pollMs);
    latest = await inspector();
  }
  return latest;
}

async function verifyMacApp(run, app) {
  const verified = await runCommand(run, "/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 600_000 });
  if (!verified.ok) return { ok: false, reason: `its code signature did not verify: ${failureText(verified, "codesign failed")}` };
  const described = await runCommand(run, "/usr/bin/codesign", ["-dv", "--verbose=2", app], { timeout: 60_000 });
  if (!described.ok || !`${described.stdout}\n${described.stderr}`.includes(`TeamIdentifier=${DOCKER_TEAM_ID}`)) {
    return { ok: false, reason: `it is not signed by Docker Inc (Team ID ${DOCKER_TEAM_ID})` };
  }
  const assessed = await runCommand(run, "/usr/sbin/spctl", ["-a", "-t", "exec", "-vv", app], { timeout: 120_000 });
  if (!assessed.ok || !`${assessed.stdout}\n${assessed.stderr}`.includes(`(${DOCKER_TEAM_ID})`)) {
    return { ok: false, reason: `Gatekeeper (spctl) did not accept it: ${failureText(assessed, "spctl failed")}` };
  }
  return {
    ok: true,
    verified: `codesign --verify --deep --strict passed, TeamIdentifier=${DOCKER_TEAM_ID} (Docker Inc), spctl -a accepted it; Docker publishes no checksum for this download`,
  };
}

function powershellPath(env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function verifyWindowsInstaller(run, env, installer) {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(installer)}; Write-Output ([string]$s.Status); Write-Output ([string]$s.SignerCertificate.Subject)`;
  const checked = await runCommand(run, powershellPath(env), ["-NoProfile", "-NonInteractive", "-Command", script], { env, timeout: 120_000 });
  const [status = "", subject = ""] = checked.stdout.replace(/\0/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!checked.ok || status !== "Valid") return { ok: false, reason: `its Authenticode signature is not valid (${status || failureText(checked, "no status")})` };
  if (!/(?:^|,\s*)O="?Docker Inc\b/i.test(subject)) return { ok: false, reason: `it is signed by ${subject || "an unknown signer"}, not Docker Inc` };
  return { ok: true, verified: `Authenticode signature Valid, signer ${subject}; Docker publishes no checksum for this download` };
}

/** The elevated install command. UAC is the user's click. */
export function windowsDockerInstallCommand(installer, env = process.env) {
  return {
    command: powershellPath(env),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Start-Process -FilePath ${psQuote(installer)} -ArgumentList 'install','--accept-license','--quiet' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
    ],
  };
}

// Windows Installer's own "success, restart needed" codes.
const RESTART_EXIT_CODES = new Set([3010, 1641]);

/**
 * Download Docker Desktop, check its signature, install it, and start it. The
 * engine is not waited for here: `prepareRuntime` downloads Ollama meanwhile, which
 * is time the user spends in Docker's first-run window.
 */
export async function installDockerDesktop({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  runtimeDir,
  fetchImpl = globalThis.fetch,
  run = defaultRun,
  launcher = launchDockerDesktop,
  tmpDir = os.tmpdir(),
  timeoutMs,
  idleTimeoutMs,
  // What is checked and removed in /Applications. Tests always replace both.
  pathExists = exists,
  removeApp = (target) => fsp.rm(target, { recursive: true, force: true }),
} = {}) {
  const planned = dockerDesktopDownload({ platform, arch, env, runtimeDir });
  if (!planned) return { ok: false, issues: [`Docker Desktop has no download for ${platform} on ${arch}`] };
  let download;
  try { download = await downloadFile({ url: planned.url, target: planned.download, fetchImpl, timeoutMs, idleTimeoutMs }); }
  catch (error) { return { ok: false, issues: [`Docker Desktop: ${error.message}`] }; }
  const base = { type: "install-docker-desktop", url: planned.url, destination: planned.destination, bytes: download.bytes, sha256: download.sha256 };
  const discard = () => fsp.rm(planned.download, { force: true }).catch(() => {});

  if (platform === "darwin") {
    const mount = await fsp.mkdtemp(path.join(tmpDir, "honcho-docker-dmg-"));
    const attached = await runCommand(run, "/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, planned.download], { timeout: 600_000 });
    if (!attached.ok) {
      await fsp.rm(mount, { recursive: true, force: true }).catch(() => {});
      await discard();
      return { ok: false, issues: [`The Docker Desktop disk image could not be opened (hdiutil attach): ${failureText(attached, "hdiutil failed")}`] };
    }
    let outcome;
    try {
      const source = path.join(mount, "Docker.app");
      const signature = await verifyMacApp(run, source);
      if (!signature.ok) {
        outcome = { ok: false, issues: [`The downloaded Docker Desktop was not installed because ${signature.reason}`] };
      } else if (await pathExists(planned.destination)) {
        // Installed meanwhile by someone else: used as it is.
        outcome = { ok: true, verified: signature.verified, copied: false };
      } else {
        const copied = await runCommand(run, "/usr/bin/ditto", [source, planned.destination], { timeout: 1_800_000 });
        if (copied.ok) outcome = { ok: true, verified: signature.verified, copied: true };
        else if (/Permission denied|Operation not permitted|EACCES|EPERM/i.test(`${copied.stderr}\n${copied.stdout}\n${copied.error}`)) {
          outcome = {
            ok: false,
            issues: ["Docker Desktop could not be copied into /Applications: this macOS account may not write there (only administrators can), and Docker Desktop documents no other install location. Sign in as an administrator, or ask one to install Docker Desktop, then run prepare again."],
          };
        } else {
          // Nothing was there before this copy, so a half-copied app is removed
          // rather than later taken for an installed Docker Desktop.
          await Promise.resolve(removeApp(planned.destination)).catch(() => {});
          outcome = { ok: false, issues: [`Docker Desktop could not be copied into /Applications (ditto): ${failureText(copied, "ditto failed")}`] };
        }
      }
    } finally {
      const detached = await runCommand(run, "/usr/bin/hdiutil", ["detach", mount], { timeout: 120_000 });
      if (!detached.ok) await runCommand(run, "/usr/bin/hdiutil", ["detach", "-force", mount], { timeout: 120_000 });
      await fsp.rm(mount, { recursive: true, force: true }).catch(() => {});
    }
    await discard();
    if (!outcome.ok) return outcome;
    await markDockerFirstRun(runtimeDir, planned.app);
    launcher(planned.app, platform, { foreground: true });
    return { ok: true, app: planned.app, action: { ...base, verified: outcome.verified, installed: outcome.copied, launched: true, changed: outcome.copied } };
  }

  // Windows.
  const signature = await verifyWindowsInstaller(run, env, planned.download);
  if (!signature.ok) {
    await discard();
    return { ok: false, issues: [`The downloaded Docker Desktop installer was not run because ${signature.reason}`] };
  }
  const invocation = windowsDockerInstallCommand(planned.download, env);
  const installed = await runCommand(run, invocation.command, invocation.args, { env, timeout: 3_600_000 });
  const action = { ...base, verified: signature.verified, elevated: true, exitCode: installed.code };
  if (!installed.ok && !RESTART_EXIT_CODES.has(installed.code)) {
    if (/cancel+ed by the user/i.test(`${installed.stderr}\n${installed.stdout}\n${installed.error}`)) {
      return { ok: true, ready: false, action: { ...action, changed: false }, nextAction: approvalDeclinedAction() };
    }
    await discard();
    return { ok: false, issues: [`Docker Desktop's installer failed with exit code ${installed.code}: ${failureText(installed, "no output")}`] };
  }
  await discard();
  await markDockerFirstRun(runtimeDir, planned.app);
  if (RESTART_EXIT_CODES.has(installed.code)) {
    return { ok: true, ready: false, app: planned.app, action: { ...action, changed: true }, nextAction: restartRequiredAction("Docker Desktop's installer asked for a restart") };
  }
  const wsl = await runCommand(run, "wsl.exe", ["--status"], { env, timeout: 60_000 });
  const wslText = `${wsl.stdout}\n${wsl.stderr}`.replace(/\0/g, "");
  if (!wsl.ok || /restart|reboot/i.test(wslText)) {
    return {
      ok: true,
      ready: false,
      app: planned.app,
      action: { ...action, changed: true, wsl: "not ready" },
      nextAction: restartRequiredAction(wsl.ok ? "WSL reports that it needs a restart" : "WSL 2 is not ready yet"),
    };
  }
  launcher(planned.app, platform, { foreground: true });
  return { ok: true, app: planned.app, action: { ...action, launched: true, changed: true } };
}

// ------------------------------------------------------------------ both

/**
 * Run the plan's `install-docker-desktop` and `install-ollama` operations: Docker
 * first (so its first-run window is up while Ollama downloads), then Ollama, then a
 * bounded wait for the Docker engine. Nothing else is changed.
 */
export async function prepareRuntime({
  operations = [],
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  runtimeDir,
  fetchImpl = globalThis.fetch,
  run = defaultRun,
  launcher = launchDockerDesktop,
  dockerInspector,
  engineTimeoutMs = DOCKER_ENGINE_WAIT_MS,
  enginePollMs = 3_000,
  sleep = defaultSleep,
  tmpDir,
  timeoutMs,
  idleTimeoutMs,
  dockerInstaller = installDockerDesktop,
  ollamaInstaller = installOllama,
  dockerInstallOptions = {},
} = {}) {
  const actions = [];
  const wantsDocker = operations.some((item) => item.type === "install-docker-desktop");
  const ollamaOperation = operations.find((item) => item.type === "install-ollama");
  let dockerApp = "";
  if (wantsDocker) {
    const docker = await dockerInstaller({ platform, arch, env, runtimeDir, fetchImpl, run, launcher, tmpDir, timeoutMs, idleTimeoutMs, ...dockerInstallOptions });
    if (docker.action) actions.push(docker.action);
    if (!docker.ok) return { ok: false, ready: false, actions, issues: docker.issues };
    if (docker.nextAction) return { ok: true, ready: false, actions, nextAction: docker.nextAction, next: docker.nextAction.message };
    dockerApp = docker.app;
  }
  let ollamaExecutable = "";
  if (ollamaOperation) {
    const ollama = await ollamaInstaller({
      platform,
      arch,
      env,
      ollamaDir: ollamaOperation.destination,
      fetchImpl,
      run,
      timeoutMs,
      idleTimeoutMs,
    });
    if (!ollama.ok) return { ok: false, ready: false, actions, issues: ollama.issues };
    actions.push(ollama.action);
    ollamaExecutable = ollama.executable;
  }
  if (wantsDocker) {
    const engine = await waitForDockerEngine({ inspector: dockerInspector, timeoutMs: engineTimeoutMs, pollMs: enginePollMs, sleep });
    if (!engine.running) {
      const nextAction = dockerFirstRunAction(dockerApp, platform);
      return { ok: true, ready: false, actions, nextAction, next: nextAction.message, ...(ollamaExecutable ? { ollamaExecutable } : {}) };
    }
    await clearDockerFirstRun(runtimeDir);
    actions.push({ type: "docker-engine", running: true });
  }
  return { ok: true, ready: true, actions, ...(ollamaExecutable ? { ollamaExecutable } : {}) };
}
