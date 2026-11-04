-- 0004: related-row consistency and the actual-spend ledger (review findings M3, M4, L9, and nit on timestamps).
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- New SQLSTATEs (0002 defines MD001-MD005):
--   MD006  mandate is not ACTIVE, or now() is outside its starts_at/ends_at window
--   MD007  a row does not match the related row it claims to belong to (request, mandate, currency, price,
--          decision outcome, approver, or the hold that pays for an order)
--
-- Scope: the rows money passes through (cart -> decision -> reservation -> approval -> order). Cart totals versus
-- their lines and freezing a cart after its decision are left to issue #12 and documented in docs/er-diagram.md.

-- Composite keys so foreign keys can carry the purchase request and currency along -----------------

ALTER TABLE public.cart
  ADD CONSTRAINT cart_id_request_currency_key UNIQUE (id, purchase_request_id, currency);
ALTER TABLE public.policy_decision
  ADD CONSTRAINT policy_decision_id_request_key UNIQUE (id, purchase_request_id),
  ADD CONSTRAINT policy_decision_id_request_currency_key UNIQUE (id, purchase_request_id, currency);

-- A decision scores a cart of the same request, in the cart's currency.
ALTER TABLE public.policy_decision
  ADD CONSTRAINT policy_decision_cart_request_currency_fkey
    FOREIGN KEY (cart_id, purchase_request_id, currency) REFERENCES public.cart (id, purchase_request_id, currency);
-- An order pays for a decision of the same request, in the decision's currency.
ALTER TABLE public.purchase_order
  ADD CONSTRAINT purchase_order_decision_request_currency_fkey
    FOREIGN KEY (policy_decision_id, purchase_request_id, currency) REFERENCES public.policy_decision (id, purchase_request_id, currency);
-- An approval escalates a decision of the same request.
ALTER TABLE public.approval
  ADD CONSTRAINT approval_decision_request_fkey
    FOREIGN KEY (policy_decision_id, purchase_request_id) REFERENCES public.policy_decision (id, purchase_request_id);

-- Actual spend (M4) --------------------------------------------------------------------------------
-- amount_minor_units is what a HELD reservation blocks: a ceiling, at least the decision total (it may include
-- the mandate's drift tolerance). committed_amount_minor_units is what was actually captured, set exactly once
-- on HELD -> COMMITTED and never above the hold. A COMMITTED row counts its committed amount, so the unused part
-- of a hold returns to the budget. Paying more than was held needs a new decision, never a silent top-up.

ALTER TABLE public.budget_reservation
  ADD COLUMN committed_amount_minor_units minor_units;
-- Rows committed before this column existed recorded no actual amount; the hold is the best figure available.
-- The reservation trigger (0002) allows this: it only sets the new column and changes no state or amount.
UPDATE public.budget_reservation SET committed_amount_minor_units = amount_minor_units WHERE state = 'COMMITTED';
ALTER TABLE public.budget_reservation
  ADD CONSTRAINT budget_reservation_committed_amount_check
    CHECK ((state = 'COMMITTED') = (committed_amount_minor_units IS NOT NULL)),
  ADD CONSTRAINT budget_reservation_committed_within_hold_check
    CHECK (committed_amount_minor_units <= amount_minor_units);

-- The one definition of "spent or held" for a mandate, used by both budget triggers and by reserveBudget().
CREATE FUNCTION public.mandate_active_total(mandate uuid) RETURNS bigint
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(SUM(CASE WHEN r.state = 'COMMITTED' THEN r.committed_amount_minor_units ELSE r.amount_minor_units END), 0)::bigint
    FROM public.budget_reservation AS r
   WHERE r.mandate_id = mandate
     AND r.state IN ('HELD', 'COMMITTED');
$$;

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
       OR (OLD.committed_amount_minor_units IS NOT NULL
           AND NEW.committed_amount_minor_units IS DISTINCT FROM OLD.committed_amount_minor_units) THEN
      RAISE EXCEPTION 'budget_reservation mandate, decision, amount, currency and committed amount cannot change'
        USING ERRCODE = 'MD003';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state THEN
      IF OLD.state <> 'HELD' THEN
        RAISE EXCEPTION 'budget_reservation cannot move from % to %', OLD.state, NEW.state USING ERRCODE = 'MD003';
      END IF;
      -- A payment in flight may still succeed: its hold must stay until reconciliation settles it (failure mode 4).
      IF NEW.state = 'RELEASED' AND EXISTS (
           SELECT 1 FROM public.purchase_order AS o
            WHERE o.policy_decision_id = NEW.policy_decision_id
              AND o.state IN ('PAYMENT_PENDING', 'UNKNOWN_OUTCOME')) THEN
        RAISE EXCEPTION 'cannot release a hold while its order is PAYMENT_PENDING or UNKNOWN_OUTCOME'
          USING ERRCODE = 'MD003', HINT = 'Reconcile the order with get-order first.';
      END IF;
    END IF;
    -- HELD -> RELEASED lowers the active total; HELD -> COMMITTED replaces the hold by a smaller or equal
    -- committed amount (checked by constraint). Neither can raise it, so neither needs a budget check.
    RETURN NEW;
  END IF;

  IF NEW.state <> 'HELD' THEN
    RAISE EXCEPTION 'a new budget_reservation must start HELD, not %', NEW.state USING ERRCODE = 'MD003';
  END IF;
  IF NEW.expires_at <= now() THEN
    RAISE EXCEPTION 'a new budget_reservation must expire in the future' USING ERRCODE = 'MD003';
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

CREATE OR REPLACE FUNCTION public.enforce_mandate_budget() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  active_total bigint;
BEGIN
  IF NEW.budget_minor_units >= OLD.budget_minor_units AND NEW.currency = OLD.currency THEN
    RETURN NEW; -- raising the budget cannot break the invariant, under any isolation level
  END IF;
  PERFORM public.require_read_committed('lowering a mandate budget or changing its currency');
  active_total := public.mandate_active_total(NEW.id);
  IF NEW.currency <> OLD.currency AND active_total > 0 THEN
    RAISE EXCEPTION 'mandate currency cannot change while reservations exist' USING ERRCODE = 'MD005';
  END IF;
  IF NEW.budget_minor_units < active_total THEN
    RAISE EXCEPTION 'BUDGET_EXCEEDED'
      USING ERRCODE = 'MD001',
            DETAIL = format('budget %s < already reserved %s', NEW.budget_minor_units, active_total);
  END IF;
  RETURN NEW;
END;
$$;

-- Prices come from snapshots (hard rule 2) ---------------------------------------------------------
-- A snapshot is evidence of the price a decision used, so it never changes after it is written.
CREATE TRIGGER product_snapshot_immutable BEFORE UPDATE OR DELETE ON public.product_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER product_snapshot_no_truncate BEFORE TRUNCATE ON public.product_snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

-- A cart line uses a snapshot of its own request, in the cart's currency, at exactly the snapshot's price.
CREATE FUNCTION public.enforce_cart_item() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM public.cart AS c
         JOIN public.product_snapshot AS s ON s.id = NEW.product_snapshot_id
        WHERE c.id = NEW.cart_id
          AND s.purchase_request_id = c.purchase_request_id
          AND s.currency = c.currency
          AND s.unit_price_minor_units = NEW.unit_price_minor_units) THEN
    -- A missing cart or snapshot also lands here; the foreign keys would reject it anyway.
    RAISE EXCEPTION 'cart line does not match its product snapshot (request, currency or unit price)'
      USING ERRCODE = 'MD007';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cart_item_matches_snapshot BEFORE INSERT OR UPDATE ON public.cart_item
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cart_item();

-- Approvals: only the mandate's approver, only for a NEEDS_APPROVAL decision -------------------------
CREATE FUNCTION public.enforce_approval() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM public.policy_decision AS pd
         JOIN public.purchase_request AS pr ON pr.id = pd.purchase_request_id
         JOIN public.mandate AS m ON m.id = pr.mandate_id
        WHERE pd.id = NEW.policy_decision_id
          AND pd.outcome = 'NEEDS_APPROVAL'
          AND m.approver_user_id = NEW.approver_user_id) THEN
    RAISE EXCEPTION 'approval must be for a NEEDS_APPROVAL decision and by the mandate''s approver'
      USING ERRCODE = 'MD007';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_matches_mandate BEFORE INSERT OR UPDATE OF policy_decision_id, approver_user_id ON public.approval
  FOR EACH ROW EXECUTE FUNCTION public.enforce_approval();

-- Orders: the database backstop for hard rule 1 ------------------------------------------------------
-- A payment row needs an ALLOW decision, or a NEEDS_APPROVAL decision with an APPROVED approval of that same
-- decision, and a HELD reservation of that decision covering the order amount.
CREATE FUNCTION public.enforce_purchase_order() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  outcome text;
BEGIN
  SELECT pd.outcome INTO outcome FROM public.policy_decision AS pd WHERE pd.id = NEW.policy_decision_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key rejects the row with its usual error
  END IF;
  IF outcome = 'DENY'
     OR (outcome = 'NEEDS_APPROVAL' AND NOT EXISTS (
           SELECT 1 FROM public.approval AS a
            WHERE a.id = NEW.approval_id
              AND a.policy_decision_id = NEW.policy_decision_id
              AND a.status = 'APPROVED')) THEN
    RAISE EXCEPTION 'an order needs an ALLOW decision or an APPROVED approval of its decision' USING ERRCODE = 'MD007';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.budget_reservation AS r
        WHERE r.policy_decision_id = NEW.policy_decision_id
          AND r.state = 'HELD'
          AND r.amount_minor_units >= NEW.amount_minor_units) THEN
    RAISE EXCEPTION 'an order needs a HELD reservation of its decision covering its amount' USING ERRCODE = 'MD007';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_order_requires_authorization BEFORE INSERT ON public.purchase_order
  FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_order();

-- Append-only timestamps are the server's, not the caller's -----------------------------------------
-- Otherwise an insert could backdate an audit entry. order_event.occurred_at stays caller-supplied: it is the
-- provider's own time, kept to detect out-of-order delivery.
CREATE FUNCTION public.stamp_insert_time() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'audit_log' THEN
    NEW.created_at := now();
  ELSE
    NEW.recorded_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_stamp_created_at BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.stamp_insert_time();
CREATE TRIGGER order_event_stamp_recorded_at BEFORE INSERT ON public.order_event
  FOR EACH ROW EXECUTE FUNCTION public.stamp_insert_time();
