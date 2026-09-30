// A pin file names the repository a missing source tree is fetched from.
//
// Two trees arrive this way: the Honcho server (honcho-source.json) and the
// subscription gateway (gateway-source.json). Both live in their own AGPL
// repositories, which is why this package carries neither. The pin's values are
// handed to git on a command line, so none of them is taken on trust.
import fsp from "node:fs/promises";
import path from "node:path";

const SOURCE_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/;
// A leading "-" would read as a git option.
const SOURCE_REF = /^(?!-)[A-Za-z0-9._\/-]{1,128}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;

export async function readSourcePin(directory, fileName) {
  const pinPath = path.join(directory, fileName);
  let raw;
  try { raw = await fsp.readFile(pinPath, "utf8"); }
  catch { return { ok: false, path: pinPath, reason: "no source pin is bundled" }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, path: pinPath, reason: `${fileName} is not valid JSON` }; }
  const repo = String(parsed?.repo || "").trim();
  const ref = String(parsed?.ref || "").trim();
  const commit = String(parsed?.commit || "").trim();
  if (!SOURCE_URL.test(repo)) return { ok: false, path: pinPath, reason: `${fileName} needs an https repository URL` };
  if (!SOURCE_REF.test(ref)) return { ok: false, path: pinPath, reason: `${fileName} needs a branch or tag in "ref"` };
  if (commit && !SOURCE_COMMIT.test(commit)) return { ok: false, path: pinPath, reason: `${fileName} "commit" must be a full 40-character hash` };
  return { ok: true, path: pinPath, repo, ref, ...(commit ? { commit } : {}) };
}

export async function gitAvailable(runner) {
  try { await runner("git", ["--version"], { timeout: 10_000 }); return true; }
  catch { return false; }
}

/**
 * Clone the pinned source into `target` and normally drop its history. Honcho
 * wrappers retain Git until their upstream submodule has been materialized.
 * Returns the commit
 * that was checked out. The caller owns `target`: it is a staging path, renamed
 * into place only once this has succeeded.
 */
export async function cloneSource(pin, target, runner, { keepGit = false } = {}) {
  const clone = ["clone", "--branch", pin.ref, "--single-branch"];
  if (!pin.commit) clone.push("--depth", "1");
  clone.push(pin.repo, target);
  await runner("git", clone, { timeout: 900_000 });
  if (pin.commit) await runner("git", ["-C", target, "checkout", "--detach", pin.commit], { timeout: 120_000 });
  const { stdout } = await runner("git", ["-C", target, "rev-parse", "HEAD"], { timeout: 30_000 });
  if (!keepGit) await fsp.rm(path.join(target, ".git"), { recursive: true, force: true });
  return String(stdout || "").trim();
}
