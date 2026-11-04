-- 0001: core tables from docs/er-diagram.md.
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- Naming: the ER entities USER and ORDER are the tables app_user and purchase_order. Both words are
-- reserved in SQL, and an unquoted `SELECT * FROM user` silently returns the session user instead of failing.
-- Money: every amount is minor_units (bigint) next to a currency_code (text). Never numeric, never float.

-- Bounded at Number.MAX_SAFE_INTEGER so every stored amount parses into @mandate/shared's MoneySchema.
CREATE DOMAIN minor_units AS bigint
  CHECK (VALUE >= 0 AND VALUE <= 9007199254740991);

-- ISO 4217 alpha-3 format, as CurrencySchema in @mandate/shared.
CREATE DOMAIN currency_code AS text
  CHECK (VALUE ~ '^[A-Z]{3}$');

-- Normalized category slug, as CategorySchema in @mandate/policy.
CREATE DOMAIN category_slug AS text
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9_-]{0,63}$');

-- Every state an order or request can be in: docs/uml.md section 2. Issue #12 may narrow these per table.
CREATE DOMAIN order_state AS text
  CHECK (VALUE IN (
    'CREATED', 'QUOTED', 'POLICY_CHECKED', 'DENIED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED',
    'PAYMENT_PENDING', 'CAPTURED', 'FAILED', 'UNKNOWN_OUTCOME', 'SHIPPED', 'DELIVERED',
    'REFUND_REQUESTED', 'REFUNDED'
  ));

CREATE TABLE organization (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  default_currency currency_code NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization (id),
  email           text NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email LIKE '%_@_%'),
  role            text NOT NULL CHECK (role IN ('requester', 'approver', 'admin')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Target of composite foreign keys that keep a mandate's approver inside the mandate's organization.
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX app_user_organization_email_key ON app_user (organization_id, lower(email));

CREATE TABLE mandate (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                uuid NOT NULL REFERENCES organization (id),
  approver_user_id               uuid NOT NULL,
  name                           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status                         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CLOSED')),
  currency                       currency_code NOT NULL,
  budget_minor_units             minor_units NOT NULL,
  -- Applies to each line total (unit price x quantity), not to the unit price.
  per_item_cap_minor_units       minor_units NOT NULL,
  -- At or above this cart total the outcome is at least NEEDS_APPROVAL.
  approval_threshold_minor_units minor_units NOT NULL,
  -- The next three are read by @mandate/policy and were missing from the first ER diagram.
  -- Bounds match MandateSchema (MAX_QUANTITY = 10000; 31 days; 100% in basis points).
  max_quantity_per_line          integer NOT NULL CHECK (max_quantity_per_line BETWEEN 1 AND 10000),
  structuring_window_minutes     integer NOT NULL CHECK (structuring_window_minutes BETWEEN 1 AND 44640),
  price_drift_tolerance_bps      integer NOT NULL CHECK (price_drift_tolerance_bps BETWEEN 0 AND 10000),
  starts_at                      timestamptz NOT NULL,
  ends_at                        timestamptz NOT NULL,
  policy_version                 text NOT NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (organization_id, approver_user_id) REFERENCES app_user (organization_id, id)
);
CREATE INDEX mandate_organization_id_idx ON mandate (organization_id);

CREATE TABLE category_limit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id      uuid NOT NULL REFERENCES mandate (id) ON DELETE CASCADE,
  category        category_slug NOT NULL,
  -- false is an explicit block; a category with no row is not in the allow-list either.
  allowed         boolean NOT NULL,
  -- NULL means no category cap. Counts committed plus held spend in this category.
  cap_minor_units minor_units,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, category)
);

CREATE TABLE purchase_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id        uuid NOT NULL REFERENCES mandate (id),
  requester_user_id uuid NOT NULL REFERENCES app_user (id),
  raw_text          text NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 4000),
  -- Schema-validated LLM output (PurchaseIntentSchema). Data, never instructions.
  parsed_intent     jsonb,
  status            order_state NOT NULL DEFAULT 'CREATED',
  -- Client-supplied idempotency key, unique per requester (constraint below). A double submit by the same
  -- requester hits the constraint; one requester's keys can never collide with, or reveal, another's.
  request_key       text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_request_requester_request_key_key UNIQUE (requester_user_id, request_key)
);
CREATE INDEX purchase_request_mandate_created_idx ON purchase_request (mandate_id, created_at DESC);

CREATE TABLE product_snapshot (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id    uuid NOT NULL REFERENCES purchase_request (id),
  provider               text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  external_product_id    text NOT NULL CHECK (length(external_product_id) BETWEEN 1 AND 128),
  title                  text NOT NULL,
  category               category_slug NOT NULL,
  -- The authoritative price. Every total derives from this column, never from model output.
  unit_price_minor_units minor_units NOT NULL,
  currency               currency_code NOT NULL,
  raw_payload            jsonb NOT NULL,
  text_quarantined       boolean NOT NULL,
  fetched_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_snapshot_purchase_request_idx ON product_snapshot (purchase_request_id);

CREATE TABLE cart (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id  uuid NOT NULL UNIQUE REFERENCES purchase_request (id),
  currency             currency_code NOT NULL,
  subtotal_minor_units minor_units NOT NULL,
  shipping_minor_units minor_units NOT NULL DEFAULT 0,
  tax_minor_units      minor_units NOT NULL DEFAULT 0,
  -- Computed by the database, so no caller can supply a total.
  total_minor_units    bigint GENERATED ALWAYS AS (subtotal_minor_units + shipping_minor_units + tax_minor_units) STORED,
  quoted_at            timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (total_minor_units <= 9007199254740991)
);

CREATE TABLE cart_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id                uuid NOT NULL REFERENCES cart (id) ON DELETE CASCADE,
  product_snapshot_id    uuid NOT NULL REFERENCES product_snapshot (id),
  -- Positive only. The plausibility ceiling is a policy rule, so a large quantity yields a reason, not a 500.
  quantity               integer NOT NULL CHECK (quantity > 0),
  unit_price_minor_units minor_units NOT NULL,
  line_total_minor_units minor_units NOT NULL,
  CHECK (line_total_minor_units = unit_price_minor_units * quantity),
  UNIQUE (cart_id, product_snapshot_id)
);
CREATE INDEX cart_item_product_snapshot_idx ON cart_item (product_snapshot_id);

CREATE TABLE policy_decision (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id         uuid NOT NULL REFERENCES purchase_request (id),
  cart_id                     uuid NOT NULL REFERENCES cart (id),
  outcome                     text NOT NULL CHECK (outcome IN ('ALLOW', 'NEEDS_APPROVAL', 'DENY')),
  -- Array of {code, message, ruleId, severity} from @mandate/policy.
  reasons                     jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  policy_version              text NOT NULL,
  evaluated_total_minor_units minor_units NOT NULL,
  -- Not in the first ER diagram: an amount without its currency breaks the money rule.
  currency                    currency_code NOT NULL,
  decided_at                  timestamptz NOT NULL
);
CREATE INDEX policy_decision_purchase_request_idx ON policy_decision (purchase_request_id);
CREATE INDEX policy_decision_cart_idx ON policy_decision (cart_id);

CREATE TABLE budget_reservation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id         uuid NOT NULL REFERENCES mandate (id),
  policy_decision_id uuid NOT NULL UNIQUE REFERENCES policy_decision (id),
  amount_minor_units minor_units NOT NULL,
  currency           currency_code NOT NULL,
  state              text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD', 'RELEASED', 'COMMITTED')),
  expires_at         timestamptz NOT NULL,
  released_at        timestamptz,
  committed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'RELEASED') = (released_at IS NOT NULL)),
  CHECK ((state = 'COMMITTED') = (committed_at IS NOT NULL))
);
-- The budget check sums these rows under the mandate lock (migration 0002).
CREATE INDEX budget_reservation_active_idx ON budget_reservation (mandate_id) WHERE state IN ('HELD', 'COMMITTED');
-- The expiry sweeper scans only held rows.
CREATE INDEX budget_reservation_held_expiry_idx ON budget_reservation (expires_at) WHERE state = 'HELD';

CREATE TABLE approval (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id uuid NOT NULL REFERENCES purchase_request (id),
  policy_decision_id  uuid NOT NULL UNIQUE REFERENCES policy_decision (id),
  approver_user_id    uuid NOT NULL REFERENCES app_user (id),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  channel             text NOT NULL CHECK (length(channel) BETWEEN 1 AND 32),
  -- Only the hash of the callback token is stored. Unique, so a token cannot be replayed onto another row.
  token_hash          text NOT NULL UNIQUE,
  token_used_at       timestamptz,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  expires_at          timestamptz NOT NULL,
  CHECK ((status IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL)),
  CHECK (expires_at > requested_at)
);
CREATE INDEX approval_purchase_request_idx ON approval (purchase_request_id);
CREATE INDEX approval_pending_expiry_idx ON approval (expires_at) WHERE status = 'PENDING';

CREATE TABLE purchase_order (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id uuid NOT NULL UNIQUE REFERENCES purchase_request (id),
  policy_decision_id  uuid NOT NULL REFERENCES policy_decision (id),
  approval_id         uuid REFERENCES approval (id),
  provider            text NOT NULL DEFAULT 'paypal' CHECK (length(provider) BETWEEN 1 AND 64),
  -- Set once PayPal answers. Needed to reconcile an UNKNOWN_OUTCOME with get-order.
  provider_order_id   text,
  -- Generated before the first money-moving call and reused on every retry of that capture.
  idempotency_key     text NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,108}$'),
  state               order_state NOT NULL DEFAULT 'PAYMENT_PENDING',
  payment_variant     text NOT NULL CHECK (payment_variant IN ('PREAUTH_CAPTURE', 'APPROVAL_LINK')),
  amount_minor_units  minor_units NOT NULL,
  currency            currency_code NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id)
);
CREATE INDEX purchase_order_policy_decision_idx ON purchase_order (policy_decision_id);
CREATE INDEX purchase_order_open_state_idx ON purchase_order (state) WHERE state IN ('PAYMENT_PENDING', 'UNKNOWN_OUTCOME');

CREATE TABLE webhook_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  provider_event_id  text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  -- An unverified event is stored for forensics and never processed.
  signature_verified boolean NOT NULL,
  processing_state   text NOT NULL DEFAULT 'RECEIVED' CHECK (processing_state IN ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED')),
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);
-- The dedupe mechanism: a redelivered *verified* event hits this index and is not reprocessed. Unverified rows
-- are excluded on purpose: a forged event, or one whose verification failed transiently, must not occupy the
-- slot and swallow PayPal's genuine redelivery. Handlers insert with
--   ON CONFLICT (provider, provider_event_id) WHERE signature_verified DO NOTHING
CREATE UNIQUE INDEX webhook_event_verified_dedupe_key ON webhook_event (provider, provider_event_id) WHERE signature_verified;
CREATE INDEX webhook_event_unprocessed_idx ON webhook_event (received_at) WHERE processing_state = 'RECEIVED';

-- Append-only (migration 0002).
CREATE TABLE order_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES purchase_order (id),
  webhook_event_id uuid REFERENCES webhook_event (id),
  event_type       text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  from_state       order_state,
  to_state         order_state NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Provider time vs our time: comparing them exposes out-of-order delivery.
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_event_order_recorded_idx ON order_event (order_id, recorded_at);
CREATE INDEX order_event_webhook_event_idx ON order_event (webhook_event_id) WHERE webhook_event_id IS NOT NULL;

-- Append-only (migration 0002).
CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization (id),
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'webhook')),
  actor_id        text,
  action          text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  subject_type    text NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 64),
  subject_id      uuid,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_organization_created_idx ON audit_log (organization_id, created_at DESC);
CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id);
