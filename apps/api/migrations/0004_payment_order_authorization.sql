-- 0004: a payment order needs an authorization (hard rule 1), enforced below the service so no code path can skip it.
-- An order may only exist for a policy decision of the same request that is ALLOW, or NEEDS_APPROVAL with that
-- decision's own approval APPROVED, and never for more than the decision evaluated, or in another currency.
CREATE FUNCTION payment_order_authorized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d policy_decision%ROWTYPE;
BEGIN
  SELECT * INTO d FROM policy_decision WHERE id = NEW.policy_decision_id;
  IF d.purchase_request_id IS DISTINCT FROM NEW.purchase_request_id THEN
    RAISE EXCEPTION 'payment_order: policy decision % belongs to another request', NEW.policy_decision_id;
  END IF;
  IF NOT (
    d.outcome = 'ALLOW'
    OR (d.outcome = 'NEEDS_APPROVAL' AND EXISTS (
      SELECT 1 FROM approval a
       WHERE a.id = NEW.approval_id AND a.policy_decision_id = d.id AND a.status = 'APPROVED'))
  ) THEN
    RAISE EXCEPTION 'payment_order: not authorized (decision %, approval %)', d.outcome, NEW.approval_id;
  END IF;
  IF NEW.currency <> d.currency OR NEW.amount_minor_units > d.evaluated_total_minor_units THEN
    RAISE EXCEPTION 'payment_order: amount exceeds the policy decision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_order_authorized
  BEFORE INSERT OR UPDATE OF purchase_request_id, policy_decision_id, approval_id, amount_minor_units, currency
  ON payment_order FOR EACH ROW EXECUTE FUNCTION payment_order_authorized();
