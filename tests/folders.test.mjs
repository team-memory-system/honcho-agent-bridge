// The folder picker lists one folder's subfolders: directories only, hidden ones
// left out, in the order a person would sort them, with the places a search starts.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { folderRoots, hiddenName, listFolders, MAX_FOLDERS } from "../scripts/folders.mjs";

async function tempDir(t) {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-bridge-folders-")));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("subfolders only, hidden ones left out, sorted by name with numbers in order", async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  for (const name of ["b", "A", "item10", "item2", ".hidden", "$RECYCLE.BIN", "System Volume Information"]) {
    await fsp.mkdir(path.join(home, name), { recursive: true });
  }
  await fsp.writeFile(path.join(home, "notes.txt"), "a file, not a folder");
  await fsp.mkdir(path.join(root, "elsewhere"));
  await fsp.symlink(path.join(root, "elsewhere"), path.join(home, "linked"));
  await fsp.symlink(path.join(home, "notes.txt"), path.join(home, "file-link"));
  await fsp.symlink(path.join(root, "gone"), path.join(home, "dangling"));

  const result = await listFolders({ home, platform: "linux", mountDirs: [] });
  assert.equal(result.ok, true);
  assert.equal(result.path, home, "no path starts at the home folder");
  assert.equal(result.parent, root);
  assert.equal(result.truncated, false);
  // Only Windows hides its own system folders.
  assert.deepEqual(result.folders.map((folder) => folder.name), ["$RECYCLE.BIN", "A", "b", "item2", "item10", "linked", "System Volume Information"]);
  assert.deepEqual(result.folders.find((folder) => folder.name === "linked"), { name: "linked", path: path.join(home, "linked") });
  assert.deepEqual(result.roots, [{ kind: "home", path: home }, { kind: "root", path: "/" }]);

  const given = await listFolders({ path: `${path.join(home, "A")}/`, home, platform: "linux", mountDirs: [] });
  assert.equal(given.path, path.join(home, "A"), "a trailing slash is dropped");
  assert.deepEqual(given.folders, []);
  assert.equal(given.parent, home);
});

test("on Windows the recycle bin and System Volume Information are left out too", async (t) => {
  for (const name of [".git", ".Trash"]) {
    assert.equal(hiddenName(name, "linux"), true, name);
    assert.equal(hiddenName(name, "win32"), true, name);
  }
  for (const name of ["$RECYCLE.BIN", "$Recycle.Bin", "System Volume Information"]) {
    assert.equal(hiddenName(name, "linux"), false, name);
    assert.equal(hiddenName(name, "win32"), true, name);
  }
  assert.equal(hiddenName("Users", "win32"), false);

  if (process.platform !== "win32") return;
  const root = await tempDir(t);
  for (const name of ["$Recycle.Bin", "System Volume Information", "Users"]) await fsp.mkdir(path.join(root, name));
  const result = await listFolders({ path: root, home: root, platform: "win32" });
  assert.deepEqual(result.folders.map((folder) => folder.name), ["Users"]);
});

test("a bad path answers why", async (t) => {
  const root = await tempDir(t);
  await fsp.writeFile(path.join(root, "file.txt"), "x");
  const options = { home: root, platform: "linux", mountDirs: [] };

  for (const [given, reason] of [
    ["relative/path", "not-absolute"],
    [path.join(root, "missing"), "missing"],
    [path.join(root, "file.txt", "below"), "missing"],
    [path.join(root, "file.txt"), "not-directory"],
  ]) {
    const result = await listFolders({ ...options, path: given });
    assert.equal(result.ok, false, given);
    assert.equal(result.reason, reason, given);
    assert.equal(typeof result.error, "string");
    assert.deepEqual(Object.keys(result).sort(), ["error", "ok", "reason"]);
  }

  if (process.getuid?.() !== 0) {
    const locked = path.join(root, "locked");
    await fsp.mkdir(locked);
    await fsp.chmod(locked, 0o000);
    const result = await listFolders({ ...options, path: locked });
    await fsp.chmod(locked, 0o755);
    assert.equal(result.reason, "unreadable");
  }
});

test("the filesystem root has no parent", async () => {
  const result = await listFolders({ path: "/", home: "/", platform: process.platform === "win32" ? "linux" : process.platform, volumesDir: "/nonexistent", mountDirs: [] });
  assert.equal(result.ok, true);
  assert.equal(result.path, "/");
  assert.equal(result.parent, null);
});

test("a folder with more than the cap is cut and says so", async (t) => {
  const root = await tempDir(t);
  await Promise.all(Array.from({ length: MAX_FOLDERS + 5 }, (_, index) => fsp.mkdir(path.join(root, `d${index}`))));
  const result = await listFolders({ path: root, home: root, platform: "linux", mountDirs: [] });
  assert.equal(result.folders.length, MAX_FOLDERS);
  assert.equal(result.truncated, true);
  assert.equal(result.folders[0].name, "d0");
  assert.equal(result.folders.at(-1).name, `d${MAX_FOLDERS - 1}`, "the first ones by name are kept");
});

test("other disks: /Volumes on macOS without the startup disk, mount folders on Linux", async (t) => {
  const root = await tempDir(t);
  const volumes = path.join(root, "Volumes");
  await fsp.mkdir(path.join(volumes, "Backup"), { recursive: true });
  await fsp.mkdir(path.join(volumes, ".timemachine"));
  await fsp.writeFile(path.join(volumes, "stray-file"), "");
  await fsp.symlink("/", path.join(volumes, "Macintosh HD"));
  await fsp.mkdir(path.join(root, "usb"));
  await fsp.symlink(path.join(root, "usb"), path.join(volumes, "USB 10"));

  const mac = await folderRoots({ home: root, platform: "darwin", volumesDir: volumes });
  assert.deepEqual(mac, [
    { kind: "home", path: root },
    { kind: "volume", name: "Backup", path: path.join(volumes, "Backup") },
    { kind: "volume", name: "USB 10", path: path.join(volumes, "USB 10") },
    { kind: "root", path: "/" },
  ]);

  const media = path.join(root, "media");
  const mnt = path.join(root, "mnt");
  await fsp.mkdir(path.join(media, "stick"), { recursive: true });
  await fsp.mkdir(path.join(mnt, "data"), { recursive: true });
  const linux = await folderRoots({ home: root, platform: "linux", mountDirs: [media, path.join(root, "absent"), mnt] });
  assert.deepEqual(linux, [
    { kind: "home", path: root },
    { kind: "volume", name: "stick", path: path.join(media, "stick") },
    { kind: "volume", name: "data", path: path.join(mnt, "data") },
    { kind: "root", path: "/" },
  ]);

  const listed = await listFolders({ path: root, home: root, platform: "darwin", volumesDir: volumes });
  assert.deepEqual(listed.roots, mac, "a listing carries the same roots");
});
