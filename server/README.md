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

`env.personal.example` is the personal profile's template. Every chat model
points at the subscription gateway's router (`host.docker.internal:11400`) and
embeddings at Ollama; secret-looking values are always blank. `server prepare
--profile personal` writes the router address, key and chat model that the
installed gateway reports over those defaults. `gateway-source.json` names the
independent `chenjingdev/subscription-gateway` repository and a full commit hash,
so a plugin release always installs the same gateway revision. The gateway is
fetched into the app directory's `runtime/subscription-gateway`, not here: it runs
as its own program, and its own autostart points at those files. Update the pinned
commit only after verifying the new gateway with this installer, and record the
same commit in the root `subscription-gateway/` Git submodule. The submodule is a
development checkout and a visible link to the source; release bundles omit its
contents and use the JSON pin to fetch the runtime during installation.

Never add `.env`, database exports, Docker volumes, API keys, bearer tokens, or
Cloudflare credentials to a release.
