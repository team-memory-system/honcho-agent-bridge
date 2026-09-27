---
name: setup-memory
description: Install, update, or diagnose the bundled self-hosted personal-memory runtime for Codex and Claude Code. Use when the user asks to set up memory, connect coding agents to Honcho, choose which detected agents receive hooks, inspect an installation plan, repair hooks, or run a memory health check.
---

# Setup Memory

Use the deterministic CLI bundled at `<plugin-root>/scripts/cli.mjs`. Resolve `<plugin-root>` as the directory two levels above this `SKILL.md`. Never reconstruct its mutations manually when the CLI supports them.

## Workflow

1. Run `node <plugin-root>/scripts/cli.mjs detect` and inspect the JSON.
   - If a configured Honcho server is already healthy, offer to connect to it and do not replace it.
   - If Honcho is unreachable, determine which bundled profile is available. `personal` requires both `server/env.personal.example` and `server/host-profile.personal.json`; otherwise use `portable`.
   - Recommend `personal` when it is bundled. Explain that one server lifecycle manages the Docker Honcho stack plus the host Codex proxy and Ollama/Qwen 8192 services. Offer `portable` when the user wants a generic external OpenAI-compatible setup without managed host models.
   - Run `node <plugin-root>/scripts/cli.mjs server plan --profile <profile>` and show its exact operations before any mutation. Never delete or replace Docker volumes.
   - On Windows, treat Docker Desktop with the WSL 2 backend, enabled virtualization/WSL features, and Ollama on `PATH` as prerequisites. The server plan automatically checks Docker CLI/Compose and engine health; personal preparation checks Codex auth, npm/pnpm, Ollama CLI/API, and the base/alias/context. It does not independently enable WSL, clear a pending reboot, or preflight every port. When Docker reports an incomplete WSL setup or reboot requirement, stop and tell the user to finish it, reboot if requested, and rerun detection and the plan.
   - If Docker or Ollama is missing, offer to install the missing prerequisite with the detected OS's official package manager or vendor installer. Treat this as a separate, explicit confirmation because it installs system software. Verify the publisher/source, avoid piping a downloaded script directly into a shell, and rerun `detect` and `server plan` after installation. On Windows, complete any requested WSL feature enablement and reboot before continuing. If an official unattended path is unavailable, open or provide the official installer and guide the user through it rather than silently substituting an unofficial package.
   - For `personal`, require the current user's existing Codex OAuth login. If the plan reports missing or unusable credentials, tell the user to run `codex login` locally and rerun the plan. Never copy `~/.codex/auth.json`, place it in Docker, include it in a release, or ask the user to paste any of its values.
   - After confirmation, run `node <plugin-root>/scripts/cli.mjs server prepare --profile <profile>`. For `personal`, this prepares the private Docker environment, proxy dependencies, and the Qwen3 base model with its 8192-token alias. The LLM proxies are a separate lifecycle: `host start` launches their supervisor detached, and nothing is registered with launchd, the Windows task scheduler or systemd - so after a reboot they stay down until the app or `host start` runs again. For `portable`, if it reports `missingSecretFields`, tell the user which fields to fill in the returned installed `.env` path. Never ask the user to paste their values into chat.
   - Once `server prepare` reports `ready: true`, run `node <plugin-root>/scripts/cli.mjs server start --profile <profile>`. With `personal`, this must start and verify the host supervisor before Compose. Require `server status --profile personal`, `server verify --profile personal`, and Honcho health to pass before continuing. Default verification does not invoke a Codex completion; use `--live-completion` only after the user explicitly asks for or confirms a real model call.
2. Ask which detected agents to configure before planning.
   - Prefer the host's native structured question tool when available (`request_user_input` in supported Codex modes or `AskUserQuestion` in Claude Code).
   - Offer all detected agents as the recommended choice, the current agent only, and manual selection.
   - If no structured question tool exists, ask one concise question using the host's permitted interaction style.
3. Ask whether to use the detected OS application-data location or a custom data directory. Recommend the detected default. Ask for a path only when the user chooses custom storage, then pass it as `--data-dir`.
4. Ask for a user peer ID only when none is already configured. Default the workspace to `memory` and the Honcho URL to `http://127.0.0.1:8001` unless detection found configured values. Use `--codex-root` only when the Codex session directory is nonstandard. If the portable profile needs an API key, have the user place it in the installed private `server/.env`; never request that they paste a secret into chat or pass it as a command-line argument. The personal profile generates its Docker-to-proxy shared secret locally and obtains model access from the existing Codex login.
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
9. Tell the user to restart newly configured agent hosts so their tool and hook caches reload.
   - Claude Code may use `/reload-plugins`; Codex should start a new session or restart.

## Safety

- Preserve unrelated hooks and settings. The CLI removes only entries bearing its managed markers and creates timestamped backups before rewriting existing files.
- Never display API tokens, bearer tokens, or secret environment values.
- Never put the personal proxy secret on a command line. The opt-in live verification must read it from the installed private `.env` inside the process, discard the completion response body, and report only success/model.
- Do not add company-memory sharing, automatic folder policies, or cross-device synchronization in this version.
- Do not claim Honcho was installed when `server start`, `server status`, or `doctor` reports it unreachable. For `personal`, success also requires a healthy Codex proxy, healthy Ollama, and the Qwen alias resident.
- Use the same profile for the complete lifecycle. `server status --profile personal` covers Docker and host services; `server stop --profile personal` stops both while preserving configuration and Docker volumes.
- `server stop` preserves Docker volumes. Never run `docker compose down -v` or otherwise delete memory data.
- Do not rerun `apply` with guessed identity values. Ask for the missing peer ID.

## Backup and restore

- Distinguish automatic installation rollback from a durable memory backup. Setup can restore the managed runtime, configuration, and host hook files after a failed apply, but that is not a database backup.
- Before machine migration or destructive repair, require a consistent PostgreSQL dump or offline `pgdata` volume copy and a protected copy of the Honcho Agent Bridge application-data directory. That directory contains the private server `.env`, `config.json`, MCP tool settings, and pending collector spool/state. Include Redis only when in-flight Deriver work must survive; PostgreSQL is the authoritative long-term memory store.
- Do not include Codex `auth.json`, Ollama model blobs, generated proxy dependencies, plugin caches, or hooks in a portable backup. On the destination computer, install the platform prerequisites, run `codex login`, restore the database and private Honcho Agent Bridge files, and rerun `server prepare/start --profile personal`, `host start`, plus `setup apply`. Missing Qwen models are recreated by the personal lifecycle.
- Treat backups containing `.env` or `config.json` as secrets and require encrypted storage. Do not state that a backup exists unless its database and application-data contents were actually verified.
