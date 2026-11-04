-- 0006: payment evidence, the order lifecycle, mandate administration, and the runtime role's reach
-- (second review of issue #11: findings H1, H2, H3, M2, M4, L1, L2, L3, L5).
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- New SQLSTATEs (0002 and 0004 define MD001-MD007):
--   MD008  illegal purchase_order change: a state transition outside docs/uml.md section 2, or a change to a column
--          that is fixed once written
--   MD009  PayPal capture evidence missing or inconsistent (committing spend without a verified capture)
--   MD010  not authorized: the acting user is not an owner or admin of the organization, or an approver is
--          deciding their own request
--   MD011  the user cannot be a mandate's approver (wrong role)
--   MD012  illegal approval change: a decision after expiry, a status moving backwards, a token used twice
--   MD013  existing rows break a rule this migration adds; nothing was changed
--
-- What the database can and cannot prove about payments: it cannot call PayPal. It can only refuse to record a
-- capture without the evidence the payments module got from PayPal (capture id, status COMPLETED, amount and
-- currency equal to the order), and refuse to count spend as COMMITTED unless an order of the same decision
-- carries that evidence. Verifying the evidence against PayPal (captureOrder / getOrder) is the payments
-- module's job (issue #12), and a role that writes these columns can still write false evidence.
--
-- Corrections to earlier comments (applied migrations cannot be edited):
--   * 0002 says its invariants hold "whatever code (or person) writes to it" and that the triggers "hold even for the
--     table owner". They do not: the owner and any superuser can disable or drop triggers, or bypass them with
--     session_replication_role = replica. Every guarantee here holds against the runtime role only (0005, this file).
--   * 0004 calls its order trigger "the database backstop for hard rule 1". It was not one: an order could be
--     inserted CAPTURED and moved freely afterwards (second review, H1). This file adds the state machine; even so it
--     checks consistency, not truth, and a writer with the runtime role's rights can record false evidence.
--
-- Every function pins search_path and qualifies every table, as in 0002 (finding H2 of the first review).

-- 0. Existing rows must already satisfy the rules below (finding L5) ----------------------------------------------
-- 0004 added triggers that only check new writes, and this migration adds more. Rather than keep rows that
-- break them, refuse to migrate and say which rule fails. The usual fix is to move unproven orders to
-- UNKNOWN_OUTCOME before migrating, then reconcile them with PayPal afterwards.

DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.purchase_order
   WHERE state IN ('CAPTURED', 'SHIPPED', 'DELIVERED', 'REFUND_REQUESTED', 'REFUNDED');
  IF n > 0 THEN
    problems := problems || format('%s order(s) are CAPTURED or later with no recorded PayPal capture evidence; set them to UNKNOWN_OUTCOME, migrate, then reconcile with get-order', n);
  END IF;

  SELECT count(*) INTO n FROM public.purchase_order
   WHERE state NOT IN ('PAYMENT_PENDING', 'CAPTURED', 'FAILED', 'UNKNOWN_OUTCOME', 'SHIPPED', 'DELIVERED', 'REFUND_REQUESTED', 'REFUNDED');
  IF n > 0 THEN
    problems := problems || format('%s order(s) are in a request-only state (CREATED, QUOTED, ...), which an order never takes', n);
  END IF;

  SELECT count(*) INTO n FROM public.budget_reservation WHERE state = 'COMMITTED';
  IF n > 0 THEN
    problems := problems || format('%s reservation(s) are COMMITTED, but no capture evidence could be recorded before this migration, so the spend is unproven', n);
  END IF;

  SELECT count(*) INTO n
    FROM public.budget_reservation AS r
    JOIN public.policy_decision AS pd ON pd.id = r.policy_decision_id
    JOIN public.purchase_request AS pr ON pr.id = pd.purchase_request_id
   WHERE pr.mandate_id <> r.mandate_id OR pd.currency <> r.currency
      OR pd.outcome NOT IN ('ALLOW', 'NEEDS_APPROVAL') OR r.amount_minor_units < pd.evaluated_total_minor_units;
  IF n > 0 THEN
    problems := problems || format('%s reservation(s) do not match their policy decision (0004 rule)', n);
  END IF;

  SELECT count(*) INTO n
    FROM public.purchase_order AS o
    JOIN public.policy_decision AS pd ON pd.id = o.policy_decision_id
    LEFT JOIN public.approval AS a ON a.id = o.approval_id
    LEFT JOIN public.budget_reservation AS r ON r.policy_decision_id = o.policy_decision_id
   WHERE pd.outcome = 'DENY'
      OR (pd.outcome = 'NEEDS_APPROVAL' AND (a.id IS NULL OR a.status <> 'APPROVED'))
      OR (a.id IS NOT NULL AND a.policy_decision_id <> o.policy_decision_id)
      OR r.id IS NULL OR r.amount_minor_units < o.amount_minor_units;
  IF n > 0 THEN
    problems := problems || format('%s order(s) lack authorization, a covering hold, or carry another decision''s approval', n);
  END IF;

  SELECT count(*) INTO n
    FROM public.purchase_order AS o
    JOIN public.budget_reservation AS r ON r.policy_decision_id = o.policy_decision_id
   WHERE r.state = 'RELEASED' AND o.state IN ('PAYMENT_PENDING', 'UNKNOWN_OUTCOME');
  IF n > 0 THEN
    problems := problems || format('%s order(s) are in flight while their hold is RELEASED (review finding H3)', n);
  END IF;

  SELECT count(*) INTO n
    FROM public.approval AS a
    JOIN public.policy_decision AS pd ON pd.id = a.policy_decision_id
    JOIN public.purchase_request AS pr ON pr.id = pd.purchase_request_id
    JOIN public.mandate AS m ON m.id = pr.mandate_id
   WHERE pd.outcome <> 'NEEDS_APPROVAL' OR m.approver_user_id <> a.approver_user_id
      OR a.approver_user_id = pr.requester_user_id
      OR (a.status IN ('APPROVED', 'REJECTED') AND a.decided_at >= a.expires_at);
  IF n > 0 THEN
    problems := problems || format('%s approval(s) are not by the mandate approver, approve the approver''s own request, or were decided after expiry', n);
  END IF;

  SELECT count(*) INTO n
    FROM public.cart_item AS ci
    JOIN public.cart AS c ON c.id = ci.cart_id
    JOIN public.product_snapshot AS s ON s.id = ci.product_snapshot_id
   WHERE s.purchase_request_id <> c.purchase_request_id OR s.currency <> c.currency
      OR s.unit_price_minor_units <> ci.unit_price_minor_units;
  IF n > 0 THEN
    problems := problems || format('%s cart line(s) do not match their product snapshot (0004 rule)', n);
  END IF;

  SELECT count(*) INTO n
    FROM public.mandate AS m
    JOIN public.app_user AS u ON u.id = m.approver_user_id
   WHERE u.role NOT IN ('approver', 'admin');
  IF n > 0 THEN
    problems := problems || format('%s mandate(s) name an approver whose role cannot approve (requester)', n);
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'migration 0006 refused existing data: %', array_to_string(problems, '; ')
      USING ERRCODE = 'MD013';
  END IF;
END;
$$;

-- 1. Roles inside an organization ---------------------------------------------------------------------------------
-- 'owner' joins 'admin' as a role that may administer mandates (M2 decision). Widening an allowed set breaks no row.
ALTER TABLE public.app_user DROP CONSTRAINT app_user_role_check;
ALTER TABLE public.app_user
  ADD CONSTRAINT app_user_role_check CHECK (role IN ('requester', 'approver', 'admin', 'owner'));

-- 2. PayPal capture evidence on the order (finding H2) ------------------------------------------------------------
ALTER TABLE public.purchase_order
  ADD COLUMN provider_capture_id         text,
  ADD COLUMN capture_status              text,
  ADD COLUMN captured_amount_minor_units minor_units,
  ADD COLUMN captured_currency           currency_code,
  -- Server time of the write that recorded the evidence; set by the trigger below, never by the caller.
  ADD COLUMN capture_verified_at         timestamptz;

ALTER TABLE public.purchase_order
  -- An order row only ever takes the payment-stage states; the request-stage ones belong to purchase_request.
  ADD CONSTRAINT purchase_order_state_check
    CHECK (state IN ('PAYMENT_PENDING', 'CAPTURED', 'FAILED', 'UNKNOWN_OUTCOME', 'SHIPPED', 'DELIVERED', 'REFUND_REQUESTED', 'REFUNDED')),
  ADD CONSTRAINT purchase_order_capture_id_format_check
    CHECK (provider_capture_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  -- Only COMPLETED counts. A PENDING capture (e.g. under review at PayPal) leaves the order PAYMENT_PENDING.
  ADD CONSTRAINT purchase_order_capture_status_check CHECK (capture_status = 'COMPLETED'),
  -- The evidence is recorded all at once or not at all.
  ADD CONSTRAINT purchase_order_capture_evidence_complete_check
    CHECK (num_nonnulls(provider_capture_id, capture_status, captured_amount_minor_units, captured_currency, capture_verified_at) IN (0, 5)),
  -- CAPTURED and every later state need the PayPal order id and a COMPLETED capture of exactly the order amount.
  -- The explicit IS NOT NULL tests matter: a CHECK that evaluates to NULL passes.
  ADD CONSTRAINT purchase_order_captured_needs_evidence_check
    CHECK (state NOT IN ('CAPTURED', 'SHIPPED', 'DELIVERED', 'REFUND_REQUESTED', 'REFUNDED')
           OR (provider_order_id IS NOT NULL
               AND provider_capture_id IS NOT NULL
               AND capture_status IS NOT NULL
               AND captured_amount_minor_units IS NOT NULL
               AND captured_currency IS NOT NULL
               AND capture_verified_at IS NOT NULL
               AND captured_amount_minor_units = amount_minor_units
               AND captured_currency = currency)),
  -- One PayPal capture pays for one order.
  ADD CONSTRAINT purchase_order_provider_capture_key UNIQUE (provider, provider_capture_id);

-- 3. Orders: authorization on insert, and the state machine afterwards (findings H1, H3, L1, L2) -----------------

CREATE OR REPLACE FUNCTION public.enforce_purchase_order() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  outcome         text;
  approval_status text;
  approval_of     uuid;
  hold            record;
BEGIN
  -- H1: an order is born PAYMENT_PENDING. CAPTURED is only reachable through the transition rules below.
  IF NEW.state <> 'PAYMENT_PENDING' THEN
    RAISE EXCEPTION 'a new purchase_order must start PAYMENT_PENDING, not %', NEW.state USING ERRCODE = 'MD008';
  END IF;
  IF num_nonnulls(NEW.provider_capture_id, NEW.capture_status, NEW.captured_amount_minor_units, NEW.captured_currency, NEW.capture_verified_at) > 0 THEN
    RAISE EXCEPTION 'capture evidence is recorded on the transition to CAPTURED, never on insert' USING ERRCODE = 'MD009';
  END IF;

  -- The hold check below relies on reading the latest row version after the lock (as the budget triggers do).
  PERFORM public.require_read_committed('creating an order');

  SELECT pd.outcome INTO outcome FROM public.policy_decision AS pd WHERE pd.id = NEW.policy_decision_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key rejects the row with its usual error
  END IF;

  -- L2: an approval_id, whatever the outcome, must be an approval of this order's own decision.
  IF NEW.approval_id IS NOT NULL THEN
    SELECT a.status, a.policy_decision_id INTO approval_status, approval_of FROM public.approval AS a WHERE a.id = NEW.approval_id;
    IF NOT FOUND OR approval_of <> NEW.policy_decision_id THEN
      RAISE EXCEPTION 'approval_id must reference an approval of the order''s own decision' USING ERRCODE = 'MD007';
    END IF;
  END IF;
  IF outcome = 'DENY' OR (outcome = 'NEEDS_APPROVAL' AND approval_status IS DISTINCT FROM 'APPROVED') THEN
    RAISE EXCEPTION 'an order needs an ALLOW decision or an APPROVED approval of its decision' USING ERRCODE = 'MD007';
  END IF;

  -- H3: lock the hold. A concurrent release either finished first (we then read RELEASED and refuse) or waits for
  -- this transaction and then sees the order, which its own rule refuses to release under.
  SELECT r.state, r.amount_minor_units, r.expires_at INTO hold
    FROM public.budget_reservation AS r
   WHERE r.policy_decision_id = NEW.policy_decision_id
     FOR UPDATE;
  IF NOT FOUND OR hold.state <> 'HELD' OR hold.amount_minor_units < NEW.amount_minor_units THEN
    RAISE EXCEPTION 'an order needs a HELD reservation of its decision covering its amount' USING ERRCODE = 'MD007';
  END IF;
  -- L1: an expired hold is waiting for the sweeper; it must not fund new spending. clock_timestamp(), not now():
  -- now() is the transaction start, which a long transaction would hold in the past.
  IF hold.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'the reservation for this decision has expired' USING ERRCODE = 'MD007';
  END IF;
  RETURN NEW;
END;
$$;

-- Legal transitions: the whole state machine of docs/uml.md section 2. purchase_order_state_check keeps an order row
-- to the payment-stage states, so for a row only the payment part applies; order_event rows may also describe the
-- step into PAYMENT_PENDING. A row may be rewritten in its current state (e.g. to record provider_order_id), which
-- is not a transition.
CREATE FUNCTION public.order_transition_allowed(from_state text, to_state text) RETURNS boolean
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
    ('CAPTURED', 'SHIPPED'), ('CAPTURED', 'REFUND_REQUESTED'),
    ('SHIPPED', 'DELIVERED'), ('SHIPPED', 'REFUND_REQUESTED'),
    ('DELIVERED', 'REFUND_REQUESTED'),
    ('REFUND_REQUESTED', 'REFUNDED'), ('REFUND_REQUESTED', 'FAILED'));
$$;

CREATE FUNCTION public.enforce_purchase_order_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.purchase_request_id <> OLD.purchase_request_id
     OR NEW.policy_decision_id <> OLD.policy_decision_id
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.provider <> OLD.provider
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.payment_variant <> OLD.payment_variant
     OR NEW.amount_minor_units <> OLD.amount_minor_units
     OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'purchase_order identity, authorization and amount cannot change' USING ERRCODE = 'MD008';
  END IF;
  IF OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id THEN
    RAISE EXCEPTION 'provider_order_id is fixed once recorded' USING ERRCODE = 'MD008';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT public.order_transition_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'purchase_order cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'MD008', HINT = 'Legal transitions: docs/uml.md section 2.';
  END IF;

  -- Evidence is written exactly once, on the transition into CAPTURED, and never changes afterwards.
  IF NEW.state = 'CAPTURED' AND OLD.state IN ('PAYMENT_PENDING', 'UNKNOWN_OUTCOME') THEN
    IF num_nonnulls(NEW.provider_capture_id, NEW.capture_status, NEW.captured_amount_minor_units, NEW.captured_currency) <> 4 THEN
      RAISE EXCEPTION 'CAPTURED needs the PayPal capture id, status, amount and currency' USING ERRCODE = 'MD009';
    END IF;
    NEW.capture_verified_at := now();
  ELSIF NEW.provider_capture_id IS DISTINCT FROM OLD.provider_capture_id
     OR NEW.capture_status IS DISTINCT FROM OLD.capture_status
     OR NEW.captured_amount_minor_units IS DISTINCT FROM OLD.captured_amount_minor_units
     OR NEW.captured_currency IS DISTINCT FROM OLD.captured_currency
     OR NEW.capture_verified_at IS DISTINCT FROM OLD.capture_verified_at THEN
    RAISE EXCEPTION 'capture evidence is recorded once, on the transition to CAPTURED' USING ERRCODE = 'MD009';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_order_lifecycle BEFORE UPDATE ON public.purchase_order
  FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_order_update();

-- 4. Reservations: commit only against evidence, release only when nothing was or may be paid (H1, H2, L1) --------

CREATE OR REPLACE FUNCTION public.enforce_budget_reservation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  m              record;
  decision       record;
  active_total   bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.mandate_id <> OLD.mandate_id
       OR NEW.policy_decision_id <> OLD.policy_decision_id
       OR NEW.amount_minor_units <> OLD.amount_minor_units
       OR NEW.currency <> OLD.currency
       OR NEW.created_at <> OLD.created_at
       OR (OLD.committed_amount_minor_units IS NOT NULL
           AND NEW.committed_amount_minor_units IS DISTINCT FROM OLD.committed_amount_minor_units) THEN
      RAISE EXCEPTION 'budget_reservation mandate, decision, amount, currency and committed amount cannot change'
        USING ERRCODE = 'MD003';
    END IF;
    IF OLD.state <> 'HELD' THEN
      IF NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'budget_reservation cannot move from % to %', OLD.state, NEW.state USING ERRCODE = 'MD003';
      END IF;
      -- L1: a finished hold is history; its expiry and timestamps no longer change.
      IF NEW.expires_at <> OLD.expires_at
         OR NEW.released_at IS DISTINCT FROM OLD.released_at
         OR NEW.committed_at IS DISTINCT FROM OLD.committed_at THEN
        RAISE EXCEPTION 'a % reservation cannot be edited', OLD.state USING ERRCODE = 'MD003';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.state IN ('RELEASED', 'COMMITTED') THEN
      -- Both read purchase_order to decide. Under REPEATABLE READ or SERIALIZABLE that read uses the transaction's
      -- first snapshot and misses an order committed after it, even one that locked this hold; an order insert only
      -- locks the hold row, which raises no serialization failure (third review, H1).
      PERFORM public.require_read_committed('releasing or committing a hold');
    END IF;
    IF NEW.state = 'RELEASED' THEN
      -- Release only when no order of this decision was paid or may still be paid: either there is no order, or it
      -- FAILED without ever recording a capture (an order that failed a refund still spent the money).
      IF EXISTS (
           SELECT 1 FROM public.purchase_order AS o
            WHERE o.policy_decision_id = NEW.policy_decision_id
              AND (o.state <> 'FAILED' OR o.provider_capture_id IS NOT NULL)) THEN
        RAISE EXCEPTION 'cannot release a hold while its order is not FAILED, or after it was captured'
          USING ERRCODE = 'MD003', HINT = 'Reconcile the order with get-order first.';
      END IF;
      NEW.released_at := now();
    ELSIF NEW.state = 'COMMITTED' THEN
      -- H2: spend counts as committed only against a recorded COMPLETED capture of an order of this decision, and
      -- for exactly the captured amount.
      IF NOT EXISTS (
           SELECT 1 FROM public.purchase_order AS o
            WHERE o.policy_decision_id = NEW.policy_decision_id
              AND o.provider_capture_id IS NOT NULL
              AND o.capture_verified_at IS NOT NULL
              AND o.captured_currency = NEW.currency
              AND o.captured_amount_minor_units = NEW.committed_amount_minor_units) THEN
        RAISE EXCEPTION 'a reservation commits only against a recorded PayPal capture of its decision, for the captured amount'
          USING ERRCODE = 'MD009';
      END IF;
      NEW.committed_at := now();
    END IF;
    -- HELD -> RELEASED lowers the active total; HELD -> COMMITTED replaces the hold by a smaller or equal
    -- committed amount (checked by constraint). Neither can raise it, so neither needs a budget check.
    RETURN NEW;
  END IF;

  IF NEW.state <> 'HELD' THEN
    RAISE EXCEPTION 'a new budget_reservation must start HELD, not %', NEW.state USING ERRCODE = 'MD003';
  END IF;
  IF NEW.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'a new budget_reservation must expire in the future' USING ERRCODE = 'MD003';
  END IF;
  IF NEW.released_at IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.committed_amount_minor_units IS NOT NULL THEN
    RAISE EXCEPTION 'a new budget_reservation cannot carry release or commit data' USING ERRCODE = 'MD003';
  END IF;
  PERFORM public.require_read_committed('a budget reservation');

  SELECT mm.budget_minor_units, mm.currency, mm.status, mm.starts_at, mm.ends_at INTO m
    FROM public.mandate AS mm
   WHERE mm.id = NEW.mandate_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key rejects the row with its usual error
  END IF;
  IF NEW.currency <> m.currency THEN
    RAISE EXCEPTION 'reservation currency % differs from mandate currency %', NEW.currency, m.currency
      USING ERRCODE = 'MD005';
  END IF;
  IF m.status <> 'ACTIVE' OR now() < m.starts_at OR now() >= m.ends_at THEN
    RAISE EXCEPTION 'mandate is not active' USING ERRCODE = 'MD006';
  END IF;

  SELECT pd.outcome, pd.currency, pd.evaluated_total_minor_units, pr.mandate_id INTO decision
    FROM public.policy_decision AS pd
    JOIN public.purchase_request AS pr ON pr.id = pd.purchase_request_id
   WHERE pd.id = NEW.policy_decision_id;
  IF FOUND AND (decision.mandate_id <> NEW.mandate_id
                OR decision.currency <> NEW.currency
                OR decision.outcome NOT IN ('ALLOW', 'NEEDS_APPROVAL')
                OR NEW.amount_minor_units < decision.evaluated_total_minor_units) THEN
    RAISE EXCEPTION 'reservation does not match its policy decision (mandate, currency, outcome or amount)'
      USING ERRCODE = 'MD007';
  END IF;

  active_total := public.mandate_active_total(NEW.mandate_id);
  IF active_total + NEW.amount_minor_units > m.budget_minor_units THEN
    RAISE EXCEPTION 'BUDGET_EXCEEDED'
      USING ERRCODE = 'MD001',
            DETAIL = format('reserved %s + requested %s > budget %s', active_total, NEW.amount_minor_units, m.budget_minor_units);
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Approvals: forward-only, decided before expiry, never by the requester, token used once (M2, MD012) ----------

CREATE FUNCTION public.enforce_approval_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  requester uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.decided_at IS NOT NULL OR NEW.token_used_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new approval must be PENDING and unused' USING ERRCODE = 'MD012';
    END IF;
    NEW.requested_at := clock_timestamp();
    IF NEW.expires_at <= NEW.requested_at THEN
      RAISE EXCEPTION 'a new approval must expire in the future' USING ERRCODE = 'MD012';
    END IF;
    SELECT pr.requester_user_id INTO requester FROM public.purchase_request AS pr WHERE pr.id = NEW.purchase_request_id;
    IF requester = NEW.approver_user_id THEN
      RAISE EXCEPTION 'an approver cannot approve their own request' USING ERRCODE = 'MD010';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.purchase_request_id <> OLD.purchase_request_id
     OR NEW.policy_decision_id <> OLD.policy_decision_id
     OR NEW.approver_user_id <> OLD.approver_user_id
     OR NEW.channel <> OLD.channel
     OR NEW.token_hash <> OLD.token_hash
     OR NEW.requested_at <> OLD.requested_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'approval identity, token and expiry cannot change' USING ERRCODE = 'MD012';
  END IF;
  IF OLD.token_used_at IS NOT NULL AND NEW.token_used_at IS DISTINCT FROM OLD.token_used_at THEN
    RAISE EXCEPTION 'an approval token is single-use' USING ERRCODE = 'MD012';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'approval cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'MD012';
    END IF;
    -- clock_timestamp(), not now(): now() is the transaction start, so a transaction opened before expiry could
    -- otherwise approve after it, with decided_at back-dated (third review, L1).
    IF NEW.status IN ('APPROVED', 'REJECTED') THEN
      IF clock_timestamp() >= OLD.expires_at THEN
        RAISE EXCEPTION 'approval expired at %; it can only become EXPIRED', OLD.expires_at USING ERRCODE = 'MD012';
      END IF;
      NEW.decided_at := clock_timestamp();
    ELSIF NEW.status = 'EXPIRED' AND clock_timestamp() < OLD.expires_at THEN
      RAISE EXCEPTION 'approval has not expired yet' USING ERRCODE = 'MD012';
    END IF;
  ELSIF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    RAISE EXCEPTION 'decided_at is set by the decision itself' USING ERRCODE = 'MD012';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_lifecycle BEFORE INSERT OR UPDATE ON public.approval
  FOR EACH ROW EXECUTE FUNCTION public.enforce_approval_lifecycle();

-- 6. Append-only rows must agree with what they describe (finding L3) ---------------------------------------------

-- An order event records the order's current state, reached by a legal step, from a verified webhook if any.
-- webhook_event.signature_verified is set by the application that checked the signature; the database cannot check
-- it, so this rule stops citing a row the application marked unverified, not a forged row marked verified.
CREATE FUNCTION public.enforce_order_event() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_state text;
BEGIN
  SELECT o.state INTO current_state FROM public.purchase_order AS o WHERE o.id = NEW.order_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key rejects the row with its usual error
  END IF;
  IF NEW.to_state <> current_state THEN
    RAISE EXCEPTION 'order_event to_state % contradicts the order''s state %', NEW.to_state, current_state USING ERRCODE = 'MD007';
  END IF;
  IF NEW.from_state IS NOT NULL AND NEW.from_state <> NEW.to_state
     AND NOT public.order_transition_allowed(NEW.from_state, NEW.to_state) THEN
    RAISE EXCEPTION 'order_event % -> % is not a legal transition', NEW.from_state, NEW.to_state USING ERRCODE = 'MD007';
  END IF;
  IF NEW.webhook_event_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.webhook_event AS w WHERE w.id = NEW.webhook_event_id AND w.signature_verified) THEN
    RAISE EXCEPTION 'order_event can only cite a signature-verified webhook' USING ERRCODE = 'MD007';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_event_matches_order BEFORE INSERT ON public.order_event
  FOR EACH ROW EXECUTE FUNCTION public.enforce_order_event();

-- An audit entry about a known kind of subject must belong to that subject's organization, and a user actor must be
-- a user of that organization. Subject types not listed here are not checked (documented in docs/er-diagram.md).
CREATE FUNCTION public.audit_subject_organization(subject_type text, subject_id uuid) RETURNS uuid
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
  END;
$$;

CREATE FUNCTION public.enforce_audit_tenancy() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  actor uuid;
BEGIN
  IF NEW.subject_id IS NOT NULL
     AND NEW.subject_type IN ('organization', 'app_user', 'mandate', 'category_limit', 'purchase_request',
                              'policy_decision', 'budget_reservation', 'approval', 'purchase_order')
     AND public.audit_subject_organization(NEW.subject_type, NEW.subject_id) IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'audit entry subject % % is not in organization %', NEW.subject_type, NEW.subject_id, NEW.organization_id
      USING ERRCODE = 'MD007';
  END IF;
  -- Entries about mandate administration are written only by the audit trigger, which runs as the table owner (inside
  -- the SECURITY DEFINER admin functions, or for the owner's own writes). Any other writer could otherwise forge an
  -- entry indistinguishable from a genuine admin change (third review, M4).
  IF NEW.action ~ '^(mandate|category_limit)[.]'
     AND NOT pg_catalog.pg_has_role(current_user, (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.audit_log'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'audit actions mandate.* and category_limit.* are written by the database itself' USING ERRCODE = 'MD010';
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

CREATE TRIGGER audit_log_matches_tenant BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.enforce_audit_tenancy();

-- 7. Mandate administration (finding M2) --------------------------------------------------------------------------
-- Decision: only an owner or admin of the organization creates or changes mandates, budgets, caps, category limits
-- and approver assignments; every such change is written to audit_log in the same transaction.
--
-- The runtime role loses INSERT/UPDATE on mandate and all writes on category_limit. It changes them only through
-- the SECURITY DEFINER functions below, which check that the acting user is an owner or admin of the mandate's
-- organization. The acting user's id comes from the API, which must authenticate it: the database cannot tell a
-- genuine admin request from a compromised API that names an admin. What it does guarantee is that the named
-- actor is an admin of that organization and that the change is audited under that name.
--
-- The audit trigger fires for every writer, so changes the owner makes (seed, onboarding) are audited as 'system'.

-- An approver must be able to approve: role approver, admin or owner, never requester. The organization match is the
-- composite foreign key from 0001.
CREATE FUNCTION public.enforce_mandate_approver() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.app_user AS u
        WHERE u.id = NEW.approver_user_id AND u.organization_id = NEW.organization_id AND u.role IN ('approver', 'admin', 'owner')) THEN
    RAISE EXCEPTION 'mandate approver must be an approver, admin or owner of the mandate''s organization' USING ERRCODE = 'MD011';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mandate_approver_eligible BEFORE INSERT OR UPDATE OF approver_user_id, organization_id ON public.mandate
  FOR EACH ROW EXECUTE FUNCTION public.enforce_mandate_approver();

-- Writes one audit_log row per changed mandate or category_limit row. The actor is the user an admin function
-- verified (transaction-local setting mandate.actor_user_id), otherwise the connected role as 'system'. The subject is
-- the mandate (a category limit is part of its mandate's permissions), or the organization once the mandate is gone.
CREATE FUNCTION public.audit_mandate_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  before    jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'updated_at' END;
  after     jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) - 'updated_at' END;
  row_data  jsonb := COALESCE(after, before);
  org       uuid;
  subject   uuid;
  actor     text := NULLIF(current_setting('mandate.actor_user_id', true), '');
BEGIN
  IF before IS NOT DISTINCT FROM after THEN
    RETURN NULL; -- nothing an auditor cares about changed (e.g. an idempotent seed rerun)
  END IF;
  IF TG_TABLE_NAME = 'mandate' THEN
    org := (row_data ->> 'organization_id')::uuid;
    subject := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE (row_data ->> 'id')::uuid END;
  ELSE
    subject := (row_data ->> 'mandate_id')::uuid;
    SELECT m.organization_id INTO org FROM public.mandate AS m WHERE m.id = (row_data ->> 'mandate_id')::uuid;
    IF org IS NULL THEN
      RETURN NULL; -- the mandate itself is being deleted in this statement, and its own row is audited
    END IF;
  END IF;
  INSERT INTO public.audit_log (organization_id, actor_type, actor_id, action, subject_type, subject_id, detail)
  VALUES (org,
          CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,
          COALESCE(actor, session_user),
          TG_TABLE_NAME || '.' || lower(TG_OP),
          CASE WHEN subject IS NULL THEN 'organization' ELSE 'mandate' END,
          COALESCE(subject, org),
          jsonb_build_object('before', before, 'after', after));
  RETURN NULL;
END;
$$;

CREATE TRIGGER mandate_audit AFTER INSERT OR UPDATE OR DELETE ON public.mandate
  FOR EACH ROW EXECUTE FUNCTION public.audit_mandate_change();
CREATE TRIGGER category_limit_audit AFTER INSERT OR UPDATE OR DELETE ON public.category_limit
  FOR EACH ROW EXECUTE FUNCTION public.audit_mandate_change();

-- Checks the actor and records it for the audit trigger, for the rest of this transaction only.
CREATE FUNCTION public.mandate_admin_authorize(actor uuid, organization uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- FOR KEY SHARE: the actor's row cannot be deleted under us. Role changes need the owner, not the runtime.
  PERFORM 1 FROM public.app_user AS u
    WHERE u.id = actor AND u.organization_id = organization AND u.role IN ('owner', 'admin')
      FOR KEY SHARE;
  IF actor IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'only an owner or admin of the organization can change its mandates' USING ERRCODE = 'MD010';
  END IF;
  PERFORM pg_catalog.set_config('mandate.actor_user_id', actor::text, true);
END;
$$;

CREATE FUNCTION public.admin_create_mandate(
  actor uuid, organization uuid, approver uuid, mandate_name text, mandate_currency text,
  budget bigint, per_item_cap bigint, approval_threshold bigint, max_quantity integer,
  structuring_window integer, drift_tolerance_bps integer, window_starts timestamptz, window_ends timestamptz,
  version text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  created uuid;
BEGIN
  PERFORM public.mandate_admin_authorize(actor, organization);
  INSERT INTO public.mandate (organization_id, approver_user_id, name, currency, budget_minor_units, per_item_cap_minor_units,
                              approval_threshold_minor_units, max_quantity_per_line, structuring_window_minutes,
                              price_drift_tolerance_bps, starts_at, ends_at, policy_version)
  VALUES (organization, approver, mandate_name, mandate_currency, budget, per_item_cap, approval_threshold, max_quantity,
          structuring_window, drift_tolerance_bps, window_starts, window_ends, version)
  RETURNING id INTO created;
  PERFORM pg_catalog.set_config('mandate.actor_user_id', '', true);
  RETURN created;
END;
$$;

-- Replaces every administrable field. The organization never changes. Budget and currency changes still pass the
-- budget trigger (0002/0004): a budget cannot drop below what is held or committed.
CREATE FUNCTION public.admin_update_mandate(
  actor uuid, target_mandate uuid, approver uuid, mandate_name text, mandate_status text, mandate_currency text,
  budget bigint, per_item_cap bigint, approval_threshold bigint, max_quantity integer,
  structuring_window integer, drift_tolerance_bps integer, window_starts timestamptz, window_ends timestamptz,
  version text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  organization uuid;
BEGIN
  SELECT m.organization_id INTO organization FROM public.mandate AS m WHERE m.id = target_mandate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mandate % not found', target_mandate USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.mandate_admin_authorize(actor, organization);
  UPDATE public.mandate
     SET approver_user_id = approver, name = mandate_name, status = mandate_status, currency = mandate_currency,
         budget_minor_units = budget, per_item_cap_minor_units = per_item_cap,
         approval_threshold_minor_units = approval_threshold, max_quantity_per_line = max_quantity,
         structuring_window_minutes = structuring_window, price_drift_tolerance_bps = drift_tolerance_bps,
         starts_at = window_starts, ends_at = window_ends, policy_version = version
   WHERE id = target_mandate;
  PERFORM pg_catalog.set_config('mandate.actor_user_id', '', true);
END;
$$;

CREATE FUNCTION public.admin_set_category_limit(actor uuid, target_mandate uuid, limit_category text, is_allowed boolean, cap bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  organization uuid;
  limit_id     uuid;
BEGIN
  SELECT m.organization_id INTO organization FROM public.mandate AS m WHERE m.id = target_mandate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mandate % not found', target_mandate USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.mandate_admin_authorize(actor, organization);
  INSERT INTO public.category_limit (mandate_id, category, allowed, cap_minor_units)
  VALUES (target_mandate, limit_category, is_allowed, cap)
  ON CONFLICT (mandate_id, category) DO UPDATE SET allowed = EXCLUDED.allowed, cap_minor_units = EXCLUDED.cap_minor_units
  RETURNING id INTO limit_id;
  PERFORM pg_catalog.set_config('mandate.actor_user_id', '', true);
  RETURN limit_id;
END;
$$;

CREATE FUNCTION public.admin_remove_category_limit(actor uuid, target_mandate uuid, limit_category text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  organization uuid;
  removed      boolean;
BEGIN
  SELECT m.organization_id INTO organization FROM public.mandate AS m WHERE m.id = target_mandate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mandate % not found', target_mandate USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.mandate_admin_authorize(actor, organization);
  DELETE FROM public.category_limit AS c WHERE c.mandate_id = target_mandate AND c.category = limit_category;
  removed := FOUND;
  PERFORM pg_catalog.set_config('mandate.actor_user_id', '', true);
  RETURN removed;
END;
$$;

-- Functions are executable by PUBLIC by default. These four are the only route the runtime has to mandate data, so
-- only mandate_runtime may call them; the authorization helper is internal.
REVOKE ALL ON FUNCTION public.mandate_admin_authorize(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_mandate(uuid, uuid, uuid, text, text, bigint, bigint, bigint, integer, integer, integer, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_mandate(uuid, uuid, uuid, text, text, text, bigint, bigint, bigint, integer, integer, integer, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_category_limit(uuid, uuid, text, boolean, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_remove_category_limit(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_mandate(uuid, uuid, uuid, text, text, bigint, bigint, bigint, integer, integer, integer, timestamptz, timestamptz, text) TO mandate_runtime;
GRANT EXECUTE ON FUNCTION public.admin_update_mandate(uuid, uuid, uuid, text, text, text, bigint, bigint, bigint, integer, integer, integer, timestamptz, timestamptz, text) TO mandate_runtime;
GRANT EXECUTE ON FUNCTION public.admin_set_category_limit(uuid, uuid, text, boolean, bigint) TO mandate_runtime;
GRANT EXECUTE ON FUNCTION public.admin_remove_category_limit(uuid, uuid, text) TO mandate_runtime;

REVOKE INSERT, UPDATE ON public.mandate FROM mandate_runtime;
REVOKE INSERT, UPDATE, DELETE ON public.category_limit FROM mandate_runtime;
-- Row locks (SELECT ... FOR NO KEY UPDATE, which reservations take on the mandate) need UPDATE on at least one
-- column. updated_at is the one column whose update changes nothing: set_updated_at() overwrites it, and the audit
-- trigger ignores it.
GRANT UPDATE (updated_at) ON public.mandate TO mandate_runtime;

-- 8. Order evidence columns for the runtime -----------------------------------------------------------------------
GRANT UPDATE (provider_capture_id, capture_status, captured_amount_minor_units, captured_currency)
  ON public.purchase_order TO mandate_runtime;

-- 9. The runtime role's reach (finding M4) ------------------------------------------------------------------------
-- Decision: one shared mandate_runtime role per PostgreSQL cluster. Roles are cluster-wide; privileges are not. Every
-- database grants CONNECT to PUBLIC by default, so a login role could connect to any database on the cluster. Here
-- the Mandate database stops granting CONNECT to PUBLIC and grants it to mandate_runtime instead. Other databases
-- on the same cluster are outside this migration's reach; tenant isolation inside the Mandate database comes from
-- application authorization and the constraints above, not from roles. Run one environment per cluster.

DO $$
DECLARE
  db       text := current_database();
  can_act  boolean;
  members  text;
BEGIN
  SELECT r.rolsuper OR pg_catalog.pg_has_role(current_user, d.datdba, 'MEMBER') INTO can_act
    FROM pg_catalog.pg_database AS d, pg_catalog.pg_roles AS r
   WHERE d.datname = db AND r.rolname = current_user;
  IF NOT can_act THEN
    RAISE EXCEPTION 'migration 0006 must run as the owner of database %, to restrict CONNECT', db;
  END IF;
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mandate_runtime', db);
  IF pg_catalog.has_database_privilege('public', db, 'CONNECT') OR NOT pg_catalog.has_database_privilege('mandate_runtime', db, 'CONNECT') THEN
    RAISE EXCEPTION 'could not restrict CONNECT on database % to mandate_runtime', db;
  END IF;

  -- The group role itself must stay unprivileged: no attributes (checked again, as in 0005) and no memberships, so
  -- nothing granted to it can carry in another role's rights (for example pg_write_server_files).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'mandate_runtime'
                AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'role mandate_runtime has privileged attributes; recreate it NOLOGIN without them';
  END IF;
  SELECT string_agg(g.rolname, ', ') INTO members
    FROM pg_catalog.pg_auth_members AS am
    JOIN pg_catalog.pg_roles AS g ON g.oid = am.roleid
   WHERE am.member = 'mandate_runtime'::regrole;
  IF members IS NOT NULL THEN
    RAISE EXCEPTION 'role mandate_runtime must not be a member of any role, but is a member of: %', members;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_database AS d WHERE d.datname = db AND d.datdba = 'mandate_runtime'::regrole) THEN
    RAISE EXCEPTION 'mandate_runtime must not own database %', db;
  END IF;
END;
$$;
