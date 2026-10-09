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
publishes only `127.0.0.1:${HONCHO_GATE_PORT:-8010}`. Cloudflare Access covers the
whole host, so everything the tunnel brings carries a person's login: the gate
verifies `Cf-Access-Jwt-Assertion` against
`https://<HONCHO_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` and `HONCHO_ACCESS_AUD`
and requires an `email` claim. What that person may do is in `../runtime/gate`,
mounted at `/gate-state`:

- `access.json`, written by the owner's app: the owners, the teammates who may
  `chat` (with the projects opened to them) and those who collect into this
  server. The gate reads it again when it changes; without it nobody gets in but
  the gate token.
- `devices.json`, written by the gate alone (owner-only): every computer that
  writes here registers once with `POST /team-memory/devices` and then sends its
  key in `X-Team-Memory-Device`. Only the key's hash is kept, and `access.json`
  can revoke one computer.

The doors:

- `GET /team-memory/whoami` tells a person what they may do;
  `DELETE /team-memory/devices/<id>` lets a computer remove its own key.
- `GET /health` and `/v3/*` go to the API. The gate token (`HONCHO_GATE_TOKEN`)
  opens both as before, and the Compose health check uses it. Through Access,
  `/health` answers anyone this server lets in, and `/v3/*` takes an owner's
  registered computer as it is and a collecting teammate's only to write and read
  back their own conversations, whose session ids get the teammate's own `tm-…_`
  prefix.
- `/mcp` and `/mcp/*` go to `mcp` for an owner (every project) or a teammate
  allowed to chat (their projects). The gate drops the caller's credentials,
  `x-honcho-*` and `x-team-memory-*` headers and sends `HONCHO_TEAM_MCP_TOKEN`,
  the verified email, `x-honcho-scope-mode` and `x-honcho-allowed-scopes`. Until
  the team domain, the AUD and the team MCP token are all set, `/mcp` answers 404.

Each refusal leaves a `refused` line with the door and its reason, never an email
or a key, in the gate's log.

`mcp` is honcho-selfhost's `local-mcp-bridge`, built from `honcho/local-mcp-
bridge`. It answers `chat` only, pinned to `HONCHO_TEAM_WORKSPACE` (default
`memory`) and `HONCHO_TEAM_PEER`; with `HONCHO_MCP_SCOPE_FROM_GATE` a teammate's
`chat` answers only from the projects in the gate's scope headers. It records each
call in the audit schema as bridge `team`, with the caller's email, and with
`HONCHO_AUDIT_READ` serves that record at `/audit` to the team MCP token; the
dashboard reads it there (`HONCHO_MCP_AUDIT_URL=http://mcp:8765/audit`) for the
app's 조회 기록, and passes the owner's 가드 시험 to `/guard-trial` beside it. The
gate passes only `/mcp` and `/mcp/*` on, so both stay inside Compose, and `mcp` has
no host port. Without the share profile there is no `mcp`,
and the dashboard's audit read answers 502. The Jev judgment gate comes from
the private `.env` and is off while `HONCHO_JEV_GATE` is empty. In a team the app
writes `HONCHO_JEV_GUARD_URL` and `HONCHO_JEV_GUARD_TOKEN` there, and the bridge
asks the team hub's guard, which holds the team's Jev key; outside a team
`TYPESAFE_API_KEY` (with the optional `TYPESAFE_BASE_URL`, `HONCHO_JEV_MODEL`,
`HONCHO_JEV_THRESHOLD`, `HONCHO_JEV_FAIL_MODE`, `HONCHO_JEV_TOOLS`) has it call
Jev itself. Either way it judges the answer as well as the question, and
`HONCHO_JEV_ANSWER_FAIL_MODE` (closed unless set) decides what happens to an answer
Jev could not judge. `.env.example` describes each.

`tunnel` is `cloudflared` (pinned image tag). It runs the tunnel whose token is
`HONCHO_TUNNEL_TOKEN` in `.env`, and the tunnel's ingress, set in Cloudflare, is
`http://gate:8010`.

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
