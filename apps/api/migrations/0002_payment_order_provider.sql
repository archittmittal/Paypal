-- 0002: what the purchase flow needs to show a pending PayPal order.
-- approve_url: where the buyer approves an APPROVAL_LINK order (PayPal returns it once, on create).
-- provider_status: PayPal's own order status (CREATED, PAYER_ACTION_REQUIRED, COMPLETED, ...), kept
-- separate from our state machine in payment_order.state.
ALTER TABLE payment_order
  ADD COLUMN approve_url     text CHECK (approve_url IS NULL OR approve_url ~ '^https://'),
  ADD COLUMN provider_status text;

-- Why a request ended in FAILED (e.g. INTENT_FAILED, UNKNOWN_CANDIDATE, PAYPAL_UNPROCESSABLE). A fixed code,
-- never provider or model text.
ALTER TABLE purchase_request
  ADD COLUMN failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$');

-- The request-level status values the purchase flow writes (docs/uml.md section 2).
ALTER TABLE purchase_request
  ADD CONSTRAINT purchase_request_status_check CHECK (status IN (
    'RECEIVED', 'NEEDS_CLARIFICATION', 'NO_MATCH', 'QUOTED', 'DENIED', 'PENDING_APPROVAL',
    'PAYMENT_PENDING', 'UNKNOWN_OUTCOME', 'CAPTURED', 'FAILED'
  ));

ALTER TABLE payment_order
  ADD CONSTRAINT payment_order_state_check CHECK (state IN (
    'PAYMENT_PENDING', 'UNKNOWN_OUTCOME', 'CAPTURED', 'FAILED'
  ));
