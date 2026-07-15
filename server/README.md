# Bundled Honcho server

Release bundles place the complete AGPL Honcho source in `honcho/`. The local
collector and MCP process stay on the host; this Compose project runs Honcho
API, Deriver, PostgreSQL/pgvector, Redis, and the dashboard.

The setup CLI creates `.env`, generates a database password, and starts this
project. API and dashboard ports bind only to `127.0.0.1`; PostgreSQL and Redis
are not published to the host. Persistent memory lives in named Docker volumes.

`env.personal.example`, when present, contains a sanitized copy of the release
author's model topology. Secret-looking values are always blanked. It may rely
on host-side OpenAI-compatible services and is therefore opt-in.

Never add `.env`, database exports, Docker volumes, API keys, bearer tokens, or
Cloudflare credentials to a release.
