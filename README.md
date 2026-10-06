# Honcho Agent Bridge

Collector, installer and plugin for one person's self-hosted Honcho memory. Reads
Codex / Claude Code / agy / Grok CLI / ChatGPT conversations and writes them into
that person's Honcho.

## Read this first (for agents)

This is one of three repositories that make up the memory system, all in the
`team-memory-system` organization. Any of them can be the place you landed, so
here is the whole map.

`honcho-selfhost` keeps official Honcho in a submodule and its core changes in
patches. This installer (0.3.5+) prepares that source before installing it, so the
installed server keeps the same flat Docker build layout. Both source downloads
are pinned to full commits in `server/*-source.json`; `.honcho-source.json` inside
the installed Honcho source records the official commit and patch checksums.

| Repository | What it is | Installed where |
|---|---|---|
| [`honcho-selfhost`](https://github.com/team-memory-system/honcho-selfhost) | The memory server. A fork of `plastic-labs/honcho` (AGPL-3.0), with the MCP bridge and dashboard inside it | One computer per person |
| **`honcho-agent-bridge`** (this one) | Collector, installer, diagnostics, release builder, agent plugin | Every machine that runs an agent |
| [`subscription-gateway`](https://github.com/team-memory-system/subscription-gateway) | Subscription-to-API gateway with its own login screen, also usable on its own (AGPL-3.0) | The computer that runs Honcho; `server prepare` fetches the pinned source revision and runs the gateway's own install |

**Topology.** One Honcho and one database per person; that person's several machines
all feed the same one. Teammates do not share a database. What is shared is a single
MCP tool, `chat`, on a second bridge process beside the server, which a teammate
reaches after a Google login through Cloudflare Access — so a teammate can ask a
question and gets an answer, without reading the underlying messages.

### What this repository does

1. **Collect.** An agent's Stop hook runs `scripts/main.mjs`, which reads that
   turn's transcript file and posts new messages to Honcho. There is no daemon:
   the hook is invoked by the agent, once per turn. Failed writes are queued in a
   spool and retried on the next hook. Conversations from chosen folders can also
   go to a second server (`target ...`, `scripts/targets.mjs`); each such server
   has its own spool and dedupe state.
2. **Install.** `scripts/cli.mjs` detects agents, previews changes, backs up what it
   edits, and writes the hook.
3. **The Team Memory app.** `scripts/ui.mjs` serves `ui/`, one screen over all three
   programs, in six menus. 대시보드, the first screen after setup, shows at a glance
   how this computer's memory stands: what waits on this computer to be sent, how
   many conversations the server holds, how far Honcho has got putting them in
   order, and the gateway, models, backup and sharing; nothing on it is a link. 기억
   reads and searches the memories and asks Honcho or a gateway model. 내 컴퓨터
   sets up collection, sends chosen projects' conversations to other servers too,
   switches this computer's MCP tools, opens the server to the owner's other
   computers and imports ChatGPT. 팀 shares the memory with teammates, reads the
   audit log and connects teammates' memories. 서버 runs the server (기억 서버) and,
   on 모델, the subscription gateway, the embedding model and the model the server
   uses; 백업 copies the raw conversations every day at the hour chosen.
   Setup steps run the same CLI a terminal would; memories, the gateway and the
   audit log are relayed to those programs' own APIs by `scripts/app-api.mjs`,
   which adds the Honcho token so the page never holds it.
   `cli.mjs ui open` starts it detached (default `http://127.0.0.1:4180`) and opens
   the browser, which is how `/memory-setup` shows it.
4. **Run the local stack.** `server ...` drives the Honcho Docker stack;
   `host ...` installs the subscription gateway through its own CLI and supervises
   Ollama. Every chat model Honcho uses goes through the gateway's router; the router
   key comes from the gateway, not from the person installing.
5. **Recall.** `scripts/mcp-server.mjs` is a stdio MCP server for this computer's
   own memory: the local recall tools, filtered by `mcp-tools.json`, and none until
   setup has given this computer a user peer. A teammate's memory does not go
   through it. Each teammate's server is a remote MCP server of its own,
   `team-<name>` at `https://<host>/mcp`, that `teammates connect` adds to Claude
   Code and Codex, and each client logs in to it itself (see [Asking a teammate's
   memory](#asking-a-teammates-memory--팀원-기억-연결)).
6. **Recall at the start of work.** `scripts/recall.mjs` is meant for Claude Code's
   SessionStart (`session-start`, on startup and `/clear`) and UserPromptSubmit
   (`prompt`) hooks. At session start it adds the short summary of the last
   conversation in the same folder and the judgment-like conclusions of the recent
   ones. On the first real request it searches conclusions with the request, this
   folder's sessions first, then the rest of memory. It never sends the peer card,
   and it drops the boilerplate the deriver made out of stored compaction summaries.
   It prints nothing when Honcho is slow or down. It is not yet in
   `hooks/claude-hooks.json` or the installer; on a machine that runs this checkout
   directly, add the two hooks to `~/.claude/settings.json` by hand.

### Things that will bite you

- **After a reboot everything comes back at login by itself; nobody has to press
  start.** The gateway's own `install`, which `server prepare` and `host start` run,
  registers the gateway's per-user autostart (reported under `gateway` as
  `autostart`). `host start`, and so `server start` and the setup UI's start button,
  registers one for the host supervisor too, and starts the supervisor through it.
  Neither needs admin rights:

  | Platform | Host supervisor autostart | Logs |
  | --- | --- | --- |
  | macOS | LaunchAgent `~/Library/LaunchAgents/team-memory-system.host.plist` (RunAtLoad, `KeepAlive {SuccessfulExit: false}`) | `runtime/host/logs/supervisor.log`, `supervisor.error.log` |
  | Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `TeamMemoryHost`, a hidden `wscript` running `runtime/host/supervisor.vbs` | `runtime/host/logs/supervisor.log` |
  | Linux | systemd user unit `team-memory-host.service` (`Restart=on-failure`) | `runtime/host/logs/supervisor.log`, `supervisor.error.log` |

  Each runs exactly what `host start` would spawn: the `node` that ran `host start`
  (by absolute path, so a `host start` after a Node upgrade rewrites it), the
  supervisor, and `--config runtime/host/host-config.json --log
  runtime/host/logs/supervisor.log`; the log is rotated to `supervisor.log.1` past
  10 MB. A second supervisor finds the first through its PID file and exits 0, and a
  stop exits 0 too, so launchd and systemd restart only a crash and never loop on a
  duplicate; a missing host config also exits 0, since no restart fixes it. On
  Windows the Run value takes effect at the next logon, so `host start` spawns the
  same command itself. Where no autostart can be registered (no systemd user
  session, say), `host start` still starts the supervisor and reports
  `autostart.error` and a warning. `host status` and `server status --profile
  personal` report `autostart: {registered, kind}`.

  At login the supervisor may start before Docker Desktop, the gateway, or Ollama's
  own app; it waits for them instead of exiting. It never uses Docker. An Ollama this
  app did not download gets 60 seconds to answer before the supervisor starts
  `ollama serve` itself, and a failed warmup is retried after 5 seconds, doubling up
  to the 5-minute warm interval. An Ollama the app downloaded itself
  (`runtime/ollama`) has no app or service of its own and is started at once; the
  supervisor starts it again within 15 seconds whenever it stops answering.

  `host stop` and `server stop` remove the supervisor's autostart first (launchd and
  systemd stop the supervisor as they do), so it stays down after the next reboot;
  if the autostart cannot be removed, they report `ok: false`. They leave the
  gateway running; `node <app-dir>/runtime/subscription-gateway/gateway/cli.mjs
  uninstall` removes it.
- **A changed `gateway-source.json` replaces the gateway.** The next `server prepare`
  or `host start` fetches the new copy, runs the old copy's own `uninstall` (its
  autostart removed, what it started stopped, logins kept) so nothing holds the
  folder open on Windows, keeps the old copy as `.previous`, and installs the new
  one. If the swap still fails, the result says so, including a failed uninstall. An
  old copy that had already uninstalled itself is put back and installed again, best
  effort, so the gateway keeps serving (`restored`, and `restoreError` when that
  install fails); the next run uninstalls it first again. A folder there that this
  installer did not fetch is never uninstalled or replaced.
- **The gateway's logins are its own.** A Codex or Claude login made in the gateway
  screen lives in the gateway's app directory (`SubscriptionGateway`), apart from the
  user's own `codex` and `claude` logins; `codex login` and `~/.codex/auth.json` play
  no part. Until one login is connected, `server prepare` stops with
  `nextAction.kind: "gateway-login"` and the screen's address.
- **The chat model sticks until `--model` changes it.** Every prepare, including the
  one `server start` runs, keeps the model the installed `.env` already uses while
  the gateway offers it (`chatModelSource: "kept"`). Only a fresh install, or a model
  the gateway stopped offering, goes back to the first of `gpt-6-luna`,
  `gpt-5.6-luna`, `gpt-5.5`, `claude-haiku-4-5`, `claude-sonnet-5-5` it offers
  (`"default"`). Logging in to another subscription later does not switch it;
  `server prepare --model <id>` does (`"override"`).
- **The hook is what keeps collection alive.** Changing the hook command format has
  happened twice already; `LEGACY_HOOK_MARKERS` in `scripts/cli.mjs` exists so the
  installer can still recognise and clean up hooks it wrote under an older name.
- **One Codex thread can span several files.** Codex writes a long thread as
  `rollout-<ts>-<A>.jsonl` plus continuation segments `rollout-<ts>-<A>_<B>.jsonl`
  (`history_mode: "paginated"`), all with session id A and lines numbered from 1.
  A segment's turns are identified by session, segment B, line and role
  (`scripts/turn-identity.mjs`); every other file keeps the line identity. The first
  time a segment is read, the collector rebuilds the hashes of the turns Honcho
  already holds from it through each message's `codex_rollout_path`, and imports
  nothing while Honcho cannot list them (`SEGMENT_SYNC_FAILED` in the log). New
  segment messages carry `codex_segment_id`. Rolling back to a collector without
  this sends segment turns again. Before 2026-10-05 a segment turn at the same line
  and role as an earlier file's was skipped; on the owner's Mac those were sent
  then (`memory_trigger` `segment_backfill`, plus `segment_backfill_recheck` for
  parent-file tails).
- **Only what the person typed goes in as their words.** The parsers drop what the
  app wrote in the user role: Codex's in-app browser and Chrome tab state, IDE
  context, mentioned-file lists and ChatGPT reference previews in front of
  `## My request:` (what follows is kept whole), `<user_instructions>`,
  `<user_action>`, `<user_shell_command>`, image markers, and a goal continuation
  except its objective (once per file); Claude rows marked `isMeta`, except a
  command or typed slash command with arguments and a goal reminder. Turn
  identities hold no text, so changing a filter never sends a turn again. Messages
  stored before 2026-10-05 still hold such text.
- **The owner's machine is hand-wired, not installed.** Its hooks read
  `~/.config/codex-honcho-sync/.env` and use `CODEX_HONCHO_SYNC_ROOT`. Those names
  are deliberately left at the old spelling: renaming them buys nothing and can
  stop live collection. The installed layout under
  `~/Library/Application Support/HonchoAgentBridge` is the one this code creates.
  Its gateway runs from `~/dev/subscription-gateway` under the LaunchAgent
  `subscription-gateway.ui`; `server prepare` or `host start` there would fetch a
  second gateway into the app directory and run that copy's `install`.
- **`setup` rebuilds `config.json` from scratch.** Anything it does not own must be
  carried through explicitly. The shared-bridge fields of 0.3.28 and before
  (`OLD_RELAY_FIELDS` in `scripts/cli.mjs`) are dropped on purpose, and `bridge
  disconnect` removes them on a computer that never runs setup again.
- **The memory server's Access service token.** `honcho.access.{clientId,clientSecret}`
  is written only by `setup` from `HONCHO_CF_ACCESS_CLIENT_ID/SECRET`, for a server
  whose Access application also covers `/v3`; a server shared by this app needs
  none (see [Collecting from another computer](#collecting-from-another-computer)).
  Every request to `honcho.baseUrl` builds its headers with `honchoHeaders` in
  `scripts/honcho-access.mjs`, and goes through `fetchHoncho`, which follows
  redirects only within that origin so an Access login redirect is seen, not
  followed.
- **Everyone on the team list can ask about the whole memory.** A shared server's
  `chat` is pinned to the owner's workspace and peer, and the bridge refuses any
  other `workspace_id`, peer or filter, but nothing yet limits a question to a
  project: whoever passes the Access login can ask about anything that peer's
  memory holds.
- **An install shared under 0.3.28 or before stops sharing on update.** Its tunnel
  ran on the host. `server prepare` and `server start` remove that autostart
  (moving its token into the `.env` when the `.env` has none), and drop `share` from
  `COMPOSE_PROFILES` while `HONCHO_TUNNEL_TOKEN`, `HONCHO_TEAM_MCP_TOKEN` or
  `HONCHO_TEAM_PEER` is empty, so the new `tunnel` and `mcp` services never restart
  in a loop. The result says so in `share` and `warnings`; turn sharing on again
  with `server share enable` (or `server share join` on a teammate's computer).
- **Secrets are never in this repository.** Tokens live in the installed private
  `config.json` and `.env`, and in 1Password. `assertNoSecretFields` rejects a host
  profile that carries one. The gateway's router key comes from its `connect-info`,
  is written only into the installed private `.env`, and appears in no result this
  CLI prints; `scripts/gateway.mjs` hands it on as a non-enumerable property.
- **CLI output redacts by field name.** `scripts/redact.mjs` prints any field whose
  name contains token, secret, api key, authorization or client id as `"[redacted]"`, whatever
  it holds. A field that only lists setting NAMES has to be in `NAME_ONLY_FIELDS`
  there, or it prints as `"[redacted]"` too; `missingSecretFields` did until
  2026-09-30, so a portable install could not see which keys to fill in.
- **`--profile personal` needs macOS or Windows.** Native Linux cannot reach the
  loopback-only host services from Docker; use `--profile portable` there.
- **Codex also reads a plugin's `hooks/hooks.json`.** Codex 0.157 loaded the Claude
  Stop hook from there and offered it for approval next to its own, so the Claude
  hook lives in `hooks/claude-hooks.json` and only `.claude-plugin/plugin.json`
  names it. Codex's hook is the one `setup apply` writes into `~/.codex/hooks.json`;
  Codex asks the user to approve it before it runs. `main.mjs` also drops a Stop
  payload whose transcript belongs to the other host.
- **Codex stops running a hook whose command changed.** Its trust turns to
  `modified` (`hooks/list` shows it), and the hook does not run until the user
  approves it again in the Codex app or with `/hooks`. For a one-off test,
  `codex exec --dangerously-bypass-hook-trust` runs it anyway.
- **On Windows the two hosts run hooks through different shells.** Codex uses
  `cmd.exe /C`, Claude Code uses Git Bash. `node "C:/Users/<you>/…/scripts/main.mjs"
  --provider codex` works in both: plain `node` from `PATH`, forward slashes, and
  the path in double quotes. It also survives a Node upgrade through winget.
- **A computer that already has conversations sends each one whole on its next
  Stop.** The state files (`<dataDir>/state/codex.json`, `claude.json`) record which
  turns were sent. With no state, the next Stop in an older session sends that
  session's whole history, unless Honcho already holds it. On one Windows PC on
  2026-10-05 that would have been 3,360 Codex and 1,043 Claude turns.
  `main.mjs --provider <p> --transcript <file> --dry-run` shows what a Stop would
  send. When those conversations reach the server another way, mark their current
  turns as sent before the hook goes on. No command does this; that PC's state was
  written by a one-off script over the collector's own parsers and
  `turnHashCandidates`.
- **Grok CLI also runs Claude Code's hooks.** It loads `~/.claude/settings.json`
  too, and hands those hooks its own `updates.jsonl` as `transcript_path`; `main.mjs`
  drops such a payload for claude and codex. Hooks there that need environment
  variables fail inside Grok with "required env var(s) not set", which Grok ignores.
  `[compat.claude] hooks = false` in `~/.grok/config.toml` would stop that, but it
  turns off every other Claude hook in Grok as well.
- **A Grok hook command must not contain `$` or `${…}`.** Grok checks environment
  references before any shell starts, so in August all 392 runs of such a hook
  failed. Source an env file by absolute path instead. The owner's hook is
  `~/.grok/hooks/honcho-sync.json`, which needs no trust approval:
  `/bin/sh -lc 'set -a; . /Users/<you>/.config/codex-honcho-sync/.env; set +a; exec
  /opt/homebrew/bin/node /Users/<you>/…/scripts/main.mjs --provider grok'`.
- **Grok's transcript is not the file its hook names.** The payload's
  `transcript_path` is `updates.jsonl`; the collector reads `chat_history.jsonl`
  beside it, and a session without one queues nothing. A turn is identified by
  `grok-<session id>` plus line number and role. Typed prompts are the
  `<user_query>` lines; the `<user_info>` line and every line with a
  `synthetic_reason` are Grok's own and are dropped. Whether `/compact` rewrites
  `chat_history.jsonl`, which would shift those line numbers, has not been checked.
- **agy's hook lives in `~/.gemini/config/hooks.json`** (the named hook
  `honcho-write`). Its payload keys are camelCase, such as `transcriptPath`, and
  `normalizeHookInput` in `main.mjs` maps them.
- **A new server does not assume 8001 and 4173 are free.** `server prepare` picks the
  first free port from each (another Honcho or an SSH tunnel often holds 8001) and
  writes `HONCHO_API_PORT` / `HONCHO_DASHBOARD_PORT` into the installed `.env`; an
  installed server keeps its ports. `start`, `status`, `verify`, `detect` and
  `setup`'s default `--honcho-url` all read them from there.
- **A Honcho answering on loopback is not necessarily this install's.** `detect` and
  `setup plan` report `managedByThisInstall: false` / `connect-unknown-existing` when
  the port is not published by this plugin's Compose project.

### Verify a change

```sh
npm test          # 422 tests, no network, no Docker
node scripts/cli.mjs detect
node scripts/cli.mjs doctor
npm run ui        # the Team Memory app on localhost
```

Tests are the contract. Several of them exist specifically to fail when something
drifts: the tool count in `tests/mcp-server.test.mjs`, the setup and connect forms'
field names in `tests/ui.test.mjs`, the CLI never printing the Cloudflare API token,
a tunnel token or an invite in `tests/team-access.test.mjs`, the absence of any
OS-registration call in `tests/host-manager.test.mjs`, and the gateway's router key
never appearing in a returned result in `tests/gateway.test.mjs` and
`tests/server-manager.test.mjs`.

### Licence

MIT. This repository contains no Honcho source: `scripts/build-distribution.mjs`
copies the server into `server/honcho/` inside a release bundle at build time, and
copies `HONCHO-LICENSE-AGPL-3.0.txt` next to it. A built bundle is therefore a
combined work carrying AGPL-3.0 code; this repository on its own is not.
`honcho-selfhost` and `subscription-gateway` are AGPL-3.0 and separate. The gateway
is fetched at install time into the app directory and runs as its own program; no
release bundle contains it.

---

## Detail

The repository bundles the conversation collectors, setup/diagnostic workflow, a dependency-free MCP bridge, and a release builder for the complete local Honcho Docker stack. It does not publish or download an npm package.

## Current scope

- Capture Codex, Claude Code, agy and Grok CLI conversations from their Stop hooks into one personal Honcho workspace, and import a ChatGPT export once.
- Recall memory through the Honcho tools exposed by the bundled MCP server: 19 recall tools by default, and 12 memory-changing tools once enabled.
- Detect installed agents, preview setup changes, preserve unrelated settings, and create backups.
- Run on macOS, Windows, and Linux wherever a recent Node.js runtime is available.

- Also send the conversations from chosen folders to a second server, such as the company's shared Honcho (see "Also sending some folders to another server").
- Let teammates ask one's memory through `chat` after a Google login through Cloudflare Access, and ask theirs the same way (see "Sending to this server from other computers" and "Asking a teammate's memory").

Cross-device database synchronization is intentionally deferred until the personal-memory package is complete.

## Prerequisites

- Node.js 18 or newer.
- Docker Desktop/Engine with Compose when installing the bundled local Honcho server (`server prepare` starts a closed Docker Desktop on macOS and Windows and waits for its engine), or an existing Honcho API. For your own server on another computer, see [Collecting from another computer](#collecting-from-another-computer).
- This repository installed as a plugin in each agent host that should receive Honcho MCP tools.
- For sharing, the team's owner only: a Cloudflare account with a domain on it, Zero Trust with a Google login method, and an API token (see [What the owner needs in Cloudflare](#what-the-owner-needs-in-cloudflare)). Teammates need only a Google account.

`prereqs [--features server,sync]` reports Node.js and git for both, and Docker and Ollama for `server`. The app's 시작하기 first asks where the memory server is: on this computer (`server,sync`) or on another of the user's computers (`sync`). Asking a teammate's memory is set up later, from 팀 → 팀원 기억 연결.

The `personal` profile also requires macOS or Windows, git, and a Codex and/or Claude subscription. Docker Desktop and Ollama are fetched by the app when this computer has neither (see [Docker Desktop and Ollama](#docker-desktop-and-ollama)). `server prepare` installs the subscription gateway and stops once to ask for a login with that subscription in the gateway's own screen; nothing reads `~/.codex/auth.json`, and no key is typed anywhere. Native Linux currently supports the `portable` profile; its Docker bridge cannot safely reach the personal profile's loopback-only host services without an additional binding design.

On Windows, Docker Desktop must use its WSL 2 backend and hardware virtualization must be enabled. `server plan` checks Docker CLI/Compose and engine health and whether git can fetch the gateway; personal preparation installs the gateway (its own install brings its npm dependencies) and checks Ollama and its local API, and the required base/alias/context. Docker engine readiness is the current gate for the WSL backend: setup does not independently enable WSL beyond what Docker's installer does, or preflight every port. If Docker or WSL asks for a reboot, restart Windows and run the same plan again.

### Docker Desktop and Ollama

With `--profile personal` on macOS (Apple Silicon or Intel) or Windows 11, a missing Docker Desktop or Ollama is not an issue: `server plan` lists `install-docker-desktop {url, destination}` and `install-ollama {url, destination}` first, and `server prepare` runs them before anything else. Downloads stream to `<app dir>/runtime/downloads/<name>.part` and are renamed only when complete; a failed download removes the `.part` and names the URL. Each action reports its byte size and what was verified.

- **Ollama** is found on `PATH`, as the macOS app's CLI (`/Applications/Ollama.app/Contents/Resources/ollama`), as the Windows installer's `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`, or as the app's own copy in `<app dir>/runtime/ollama`. When there is none, prepare downloads the standalone build from `https://github.com/ollama/ollama/releases/latest/download/` (`ollama-darwin.tgz`, `ollama-windows-amd64.zip` or `ollama-windows-arm64.zip`), checks it against that release's `sha256sum.txt` (a mismatch deletes it), unpacks it whole with the system `tar` so its libraries stay beside the binary, and runs `ollama --version`. No admin rights are needed. Models stay in Ollama's default directory (`~/.ollama`). The app starts `ollama serve` for its own copy (see the reboot note above).
- **Docker Desktop** on macOS: `Docker.dmg` for this Mac's processor is mounted read-only, its `Docker.app` must pass `codesign --verify --deep --strict`, carry Docker's Team ID `9BNSXJN65R` and be accepted by `spctl -a`, and is then copied to `/Applications` with `ditto` (an administrator account can do this without sudo; Docker documents no other location, so a non-admin account gets a clear issue). The app is opened, and prepare waits up to 3 minutes for the engine while Docker's first-run window asks to accept its terms and, for the recommended settings, the macOS password. Until its first run links the CLI onto `PATH`, every docker call uses `Docker.app/Contents/Resources/bin/docker`.
- **Docker Desktop** on Windows: `Docker Desktop Installer.exe` must have a valid Authenticode signature from Docker Inc; it then runs elevated (`install --accept-license --quiet`, so Windows shows its administrator prompt), `wsl --status` is checked, and `Docker Desktop.exe` is started. A restart the installer (exit 3010/1641) or WSL asks for returns `nextAction: {"kind": "restart-required"}`; a declined prompt returns `docker-install-approval`.
- When the engine is not up in time, prepare returns `ok: true, ready: false` with `nextAction: {"kind": "docker-first-run", "app": ...}` and changes nothing else; running prepare again continues from there.
- Docker publishes no checksum for these unversioned downloads, which is why the signature is what is checked.
- Docker Desktop is free for personal use, education, non-commercial open source projects and small businesses (fewer than 250 employees and less than $10 million in annual revenue); larger companies and government entities need a paid Docker subscription. The plan repeats this as a warning.

Git is still a prerequisite. When git is absent, the setup skill offers an explicitly confirmed installation through the detected platform's official package manager or vendor installer, then reruns the prerequisite checks. System software installation is never hidden inside the release archive.

One setup run can enable conversation collection for every detected agent, and it puts the plugin into each of those hosts that does not have it yet (see [Plugin installation](#plugin-installation)).

## Plugin installation

Install the plugin in the host you start from; one of these pairs is enough:

```sh
codex plugin marketplace add team-memory-system/honcho-agent-bridge
codex plugin add honcho-agent-bridge@honcho-agent-bridge

claude plugin marketplace add team-memory-system/honcho-agent-bridge
claude plugin install honcho-agent-bridge@honcho-agent-bridge
```

`setup apply` puts the plugin into the other host for you. For every agent it turns collection on for, it looks at that host's plugin. A host where the plugin is missing gets the plugin installed with its own CLI, as an `install-plugin` operation in the plan. Claude Code's Stop hook ships only inside the plugin, and Codex gets its skills and recall MCP server from it.

- **Source.** The other host's marketplace record says where this plugin came from:
  - Claude Code's `~/.claude/plugins/known_marketplaces.json`;
  - Codex's `[marketplaces.<name>]` in `~/.codex/config.toml`.

  A GitHub repository (with its ref), a git URL or a local directory is used as it is. Without a record, the source is `team-memory-system/honcho-agent-bridge`. On Windows a local directory falls back to it too, because a backslash path cannot pass the CLI argument check.
- **Commands.**
  - Codex runs `codex plugin marketplace add <source> [--ref <ref>]`, then `codex plugin add honcho-agent-bridge@<marketplace>`.
  - Claude Code runs `claude plugin marketplace add <source>[#<ref>]`, then `claude plugin install honcho-agent-bridge@<marketplace> --scope user`.
  - A marketplace the host already has is not added again. Claude Code would point it at the new source, and Codex refuses a second source under the same name.
  - Each command may take 180 seconds, because it clones from git.
- **Finding the Codex CLI.** Setup looks for `codex` on `PATH` first. A computer with only the desktop app falls back, in order, to:
  1. `CODEX_CLI_PATH` from the environment;
  2. `CODEX_CLI_PATH` in `~/.codex/config.toml`;
  3. the CLI inside the macOS app bundle.
- **Result.** The apply result lists `plugins: [{agent, action}]`, where `action` is `installed`, `already`, `failed` or `missing-cli`.
  - An install that fails, or finds no CLI, never fails setup or rolls it back. Its `nextSteps` entry `install-plugin` carries the two `commands` to run by hand, and the app shows them in its result.
  - A plugin that is installed but turned off stays off, and the plan warns about it.

To update an installed plugin:

```sh
claude plugin marketplace update honcho-agent-bridge
claude plugin update honcho-agent-bridge@honcho-agent-bridge

codex plugin marketplace upgrade
codex plugin add honcho-agent-bridge@honcho-agent-bridge
```

For a local checkout, pass its absolute directory instead of the repository name. Start a new Codex session or reload Claude plugins after installation. Then invoke `$setup-memory` in Codex or `/memory-setup` in Claude Code.

## Setup

Use the bundled `setup-memory` skill. It follows this sequence:

1. Detect Codex, Claude Code, the current configuration, Honcho health, and the local Docker/host-model prerequisites for the selected profile.
2. Ask which detected agents should collect conversations.
3. Offer the OS-default storage location or a custom path.
4. Show the exact installation plan without changing files.
5. Apply only after confirmation. Apply also installs the plugin into any chosen host that lacks it.
6. Run the diagnostic checks and pass on `nextSteps` from `setup apply`:
   - Codex asks the user to approve the new Stop hook in a new session (or `/hooks`).
   - Claude Code sessions opened before setup need `/reload-plugins`.
   - An `install-plugin` step lists the commands to run when setup could not install the plugin itself.

### Collecting from another computer

The memory server runs on one machine; another computer (a laptop, a work machine)
sends its conversations there through the server's Cloudflare Tunnel, once the
server is shared (see [Sending to this server from other
computers](#sending-to-this-server-from-other-computers-cloudflare--다른-컴퓨터에서-이-서버로-보내기)).
On that other computer, setup needs two things:

1. **The server's address**, with `--honcho-url https://memory.example.com`.
2. **The server's gate token** (`server share token` on the server's computer), in
   `HONCHO_API_TOKEN`.

A shared server's `/v3` and `/health` sit under a Cloudflare Access application that
lets every request through to the gate, so the gate token is what keeps them closed.
Only a server
whose Access application covers `/v3` too, set up by hand, also needs an Access
service token, in `HONCHO_CF_ACCESS_CLIENT_ID` and `HONCHO_CF_ACCESS_CLIENT_SECRET`
(both, or neither).

```bash
export HONCHO_API_TOKEN=...                   # the server's gate token
node scripts/cli.mjs setup plan --honcho-url https://memory.example.com --agents codex,claude --user-peer <id>
node scripts/cli.mjs setup apply --honcho-url https://memory.example.com --agents codex,claude --user-peer <id>
```

Setup refuses any of these secrets as command-line options, prints them only as
`"[redacted]"`, and saves them in the private `config.json` (`honcho.apiToken`,
`honcho.access`). A later setup without them keeps them while the address stays on
the same server, and drops them with a warning when it moves to another one. The
Team Memory app's setup form takes the same values and hands them to the CLI
through its environment.

The collector, the MCP server, the app and `doctor` all send the bearer token and,
when saved, the service token with every request to that server, and to no other
program. When Access refuses this computer (a 403 from Access, or a redirect to its
`*.cloudflareaccess.com` login page), `setup plan` warns that the server "is behind
Cloudflare Access and refused this computer", `doctor`'s `honcho-health` check
fails with `code: "cloudflare-access"`, and the app says so instead of reporting
the server as down. Add a service token and run setup again, or have the server's
owner turn sharing on with `--cloudflare`, which makes the `/v3` application.

### Server profiles

| Profile | What runs in Docker | What runs on the host | Model credentials | Intended use |
| --- | --- | --- | --- | --- |
| `personal` | Honcho API, Deriver, PostgreSQL/pgvector, Redis, dashboard | Subscription gateway (router 11400, screen 11450), Ollama, Qwen3-Embedding 4B (`qwen3-embedding-4b-honcho-8192`), collector and MCP bridge | A Codex and/or Claude login in the gateway's screen; the router key comes from the gateway and is written only into the installed private `.env` | macOS/Windows reproduction of this self-hosted topology with local 1536-dimensional, 8192-token embeddings |
| `portable` | Honcho API, Deriver, PostgreSQL/pgvector, Redis, dashboard | Collector and MCP bridge only | External OpenAI-compatible API key entered in the installed private `.env` | Generic installation when the personal host topology is unavailable or unwanted |

The `personal` profile requires `server/env.personal.example`, `server/host-profile.personal.json` and `server/gateway-source.json`. `server prepare --profile personal` fetches the gateway that `gateway-source.json` names into `runtime/subscription-gateway` under the app directory, runs the gateway's `install`, and asks its `connect-info` for the router address and key. Until a login is connected it returns `ready: false` with `nextAction: {"kind": "gateway-login", "url": ...}` and changes nothing installed. Once one is, it writes the router address (its host replaced by `host.docker.internal`), the key, and the chosen chat model with `THINKING_EFFORT=low` into every chat setting of the installed `.env`; embeddings stay on Ollama, and other values the user edited are kept. The chat model is `--model <id>` when given (it must be one the gateway offers), otherwise the model the installed `.env` already uses while the gateway still offers it, otherwise the first of `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.5`, `claude-haiku-4-5` and `claude-sonnet-5-5` the gateway offers, otherwise the first it lists that is not an embedding model; `chatModelSource` says which (`override`, `kept`, `default`). When the gateway offers no chat model at all, prepare stops with `ready: false`, the reason in `gateway.reason`, and the same `gateway-login` next action. Embeddings use Qwen3-Embedding 4B (`qwen3-embedding:4b`) through the alias `qwen3-embedding-4b-honcho-8192`; an install whose `.env` already names the earlier 8B alias `qwen3-embedding-honcho-8192` keeps it, since its stored vectors were made by 8B, and that alias is only ever created from `qwen3-embedding:8b`. Host prepare writes the alias's Modelfile from its own base into the host runtime directory right before `ollama create`. The host supervisor keeps the Qwen alias resident. `server stop` and `host stop` leave the gateway running.

For development or recovery, the same deterministic workflow is available directly:

```sh
node scripts/cli.mjs detect
node scripts/cli.mjs server plan --profile personal
node scripts/cli.mjs server prepare --profile personal
# If it returns nextAction "gateway-login": open the app's gateway screen, log in
# there with Codex and/or Claude, then rerun prepare.
node scripts/cli.mjs ui open --screen models
node scripts/cli.mjs server start --profile personal
node scripts/cli.mjs server status --profile personal
node scripts/cli.mjs server verify --profile personal
node scripts/cli.mjs setup plan --agents codex,claude --user-peer user_name
node scripts/cli.mjs setup apply --agents codex,claude --user-peer user_name
node scripts/cli.mjs doctor
```

For a portable install, replace `personal` with `portable`. `server prepare` reports the blank external LLM credential fields without printing their values; fill only those fields in the returned installed `.env` path before running `server start`. The collector and MCP bridge always remain on the host so they can read agent transcripts and integrate with the host tool cache. The Honcho API, dashboard, gateway, and Ollama endpoints bind to localhost; database ports are not exposed.

### Logging in to a gateway on another computer

The app's 서버 → 모델 screen (`ui open --screen models`) can finish a gateway login when
the browser is on a different computer from the gateway, such as a server without a
screen. This needs subscription-gateway `03aa85d` or newer.

- **The link:** 로그인 and 계정 추가 show the gateway's sign-in link.
- **Claude:** paste the code the page shows after signing in. It goes to
  `POST /api/gw/api/login/code`.
- **Codex:** the browser stops on a `localhost:1455/auth/callback?…` address that
  does not load. Paste the whole address. It goes to `/api/gw/api/login/callback`,
  and the gateway replays it on its own computer.
- **취소:** sends `/api/gw/api/login/cancel`.

The relay sends no `Origin`, which the gateway's same-origin rule accepts. An older
gateway sends no sign-in prompt, and the screen shows the old "브라우저에 열린 로그인
창…" notice instead.

When the screen opens, it picks up a login still waiting on the gateway. After 5
minutes it gives up and cancels the login; sending a code or an address restarts the
5 minutes.

The app finds the gateway only through `GATEWAY_UI_URL` (or `GATEWAY_UI_PORT`) in the
environment of its server process. A server that is already running keeps the
address it started with. For a gateway on another computer, open a tunnel, then start
the app's server with that address:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 21450:127.0.0.1:11450 <server>
# start the app's server with GATEWAY_UI_URL=http://127.0.0.1:21450 in its environment
```

Three things still assume the gateway is on this computer:
- the "API 주소" row, which shows the router's address as the gateway sees it;
- "게이트웨이 켜기", which starts or opens a gateway here;
- the header link to the gateway's own screen. Opened through a tunnel port, that screen's buttons only work on a gateway at `03aa85d` or newer; an older one refuses them with 403.

`server verify --profile personal` performs a production-shaped, non-destructive diagnostic: combined server status including the gateway's router health, a local Ollama embedding request proven to exceed 2048 evaluated tokens with truncation disabled and exactly 1536 output dimensions, Docker API-container access to both host services (Ollama and the router's `/health`), and Honcho health. It makes no model call by default. Add `--live-completion` only when an actual minimal completion through the router is intended; it uses the installed `.env`'s router address, key, model and effort, reads the key internally, never places it on a command line, sends it nowhere but this machine, returns only success and model, and discards the completion body.

## Sending to this server from other computers (Cloudflare) / 다른 컴퓨터에서 이 서버로 보내기

A personal server listens only on `127.0.0.1`. Sharing puts it behind a Cloudflare Tunnel with three Compose services under the `share` profile, all on the server's computer (see `server/README.md`):

- **`gate`** (`server/gate/gate.mjs`) publishes `127.0.0.1:<gate port>` (8010, or the next free port; kept in the installed `.env` as `HONCHO_GATE_PORT` once chosen). It has two ways through:
  - `GET /health` and `/v3/*`, for the owner's other computers, with `Authorization: Bearer <gate token>`, compared in constant time. The gate token is 32 random bytes, generated once into the private `.env` as `HONCHO_GATE_TOKEN`. Bodies stream both ways (dialectic SSE included), and bodies over 20 MB are refused.
  - `/mcp`, for teammates' agents, only with a verified Cloudflare Access login: `Cf-Access-Jwt-Assertion`, checked against the team's keys and the application's AUD tag, with an email in it. The gate passes the request on to `mcp` with that email.
- **`mcp`**, honcho-selfhost's MCP bridge, answers `chat` only, as `HONCHO_TEAM_PEER` in `HONCHO_TEAM_WORKSPACE`, and records each call with the caller's email.
- **`tunnel`**, `cloudflared` in a container, runs the tunnel whose token is `HONCHO_TUNNEL_TOKEN`. Its ingress, set in Cloudflare, is `http://gate:8010`.

In Cloudflare the server's hostname has two Access applications. One covers `/v3` and `/health` and lets every request through to the gate, where the gate token is the lock. The other covers the rest of the hostname: it sends people to Google login and lets in only the emails on the team list, and MCP clients log in to it through Access's Managed OAuth.

### What the owner needs in Cloudflare

Once, by hand, in the dashboard:

1. A domain (zone) on the Cloudflare account. Each server takes one hostname in it: the owner's is `<name>.<zone>`, a teammate's `memory-<name>.<zone>`.
2. Zero Trust turned on (its team domain is `<team>.cloudflareaccess.com`), with Google under Settings → Authentication → Login methods.
3. An API token with these permissions:
   - Account → Cloudflare Tunnel → Edit
   - Account → Access: Apps and Policies → Edit
   - Account → Access: Organizations, Identity Providers, and Groups → Read
   - Zone → DNS → Edit, and Zone → Zone → Read, on that zone

Zero Trust's free plan has 50 seats. A person takes a seat at their first login to any Access application on the account, not when their email goes on the list, and the seats are shared with every other application there. Taking someone off the list does not free their seat; removing the user from Zero Trust's user list does.

### Turning it on / 공유 켜기

```sh
# The API token goes in the environment, never on the command line.
CLOUDFLARE_API_TOKEN='<api token>' node scripts/cli.mjs server share enable --cloudflare --email <owner's Google email> [--name memory] [--zone <zone>] [--idp <id|name>]
node scripts/cli.mjs server share status --check
node scripts/cli.mjs server share token     # the gate token, to copy to the other computers
```

`enable --cloudflare` needs an installed personal server and a user peer (`setup apply --user-peer <id>` first: teammates' questions run as that peer). `--email` is needed the first time, `--zone` only when the token sees more than one zone, and `--idp` only when Zero Trust has more than one Google login. Through the API it makes the following, or keeps each one that is already right:

- the tunnel `team-memory-<name>` with the ingress `http://gate:8010`, and a CNAME `<name>.<zone>` to it;
- the reusable Access policies "Team Memory people" (Allow, exact emails only; the owner's is added) and "Team Memory gate token" (Bypass, everyone);
- the application `Team Memory <host>` on the hostname: Google only and sent straight there, a 24-hour session, the people policy, and Managed OAuth with dynamic client registration for localhost and loopback redirects and a 336-hour grant;
- the application on `<host>/v3` and `<host>/health` with the bypass policy.

Then it writes `HONCHO_TUNNEL_TOKEN`, `HONCHO_ACCESS_TEAM_DOMAIN`, `HONCHO_ACCESS_AUD`, `HONCHO_TEAM_WORKSPACE` and `HONCHO_TEAM_PEER` into the installed `.env`, creates `HONCHO_GATE_TOKEN`, `HONCHO_TEAM_MCP_TOKEN` and `HONCHO_GATE_PORT` when they are missing, adds `share` to `COMPOSE_PROFILES` (other profiles are kept), and runs `docker compose up -d gate mcp tunnel`. Once a call with the API token has worked, the token is saved owner-only in `runtime/cloudflare/api-token`, so the `teammates` commands need it in the environment only the first time. What was made, by id, goes in `runtime/team-access.json`, and the address in `runtime/share.json`. Running `enable` again changes only what is missing or wrong; `cloudflare.changes` lists it.

`server start` brings the share services up by itself while sharing is on, because Compose reads `COMPOSE_PROFILES` from the installed `.env`. `server status` includes `share: {enabled, publicUrl}`.

`server share status` reports by name and state only: `gate`; `tunnel`, where `hostAutostart` means the host tunnel of an older version is still registered; `mcp: {configured, missing, running}`, where `missing` names the settings `/mcp` still needs; and `cloudflare: {managed, joined, host, apiTokenSaved, teammatesShared}`. `--check` also requests `<public address>/health` with the gate token and reports `publicCheck.state`: `ok`; `access` (Cloudflare Access stopped the request: a 403, a redirect to `*.cloudflareaccess.com`, or a `cf-access-*`/`cf-mitigated` header); `token` (a 401 from the gate); `unreachable` (DNS or network failure, or a Cloudflare 502/530/1033 because the tunnel or the gate is down); or `error`.

`server share disable` stops the tunnel first, then `mcp` and the gate, removes their containers, and removes `share` from `COMPOSE_PROFILES`. It keeps the tokens in the `.env` and changes nothing in Cloudflare (tunnel, hostname, Access applications), so turning sharing on again needs no new invite and keeps every other computer working. `server share rotate` makes a new gate token and recreates the gate; every other computer then needs the new one.

### Teammates / 팀원

The owner keeps the team list with the saved API token, or the one in `CLOUDFLARE_API_TOKEN`:

```sh
node scripts/cli.mjs teammates add <email>                                     # may log in and ask
node scripts/cli.mjs teammates add <email> --share <name> --invite-out <file>   # also shares their own memory
node scripts/cli.mjs teammates list
node scripts/cli.mjs teammates remove <email>
node scripts/cli.mjs teammates unshare <name>
```

- `add` puts the email on "Team Memory people", which every server of the team uses. With `--share <name>` it also makes that teammate's server in the owner's account (`memory-<name>.<zone>`, the tunnel `team-memory-<name>` and both applications) and writes an invite to `<file>`, readable only by the user. The invite is `tm1.` followed by base64url JSON: the host, its tunnel token, the team domain, the AUD tag and the team's server list. Because it holds a tunnel token, it goes to the teammate over a private channel; the CLI never prints it, and the app shows it once.
- `list` reports the emails, the servers and `addressText`, the 팀 주소: one `<name> https://<host>/mcp` line per server, with no secret in it, for teammates who only ask.
- `remove` takes an email off the list, but never the owner's own. A server that teammate shares stays reachable to the others; `unshare <name>` deletes its applications, hostname and tunnel.

### A teammate's own server / 팀원 서버 공유

```sh
node scripts/cli.mjs server share join --invite-file <file>      # or the code in HONCHO_SHARE_INVITE
```

`join` needs only the invite. It writes the invite's values into the installed `.env` the way `enable --cloudflare` does, starts the same three services, and keeps the team's server list in `runtime/share.json`, which `teammates connect` there offers.

### Turning it on by hand

```sh
# The tunnel token goes in the environment, never on the command line.
HONCHO_TUNNEL_TOKEN='<token>' node scripts/cli.mjs server share enable --public-url https://<name>.<your domain>
```

This is for a tunnel made in the dashboard (Networks → Tunnels → Create a tunnel → Cloudflared; copy the token from the install command shown there; the Compose `tunnel` service runs the connector). Its public hostname's service must be `http://gate:8010`, since cloudflared runs beside the gate in Compose. The Access applications are the owner's to make: the gate token still covers `/v3`, and `/mcp` answers 404 until `HONCHO_ACCESS_TEAM_DOMAIN` and `HONCHO_ACCESS_AUD` are in the `.env`. An address on another host than before clears those two. The tunnel token is needed the first time only.

### On each other computer

Install the plugin, then run setup against the public address with the gate token in the environment, as for any server that needs an API token:

```sh
HONCHO_API_TOKEN='<gate token>' node scripts/cli.mjs setup apply --agents codex,claude --user-peer <id> --honcho-url https://<name>.<your domain>
```

In the app on that computer, 내 컴퓨터 → 대화 쌓기 does the same: the address and the gate token go into its form. `/memory-setup` opens that screen for a server on another computer.

The Team Memory app offers all of this on two pages over the same switch. 내 컴퓨터 → 다른 컴퓨터 붙이기 has "Cloudflare로 공유 켜기" (the API token, the owner's email, and the zone and name under "token 권한과 주소"), "초대 코드로 공유 켜기", the folded "직접 만든 통로로 켜기", and the gate token ("서버 token 복사", "서버 token 바꾸기"). 팀 → 내 기억 공유 has the same two ways to turn it on and, for the owner, the 팀원 list with "팀원 더하기", "공유 빼기" and "팀 주소 복사". A token typed there goes to the app's own server only, and no token or invite is logged.

## Asking a teammate's memory / 팀원 기억 연결

A teammate's shared server is a remote MCP server at `https://<host>/mcp`. Claude Code and Codex each keep it as `team-<name>` and log in to it themselves, each keeping its own login.

```sh
node scripts/cli.mjs teammates connect <name> <host|https://host/mcp>
node scripts/cli.mjs teammates connected
node scripts/cli.mjs teammates disconnect <name>
```

- `connect` runs `claude mcp add --transport http --scope user team-<name> https://<host>/mcp` and `codex mcp add team-<name> --url https://<host>/mcp`. The same address again changes nothing, and another address replaces the entry. A client that is not installed is reported, and the other is still done.
- Log in once in each client. In Claude Code, run `/mcp`, choose `team-<name>` and Authenticate; for Codex, run `codex mcp login team-<name>`. Either one opens Google login through Cloudflare Access, and only an email on the team list gets in. The agent then has that server's `chat`.
- `connected` lists every team server this computer knows and whether each client has it. It reads the invite's team list, the owner's `team-access.json`, and the `team-*` entries already in `~/.claude.json` and `~/.codex/config.toml`. This computer's own shared server is left out: its agents use their own memory directly.
- The app's 팀 → 팀원 기억 연결 page does the same: paste the 팀 주소 and press "Claude Code·Codex에 연결"; "Codex 로그인" starts the Codex login.
- `bridge disconnect` only removes the shared-bridge settings that 0.3.28 and before saved.

## Also sending some folders to another server (e.g. your company's)

Every conversation still goes to your own server, exactly as before. A *target* is
a second Honcho server that also receives a copy of the conversations you had in
chosen folders, for example your work repositories going to the company's shared
memory:

```sh
# The target's secrets go in the environment, never on the command line.
export HONCHO_TARGET_API_TOKEN=...                  # when that server requires one
export HONCHO_TARGET_CF_ACCESS_CLIENT_ID=...        # only when Cloudflare Access covers its API
export HONCHO_TARGET_CF_ACCESS_CLIENT_SECRET=...
node scripts/cli.mjs target add company --url https://memory.company.example \
  --folders ~/work/acme,~/work/acme-infra --label "ACME" --workspace acme
node scripts/cli.mjs target list
node scripts/cli.mjs target test company
node scripts/cli.mjs target set company --folders ~/work/acme   # or --enabled false to pause it
node scripts/cli.mjs target remove company
```

- **Which conversations.** A Codex or Claude Code session goes to a target when its
  working directory is one of the target's folders or inside one: `~/work/acme`
  takes `~/work/acme/api` but not `~/work/acme-old`. Paths are compared after `~`
  and `..` are resolved, trailing slashes removed and symlinks followed, and without
  regard to case on Windows and macOS (whose default file system ignores case). A
  session is decided once, by the first working directory its transcript records
  (Codex's session header, Claude Code's first message line): a session that `cd`s
  into another folder later stays where it started. ChatGPT imports and anything
  else without a working directory never go to a target.
- **What is sent.** The same messages, peers and metadata your own server gets, in
  the target's workspace (`--workspace`, default your own workspace id) under your
  user peer (`--user-peer` to use another name there). Messages carry the local
  transcript path in their metadata, as they do on your own server.
- **When.** From the turn after `target add` on. Nothing from before is sent until
  you ask: `target backfill company --since 2026-09-01` sends past sessions from
  those folders whose transcript was written on or after that date. It works through
  at most `--limit` transcripts per run (default 500), oldest first, and remembers
  which it finished, so running it again carries on where it stopped and never sends
  anything twice.
- **When the target is down.** Your own server is sent to first, so a target that is
  slow or down never holds it up. The target's copy waits in its own spool and goes
  on the next drain, as your own server's failed writes do. Each target keeps its
  own dedupe state, so neither server gets a message twice.
- **Recall stays with your own server.** The MCP tools (`scripts/mcp-server.mjs`)
  read only your own server; a target is written to, never read from.

`target add` checks that the server answers and that its workspace can be read with
the given token (the same Cloudflare Access and 401 classification setup uses), and
warns when a folder does not exist yet. `doctor` runs the same check for every
enabled target. `target list`, `doctor` and the app show only whether a token is
saved (`hasToken`, `hasAccess`), never the token. The app's routes are
`GET /api/targets` and `POST /api/targets/add|remove|set|test|backfill`; the tokens
typed into its form reach the CLI through its environment only.

In the app, 내 컴퓨터 → 다른 서버에도 쌓기 adds a server in four steps: the server,
the projects, past conversations, and a last look before 더하기. The projects offered
are the folders this computer's Claude Code and Codex conversations were held in
(`GET /api/app/projects`, `scripts/projects.mjs`, reading the same transcripts as
`target backfill`). A folder counts under the repository it sits in. Outside a
repository, one-off folders count under the folder that holds them: anything in the
system's temporary folder, and a folder whose name starts with a date, as the Codex
app's `~/Documents/Codex/<date>-<task>`. A folder that is gone shows when searched
for, and 다른 폴더 더하기 picks any folder through `GET /api/app/folders`.

On disk, each target keeps its own directory, `<data>/targets/<id>/`:
`spool/<agent>/pending/` (turns waiting for it), `state/<agent>.json` (what it has
been sent), `logs/<agent>.log`, and `backfill.json`. `target remove` deletes that
directory; what is already on that server stays there.

## Importing a ChatGPT export / ChatGPT 기록 가져오기

ChatGPT has no hook, so its history comes in from a data export (Settings → Data
controls → Export data), once or again later with a newer export:

```sh
HONCHO_USER_NAME=<your peer> node scripts/collector.mjs --provider chatgpt \
  --export ~/Downloads/<export>.zip [--workspace <id>] --dry-run   # then without --dry-run
```

- **What it reads.** The export as downloaded:
  - the zip itself, including a zip inside a zip, ZIP64, and zips over 4 GiB written without ZIP64;
  - the unpacked folder, so put several `…-part-000N.zip` downloads in one folder;
  - one JSON file.

  It finds `conversations.json` or the numbered shards (`conversations-000.json`, …), and skips `Files_*` zips that hold only attachments. Conversations are parsed one at a time, so a large export does not need to fit in memory.
- **Who and where.**
  - The person is `HONCHO_USER_NAME`. Unset, it is `user`, so always set it.
  - The assistant peer is `HONCHO_CHATGPT_ASSISTANT_NAME`, then `HONCHO_ASSISTANT_NAME`, then `assistant_chatgpt`.
  - The workspace is `HONCHO_WORKSPACE_ID`; `--workspace` wins.
- **What goes in:**
  - Only the branch the conversation shows, so edited-away or regenerated turns stay out.
  - Each message carries its original `create_time` as `created_at`. A message without one takes the time of the message before it.
- **What is skipped:**
  - system and hidden messages, custom instructions and user context;
  - assistant turns addressed to a tool (python, web, memory, canvas) and tool output;
  - thoughts and reasoning summaries;
  - turns that are only an image or audio.

  Citation markup is removed from answers.
- **Order.** Conversations go in oldest first, each one whole. A conversation reopened months later goes in at its start.
- **Safe to repeat.**
  - The whole export is parsed before the first write, and a broken shard stops it before anything is sent.
  - Running the same export again sends nothing, and a newer export sends only new messages.
  - The dedupe state is kept per server and workspace, so a different workspace gets everything.
- **`--dry-run`** sends nothing. It prints a `summary`: the files read, turns by role, the first and last time, and what was skipped and why.
- **In the app**, 내 컴퓨터 → ChatGPT 기록 가져오기 runs the same import. It takes uploads up to 256 MB and always uses the configured workspace and peer. Use the command for anything bigger or for another workspace.

## Backing up the conversation originals / 대화 원본 백업

This copies each agent's original conversation files, byte for byte, to a folder (a local folder, a NAS or an external drive) or to an rclone cloud remote. It is separate from collection. Nothing is converted, and Honcho never reads the backup.

```sh
node scripts/cli.mjs backup set --cloud gdrive_dev: --device studio   # or --folder /Volumes/Backup
node scripts/cli.mjs backup run --dry-run --verbose                    # what it would do; writes nothing
node scripts/cli.mjs backup run                                        # copy now (`backup start` runs it in the background)
node scripts/cli.mjs backup schedule on --hour 3                       # daily at 03:MM; `schedule off` stops it
node scripts/cli.mjs backup status
node scripts/cli.mjs backup remotes                                    # rclone remotes it can use
```

- **What is copied.**
  - Main transcripts: Claude Code `~/.claude/projects/*/<session>.jsonl` and Codex `~/.codex/sessions/**/rollout-*.jsonl`.
  - agy: `transcript_full.jsonl` and `transcript.jsonl` from `~/.gemini/<product>/brain/<conversation>/.system_generated/logs/`, where `<product>` is `antigravity-cli`, `antigravity` or `antigravity-ide`.
  - Grok CLI: `chat_history.jsonl` and `updates.jsonl` from `~/.grok/sessions/<encoded working folder>/<session>/`.
  - Each agent's `history.jsonl`.
  - Claude Code memory notes.

  Subagent transcripts, tool results and runtime state are not copied; `--dry-run --verbose` only counts them (`agy/other`, `grok/other`, and Grok's search index as `grok/search-index`). Codex archived sessions (`~/.codex/archived_sessions`) are copied under `codex/_아카이브/`. Collection never reads them.
- **Where.**
  - Transcripts go to `<folder>/대화/<agent>/YYYY/MM/DD/<original file name>`. The date is the day the conversation started, in Korea time. A file stays in that folder while the conversation goes on.
  - agy and Grok name every conversation's files alike, so theirs go one folder deeper: `대화/<agy|grok>/YYYY/MM/DD/<conversation id>/<original file name>`. agy's start is the first `created_at` in the transcript; Grok's is `summary.json`'s `created_at`, else the time in its UUIDv7 session id, else the first line of `updates.jsonl`.
  - `history.jsonl` goes to `<agent>/_부속자료/<device>/history.jsonl`; agy's comes from `~/.gemini/antigravity-cli/history.jsonl`.
  - Memory notes go to `claude/_부속자료/projects/<project>/memory/`.
  - The device id comes from the host name and is fixed when a destination is first saved. Set a short one with `--device`, because it becomes part of file names.
- **Several computers, one destination.** There are no device folders. Backup only copies: it never deletes anything at the destination and never syncs. When the destination file differs:
  - it is replaced if it is the start of this computer's file, i.e. a transcript that grew;
  - it is replaced if this computer uploaded it last and the ledger shows it unchanged since;
  - otherwise both are kept, and this computer's copy is saved as `<stem>.<device><ext>`.

  Modification time never decides. Each computer's daily run starts at a minute derived from its device id, so two computers don't create the same Drive folder at once.
- **Archived sessions and earlier versions.**
  - When a session is archived, its copy in the normal date folder moves into `_아카이브/`. If it differs from the archived file, it is kept as `<stem>.pre-archive.jsonl`, because Codex rewrites a file when it archives it.
  - If a copy under a date folder's `_원본버전/` is the same bytes as this computer's file, or its beginning, it is moved onto the normal path. Nothing is uploaded again.
  - On Google Drive these moves go up to 100 per `rclone backend moveid` call. Each one counts only when a listing shows the same file id under its new name. Anything not confirmed is tried again with `moveto`, and a move that still fails is an error and stays out of the ledger. Other remotes, files listed without an id and moves onto a taken name use one `moveto` each. Never put a `--drive-*` flag on a `moveid` call without `--server-side-across-configs`: rclone then copies the file and trashes the original instead of moving it.
- **연결 대기.** If the folder's drive is not mounted, or the remote does not answer, the run waits. It never writes to the internal disk instead.
- **State and schedule.**
  - State lives in `<data>/backup/`: `settings.json`, `status.json`, `ledger-<destination hash>.json` and `run.lock`. The log is `<data>/logs/backup.log`.
  - The scheduled job is launchd `team-memory-system.backup`, systemd `team-memory-backup.timer` or the Windows task `TeamMemoryBackup`. It runs `backup run --scheduled`, which re-checks the whole destination (`--full`) when the last full check is more than 7 days old.
  - The hour is the person's: 3 unless `--hour` or the hour box on the app's 백업 screen says otherwise. The minute comes from the device id. On that screen 폴더 고르기 browses this computer's folders for a folder destination.
- **Alerts.** A notification appears on the computer whose backup has a problem: a scheduled run ended with errors, threw or stopped midway, or there has been no successful run for more than 48 hours with at least two unsuccessful runs since. A single waiting run after a recent success does not alert.
  - Notifiers: `osascript` on macOS (credited to Script Editor, so its notifications must be allowed), a PowerShell toast on Windows, `notify-send` on Linux. A failed notification is logged as an `alert (...)` line in `backup.log` and never fails the backup.
  - The nightly run checks when it ends. A daytime check at 10:MM repeats it while the problem lasts, at most once per problem in 4 hours: launchd `team-memory-system.backup-check`, systemd `team-memory-backup-check.timer` or the Windows task `TeamMemoryBackupCheck`. The 백업 screen shows the same problem as a banner.
  - `backup alert test` shows a sample and `backup alert check` runs the check. The state is `<data>/backup/alert.json` plus `failing` in `status.json`.
  - `backup schedule on` registers both jobs, so run it again after a `git pull` on another computer.
- **Finding rclone.** `RCLONE_BIN`, then `PATH`, then the usual install folders, including `~/.local/bin` (macOS, Linux) and `%USERPROFILE%\.local\bin` (Windows). A scheduled job often has a shorter `PATH` than a terminal.

## Building a distributable bundle

The release builder copies this plugin and a complete Honcho source checkout, removes runtime state and secret-bearing files, preserves the Honcho AGPL license, records the exact source commit, and creates a tarball:

```sh
node scripts/build-distribution.mjs \
  --honcho-source /path/to/custom-honcho \
  --env-source /path/to/custom-honcho/.env
```

The optional environment source becomes `server/env.personal.example`, and its non-secret host requirements become `server/host-profile.personal.json`. Embedding model names, dimensions, context length and ports remain; every chat setting points at the gateway's router defaults (`host.docker.internal:11400`, `gpt-6-luna`, `low`), which `server prepare` replaces with what the installed gateway reports. Keys, tokens, passwords, credentials, and secret-looking values are blank. The resulting bundle contains no conversations, database volume, gateway source or logins, or Ollama model blobs. Run `server plan`, `prepare`, and `start` with `--profile personal` to reproduce the complete Docker-plus-host topology. Use `--profile portable` for the generic external OpenAI-compatible configuration.

`setup apply` copies the runtime to a stable application-data directory, writes a private `config.json`, merges only the managed Codex Stop hook, and removes obsolete Honcho Agent Bridge hooks. Claude Code uses the hook bundled with the plugin. Existing unrelated hooks and settings are preserved.

## Runtime locations

| Platform | Default application data |
| --- | --- |
| macOS | `~/Library/Application Support/HonchoAgentBridge` |
| Windows | `%LOCALAPPDATA%\HonchoAgentBridge` |
| Linux | `$XDG_DATA_HOME/honcho-agent-bridge` or `~/.local/share/honcho-agent-bridge` |

The directory contains the private configuration and data plus isolated runtime trees: `runtime/collector` for the replaceable collector/MCP bridge and, in the personal profile, `runtime/host` for the long-running Ollama supervisor and `runtime/subscription-gateway` for the gateway's fetched source. The gateway keeps its logins in its own app directory, `SubscriptionGateway`. Collector rollback is retained beside it as `runtime/collector.previous`; server rollback uses `server.previous`. Override the application-data root for testing with `HONCHO_AGENT_BRIDGE_HOME`; override the detected user home with `HONCHO_AGENT_BRIDGE_USER_HOME`.

## Architecture

```text
Codex Stop hook ─┐
Claude plugin hook ──> main.mjs ─> queue.mjs ─> collector.mjs ─> Honcho API
                 │                                  └─> providers/<agent>.mjs
Agent host ──────┴─> bundled stdio MCP ─────────────────────────> Honcho API

personal profile only:
Honcho containers ──> gateway router :11400 ──> the gateway's own Codex / Claude logins
Honcho containers ──> host Ollama ────────────> Qwen3-Embedding 4B 1536d / 8192-token
Gateway's own autostart ──────────────────────> gateway screen, adapters and router
host supervisor's own autostart ──────────────> keeps Qwen resident

while shared (Compose profile share):
another computer's collector ──> tunnel ──> gate /v3 (gate token) ──────────────> Honcho API
teammate's agent ──> Access (Google) ──> tunnel ──> gate /mcp ──> mcp (chat) ──> Honcho API
```

The queue keeps failed imports and retries them on the next agent Stop hook or an explicit queue drain. Its personal local-server defaults drain every newly queued transcript immediately. Transcript parsing is provider-specific; storage, deduplication, peer configuration, and API writes are shared.

## MCP tools

Codex loads `.mcp.json`; Claude Code loads `.mcp.claude.json`. Both start `scripts/mcp-server.mjs` through stdio and read the same external `config.json`, so no credentials or mutable state live inside a plugin cache.

`setup apply` writes `mcp-tools.json` under the configured data directory with the 12 tools that change memory turned off (`scripts/mcp-tool-defaults.mjs`); an install without that file behaves the same. Recall needs none of them. The file is the whole truth once it exists: list what should stay off, for example

```json
{
  "disabled_tools": ["delete_session", "delete_conclusion", "remove_peers_from_session"]
}
```

Agent hosts may cache their initial tool list, so reload Claude plugins or start a new Codex session after changing tool availability. The app's 내 컴퓨터 → MCP 도구 shows the same switches.

A teammate's `team-<name>` server is not one of these tools: it is a separate remote MCP server in Claude Code and Codex (see [Asking a teammate's memory](#asking-a-teammates-memory--팀원-기억-연결)), and `mcp-tools.json` does not list or switch it.

## Safety and rollback

- Setup requires a user peer ID and refuses to apply an incomplete plan.
- Existing JSON settings are backed up before a managed change.
- Setup is single-writer and automatically restores the previous runtime, configuration, and host files if an apply step fails.
- Reapplying setup is idempotent and does not duplicate hooks.
- Collector runtime updates keep the former copy as `runtime/collector.previous` without touching the running `runtime/host` supervisor.
- API tokens, when configured later, remain in the private external configuration and are never included in MCP metadata.
- Diagnostics check Honcho health and authenticated workspace access, the installed runtime version, active host plugins, exact hooks, and a real MCP initialize/tool-list handshake.

Installation rollback and memory backup are different:

- Setup automatically rolls back the managed runtime, private configuration, and edited host hook files when an apply step fails. Updates retain `runtime/collector.previous` and `server.previous`; unrelated host settings and the running host supervisor are preserved.
- Durable memory lives primarily in the Docker PostgreSQL `pgdata` volume. A machine-migration or disaster backup must contain a consistent PostgreSQL dump (or an offline copy of that volume) plus the Honcho Agent Bridge application-data directory containing `config.json`, the private server `.env`, MCP tool settings, and any pending collector spool/state. Include the Redis volume only when preserving in-flight Deriver jobs is important; Redis is not the authoritative long-term memory store.
- The gateway (its source and its logins), Ollama model blobs, plugin caches, and hooks are deliberately outside the portable backup set. On a restored computer, install the prerequisites, restore the database and private Honcho Agent Bridge files, then rerun `server prepare --profile personal` (log in at the gateway screen when it asks; the restored router key is replaced with the new gateway's), `server start --profile personal`, and `setup apply`. Qwen models are recreated when absent.
- Keep backups encrypted because the private `.env` and Honcho Agent Bridge configuration can contain database passwords, the gateway's router key, or API bearer tokens. The release builder never includes them.
- `server stop --profile personal` preserves Docker volumes. Never use `docker compose down -v` unless permanently deleting the memory database is the explicit goal.

## Verification

```sh
npm test
claude plugin validate .
```

The tests exercise isolated installation, hook preservation and cleanup, transcript edge cases, all 31 MCP definitions and the read-only default, REST forwarding, per-tool disabling, port selection and Docker Desktop start-up without touching the live user configuration.
