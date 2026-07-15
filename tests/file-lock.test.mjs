import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireFileLock, releaseFileLock } from "../scripts/file-lock.mjs";

test("an old owner never removes a replacement owner's lock", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-lock-owner-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "state.lock");
  const oldOwner = await acquireFileLock(lockPath);
  assert.ok(oldOwner);
  if (process.platform === "win32") await oldOwner.handle.close();
  await fsp.unlink(lockPath);
  const replacement = JSON.stringify({ pid: process.pid, nonce: "replacement-owner" });
  await fsp.writeFile(lockPath, replacement);

  await releaseFileLock(oldOwner);
  assert.equal(await fsp.readFile(lockPath, "utf8"), replacement);
});
