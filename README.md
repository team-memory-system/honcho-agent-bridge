# codex-honcho-sync

Shared Codex hook scripts for syncing Codex conversations into Honcho.

## Files

- `scripts/codex_honcho_turn_gate.mjs`: hook gate and queue drainer.
- `scripts/codex_honcho_turn_ended.mjs`: Codex rollout importer for Honcho messages.
- `hooks/mac-hooks.json`: macOS Codex hook template.
- `hooks/amd-hooks.json`: AMD Windows Codex hook template.
- `launchagents/*.plist`: macOS LaunchAgent templates for env setup and queue draining.

## Runtime Paths

Set these environment variables on each machine:

- `CODEX_HONCHO_SYNC_ROOT`: path to this repository.
- `CODEX_HONCHO_NODE`: path to the Node executable.

macOS:

- `CODEX_HONCHO_SYNC_ROOT=/Users/chenjing/dev/codex-honcho-sync`
- `CODEX_HONCHO_NODE=/opt/homebrew/bin/node`
- `~/.codex/hooks.json`

AMD Windows:

- `CODEX_HONCHO_SYNC_ROOT=C:\Users\chenj\dev\codex-honcho-sync`
- `CODEX_HONCHO_NODE=C:\Users\chenj\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\node.exe`
- `C:\Users\chenj\.codex\hooks.json`

The scripts are run on demand by Codex hooks or scheduled drain jobs. They are not long-running Node services.

The hook templates read `CODEX_HONCHO_SYNC_ROOT` and `CODEX_HONCHO_NODE` at runtime instead of embedding script paths directly.
