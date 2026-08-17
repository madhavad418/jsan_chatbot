# Railway deployment — owner runbook

## 1. Create the production project
Create a Railway **Pro** project named `JSAN Dev AI` and a `production` environment. Keep staging separate if you add it later.

## 2. Add PostgreSQL
Add Railway PostgreSQL from `+ New`. Keep it private; the application services use its reference variable. Enable daily backups before inviting users; enable PITR when this becomes business-critical.

## 3. Deploy LiteLLM
Create a service named exactly `litellm` from this repository and set **Root Directory** to `/litellm`.

Add variables from `litellm/.env.railway.example`. Generate the master and salt keys locally. Never change `LITELLM_SALT_KEY` after provider credentials have been stored.

Do **not** generate a public domain for LiteLLM. Its Railway healthcheck is `/health/readiness`.

## 4. Deploy the JSAN portal
Create a service named `portal` from the same repository and set **Root Directory** to `/portal`.

Add variables from `portal/.env.railway.example`. Railway reference variables connect it privately to Postgres and LiteLLM.

The portal listens on Railway's injected `PORT`. Healthcheck: `/api/health`.

## 5. Add the public domain
On `portal` only: Settings → Networking → Custom Domain → `ai.jsanconsulting.com`.

Create the CNAME/TXT DNS records Railway gives you. Railway provisions and renews TLS automatically.

Do not expose PostgreSQL or LiteLLM publicly for normal operation.

## 6. Provider onboarding
For first production smoke test, configure only four logical groups:
- `auto` — Gemini
- `code` — Kimi or Claude
- `think` — Claude or OpenAI
- `fast` — Groq

After validation, add Cerebras, OpenRouter and NVIDIA as secondary deployments/fallbacks.

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
- Portal: 1 replica initially; 0.5–1 vCPU / 512 MB–1 GB is normally enough.
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
