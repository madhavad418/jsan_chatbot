# JSAN Dev AI — Railway Production Edition

Production-oriented Railway package for the 20-seat JSAN developer AI gateway.

## Services

1. `portal` — JSAN Dev AI web UI + API + public `/v1` gateway edge.
2. `litellm` — private LiteLLM gateway; no public domain required.
3. `Postgres` — Railway PostgreSQL for portal + LiteLLM persistence.

## Layout

```
portal/            the public service - one image serving all three
├── frontend/      Vite + React UI
├── backend/       Express API and the /v1 gateway edge
└── database/      @jsan/database - SQLite store (not yet wired into backend)
litellm/           private LiteLLM gateway config
scripts/           local Postgres init
```

The frontend and backend ship in a single container: the Dockerfile builds
`frontend/` and copies the bundle into the runtime image that runs the Express
server, which serves it as static files.

Run the two backing services locally with
`docker compose -f docker-compose.local.yml up -d`.

Only `portal` is public. Use `https://ai.jsanconsulting.com` for the UI and `https://ai.jsanconsulting.com/v1` for developer tools.

Start with `RAILWAY_DEPLOYMENT_GUIDE.md`.
