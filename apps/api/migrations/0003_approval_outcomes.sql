-- 0003: request statuses for a human decision (#13) and the reason an approval ended.
ALTER TABLE purchase_request DROP CONSTRAINT purchase_request_status_check;
ALTER TABLE purchase_request
  ADD CONSTRAINT purchase_request_status_check CHECK (status IN (
    'RECEIVED', 'NEEDS_CLARIFICATION', 'NO_MATCH', 'QUOTED', 'DENIED', 'PENDING_APPROVAL', 'REJECTED', 'EXPIRED',
    'PAYMENT_PENDING', 'UNKNOWN_OUTCOME', 'CAPTURED', 'FAILED'
  ));
