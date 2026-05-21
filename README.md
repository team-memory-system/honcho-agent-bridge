# codex-honcho-sync

Shared Codex hook scripts for syncing Codex conversations into Honcho.

## Files

- `scripts/codex_honcho_turn_gate.mjs`: hook gate and queue drainer.
- `scripts/codex_honcho_turn_ended.mjs`: Codex rollout importer for Honcho messages.
- `hooks/mac-hooks.json`: macOS Codex hook template.
- `hooks/amd-hooks.json`: AMD Windows Codex hook template.
- `launchagents/*.plist`: macOS LaunchAgent templates for env setup and queue draining.

## Runtime Paths

Create a local `.env` file on each machine. This file is intentionally not stored in the repo.

macOS:

- env file: `~/.config/codex-honcho-sync/.env`
- example: `config/macos.env.example`
- `~/.codex/hooks.json`

AMD Windows:

- env file: `C:\Users\chenj\.config\codex-honcho-sync\.env`
- example: `config/windows.env.example`
- `C:\Users\chenj\.codex\hooks.json`

The scripts are run on demand by Codex hooks or scheduled drain jobs. They are not long-running Node services.
Scheduled `--drain-if-due` runs only when the gate detects an external network; manual `--drain` still runs on any network.

The hook templates read `CODEX_HONCHO_SYNC_ROOT` and `CODEX_HONCHO_NODE` from the fixed `.env` path at runtime instead of embedding script paths directly.
