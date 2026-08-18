# Railway deployment — owner runbook

## 1. Create the production project
Create a Railway **Pro** project named `JSAN Dev AI` and a `production` environment. Keep staging separate if you add it later.

## 2. Add PostgreSQL
Add Railway PostgreSQL from `+ New`. It serves **LiteLLM only** — the portal keeps its own state in SQLite. Keep it private; LiteLLM uses its reference variable. Enable daily backups before inviting users; enable PITR when this becomes business-critical.

## 3. Deploy LiteLLM
Create a service named exactly `litellm` from this repository and set **Root Directory** to `/litellm`.

Add variables from `litellm/.env.railway.example`. Generate the master and salt keys locally. Never change `LITELLM_SALT_KEY` after provider credentials have been stored.

Do **not** generate a public domain for LiteLLM. Its Railway healthcheck is `/health/readiness`.

## 4. Deploy the JSAN portal
Create a service named `portal` from the same repository and set **Root Directory** to `/portal`.

Attach a **volume** to the service and mount it at `/data`, then set `SQLITE_PATH=/data/jsan.db`. The container filesystem is ephemeral, so without a volume every deploy starts from an empty database and all accounts are lost.

Add variables from `portal/.env.railway.example`. Railway reference variables connect it privately to LiteLLM.

The portal listens on Railway's injected `PORT`. Healthcheck: `/api/health`.

## 5. Add the public domain
On `portal` only: Settings → Networking → Custom Domain → `ai.jsanconsulting.com`.

Create the CNAME/TXT DNS records Railway gives you. Railway provisions and renews TLS automatically.

Do not expose PostgreSQL or LiteLLM publicly for normal operation.

## 6. Provider onboarding
All four logical groups run on OpenRouter free-tier models, so one OpenRouter key is the only provider credential needed:
- `auto` — Nemotron 3 Super 120B
- `code` — Poolside Laguna S 2.1
- `think` — Nemotron 3 Ultra 550B
- `fast` — Nemotron 3.5 Lightning

The free tier is rate limited per account rather than per developer, so validate throughput against 20 seats before relying on it. Moving a mode to a paid model or a direct provider key is a one-line change in `litellm/config.yaml`.

Models can be stored in LiteLLM's DB (`STORE_MODEL_IN_DB=True`). If you need the LiteLLM Admin UI during maintenance, expose it only temporarily or put it behind your organization's access control; remove public exposure when finished. Never share the master key with developers.

## 7. Registration
Open `https://ai.jsanconsulting.com`, register the owner/test account with the team access code, then verify:
- login/logout
- conversation persistence
- Auto / Code / Think / Fast
- developer key display/rotation
- `/v1/models`
- Codex configuration
- Claude Code configuration

Only then invite the remaining developers. The portal stops new registration at 20 users.

## 8. Production settings
For the 20-user pilot:
- Portal: **exactly 1 replica** — SQLite allows a single writer on a single node, so a second replica would run against its own copy of the database. Scale up rather than out, or move to Postgres first. 0.5–1 vCPU / 512 MB–1 GB is normally enough.
- LiteLLM: 1 replica initially; 1 vCPU / 1–2 GB.
- PostgreSQL: Railway default, with backups enabled.
- Restart policy: On Failure.
- Healthchecks: enabled on both application services.
- Set Railway cost alerts and a hard limit only if you accept the risk that Railway will stop workloads at that limit.

Scale based on measured CPU/memory/latency rather than pre-allocating VM-sized resources.

## 9. Production smoke tests
```bash
curl -fsS https://ai.jsanconsulting.com/api/health
curl -fsS https://ai.jsanconsulting.com/v1/models \
  -H "Authorization: Bearer <developer-key>"
```

Then send one request through each logical mode.

## 10. Release discipline
Use a Git repository. Protect `main`; deploy production from reviewed commits/tags. Keep provider secrets only in Railway Variables. Do not commit `.env` files. Use a staging environment for gateway upgrades/provider changes before production.
