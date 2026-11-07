# Deploy runbook: Render

**Related:** [render.yaml](../render.yaml) · **[full deployment guide](deployment-render.md)** · [tech stack](tech-stack.md) · [architecture](architecture.md)

The API, the web app and their Postgres database are described as code in [`render.yaml`](../render.yaml) (a Render Blueprint). This page is the short checklist; [deployment-render.md](deployment-render.md) explains every step, the security model, troubleshooting and recovery.

**Two database logins (issue #14).** The database owner runs migrations from an operator's laptop (`MIGRATION_DATABASE_URL`) and is never set on the API. The API logs in as `mandate_app`, a member of `mandate_runtime` only, created by `pnpm db:roles`. Migrations do **not** run on boot: the Free plan has no pre-deploy command or Shell, and a pre-deploy command would put the owner's credentials into the API's environment. Instead, with `NODE_ENV=production` the API refuses to start unless the schema matches its code and its login is least-privilege; Render then keeps the previous deploy serving.

## First deploy

1. Render dashboard → **New → Blueprint** → `PxA-Labs/Paypal` → branch `main`. Render asks for every `sync: false` variable:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | **Leave empty now.** Set in step 4 |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials from developer.paypal.com → Apps & Credentials (**Sandbox** tab) |
   | `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | `https://<web app URL>/paypal/return` and `/paypal/cancel` |
   | `ANTHROPIC_API_KEY` | The team's LLM key |
   | `WEB_ORIGIN` | The web app's URL, e.g. `https://mandate-web.onrender.com` |
   | `ZAPIER_APPROVAL_WEBHOOK_URL`, `WEB_APP_URL` | Optional, both or neither ([docs/zapier.md](zapier.md)) |
   | `PAYPAL_WEBHOOK_ID` | Optional at first ([guide, step 13](deployment-render.md#13-paypal-webhook-url-and-verification)) |
   | `VITE_API_URL` (on `mandate-web`) | The API's URL. Public: never a secret |

   Never paste these into git, issues, PRs or chat. Judges get sandbox credentials only through the Devpost testing instructions (hard rule 7).
2. **Apply.** Render creates `mandate-db` and builds the services. The first `mandate-api` start fails with `Invalid API configuration: DATABASE_URL (required with NODE_ENV=production)`; that is expected.
3. From your laptop, on the commit being deployed ([guide, steps 7–8](deployment-render.md#7-set-up-migration-credentials)): add your IP `/32` to `mandate-db` → Access Control, then

   ```bash
   read -rs MIGRATION_DATABASE_URL && export MIGRATION_DATABASE_URL NODE_ENV=production   # owner's EXTERNAL URL + ?sslmode=require
   pnpm db:migrate && pnpm db:status
   read -rs MANDATE_APP_DB_PASSWORD && export MANDATE_APP_DB_PASSWORD   # e.g. from: openssl rand -base64 33 | tr -d '\n/+='
   pnpm db:roles
   MANDATE_SEED_DEMO=1 pnpm db:seed                                     # demo data, once
   unset MIGRATION_DATABASE_URL MANDATE_APP_DB_PASSWORD
   ```

   Then remove your IP from the allow list.
4. `mandate-api` → Environment → `DATABASE_URL` = `mandate-db`'s **internal** URL with user `mandate_app` and that password → deploy.
5. Check: `/health` returns `{"status":"ok"}`, `/ready` returns `{"status":"ready","checks":{"postgres":"ok"}}`, and the log has no `Refusing to start` or `not least-privilege` line.
6. Background jobs run inside the web service every 60 s: expired approvals are swept, and orders in `UNKNOWN_OUTCOME` are reconciled from PayPal's `getOrder`. This assumes **one instance**. The sweep locks each row, but `reconcile()` does not, so don't scale the service out until it does.

## Every deploy after that

Merging to `main` deploys automatically (`autoDeployTrigger: commit`). **If the merge adds a migration**, that auto-deploy fails with `pending migrations: …` and the previous release keeps serving. Then:

1. Run `pnpm db:migrate && pnpm db:status` on the merged commit (step 3, owner URL). The running release keeps serving: it accepts a database that is only ahead of it, with a warning.
2. `mandate-api` → **Manual Deploy → Deploy latest commit** (Render does not retry the failed deploy).

Every migration must be backward compatible with the release before it (add, don't rename or drop); see [guide, step 8](deployment-render.md#8-run-database-migrations-safely).

## Rollback

Service → **Events** → pick the last good deploy → **Rollback**. The older release accepts a database that is ahead of it, so this works when the migrations since then were backward compatible. Otherwise fix forward with a new migration; never edit an applied one (the runner refuses edited migrations). Details: [guide, step 15](deployment-render.md#15-rollback-and-recovery).

## Known limits

Checked against Render's docs on 2026-11-07 ([guide: Free-plan limits](deployment-render.md#free-plan-limits)); re-check before relying on them.

| Item | Why it matters |
|---|---|
| **Free Postgres expires** 30 days after creation (14-day grace), has **no backups** and a 1 GB disk. Judging runs to mid-December | Create the database no earlier than needed, `pg_dump` before demos, or move it to a paid plan before submission |
| **Free web services sleep** after 15 minutes idle; the first request then takes tens of seconds | Open the URL a minute before the demo or video; consider a paid instance for judging |
| **No pre-deploy command and no Shell** on Free web services | Migrations, roles and seeding are the operator step above |
| `CREATEROLE` for `pnpm db:roles` | VERIFY on the first deploy. Without it, see [troubleshooting](deployment-render.md#14-troubleshooting) |
| `corepack enable` in the build | Render's Node image must allow corepack to install pnpm 11.14.0. If the build fails here, use `npm install -g pnpm@11.14.0 && pnpm install --frozen-lockfile` |
| Region `singapore` | Close to the team. Judges are mostly US-based; latency is acceptable for a demo. The API and the database must share a region for the internal URL |
