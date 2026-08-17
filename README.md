# JSAN Dev AI — Railway Production Edition

Production-oriented Railway package for the 20-seat JSAN developer AI gateway.

## Services

1. `portal` — JSAN Dev AI web UI + API + public `/v1` gateway edge.
2. `litellm` — private LiteLLM gateway; no public domain required.
3. `Postgres` — Railway PostgreSQL for portal + LiteLLM persistence.

Only `portal` is public. Use `https://ai.jsanconsulting.com` for the UI and `https://ai.jsanconsulting.com/v1` for developer tools.

Start with `RAILWAY_DEPLOYMENT_GUIDE.md`.
