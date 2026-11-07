# Deploying Mandate to Render

**Related:** [`render.yaml`](../render.yaml) · [deploy runbook (short)](deploy.md) · [Zapier approvals](zapier.md) · [sandbox spike](spike-results.md) · issue #14

This guide takes you from an empty Render account to a running API, web app and Postgres database. It assumes no prior Render experience. Every command is run from the repository root unless it says otherwise.

> **Sandbox only.** Mandate talks to the PayPal **sandbox** and has no live setting. Never put live PayPal credentials anywhere.
> **No secrets in git, issues, PRs or chat.** Secrets go into the Render dashboard or your local shell, nowhere else.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Render account setup](#2-render-account-setup)
3. [Connect the GitHub repository](#3-connect-the-github-repository)
4. [Deploy with `render.yaml`](#4-deploy-with-renderyaml)
5. [The PostgreSQL database](#5-the-postgresql-database)
6. [Configure secrets](#6-configure-secrets)
7. [Set up migration credentials](#7-set-up-migration-credentials)
8. [Run database migrations safely](#8-run-database-migrations-safely)
9. [Deploy the API](#9-deploy-the-api)
10. [Check health and readiness](#10-check-health-and-readiness)
11. [Test the deployed API](#11-test-the-deployed-api)
12. [PayPal sandbox credentials](#12-paypal-sandbox-credentials)
13. [PayPal webhook URL and verification](#13-paypal-webhook-url-and-verification)
14. [Troubleshooting](#14-troubleshooting)
15. [Rollback and recovery](#15-rollback-and-recovery)

Reference: [How the database is secured](#how-the-database-is-secured) · [Environment variables](#environment-variables) · [Internal and external database URLs](#internal-and-external-database-urls) · [Free-plan limits](#free-plan-limits) · [Running it locally first](#running-it-locally-first) · [What is verified and what is not](#what-is-verified-and-what-is-not)

---

## How the database is secured

Read this once; the steps below follow from it.

| Who | Database login | What it can do | Where its credentials live |
|---|---|---|---|
| **Operator** (you, from a trusted laptop) | The **owner** Render creates with the database (user `mandate`) | Run migrations, create roles, seed demo data. Owns every table | Only in your terminal session, as `MIGRATION_DATABASE_URL`. Never on a Render service |
| **API** (`mandate-api`) | **`mandate_app`**, created by `pnpm db:roles`, a member of the `mandate_runtime` group only | `SELECT`/`INSERT`/`UPDATE` on application tables; `INSERT` only on `audit_log` and `order_event`; `DELETE` only on `category_limit`; read-only `schema_migrations`. No DDL, no `TRUNCATE`, cannot disable triggers | `DATABASE_URL` on `mandate-api` (dashboard secret) |

Why this split matters:

- The append-only audit and order-event tables, and the rule that a PayPal order needs an `ALLOW` decision or a recorded approval, are enforced by **triggers**. Only a table's **owner** can disable a trigger. Running the API as the owner would let a bug or a compromised code path switch those rules off. Running it as `mandate_app` cannot.
- **Migrations never run inside the API.** On the Free instance type Render has no pre-deploy command, and Free web services have no Shell. Even on a paid plan, a `preDeployCommand` runs with the service's own environment, so the owner's credentials would sit in the API's runtime. So migrations are an operator step ([step 8](#8-run-database-migrations-safely)).
- **The API refuses to start** (exit code 1, so Render marks the deploy failed and keeps the previous version serving) when:
  - the schema is not compatible with its code: never migrated, a pending migration, an edited one, or a foreign one (a version this code does not know that is not newer than its own). This is never overridable. A database that is only **ahead** (migrated for the next release: every extra version is newer than this code's) is accepted with a logged warning, so the running release keeps serving, even across Free-plan restarts, until the next one is deployed. That relies on the migration rule in [step 8](#8-run-database-migrations-safely): forward-only and backward compatible;
  - with `NODE_ENV=production`: `DATABASE_URL` is missing; `MIGRATION_DATABASE_URL` or `MANDATE_APP_DB_PASSWORD` is set on the service; or the login is not least-privilege (superuser, owner, `CREATEROLE`, extra grants, …). The last one alone can be overridden with `MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1`, logged at every start ([troubleshooting](#14-troubleshooting)).
- Error messages name variables, roles, tables and migration versions, never values or passwords.

The checks live in `apps/api/src/db/startup.ts` (`checkDatabaseAtStartup`) and `apps/api/src/db/roles.ts` (`runtimeRoleProblems`, `provisionRuntimeRole`). `runtimeRoleProblems` checks the login's and its groups' attributes, memberships and ADMIN OPTION, its own grants and saved settings, ownership, every table and column privilege (including `TRIGGER`, `REFERENCES`, `MAINTAIN`), and `CREATE` on schemas and the database.

Known limits of the model:

- PostgreSQL grants `TEMP` on the database and `EXECUTE` on new functions to `PUBLIC` by default; the check does not flag them. Migration authors must not add `SECURITY DEFINER` functions without revoking `EXECUTE` from `PUBLIC`.
- Roles are cluster-wide: one Render database instance per environment.
- If `CREATE ROLE` / `ALTER ROLE` fails on the server, PostgreSQL may log the statement, which contains the password's SCRAM verifier (not the password). Use generated passwords (the `openssl` command below gives 44 characters), so the verifier cannot be guessed offline.

---

## 1. Prerequisites

| You need | Why | Check |
|---|---|---|
| A GitHub account with access to `PxA-Labs/Paypal` | Render deploys from GitHub | You can open the repository |
| A Render account | Hosting | [dashboard.render.com](https://dashboard.render.com) |
| Node.js **22.18 or newer** | The operator commands run TypeScript through Node's type stripping | `node --version` |
| pnpm 11.14.0 through corepack | Workspace install | `corepack enable && pnpm --version` |
| `git` and a clone of the repository | The operator commands run from it | `git clone https://github.com/PxA-Labs/Paypal.git && cd Paypal && pnpm install --frozen-lockfile` |
| `curl` | Checking the deployed API | `curl --version` |
| A PayPal developer account with a **sandbox** REST app | Payments | [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → **Sandbox** |
| An Anthropic API key | The LLM layer (intent parsing, ranking) | From the team |
| `openssl` (optional) | Generating the API's database password | `openssl version` |

Check out the commit you are deploying (normally `main`) before running any operator command: the commands compare the database with the migrations **in your checkout**.

## 2. Render account setup

1. Sign in at [dashboard.render.com](https://dashboard.render.com) (GitHub sign-in is simplest).
2. Pick or create the **workspace** the team will share. A workspace may have only **one** Free Postgres database at a time ([Free-plan limits](#free-plan-limits)).
3. If the Free database must survive judging (it expires after 30 days), decide now whether to use a paid database plan instead.

## 3. Connect the GitHub repository

1. Render dashboard → **Account settings → Git providers** (or the prompt shown on first use) → connect **GitHub**.
2. Grant the Render GitHub app access to `PxA-Labs/Paypal`. An organization owner may have to approve it.

## 4. Deploy with `render.yaml`

`render.yaml` (a [Render Blueprint](https://render.com/docs/blueprint-spec)) defines three resources:

| Name | Type | Plan | Notes |
|---|---|---|---|
| `mandate-db` | Postgres 17 | free | Region `singapore`, database `mandate`, owner user `mandate`, **no external access** (`ipAllowList: []`) |
| `mandate-api` | Web service, Node | free | Build `corepack enable && pnpm install --frozen-lockfile`; start `pnpm --filter @mandate/api start`; health check `/health`; `NODE_ENV=production`, `HOST=0.0.0.0` |
| `mandate-web` | Static site | — | Vite build of `apps/web`, published from `apps/web/dist` |

0. **Check for existing services first, so nothing is created twice.** The earlier Blueprint (#37) may already have created `mandate-db` and `mandate-api`. Dashboard → **Blueprints** and **Services**: if they exist, do not create a new Blueprint; open the existing one and **Manual sync** after this change is merged. Render ignores `sync: false` variables on an existing Blueprint, so the old `DATABASE_URL` (the owner's connection string from `fromDatabase`) stays on `mandate-api` until you replace it in [step 9](#9-deploy-the-api). Until then the new API refuses to start (`… must be a member of mandate_runtime only …`) and the previous deploy keeps serving. An existing database migrated by the old start command is upgraded in place by steps 7–8 with no data change (verified locally: data and migration history byte-identical).
1. Dashboard → **New → Blueprint** → pick `PxA-Labs/Paypal`, branch `main` → Render reads `render.yaml`.
2. Render asks for every `sync: false` variable ([step 6](#6-configure-secrets)). **Leave `DATABASE_URL` empty for now**: the restricted login it needs does not exist until [step 8](#8-run-database-migrations-safely).
3. **Apply.** Render creates `mandate-db`, then builds `mandate-api` and `mandate-web`.

**Expected on the very first deploy:** `mandate-api` fails to start with
`Invalid API configuration: DATABASE_URL (required with NODE_ENV=production)`. That is the fail-closed check working; you fix it in steps 7–9. `mandate-db` is created regardless.

`sync: false` values are prompted **only when the Blueprint is first created**; later Blueprint syncs ignore them. Change them afterwards in each service's **Environment** tab.

## 5. The PostgreSQL database

Render creates `mandate-db` from the Blueprint: Postgres 17, region `singapore` (the API must be in the same region to use the internal URL), database `mandate`, owner user `mandate`.

After it shows **Available**, open `mandate-db` → **Info** (or **Connect**). You will use two values from it, and **neither is ever pasted into git**:

- **Internal Database URL**: for `mandate-api` (with the user and password changed, [step 9](#9-deploy-the-api)).
- **External Database URL**: for your operator commands only ([step 7](#7-set-up-migration-credentials)).

See [Internal and external database URLs](#internal-and-external-database-urls).

## 6. Configure secrets

Set these on **`mandate-api` → Environment** (as secrets). Names must match exactly; the API validates them at startup.

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | **Yes** (production) | `mandate-db`'s **internal** URL with user `mandate_app` and its password. Set in [step 9](#9-deploy-the-api) |
| `ANTHROPIC_API_KEY` | For purchases | The team's LLM key |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | For purchases | Sandbox app credentials ([step 12](#12-paypal-sandbox-credentials)) |
| `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | For purchases | `https://<mandate-web URL>/paypal/return` and `/paypal/cancel` |
| `PAYPAL_WEBHOOK_ID` | For webhooks | After [step 13](#13-paypal-webhook-url-and-verification) |
| `WEB_ORIGIN` | For the web app | The `mandate-web` URL, e.g. `https://mandate-web.onrender.com` (comma-separate several; bare origins only) |
| `ZAPIER_APPROVAL_WEBHOOK_URL`, `WEB_APP_URL` | Optional, both or neither | [docs/zapier.md](zapier.md) |

And on **`mandate-web` → Environment**: `VITE_API_URL` = the `mandate-api` URL, e.g. `https://mandate-api.onrender.com`. `VITE_*` values are compiled into public JavaScript: never put a secret there.

**Never set on `mandate-api`:** `MIGRATION_DATABASE_URL`, `MANDATE_APP_DB_PASSWORD` (the API refuses to start with them in production), and `MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME` except as a documented emergency. The purchase routes are registered only when `DATABASE_URL`, `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are all set; the boot log line `feature disabled: configuration missing` names whatever is missing (names only). The full list is in [Environment variables](#environment-variables).

## 7. Set up migration credentials

Migrations and role provisioning run **from your laptop** as the database owner, over the database's external URL. Because `render.yaml` blocks all external connections, you open access for your own IP only, for the few minutes you need it.

1. Find your public IPv4 address: `curl -s https://checkip.amazonaws.com`.
2. `mandate-db` → **Access Control** (Networking) → **Add source** → `<your IP>/32` → save.
3. `mandate-db` → **Info** → copy the **External Database URL**. If it does not already contain `sslmode`, add `?sslmode=require` at the end.
4. In a **new terminal**, load it into your shell without echoing it and without writing it to shell history:

   ```bash
   cd Paypal                      # your clone, on the commit being deployed
   read -rs MIGRATION_DATABASE_URL && export MIGRATION_DATABASE_URL   # paste the external URL, press Enter
   export NODE_ENV=production
   ```

   With `NODE_ENV=production` the commands **require** `MIGRATION_DATABASE_URL` and never fall back to `DATABASE_URL`. They print which variable they used, never its value.

Do not put `MIGRATION_DATABASE_URL` in `.env`, in a Render service, in CI, or in any file.

## 8. Run database migrations safely

**First, check what the owner may do** (first deploy only). In the same terminal, with `psql` installed:

```bash
psql "$MIGRATION_DATABASE_URL" -c "SELECT current_user, rolsuper AS is_superuser, rolcreaterole AS can_create_roles, rolcreatedb AS can_create_databases FROM pg_roles WHERE rolname = current_user;"
```

`can_create_roles` must be `t` for `pnpm db:roles`. If it is `f`, **stop**: do not try to obtain superuser or any other privilege, and do not run the API as the owner by default. Agree on one of these with the team (Purvansh owns #14):
1. ask Render support whether the owner can be given `CREATEROLE`, or whether they can create `mandate_runtime` and `mandate_app` for you (then run `pnpm db:roles`, which only needs ADMIN OPTION on existing roles);
2. as a recorded, temporary accepted risk only, the emergency override in [troubleshooting](#14-troubleshooting).

Then:

```bash
pnpm db:migrate      # applies pending migrations, in order, in ONE transaction, under an advisory lock
pnpm db:status       # must print: Up to date (N migrations)
```

What the runner guarantees (`apps/api/src/db/migrate.ts`):

- Files `NNNN_name.sql` run in version order. All pending migrations run in **one transaction**: either all apply or none do, and a failure is reported, never skipped.
- Re-running is safe: applied versions are skipped (`Up to date`). That safety comes from the runner's bookkeeping in `schema_migrations`, **not** from the SQL: the migration files use plain `CREATE TABLE` / `CREATE FUNCTION` and are not idempotent. Never run a migration file by hand (e.g. with `psql -f`); it would fail on a second run, or apply without being recorded.
- It **refuses** to run if an applied migration was edited (checksum) or is missing locally. Never edit an applied migration; add a new one.
- An advisory lock stops two runs from migrating at once.
- Nothing destructive runs automatically: migrations are forward-only SQL reviewed in PRs, and nothing here drops data.
- After migrating, if `mandate_runtime` exists, the runner re-applies its grants so new tables are covered.

**First deploy only: create the API's restricted login.**

```bash
openssl rand -base64 33 | tr -d '\n/+='; echo     # generate a password; store it in your team password manager
read -rs MANDATE_APP_DB_PASSWORD && export MANDATE_APP_DB_PASSWORD   # paste it, press Enter
pnpm db:roles
```

Expected output:

```
Connecting with MIGRATION_DATABASE_URL
Created mandate_runtime; created login mandate_app; granted on 18 tables
Login mandate_app connects and passes the least-privilege check.
Set the API's DATABASE_URL to the database's INTERNAL URL with user mandate_app and this password.
```

`db:roles` is idempotent: run it again to rotate the password (`updated login mandate_app`). The password is sent to Postgres as a SCRAM verifier, never in clear, so it does not appear in server logs. It needs the owner to have the `CREATEROLE` attribute; if it does not, it stops with `role mandate lacks CREATEROLE …` and changes nothing ([troubleshooting](#14-troubleshooting)).

**Demo data (optional).** The web app expects the demo mandate `00000000-0000-4000-8000-000000000021`:

```bash
MANDATE_SEED_DEMO=1 pnpm db:seed     # idempotent; refused in production without MANDATE_SEED_DEMO=1
```

**Close access again:**

```bash
unset MIGRATION_DATABASE_URL MANDATE_APP_DB_PASSWORD
```

Then `mandate-db` → **Access Control** → delete your `/32` entry. Do this every time; do not rely on a later Blueprint sync to reset the list (VERIFY whether it does).

**Every later deploy with a new migration:**

1. Merge the PR. Render auto-deploys it; that deploy **fails** with `pending migrations: NNNN` and the previous release keeps serving. This is expected.
2. Repeat [step 7](#7-set-up-migration-credentials) and run `pnpm db:migrate && pnpm db:status` **on the merged commit**. The running (older) release keeps serving: it accepts a database that is only ahead of it, with a warning.
3. **Deploy again yourself**: `mandate-api` → **Manual Deploy → Deploy latest commit**. Render does not retry the failed auto-deploy.

This works only if every migration is **backward compatible** with the release before it: add tables, add nullable columns or columns with defaults, add indexes. Renaming or dropping a column or table, or tightening a constraint that the old code would violate, needs two releases (stop using it, then remove it).

## 9. Deploy the API

1. Build the API's `DATABASE_URL` from the **Internal Database URL** of `mandate-db`, replacing only the user and password:

   ```
   internal URL:  postgresql://mandate:<owner password>@<internal host>/mandate
   API URL:       postgresql://mandate_app:<the db:roles password>@<internal host>/mandate
   ```

   If the password contains characters other than letters and digits, percent-encode them. The generator above produces letters and digits only.
2. `mandate-api` → **Environment** → set `DATABASE_URL` to that value (and the other secrets from [step 6](#6-configure-secrets)) → **Save, rebuild and deploy** (or **Manual Deploy → Deploy latest commit**).
3. Watch **Logs**. A good start looks like:

   ```
   {"level":30,"msg":"Server listening at http://0.0.0.0:10000"}
   ```

   with no `Refusing to start` line and no `database login is not least-privilege` warning. If purchases are configured you also see no `feature disabled` line for `purchases`.

Background jobs (expired-approval sweep and reconciliation of `UNKNOWN_OUTCOME` orders) run inside this service every 60 s and assume **one instance**: do not scale `mandate-api` out ([`apps/api/src/jobs.ts`](../apps/api/src/jobs.ts)).

## 10. Check health and readiness

```bash
API=https://mandate-api.onrender.com          # your service URL (Dashboard → mandate-api)
curl -s "$API/health"; echo                   # {"status":"ok"}                                 liveness
curl -s -w ' %{http_code}\n' "$API/ready"     # {"status":"ready","checks":{"postgres":"ok"}} 200   readiness
```

- `/health` is liveness only: the process answers. It touches no database and calls no external service, and it is Render's health check (`healthCheckPath`).
- `/ready` runs `SELECT 1` against Postgres with a 2-second timeout and answers `503` with `"postgres":"fail"` if it fails. It never names the error (which could contain connection details) and never calls PayPal.
- On the Free plan the first request after 15 idle minutes can take tens of seconds while the service wakes up.

## 11. Test the deployed API

With the demo seed ([step 8](#8-run-database-migrations-safely)):

```bash
MANDATE=00000000-0000-4000-8000-000000000021
REQUESTER=00000000-0000-4000-8000-000000000011
curl -s "$API/mandates/$MANDATE" | head -c 300; echo          # the demo mandate
curl -s "$API/mandates/$MANDATE/summary"; echo                # spend summary
```

A purchase request (needs `ANTHROPIC_API_KEY` and the PayPal sandbox variables). It runs the LLM intent parser and ranker, the deterministic policy engine and, on `ALLOW`, creates a **sandbox** PayPal order:

```bash
curl -s -X POST "$API/mandates/$MANDATE/purchases" -H 'content-type: application/json' \
  -d "{\"requesterUserId\":\"$REQUESTER\",\"text\":\"Two sets of whiteboard markers for the club room.\",\"requestKey\":\"deploy-check-$(date +%s)\"}"
```

The response holds the decision with every reason and, after `ALLOW`, the order with PayPal's `approveUrl`. Then:

1. Open `approveUrl`, log in as a **sandbox Personal (buyer)** account, approve.
2. Capture: `curl -s -X POST "$API/purchases/<purchaseId>/capture"` (or wait: the webhook or the 60-second reconcile job captures an `APPROVED` order).
3. Audit trail: `curl -s "$API/purchases/<purchaseId>/audit"`.
4. A blocked request (expect `DENY`): the same POST with `"text":"Buy one 100 USD digital gift card for the raffle."`.

The Postman collection in [`postman/`](../postman) has every request; set `baseUrl` to `$API`.

**Gate 1 evidence (issue #14):** record the sandbox order id, capture id and UTC time of one order created **by the deployed service** in [`docs/spike-results.md`](spike-results.md). These are sandbox identifiers, not secrets. Do this only deliberately, with sandbox credentials. No real money moves.

## 12. PayPal sandbox credentials

1. [developer.paypal.com](https://developer.paypal.com) → **Apps & Credentials** → make sure the **Sandbox** toggle is on.
2. Open (or create) the team's REST app. Enable **Accept payments**; for saved-wallet charging also **Vault** ([spike results](spike-results.md)).
3. Copy **Client ID** and **Secret** into `mandate-api` → `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`.
4. Sandbox buyer for approvals: **Testing tools → Sandbox accounts** → a **Personal** account.

`packages/payments` only ever targets `https://api-m.sandbox.paypal.com`; there is no live switch.

## 13. PayPal webhook URL and verification

1. In the sandbox app → **Webhooks → Add webhook**.
2. URL: `https://<mandate-api URL>/webhooks/paypal`.
3. Events: the order and capture events, at least `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`. The handler accepts any `CHECKOUT.ORDER.*` or `PAYMENT.CAPTURE.*` event and re-reads the order from PayPal before acting, so an extra event type is harmless.
4. Save, copy the **Webhook ID**, set `PAYPAL_WEBHOOK_ID` on `mandate-api`, redeploy.
5. Without `PAYPAL_WEBHOOK_ID` the route is **not registered** (its signature could not be verified); the reconcile job still settles orders by polling PayPal.
6. Every delivery's signature is verified with PayPal (`POST /v1/notifications/verify-webhook-signature`) and stored once per PayPal event id (`webhook_event`, unique per provider and event id), so a redelivery is a no-op. Test with the dashboard's **Webhooks simulator** or a real sandbox order. The signature header is redacted from request logs; a delivery that is not processed is logged as `paypal webhook not processed` with its result.

## 14. Troubleshooting

| Symptom (deploy log) | Cause | Fix |
|---|---|---|
| `Invalid API configuration: DATABASE_URL (required with NODE_ENV=production)` | `DATABASE_URL` unset on `mandate-api` | [Step 9](#9-deploy-the-api) |
| `Invalid API configuration: MIGRATION_DATABASE_URL (provisioning credentials must not be set …)` | Owner credentials on the API service | Delete the variable from `mandate-api` → Environment |
| `Refusing to start: the database has never been migrated …` or `pending migrations: 0005` | Migrations not applied for this commit | [Steps 7–8](#7-set-up-migration-credentials), then redeploy |
| `Refusing to start: applied migrations unknown to this code (not newer than its own; histories differ)` | The database holds a migration this branch never had (e.g. it was migrated from another branch) | Deploy the commit whose migrations the database has; never migrate the production database from an unmerged branch |
| Warning `database is migrated for a later release (NNNN)` | The operator migrated for the next release; it has not been deployed yet | Expected between [step 8](#8-run-database-migrations-safely) and the manual deploy |
| `Refusing to start: applied migrations edited since: 0003` | An applied migration file was changed | Restore the file from git; put the change in a new migration |
| `Refusing to start: mandate is a superuser; …` / `owns … objects` | `DATABASE_URL` uses the **owner** | Use `mandate_app` ([step 9](#9-deploy-the-api)) |
| `Refusing to start: … cannot read <table>; run pnpm db:roles` | A new table without grants | `pnpm db:migrate` (re-applies grants) or `pnpm db:roles` |
| `Refusing to start: could not check the database: … ECONNREFUSED / ENOTFOUND / timeout` | Wrong host, the external URL used on Render, different region, or the database is down/expired | Use the **internal** URL; check `mandate-db` status and region |
| `password authentication failed for user "mandate_app"` | Wrong or stale password in `DATABASE_URL` | Re-run `pnpm db:roles` with a new password and update `DATABASE_URL` |
| `pnpm db:roles`: `role mandate lacks CREATEROLE …` | The database owner cannot create roles on this database | Ask Render support for `CREATEROLE`, or use the emergency override below |
| Operator command: `ECONNREFUSED`, timeout, or `no pg_hba.conf entry` | Your IP is not in the allow list, or you used the internal URL | [Step 7](#7-set-up-migration-credentials): add `<IP>/32`, use the **external** URL |
| Operator command: SSL / certificate error | `sslmode` missing or certificate verification failing | Use the external URL exactly as shown, with `?sslmode=require` |
| `MIGRATION_DATABASE_URL is required with NODE_ENV=production` | Operator shell not prepared | `read -rs MIGRATION_DATABASE_URL && export MIGRATION_DATABASE_URL` |
| Build fails at `corepack enable` | Corepack could not install pnpm | Build command `npm install -g pnpm@11.14.0 && pnpm install --frozen-lockfile` |
| `feature disabled: configuration missing` with `missing: [...]` | Purchase/webhook/approval variables not set | Set the named variables ([step 6](#6-configure-secrets)) |
| Browser: CORS error from the web app | `WEB_ORIGIN` does not match the web app's origin exactly | Set `WEB_ORIGIN=https://mandate-web.onrender.com` (no path, no trailing slash) |
| First request takes ~30–60 s | Free web service spun down after 15 idle minutes | Expected; open the URL before a demo |
| Database `Suspended` / connection refused after a month | Free Postgres expired (30 days) | [Free-plan limits](#free-plan-limits) |

**Emergency override.** If the database cannot get a restricted login, you can run the API as the owner by setting `DATABASE_URL` to the owner's **internal** URL **and** `MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1` on `mandate-api`. Every start then logs each finding as `accepted by MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1`. This removes the protection described in [How the database is secured](#how-the-database-is-secured) (the API could disable the audit and payment-authorization triggers); record it as an accepted risk and remove it as soon as possible. The schema check is never overridable.

## 15. Rollback and recovery

- **Code rollback:** `mandate-api` → **Events** → pick the last good deploy → **Rollback**. The older release accepts a database that is ahead of it (newer migrations only), so a rollback works as long as the migrations since then were backward compatible ([step 8](#8-run-database-migrations-safely)); it logs `database is migrated for a later release`. If a migration was not backward compatible, fix forward instead.
- **Fix forward:** migrations are forward-only. Write a new migration that corrects the schema, review it, merge it, run `pnpm db:migrate` ([step 8](#8-run-database-migrations-safely)), deploy. Never edit or delete an applied migration (the runner refuses).
- **A failed migration** changes nothing: all pending migrations run in one transaction. Fix the SQL in a new commit (the failed file was never recorded as applied, so it can still be corrected before it first succeeds) and run `pnpm db:migrate` again.
- **A failed deploy** (any start-up refusal, failed build, or no healthy `/health` within Render's window) leaves the previous successful deploy serving. Read the first `Refusing to start` or `Invalid API configuration` line in the deploy log.
- **Leaked credential:** owner → `mandate-db` → **Credentials** → create a new credential, update your operator notes, delete the old one; API login → re-run `pnpm db:roles` with a new password and update `DATABASE_URL`; PayPal / Anthropic / Zapier → rotate in their dashboards and update `mandate-api`.
- **Data loss on Free:** Free Postgres has **no backups**. Before an important demo, export with `pg_dump` over the external URL ([step 7](#7-set-up-migration-credentials)) or move the database to a paid plan.

---

## Environment variables

`mandate-api` (read by `loadApiConfig()`, `loadLlmConfig()`, `loadPaypalConfig()`, `loadZapierConfig()`):

| Variable | Mandatory? | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | Set by `render.yaml` | `development` | `production` enables the fail-closed checks |
| `PORT` | Set by Render | `3000` | Render injects it |
| `HOST` | Set by `render.yaml` | `127.0.0.1` | `0.0.0.0` on Render |
| `LOG_LEVEL` | No | `info` | pino level |
| `DATABASE_URL` | **Yes** in production | — | Internal URL, user `mandate_app` |
| `WEB_ORIGIN` | For the web app | — | Comma-separated bare origins |
| `ANTHROPIC_API_KEY` | For purchases | — | Plus optional `LLM_PROVIDER`, `LLM_MODEL`, `LLM_TIMEOUT_MS`, `LLM_MAX_OUTPUT_TOKENS` ([.env.example](../.env.example)) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | For purchases | — | Sandbox only |
| `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | For purchases | — | https URLs |
| `PAYPAL_WEBHOOK_ID` | For webhooks | — | Without it the webhook route is off |
| `PAYPAL_TIMEOUT_MS` | No | `20000` | |
| `ZAPIER_APPROVAL_WEBHOOK_URL`, `WEB_APP_URL` | Optional (both or neither) | — | Approval messages ([zapier.md](zapier.md)) |
| `MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME` | **No** (emergency only) | `0` | See [troubleshooting](#14-troubleshooting) |

Operator shell only (refused on `mandate-api` in production):

| Variable | Used by | Notes |
|---|---|---|
| `MIGRATION_DATABASE_URL` | `db:migrate`, `db:status`, `db:roles`, `db:seed` | Owner's **external** URL with `sslmode=require`. Required with `NODE_ENV=production`; locally `DATABASE_URL` is used when unset |
| `MANDATE_APP_DB_PASSWORD` | `db:roles` | 16–256 printable ASCII characters, no spaces |
| `MANDATE_APP_DB_USER` | `db:roles` | Default `mandate_app` |
| `MANDATE_SEED_DEMO` | `db:seed` | `1` allows demo data with `NODE_ENV=production` |

`mandate-web`: `VITE_API_URL` (public), `VITE_MANDATE_ID` (set in `render.yaml`).

## Internal and external database URLs

Render gives every Postgres instance two connection strings ([Render docs](https://render.com/docs/postgresql-creating-connecting)):

| | Internal URL | External URL |
|---|---|---|
| Reachable from | Render services in the **same region** and workspace, over Render's private network | Anywhere on the internet, **if** the IP is in the database's allow list |
| Used by | `mandate-api` (`DATABASE_URL`, user `mandate_app`) | The operator's laptop (`MIGRATION_DATABASE_URL`, owner user) |
| Speed | Faster | Slower (public internet) |
| Affected by `ipAllowList` | No | Yes. `render.yaml` sets `[]`, which blocks every external connection |
| Blueprint reference | `fromDatabase.property: connectionString` (not used for the API on purpose: it carries the owner's credentials) | None; copy it from the dashboard |

## Free-plan limits

From Render's documentation ([Free instances](https://render.com/docs/free), [Blueprint spec](https://render.com/docs/blueprint-spec), [deploys](https://render.com/docs/deploys)), checked 2026-11-07. Plans change; re-check before relying on them.

| Limit | Impact on Mandate |
|---|---|
| Free web services **spin down after 15 minutes** without traffic; the next request waits for a cold start | Demo/judging latency; warm the URL first or use a paid instance |
| **No pre-deploy command** on Free (paid web services only) | Migrations are the operator step in [step 8](#8-run-database-migrations-safely) |
| **No Shell / SSH** on Free web services | Seeding and migrations cannot be run from the dashboard; use the operator procedure |
| Render may restart a Free web service at any time | In-process jobs restart with it; they are idempotent |
| Free Postgres **expires 30 days after creation** (then a 14-day grace period before deletion) | Judging runs past 30 days: create the database late, or upgrade it |
| Free Postgres has **no backups**, a fixed **1 GB** disk, and only **one** per workspace | `pg_dump` before demos; one environment per workspace |
| A deploy whose new instance fails to start or to become healthy is cancelled and the previous deploy keeps serving | A refused **new** deploy is safe. A **restart** of the running release must not be refused either, which is why a database that is only ahead is accepted ([how the database is secured](#how-the-database-is-secured)) |

On a paid instance type the procedure stays the same: we deliberately do not use `preDeployCommand` (it would put owner credentials into the API's runtime).

## Running it locally first

```bash
corepack enable && pnpm install --frozen-lockfile
cp .env.example .env                      # placeholders; the local DATABASE_URL works with docker compose
docker compose up -d --wait               # Postgres 17 on 127.0.0.1:5432
#   port 5432 taken?  POSTGRES_PORT=5442 docker compose up -d --wait   (then use :5442 in .env)
pnpm db:migrate && pnpm db:status         # Applied: 0001, … / Up to date
pnpm db:seed                              # demo data
pnpm dev                                  # API on http://127.0.0.1:3000
curl -s localhost:3000/health; curl -s localhost:3000/ready
```

Locally the API connects as the compose superuser: it starts and logs one summary line `database login is not least-privilege (not enforced outside NODE_ENV=production)`. With `DATABASE_URL` set, it does **not** start if Postgres is down or the schema needs `pnpm db:migrate` (it prints why); unset `DATABASE_URL` to run without a database.

To rehearse production exactly (this creates cluster-wide roles in your local Postgres; `docker compose down -v` removes them):

```bash
APP_PW=$(openssl rand -base64 33 | tr -d '\n/+=')
MANDATE_APP_DB_PASSWORD="$APP_PW" pnpm db:roles
NODE_ENV=production DATABASE_URL="postgres://mandate_app:$APP_PW@127.0.0.1:5432/mandate" pnpm --filter @mandate/api start
```

Tests: `pnpm test` (unit, including PGlite role and start-up tests); with `TEST_DATABASE_URL` set (CI does), also `apps/api/test/postgres.integration.test.ts` and `apps/api/test/deploy.integration.test.ts`, which runs the operator CLI and the API process against a real server as a non-superuser `CREATEROLE` owner, like Render's.

## What is verified and what is not

**Verified offline (2026-11-07):**

- `render.yaml` validates against Render's published schema `https://render.com/schema/render.yaml.json` (the one SchemaStore uses for IDE validation).
- The full local flow above, including production mode with `mandate_app`, and the integration test as a non-superuser `CREATEROLE` owner on Postgres 17.

**VERIFY on the first real deploy** (needs the Render account):

1. `render blueprints validate render.yaml` (Render CLI 2.7+, logged in) or the Validate Blueprint API: Render's own validation, which also checks plans and regions against the workspace.
2. That Render's database owner has `CREATEROLE` (`pnpm db:roles` says so; or run `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user;` over the external URL). If it does not, see [troubleshooting](#14-troubleshooting).
3. That the external URL works with `?sslmode=require` and pg's certificate verification, and that a role created with `CREATE ROLE` (`mandate_app`) may log in over the internal URL (Render's `pg_hba` rules are not documented for custom roles).
4. That `corepack enable` works in Render's Node image with `NODE_VERSION=24.16.0`.
5. Health, readiness, one sandbox purchase and one webhook on the deployed service (Gate 1 evidence in `docs/spike-results.md`).
