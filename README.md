# Honcho Agent Bridge

Self-contained Codex and Claude Code plugin for one personal, self-hosted Honcho memory.

The repository bundles the conversation collectors, setup/diagnostic workflow, a dependency-free MCP bridge, and a release builder for the complete local Honcho Docker stack. It does not publish or download an npm package.

## Current scope

- Capture Codex and Claude Code conversations into one personal Honcho workspace.
- Recall memory through the 31 Honcho tools exposed by the bundled MCP server.
- Detect installed agents, preview setup changes, preserve unrelated settings, and create backups.
- Run on macOS, Windows, and Linux wherever a recent Node.js runtime is available.

Company memory, folder-based sharing rules, and cross-device database synchronization are intentionally deferred until the personal-memory package is complete.

## Prerequisites

- Node.js 18 or newer.
- Docker Desktop/Engine with Compose when installing the bundled local Honcho server, or an existing Honcho API at `http://127.0.0.1:8001`.
- This repository installed as a plugin in each agent host that should receive Honcho MCP tools.

The `personal` profile also requires macOS or Windows, a working Codex login, and Ollama on the host. It reuses the current user's `~/.codex/auth.json`; it never copies Codex credentials into the plugin, Docker image, release archive, or private server environment. Run `codex login` on a new computer before setup. The setup process validates only that usable access and refresh credentials exist. Native Linux currently supports the `portable` profile; its Docker bridge cannot safely reach the personal profile's loopback-only host services without an additional binding design.

On Windows, Docker Desktop must use its WSL 2 backend, hardware virtualization and the WSL features must be enabled, and Ollama must be installed for the current user and available on `PATH`. `server plan` checks Docker CLI/Compose and engine health; personal preparation checks Codex authentication, npm/pnpm, Ollama and its local API, and the required base/alias/context. Docker engine readiness is the current gate for the WSL backend: setup does not independently enable WSL, clear a pending reboot, or preflight every port. If Docker reports that a WSL feature change requires a reboot, restart Windows and run the same plan again.

When Docker or Ollama is absent, the setup skill offers an explicitly confirmed installation through the detected platform's official package manager or vendor installer, then reruns the prerequisite checks. System software installation is never hidden inside the release archive.

One setup run can enable conversation collection for every detected agent. Installing the plugin in each host is still required for that host to receive the skills and MCP tools.

## Plugin installation

From a private Git repository, replace `OWNER/REPOSITORY` below:

```sh
codex plugin marketplace add OWNER/REPOSITORY
codex plugin add honcho-agent-bridge@honcho-agent-bridge

claude plugin marketplace add OWNER/REPOSITORY
claude plugin install honcho-agent-bridge@honcho-agent-bridge
```

For a local checkout, pass its absolute directory instead of `OWNER/REPOSITORY`. Start a new Codex session or reload Claude plugins after installation. Then invoke `$setup-memory` in Codex or `/memory-setup` in Claude Code.

## Setup

Use the bundled `setup-memory` skill. It follows this sequence:

1. Detect Codex, Claude Code, the current configuration, Honcho health, and the local Docker/host-model prerequisites for the selected profile.
2. Ask which detected agents should collect conversations.
3. Offer the OS-default storage location or a custom path.
4. Show the exact installation plan without changing files.
5. Apply only after confirmation.
6. Run the diagnostic checks and explain whether a host reload is needed.

### Server profiles

| Profile | What runs in Docker | What runs on the host | Model credentials | Intended use |
| --- | --- | --- | --- | --- |
| `personal` | Honcho API, Deriver, PostgreSQL/pgvector, Redis, dashboard | Codex OpenAI-compatible proxy, Ollama, `qwen3-embedding-honcho-8192`, collector and MCP bridge | Reuses the current `codex login`; the Docker-to-proxy shared secret is generated locally | macOS/Windows reproduction of this self-hosted topology with local 1536-dimensional, 8192-token embeddings |
| `portable` | Honcho API, Deriver, PostgreSQL/pgvector, Redis, dashboard | Collector and MCP bridge only | External OpenAI-compatible API key entered in the installed private `.env` | Generic installation when the personal host topology is unavailable or unwanted |

The `personal` profile requires `server/env.personal.example` and `server/host-profile.personal.json`. The LLM proxy is an independently installed service from `../llm-proxy`; this bundle neither includes its source nor starts/stops it by default (`codexProxy.enabled: false` means externally managed). Supply that service's existing shared key as `LLM_VLLM_API_KEY` in a private source or installed `.env` before preparing. No random proxy key is generated for an external service. `server prepare --profile personal` prepares Honcho and local Ollama; the host supervisor keeps the Qwen alias resident. Server stop leaves the independently managed proxy running. Legacy opt-in managed profiles must explicitly set `codexProxy.enabled: true` and may set `codexProxy.sourceDir` to an independently installed source directory.

For development or recovery, the same deterministic workflow is available directly:

```sh
node scripts/cli.mjs detect
node scripts/cli.mjs server plan --profile personal
node scripts/cli.mjs server prepare --profile personal
# If Codex authentication is missing or expired, run `codex login` locally,
# then rerun prepare. Never paste or copy auth.json into the bundle.
node scripts/cli.mjs server start --profile personal
node scripts/cli.mjs server status --profile personal
node scripts/cli.mjs server verify --profile personal
node scripts/cli.mjs setup plan --agents codex,claude --user-peer user_name
node scripts/cli.mjs setup apply --agents codex,claude --user-peer user_name
node scripts/cli.mjs doctor
```

For a portable install, replace `personal` with `portable`. `server prepare` reports the blank external LLM credential fields without printing their values; fill only those fields in the returned installed `.env` path before running `server start`. The collector and MCP bridge always remain on the host so they can read agent transcripts and integrate with the host tool cache. The Honcho API, dashboard, Codex proxy, and Ollama endpoints bind to localhost; database ports are not exposed.

`server verify --profile personal` performs a production-shaped, non-destructive diagnostic: combined server status, a local Ollama embedding request proven to exceed 2048 evaluated tokens with truncation disabled and exactly 1536 output dimensions, Docker API-container access to both host services, and Honcho health. It does not call a Codex model by default. Add `--live-completion` only when an actual minimal Codex completion is intended; the command reads the installed proxy secret internally, never places it on a command line, returns only success and model, and discards the completion body.

## Building a distributable bundle

The release builder copies this plugin and a complete Honcho source checkout, removes runtime state and secret-bearing files, preserves the Honcho AGPL license, records the exact source commit, and creates a tarball:

```sh
node scripts/build-distribution.mjs \
  --honcho-source /path/to/custom-honcho \
  --env-source /path/to/custom-honcho/.env
```

The optional environment source becomes `server/env.personal.example`, and its non-secret host requirements become `server/host-profile.personal.json`. Model names, dimensions, context length, ports, and topology remain; keys, tokens, passwords, credentials, and secret-looking values are blank. The resulting bundle contains no conversations, database volume, Codex authentication, or Ollama model blobs. Run `server plan`, `prepare`, and `start` with `--profile personal` to reproduce the complete Docker-plus-host topology. Use `--profile portable` for the generic external OpenAI-compatible configuration.

`setup apply` copies the runtime to a stable application-data directory, writes a private `config.json`, merges only the managed Codex Stop hook, and removes obsolete Honcho Agent Bridge hooks. Claude Code uses the hook bundled with the plugin. Existing unrelated hooks and settings are preserved.

## Runtime locations

| Platform | Default application data |
| --- | --- |
| macOS | `~/Library/Application Support/HonchoAgentBridge` |
| Windows | `%LOCALAPPDATA%\HonchoAgentBridge` |
| Linux | `$XDG_DATA_HOME/honcho-agent-bridge` or `~/.local/share/honcho-agent-bridge` |

The directory contains the private configuration and data plus isolated runtime trees: `runtime/collector` for the replaceable collector/MCP bridge and, in the personal profile, `runtime/host` for the long-running proxy/Ollama supervisor. Collector rollback is retained beside it as `runtime/collector.previous`; server rollback uses `server.previous`. Override the application-data root for testing with `HONCHO_AGENT_BRIDGE_HOME`; override the detected user home with `HONCHO_AGENT_BRIDGE_USER_HOME`.

## Architecture

```text
Codex Stop hook ─┐
Claude plugin hook ──> main.mjs ─> queue.mjs ─> collector.mjs ─> Honcho API
                 │                                  └─> providers/<agent>.mjs
Agent host ──────┴─> bundled stdio MCP ─────────────────────────> Honcho API

personal profile only:
Honcho containers ──> host Codex proxy ──> existing Codex OAuth session
Honcho containers ──> host Ollama ───────> Qwen3 1536d / 8192-token embeddings
Native user service ─────────────────────> keeps proxy and Qwen resident
```

The queue keeps failed imports and retries them on the next agent Stop hook or an explicit queue drain. Its personal local-server defaults drain every newly queued transcript immediately. Transcript parsing is provider-specific; storage, deduplication, peer configuration, and API writes are shared.

## MCP tools

Codex loads `.mcp.json`; Claude Code loads `.mcp.claude.json`. Both start `scripts/mcp-server.mjs` through stdio and read the same external `config.json`, so no credentials or mutable state live inside a plugin cache.

All 31 bridge tools are available by default. To hide tools, write this file under the configured data directory as `mcp-tools.json`:

```json
{
  "disabled_tools": ["delete_session", "create_conclusions"]
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
- Codex `auth.json`, Ollama model blobs, generated proxy dependencies, plugin caches, and hooks are deliberately outside the portable backup set. On a restored computer, install the prerequisites, run `codex login`, restore the database and private Honcho Agent Bridge files, then rerun `server prepare/start --profile personal`, `host start`, and `setup apply`. Qwen models are recreated when absent.
- Keep backups encrypted because the private `.env` and Honcho Agent Bridge configuration can contain database passwords or API bearer tokens. The release builder never includes them.
- `server stop --profile personal` preserves Docker volumes. Never use `docker compose down -v` unless permanently deleting the memory database is the explicit goal.

## Verification

```sh
npm test
claude plugin validate .
```

The tests exercise isolated installation, hook preservation and cleanup, transcript edge cases, all 31 MCP definitions, REST forwarding, and per-tool disabling without touching the live user configuration.
