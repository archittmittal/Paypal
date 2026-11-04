-- 0007: organization roles, refunds tracked apart from the payment, and large-object hardening.
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- Decisions this implements:
--   1. 'owner' stays a role, with the permissions below, and nobody assigns a role to themselves.
--   4. A refund never changes the captured order's state. Refunds live in their own table with their own status;
--      the order keeps the payment state it reached (CAPTURED, SHIPPED, DELIVERED).
--   Hardening: mandate_runtime should not create large objects (second review nit). PostgreSQL has no privilege for
--   creating large objects; the only control is EXECUTE on the creating functions, which only their owner (the
--   bootstrap superuser) can revoke. This file revokes it when it runs as a superuser and otherwise warns;
--   `pnpm db:harden` does the same later as a superuser. runtimeRoleProblems() reports it until it is done.
--
-- Role permissions inside an organization (enforced here and in 0006; docs/er-diagram.md has the table):
--   requester  raises purchase requests. Administers nothing.
--   approver   may be named a mandate's approver and decide its approvals (never for their own request).
--   admin      everything an approver can, plus mandates, budgets, caps, category limits, approver assignments
--              (0006), and the roles requester/approver of OTHER users.
--   owner      everything an admin can, plus granting or removing admin and owner. An organization that has an
--              owner keeps at least one.
--   Nobody changes their own role through the API. The database owner role (seed, onboarding) is outside these rules
--   except the last-owner and approver rules below, which bind every writer.
--
-- New SQLSTATE: none. MD010 (not authorized), MD011 (approver not eligible), MD012 (illegal approval or refund
-- change), MD013 (existing rows refused) are reused.

-- 0. Existing rows ------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.purchase_order WHERE state IN ('REFUND_REQUESTED', 'REFUNDED')
     OR (state = 'FAILED' AND provider_capture_id IS NOT NULL);
  IF n > 0 THEN
    RAISE EXCEPTION 'migration 0007 refused existing data: % order(s) carry a refund state or failed after capture; refunds are now tracked in the refund table and the order keeps its payment state', n
      USING ERRCODE = 'MD013';
  END IF;
END;
$$;

-- 1. Orders no longer take refund states (decision 4) ------------------------------------------------------------
ALTER TABLE public.purchase_order DROP CONSTRAINT purchase_order_state_check;
ALTER TABLE public.purchase_order
  ADD CONSTRAINT purchase_order_state_check
    CHECK (state IN ('PAYMENT_PENDING', 'CAPTURED', 'FAILED', 'UNKNOWN_OUTCOME', 'SHIPPED', 'DELIVERED'));

-- The diagram without the refund branch. A captured order can no longer become FAILED by any path.
CREATE OR REPLACE FUNCTION public.order_transition_allowed(from_state text, to_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (from_state, to_state) IN (
    ('CREATED', 'QUOTED'), ('QUOTED', 'POLICY_CHECKED'),
    ('POLICY_CHECKED', 'DENIED'), ('POLICY_CHECKED', 'PENDING_APPROVAL'), ('POLICY_CHECKED', 'PAYMENT_PENDING'),
    ('PENDING_APPROVAL', 'APPROVED'), ('PENDING_APPROVAL', 'REJECTED'), ('PENDING_APPROVAL', 'EXPIRED'),
    ('APPROVED', 'PAYMENT_PENDING'), ('APPROVED', 'QUOTED'),
    ('PAYMENT_PENDING', 'CAPTURED'), ('PAYMENT_PENDING', 'FAILED'), ('PAYMENT_PENDING', 'UNKNOWN_OUTCOME'),
    ('UNKNOWN_OUTCOME', 'CAPTURED'), ('UNKNOWN_OUTCOME', 'FAILED'),
    ('CAPTURED', 'SHIPPED'), ('SHIPPED', 'DELIVERED'));
$$;

-- 2. Refunds (decision 4) -----------------------------------------------------------------------------------------
-- A refund of part or all of a captured order. COMPLETED needs PayPal's refund id and status COMPLETED, recorded by
-- the payments module from PayPal's response; the database cannot call PayPal and records only what it is given.
-- Refunds do not yet credit the mandate budget back (documented; issue #12).
CREATE TABLE public.refund (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES public.purchase_order (id),
  -- Generated before the refund call and reused on every retry of it (PayPal-Request-Id).
  idempotency_key    text NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,108}$'),
  status             text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'COMPLETED', 'REJECTED')),
  amount_minor_units minor_units NOT NULL CHECK (amount_minor_units > 0),
  currency           currency_code NOT NULL,
  provider           text NOT NULL DEFAULT 'paypal' CHECK (length(provider) BETWEEN 1 AND 64),
  provider_refund_id text CHECK (provider_refund_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  -- PayPal's own refund status as the payments module read it.
  provider_status    text CHECK (length(provider_status) BETWEEN 1 AND 32),
  reason             text CHECK (length(reason) BETWEEN 1 AND 500),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  CHECK ((status = 'REQUESTED') = (decided_at IS NULL)),
  CHECK (status <> 'COMPLETED' OR (provider_refund_id IS NOT NULL AND provider_status IS NOT NULL AND provider_status = 'COMPLETED')),
  UNIQUE (provider, provider_refund_id)
);
CREATE INDEX refund_order_idx ON public.refund (order_id);

CREATE FUNCTION public.enforce_refund() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o          record;
  refunded   bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' OR NEW.decided_at IS NOT NULL OR NEW.provider_refund_id IS NOT NULL OR NEW.provider_status IS NOT NULL THEN
      RAISE EXCEPTION 'a new refund must be REQUESTED, with no PayPal outcome yet' USING ERRCODE = 'MD012';
    END IF;
    -- The sum of open and completed refunds is read under the order's lock, as reservations are under the mandate's.
    PERFORM public.require_read_committed('requesting a refund');
    SELECT po.state, po.currency, po.captured_amount_minor_units, po.provider_capture_id INTO o
      FROM public.purchase_order AS po WHERE po.id = NEW.order_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN NEW; -- the foreign key rejects the row with its usual error
    END IF;
    IF o.provider_capture_id IS NULL OR o.state NOT IN ('CAPTURED', 'SHIPPED', 'DELIVERED') THEN
      RAISE EXCEPTION 'only a captured order can be refunded' USING ERRCODE = 'MD007';
    END IF;
    IF NEW.currency <> o.currency THEN
      RAISE EXCEPTION 'refund currency % differs from order currency %', NEW.currency, o.currency USING ERRCODE = 'MD005';
    END IF;
    SELECT COALESCE(SUM(r.amount_minor_units), 0)::bigint INTO refunded
      FROM public.refund AS r WHERE r.order_id = NEW.order_id AND r.status <> 'REJECTED';
    IF refunded + NEW.amount_minor_units > o.captured_amount_minor_units THEN
      RAISE EXCEPTION 'refunds would exceed the captured amount'
        USING ERRCODE = 'MD007', DETAIL = format('refunded or pending %s + requested %s > captured %s', refunded, NEW.amount_minor_units, o.captured_amount_minor_units);
    END IF;
    NEW.requested_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.order_id <> OLD.order_id OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.amount_minor_units <> OLD.amount_minor_units OR NEW.currency <> OLD.currency
     OR NEW.provider <> OLD.provider OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'refund identity, amount and reason cannot change' USING ERRCODE = 'MD012';
  END IF;
  IF OLD.status <> 'REQUESTED' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a % refund cannot change', OLD.status USING ERRCODE = 'MD012';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'provider_refund_id is fixed once recorded' USING ERRCODE = 'MD012';
  END IF;
  IF NEW.status <> OLD.status THEN
    NEW.decided_at := clock_timestamp();
  ELSIF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    RAISE EXCEPTION 'decided_at is set by the decision itself' USING ERRCODE = 'MD012';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refund_rules BEFORE INSERT OR UPDATE ON public.refund
  FOR EACH ROW EXECUTE FUNCTION public.enforce_refund();
-- A refund is a financial record: corrections are new rows.
CREATE TRIGGER refund_no_delete BEFORE DELETE ON public.refund
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER refund_no_truncate BEFORE TRUNCATE ON public.refund
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

REVOKE ALL ON public.refund FROM mandate_runtime;
GRANT SELECT, INSERT ON public.refund TO mandate_runtime;
GRANT UPDATE (status, provider_refund_id, provider_status) ON public.refund TO mandate_runtime;

-- 3. Role rules for every writer (decision 1) ---------------------------------------------------------------------
CREATE FUNCTION public.enforce_user_role() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  stops_being_owner boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    stops_being_owner := OLD.role = 'owner';
  ELSE
    stops_being_owner := OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.organization_id <> OLD.organization_id);
  END IF;
  -- An organization that has an owner keeps one.
  IF stops_being_owner AND NOT EXISTS (
       SELECT 1 FROM public.app_user AS u
        WHERE u.organization_id = OLD.organization_id AND u.role = 'owner' AND u.id <> OLD.id) THEN
    RAISE EXCEPTION 'organization % would be left without an owner', OLD.organization_id USING ERRCODE = 'MD010';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- A user named as a mandate's approver cannot become a requester (0006 checks the other direction).
  IF NEW.role = 'requester' AND OLD.role <> 'requester'
     AND EXISTS (SELECT 1 FROM public.mandate AS m WHERE m.approver_user_id = OLD.id) THEN
    RAISE EXCEPTION 'user % is a mandate approver; reassign those mandates first', OLD.id USING ERRCODE = 'MD011';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_user_role_rules BEFORE UPDATE OF role, organization_id OR DELETE ON public.app_user
  FOR EACH ROW EXECUTE FUNCTION public.enforce_user_role();

-- Every user created, and every role change, is audited, under the verified actor when it came through
-- admin_set_user_role(), otherwise as 'system'.
CREATE FUNCTION public.audit_user_role() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  actor text := NULLIF(current_setting('mandate.actor_user_id', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role = OLD.role THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.audit_log (organization_id, actor_type, actor_id, action, subject_type, subject_id, detail)
  VALUES (NEW.organization_id,
          CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,
          COALESCE(actor, session_user),
          CASE WHEN TG_OP = 'INSERT' THEN 'app_user.insert' ELSE 'app_user.role_change' END,
          'app_user',
          NEW.id,
          jsonb_build_object('before', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.role END, 'after', NEW.role));
  RETURN NULL;
END;
$$;

CREATE TRIGGER app_user_audit AFTER INSERT OR UPDATE OF role ON public.app_user
  FOR EACH ROW EXECUTE FUNCTION public.audit_user_role();

-- Role assignment through the runtime. Owners and admins of the target's organization only; never one's own role;
-- admin and owner are granted or removed by an owner only.
CREATE FUNCTION public.admin_set_user_role(actor uuid, target_user uuid, new_role text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target     record;
  actor_role text;
BEGIN
  SELECT u.organization_id, u.role INTO target FROM public.app_user AS u WHERE u.id = target_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user % not found', target_user USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.mandate_admin_authorize(actor, target.organization_id);
  IF actor = target_user THEN
    RAISE EXCEPTION 'nobody can change their own role' USING ERRCODE = 'MD010';
  END IF;
  SELECT u.role INTO actor_role FROM public.app_user AS u WHERE u.id = actor;
  IF actor_role <> 'owner' AND (new_role IN ('admin', 'owner') OR target.role IN ('admin', 'owner')) THEN
    RAISE EXCEPTION 'only an owner can grant or remove admin and owner' USING ERRCODE = 'MD010';
  END IF;
  UPDATE public.app_user SET role = new_role WHERE id = target_user;
  PERFORM pg_catalog.set_config('mandate.actor_user_id', '', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, uuid, text) TO mandate_runtime;

-- 4. Audit rules: the new subjects, and role entries reserved to the database -----------------------------------
CREATE OR REPLACE FUNCTION public.audit_subject_organization(subject_type text, subject_id uuid) RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE subject_type
    WHEN 'organization'       THEN (SELECT o.id FROM public.organization AS o WHERE o.id = subject_id)
    WHEN 'app_user'           THEN (SELECT u.organization_id FROM public.app_user AS u WHERE u.id = subject_id)
    WHEN 'mandate'            THEN (SELECT m.organization_id FROM public.mandate AS m WHERE m.id = subject_id)
    WHEN 'category_limit'     THEN (SELECT m.organization_id FROM public.category_limit AS c JOIN public.mandate AS m ON m.id = c.mandate_id WHERE c.id = subject_id)
    WHEN 'purchase_request'   THEN (SELECT pr.organization_id FROM public.purchase_request AS pr WHERE pr.id = subject_id)
    WHEN 'policy_decision'    THEN (SELECT pr.organization_id FROM public.policy_decision AS pd JOIN public.purchase_request AS pr ON pr.id = pd.purchase_request_id WHERE pd.id = subject_id)
    WHEN 'budget_reservation' THEN (SELECT m.organization_id FROM public.budget_reservation AS r JOIN public.mandate AS m ON m.id = r.mandate_id WHERE r.id = subject_id)
    WHEN 'approval'           THEN (SELECT pr.organization_id FROM public.approval AS a JOIN public.purchase_request AS pr ON pr.id = a.purchase_request_id WHERE a.id = subject_id)
    WHEN 'purchase_order'     THEN (SELECT pr.organization_id FROM public.purchase_order AS o JOIN public.purchase_request AS pr ON pr.id = o.purchase_request_id WHERE o.id = subject_id)
    WHEN 'refund'             THEN (SELECT pr.organization_id FROM public.refund AS rf JOIN public.purchase_order AS o ON o.id = rf.order_id JOIN public.purchase_request AS pr ON pr.id = o.purchase_request_id WHERE rf.id = subject_id)
  END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_audit_tenancy() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  actor uuid;
BEGIN
  IF NEW.subject_id IS NOT NULL
     AND NEW.subject_type IN ('organization', 'app_user', 'mandate', 'category_limit', 'purchase_request',
                              'policy_decision', 'budget_reservation', 'approval', 'purchase_order', 'refund')
     AND public.audit_subject_organization(NEW.subject_type, NEW.subject_id) IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'audit entry subject % % is not in organization %', NEW.subject_type, NEW.subject_id, NEW.organization_id
      USING ERRCODE = 'MD007';
  END IF;
  -- Entries the database writes itself (mandate administration, users and roles) cannot be written by anyone else.
  IF NEW.action ~ '^(mandate|category_limit|app_user)[.]'
     AND NOT pg_catalog.pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.audit_log'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'audit actions mandate.*, category_limit.* and app_user.* are written by the database itself' USING ERRCODE = 'MD010';
  END IF;
  IF NEW.actor_type = 'user' THEN
    IF NEW.actor_id IS NULL OR NEW.actor_id !~ '^[0-9a-fA-F-]{36}$' THEN
      RAISE EXCEPTION 'a user actor must be an app_user id' USING ERRCODE = 'MD007';
    END IF;
    actor := NEW.actor_id::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.app_user AS u WHERE u.id = actor AND u.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'audit actor % is not a user of organization %', actor, NEW.organization_id USING ERRCODE = 'MD007';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Large objects (hardening) ------------------------------------------------------------------------------------
-- Function privileges are per database, so this affects the Mandate database only. lo_import is already limited to
-- superusers and pg_read_server_files by PostgreSQL; revoking it again is harmless.
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid), pg_catalog.lo_from_bytea(oid, bytea),
                               pg_catalog.lo_import(text), pg_catalog.lo_import(text, oid)
      FROM PUBLIC;
  ELSE
    RAISE WARNING 'large-object creation is still open to PUBLIC in database %: only a superuser can revoke it. Run pnpm db:harden as a superuser.', current_database();
  END IF;
END;
$$;
