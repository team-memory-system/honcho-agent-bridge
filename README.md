# codex-honcho-sync

Shared Codex hook scripts for syncing Codex conversations into Honcho.

## Files

- `scripts/codex_honcho_turn_gate.mjs`: hook gate and queue drainer.
- `scripts/codex_honcho_turn_ended.mjs`: Codex rollout importer for Honcho messages.
- `hooks/mac-hooks.json`: macOS Codex hook template.
- `hooks/amd-hooks.json`: AMD Windows Codex hook template.

## Runtime Paths

macOS:

- `~/dev/codex-honcho-sync/scripts/codex_honcho_turn_gate.mjs`
- `~/dev/codex-honcho-sync/scripts/codex_honcho_turn_ended.mjs`
- `~/.codex/hooks.json`

AMD Windows:

- `C:\Users\chenj\dev\codex-honcho-sync\scripts\codex_honcho_turn_gate.mjs`
- `C:\Users\chenj\dev\codex-honcho-sync\scripts\codex_honcho_turn_ended.mjs`
- `C:\Users\chenj\.codex\hooks.json`

The scripts are run on demand by Codex hooks or scheduled drain jobs. They are not long-running Node services.
