import { POLICY_VERSION } from '@mandate/policy';
import type { Db } from './db.js';

/** Fixed ids so the README, Postman collection and demo script can refer to the seeded rows. */
export const DEMO_IDS = {
  organization: '00000000-0000-4000-8000-000000000001',
  requester: '00000000-0000-4000-8000-000000000011',
  approver: '00000000-0000-4000-8000-000000000012',
  admin: '00000000-0000-4000-8000-000000000013',
  mandate: '00000000-0000-4000-8000-000000000021',
} as const;

/**
 * Demo data: one organization, three users and one active USD mandate. Safe to run repeatedly; existing
 * rows are left as they are. Fictional people on example.com only.
 */
export async function seed(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO organization (id, name, default_currency) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [DEMO_IDS.organization, 'Demo Robotics Club', 'USD'],
    );
    const users = [
      [DEMO_IDS.requester, 'requester@example.com', 'Riya (requester)', 'requester'],
      [DEMO_IDS.approver, 'approver@example.com', 'Arjun (approver)', 'approver'],
      [DEMO_IDS.admin, 'admin@example.com', 'Meera (admin)', 'admin'],
    ] as const;
    for (const [id, email, name, role] of users) {
      await tx.query(
        'INSERT INTO app_user (id, organization_id, email, display_name, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
        [id, DEMO_IDS.organization, email, name, role],
      );
    }
    await tx.query(
      `INSERT INTO mandate (id, organization_id, approver_user_id, name, currency, budget_minor_units,
         per_item_cap_minor_units, approval_threshold_minor_units, max_quantity_per_line,
         structuring_window_minutes, price_drift_tolerance_bps, starts_at, ends_at, policy_version)
       VALUES ($1, $2, $3, $4, 'USD', 100000, 20000, 30000, 10, 1440, 200, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        DEMO_IDS.mandate,
        DEMO_IDS.organization,
        DEMO_IDS.approver,
        'Club supplies, Nov-Dec 2026',
        new Date('2026-11-01T00:00:00Z'),
        new Date('2027-01-01T00:00:00Z'),
        POLICY_VERSION,
      ],
    );
    const limits = [
      ['office-supplies', true, null],
      ['electronics', true, 50000],
      ['software', true, 25000],
      ['gift-cards', false, null],
    ] as const;
    for (const [category, allowed, cap] of limits) {
      await tx.query(
        'INSERT INTO category_limit (mandate_id, category, allowed, cap_minor_units) VALUES ($1, $2, $3, $4) ON CONFLICT (mandate_id, category) DO NOTHING',
        [DEMO_IDS.mandate, category, allowed, cap],
      );
    }
  });
}
