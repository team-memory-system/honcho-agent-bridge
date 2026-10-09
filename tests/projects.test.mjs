// The app lists the folders this computer's conversations were held in, grouped by
// the repository each one sits in (or the folder holding one-off folders), from the
// same transcripts `target backfill` reads.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  conversationProjects,
  datedParent,
  gitRemote,
  normalizeRemote,
  projectFolder,
  projectScope,
  systemTempFolders,
  transcriptFiles,
  unlistedFolder,
} from "../scripts/projects.mjs";

async function tempDir(t) {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-bridge-projects-")));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

const lines = (...records) => `${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`;

async function writeTranscript(file, content, when) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  if (when) await fsp.utimes(file, new Date(when), new Date(when));
}

function claudeLines(cwd) {
  return lines(
    { type: "summary", summary: "earlier" },
    { type: "user", cwd, sessionId: "s", message: { role: "user", content: "hello" } },
  );
}

function codexLines(cwd) {
  return lines(
    { type: "session_meta", payload: { id: "c", cwd, originator: "codex_cli_rs" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
  );
}

test("sessions are grouped by the repository their folder sits in, newest first", async (t) => {
  const home = await tempDir(t);
  const dev = path.join(home, "dev");
  const repo = path.join(dev, "repo");
  const worktree = path.join(dev, "worktree");
  const plain = path.join(dev, "plain", "inner");
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  await fsp.mkdir(path.join(repo, "src", "deep"), { recursive: true });
  await fsp.mkdir(worktree, { recursive: true });
  await fsp.writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere\n");
  await fsp.mkdir(plain, { recursive: true });
  const gone = path.join(dev, "deleted-project");

  const claude = path.join(home, ".claude", "projects");
  const codex = path.join(home, ".codex", "sessions", "2026", "10", "01");
  await writeTranscript(path.join(claude, "-repo", "a.jsonl"), claudeLines(path.join(repo, "src", "deep")), "2026-10-01T10:00:00Z");
  await writeTranscript(path.join(codex, "rollout-a.jsonl"), codexLines(repo), "2026-10-03T10:00:00Z");
  await writeTranscript(path.join(codex, "rollout-b.jsonl"), codexLines(`${repo}/`), "2026-10-02T10:00:00Z");
  await writeTranscript(path.join(claude, "-worktree", "b.jsonl"), claudeLines(worktree), "2026-10-04T10:00:00Z");
  await writeTranscript(path.join(claude, "-plain", "c.jsonl"), claudeLines(plain), "2026-09-01T10:00:00Z");
  await writeTranscript(path.join(claude, "-gone", "d.jsonl"), claudeLines(gone), "2026-09-02T10:00:00Z");
  await writeTranscript(path.join(claude, "-home", "e.jsonl"), claudeLines(home), "2026-09-03T10:00:00Z");
  // A subagent's transcript sits deeper and is not a conversation of its own.
  await writeTranscript(path.join(claude, "-repo", "a", "subagents", "agent.jsonl"), claudeLines(repo), "2026-10-05T10:00:00Z");
  // A file that is not a Codex rollout is not one either.
  await writeTranscript(path.join(codex, "history.jsonl"), codexLines(repo), "2026-10-05T10:00:00Z");

  const result = await conversationProjects({ home });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 7);
  assert.equal(result.withoutFolder, 0);
  assert.ok(result.projects.every((project) => /^p-[0-9a-f]{12}$/.test(project.scope)));
  assert.deepEqual(result.projects.map(({ scope, ...project }) => project), [
    { path: worktree, name: "worktree", sessions: 1, lastAt: "2026-10-04T10:00:00.000Z", agents: { claude: 1, codex: 0 }, exists: true, git: true, folded: false, folders: 1 },
    { path: repo, name: "repo", sessions: 3, lastAt: "2026-10-03T10:00:00.000Z", agents: { claude: 1, codex: 2 }, exists: true, git: true, folded: false, folders: 2 },
    { path: home, name: "~", sessions: 1, lastAt: "2026-09-03T10:00:00.000Z", agents: { claude: 1, codex: 0 }, exists: true, git: false, folded: false, folders: 1 },
    { path: gone, name: "deleted-project", sessions: 1, lastAt: "2026-09-02T10:00:00.000Z", agents: { claude: 1, codex: 0 }, exists: false, git: false, folded: false, folders: 1 },
    { path: plain, name: "inner", sessions: 1, lastAt: "2026-09-01T10:00:00.000Z", agents: { claude: 1, codex: 0 }, exists: true, git: false, folded: false, folders: 1 },
  ]);
});

test("one-off folders outside a repository count under the folder that holds them", async (t) => {
  const home = await tempDir(t);
  const codexApp = path.join(home, "Documents", "Codex");
  const first = path.join(codexApp, "2026-10-01", "fix-login");
  const second = path.join(codexApp, "2026-10-02-draft-mail");
  const removed = path.join(codexApp, "2026-09-30", "gone-task");
  const repo = path.join(home, "dev", "repo");
  const inRepo = path.join(repo, "notes", "2026-10-03");
  const scratch = path.join(home, "scratch");
  const scratchWork = path.join(scratch, "claude-501", "task", "scratchpad");
  for (const folder of [first, second, inRepo, scratchWork]) await fsp.mkdir(folder, { recursive: true });
  await fsp.mkdir(path.join(repo, ".git"), { recursive: true });
  const codex = path.join(home, ".codex", "sessions", "2026", "10", "02");
  const claude = path.join(home, ".claude", "projects", "-x");
  await writeTranscript(path.join(codex, "rollout-a.jsonl"), codexLines(first), "2026-10-01T10:00:00Z");
  await writeTranscript(path.join(codex, "rollout-b.jsonl"), codexLines(second), "2026-10-02T10:00:00Z");
  await writeTranscript(path.join(codex, "rollout-c.jsonl"), codexLines(removed), "2026-09-30T10:00:00Z");
  // The holder opened itself counts there too.
  await writeTranscript(path.join(claude, "a.jsonl"), claudeLines(codexApp), "2026-09-28T10:00:00Z");
  // Inside a repository the repository is the project, dated folder or not.
  await writeTranscript(path.join(codex, "rollout-d.jsonl"), codexLines(inRepo), "2026-09-29T10:00:00Z");
  // The temporary folder, under either name it is written as, is nobody's project.
  await writeTranscript(path.join(claude, "b.jsonl"), claudeLines(scratchWork), "2026-09-27T10:00:00Z");
  await writeTranscript(path.join(claude, "c.jsonl"), claudeLines(path.join(home, "tmp-link", "elsewhere")), "2026-09-26T10:00:00Z");
  await writeTranscript(path.join(claude, "d.jsonl"), claudeLines(path.join(home, "tmp-link")), "2026-09-25T10:00:00Z");

  const temp = [[path.join(home, "tmp-link"), scratch], [scratch, scratch]];
  const result = await conversationProjects({ home, temp });
  assert.deepEqual(result.projects.map(({ scope, ...project }) => project), [
    { path: codexApp, name: "Codex", sessions: 4, lastAt: "2026-10-02T10:00:00.000Z", agents: { claude: 1, codex: 3 }, exists: true, git: false, folded: true, folders: 4 },
    { path: repo, name: "repo", sessions: 1, lastAt: "2026-09-29T10:00:00.000Z", agents: { claude: 0, codex: 1 }, exists: true, git: true, folded: false, folders: 1 },
  ]);
  assert.equal(await projectFolder(scratchWork, { home, temps: temp }), null);
  assert.equal(await projectFolder(path.join(home, "tmp-link"), { home, temps: temp }), null);
});

test("an app's folder inside a hidden folder of home is left out, the hidden folder and a repository in one are not", async (t) => {
  const home = await tempDir(t);
  const pencil = path.join(home, ".pencil", "documents", "0f4c2a9e-3b1d-4c55-9a8e-2d7f1b6c3e10");
  const pluginCache = path.join(home, ".claude", "plugins", "cache", "honcho-agent-bridge", "honcho-agent-bridge", "0.3.10");
  const settings = path.join(home, ".claude");
  const nvim = path.join(home, ".config", "nvim");
  for (const folder of [pencil, pluginCache, path.join(nvim, ".git"), path.join(nvim, "lua")]) await fsp.mkdir(folder, { recursive: true });
  const claude = path.join(home, ".claude", "projects", "-x");
  await writeTranscript(path.join(claude, "pencil.jsonl"), claudeLines(pencil), "2026-10-04T10:00:00Z");
  await writeTranscript(path.join(claude, "cache.jsonl"), claudeLines(pluginCache), "2026-10-03T10:00:00Z");
  await writeTranscript(path.join(claude, "settings.jsonl"), claudeLines(settings), "2026-10-02T10:00:00Z");
  await writeTranscript(path.join(claude, "nvim.jsonl"), claudeLines(path.join(nvim, "lua")), "2026-10-01T10:00:00Z");
  // A worktree an agent app made and has since removed was a repository all the same.
  const worktree = path.join(home, ".codex", "worktrees", "94cb", "neuromem");
  await writeTranscript(path.join(claude, "worktree.jsonl"), claudeLines(worktree), "2026-09-30T10:00:00Z");

  const result = await conversationProjects({ home, temp: [] });
  assert.deepEqual(result.projects.map((project) => project.path), [settings, nvim, worktree]);
  assert.equal(result.withoutFolder, 0, "left out, not counted as a transcript without a folder");
  assert.equal(await projectFolder(pencil, { home, temps: [] }), null);
  assert.equal(await projectFolder(path.join(nvim, "lua"), { home, temps: [] }), nvim);
  assert.deepEqual([pencil, pluginCache, settings, path.join(nvim, "lua")].map((cwd) => unlistedFolder(cwd, { home, temps: [] })), [true, true, false, false]);
});

test("the system's temporary folders are the ones that do not hold home", () => {
  const temps = systemTempFolders(os.homedir());
  const real = fs.realpathSync(os.tmpdir());
  assert.ok(temps.some(([name, folder]) => name === os.tmpdir() && folder === real));
  // Longest first, so the most specific name is matched first.
  assert.deepEqual(temps.map(([name]) => name.length), temps.map(([name]) => name.length).sort((a, b) => b - a));
  assert.ok(!systemTempFolders(path.join(real, "someone")).some(([, folder]) => folder === real));
  assert.equal(datedParent(path.join("/Users", "x", "dev", "2026-10-012")), null);
  assert.equal(datedParent("/2026-10-01/x"), null);
});

test("automation sessions are left out, and a transcript without a folder is counted apart", async (t) => {
  const home = await tempDir(t);
  const project = path.join(home, "project");
  await fsp.mkdir(path.join(project, ".git"), { recursive: true });
  const codex = path.join(home, ".codex", "sessions", "2026", "10", "02");
  const claude = path.join(home, ".claude", "projects", "-x");

  await writeTranscript(path.join(codex, "rollout-root.jsonl"), codexLines("/"));
  await writeTranscript(path.join(codex, "rollout-symphony.jsonl"), codexLines(path.join(home, ".symphony", "workspaces", "TEAM-1")));
  await writeTranscript(path.join(claude, "symphony.jsonl"), claudeLines(path.join(home, ".symphony", "workspaces", "TEAM-2", "src")));
  // A cwd outside session_meta is not the session's folder.
  await writeTranscript(path.join(codex, "rollout-nometa.jsonl"), lines({ type: "turn_context", payload: { cwd: project } }));
  await writeTranscript(path.join(claude, "nocwd.jsonl"), lines({ type: "summary", summary: "x" }, { type: "user", cwd: "" }));
  await writeTranscript(path.join(claude, "empty.jsonl"), "");
  await writeTranscript(path.join(claude, "relative.jsonl"), claudeLines("some/where"));
  // The folder lies past the first 512 KB, which is all that is read.
  await writeTranscript(path.join(claude, "late.jsonl"), lines({ type: "summary", summary: "x".repeat(520 * 1024) }, { cwd: project }));
  // Broken lines are skipped, and a last line with no newline still counts.
  await writeTranscript(path.join(claude, "unterminated.jsonl"), `not json\n{"cut":\n${JSON.stringify({ cwd: project })}`);
  await writeTranscript(path.join(codex, "rollout-kept.jsonl"), codexLines(project));

  const result = await conversationProjects({ home });
  assert.equal(result.scanned, 10);
  assert.equal(result.withoutFolder, 5);
  assert.deepEqual(result.projects.map(({ path: where, sessions, agents }) => ({ where, sessions, agents })), [
    { where: project, sessions: 2, agents: { claude: 1, codex: 1 } },
  ]);
});

test("the transcript folders in the configuration are the ones read", async (t) => {
  const home = await tempDir(t);
  const project = path.join(home, "project");
  await fsp.mkdir(project, { recursive: true });
  const claudeRoot = path.join(home, "elsewhere", "claude");
  const codexRoot = path.join(home, "elsewhere", "codex");
  await writeTranscript(path.join(claudeRoot, "-p", "a.jsonl"), claudeLines(project));
  await writeTranscript(path.join(codexRoot, "x", "y", "rollout-a.jsonl"), codexLines(project));
  await writeTranscript(path.join(home, ".claude", "projects", "-p", "ignored.jsonl"), claudeLines(project));

  const config = { sources: { claude: { root: claudeRoot }, codex: { root: codexRoot } } };
  const result = await conversationProjects({ config, home });
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.projects[0].agents, { claude: 1, codex: 1 });

  // Backfill's own lookup, with the same configuration, finds the same files.
  assert.deepEqual(await transcriptFiles(config, "claude"), [path.join(claudeRoot, "-p", "a.jsonl")]);
  assert.deepEqual(await transcriptFiles(config, "codex"), [path.join(codexRoot, "x", "y", "rollout-a.jsonl")]);
});

test("a second look reads again only the transcripts that changed", async (t) => {
  const home = await tempDir(t);
  const first = path.join(home, "first");
  const other = path.join(home, "other");
  const second = path.join(home, "second");
  const longer = path.join(home, "second-renamed");
  for (const folder of [first, other, second, longer]) await fsp.mkdir(folder, { recursive: true });
  const claude = path.join(home, ".claude", "projects", "-p");
  const kept = path.join(claude, "kept.jsonl");
  const changed = path.join(claude, "changed.jsonl");
  await writeTranscript(kept, claudeLines(first), "2026-10-01T00:00:00Z");
  await writeTranscript(changed, claudeLines(second), "2026-10-02T00:00:00Z");

  const before = await conversationProjects({ home });
  assert.deepEqual(before.projects.map((project) => project.path), [second, first]);

  // Same size and time as before: taken from the cache, so the new folder is not seen.
  assert.equal(first.length, other.length);
  await writeTranscript(kept, claudeLines(other), "2026-10-01T00:00:00Z");
  // A different size: read again.
  await writeTranscript(changed, claudeLines(longer), "2026-10-02T00:00:00Z");

  const after = await conversationProjects({ home });
  assert.deepEqual(after.projects.map((project) => project.path), [longer, first]);
});

test("a project's scope follows its repository's origin, so every clone of it has the same one", async (t) => {
  const home = await tempDir(t);
  const first = path.join(home, "dev", "honcho");
  const second = path.join(home, "work", "honcho-copy");
  const worktree = path.join(home, "dev", "honcho-wt");
  const plain = path.join(home, "dev", "notes");
  for (const folder of [path.join(first, ".git"), path.join(second, ".git"), worktree, plain]) await fsp.mkdir(folder, { recursive: true });
  await fsp.writeFile(path.join(first, ".git", "config"), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/else.git\n[remote "origin"]\n\turl = git@github.com:Team/Honcho.git\n');
  await fsp.writeFile(path.join(second, ".git", "config"), '[remote "origin"]\n\turl = https://user@github.com/team/honcho/\n');
  // A worktree's .git is a file naming its gitdir, whose commondir holds the config.
  await fsp.mkdir(path.join(first, ".git", "worktrees", "wt"), { recursive: true });
  await fsp.writeFile(path.join(first, ".git", "worktrees", "wt", "commondir"), "../..\n");
  await fsp.writeFile(path.join(worktree, ".git"), `gitdir: ${path.join(first, ".git", "worktrees", "wt")}\n`);

  assert.equal(normalizeRemote("git@github.com:Team/Honcho.git"), "github.com/team/honcho");
  assert.equal(normalizeRemote("ssh://git@github.com:22/team/honcho.git"), "github.com/team/honcho");
  assert.equal(normalizeRemote("file:///srv/repo"), null);
  assert.equal(await gitRemote(first), "github.com/team/honcho");
  assert.equal(await gitRemote(worktree), "github.com/team/honcho");
  assert.equal(await gitRemote(plain), null);

  const [a, b, c, d] = await Promise.all([first, second, worktree, plain].map((folder) => projectScope(folder)));
  assert.match(a.id, /^p-[0-9a-f]{12}$/);
  assert.equal(a.id, b.id, "two clones of one repository share a scope");
  assert.equal(a.id, c.id, "so does a worktree of it");
  assert.equal(a.name, "honcho");
  assert.equal(b.name, "honcho-copy");
  assert.notEqual(d.id, a.id);
  assert.equal((await projectScope(path.join(home, "elsewhere", "notes"))).id, d.id, "a folder with no remote goes by its name");

  // A session's project is its repository's root, as in the list.
  assert.equal(await projectFolder(path.join(first, ".git"), { home }), first);
  assert.equal(await projectFolder("/", { home }), null);
  assert.equal(await projectFolder("relative/path", { home }), null);
});
