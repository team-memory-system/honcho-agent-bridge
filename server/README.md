# Bundled Honcho server

The AGPL Honcho source belongs in `honcho/`, and it arrives one of two ways.
A release bundle ships it already filled. A plugin installed from a marketplace
cannot carry it — the source is AGPL and lives in its own repository, which is
why `.gitignore` here excludes the directory — so `server prepare` clones the
repository named in `honcho-source.json` into `honcho/` before it builds
anything. `server plan` reports that download and never performs it. Set a full
40-character `commit` in that file to tie a plugin version to one Honcho commit;
with only `ref`, every install takes the current tip of that branch.

The local collector and MCP process stay on the host; this Compose project runs
Honcho API, Deriver, PostgreSQL/pgvector, Redis, and the dashboard.

The setup CLI creates `.env`, generates a database password, and starts this
project. API and dashboard ports bind only to `127.0.0.1`; PostgreSQL and Redis
are not published to the host. Persistent memory lives in named Docker volumes.

`env.personal.example` is the personal profile's template. Every chat model
points at the subscription gateway's router (`host.docker.internal:11400`) and
embeddings at Ollama; secret-looking values are always blank. `server prepare
--profile personal` writes the router address, key and chat model that the
installed gateway reports over those defaults. `gateway-source.json` names the
gateway's repository the way `honcho-source.json` names Honcho's, but the gateway
is fetched into the app directory's `runtime/subscription-gateway`, not here: it
runs as its own program, and its own autostart points at those files.

Never add `.env`, database exports, Docker volumes, API keys, bearer tokens, or
Cloudflare credentials to a release.
