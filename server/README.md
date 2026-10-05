# Bundled Honcho server

The AGPL Honcho runtime source belongs in `honcho/`, and it arrives one of two ways.
A release bundle ships it already prepared. A marketplace plugin downloads the
separate repository named in `honcho-source.json` into a staging directory. For
the `honcho-selfhost` wrapper it initializes the pinned official submodule, applies
the local patches, and exports the runtime into `honcho/`; the upstream checkout
itself stays unchanged.
`server plan` reports the download and never performs it. Both source pins use a
full 40-character `commit` so a plugin version always installs the reviewed source.
The prepared source records upstream and patch provenance in `.honcho-source.json`.

The local collector and MCP process stay on the host; this Compose project runs
Honcho API, Deriver, PostgreSQL/pgvector, Redis, and the dashboard, and, while the
server is shared, the gate, the team MCP bridge and the tunnel.

The setup CLI creates `.env`, generates a database password, and starts this
project. API and dashboard ports bind only to `127.0.0.1`; PostgreSQL and Redis
are not published to the host. Persistent memory lives in named Docker volumes.

Sharing runs three services under the Compose profile `share`.

`gate/gate.mjs` runs as the `gate` service on the dashboard image's Node. It
publishes only `127.0.0.1:${HONCHO_GATE_PORT:-8010}` and has two ways through:

- `GET /health` and `/v3/*`, for the owner's other computers, only with the gate
  token (`HONCHO_GATE_TOKEN`).
- `/mcp` and `/mcp/*`, for teammates, only with a person's Cloudflare Access login.
  The gate verifies `Cf-Access-Jwt-Assertion` against
  `https://<HONCHO_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` and
  `HONCHO_ACCESS_AUD`, and requires an `email` claim. It drops the caller's own
  credentials and `x-honcho-*` headers, then passes the request to `mcp` with
  `HONCHO_TEAM_MCP_TOKEN` and the verified email. Until the team domain, the AUD
  and the team MCP token are all set, `/mcp` answers 404. Each refused login
  leaves an `mcp_refused` line with its reason in the gate's log.

`mcp` is honcho-selfhost's `local-mcp-bridge`, built from
`honcho/local-mcp-bridge`. It answers `chat` only, pinned to
`HONCHO_TEAM_WORKSPACE` (default `memory`) and `HONCHO_TEAM_PEER`. It records each
call in the audit schema as bridge `team`, with the caller's email. It has no host
port.

`tunnel` is `cloudflared` (pinned image tag). It runs the tunnel whose token is
`HONCHO_TUNNEL_TOKEN` in `.env`, and the tunnel's ingress, set in Cloudflare, is
`http://gate:8010`. No cloudflared runs on the host.

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
