// The folders on this computer, one level at a time, for the app's folder picker.
// A browser page cannot read the computer's folders itself, so the app server
// lists them: directories only, hidden ones left out, and the places a folder
// usually starts from (the home folder, other disks, the filesystem root).
//
// Importing this module does nothing on its own.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_FOLDERS = 1000;
const STAT_BATCH = 64;
const WINDOWS_SKIPPED = new Set(["$recycle.bin", "system volume information"]);

const MESSAGES = {
  "not-absolute": "Give a full folder path.",
  missing: "That folder does not exist.",
  "not-directory": "That is a file, not a folder.",
  unreadable: "This folder cannot be opened.",
};

function failure(reason) {
  return { ok: false, reason, error: MESSAGES[reason] };
}

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** A name the picker leaves out: dot names, and on Windows its own system folders. */
export function hiddenName(name, platform = process.platform) {
  if (name.startsWith(".")) return true;
  return platform === "win32" && WINDOWS_SKIPPED.has(name.toLowerCase());
}

function byName(left, right) {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

async function isDirectory(target) {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** A directory, or a link that leads to one. */
async function folderEntry(directory, entry, paths) {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) return isDirectory(paths.join(directory, entry.name));
  return false;
}

async function readFolders(directory, platform) {
  const paths = pathFor(platform);
  const entries = (await fsp.readdir(directory, { withFileTypes: true }))
    .filter((entry) => !hiddenName(entry.name, platform))
    .sort(byName);
  const folders = [];
  for (let start = 0; start < entries.length; start += STAT_BATCH) {
    const batch = entries.slice(start, start + STAT_BATCH);
    const keep = await Promise.all(batch.map((entry) => folderEntry(directory, entry, paths)));
    for (let index = 0; index < batch.length; index += 1) {
      if (!keep[index]) continue;
      // One folder past the cap is enough to know the list was cut.
      if (folders.length === MAX_FOLDERS) return { folders, truncated: true };
      folders.push({ name: batch[index].name, path: paths.join(directory, batch[index].name) });
    }
  }
  return { folders, truncated: false };
}

/** The visible folders inside `directory`, as roots of the given kind. */
async function mountedIn(directory, kind, paths, { notRoot = false } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort(byName)
    .map(async (entry) => {
      const full = paths.join(directory, entry.name);
      if (!(await isDirectory(full))) return null;
      // macOS lists the startup disk in /Volumes as a link back to /.
      if (notRoot && (await fsp.realpath(full).catch(() => full)) === "/") return null;
      return { kind, name: entry.name, path: full };
    }));
  return found.filter(Boolean);
}

function currentUser(home) {
  try {
    return os.userInfo().username || path.basename(home);
  } catch {
    return path.basename(home);
  }
}

async function windowsDrives() {
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  const found = await Promise.all(letters.map(async (letter) => {
    const root = `${letter}:\\`;
    return (await isDirectory(root)) ? { kind: "drive", name: `${letter}:`, path: root } : null;
  }));
  return found.filter(Boolean);
}

/**
 * Where a folder search starts: the home folder, then other disks, then `/`.
 * `volumesDir` (macOS) and `mountDirs` (Linux) let a test stand in for the real ones.
 */
export async function folderRoots({ home = os.homedir(), platform = process.platform, volumesDir, mountDirs } = {}) {
  const paths = pathFor(platform);
  const roots = [{ kind: "home", path: home }];
  if (platform === "win32") {
    roots.push(...await windowsDrives());
  } else if (platform === "darwin") {
    roots.push(...await mountedIn(volumesDir || "/Volumes", "volume", paths, { notRoot: true }));
  } else {
    const user = currentUser(home);
    const directories = mountDirs || [paths.join("/media", user), paths.join("/run/media", user), "/mnt"];
    for (const directory of directories) roots.push(...await mountedIn(directory, "volume", paths));
  }
  if (platform !== "win32") roots.push({ kind: "root", path: "/" });
  return roots;
}

/**
 * One folder's subfolders. With no `path`, the home folder's.
 *
 * Answers `{ ok: true, path, parent, folders: [{ name, path }], roots, truncated }`,
 * or `{ ok: false, reason, error }` with reason `not-absolute`, `missing`,
 * `not-directory` or `unreadable`.
 */
export async function listFolders({ path: requested, home = os.homedir(), platform = process.platform, volumesDir, mountDirs } = {}) {
  const paths = pathFor(platform);
  const given = typeof requested === "string" && requested.trim() ? requested.trim() : null;
  if (given !== null && !paths.isAbsolute(given)) return failure("not-absolute");
  const directory = paths.resolve(given ?? home);

  let stat;
  try {
    stat = await fsp.stat(directory);
  } catch (error) {
    return failure(error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "missing" : "unreadable");
  }
  if (!stat.isDirectory()) return failure("not-directory");

  let listed;
  try {
    listed = await readFolders(directory, platform);
  } catch {
    return failure("unreadable");
  }
  const parent = paths.dirname(directory);
  return {
    ok: true,
    path: directory,
    parent: parent === directory ? null : parent,
    folders: listed.folders,
    roots: await folderRoots({ home, platform, volumesDir, mountDirs }),
    truncated: listed.truncated,
  };
}
