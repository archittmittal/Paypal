import { evaluate, MandateSchema, POLICY_VERSION } from '@mandate/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, SeedConflictError, seed } from '../src/seed.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function counts(): Promise<Record<string, number>> {
  const { rows } = await db.pool.query<Record<string, number>>(`
    SELECT (SELECT count(*) FROM organization)::bigint   AS organizations,
           (SELECT count(*) FROM app_user)::bigint       AS users,
           (SELECT count(*) FROM mandate)::bigint        AS mandates,
           (SELECT count(*) FROM category_limit)::bigint AS category_limits`);
  return rows[0] ?? {};
}

describe('db:seed (real Postgres)', () => {
  it('inserts one organization, four users (one owner), one mandate and three category limits', async () => {
    await seed(db.pool);
    expect(await counts()).toEqual({ organizations: 1, users: 4, mandates: 1, category_limits: 3 });
  });

  it('is idempotent: rerunning changes no counts and restores edited demo values', async () => {
    await seed(db.pool);
    await db.pool.query('UPDATE mandate SET budget_minor_units = 99999 WHERE id = $1', [DEMO.mandate.id]);
    await seed(db.pool);
    await seed(db.pool);
    expect(await counts()).toEqual({ organizations: 1, users: 4, mandates: 1, category_limits: 3 });
    const { rows } = await db.pool.query<{ budget_minor_units: number; policy_version: string }>(
      'SELECT budget_minor_units, policy_version FROM mandate WHERE id = $1',
      [DEMO.mandate.id],
    );
    expect(rows[0]).toEqual({ budget_minor_units: 50_000, policy_version: POLICY_VERSION });
  });

  it('produces a mandate the policy engine accepts, with the documented category rules', async () => {
    await seed(db.pool);
    const m = await db.pool.query<{
      id: string;
      status: 'ACTIVE' | 'PAUSED' | 'CLOSED';
      currency: string;
      budget_minor_units: number;
      per_item_cap_minor_units: number;
      approval_threshold_minor_units: number;
      max_quantity_per_line: number;
      structuring_window_minutes: number;
      price_drift_tolerance_bps: number;
      starts_at: Date;
      ends_at: Date;
    }>('SELECT * FROM mandate WHERE id = $1', [DEMO.mandate.id]);
    const limits = await db.pool.query<{ category: string; allowed: boolean; cap_minor_units: number | null }>(
      'SELECT category, allowed, cap_minor_units FROM category_limit WHERE mandate_id = $1 ORDER BY category',
      [DEMO.mandate.id],
    );
    const row = m.rows[0];
    if (row === undefined) throw new Error('mandate not seeded');

    // The row-to-engine mapping issue #12 will need; parsing proves the columns line up with MandateSchema.
    const mandate = MandateSchema.parse({
      id: row.id,
      status: row.status,
      currency: row.currency,
      budgetMinor: row.budget_minor_units,
      perItemCapMinor: row.per_item_cap_minor_units,
      approvalThresholdMinor: row.approval_threshold_minor_units,
      maxQuantityPerLine: row.max_quantity_per_line,
      structuringWindowMinutes: row.structuring_window_minutes,
      priceDriftToleranceBps: row.price_drift_tolerance_bps,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      categoryLimits: limits.rows.map((l) => (l.cap_minor_units === null ? { category: l.category, allowed: l.allowed } : { category: l.category, allowed: l.allowed, capMinor: l.cap_minor_units })),
    });

    const now = new Date('2026-11-04T12:00:00Z');
    const tags = { productId: 'tags', category: 'office_supplies', unitPriceMinor: 50, quantity: 40 };
    const card = { productId: 'card', category: 'gift_cards', unitPriceMinor: 2_500, quantity: 1 };
    expect(evaluate(mandate, { currency: 'USD', items: [tags], shippingMinor: 0, taxMinor: 0 }, { records: [] }, now).outcome).toBe('ALLOW');
    expect(evaluate(mandate, { currency: 'USD', items: [card], shippingMinor: 0, taxMinor: 0 }, { records: [] }, now).outcome).toBe('DENY');
  });

  it('removes category limits added to the demo mandate since the last seed', async () => {
    await seed(db.pool);
    await db.pool.query(`INSERT INTO category_limit (mandate_id, category, allowed) VALUES ($1, 'alcohol', true)`, [DEMO.mandate.id]);
    await seed(db.pool);
    const { rows } = await db.pool.query<{ category: string }>('SELECT category FROM category_limit WHERE mandate_id = $1 ORDER BY category', [DEMO.mandate.id]);
    expect(rows.map((r) => r.category)).toEqual(['electronics', 'gift_cards', 'office_supplies']);
  });

  it('fails with a clear error, changing nothing, when another user holds a demo email', async () => {
    await seed(db.pool);
    await db.pool.query('UPDATE app_user SET email = $2 WHERE id = $1', [DEMO.users[2].id, 'renamed@demo.mandate.test']);
    await db.pool.query(`INSERT INTO app_user (organization_id, email, role) VALUES ($1, $2, 'requester')`, [DEMO.organization.id, DEMO.users[2].email]);
    await db.pool.query('UPDATE mandate SET name = $2 WHERE id = $1', [DEMO.mandate.id, 'edited']);
    await expect(seed(db.pool)).rejects.toBeInstanceOf(SeedConflictError);
    const { rows } = await db.pool.query<{ name: string }>('SELECT name FROM mandate WHERE id = $1', [DEMO.mandate.id]);
    expect(rows[0]?.name).toBe('edited'); // rolled back: nothing was changed
  });

  it('seeds a documented demo owner identity with no credentials anywhere', async () => {
    // Seeded by the tests above (the previous one leaves a conflicting user, so no reseed here).
    const owners = await db.pool.query<{ id: string; email: string }>(`SELECT id, email FROM app_user WHERE organization_id = $1 AND role = 'owner'`, [
      DEMO.organization.id,
    ]);
    expect(owners.rows).toEqual([{ id: '00000000-0000-4000-8000-000000000014', email: 'owner@demo.mandate.test' }]);
    // app_user holds identities, not accounts: no column could carry a password, token or key.
    const columns = await db.pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'app_user' ORDER BY 1`);
    expect(columns.rows.map((r) => r.column_name)).toEqual(['created_at', 'email', 'id', 'organization_id', 'role']);
  });
});
