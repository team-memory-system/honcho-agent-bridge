// The owner's side of the gate's files: access.json, which says who may do what on
// this computer's shared server, and devices.json, which only the gate writes. What
// matters: only what the gate reads is ever written, one change never loses
// another, chat is opened with a list of projects and closed again, a computer is
// cut off by its id, and the list of computers names no key.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  changeGateAccess,
  gateDevices,
  gateGrants,
  gateStatePaths,
  grantChat,
  grantCollect,
  normalizeGateAccess,
  readGateAccess,
  revokeDevice,
  revokePerson,
  setGateOwners,
} from "../scripts/gate-access.mjs";

async function tempPaths(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-access-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return gateStatePaths({ serverDirectory: path.join(dir, "server") });
}

const HONCHO = { id: "p-0123456789ab", name: "honcho" };
const WEB = { id: "p-abcdef012345", name: "web-app" };

test("the gate's folder is <runtime>/gate beside the server, as Compose mounts ../runtime/gate", () => {
  const paths = gateStatePaths({ serverDirectory: path.join("/apps", "team-memory", "server") });
  assert.equal(paths.dir, path.resolve("/apps", "team-memory", "runtime", "gate"));
  assert.equal(paths.accessFile, path.join(paths.dir, "access.json"));
  assert.equal(paths.devicesFile, path.join(paths.dir, "devices.json"));
});

test("owners, chat with projects and collecting are written as the gate reads them", async (t) => {
  const paths = await tempPaths(t);
  assert.deepEqual(await readGateAccess(paths), { version: 1, owners: [], workspace: "memory", people: {}, revokedDevices: [] });
  await setGateOwners(paths, { owners: ["Me@Example.com"], workspace: "memory" });
  await grantChat(paths, { email: "alice@example.com", peer: "alice", projects: [HONCHO, WEB, { id: "not-a-scope", name: "x" }, HONCHO] });
  await grantCollect(paths, { email: "bob@example.com", peer: "bob", workspace: "memory" });
  const access = JSON.parse(await fs.readFile(paths.accessFile, "utf8"));
  assert.deepEqual(access.owners, ["me@example.com"]);
  assert.deepEqual(access.people["alice@example.com"].chat.projects, [HONCHO, WEB], "a bad id and a repeat are dropped");
  assert.equal(access.people["alice@example.com"].peer, "alice");
  assert.equal(access.people["bob@example.com"].collect.workspace, "memory");
  if (process.platform !== "win32") {
    // The gate's own user in its container reads it; it holds no secret.
    assert.equal((await fs.stat(paths.accessFile)).mode & 0o777, 0o644);
  }

  // Changing the projects keeps when chat was first opened.
  const since = access.people["alice@example.com"].chat.since;
  await grantChat(paths, { email: "alice@example.com", projects: [WEB] });
  const changed = await readGateAccess(paths);
  assert.deepEqual(changed.people["alice@example.com"].chat.projects, [WEB]);
  assert.equal(changed.people["alice@example.com"].chat.since, since);

  // Closing chat leaves collecting; closing the last thing drops the person.
  await grantCollect(paths, { email: "alice@example.com", peer: "alice" });
  await revokePerson(paths, { email: "alice@example.com", kind: "chat" });
  assert.equal((await readGateAccess(paths)).people["alice@example.com"].chat, undefined);
  await revokePerson(paths, { email: "alice@example.com", kind: "collect" });
  assert.equal((await readGateAccess(paths)).people["alice@example.com"], undefined);
});

test("two changes at once both land", async (t) => {
  const paths = await tempPaths(t);
  await Promise.all([
    grantChat(paths, { email: "a@example.com", peer: "a", projects: [HONCHO] }),
    grantChat(paths, { email: "b@example.com", peer: "b", projects: [WEB] }),
    grantCollect(paths, { email: "c@example.com", peer: "c" }),
    revokeDevice(paths, { id: "d-0123456789abcdef" }),
  ]);
  const access = await readGateAccess(paths);
  assert.deepEqual(Object.keys(access.people).sort(), ["a@example.com", "b@example.com", "c@example.com"]);
  assert.deepEqual(access.revokedDevices, ["d-0123456789abcdef"]);
});

test("what the gate would not read never reaches the file", () => {
  const normalized = normalizeGateAccess({
    owners: ["not an email", "OK@example.com"],
    workspace: "bad workspace!",
    people: {
      "x@example.com": { peer: "x", chat: { projects: [HONCHO] }, admin: true },
      "y@example.com": { peer: "bad peer!", chat: { projects: [HONCHO] } },
      "z@example.com": { peer: "z" },
      "not-an-email": { peer: "n", collect: {} },
    },
    revokedDevices: ["d-0123456789abcdef", "nope"],
    extra: "dropped",
  });
  assert.deepEqual(normalized, {
    version: 1,
    owners: ["ok@example.com"],
    workspace: "memory",
    people: { "x@example.com": { peer: "x", chat: { projects: [HONCHO] } } },
    revokedDevices: ["d-0123456789abcdef"],
  });
});

test("the list of computers comes from the gate's file, owners marked, keys left out", async (t) => {
  const paths = await tempPaths(t);
  await setGateOwners(paths, { owners: ["me@example.com"] });
  await grantCollect(paths, { email: "bob@example.com", peer: "bob" });
  await fs.writeFile(paths.devicesFile, JSON.stringify({
    version: 1,
    devices: {
      "d-1111111111111111": { email: "me@example.com", name: "iMac", keyHash: "a".repeat(64), createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-07T01:00:00Z" },
      "d-2222222222222222": { email: "bob@example.com", name: "bob's laptop", keyHash: "b".repeat(64), createdAt: "2026-10-02T00:00:00Z", lastSeenAt: "2026-10-07T02:00:00Z" },
      "bad id": { email: "x@example.com", name: "x" },
    },
  }));
  await revokeDevice(paths, { id: "d-1111111111111111" });
  const devices = await gateDevices(paths);
  assert.deepEqual(devices.map((device) => [device.id, device.owner, device.revoked, device.peer]), [
    ["d-2222222222222222", false, false, "bob"],
    ["d-1111111111111111", true, true, null],
  ]);
  assert.equal(JSON.stringify(devices).includes("keyHash"), false);
  await assert.rejects(revokeDevice(paths, { id: "../etc" }), /Not a device id/);

  const grants = await gateGrants(paths);
  assert.deepEqual(grants, [{ email: "bob@example.com", peer: "bob", chat: null, collect: { workspace: "memory", since: grants[0].collect.since } }]);
});

test("a change that returns nothing leaves the file as it was", async (t) => {
  const paths = await tempPaths(t);
  await setGateOwners(paths, { owners: ["me@example.com"] });
  const before = await fs.readFile(paths.accessFile, "utf8");
  await changeGateAccess(paths, () => null);
  assert.equal(await fs.readFile(paths.accessFile, "utf8"), before);
});
