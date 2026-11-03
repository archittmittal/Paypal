import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { createPgDb, createPgPool } from '../src/db/pg.js';
import { reserveBudget } from '../src/db/reservations.js';
import { DEMO_IDS, seed } from '../src/db/seed.js';

// Needs a real Postgres with several connections: PGlite is single-connection, so it cannot show two
// transactions racing. CI provides one (see .github/workflows/ci.yml). Locally:
//   docker compose up -d && TEST_DATABASE_URL=postgres://mandate:mandate@127.0.0.1:5432/mandate_test pnpm test
// The database is wiped, so never point this at anything but a throwaway test database.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Postgres integration', () => {
  let db: Db;

  beforeAll(async () => {
    db = createPgDb(createPgPool(url ?? ''));
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    expect(await migrate(db, loadMigrations())).toEqual(['0001']);
    await seed(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('never lets concurrent reservations pass the budget (failure mode 10)', async () => {
    // 20 requests of 10,000 race for a 100,000 budget: exactly 10 may win.
    const decisions: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const request = await db.query<{ id: string }>(
        'INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key) VALUES ($1, $2, $3, $4) RETURNING id',
        [DEMO_IDS.mandate, DEMO_IDS.requester, 'race', `race-${i}`],
      );
      const decision = await db.query<{ id: string }>(
        `INSERT INTO policy_decision (purchase_request_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
         VALUES ($1, 'ALLOW', '[]'::jsonb, '0.1.0', 10000, 'USD', now()) RETURNING id`,
        [request.rows[0]?.id],
      );
      decisions.push(decision.rows[0]?.id ?? '');
    }

    const results = await Promise.all(
      decisions.map((policyDecisionId) =>
        db.transaction(async (tx) => {
          const result = await reserveBudget(tx, {
            mandateId: DEMO_IDS.mandate,
            policyDecisionId,
            amountMinor: 10_000,
            currency: 'USD',
            expiresAt: new Date(Date.now() + 3_600_000),
          });
          // Hold the lock a little so the transactions genuinely overlap.
          await tx.query('SELECT pg_sleep(0.01)');
          return result;
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(10);
    const { rows } = await db.query<{ total: string }>(
      "SELECT SUM(amount_minor_units)::text AS total FROM budget_reservation WHERE mandate_id = $1 AND state IN ('HELD', 'COMMITTED')",
      [DEMO_IDS.mandate],
    );
    expect(rows[0]?.total).toBe('100000');
  }, 60_000);
});
