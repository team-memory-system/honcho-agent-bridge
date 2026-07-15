import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

function utcNow() {
  return new Date().toISOString();
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createOwnedFile(filePath) {
  const handle = await fsp.open(filePath, "wx");
  const token = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), created_at: utcNow() });
  try {
    await handle.writeFile(token, "utf8");
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.unlink(filePath).catch(() => {});
    throw error;
  }
  return { handle, filePath, token };
}

export async function releaseFileLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  try {
    if ((await fsp.readFile(lock.filePath, "utf8")) === lock.token) await fsp.unlink(lock.filePath);
  } catch {}
}

async function restoreMovedGuard(tombstonePath, guardPath, raw) {
  try {
    await fsp.link(tombstonePath, guardPath);
  } catch (error) {
    if (error.code === "EEXIST") return;
    try {
      const handle = await fsp.open(guardPath, "wx");
      try {
        await handle.writeFile(raw, "utf8");
      } finally {
        await handle.close();
      }
    } catch (restoreError) {
      if (restoreError.code !== "EEXIST") throw restoreError;
    }
  }
}

async function recoverOrphanGuard(guardPath) {
  let observedRaw;
  let stat;
  try {
    [observedRaw, stat] = await Promise.all([fsp.readFile(guardPath, "utf8"), fsp.stat(guardPath)]);
  } catch (error) {
    return error.code === "ENOENT";
  }
  let ownerPid = 0;
  let parsed = false;
  try {
    ownerPid = Number(JSON.parse(observedRaw).pid || 0);
    parsed = true;
  } catch {}
  const guardExpired = Date.now() - stat.mtimeMs > 60_000;
  if (parsed && processIsAlive(ownerPid)) return false;
  if (!parsed && !guardExpired) return false;

  const tombstonePath = `${guardPath}.orphan-${crypto.randomUUID()}`;
  try {
    if ((await fsp.readFile(guardPath, "utf8")) !== observedRaw) return false;
    await fsp.rename(guardPath, tombstonePath);
  } catch (error) {
    return error.code === "ENOENT";
  }
  try {
    const movedRaw = await fsp.readFile(tombstonePath, "utf8");
    if (movedRaw === observedRaw) return true;
    await restoreMovedGuard(tombstonePath, guardPath, movedRaw);
    return false;
  } finally {
    await fsp.unlink(tombstonePath).catch(() => {});
  }
}

async function acquireReclaimGuard(guardPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let guard;
    try {
      guard = await createOwnedFile(guardPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await recoverOrphanGuard(guardPath)) continue;
      return null;
    }
    await sleep(20);
    try {
      if ((await fsp.readFile(guardPath, "utf8")) === guard.token) return guard;
    } catch {}
    await releaseFileLock(guard);
  }
  return null;
}

async function tryReclaimFileLock(lockPath, { staleMs, reclaimDeadImmediately }) {
  const guardPath = `${lockPath}.reclaim`;
  const guard = await acquireReclaimGuard(guardPath);
  if (!guard) return false;
  try {
    let raw;
    let stat;
    try {
      [raw, stat] = await Promise.all([fsp.readFile(lockPath, "utf8"), fsp.stat(lockPath)]);
    } catch (error) {
      return error.code === "ENOENT";
    }
    let ownerPid = 0;
    let parsed = false;
    try {
      ownerPid = Number(JSON.parse(raw).pid || 0);
      parsed = true;
    } catch {}
    if (processIsAlive(ownerPid)) return false;
    const oldEnough = Date.now() - stat.mtimeMs > staleMs;
    if (!(oldEnough || (parsed && reclaimDeadImmediately))) return false;
    try {
      if ((await fsp.readFile(lockPath, "utf8")) !== raw) return false;
      if ((await fsp.readFile(guardPath, "utf8")) !== guard.token) return false;
      await fsp.unlink(lockPath);
      return true;
    } catch (error) {
      return error.code === "ENOENT";
    }
  } finally {
    await releaseFileLock(guard);
  }
}

export async function acquireFileLock(
  lockPath,
  { attempts = 1, delayMs = 100, staleMs = 120_000, reclaimDeadImmediately = false } = {},
) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  let failures = 0;
  while (failures < attempts) {
    try {
      return await createOwnedFile(lockPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await tryReclaimFileLock(lockPath, { staleMs, reclaimDeadImmediately })) continue;
      failures += 1;
      if (failures < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}
