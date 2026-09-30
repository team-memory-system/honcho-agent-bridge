# Honcho Agent Bridge

Collector, installer and plugin for one person's self-hosted Honcho memory. Reads
Codex / Claude Code / agy / ChatGPT conversations and writes them into that
person's Honcho.

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
MCP tool, `chat`, on a second bridge process — so a teammate can ask a question and
gets an answer, without reading the underlying messages.

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
   programs: read and search the memories, ask Honcho or a gateway model, log
   subscription accounts in, set up collection, run the server, switch MCP tools and
   read the audit log. Setup steps run the same CLI a terminal would; memories, the
   gateway and the server's tool switches are relayed to those programs' own APIs
   by `scripts/app-api.mjs`, which adds the Honcho token so the page never holds it.
   `cli.mjs ui open` starts it detached (default `http://127.0.0.1:4180`) and opens
   the browser, which is how `/memory-setup` shows it.
4. **Run the local stack.** `server ...` drives the Honcho Docker stack;
   `host ...` installs the subscription gateway through its own CLI and supervises
   Ollama. Every chat model Honcho uses goes through the gateway's router; the router
   key comes from the gateway, not from the person installing.
5. **Recall.** `scripts/mcp-server.mjs` is a stdio MCP server. Given
   `honcho.mcpBridgeUrl` in its config it stops implementing the tools itself and
   relays to that bridge instead, so the tool definitions live in one place and the
   call is recorded in the bridge's audit log. `bridge connect` writes that address
   and its three credentials, and keeps them only if the plugin's own MCP server
   then reaches the bridge with them.

### Things that will bite you

- **This repository registers no OS autostart; the gateway registers its own.**
  Nothing here touches launchd, the Windows task scheduler or registry, or systemd.
  The gateway's own `install`, which `server prepare` and `host start` run, registers
  the gateway's per-user autostart (launchd, the Windows Run key or systemd,
  reported as `autostart`), so after a reboot its screen, adapters and router come
  back by themselves. The Ollama supervisor does not: `host start` spawns it
  detached and finds it again through its PID file, and after a reboot it stays down
  until someone runs `host start` or presses start in the setup UI. Until then the
  Qwen alias is not kept loaded, and Ollama answers only if its own app started it.
  `host stop` and `server stop` leave the gateway running;
  `node <app-dir>/runtime/subscription-gateway/gateway/cli.mjs uninstall` removes it.
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
- **The owner's machine is hand-wired, not installed.** Its hooks read
  `~/.config/codex-honcho-sync/.env` and use `CODEX_HONCHO_SYNC_ROOT`. Those names
  are deliberately left at the old spelling: renaming them buys nothing and can
  stop live collection. The installed layout under
  `~/Library/Application Support/HonchoAgentBridge` is the one this code creates.
  Its gateway runs from `~/dev/subscription-gateway` under the LaunchAgent
  `subscription-gateway.ui`; `server prepare` or `host start` there would fetch a
  second gateway into the app directory and run that copy's `install`.
- **`setup` rebuilds `config.json` from scratch.** Anything it does not own must be
  carried through explicitly; `RELAY_FIELDS` in `scripts/cli.mjs` is that list for
  the shared bridge. Before it existed, installing hooks silently disconnected a
  teammate from the bridge.
- **A bridge older than `BearerGate` accepts any token at `initialize`.** It only
  refuses at the first tool call, so `bridge connect` against it reports success
  with a wrong token. `honcho-selfhost` added the gate on 2026-09-28; a bridge
  process started before that still runs the old code.
- **Shared-bridge credentials never go on a command line.** `bridge connect` reads
  them from `HONCHO_MCP_BEARER_TOKEN`, `CF_ACCESS_CLIENT_ID` and
  `CF_ACCESS_CLIENT_SECRET`, refuses them as options, and the UI passes them to the
  CLI through its environment.
- **Two Cloudflare service tokens, never mixed.** `honcho.accessClientId/Secret`
  (written by `bridge connect`, cleared by `bridge disconnect`) are the shared
  bridge's. `honcho.access.{clientId,clientSecret}` is the memory server's own,
  written only by `setup` from `HONCHO_CF_ACCESS_CLIENT_ID/SECRET`. Every request to
  `honcho.baseUrl` builds its headers with `honchoHeaders` in
  `scripts/honcho-access.mjs`, and goes through `fetchHoncho`, which follows
  redirects only within that origin so an Access login redirect is seen, not
  followed.
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
npm test          # 173 tests, no network, no Docker
node scripts/cli.mjs detect
node scripts/cli.mjs doctor
npm run ui        # the Team Memory app on localhost
```

Tests are the contract. Several of them exist specifically to fail when something
drifts: the tool count in `tests/mcp-server.test.mjs`, the setup and connect forms'
field names in `tests/ui.test.mjs`, the relay fields surviving `setup apply` in
`tests/bridge-connect.test.mjs`, the absence of any OS-registration call in
`tests/host-manager.test.mjs`, and the gateway's router key never appearing in a
returned result in `tests/gateway.test.mjs` and `tests/server-manager.test.mjs`.

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

- Capture Codex and Claude Code conversations into one personal Honcho workspace.
- Recall memory through the Honcho tools exposed by the bundled MCP server: 19 recall tools by default, and 12 memory-changing tools once enabled.
- Detect installed agents, preview setup changes, preserve unrelated settings, and create backups.
- Run on macOS, Windows, and Linux wherever a recent Node.js runtime is available.

- Also send the conversations from chosen folders to a second server, such as the company's shared Honcho (see "Also sending some folders to another server").

Cross-device database synchronization is intentionally deferred until the personal-memory package is complete.

## Prerequisites

- Node.js 18 or newer.
- Docker Desktop/Engine with Compose when installing the bundled local Honcho server (`server prepare` starts a closed Docker Desktop on macOS and Windows and waits for its engine), or an existing Honcho API. For your own server on another computer, see [Collecting from another computer](#collecting-from-another-computer).
- This repository installed as a plugin in each agent host that should receive Honcho MCP tools.

The `personal` profile also requires macOS or Windows, git, Ollama on the host, and a Codex and/or Claude subscription. `server prepare` installs the subscription gateway and stops once to ask for a login with that subscription in the gateway's own screen; nothing reads `~/.codex/auth.json`, and no key is typed anywhere. Native Linux currently supports the `portable` profile; its Docker bridge cannot safely reach the personal profile's loopback-only host services without an additional binding design.

On Windows, Docker Desktop must use its WSL 2 backend, hardware virtualization and the WSL features must be enabled, and Ollama must be installed for the current user and available on `PATH`. `server plan` checks Docker CLI/Compose and engine health and whether git can fetch the gateway; personal preparation installs the gateway (its own install brings its npm dependencies) and checks Ollama and its local API, and the required base/alias/context. Docker engine readiness is the current gate for the WSL backend: setup does not independently enable WSL, clear a pending reboot, or preflight every port. If Docker reports that a WSL feature change requires a reboot, restart Windows and run the same plan again.

When Docker, Ollama or git is absent, the setup skill offers an explicitly confirmed installation through the detected platform's official package manager or vendor installer, then reruns the prerequisite checks. System software installation is never hidden inside the release archive.

One setup run can enable conversation collection for every detected agent. Installing the plugin in each host is still required for that host to receive the skills and MCP tools.

## Plugin installation

```sh
codex plugin marketplace add team-memory-system/honcho-agent-bridge
codex plugin add honcho-agent-bridge@honcho-agent-bridge

claude plugin marketplace add team-memory-system/honcho-agent-bridge
claude plugin install honcho-agent-bridge@honcho-agent-bridge
```

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
5. Apply only after confirmation.
6. Run the diagnostic checks and pass on `nextSteps` from `setup apply`: Codex asks the user to approve the new Stop hook (or `/hooks`), and Claude Code sessions opened before setup need `/reload-plugins`.

### Collecting from another computer

The memory server runs on one machine; another computer (a laptop, a work machine)
sends its conversations there through a Cloudflare Tunnel protected by Cloudflare
Access. On that other computer, setup needs up to three things:

1. **The server's address**, with `--honcho-url https://memory.example.com`.
2. **The server's API token**, in `HONCHO_API_TOKEN`, when the server requires one.
3. **An Access service token, only if this computer is not on WARP.** The default
   is to connect Cloudflare WARP with the team account: Access then lets the device
   through by identity and nothing more is needed. A machine that cannot run WARP
   presents a service token instead, in `HONCHO_CF_ACCESS_CLIENT_ID` and
   `HONCHO_CF_ACCESS_CLIENT_SECRET` (both, or neither).

```bash
export HONCHO_API_TOKEN=...                   # the server's bearer token
export HONCHO_CF_ACCESS_CLIENT_ID=...         # only without WARP
export HONCHO_CF_ACCESS_CLIENT_SECRET=...     # only without WARP
node scripts/cli.mjs setup plan --honcho-url https://memory.example.com --agents codex,claude --user-peer <id>
node scripts/cli.mjs setup apply --honcho-url https://memory.example.com --agents codex,claude --user-peer <id>
```

Setup refuses any of these secrets as command-line options, prints them only as
`"[redacted]"`, and saves them in the private `config.json` (`honcho.apiToken`,
`honcho.access`). A later setup without them keeps them while the address stays on
the same server, and drops them with a warning when it moves to another one. The
Team Memory app's setup form takes the same three values and hands them to the CLI
through its environment.

The collector, the MCP server, the app and `doctor` all send the bearer token and,
when saved, the service token with every request to that server, and to no other
program. When Access refuses this computer (a 403 from Access, or a redirect to its
`*.cloudflareaccess.com` login page), `setup plan` warns that the server "is behind
Cloudflare Access and refused this computer", `doctor`'s `honcho-health` check
fails with `code: "cloudflare-access"`, and the app says so instead of reporting
the server as down. Connect WARP with the team account, or add a service token and
run setup again.

This service token is the memory server's. The one `bridge connect` takes
(`CF_ACCESS_CLIENT_ID/SECRET`) belongs to someone else's shared bridge, and the two
never stand in for each other.

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
# If it returns nextAction "gateway-login": open the gateway screen, log in there
# with Codex and/or Claude, then rerun prepare.
node scripts/cli.mjs gateway open
node scripts/cli.mjs server start --profile personal
node scripts/cli.mjs server status --profile personal
node scripts/cli.mjs server verify --profile personal
node scripts/cli.mjs setup plan --agents codex,claude --user-peer user_name
node scripts/cli.mjs setup apply --agents codex,claude --user-peer user_name
node scripts/cli.mjs doctor
```

For a portable install, replace `personal` with `portable`. `server prepare` reports the blank external LLM credential fields without printing their values; fill only those fields in the returned installed `.env` path before running `server start`. The collector and MCP bridge always remain on the host so they can read agent transcripts and integrate with the host tool cache. The Honcho API, dashboard, gateway, and Ollama endpoints bind to localhost; database ports are not exposed.

`server verify --profile personal` performs a production-shaped, non-destructive diagnostic: combined server status including the gateway's router health, a local Ollama embedding request proven to exceed 2048 evaluated tokens with truncation disabled and exactly 1536 output dimensions, Docker API-container access to both host services (Ollama and the router's `/health`), and Honcho health. It makes no model call by default. Add `--live-completion` only when an actual minimal completion through the router is intended; it uses the installed `.env`'s router address, key, model and effort, reads the key internally, never places it on a command line, sends it nowhere but this machine, returns only success and model, and discards the completion body.

## Sending to this server from other computers (Cloudflare) / 다른 컴퓨터에서 이 서버로 보내기

A personal server listens only on `127.0.0.1`, so the owner's other computers cannot reach it. Sharing puts two things in front of it, both on the server's computer:

- **The gate** (`server/gate/gate.mjs`), a Compose service under the `share` profile that publishes `127.0.0.1:<gate port>` (8010, or the next free port; kept in the installed `.env` as `HONCHO_GATE_PORT` once chosen). Every request needs `Authorization: Bearer <gate token>`, compared in constant time; only `GET /health` and `/v3/*` are forwarded to the API, bodies stream both ways (dialectic SSE included), and bodies over 20 MB are refused. The gate token is 32 random bytes, generated once into the private `.env` as `HONCHO_GATE_TOKEN`.
- **A Cloudflare tunnel** (`cloudflared`) from a public hostname to the gate. Cloudflare Access in front of the hostname decides which devices get in at all; the gate token decides which of them may use the API. There is no Tailscale path.

### Owner steps in the Cloudflare Zero Trust dashboard

1. **Networks → Tunnels → Create a tunnel**, type **Cloudflared**, any name. On the install step, copy the token from the shown command (the long value after `--token`). Do not run that command; the app installs and runs cloudflared itself.
2. **Public hostname**: `<name>.<your domain>`, service **HTTP**, URL `http://localhost:<gate port>` (`server share status` shows the port, 8010 unless it was taken).
3. **Access → Applications → Add an application → Self-hosted** on that same hostname, with a policy that allows your WARP device group and/or your email addresses.
4. For a computer without WARP, create a **service token** (Access → Service credentials) and add a **Service Auth** policy for it on the same application. That computer's collector sends it when `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set in its environment.

For a team, an admin can create the tunnel and the Access application and hand the teammate only the tunnel token and the hostname.

### Turning it on

```sh
# The tunnel token goes in the environment, never on the command line.
HONCHO_TUNNEL_TOKEN='<token from step 1>' node scripts/cli.mjs server share enable --public-url https://<name>.<your domain>
node scripts/cli.mjs server share status --check
node scripts/cli.mjs server share token     # the gate token, to copy to the other computers
```

`enable` needs an installed personal server. It uses `cloudflared` from `PATH`, else `runtime/cloudflared/cloudflared` in the app directory, else downloads the latest release for this platform from `github.com/cloudflare/cloudflared` into that path and checks it with `cloudflared --version`. It writes the tunnel token to `runtime/cloudflared/tunnel-token` (owner-only), adds `share` to `COMPOSE_PROFILES` in the installed `.env` (other profiles are kept), runs `docker compose up -d gate`, and registers a per-user autostart that runs `cloudflared tunnel --no-autoupdate run --token-file <that file>`, with no admin rights:

| Platform | Autostart | Logs |
| --- | --- | --- |
| macOS | LaunchAgent `~/Library/LaunchAgents/team-memory-system.tunnel.plist` (RunAtLoad, KeepAlive) | `runtime/cloudflared/logs/tunnel.log`, `tunnel.error.log` |
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `TeamMemoryTunnel`, a hidden `wscript` running `runtime/cloudflared/tunnel.vbs` | `runtime/cloudflared/logs/tunnel.log` |
| Linux | systemd user unit `team-memory-tunnel.service` | `runtime/cloudflared/logs/tunnel.log`, `tunnel.error.log` |

The public address must be `https://<hostname>` with no path, query or credentials; it is saved in `runtime/share.json`. The tunnel token is needed the first time only; a later `enable` without it keeps the saved file. `server start` brings the gate up by itself while sharing is on, because Compose reads `COMPOSE_PROFILES` from the installed `.env`. `server status` includes `share: {enabled, publicUrl}`.

`server share status --check` also requests `<public address>/health` with the gate token and reports `publicCheck.state`: `ok`; `access` (Cloudflare Access stopped the request: a 403, a redirect to `*.cloudflareaccess.com`, or a `cf-access-*`/`cf-mitigated` header; this computer is not in the allowed WARP group); `token` (a 401 from the gate); `unreachable` (DNS or network failure, or a Cloudflare 502/530/1033 because the tunnel or the gate is down); or `error`.

`server share disable` removes the autostart, stops the tunnel, stops and removes the gate container, and removes `share` from `COMPOSE_PROFILES`. It keeps the gate token and the tunnel token file, so turning sharing on again keeps every other computer working. `server share rotate` makes a new gate token and recreates the gate; every other computer then needs the new one.

### On each other computer

Install the plugin, then run setup against the public address with the gate token in the environment, as for any server that needs an API token:

```sh
HONCHO_API_TOKEN='<gate token>' node scripts/cli.mjs setup apply --agents codex,claude --user-peer <id> --honcho-url https://<name>.<your domain>
```

The Team Memory app offers the same steps on its server screen (`/api/server/share/*`); the tunnel token typed there reaches the CLI through its environment only.

## Also sending some folders to another server (e.g. your company's)

Every conversation still goes to your own server, exactly as before. A *target* is
a second Honcho server that also receives a copy of the conversations you had in
chosen folders, for example your work repositories going to the company's shared
memory:

```sh
# The target's secrets go in the environment, never on the command line.
export HONCHO_TARGET_API_TOKEN=...                  # when that server requires one
export HONCHO_TARGET_CF_ACCESS_CLIENT_ID=...        # only behind Cloudflare Access without WARP
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

On disk, each target keeps its own directory, `<data>/targets/<id>/`:
`spool/<agent>/pending/` (turns waiting for it), `state/<agent>.json` (what it has
been sent), `logs/<agent>.log`, and `backfill.json`. `target remove` deletes that
directory; what is already on that server stays there.

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
host start (detached supervisor) ─────────────> keeps Qwen resident
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

The existing `~/.hermes/local-honcho-mcp/tool-config.json` format is also recognized for migration. Agent hosts may cache their initial tool list, so reload Claude plugins or start a new Codex session after changing tool availability.

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
