-- 0005: least-privilege runtime role (review finding M5).
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- mandate_runtime is a NOLOGIN group role holding exactly what the application needs at runtime. The API logs in
-- as a separate LOGIN role that is only a member of it (provisioned by `pnpm db:roles`, packages/db/src/roles.ts).
-- Migrations and the seed keep running as the owner. What this buys, and what it does not:
--
--   * The runtime role cannot UPDATE, DELETE or TRUNCATE audit_log or order_event: it lacks the privilege, which
--     is checked before any trigger runs. It cannot ALTER, DISABLE TRIGGER, DROP or change ownership of any table
--     (all of those need ownership), create tables (no CREATE on the schema), create temp tables (TEMPORARY is
--     revoked from PUBLIC), or set session_replication_role (superuser only by default).
--   * The table OWNER and any SUPERUSER can still do all of the above. Append-only therefore holds against the
--     application and anything that compromises it, not against whoever holds the owner credentials. Nothing here
--     makes past rows tamper-evident.
--
-- Roles belong to the whole server, not to one database, so the role is created only if missing. The migrating
-- role needs CREATEROLE for that first creation (VERIFY on Render; otherwise an administrator creates the role
-- once with the attributes below and this migration only grants to it).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mandate_runtime') THEN
    BEGIN
      CREATE ROLE mandate_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- another database on this server created it at the same moment
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'mandate_runtime'
                AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'role mandate_runtime exists with privileged attributes; recreate it NOLOGIN without them';
  END IF;
END;
$$;

-- Nothing implicit: start from no privileges, then grant table by table.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mandate_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mandate_runtime;
-- Temp tables are how name-shadowing attacks on triggers start (finding H2); the runtime never needs them.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END;
$$;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO mandate_runtime;

-- Written by administrators (seed, onboarding), read by the runtime.
--   organization, app_user, schema_migrations: SELECT only (granted above).

-- Mandates are managed through the API. UPDATE also covers FOR NO KEY UPDATE, which reservations need.
GRANT INSERT ON public.mandate TO mandate_runtime;
GRANT UPDATE (approver_user_id, name, status, currency, budget_minor_units, per_item_cap_minor_units,
              approval_threshold_minor_units, max_quantity_per_line, structuring_window_minutes,
              price_drift_tolerance_bps, starts_at, ends_at, policy_version)
  ON public.mandate TO mandate_runtime;
GRANT INSERT, DELETE ON public.category_limit TO mandate_runtime;
GRANT UPDATE (allowed, cap_minor_units) ON public.category_limit TO mandate_runtime;

-- The purchase flow (issue #12). Column lists keep identity, money and evidence columns immutable to the runtime.
GRANT INSERT ON public.purchase_request TO mandate_runtime;
GRANT UPDATE (status, parsed_intent) ON public.purchase_request TO mandate_runtime;
GRANT INSERT ON public.product_snapshot, public.cart, public.cart_item, public.policy_decision TO mandate_runtime;
GRANT INSERT ON public.budget_reservation TO mandate_runtime;
GRANT UPDATE (state, released_at, committed_at, committed_amount_minor_units, expires_at)
  ON public.budget_reservation TO mandate_runtime;
GRANT INSERT ON public.approval TO mandate_runtime;
GRANT UPDATE (status, decided_at, token_used_at) ON public.approval TO mandate_runtime;
GRANT INSERT ON public.purchase_order TO mandate_runtime;
GRANT UPDATE (state, provider_order_id) ON public.purchase_order TO mandate_runtime;
GRANT INSERT ON public.webhook_event TO mandate_runtime;
GRANT UPDATE (processing_state, processed_at) ON public.webhook_event TO mandate_runtime;

-- Append-only: insert and read, nothing else.
GRANT INSERT ON public.audit_log, public.order_event TO mandate_runtime;
