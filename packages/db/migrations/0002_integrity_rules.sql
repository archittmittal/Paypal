-- 0002: invariants the database enforces itself, whatever code (or person) writes to it.
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- Custom SQLSTATEs, so callers match on the code rather than on message text:
--   MD001  budget exceeded           MD002  append-only table modified
--   MD003  illegal reservation edit  MD004  unsupported isolation level
--   MD005  reservation currency differs from the mandate currency
--
-- Name resolution: every function pins `SET search_path = pg_catalog, pg_temp` and schema-qualifies every
-- table. Triggers run with the caller's privileges and, by default, the caller's search_path, in which pg_temp
-- comes first: without the pin, a role allowed to create temp tables could create `mandate` or
-- `budget_reservation` as temp tables and have the checks below read those instead. Listing pg_temp last keeps
-- it from shadowing anything; qualifying the tables makes the lookup independent of search_path entirely.

-- updated_at ---------------------------------------------------------------------------------------

CREATE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER mandate_set_updated_at BEFORE UPDATE ON public.mandate
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER purchase_request_set_updated_at BEFORE UPDATE ON public.purchase_request
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER budget_reservation_set_updated_at BEFORE UPDATE ON public.budget_reservation
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER purchase_order_set_updated_at BEFORE UPDATE ON public.purchase_order
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Append-only tables -------------------------------------------------------------------------------
-- audit_log and order_event accept INSERT only. Corrections are new rows (compensating events).
-- Triggers hold even for the table owner, which is the role local development connects as. In a
-- deployment, also revoke UPDATE/DELETE/TRUNCATE from the application role (docs/er-diagram.md):
-- the table owner or a superuser can disable triggers or rewrite columns with ALTER TABLE, so the
-- application must not connect as either.

CREATE FUNCTION public.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'MD002', HINT = 'Insert a compensating row instead.';
END;
$$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER order_event_append_only BEFORE UPDATE OR DELETE ON public.order_event
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER order_event_no_truncate BEFORE TRUNCATE ON public.order_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
-- Reservations are a ledger too: deleting a COMMITTED row would hand its budget back.
CREATE TRIGGER budget_reservation_no_delete BEFORE DELETE ON public.budget_reservation
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TRIGGER budget_reservation_no_truncate BEFORE TRUNCATE ON public.budget_reservation
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();

-- Budget invariant (architecture failure mode 10) --------------------------------------------------
-- For every mandate: SUM(amount of HELD and COMMITTED reservations) <= budget.
--
-- Both sides of the invariant (a new reservation, a lower budget) serialize on the mandate row lock, then sum
-- the active reservations in a fresh statement. Under READ COMMITTED that statement sees every reservation
-- committed by a transaction that held the lock before us, so two writers cannot both fit into the same
-- remaining budget. REPEATABLE READ and SERIALIZABLE keep the transaction's first snapshot, which would hide
-- those rows: taking a lock that another transaction only *held* (without modifying the row) raises no
-- serialization failure. Both triggers therefore refuse anything but READ COMMITTED rather than trust it.

CREATE FUNCTION public.require_read_committed(operation text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '% requires READ COMMITTED, not %', operation, current_setting('transaction_isolation')
      USING ERRCODE = 'MD004';
  END IF;
END;
$$;

CREATE FUNCTION public.enforce_budget_reservation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  mandate_budget   bigint;
  mandate_currency text;
  active_total     bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.mandate_id <> OLD.mandate_id
       OR NEW.policy_decision_id <> OLD.policy_decision_id
       OR NEW.amount_minor_units <> OLD.amount_minor_units
       OR NEW.currency <> OLD.currency THEN
      RAISE EXCEPTION 'budget_reservation mandate, decision, amount and currency cannot change'
        USING ERRCODE = 'MD003';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state <> 'HELD' THEN
      RAISE EXCEPTION 'budget_reservation cannot move from % to %', OLD.state, NEW.state
        USING ERRCODE = 'MD003';
    END IF;
    -- HELD -> RELEASED or COMMITTED never raises the active total, so it needs no budget check.
    RETURN NEW;
  END IF;

  IF NEW.state <> 'HELD' THEN
    RAISE EXCEPTION 'a new budget_reservation must start HELD, not %', NEW.state USING ERRCODE = 'MD003';
  END IF;
  PERFORM public.require_read_committed('a budget reservation');

  SELECT m.budget_minor_units, m.currency INTO mandate_budget, mandate_currency
    FROM public.mandate AS m
   WHERE m.id = NEW.mandate_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key rejects the row with its usual error
  END IF;
  IF NEW.currency <> mandate_currency THEN
    RAISE EXCEPTION 'reservation currency % differs from mandate currency %', NEW.currency, mandate_currency
      USING ERRCODE = 'MD005';
  END IF;

  SELECT COALESCE(SUM(r.amount_minor_units), 0)::bigint INTO active_total
    FROM public.budget_reservation AS r
   WHERE r.mandate_id = NEW.mandate_id
     AND r.state IN ('HELD', 'COMMITTED');

  IF active_total + NEW.amount_minor_units > mandate_budget THEN
    RAISE EXCEPTION 'BUDGET_EXCEEDED'
      USING ERRCODE = 'MD001',
            DETAIL = format('reserved %s + requested %s > budget %s', active_total, NEW.amount_minor_units, mandate_budget);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_reservation_enforce_budget BEFORE INSERT OR UPDATE ON public.budget_reservation
  FOR EACH ROW EXECUTE FUNCTION public.enforce_budget_reservation();

-- The same invariant from the other side: a mandate's budget cannot drop below what is already
-- reserved, and its currency cannot change while reservations exist. Updating the mandate row takes
-- the same row lock that reservations take, so the two cannot interleave.
CREATE FUNCTION public.enforce_mandate_budget() RETURNS trigger
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
  SELECT COALESCE(SUM(r.amount_minor_units), 0)::bigint INTO active_total
    FROM public.budget_reservation AS r
   WHERE r.mandate_id = NEW.id
     AND r.state IN ('HELD', 'COMMITTED');
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

CREATE TRIGGER mandate_enforce_budget BEFORE UPDATE OF budget_minor_units, currency ON public.mandate
  FOR EACH ROW EXECUTE FUNCTION public.enforce_mandate_budget();
