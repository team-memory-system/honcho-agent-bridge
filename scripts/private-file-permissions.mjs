import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const SID_PATTERN = /^S-\d+(?:-\d+){2,}$/i;

async function defaultRun(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      env: options.env || process.env,
      timeout: options.timeout || 10_000,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

async function runChecked(runner, command, args, options) {
  try {
    const result = await runner(command, args, options);
    if (result?.ok === false) return { ok: false, stdout: "" };
    return { ok: true, stdout: String(result?.stdout || "") };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else field += character;
  }
  fields.push(field);
  return fields.map((item) => item.trim());
}

function currentIdentity(stdout, expectedUsername) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const fields = parseCsvLine(line.trim());
    const sid = fields.find((item) => SID_PATTERN.test(item));
    if (!sid) continue;
    const account = fields[0] || "";
    const username = account.split("\\").at(-1);
    if (username?.toLocaleLowerCase("en-US") !== expectedUsername.toLocaleLowerCase("en-US")) return null;
    return { account, sid: sid.toUpperCase() };
  }
  return null;
}

/**
 * Restrict a secret-bearing file to the current Windows user, LocalSystem, and
 * the built-in Administrators group. Numerical SIDs avoid localized group
 * names. The reset removes pre-existing explicit ACEs; inheritance removal and
 * the three grants are then applied together.
 */
export async function securePrivateFile(target, {
  platform = process.platform,
  env = process.env,
  run = defaultRun,
} = {}) {
  if (platform !== "win32") {
    await fsp.chmod(target, 0o600).catch(() => {});
    return { ok: true, method: "posix-mode" };
  }

  const expectedUsername = String(env.USERNAME || "").trim();
  if (!expectedUsername) throw new Error("Unable to secure private file on Windows: USERNAME is unavailable");
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || env.WINDIR || "").trim();
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Unable to secure private file on Windows: Windows system directory is unavailable");
  }
  const whoami = path.win32.join(systemRoot, "System32", "whoami.exe");
  const icacls = path.win32.join(systemRoot, "System32", "icacls.exe");

  const identityResult = await runChecked(run, whoami, ["/user", "/fo", "csv", "/nh"], {
    env,
    timeout: 10_000,
  });
  const identity = identityResult.ok ? currentIdentity(identityResult.stdout, expectedUsername) : null;
  if (!identity) throw new Error("Unable to secure private file on Windows: current user SID could not be identified");

  const reset = await runChecked(run, icacls, [target, "/reset", "/q"], { env, timeout: 10_000 });
  if (!reset.ok) throw new Error("Unable to secure private file on Windows: ACL reset failed");

  const restricted = await runChecked(run, icacls, [
    target,
    "/inheritancelevel:r",
    "/grant:r",
    `*${identity.sid}:F`,
    `*${SYSTEM_SID}:F`,
    `*${ADMINISTRATORS_SID}:F`,
    "/q",
  ], { env, timeout: 10_000 });
  if (!restricted.ok) throw new Error("Unable to secure private file on Windows: ACL restriction failed");

  return { ok: true, method: "windows-acl", userSid: identity.sid };
}
