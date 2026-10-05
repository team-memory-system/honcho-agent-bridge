// Where the conversation backup writes: a folder (an external drive, a NAS share or
// any folder) or a cloud reached through rclone. Both write under <destination>/대화.
//
// A destination that cannot be reached right now (the drive is not mounted, the
// cloud is not authorised, rclone is missing) answers probe() with ok:false, and
// the backup then writes nothing anywhere: it never falls back to the internal disk.
// Neither store ever deletes: a move relocates a file, a copy adds or replaces one.
//
// rclone runs as a child process with its own configuration; nothing here reads,
// prints or passes that configuration or its tokens.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const ROOT_FOLDER = "대화";
const RCLONE_REMOTE = /^[A-Za-z0-9_][A-Za-z0-9_ .+@-]{0,63}$/;
const DEFAULT_TPS_LIMIT = 4;
// Moves by Drive file id go to rclone in calls of at most this many pairs and this
// long a command line, counted as Windows counts it (its limit is 32,767).
export const MOVE_BATCH_PAIRS = 100;
export const MOVE_BATCH_CHARS = 24_000;

/** md5 of a whole file, as Google Drive and rclone report it. */
export async function md5OfFile(filePath) {
  const hash = crypto.createHash("md5");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function cleanRelative(rel) {
  const parts = String(rel).split("/");
  if (!rel || parts.some((part) => !part || part === "." || part === "..")) throw new Error(`not a destination path: ${rel}`);
  return parts.join("/");
}

// ------------------------------------------------------------------ folder

/** The nearest folder at or above `target` that is the root of a mounted volume. */
export async function volumeRootOf(target) {
  let current = path.resolve(target);
  let stat = await fsp.stat(current);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    const parentStat = await fsp.stat(parent);
    if (parentStat.dev !== stat.dev) return current;
    current = parent;
    stat = parentStat;
  }
}

async function isMountPoint(target) {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  if (parent === resolved) return true;
  try {
    const [own, above] = await Promise.all([fsp.stat(resolved), fsp.stat(parent)]);
    return own.isDirectory() && own.dev !== above.dev;
  } catch {
    return false;
  }
}

/**
 * A folder destination. `volumeRoot`, recorded when the folder was chosen, is the
 * mount point it lives on (/Volumes/NAS, say): when that is no longer a mount
 * point, the drive is gone even if an empty folder of the same name is left on
 * the internal disk.
 */
export function folderStore({ folder, volumeRoot = null }) {
  const base = path.resolve(String(folder || ""));
  const root = path.join(base, ROOT_FOLDER);
  const full = (rel) => path.join(root, ...cleanRelative(rel).split("/"));
  return {
    kind: "folder",
    label: root,
    async probe() {
      if (!folder || !path.isAbsolute(String(folder))) return { ok: false, reason: "not-absolute" };
      if (volumeRoot && path.resolve(volumeRoot) !== path.parse(base).root && !(await isMountPoint(volumeRoot))) {
        return { ok: false, reason: "not-mounted" };
      }
      let stat;
      try { stat = await fsp.stat(base); } catch { return { ok: false, reason: "missing" }; }
      if (!stat.isDirectory()) return { ok: false, reason: "not-directory" };
      try { await fsp.access(base, fs.constants.W_OK); } catch { return { ok: false, reason: "not-writable" }; }
      return { ok: true };
    },
    /** Files in each folder (relative to 대화/) with their sizes; below it too for one in `recursive`. */
    async list(dirs, { recursive = new Set() } = {}) {
      const files = new Map();
      const existingDirs = new Set();
      const walk = async (dir, deep) => {
        let entries;
        try { entries = await fsp.readdir(full(dir), { withFileTypes: true }); } catch { return; }
        existingDirs.add(dir);
        for (const entry of entries) {
          if (entry.isDirectory() && deep) await walk(`${dir}/${entry.name}`, deep);
          if (!entry.isFile() || entry.name.includes(".backup-tmp-")) continue;
          const stat = await fsp.stat(path.join(full(dir), entry.name)).catch(() => null);
          if (stat) files.set(`${dir}/${entry.name}`, { size: stat.size });
        }
      };
      for (const dir of dirs) await walk(dir, recursive.has(dir));
      return { files, dirs: existingDirs };
    },
    md5(rel) {
      return md5OfFile(full(rel));
    },
    async mkdir(rel) {
      await fsp.mkdir(full(rel), { recursive: true });
    },
    /** Byte-exact copy through a temporary name beside the target, then a rename over it. */
    async copy(localPath, rel) {
      const target = full(rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.backup-tmp-${process.pid}`);
      try {
        await fsp.copyFile(localPath, temporary, fs.constants.COPYFILE_FICLONE);
        await fsp.rename(temporary, target);
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
    async move(fromRel, toRel) {
      const target = full(toRel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(full(fromRel), target);
    },
  };
}

// ------------------------------------------------------------------ rclone

/** rclone on PATH or in the usual install places; launchd and the Task Scheduler start with a short PATH. */
export function locateRclone(env = process.env, platform = process.platform) {
  if (env.RCLONE_BIN && fs.existsSync(env.RCLONE_BIN)) return env.RCLONE_BIN;
  const name = platform === "win32" ? "rclone.exe" : "rclone";
  const directories = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  if (platform === "win32") {
    directories.push(path.join(env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"), "C:\\Program Files\\rclone", path.join(env.USERPROFILE || "", "scoop", "shims"), path.join(env.USERPROFILE || "", ".local", "bin"));
  } else {
    directories.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin", path.join(env.HOME || "", ".local", "bin"));
  }
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

/** Runs rclone; always resolves {code, stdout, stderr}. */
export function runRclone(binary, args, { timeoutMs = 600_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    const out = [];
    const err = [];
    let errBytes = 0;
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (errBytes < 1024 * 1024) { err.push(chunk); errBytes += chunk.length; }
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(error?.message || error) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? -1 : 0), stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

const SECRET_IN_TEXT = [
  /ya29\.[\w.-]+/g,
  /("?(?:access_token|refresh_token|client_secret|token|password|pass)"?\s*[:=]\s*)("[^"]*"|\S+)/gi,
];

/** One short line from rclone's stderr, with anything that looks like a credential taken out. */
export function rcloneMessage(result, fallback = "rclone failed") {
  const lines = String(result?.stderr || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((item) => /\b(ERROR|CRITICAL|Failed|NOTICE: Failed)\b/.test(item)) || lines.at(-1) || `${fallback} (exit ${result?.code})`;
  let text = line.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/, "").slice(0, 300);
  for (const pattern of SECRET_IN_TEXT) text = text.replace(pattern, (match, key) => (key ? `${key}[redacted]` : "[redacted]"));
  return text;
}

/**
 * The length of the command line Windows gets for this argv: each argument quoted
 * the way Node (libuv) quotes it, at most, and one space between them.
 */
export function windowsCommandLineLength(argv) {
  return argv.reduce((total, arg) => {
    const text = String(arg);
    const quoted = text && !/[ \t"]/.test(text) ? text.length : text.length + 2 + (text.match(/["\\]/g) || []).length;
    return total + quoted + 1;
  }, -1);
}

/**
 * Splits id/destination pairs into rclone calls of at most `maxPairs` pairs whose
 * whole command line (`fixed` plus the pairs) stays within `maxChars`.
 */
export function chunkMovePairs(pairs, { fixed = [], maxPairs = MOVE_BATCH_PAIRS, maxChars = MOVE_BATCH_CHARS } = {}) {
  const base = windowsCommandLineLength(fixed);
  const batches = [];
  let current = [];
  let length = base;
  for (const pair of pairs) {
    const added = windowsCommandLineLength([pair.id, pair.dest]) + 1;
    if (current.length && (current.length >= maxPairs || length + added > maxChars)) {
      batches.push(current);
      current = [];
      length = base;
    }
    current.push(pair);
    length += added;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function parseCloudDestination(value) {
  const text = String(value || "").trim();
  const colon = text.indexOf(":");
  if (colon <= 0) return null;
  const remote = text.slice(0, colon);
  const folder = text.slice(colon + 1).replace(/^\/+|\/+$/g, "");
  if (!RCLONE_REMOTE.test(remote)) return null;
  if (folder && folder.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return { remote, path: folder };
}

/**
 * A cloud destination through an rclone remote. `run(args, options)` is injectable
 * for tests and defaults to the rclone found on this computer.
 */
export function rcloneStore({ remote, path: folder = "", run, env = process.env, tpsLimit = DEFAULT_TPS_LIMIT }) {
  const baseSpec = `${remote}:${folder ? `${folder}/` : ""}`;
  const root = `${baseSpec}${ROOT_FOLDER}`;
  const at = (rel) => `${root}/${cleanRelative(rel)}`;
  const binary = run ? "rclone" : locateRclone(env);
  const invoke = run || ((args, options) => runRclone(binary, args, { ...options, env }));
  const common = ["--tpslimit", String(tpsLimit), "--drive-stop-on-upload-limit"];
  let driveCheck = null;

  async function must(args, what, options) {
    const result = await invoke([...args, ...common], options);
    if (result.code !== 0) throw new Error(`${what}: ${rcloneMessage(result, what)}`);
    return result;
  }

  function parseListing(stdout, prefix, files, dirs) {
    let rows;
    try { rows = JSON.parse(stdout || "[]"); } catch { throw new Error("rclone lsjson returned something that is not JSON"); }
    for (const row of rows) {
      const rel = prefix ? `${prefix}/${row.Path}` : row.Path;
      if (row.IsDir) dirs.add(rel);
      else {
        files.set(rel, { size: Number(row.Size), md5: row.Hashes?.md5 || row.Hashes?.MD5 || undefined, ...(row.ID ? { id: row.ID } : {}) });
        const parent = rel.split("/").slice(0, -1).join("/");
        if (parent) dirs.add(parent);
      }
    }
  }

  return {
    kind: "cloud",
    label: root,
    async probe() {
      if (!binary) return { ok: false, reason: "rclone-missing" };
      const remotes = await invoke(["listremotes"], { timeoutMs: 30_000 });
      if (remotes.code !== 0) return { ok: false, reason: "rclone-failed", detail: rcloneMessage(remotes, "rclone listremotes") };
      const names = remotes.stdout.split(/\r?\n/).map((line) => line.trim().replace(/:$/, "")).filter(Boolean);
      if (!names.includes(remote)) return { ok: false, reason: "remote-missing" };
      const probe = await invoke(["lsf", "--max-depth", "1", "--dirs-only", baseSpec, ...common], { timeoutMs: 120_000 });
      // 3 is "directory not found": the remote answers, and the folder is made on the first copy.
      if (probe.code !== 0 && probe.code !== 3) return { ok: false, reason: "unauthorized-or-offline", detail: rcloneMessage(probe, "rclone lsf") };
      return { ok: true };
    },
    /**
     * Files in the given folders. A folder under `trees` is listed with everything
     * below it in one recursive listing, which is cheaper than many folders one by one.
     */
    async list(dirs, { trees = [], recursive = new Set() } = {}) {
      const files = new Map();
      const existingDirs = new Set();
      for (const tree of trees) {
        const result = await invoke(["lsjson", "-R", "--hash", "--hash-type", "md5", "--fast-list", "--no-mimetype", at(tree), ...common], { timeoutMs: 3_600_000 });
        if (result.code === 3) continue;
        if (result.code !== 0) throw new Error(`listing ${tree}: ${rcloneMessage(result, "rclone lsjson")}`);
        existingDirs.add(tree);
        parseListing(result.stdout, tree, files, existingDirs);
      }
      for (const dir of dirs) {
        if (trees.some((tree) => dir === tree || dir.startsWith(`${tree}/`))) continue;
        const deep = recursive.has(dir) ? ["-R", "--fast-list"] : [];
        const result = await invoke(["lsjson", ...deep, "--files-only", "--hash", "--hash-type", "md5", "--no-mimetype", at(dir), ...common], { timeoutMs: 600_000 });
        if (result.code === 3) continue;
        if (result.code !== 0) throw new Error(`listing ${dir}: ${rcloneMessage(result, "rclone lsjson")}`);
        existingDirs.add(dir);
        parseListing(result.stdout, dir, files, existingDirs);
      }
      return { files, dirs: existingDirs };
    },
    async md5() {
      // Drive reports md5 in the listing; with a remote that does not, a file that
      // would need comparing is reported as an error and left alone.
      return undefined;
    },
    async mkdir(rel) {
      await must(["mkdir", at(rel)], `making ${rel}`, { timeoutMs: 300_000 });
    },
    // --local-no-check-updated: a transcript that grows during the upload is sent at the
    // size rclone first saw, which is a byte-exact prefix the next run extends.
    // --ignore-times: always upload when asked; never decide by modification time.
    async copy(localPath, rel) {
      await must(["copyto", localPath, at(rel), "--local-no-check-updated", "--ignore-times", "--retries", "3"], `copying to ${rel}`, { timeoutMs: 6 * 3_600_000 });
    },
    // A server-side move. --checksum: an identical file already at the target is
    // recognised by content, not by its modification time.
    async move(fromRel, toRel) {
      await must(["moveto", at(fromRel), at(toRel), "--checksum"], `moving ${fromRel}`, { timeoutMs: 600_000 });
    },
    /** Whether this remote is Google Drive, whose files can be moved by id in batches. */
    canMoveById() {
      driveCheck ??= invoke(["listremotes", "--long"], { timeoutMs: 30_000 }).then((result) => result.code === 0
        && result.stdout.split(/\r?\n/).some((line) => {
          const match = /^([^:]+):\s+(\S+)/.exec(line.trim());
          return match?.[1] === remote && match[2] === "drive";
        }));
      return driveCheck;
    },
    /**
     * Server-side moves by Drive file id, many per rclone call. Each {id, from, to}
     * moves the file with that id onto `to`, where nothing was when it was listed.
     * A move counts only once a listing of its folder shows that id under its new
     * name. Returns one {ok} per move, in order; one not confirmed has an `error`,
     * and `retry` when moving it by name (moveto) may still work.
     */
    async moveByIds(moves, { log = () => {} } = {}) {
      const outcomes = moves.map(() => ({ ok: false, retry: true, error: "not moved" }));
      // rclone stops at the first pair that fails, with exit 1 and `failed moveid "<id>"`.
      // No --drive-stop-on-upload-limit here (nothing is uploaded): a drive flag on the
      // command line makes the destination a differently named config, and rclone then
      // copies and trashes instead of moving; --server-side-across-configs keeps it a move
      // even when the environment sets such a flag.
      const head = ["backend", "moveid", `${remote}:`];
      const tail = ["--tpslimit", String(tpsLimit), "--server-side-across-configs"];
      let queue = moves.map((move, index) => ({ ...move, index, dest: at(move.to) }))
        .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
      let done = 0;
      while (queue.length) {
        const [batch] = chunkMovePairs(queue, { fixed: [binary || "rclone", ...head, ...tail] });
        queue = queue.slice(batch.length);
        const started = Date.now();
        const result = await invoke([...head, ...batch.flatMap((move) => [move.id, move.dest]), ...tail], { timeoutMs: 1_800_000 });
        const failure = result.code === 0 ? null : rcloneMessage(result, "rclone backend moveid");
        const unconfirmed = [];
        const byDir = new Map();
        for (const move of batch) {
          const dir = move.to.split("/").slice(0, -1).join("/");
          if (!byDir.has(dir)) byDir.set(dir, []);
          byDir.get(dir).push(move);
        }
        for (const [dir, items] of byDir) {
          const listed = await invoke(["lsjson", "--files-only", "--no-mimetype", at(dir), ...common], { timeoutMs: 600_000 });
          let rows = null;
          if (listed.code === 0) { try { rows = JSON.parse(listed.stdout || "[]"); } catch {} }
          for (const move of items) {
            const name = move.to.split("/").at(-1);
            const named = (rows || []).filter((row) => !row.IsDir && row.Path === name);
            if (named.some((row) => row.ID === move.id)) {
              outcomes[move.index] = named.length === 1 ? { ok: true }
                : { ok: false, retry: false, error: `moved ${move.from}, but ${named.length} files are now named ${move.to}` };
            } else {
              const why = failure || (rows ? `not at ${move.to} after the move` : `checking ${dir}: ${rcloneMessage(listed, "rclone lsjson")}`);
              outcomes[move.index] = { ok: false, retry: true, error: `moving ${move.from}: ${why}` };
              unconfirmed.push(move);
            }
          }
        }
        done += batch.length - unconfirmed.length;
        log(`moved ${batch.length - unconfirmed.length}/${batch.length} by id in ${Math.round((Date.now() - started) / 1000)}s (${done}/${moves.length})${failure ? `: ${failure}` : ""}`);
        if (!failure || !unconfirmed.length) continue;
        // The pair rclone stopped at is left to be moved by name; the ones after it,
        // which rclone never reached, go back to the front of the queue.
        const stoppedAt = /failed (?:moveid|moving) "([^"]+)"/.exec(String(result.stderr || ""))?.[1];
        const culprit = unconfirmed.find((move) => move.id === stoppedAt);
        if (culprit) {
          queue = [...unconfirmed.filter((move) => move !== culprit), ...queue];
          continue;
        }
        if (unconfirmed.length === batch.length) {
          // Nothing moved and no pair to blame (rclone could not start, or timed out):
          // the rest is not tried this run.
          for (const move of [...unconfirmed, ...queue]) outcomes[move.index] = { ok: false, retry: false, error: `moving ${move.from}: ${failure}` };
          break;
        }
      }
      return outcomes;
    },
  };
}

/** The names of the rclone remotes configured on this computer, and nothing else about them. */
export async function rcloneRemotes({ env = process.env, run } = {}) {
  const binary = run ? "rclone" : locateRclone(env);
  if (!binary) return { ok: true, installed: false, remotes: [] };
  const result = await (run || ((args, options) => runRclone(binary, args, { ...options, env })))(["listremotes"], { timeoutMs: 30_000 });
  if (result.code !== 0) return { ok: false, installed: true, remotes: [], error: rcloneMessage(result, "rclone listremotes") };
  return { ok: true, installed: true, remotes: result.stdout.split(/\r?\n/).map((line) => line.trim().replace(/:$/, "")).filter(Boolean) };
}
