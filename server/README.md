# Bundled Honcho server

The AGPL Honcho runtime source belongs in `honcho/`, and it arrives one of two ways.
A release bundle ships it already prepared. A marketplace plugin downloads the
separate repository named in `honcho-source.json` into a staging directory. For
the `honcho-selfhost` wrapper it initializes the pinned official submodule, applies
the local patches, and exports the runtime into `honcho/`; the upstream checkout
itself stays unchanged. Earlier flat source repositories are accepted too.
`server plan` reports the download and never performs it. Both source pins use a
full 40-character `commit` so a plugin version always installs the reviewed source.
The prepared source records upstream and patch provenance in `.honcho-source.json`.

The local collector and MCP process stay on the host; this Compose project runs
Honcho API, Deriver, PostgreSQL/pgvector, Redis, and the dashboard.

The setup CLI creates `.env`, generates a database password, and starts this
project. API and dashboard ports bind only to `127.0.0.1`; PostgreSQL and Redis
are not published to the host. Persistent memory lives in named Docker volumes.

`gate/gate.mjs` is the token gate that `server share enable` runs as the `gate`
service (Compose profile `share`, reusing the dashboard image's Node) when the
owner shares this server with their other computers through a Cloudflare tunnel.
It publishes only `127.0.0.1:${HONCHO_GATE_PORT:-8010}` and forwards only
`GET /health` and `/v3/*`, and only with the gate token.

`host/mesh-forwarder.mjs` is the Mesh way in (`server share enable --mesh`, for an owner with no domain). The host supervisor runs it as a child process while `runtime/share.json` has `mesh.enabled`. It listens on `0.0.0.0:<mesh.port>`, passes only connections that arrived on a `100.96.0.0/12` address to `127.0.0.1:<mesh.gatePort>`, and writes `runtime/host/mesh-forwarder.json` while it listens. `share.json` holds `tunnel` (true while the Cloudflare tunnel is on) and `mesh: {enabled, port, gatePort, enabledAt, lastAddress}`.

`env.personal.example` is the personal profile's template. Every chat model
points at the subscription gateway's router (`host.docker.internal:11400`) and
embeddings at Ollama; secret-looking values are always blank. `server prepare
--profile personal` writes the router address, key and chat model that the
installed gateway reports over those defaults. `gateway-source.json` names the
`team-memory-system/subscription-gateway` repository and a full commit hash, so a
plugin release always installs the same gateway revision. The gateway is fetched
into the app directory's `runtime/subscription-gateway`, not here: it runs as its
own program, and its own autostart points at those files. Update the pinned commit
only after verifying the new gateway with this installer.

Embeddings use Qwen3-Embedding 4B (`qwen3-embedding:4b`, 1536 dimensions, an
8192-token context) through the Ollama alias `qwen3-embedding-4b-honcho-8192`.
An install whose `.env` already names the earlier 8B alias
`qwen3-embedding-honcho-8192` keeps it, because its stored vectors were made by
8B; that alias is only ever created from `qwen3-embedding:8b`. No Modelfile is
bundled: host prepare writes one from the alias's own base into the host runtime
directory right before `ollama create`.

Never add `.env`, database exports, Docker volumes, API keys, bearer tokens, or
Cloudflare credentials to a release.
