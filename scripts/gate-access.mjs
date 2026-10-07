// Who may do what on this computer's shared server: the owner's side of the gate's
// two files, in <runtime>/gate (the gate container sees that folder as /gate-state).
//
//   access.json   written here, read by the gate whenever it changes: the owners
//                 (every computer of theirs may register and write), the workspace
//                 teammates write into, and per teammate email what is opened to
//                 them: chat with a list of projects, or collecting into this
//                 server. Devices cut off are listed under revokedDevices.
//   devices.json  written by the gate only: every computer that registered (an
//                 email, its name, a hash of its key, when it was last seen). Read
//                 here for the list of computers that write to this server.
//
// access.json holds emails and project names, no secret, and the gate's container
// user must be able to read it, so it is written readable (0644); devices.json holds
// only hashes. Changes go through one lock so two windows of the app never lose
// each other's change.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { normalizeEmail } from "./cloudflare-api.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { PROJECT_SCOPE } from "./projects.mjs";
import { installedServerDir } from "./server-manager.mjs";

const DEVICE_ID = /^d-[0-9a-f]{16}$/;
const PEER = /^[A-Za-z0-9_.:@-]{1,64}$/;
const WORKSPACE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_PROJECTS = 100;

export function gateStatePaths({ serverDirectory, runtimeDirectory } = {}) {
  const serverDir = path.resolve(serverDirectory || installedServerDir());
  const runtimeDir = path.resolve(runtimeDirectory || path.join(path.dirname(serverDir), "runtime"));
  const dir = path.join(runtimeDir, "gate");
  return {
    dir,
    accessFile: path.join(dir, "access.json"),
    devicesFile: path.join(dir, "devices.json"),
    lockFile: path.join(dir, "access.json.lock"),
  };
}

async function readJsonFile(file) {
  try {
    const value = JSON.parse(await fsp.readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function projectList(value) {
  const seen = new Set();
  const list = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || !PROJECT_SCOPE.test(String(item.id)) || seen.has(item.id)) continue;
    seen.add(item.id);
    list.push({ id: item.id, name: String(item.name || item.id).slice(0, 120) });
  }
  return list.slice(0, MAX_PROJECTS);
}

/** access.json with every part present and nothing the gate would not read. */
export function normalizeGateAccess(value) {
  const people = {};
  for (const [key, entry] of Object.entries(value?.people && typeof value.people === "object" ? value.people : {})) {
    const email = normalizeEmail(key);
    if (!email || !entry || typeof entry !== "object" || !PEER.test(String(entry.peer || ""))) continue;
    const person = { peer: entry.peer };
    if (entry.chat && typeof entry.chat === "object") person.chat = { projects: projectList(entry.chat.projects), ...(entry.chat.since ? { since: entry.chat.since } : {}) };
    if (entry.collect && typeof entry.collect === "object") {
      person.collect = { ...(WORKSPACE.test(String(entry.collect.workspace || "")) ? { workspace: entry.collect.workspace } : {}), ...(entry.collect.since ? { since: entry.collect.since } : {}) };
    }
    if (person.chat || person.collect) people[email] = person;
  }
  return {
    version: 1,
    owners: [...new Set((Array.isArray(value?.owners) ? value.owners : []).map(normalizeEmail).filter(Boolean))],
    workspace: WORKSPACE.test(String(value?.workspace || "")) ? value.workspace : "memory",
    people,
    revokedDevices: [...new Set((Array.isArray(value?.revokedDevices) ? value.revokedDevices : []).filter((id) => DEVICE_ID.test(String(id))))],
  };
}

export async function readGateAccess(paths) {
  return normalizeGateAccess(await readJsonFile(paths.accessFile));
}

async function writeReadable(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, content, { mode: 0o644, flag: "wx" });
    await fsp.chmod(temporary, 0o644).catch(() => {});
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Changes access.json under its lock: `change` gets it normalized and returns the new one, or null to leave it. */
export async function changeGateAccess(paths, change) {
  await fsp.mkdir(paths.dir, { recursive: true });
  const lock = await acquireFileLock(paths.lockFile, { attempts: 50, delayMs: 100, staleMs: 60_000 });
  if (!lock) throw new Error("Another change to who may use this server is running; try again in a moment");
  try {
    const current = await readGateAccess(paths);
    const next = await change(structuredClone(current));
    if (!next) return current;
    const normalized = normalizeGateAccess(next);
    await writeReadable(paths.accessFile, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  } finally {
    await releaseFileLock(lock);
  }
}

function now() {
  return new Date().toISOString();
}

/** The owners and the workspace: set whenever sharing is turned on through the team. */
export async function setGateOwners(paths, { owners, workspace }) {
  return changeGateAccess(paths, (access) => ({ ...access, owners: [...new Set([...owners])], ...(workspace ? { workspace } : {}) }));
}

/** Opens chat with `projects` to a teammate, or changes which projects are open. */
export async function grantChat(paths, { email, peer, projects }) {
  const who = normalizeEmail(email);
  if (!who) throw new Error("A teammate's email is needed");
  return changeGateAccess(paths, (access) => {
    const person = access.people[who] || { peer };
    access.people[who] = { ...person, peer: peer || person.peer, chat: { projects: projectList(projects), since: person.chat?.since || now() } };
    return access;
  });
}

/** Lets a teammate's computers collect into this server's workspace. */
export async function grantCollect(paths, { email, peer, workspace }) {
  const who = normalizeEmail(email);
  if (!who) throw new Error("A teammate's email is needed");
  return changeGateAccess(paths, (access) => {
    const person = access.people[who] || { peer };
    access.people[who] = { ...person, peer: peer || person.peer, collect: { ...(workspace ? { workspace } : {}), since: person.collect?.since || now() } };
    return access;
  });
}

/** Takes back chat, collecting, or both (`kind` "all") from a teammate. */
export async function revokePerson(paths, { email, kind = "all" }) {
  const who = normalizeEmail(email);
  return changeGateAccess(paths, (access) => {
    const person = access.people[who];
    if (!person) return null;
    if (kind === "all" || kind === "chat") delete person.chat;
    if (kind === "all" || kind === "collect") delete person.collect;
    if (!person.chat && !person.collect) delete access.people[who];
    return access;
  });
}

/** Cuts one computer off: the gate refuses its key from the next request on. */
export async function revokeDevice(paths, { id }) {
  if (!DEVICE_ID.test(String(id))) throw new Error("Not a device id");
  return changeGateAccess(paths, (access) => ({ ...access, revokedDevices: [...access.revokedDevices, id] }));
}

/**
 * Every computer that registered with this server's gate, newest use first, with
 * whether it is one of the owner's and whether it was cut off. No key, no hash.
 */
export async function gateDevices(paths) {
  const [access, file] = await Promise.all([readGateAccess(paths), readJsonFile(paths.devicesFile)]);
  const revoked = new Set(access.revokedDevices);
  const owners = new Set(access.owners);
  const devices = file?.devices && typeof file.devices === "object" ? file.devices : {};
  return Object.entries(devices)
    .filter(([id, device]) => DEVICE_ID.test(id) && device && typeof device === "object")
    .map(([id, device]) => ({
      id,
      email: normalizeEmail(device.email) || "",
      name: String(device.name || "").slice(0, 64),
      createdAt: device.createdAt || null,
      lastSeenAt: device.lastSeenAt || null,
      owner: owners.has(normalizeEmail(device.email)),
      peer: access.people[normalizeEmail(device.email)]?.peer || null,
      revoked: revoked.has(id),
    }))
    .sort((left, right) => String(right.lastSeenAt || right.createdAt || "").localeCompare(String(left.lastSeenAt || left.createdAt || "")));
}

/** The teammates something is opened to, for 내 기억을 여는 팀원. */
export async function gateGrants(paths) {
  const access = await readGateAccess(paths);
  return Object.entries(access.people).map(([email, person]) => ({
    email,
    peer: person.peer,
    chat: person.chat ? { projects: person.chat.projects, since: person.chat.since || null } : null,
    collect: person.collect ? { workspace: person.collect.workspace || access.workspace, since: person.collect.since || null } : null,
  }));
}
