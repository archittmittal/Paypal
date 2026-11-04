-- 0003: purchase-request idempotency with a body hash, and tenant consistency (review finding H3).
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- 1. request_hash: SHA-256 (lower-case hex) of the request body, computed in code by requestBodyHash()
--    (packages/db/src/requests.ts). A retry with the same requester and request_key must carry the same hash;
--    a reused key with a different body is refused instead of silently returning the first request.
-- 2. organization_id: stored on the request so two composite foreign keys can prove that the mandate and the
--    requester belong to the same organization. Before this, a user of organization B could raise a request
--    against organization A's mandate.
--
-- Both columns are NOT NULL. Existing rows are backfilled where that is possible: the organization comes from
-- the mandate, and rows that predate the hash get a marker hash no real body can produce, so they can never be
-- matched by a retry. A request whose requester is in another organization violates the new foreign key and
-- makes this migration fail (and roll back) rather than keep inconsistent data.

ALTER TABLE public.mandate
  ADD CONSTRAINT mandate_organization_id_id_key UNIQUE (organization_id, id);

ALTER TABLE public.purchase_request
  ADD COLUMN organization_id uuid,
  ADD COLUMN request_hash text;

UPDATE public.purchase_request AS pr
   SET organization_id = m.organization_id,
       request_hash    = repeat('0', 64)
  FROM public.mandate AS m
 WHERE m.id = pr.mandate_id;

ALTER TABLE public.purchase_request
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ADD CONSTRAINT purchase_request_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT purchase_request_mandate_organization_fkey
    FOREIGN KEY (organization_id, mandate_id) REFERENCES public.mandate (organization_id, id),
  ADD CONSTRAINT purchase_request_requester_organization_fkey
    FOREIGN KEY (organization_id, requester_user_id) REFERENCES public.app_user (organization_id, id);

CREATE INDEX purchase_request_organization_created_idx ON public.purchase_request (organization_id, created_at DESC);
