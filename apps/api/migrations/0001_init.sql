-- 0001: initial schema. Mirrors docs/er-diagram.md with these deliberate differences:
--   * "user" and "order" are reserved words, so the tables are app_user and payment_order.
--   * mandate gains max_quantity_per_line, structuring_window_minutes and price_drift_tolerance_bps,
--     which @mandate/policy needs (PR #7).
--   * Append-only tables are enforced by triggers instead of role grants: triggers hold for every role,
--     including a managed database's single owner role, and need no CREATE ROLE privilege.
-- Money: bigint minor units plus an ISO currency on every row (hard rule 4).

CREATE TABLE organization (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  default_currency text NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization (id),
  email           text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  role            text NOT NULL CHECK (role IN ('requester', 'approver', 'admin')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE mandate (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                uuid NOT NULL REFERENCES organization (id),
  approver_user_id               uuid NOT NULL REFERENCES app_user (id),
  name                           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  currency                       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  budget_minor_units             bigint NOT NULL CHECK (budget_minor_units >= 0),
  per_item_cap_minor_units       bigint NOT NULL CHECK (per_item_cap_minor_units >= 0),
  approval_threshold_minor_units bigint NOT NULL CHECK (approval_threshold_minor_units >= 0),
  max_quantity_per_line          integer NOT NULL CHECK (max_quantity_per_line BETWEEN 1 AND 10000),
  structuring_window_minutes     integer NOT NULL CHECK (structuring_window_minutes BETWEEN 1 AND 44640),
  price_drift_tolerance_bps      integer NOT NULL CHECK (price_drift_tolerance_bps BETWEEN 0 AND 10000),
  starts_at                      timestamptz NOT NULL,
  ends_at                        timestamptz NOT NULL,
  status                         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CLOSED')),
  policy_version                 text NOT NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE category_limit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id        uuid NOT NULL REFERENCES mandate (id) ON DELETE CASCADE,
  -- Same slug rule as CategorySchema in @mandate/policy.
  category          text NOT NULL CHECK (category ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  allowed           boolean NOT NULL,
  cap_minor_units   bigint CHECK (cap_minor_units >= 0),
  UNIQUE (mandate_id, category)
);

CREATE TABLE purchase_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id        uuid NOT NULL REFERENCES mandate (id),
  requester_user_id uuid NOT NULL REFERENCES app_user (id),
  -- The user's words, verbatim, for audit and eval replay. Data only; never re-executed as instructions.
  raw_text          text NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 4000),
  parsed_intent     jsonb,
  status            text NOT NULL DEFAULT 'RECEIVED',
  -- Client-supplied; makes a double submit idempotent before any order exists.
  request_key       text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 8 AND 128),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_snapshot (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id    uuid NOT NULL REFERENCES purchase_request (id),
  provider               text NOT NULL,
  external_product_id    text NOT NULL,
  title                  text NOT NULL,
  category               text NOT NULL CHECK (category ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  -- The authoritative price: every total derives from this column, never from LLM output.
  unit_price_minor_units bigint NOT NULL CHECK (unit_price_minor_units >= 0),
  currency               text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  raw_payload            jsonb NOT NULL,
  -- A snapshot used in a decision must have passed quarantine; false here is a bug.
  text_quarantined       boolean NOT NULL CHECK (text_quarantined),
  fetched_at             timestamptz NOT NULL
);

CREATE TABLE cart (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id  uuid NOT NULL UNIQUE REFERENCES purchase_request (id),
  currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor_units bigint NOT NULL CHECK (subtotal_minor_units >= 0),
  shipping_minor_units bigint NOT NULL CHECK (shipping_minor_units >= 0),
  tax_minor_units      bigint NOT NULL CHECK (tax_minor_units >= 0),
  total_minor_units    bigint NOT NULL,
  quoted_at            timestamptz NOT NULL,
  -- Computed in code and asserted here, so a caller-supplied total cannot be stored.
  CHECK (total_minor_units = subtotal_minor_units + shipping_minor_units + tax_minor_units)
);

CREATE TABLE cart_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id                uuid NOT NULL REFERENCES cart (id) ON DELETE CASCADE,
  product_snapshot_id    uuid NOT NULL REFERENCES product_snapshot (id),
  quantity               integer NOT NULL CHECK (quantity > 0),
  unit_price_minor_units bigint NOT NULL CHECK (unit_price_minor_units >= 0),
  line_total_minor_units bigint NOT NULL,
  CHECK (line_total_minor_units = unit_price_minor_units * quantity)
);

CREATE TABLE policy_decision (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id         uuid NOT NULL REFERENCES purchase_request (id),
  cart_id                     uuid REFERENCES cart (id),
  outcome                     text NOT NULL CHECK (outcome IN ('ALLOW', 'NEEDS_APPROVAL', 'DENY')),
  -- Array of {code, message, ruleId, severity}: the dashboard and the eval harness read the same thing.
  reasons                     jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  policy_version              text NOT NULL,
  evaluated_total_minor_units bigint NOT NULL CHECK (evaluated_total_minor_units >= 0),
  currency                    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  decided_at                  timestamptz NOT NULL
);

CREATE TABLE budget_reservation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id         uuid NOT NULL REFERENCES mandate (id),
  policy_decision_id uuid NOT NULL UNIQUE REFERENCES policy_decision (id),
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units >= 0),
  currency           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state              text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD', 'RELEASED', 'COMMITTED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  released_at        timestamptz,
  CHECK ((state = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE INDEX budget_reservation_active_idx ON budget_reservation (mandate_id) WHERE state IN ('HELD', 'COMMITTED');

CREATE TABLE approval (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id uuid NOT NULL REFERENCES purchase_request (id),
  policy_decision_id  uuid NOT NULL UNIQUE REFERENCES policy_decision (id),
  approver_user_id    uuid NOT NULL REFERENCES app_user (id),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  channel             text,
  -- Only the hash of the single-use link token is stored.
  token_hash          text NOT NULL UNIQUE,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  expires_at          timestamptz NOT NULL,
  CHECK ((status = 'PENDING') = (decided_at IS NULL))
);

CREATE TABLE payment_order (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id uuid NOT NULL UNIQUE REFERENCES purchase_request (id),
  policy_decision_id  uuid NOT NULL REFERENCES policy_decision (id),
  approval_id         uuid REFERENCES approval (id),
  provider            text NOT NULL DEFAULT 'paypal',
  provider_order_id   text,
  -- Generated before the first money-moving call and reused on every retry (hard rule 5).
  idempotency_key     text NOT NULL UNIQUE,
  state               text NOT NULL,
  payment_variant     text NOT NULL CHECK (payment_variant IN ('PREAUTH_CAPTURE', 'APPROVAL_LINK')),
  amount_minor_units  bigint NOT NULL CHECK (amount_minor_units >= 0),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL,
  -- The dedupe mechanism: a redelivery hits this unique constraint and is acknowledged without reprocessing.
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  signature_verified boolean NOT NULL,
  processing_state   text NOT NULL DEFAULT 'RECEIVED'
                       CHECK (processing_state IN ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED')),
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE order_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES payment_order (id),
  webhook_event_id uuid REFERENCES webhook_event (id),
  event_type       text NOT NULL,
  from_state       text,
  to_state         text NOT NULL,
  payload          jsonb,
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_event_order_idx ON order_event (order_id, recorded_at);

CREATE TABLE shipment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES payment_order (id),
  carrier         text,
  tracking_number text,
  status          text NOT NULL,
  shipped_at      timestamptz,
  delivered_at    timestamptz
);

CREATE TABLE refund (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES payment_order (id),
  provider_refund_id text,
  idempotency_key    text NOT NULL UNIQUE,
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units > 0),
  currency           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state              text NOT NULL,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization (id),
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'webhook')),
  actor_id        text,
  action          text NOT NULL,
  subject_type    text NOT NULL,
  subject_id      uuid,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_time_idx ON audit_log (organization_id, created_at DESC);

-- Append-only: corrections are new rows, never edits. Holds for every role, so an application bug or a
-- compromised LLM path cannot erase its own tracks.
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER order_event_append_only BEFORE UPDATE OR DELETE ON order_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER order_event_no_truncate BEFORE TRUNCATE ON order_event
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
