# Deploy runbook: Render

**Related:** [render.yaml](../render.yaml) · [tech stack](tech-stack.md) · [architecture](architecture.md)

The API and its Postgres database are described as code in [`render.yaml`](../render.yaml) (a Render Blueprint). The web app (`apps/web`) is added to the same file when it exists.

## First deploy

1. Render dashboard → **New → Blueprint** → connect `PxA-Labs/Paypal` → branch `main`.
2. Render reads `render.yaml` and asks for every `sync: false` variable. Enter:

   | Variable | Value |
   |---|---|
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials from developer.paypal.com → Apps & Credentials (**Sandbox** tab) |
   | `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | `https://<web app URL>/paypal/return` and `/paypal/cancel` (any https URL until the web app exists) |
   | `ANTHROPIC_API_KEY` | The team's LLM key |
   | `WEB_ORIGIN` | The web app's URL, e.g. `https://mandate-web.onrender.com`, so the browser may call the API |
   | `PAYPAL_WEBHOOK_ID` | Optional at first. After the first deploy, add a webhook for `https://<service>.onrender.com/webhooks/paypal` on the sandbox app, then paste its id here |

   The purchase routes are registered only when `DATABASE_URL`, `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are all set. The webhook route also needs `PAYPAL_WEBHOOK_ID`. At boot, the log line `feature disabled: configuration missing` names any variable that is missing (names only, never values). The catalog is the offline fixture until Channel3 is verified (#16).

   Never paste these into git, issues, PRs or chat. Judges get sandbox credentials only through the Devpost testing instructions (hard rule 7).
3. **Apply.** Render creates `mandate-db`, then builds and starts `mandate-api`. The start command runs `pnpm db:migrate` first.
4. Check: `https://<service>.onrender.com/health` returns `{"status":"ok"}`, and `/ready` returns `{"status":"ready","checks":{"postgres":"ok"}}`.
5. Seed the demo data once: service → **Shell** → `pnpm db:seed`.
6. Background jobs run inside the web service every 60 s: expired approvals are swept, and orders in `UNKNOWN_OUTCOME` are reconciled from PayPal's `getOrder`. This assumes **one instance**. The sweep locks each row, but `reconcile()` does not, so don't scale the service out until it does.

## Every deploy after that

Merging to `main` deploys automatically (`autoDeployTrigger: commit`). Migrations run on boot. If one fails, the new version does not start and the previous one keeps serving.

## Rollback

Service → **Events** → pick the last good deploy → **Rollback**. Migrations are forward-only: roll back code, then fix the schema with a new migration, never by editing an applied one (the runner refuses edited migrations).

## Known limits (VERIFY before relying on them)

| Item | Why it matters |
|---|---|
| **Free Postgres expires** 30 days after creation (Render free-tier policy at the time of writing; check the current docs). Judging runs to mid-December | Create the database no earlier than needed, or move it to a paid plan before submission so the judges' demo keeps its data |
| **Free web services sleep** after ~15 minutes idle; the first request then takes tens of seconds | Open the URL a minute before the demo or video; consider a paid instance for judging |
| `corepack enable` in the build | Render's Node image must allow corepack to install pnpm 11.14.0. If the build fails here, use `npm install -g pnpm@11.14.0 && pnpm install --frozen-lockfile` |
| Region `singapore` | Close to the team. Judges are mostly US-based; latency is acceptable for a demo |
