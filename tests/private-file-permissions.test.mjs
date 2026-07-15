import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { securePrivateFile } from "../scripts/private-file-permissions.mjs";

const USER_SID = "S-1-5-21-111-222-333-1001";

test("Windows private files grant only the current SID, LocalSystem, and Administrators", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command.endsWith("\\whoami.exe")) return { ok: true, stdout: `"WORKSTATION\\alice","${USER_SID}"\r\n` };
    return { ok: true, stdout: "Successfully processed 1 files\r\n" };
  };

  const result = await securePrivateFile("C:\\AgentMemory\\runtime\\host-config.json", {
    platform: "win32",
    env: { USERNAME: "Alice", SystemRoot: "C:\\Windows" },
    run,
  });

  assert.equal(result.method, "windows-acl");
  assert.equal(result.userSid, USER_SID);
  assert.deepEqual(calls, [
    {
      command: "C:\\Windows\\System32\\whoami.exe",
      args: ["/user", "/fo", "csv", "/nh"],
    },
    {
      command: "C:\\Windows\\System32\\icacls.exe",
      args: ["C:\\AgentMemory\\runtime\\host-config.json", "/reset", "/q"],
    },
    {
      command: "C:\\Windows\\System32\\icacls.exe",
      args: [
        "C:\\AgentMemory\\runtime\\host-config.json",
        "/inheritancelevel:r",
        "/grant:r",
        `*${USER_SID}:F`,
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
        "/q",
      ],
    },
  ]);
});

test("Windows private-file setup fails closed when USERNAME or SID cannot be identified", async () => {
  let called = false;
  await assert.rejects(
    securePrivateFile("C:\\private.env", {
      platform: "win32",
      env: {},
      run: async () => { called = true; return { ok: true }; },
    }),
    /USERNAME is unavailable/,
  );
  assert.equal(called, false);

  await assert.rejects(
    securePrivateFile("C:\\private.env", {
      platform: "win32",
      env: { USERNAME: "alice", SystemRoot: "C:\\Windows" },
      run: async () => ({ ok: true, stdout: '"WORKSTATION\\bob","S-1-5-21-1-2-3-1002"\r\n' }),
    }),
    /current user SID could not be identified/,
  );
});

test("Windows private-file setup propagates icacls failure and stops before later grants", async () => {
  const calls = [];
  await assert.rejects(
    securePrivateFile("C:\\private.env", {
      platform: "win32",
      env: { USERNAME: "alice", SystemRoot: "C:\\Windows" },
      run: async (command, args) => {
        calls.push({ command, args: [...args] });
        if (command.endsWith("\\whoami.exe")) return { ok: true, stdout: `"WORKSTATION\\alice","${USER_SID}"\r\n` };
        return { ok: false };
      },
    }),
    /ACL reset failed/,
  );
  assert.equal(calls.filter((item) => item.command.endsWith("\\icacls.exe")).length, 1);
});

test("non-Windows private files retain owner-only mode", { skip: process.platform === "win32" }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-memory-private-file-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "private.env");
  await fsp.writeFile(target, "SECRET=value\n", { mode: 0o644 });
  const result = await securePrivateFile(target, { platform: "darwin" });
  assert.equal(result.method, "posix-mode");
  assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
});
