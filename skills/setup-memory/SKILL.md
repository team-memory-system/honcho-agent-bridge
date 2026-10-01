---
name: setup-memory
description: Connect to someone else's shared memory, or install, update, or diagnose the bundled self-hosted personal-memory runtime for Codex and Claude Code. Use when the user asks to set up memory, connect to a teammate's or colleague's memory, connect coding agents to Honcho, choose which detected agents receive hooks, inspect an installation plan, repair hooks, or run a memory health check.
---

# Setup Memory

Use the deterministic CLI bundled at `<plugin-root>/scripts/cli.mjs`. Resolve `<plugin-root>` as the directory two levels above this `SKILL.md`. Never reconstruct its mutations manually when the CLI supports them.

## First: which features

Ask one question before anything else: which of these three features this computer should have. They are independent and combine; ask it as a multi-select. Use these labels and descriptions as written, in the user's language (Korean shown). Do not rename them, do not present them as mutually exclusive paths, do not add options, and never name a particular computer (such as the user's home machine) in them. Prefer the host's structured question tool. Skip the question when the request already says which.

- **서버 설치** — 이 컴퓨터에 내 기억 서버를 둡니다. 한 사람에게 하나면 되고, 내 다른 컴퓨터의 대화도 여기로 모을 수 있습니다. → "Own memory workflow" below, step 1 (the server).
- **대화 동기화** — 이 컴퓨터의 Claude Code·Codex 대화를 내 기억 서버로 보냅니다. 서버가 이 컴퓨터에 있으면 그리로, 다른 컴퓨터에 있으면 그 주소와 서버 토큰으로 보냅니다. → "Own memory workflow" below, steps 2–10, with "Own server on another computer" when the server is elsewhere.
- **다른 사람 기억에 묻기 (chat)** — 팀원이 열어 준 창구에 연결해 그 사람의 기억에 질문합니다. → "Asking someone else's memory" below.

Typical combinations: the computer that keeps the server takes 서버 설치 + 대화 동기화; another of the person's computers takes 대화 동기화 (and chat if they want); a computer that only asks teammates takes chat alone. With 서버 설치 but not 대화 동기화, install and start the server and skip the hooks. With 대화 동기화 but not 서버 설치, never install a server here; ask for the address of the server they already have. Do them in this order: server, then sync, then chat.

Sending some folders to a company server as well is not a fourth feature; offer it after 대화 동기화 is set up, only if the user asks (see "Also sending some folders to another server").

## Asking someone else's memory

The memory's owner gives the user four values: the shared bridge address, a bridge token, and a Cloudflare service token ID and secret. The user enters them in the Team Memory app, not in chat.

1. Run `node <plugin-root>/scripts/cli.mjs ui open`. It starts the local Team Memory app if it is not already running, opens it in the browser, and returns its `url`. Give the user that address as text as well, in case no browser window appeared.
2. Tell the user to open 연결 → "다른 사람의 기억에 묻기", fill in the four fields, and press 연결. The screen saves the values only after it has reached the bridge with them, and shows the tools the bridge offers (normally just `chat`).
3. Never ask the user to paste any of the four values into chat, and never pass them on a command line. The terminal equivalent is `bridge connect --url <address>` with the secrets in `HONCHO_MCP_BEARER_TOKEN`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, set by the user in their own shell.
4. When the user says it is done, run `node <plugin-root>/scripts/cli.mjs bridge test` and report `connected`, `url` and `tools`. On failure, report the `error` without guessing at values.
5. Tell the user to restart the agent host so its tool list reloads: Claude Code may use `/reload-plugins`; Codex should start a new session.

This path installs no hooks and needs no local Honcho server. `bridge disconnect` removes the four values.

## Own memory workflow

1. Run `node <plugin-root>/scripts/cli.mjs detect` and inspect the JSON.
   - If a configured Honcho server is already healthy, offer to connect to it and do not replace it.
   - If `honcho.managedByThisInstall` is `false`, something else answers at that address (on one test machine it was an SSH tunnel to another computer's Honcho). Do not treat it as the user's server: ask whether it is theirs. To install a server here anyway, go ahead; `server prepare` picks free ports and never touches that program.
   - If Honcho is unreachable, determine which bundled profile is available. `personal` requires `server/env.personal.example`, `server/host-profile.personal.json` and `server/gateway-source.json`; otherwise use `portable`.
   - Recommend `personal` when it is bundled. Explain that it runs the Docker Honcho stack, the subscription gateway (which turns the user's own Codex and/or Claude subscription into the one router every chat model uses), and Ollama with Qwen3-Embedding 4B (1536 dimensions, 8192-token context) for embeddings. An existing install that already uses the 8B alias keeps it, because its stored vectors were made by 8B. Offer `portable` when the user wants a generic external OpenAI-compatible setup without host services.
   - Run `node <plugin-root>/scripts/cli.mjs server plan --profile <profile>` and show its exact `operations` and `warnings` before any mutation. A closed Docker Desktop is a warning, not a stop: `server prepare` starts it (`start-docker-desktop`) and waits for its engine. A busy 8001 or 4173 is also a warning: the plan's `apiUrl` and `dashboardUrl` show the ports the new server will use instead. Never delete or replace Docker volumes. For `personal`, point out `gateway-install`: the gateway's own install registers the gateway's own per-user autostart (launchd, the Windows Run key, or systemd), so the user is agreeing to that too.
   - On Windows, Docker Desktop runs on its WSL 2 backend and needs hardware virtualization enabled. The server plan automatically checks Docker CLI/Compose and engine health and whether git can fetch the gateway; personal preparation installs the gateway (its own install brings its npm dependencies) and checks Ollama CLI/API and the base/alias/context. It does not independently enable WSL beyond what Docker's installer does, or preflight every port. When Docker reports an incomplete WSL setup or reboot requirement, stop and tell the user to finish it, reboot if requested, and rerun detection and the plan.
   - For `personal` on macOS or Windows, a missing Docker Desktop or Ollama is not an issue: the plan starts with `install-docker-desktop` and/or `install-ollama` (each with its `url` and `destination`) and warns that Docker Desktop is free for personal use, education, non-commercial open source and small businesses (fewer than 250 employees and less than $10 million revenue) while larger companies and government entities need a paid Docker subscription. Show that warning and get the user's confirmation for it. Tell them what they will be asked: on Windows, the administrator prompt (UAC) for Docker's installer; on both, Docker's first-run window (accept its terms, recommended settings, and on macOS their password). Ollama is downloaded into the app directory, checked against the release's `sha256sum.txt`, and needs nothing from them. Then handle prepare's `nextAction`: `docker-first-run` means finish Docker's window and run prepare again; `restart-required` means restart Windows and run prepare again; `docker-install-approval` means the prompt was declined and prepare should run again with Yes chosen. A non-admin macOS account cannot write `/Applications`; prepare says so, and an administrator has to install Docker Desktop.
   - If git is missing (or Docker for `portable`), offer to install the missing prerequisite with the detected OS's official package manager or vendor installer. Treat this as a separate, explicit confirmation because it installs system software. Verify the publisher/source, avoid piping a downloaded script directly into a shell, and rerun `detect` and `server plan` after installation. On Windows, complete any requested WSL feature enablement and reboot before continuing. If an official unattended path is unavailable, open or provide the official installer and guide the user through it rather than silently substituting an unofficial package.
   - After confirmation, run `node <plugin-root>/scripts/cli.mjs server prepare --profile <profile>`. For `personal`, this fetches the gateway into the app directory, runs the gateway's install (its dependencies, its autostart, its screen at `http://127.0.0.1:11450`), asks the gateway for its router address and key, writes them with the chosen chat model into the installed private `.env`, and prepares the Qwen3-Embedding base model (4B for a new install) with its 8192-token alias. For `portable`, if it reports `missingSecretFields`, tell the user which fields to fill in the returned installed `.env` path. Never ask the user to paste their values into chat.
   - For `personal`, model access comes from a login in the gateway's own screen. `codex login` and `~/.codex/auth.json` play no part, and the gateway keeps its logins apart from the user's own CLI logins. When `server prepare` returns `ready: false` with `nextAction.kind: "gateway-login"`, run `node <plugin-root>/scripts/cli.mjs gateway open`, which opens the gateway screen and returns its `url`; give the user that address (or `nextAction.url`) as text too. Ask them to log in there with Codex and/or Claude; the same login is on the Team Memory app's 게이트웨이 screen (`ui open`), which connects the account by itself once the browser login finishes. When they say it is done, run `server prepare --profile personal` again. Never ask for a password, token or key in chat.
   - A ready personal prepare reports `chatModel` and `chatModelSource`: `override` for `--model`, `kept` for the model the installed `.env` already uses while the gateway still offers it, `default` for the first of `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.5`, `claude-haiku-4-5`, `claude-sonnet-5-5` that the gateway offers, otherwise the first model it lists that is not an embedding model. When the gateway offers no chat model at all, prepare returns `ready: false` with the same `gateway-login` next action and the reason in `gateway.reason`; the fix is again a Codex or Claude login in the gateway screen. The choice sticks: later prepares and `server start` keep it without being given `--model` again. If the user wants another one from `gateway.models`, rerun prepare with `--model <id>`.
   - Once `server prepare` reports `ready: true`, run `node <plugin-root>/scripts/cli.mjs server start --profile <profile>`. Its `apiUrl` is the server's address and `dashboardUrl` the memory dashboard; give the user the dashboard address, and use `apiUrl` as `--honcho-url` below (setup also defaults to it). With `personal`, this starts the Ollama supervisor and waits for the gateway's router before Compose. Require `server status --profile personal`, `server verify --profile personal`, and Honcho health to pass before continuing. Default verification makes no model call; use `--live-completion` only after the user explicitly asks for or confirms a real completion through the router.
   - After a reboot everything comes back by itself: the gateway through its own autostart, the host supervisor (which keeps the embedding model resident and restarts an Ollama the app downloaded) through the `team-memory-system.host` login item that `host start`/`server start` registers, and the server containers with Docker. If `host status` shows the supervisor down anyway, run `node <plugin-root>/scripts/cli.mjs host start --profile personal` or press 켜기 on the app's 서버 screen. `host start` runs the gateway's install as well and, with no login, returns the same `gateway-login` next action. When `server/gateway-source.json` changed, prepare and `host start` first uninstall the old gateway copy (its logins stay), replace it, and install the new one. If that swap fails, the old copy is put back and installed again; report the returned `error` as it is, and say whether `gateway.source.restored` is true.
2. Ask which detected agents to configure before planning.
   - Prefer the host's native structured question tool when available (`request_user_input` in supported Codex modes or `AskUserQuestion` in Claude Code).
   - Offer all detected agents as the recommended choice, the current agent only, and manual selection.
   - If no structured question tool exists, ask one concise question using the host's permitted interaction style.
3. Ask whether to use the detected OS application-data location or a custom data directory. Recommend the detected default. Ask for a path only when the user chooses custom storage, then pass it as `--data-dir`.
4. Ask for a user peer ID only when none is already configured. Default the workspace to `memory`. Leave out `--honcho-url` for a server installed here: setup uses the installed server's port. Pass it for a server elsewhere. Use `--codex-root` only when the Codex session directory is nonstandard. If the portable profile needs an API key, have the user place it in the installed private `server/.env`; never request that they paste a secret into chat or pass it as a command-line argument. The personal profile gets its router key from the gateway and writes it into the installed private `.env` itself; the user never handles it.
5. Run the plan without mutation:

```sh
node <plugin-root>/scripts/cli.mjs setup plan \
  --agents codex,claude \
  --user-peer <peer-id> \
  --workspace memory \
  --honcho-url http://127.0.0.1:8001 \
  --data-dir <selected-data-directory>
```

6. Summarize the exact files and agents from `operations`. Do not apply when `ready` is false.
   - Explain every `warning`. Selecting a host without its Honcho Agent Bridge plugin installed and enabled can prepare shared configuration, but that host will not receive the bundled skills, MCP server, or Claude hook.
7. Obtain confirmation before changing host settings. Replace `plan` with `apply` using the same options.
8. Run `node <plugin-root>/scripts/cli.mjs doctor` and report any failed check.
9. Tell the user every entry of `nextSteps` from the apply result, in their words. Collection is not finished without them:
   - `approve-hook` (Codex): Codex shows the new Stop hook for approval when a session starts, or in `/hooks`. Approve only "Syncing codex conversation to personal memory". Nothing from Codex is collected before that.
   - `reload-plugins` (Claude Code): sessions that were already open need `/reload-plugins` or a restart; new sessions need nothing. Earlier turns of those sessions are sent with their next turn.
10. The memory-changing MCP tools (writes and deletes) start turned off; recall does not need them. Mention it only if the user asks for a tool that is missing.

## Own server on another computer

For a user whose own Honcho already runs on another of their computers (reachable from this one), install only the collector here:

1. Install the plugin as usual. Skip `server ...` entirely.
2. Run `setup plan` with `--honcho-url <that server's address>`. If the plan warns that the address requires an API token, ask the user to set `HONCHO_API_TOKEN` in their own terminal and run `setup apply` there themselves, for example `HONCHO_API_TOKEN=... node <plugin-root>/scripts/cli.mjs setup apply ...`. Never ask for the token in chat or put it on a command line you run.
3. If the plan warns that the address "is behind Cloudflare Access and refused this computer", the default fix is for the user to connect Cloudflare WARP with the team account and run `setup plan` again. On a machine without WARP, the user sets both `HONCHO_CF_ACCESS_CLIENT_ID` and `HONCHO_CF_ACCESS_CLIENT_SECRET` (an Access service token) in their own terminal and runs `setup apply` there, the same way as the API token. These are not the `CF_ACCESS_CLIENT_*` values `bridge connect` takes.
4. Continue with `doctor` and `nextSteps` as above.

To make that possible for a personal server on the other computer, share it there first (Cloudflare Tunnel plus Access only; never Tailscale):

1. The owner creates a tunnel in the Cloudflare Zero Trust dashboard (Networks → Tunnels → Create a tunnel → Cloudflared), sets its public hostname's service to `http://localhost:<gate port>` (`server share status` shows the port), and puts an Access application with a WARP-group or email policy on that hostname. For a team, an admin can do this and hand over only the tunnel token.
2. On the server's computer the user runs `HONCHO_TUNNEL_TOKEN=... node <plugin-root>/scripts/cli.mjs server share enable --public-url https://<hostname>` in their own terminal. Never ask for the tunnel token in chat or pass it as an option; the CLI refuses a token option. The app's server screen does the same with the token kept off the command line.
3. `server share status --check` reports `publicCheck.state`: `access` means Cloudflare Access did not let this device in (check the WARP group or the policy), `token` a wrong gate token, `unreachable` the tunnel or the gate being down.
4. The gate token is the `HONCHO_API_TOKEN` for setup on the other computer. The user copies it from the app's server screen, or runs `server share token` in their own terminal; do not run that command yourself, since its output is the secret. `server share disable` turns sharing off and keeps both tokens; `server share rotate` replaces the gate token.

## Also sending some folders to another server

When the user wants the conversations from certain folders to also reach another Honcho (usually the company's), add a target. Their own server still receives everything.

1. Ask for the server address, the folders, and the workspace id there. The user sets `HONCHO_TARGET_API_TOKEN` (and, without WARP behind Cloudflare Access, `HONCHO_TARGET_CF_ACCESS_CLIENT_ID`/`_SECRET`) in their own terminal and runs `node <plugin-root>/scripts/cli.mjs target add <id> --url <https://…> --folders <a,b> [--workspace <id>]` there. Never ask for these in chat or pass them as options; the CLI refuses them.
2. `target add` checks the server first. Report its `warnings` (a folder that does not exist yet) and its `note`: past conversations are not sent until the user asks for `target backfill <id> --since YYYY-MM-DD`. Run a backfill only when the user asks.
3. `target test <id>` and `doctor` (check `target-<id>`) diagnose it; `target set <id> --folders … | --enabled false` changes or pauses it; `target remove <id>` removes it.

Only Codex and Claude Code sessions whose first working directory is inside a target folder are sent there; ChatGPT imports never are. Recall (the MCP tools) reads the user's own server only.

## Safety

- Preserve unrelated hooks and settings. The CLI removes only entries bearing its managed markers and creates timestamped backups before rewriting existing files.
- Never display API tokens, bearer tokens, or secret environment values.
- Never put the gateway's router key on a command line or in chat. `server prepare` writes it into the installed private `.env`, and no result prints it. The opt-in live verification reads it there inside the process, sends it only to this machine's router, discards the completion response body, and reports only success/model.
- The sharing this version supports is connecting to someone else's shared bridge and sending chosen folders to a target the user adds explicitly. Do not add targets, folders or backfills the user did not ask for, and do not add cross-device synchronization.
- Do not claim Honcho was installed when `server start`, `server status`, or `doctor` reports it unreachable. For `personal`, success also requires the gateway's router answering (`host.gateway.router.ok`), healthy Ollama, and the Qwen alias resident.
- Use the same profile for the complete lifecycle. `server status --profile personal` covers Docker, the gateway and Ollama; `server stop --profile personal` stops the containers and the Ollama supervisor while preserving configuration and Docker volumes. The gateway keeps running: it has its own lifecycle, and `node <app-directory>/runtime/subscription-gateway/gateway/cli.mjs uninstall` is what removes it.
- `server stop` preserves Docker volumes. Never run `docker compose down -v` or otherwise delete memory data.
- Do not rerun `apply` with guessed identity values. Ask for the missing peer ID.

## Backup and restore

- Distinguish automatic installation rollback from a durable memory backup. Setup can restore the managed runtime, configuration, and host hook files after a failed apply, but that is not a database backup.
- Before machine migration or destructive repair, require a consistent PostgreSQL dump or offline `pgdata` volume copy and a protected copy of the Honcho Agent Bridge application-data directory. That directory contains the private server `.env`, `config.json`, MCP tool settings, and pending collector spool/state. Include Redis only when in-flight Deriver work must survive; PostgreSQL is the authoritative long-term memory store.
- Do not include the gateway (its source or its logins), Ollama model blobs, plugin caches, or hooks in a portable backup. On the destination computer, install the platform prerequisites, restore the database and private Honcho Agent Bridge files, rerun `server prepare --profile personal` (the user logs in at the gateway screen when it asks), `server start --profile personal`, and `setup apply`. Prepare replaces the restored router key with the new gateway's. Missing Qwen models are recreated by the personal lifecycle.
- Treat backups containing `.env` or `config.json` as secrets and require encrypted storage. Do not state that a backup exists unless its database and application-data contents were actually verified.
