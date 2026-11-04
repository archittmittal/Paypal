import { POLICY_VERSION } from '@mandate/policy';
import { type Pool, withTransaction } from './pool.js';

/**
 * Demo data (docs/er-diagram.md, "Seed data for demos"). Fixed ids make the seed idempotent: a rerun updates
 * these rows back to the values below instead of inserting duplicates. Emails use the reserved .test domain.
 *
 * No credentials of any kind are seeded, and none of these rows is a login: app_user is an identity record, not an
 * account. The demo owner (decision 5) is the identity the admin functions accept as an owner of the demo
 * organization; it can only be used through an API that authenticates a session as that user, and the API has no
 * authentication yet. Nothing here bypasses authentication, and the demo organization is not for production.
 */
export const DEMO = {
  organization: { id: '00000000-0000-4000-8000-000000000001', name: 'Demo Student Society', defaultCurrency: 'USD' },
  users: [
    { id: '00000000-0000-4000-8000-000000000011', email: 'treasurer@demo.mandate.test', role: 'approver' },
    { id: '00000000-0000-4000-8000-000000000012', email: 'alex@demo.mandate.test', role: 'requester' },
    { id: '00000000-0000-4000-8000-000000000013', email: 'sam@demo.mandate.test', role: 'requester' },
    // The demo organization's owner: administers mandates and roles (docs/er-diagram.md, "Roles").
    { id: '00000000-0000-4000-8000-000000000014', email: 'owner@demo.mandate.test', role: 'owner' },
  ],
  mandate: {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'Autumn events 2026',
    approverUserId: '00000000-0000-4000-8000-000000000011',
    currency: 'USD',
    budgetMinor: 50_000,
    perItemCapMinor: 15_000,
    approvalThresholdMinor: 10_000,
    maxQuantityPerLine: 100,
    structuringWindowMinutes: 24 * 60,
    priceDriftToleranceBps: 200,
    // Covers the build, the demo and judging (ends Dec 15, 2026).
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2027-01-01T00:00:00Z',
  },
  categoryLimits: [
    { category: 'office_supplies', allowed: true, capMinor: null },
    { category: 'electronics', allowed: true, capMinor: 20_000 },
    { category: 'gift_cards', allowed: false, capMinor: null },
  ],
} as const;

export interface SeedResult {
  organizations: number;
  users: number;
  mandates: number;
  categoryLimits: number;
}

export class SeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedConflictError';
  }
}

/**
 * Upserts the demo rows in one transaction, so a failed run changes nothing. Safe to run any number of times: the
 * demo organization, users, mandate and category limits end up exactly as in DEMO. It does not touch other rows,
 * and it fails (with SQLSTATE MD001) rather than lower the demo budget below spend already reserved against it.
 */
export async function seed(pool: Pool): Promise<SeedResult> {
  return withTransaction(pool, async (client) => {
    const { organization: org, mandate, users, categoryLimits } = DEMO;

    await client.query(
      `INSERT INTO organization (id, name, default_currency) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, default_currency = EXCLUDED.default_currency`,
      [org.id, org.name, org.defaultCurrency],
    );

    // A rerun cannot adopt someone else's row: if a different user already holds a demo email in the demo
    // organization, the unique index would reject the insert below. Say so instead of failing with a bare 23505.
    const taken = await client.query<{ email: string }>(
      `SELECT email FROM public.app_user WHERE organization_id = $1 AND lower(email) = ANY($2::text[]) AND NOT (id = ANY($3::uuid[]))`,
      [org.id, users.map((u) => u.email.toLowerCase()), users.map((u) => u.id)],
    );
    if (taken.rows.length > 0) {
      throw new SeedConflictError(`demo email already used by another user: ${taken.rows.map((r) => r.email).join(', ')}`);
    }

    for (const user of users) {
      await client.query(
        `INSERT INTO app_user (id, organization_id, email, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role`,
        [user.id, org.id, user.email, user.role],
      );
    }

    await client.query(
      `INSERT INTO mandate (id, organization_id, approver_user_id, name, status, currency, budget_minor_units,
                            per_item_cap_minor_units, approval_threshold_minor_units, max_quantity_per_line,
                            structuring_window_minutes, price_drift_tolerance_bps, starts_at, ends_at, policy_version)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         approver_user_id = EXCLUDED.approver_user_id, name = EXCLUDED.name, status = EXCLUDED.status,
         currency = EXCLUDED.currency, budget_minor_units = EXCLUDED.budget_minor_units,
         per_item_cap_minor_units = EXCLUDED.per_item_cap_minor_units,
         approval_threshold_minor_units = EXCLUDED.approval_threshold_minor_units,
         max_quantity_per_line = EXCLUDED.max_quantity_per_line,
         structuring_window_minutes = EXCLUDED.structuring_window_minutes,
         price_drift_tolerance_bps = EXCLUDED.price_drift_tolerance_bps,
         starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, policy_version = EXCLUDED.policy_version`,
      [
        mandate.id,
        org.id,
        mandate.approverUserId,
        mandate.name,
        mandate.currency,
        mandate.budgetMinor,
        mandate.perItemCapMinor,
        mandate.approvalThresholdMinor,
        mandate.maxQuantityPerLine,
        mandate.structuringWindowMinutes,
        mandate.priceDriftToleranceBps,
        mandate.startsAt,
        mandate.endsAt,
        POLICY_VERSION,
      ],
    );

    // The demo mandate ends up with exactly the documented limits: rows added since the last seed are removed.
    await client.query('DELETE FROM public.category_limit WHERE mandate_id = $1 AND NOT (category = ANY($2::text[]))', [
      mandate.id,
      categoryLimits.map((l) => l.category),
    ]);
    for (const limit of categoryLimits) {
      await client.query(
        `INSERT INTO category_limit (mandate_id, category, allowed, cap_minor_units) VALUES ($1, $2, $3, $4)
         ON CONFLICT (mandate_id, category) DO UPDATE SET allowed = EXCLUDED.allowed, cap_minor_units = EXCLUDED.cap_minor_units`,
        [mandate.id, limit.category, limit.allowed, limit.capMinor],
      );
    }

    return { organizations: 1, users: users.length, mandates: 1, categoryLimits: categoryLimits.length };
  });
}
