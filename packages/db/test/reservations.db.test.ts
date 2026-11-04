import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { CommitOutcomeUnknownError, createPool, type PoolClient, SQLSTATE, sqlState, TransactionRolledBackError, withTransaction } from '../src/pool.js';
import { reserveBudget } from '../src/reservations.js';
import {
  activeReservedTotal,
  captureOrder,
  createDecision,
  createDecisionRows,
  createMandate,
  createTestDatabase,
  inOneHour,
  type MandateFixture,
  placeOrder,
  type TestDatabase,
  waitUntilBlockedOnLock,
} from './support/test-database.js';

// Failure mode 10 (docs/architecture.md): two requests must not both pass a budget check only one of them fits.
// Budget 10 000, request A 7 000, request B 6 000: either fits alone, both together would overspend by 3 000.

const BUDGET = 10_000;
const A = 7_000;
const B = 6_000;
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

const finished = new WeakSet<PoolClient>();

/**
 * Opens a transaction on its own pooled connection and reports the backend pid, for lock inspection. If the test
 * fails before finish(), the connection is destroyed when the test ends, so a failure never leaks a connection
 * (which would hang pool.end() and leave the test database behind).
 */
async function begin(): Promise<{ client: PoolClient; pid: number }> {
  const client = await db.pool.connect();
  onTestFinished(() => {
    if (!finished.has(client)) {
      finished.add(client);
      client.release(true);
    }
  });
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return { client, pid: rows[0]?.pid ?? 0 };
}

async function finish(client: PoolClient, sql: 'COMMIT' | 'ROLLBACK'): Promise<void> {
  try {
    await client.query(sql);
  } finally {
    finished.add(client);
    client.release();
  }
}

async function reservationCount(mandateId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>('SELECT count(*)::bigint AS n FROM budget_reservation WHERE mandate_id = $1', [mandateId]);
  return rows[0]?.n ?? 0;
}

describe('concurrent budget reservations (real Postgres)', () => {
  it('lets exactly one of A=7000 and B=6000 through when both run at once, 25 times over', async () => {
    for (let round = 0; round < 25; round++) {
      const fixture = await createMandate(db.pool, BUDGET);
      const decisionA = await createDecision(db.pool, fixture, A);
      const decisionB = await createDecision(db.pool, fixture, B);

      const attempt = (decisionId: string, amount: number) =>
        withTransaction(db.pool, async (client) => {
          const result = await reserveBudget(client, { mandateId: fixture.mandateId, policyDecisionId: decisionId, amount: usd(amount), expiresAt: inOneHour() });
          // Hold the lock a little, so the other transaction is genuinely in flight meanwhile.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return result;
        });

      const results = await Promise.all([attempt(decisionA, A), attempt(decisionB, B)]);
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);

      expect(winners).toHaveLength(1);
      expect(losers).toEqual([expect.objectContaining({ ok: false, reason: 'BUDGET_EXCEEDED', budgetMinor: BUDGET })]);
      const reserved = await activeReservedTotal(db.pool, fixture.mandateId);
      expect([A, B]).toContain(reserved);
      expect(reserved).toBeLessThanOrEqual(BUDGET);
      expect(await reservationCount(fixture.mandateId)).toBe(1);
    }
  });

  it('makes B wait for A\'s lock, then sees A\'s committed hold and refuses (forced interleaving)', async () => {
    const fixture = await createMandate(db.pool, BUDGET);
    const [decisionA, decisionB] = [await createDecision(db.pool, fixture, A), await createDecision(db.pool, fixture, B)];
    const ta = await begin();
    const tb = await begin();

    const resultA = await reserveBudget(ta.client, { mandateId: fixture.mandateId, policyDecisionId: decisionA, amount: usd(A), expiresAt: inOneHour() });
    expect(resultA).toMatchObject({ ok: true, reservedBeforeMinor: 0 });

    const pendingB = reserveBudget(tb.client, { mandateId: fixture.mandateId, policyDecisionId: decisionB, amount: usd(B), expiresAt: inOneHour() });
    await waitUntilBlockedOnLock(db.pool, tb.pid); // B is parked on the mandate row lock A holds
    await finish(ta.client, 'COMMIT');

    expect(await pendingB).toEqual({ ok: false, reason: 'BUDGET_EXCEEDED', reservedBeforeMinor: A, budgetMinor: BUDGET });
    await finish(tb.client, 'COMMIT');
    expect(await activeReservedTotal(db.pool, fixture.mandateId)).toBe(A);
  });

  it('still refuses B when a writer skips reserveBudget and inserts directly (database backstop)', async () => {
    const fixture = await createMandate(db.pool, BUDGET);
    const [decisionA, decisionB] = [await createDecision(db.pool, fixture, A), await createDecision(db.pool, fixture, B)];
    const insert = (client: PoolClient, decisionId: string, amount: number) =>
      client.query(
        `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at)
         VALUES ($1, $2, $3, 'USD', now() + interval '1 hour')`,
        [fixture.mandateId, decisionId, amount],
      );

    const ta = await begin();
    const tb = await begin();
    await insert(ta.client, decisionA, A);
    const pendingB = insert(tb.client, decisionB, B).then(
      () => 'inserted',
      (error: unknown) => sqlState(error),
    );
    await waitUntilBlockedOnLock(db.pool, tb.pid);
    await finish(ta.client, 'COMMIT');

    expect(await pendingB).toBe(SQLSTATE.BUDGET_EXCEEDED);
    await finish(tb.client, 'ROLLBACK');
    expect(await activeReservedTotal(db.pool, fixture.mandateId)).toBe(A);
  });

  it('also holds for plain concurrent inserts racing freely, 25 times over', async () => {
    for (let round = 0; round < 25; round++) {
      const fixture = await createMandate(db.pool, BUDGET);
      const [decisionA, decisionB] = [await createDecision(db.pool, fixture, A), await createDecision(db.pool, fixture, B)];
      const attempt = (decisionId: string, amount: number) =>
        db.pool
          .query(
            `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at)
             VALUES ($1, $2, $3, 'USD', now() + interval '1 hour')`,
            [fixture.mandateId, decisionId, amount],
          )
          .then(
            () => 'inserted',
            (error: unknown) => sqlState(error),
          );
      const outcomes = await Promise.all([attempt(decisionA, A), attempt(decisionB, B)]);
      expect(outcomes.sort()).toEqual([SQLSTATE.BUDGET_EXCEEDED, 'inserted'].sort());
      expect(await activeReservedTotal(db.pool, fixture.mandateId)).toBeLessThanOrEqual(BUDGET);
    }
  });

  it('negative control: without the lock and the trigger, the same interleaving overspends', async () => {
    // Proves the tests above can fail: a naive read-then-insert lets both requests through.
    const fixture = await createMandate(db.pool, BUDGET);
    const [decisionA, decisionB] = [await createDecision(db.pool, fixture, A), await createDecision(db.pool, fixture, B)];
    await db.pool.query('ALTER TABLE budget_reservation DISABLE TRIGGER budget_reservation_enforce_budget');
    try {
      const naiveCheck = async (client: PoolClient, amount: number) => {
        const { rows } = await client.query<{ total: number }>(
          `SELECT COALESCE(SUM(amount_minor_units), 0)::bigint AS total FROM budget_reservation WHERE mandate_id = $1 AND state IN ('HELD', 'COMMITTED')`,
          [fixture.mandateId],
        );
        return (rows[0]?.total ?? 0) + amount <= BUDGET;
      };
      const naiveInsert = (client: PoolClient, decisionId: string, amount: number) =>
        client.query(
          `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at)
           VALUES ($1, $2, $3, 'USD', now() + interval '1 hour')`,
          [fixture.mandateId, decisionId, amount],
        );

      const ta = await begin();
      const tb = await begin();
      expect(await naiveCheck(ta.client, A)).toBe(true);
      expect(await naiveCheck(tb.client, B)).toBe(true); // B cannot see A's uncommitted intent
      await naiveInsert(ta.client, decisionA, A);
      await naiveInsert(tb.client, decisionB, B);
      await finish(ta.client, 'COMMIT');
      await finish(tb.client, 'COMMIT');

      expect(await activeReservedTotal(db.pool, fixture.mandateId)).toBe(A + B); // 13 000 > 10 000
    } finally {
      await db.pool.query('ALTER TABLE budget_reservation ENABLE TRIGGER budget_reservation_enforce_budget');
    }
  });
});

describe('reservation rules', () => {
  let fixture: MandateFixture;

  beforeAll(async () => {
    fixture = await createMandate(db.pool, BUDGET);
  });

  it('frees budget when a hold is released, and keeps it when the hold is committed', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const first = await withTransaction(db.pool, async (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: await createDecision(c, f, A), amount: usd(A), expiresAt: inOneHour() }),
    );
    if (!first.ok) throw new Error('setup failed');
    await db.pool.query(`UPDATE budget_reservation SET state = 'RELEASED', released_at = now() WHERE id = $1`, [first.reservationId]);

    const secondRows = await createDecisionRows(db.pool, f, B);
    const second = await withTransaction(db.pool, async (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: secondRows.decisionId, amount: usd(B), expiresAt: inOneHour() }),
    );
    if (!second.ok) throw new Error('release did not free the budget');
    await captureOrder(db.pool, await placeOrder(db.pool, secondRows, B), B);

    const third = await withTransaction(db.pool, async (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: await createDecision(c, f, 5_000), amount: usd(5_000), expiresAt: inOneHour() }),
    );
    expect(third).toEqual({ ok: false, reason: 'BUDGET_EXCEEDED', reservedBeforeMinor: B, budgetMinor: BUDGET });
  });

  it('accepts a reservation that lands exactly on the budget', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const result = await withTransaction(db.pool, async (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: await createDecision(c, f, BUDGET), amount: usd(BUDGET), expiresAt: inOneHour() }),
    );
    expect(result.ok).toBe(true);
  });

  it('reports a missing mandate and a currency mismatch as values', async () => {
    const decision = await createDecision(db.pool, fixture, 100);
    await withTransaction(db.pool, async (c) => {
      expect(
        await reserveBudget(c, { mandateId: '00000000-0000-4000-8000-00000000dead', policyDecisionId: decision, amount: usd(100), expiresAt: inOneHour() }),
      ).toEqual({ ok: false, reason: 'MANDATE_NOT_FOUND' });
      expect(
        await reserveBudget(c, { mandateId: fixture.mandateId, policyDecisionId: decision, amount: { amountMinor: 100, currency: 'EUR' }, expiresAt: inOneHour() }),
      ).toEqual({ ok: false, reason: 'CURRENCY_MISMATCH' });
    });
  });

  it('rejects float or negative amounts before touching the database', async () => {
    const decision = await createDecision(db.pool, fixture, 100);
    await withTransaction(db.pool, async (c) => {
      await expect(reserveBudget(c, { mandateId: fixture.mandateId, policyDecisionId: decision, amount: usd(10.5), expiresAt: inOneHour() })).rejects.toThrow();
      await expect(reserveBudget(c, { mandateId: fixture.mandateId, policyDecisionId: decision, amount: usd(-1), expiresAt: inOneHour() })).rejects.toThrow();
    });
  });

  it.each([
    ['a reservation that has already expired', `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, 1, 'USD', now() - interval '1 second')`, SQLSTATE.ILLEGAL_RESERVATION_CHANGE],
    ['a direct insert in another currency', `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, 1, 'EUR', now() + interval '1 hour')`, SQLSTATE.CURRENCY_MISMATCH],
    ['a reservation that starts COMMITTED', `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, state, committed_at, expires_at) VALUES ($1, $2, 1, 'USD', 'COMMITTED', now(), now() + interval '1 hour')`, SQLSTATE.ILLEGAL_RESERVATION_CHANGE],
  ])('refuses %s', async (_label, sql, code) => {
    const decision = await createDecision(db.pool, fixture, 1);
    await expect(db.pool.query(sql, [fixture.mandateId, decision])).rejects.toMatchObject({ code });
  });

  it('refuses REPEATABLE READ, whose snapshot would hide concurrent holds', async () => {
    const decision = await createDecision(db.pool, fixture, 1);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(
        client.query(`INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, 1, 'USD', now() + interval '1 hour')`, [
          fixture.mandateId,
          decision,
        ]),
      ).rejects.toMatchObject({ code: SQLSTATE.UNSUPPORTED_ISOLATION });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('forbids changing amount, reviving a finished hold, or deleting one', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const rows = await createDecisionRows(db.pool, f, 100);
    const result = await withTransaction(db.pool, async (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: usd(100), expiresAt: inOneHour() }),
    );
    if (!result.ok) throw new Error('setup failed');
    const id = result.reservationId;
    await expect(db.pool.query('UPDATE budget_reservation SET amount_minor_units = 1 WHERE id = $1', [id])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_RESERVATION_CHANGE,
    });
    await captureOrder(db.pool, await placeOrder(db.pool, rows, 100), 100);
    await expect(db.pool.query(`UPDATE budget_reservation SET state = 'HELD', committed_at = NULL, committed_amount_minor_units = NULL WHERE id = $1`, [id])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_RESERVATION_CHANGE,
    });
    await expect(db.pool.query('DELETE FROM budget_reservation WHERE id = $1', [id])).rejects.toMatchObject({ code: SQLSTATE.APPEND_ONLY });
  });

  it('will not lower a mandate budget below what is already reserved', async () => {
    const f = await createMandate(db.pool, BUDGET);
    await withTransaction(db.pool, async (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: await createDecision(c, f, A), amount: usd(A), expiresAt: inOneHour() }),
    );
    await expect(db.pool.query('UPDATE mandate SET budget_minor_units = $2 WHERE id = $1', [f.mandateId, A - 1])).rejects.toMatchObject({
      code: SQLSTATE.BUDGET_EXCEEDED,
    });
    await db.pool.query('UPDATE mandate SET budget_minor_units = $2 WHERE id = $1', [f.mandateId, A]);
    await expect(db.pool.query(`UPDATE mandate SET currency = 'EUR' WHERE id = $1`, [f.mandateId])).rejects.toMatchObject({
      code: SQLSTATE.CURRENCY_MISMATCH,
    });
  });
});

describe('isolation levels (review finding H1)', () => {
  async function inIsolation(level: 'REPEATABLE READ' | 'SERIALIZABLE', work: (client: PoolClient) => Promise<unknown>): Promise<string | undefined> {
    const client = await db.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${level}`);
      await client.query('SELECT 1'); // take the snapshot, as a real transaction would have by now
      await work(client);
      await client.query('COMMIT');
      return undefined;
    } catch (error) {
      await client.query('ROLLBACK');
      return sqlState(error);
    } finally {
      client.release();
    }
  }

  it.each(['REPEATABLE READ', 'SERIALIZABLE'] as const)('refuses to lower a budget under %s, even when a stale snapshot hides a hold', async (level) => {
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, A);
    const client = await db.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${level}`);
      await client.query('SELECT 1'); // snapshot taken before the hold below commits
      await withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: decision, amount: usd(A), expiresAt: inOneHour() }));
      await expect(client.query('UPDATE mandate SET budget_minor_units = 5000 WHERE id = $1', [f.mandateId])).rejects.toMatchObject({
        code: SQLSTATE.UNSUPPORTED_ISOLATION,
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const { rows } = await db.pool.query<{ budget_minor_units: number }>('SELECT budget_minor_units FROM mandate WHERE id = $1', [f.mandateId]);
    expect(rows[0]?.budget_minor_units).toBe(BUDGET);
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(A);
  });

  it('still allows raising a budget under any isolation level (it cannot break the invariant)', async () => {
    const f = await createMandate(db.pool, BUDGET);
    expect(await inIsolation('SERIALIZABLE', (c) => c.query('UPDATE mandate SET budget_minor_units = 20000 WHERE id = $1', [f.mandateId]))).toBeUndefined();
  });

  it('refuses a reservation under SERIALIZABLE as well as REPEATABLE READ', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, 1);
    const code = await inIsolation('SERIALIZABLE', (c) =>
      c.query(`INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, 1, 'USD', now() + interval '1 hour')`, [
        f.mandateId,
        decision,
      ]),
    );
    expect(code).toBe(SQLSTATE.UNSUPPORTED_ISOLATION);
  });

  it('serializes a budget cut against a concurrent hold under READ COMMITTED (forced interleaving)', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, A);
    const holder = await begin();
    const cutter = await begin();
    await reserveBudget(holder.client, { mandateId: f.mandateId, policyDecisionId: decision, amount: usd(A), expiresAt: inOneHour() });
    const pendingCut = cutter.client.query('UPDATE mandate SET budget_minor_units = 5000 WHERE id = $1', [f.mandateId]).then(
      () => 'updated',
      (error: unknown) => sqlState(error),
    );
    await waitUntilBlockedOnLock(db.pool, cutter.pid);
    await finish(holder.client, 'COMMIT');
    expect(await pendingCut).toBe(SQLSTATE.BUDGET_EXCEEDED);
    await finish(cutter.client, 'ROLLBACK');
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(A);
  });
});

describe('trigger name resolution (review finding H2)', () => {
  it('ignores temp tables that shadow mandate and budget_reservation', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const [first, second] = [await createDecision(db.pool, f, A), await createDecision(db.pool, f, A)];
    await withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: first, amount: usd(A), expiresAt: inOneHour() }));

    const client = await db.pool.connect();
    try {
      // Temp tables live only on this session; pg_temp is searched first by default.
      await client.query('CREATE TEMP TABLE budget_reservation (mandate_id uuid, amount_minor_units bigint, state text)');
      await client.query('CREATE TEMP TABLE mandate (id uuid, budget_minor_units bigint, currency text)');
      await client.query(`INSERT INTO pg_temp.mandate VALUES ($1, 999999999, 'USD')`, [f.mandateId]);
      await expect(
        client.query(
          `INSERT INTO public.budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at)
           VALUES ($1, $2, $3, 'USD', now() + interval '1 hour')`,
          [f.mandateId, second, A],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE.BUDGET_EXCEEDED });
    } finally {
      await client.query('DROP TABLE IF EXISTS pg_temp.budget_reservation, pg_temp.mandate');
      client.release();
    }
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(A);
  });

  it('pins search_path on every function the migrations define', async () => {
    const { rows } = await db.pool.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'admin_create_mandate',
      'admin_remove_category_limit',
      'admin_set_category_limit',
      'admin_set_user_role',
      'admin_update_mandate',
      'audit_mandate_change',
      'audit_subject_organization',
      'audit_user_role',
      'enforce_approval',
      'enforce_approval_lifecycle',
      'enforce_audit_tenancy',
      'enforce_budget_reservation',
      'enforce_cart_item',
      'enforce_mandate_approver',
      'enforce_mandate_budget',
      'enforce_order_event',
      'enforce_purchase_order',
      'enforce_purchase_order_update',
      'enforce_refund',
      'enforce_user_role',
      'forbid_mutation',
      'mandate_active_total',
      'mandate_admin_authorize',
      'order_transition_allowed',
      'require_read_committed',
      'set_updated_at',
      'stamp_insert_time',
    ]);
    for (const row of rows) expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, pg_temp']);
  });
});

describe('connection loss (review finding M1)', () => {
  it('turns a connection killed mid-transaction into a rejected promise, not a crash, and keeps the pool usable', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const before = db.pool.totalCount;
    const attempt = withTransaction(db.pool, async (client) => {
      // pg-pool drops its own error handling while a client is checked out; withTransaction must add one.
      expect(client.listenerCount('error')).toBeGreaterThan(0);
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await db.pool.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
      // Give pg time to emit 'error' on this idle-in-transaction client before the next statement.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return client.query('SELECT 1 FROM mandate WHERE id = $1', [f.mandateId]);
    });
    await expect(attempt).rejects.toThrow();
    // The broken client was destroyed, not returned: the pool still answers on a fresh connection.
    const { rows } = await db.pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
    expect(db.pool.totalCount).toBeLessThanOrEqual(before + 1);
  });
});

describe('actual spend and the reservation lifecycle (review findings M4 of the first review, H1 and H2 of the second)', () => {
  const hold = async (f: MandateFixture, decisionTotal: number, amount: number) => {
    const rows = await createDecisionRows(db.pool, f, decisionTotal);
    const result = await withTransaction(db.pool, (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: usd(amount), expiresAt: inOneHour() }),
    );
    if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
    return { ...rows, reservationId: result.reservationId };
  };
  const commit = (id: string, captured: number) =>
    db.pool.query(`UPDATE budget_reservation SET state = 'COMMITTED', committed_amount_minor_units = $2 WHERE id = $1`, [id, captured]);
  const release = (id: string) => db.pool.query(`UPDATE budget_reservation SET state = 'RELEASED' WHERE id = $1`, [id]);
  const setOrder = (id: string, state: string) => db.pool.query('UPDATE purchase_order SET state = $2 WHERE id = $1', [id, state]);

  it('counts what was captured, not what was held, once a hold commits', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const h = await hold(f, 7_000, 7_140); // decision total plus a 2% drift allowance
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(7_140);
    await captureOrder(db.pool, await placeOrder(db.pool, h, 7_050), 7_050); // the price rose a little, within the hold
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(7_050);
    // The unused 90 is available again: 10000 - 7050 = 2950 fits exactly.
    const next = await createDecisionRows(db.pool, f, 2_950);
    const result = await withTransaction(db.pool, (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: next.decisionId, amount: usd(2_950), expiresAt: inOneHour() }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses to commit spend with no order, no capture, or an amount other than the capture (H2)', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const h = await hold(f, 1_000, 1_000);
    await expect(commit(h.reservationId, 0)).rejects.toMatchObject({ code: SQLSTATE.CAPTURE_EVIDENCE }); // no order at all
    const orderId = await placeOrder(db.pool, h, 1_000);
    await expect(commit(h.reservationId, 1_000)).rejects.toMatchObject({ code: SQLSTATE.CAPTURE_EVIDENCE }); // order not captured
    await captureOrder(db.pool, orderId, 1_000);
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(1_000);
    await expect(db.pool.query('UPDATE budget_reservation SET committed_amount_minor_units = 1 WHERE id = $1', [h.reservationId])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_RESERVATION_CHANGE,
    });
  });

  it('refuses a commit for another amount than PayPal captured, or above the hold', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const h = await hold(f, 1_000, 1_000);
    const orderId = await placeOrder(db.pool, h, 1_000);
    await db.pool.query(
      `UPDATE purchase_order SET state = 'CAPTURED', provider_order_id = 'PO-1', provider_capture_id = 'CAP-1', capture_status = 'COMPLETED',
              captured_amount_minor_units = 1000, captured_currency = 'USD' WHERE id = $1`,
      [orderId],
    );
    await expect(commit(h.reservationId, 990)).rejects.toMatchObject({ code: SQLSTATE.CAPTURE_EVIDENCE });
    // Above the hold: the capture can never exceed the hold (order <= hold, capture = order), so the evidence rule
    // answers first; the 0004 CHECK stays behind it.
    await expect(commit(h.reservationId, 1_001)).rejects.toMatchObject({ code: SQLSTATE.CAPTURE_EVIDENCE });
    await commit(h.reservationId, 1_000);
  });

  it.each(['PAYMENT_PENDING', 'UNKNOWN_OUTCOME'])('keeps a hold while its order is %s, and releases it once the order FAILED', async (state) => {
    const f = await createMandate(db.pool, BUDGET);
    const h = await hold(f, 1_000, 1_000);
    const orderId = await placeOrder(db.pool, h, 1_000);
    if (state !== 'PAYMENT_PENDING') await setOrder(orderId, state);
    await expect(release(h.reservationId)).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_RESERVATION_CHANGE });
    await setOrder(orderId, 'FAILED');
    await release(h.reservationId);
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(0);
  });

  it('keeps captured spend on the books: the second review\'s H1 bypasses are all refused', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const h = await hold(f, 5_000, 5_000);
    // 1. An order cannot be born CAPTURED, with or without PayPal ids.
    await expect(
      db.pool.query(
        `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, idempotency_key, payment_variant, amount_minor_units, currency, state)
         VALUES ($1, $2, 'born-captured-0001', 'APPROVAL_LINK', 5000, 'USD', 'CAPTURED')`,
        [h.requestId, h.decisionId],
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_ORDER_CHANGE });
    const orderId = await placeOrder(db.pool, h, 5_000);
    // 2. CAPTURED without evidence.
    await expect(setOrder(orderId, 'CAPTURED')).rejects.toMatchObject({ code: SQLSTATE.CAPTURE_EVIDENCE });
    await captureOrder(db.pool, orderId, 5_000);
    // 3. Back from CAPTURED to PAYMENT_PENDING, or straight to FAILED.
    await expect(setOrder(orderId, 'PAYMENT_PENDING')).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_ORDER_CHANGE });
    await expect(setOrder(orderId, 'FAILED')).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_ORDER_CHANGE });
    // 4. Rewriting the evidence.
    await expect(db.pool.query(`UPDATE purchase_order SET captured_amount_minor_units = 0 WHERE id = $1`, [orderId])).rejects.toMatchObject({
      code: SQLSTATE.CAPTURE_EVIDENCE,
    });
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(5_000);
  });

  it('never releases the hold of a captured order, and a captured order can never become FAILED (decision 4)', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const h = await hold(f, 2_000, 2_000);
    const orderId = await placeOrder(db.pool, h, 2_000);
    // Capture recorded on the order but the hold not yet committed (e.g. a crash between the two writes).
    await db.pool.query(
      `UPDATE purchase_order SET state = 'CAPTURED', provider_order_id = 'PO-2', provider_capture_id = 'CAP-2', capture_status = 'COMPLETED',
              captured_amount_minor_units = 2000, captured_currency = 'USD' WHERE id = $1`,
      [orderId],
    );
    for (const state of ['FAILED', 'REFUND_REQUESTED', 'REFUNDED']) {
      await expect(setOrder(orderId, state)).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_ORDER_CHANGE });
    }
    await expect(release(h.reservationId)).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_RESERVATION_CHANGE });
    await commit(h.reservationId, 2_000);
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(2_000);
  });

  it('refuses to fund a new order from an expired hold, and freezes a finished hold (L1)', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const h = await hold(f, 300, 300);
    await db.pool.query(`UPDATE budget_reservation SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.reservationId]);
    await expect(placeOrder(db.pool, h, 300)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await release(h.reservationId);
    await expect(db.pool.query(`UPDATE budget_reservation SET expires_at = now() + interval '1 day' WHERE id = $1`, [h.reservationId])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_RESERVATION_CHANGE,
    });
    await expect(db.pool.query(`UPDATE budget_reservation SET released_at = now() - interval '1 year' WHERE id = $1`, [h.reservationId])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_RESERVATION_CHANGE,
    });
  });
});

describe('order versus release race (second review finding H3)', () => {
  it('makes a release wait for an in-flight order insert, then refuses it', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const rows = await createDecisionRows(db.pool, f, 1_000);
    const held = await withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: usd(1_000), expiresAt: inOneHour() }));
    if (!held.ok) throw new Error('setup failed');

    const t1 = await begin();
    await placeOrder(t1.client, rows, 1_000); // locks the hold, uncommitted
    const t2 = await begin();
    const releasing = t2.client.query(`UPDATE budget_reservation SET state = 'RELEASED' WHERE id = $1`, [held.reservationId]).then(
      () => undefined,
      (error: unknown) => sqlState(error),
    );
    await waitUntilBlockedOnLock(db.pool, t2.pid);
    await finish(t1.client, 'COMMIT');
    expect(await releasing).toBe(SQLSTATE.ILLEGAL_RESERVATION_CHANGE);
    await finish(t2.client, 'ROLLBACK');
    const { rows: state } = await db.pool.query<{ state: string }>('SELECT state FROM budget_reservation WHERE id = $1', [held.reservationId]);
    expect(state[0]?.state).toBe('HELD');
  });

  it('makes an order insert wait for an in-flight release, then refuses the order', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const rows = await createDecisionRows(db.pool, f, 1_000);
    const held = await withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: usd(1_000), expiresAt: inOneHour() }));
    if (!held.ok) throw new Error('setup failed');

    const t1 = await begin();
    await t1.client.query(`UPDATE budget_reservation SET state = 'RELEASED' WHERE id = $1`, [held.reservationId]);
    const t2 = await begin();
    const ordering = placeOrder(t2.client, rows, 1_000).then(
      () => undefined,
      (error: unknown) => sqlState(error),
    );
    await waitUntilBlockedOnLock(db.pool, t2.pid);
    await finish(t1.client, 'COMMIT');
    expect(await ordering).toBe(SQLSTATE.MISMATCHED_ROW);
    await finish(t2.client, 'ROLLBACK');
    const { rows: orders } = await db.pool.query('SELECT 1 FROM purchase_order WHERE policy_decision_id = $1', [rows.decisionId]);
    expect(orders).toEqual([]);
  });
});

describe('reservations match their decision (review findings M3, L9)', () => {
  const insert = (mandateId: string, decisionId: string, amount: number) =>
    db.pool.query(
      `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, $3, 'USD', now() + interval '1 hour')`,
      [mandateId, decisionId, amount],
    );

  it('refuses a hold on another mandate, below the decision total, or for a DENY decision', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const other = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, 9_000);
    await expect(insert(other.mandateId, decision, 9_000)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await expect(insert(f.mandateId, decision, 1)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    const denied = await createDecisionRows(db.pool, f, 100, { outcome: 'DENY' });
    await expect(insert(f.mandateId, denied.decisionId, 100)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await insert(f.mandateId, decision, 9_000);
  });

  it.each([
    ['PAUSED', `UPDATE mandate SET status = 'PAUSED' WHERE id = $1`],
    ['not started yet', `UPDATE mandate SET starts_at = now() + interval '1 day', ends_at = now() + interval '2 days' WHERE id = $1`],
    ['already ended', `UPDATE mandate SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1`],
  ])('refuses holds on a mandate that is %s, in the database and in reserveBudget', async (_label, sql) => {
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, 100);
    await db.pool.query(sql, [f.mandateId]);
    await expect(insert(f.mandateId, decision, 100)).rejects.toMatchObject({ code: SQLSTATE.MANDATE_INACTIVE });
    const result = await withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: decision, amount: usd(100), expiresAt: inOneHour() }));
    expect(result).toEqual({ ok: false, reason: 'MANDATE_INACTIVE' });
  });
});

describe('idempotent reservations and ambiguous COMMIT (second review findings M3, L9)', () => {
  const reserve = (f: MandateFixture, decisionId: string, amount: number, currency = 'USD') =>
    withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: decisionId, amount: { amountMinor: amount, currency }, expiresAt: inOneHour() }));

  it('answers a retry for the same decision with the existing hold, and refuses a conflicting one as a value', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, 1_000);
    const first = await reserve(f, decision, 1_000);
    if (!first.ok || !first.created) throw new Error('setup failed');
    expect(await reserve(f, decision, 1_000)).toEqual({ ok: true, created: false, reservationId: first.reservationId, state: 'HELD' });
    expect(await reserve(f, decision, 1_200)).toEqual({ ok: false, reason: 'DECISION_ALREADY_RESERVED', reservationId: first.reservationId });
    await db.pool.query(`UPDATE budget_reservation SET state = 'RELEASED' WHERE id = $1`, [first.reservationId]);
    expect(await reserve(f, decision, 1_000)).toEqual({ ok: false, reason: 'RESERVATION_RELEASED', reservationId: first.reservationId });
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(0);
  });

  it('reports DENY, foreign, short and missing decisions as values, not errors', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const other = await createMandate(db.pool, BUDGET);
    const denied = await createDecisionRows(db.pool, f, 100, { outcome: 'DENY' });
    expect(await reserve(f, denied.decisionId, 100)).toEqual({ ok: false, reason: 'DECISION_NOT_RESERVABLE' });
    expect(await reserve(f, await createDecision(db.pool, other, 100), 100)).toEqual({ ok: false, reason: 'DECISION_NOT_RESERVABLE' });
    expect(await reserve(f, await createDecision(db.pool, f, 100), 99)).toEqual({ ok: false, reason: 'DECISION_NOT_RESERVABLE' });
    expect(await reserve(f, '00000000-0000-4000-8000-00000000beef', 100)).toEqual({ ok: false, reason: 'DECISION_NOT_FOUND' });
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(0);
  });

  it('settles five concurrent reservations of one decision into one hold', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, 1_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => reserve(f, decision, 1_000)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => (r.ok ? r.reservationId : '')))).toHaveProperty('size', 1);
    expect(await reservationCount(f.mandateId)).toBe(1);
  });

  it('throws CommitOutcomeUnknownError, not the raw error, when the connection dies during COMMIT', async () => {
    // A deferred constraint trigger runs at COMMIT time; its sleep gives the test a window to kill the backend there.
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS commit_probe (id int);
      CREATE OR REPLACE FUNCTION slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NULL; END $$;
      DROP TRIGGER IF EXISTS commit_probe_slow ON commit_probe;
      CREATE CONSTRAINT TRIGGER commit_probe_slow AFTER INSERT ON commit_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slow_commit();`);
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, 1_000);
    let pid = 0;
    const attempt = withTransaction(db.pool, async (c) => {
      pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
      const result = await reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: decision, amount: usd(1_000), expiresAt: inOneHour() });
      await c.query('INSERT INTO commit_probe VALUES (1)');
      return result;
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await db.pool.query<{ query: string }>(`SELECT query FROM pg_stat_activity WHERE pid = $1 AND state = 'active'`, [pid]);
      if (rows[0]?.query === 'COMMIT') break;
      if (Date.now() > deadline) throw new Error('COMMIT never started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await db.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await expect(attempt).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    await db.pool.query('DROP TABLE commit_probe; DROP FUNCTION slow_commit()');

    // Here the server rolled back, so the retry the error tells callers to make creates the hold now; had the COMMIT
    // landed, the same retry would return it with created=false (first test of this block).
    const retry = await reserve(f, decision, 1_000);
    expect(retry).toMatchObject({ ok: true, created: true });
    expect(await reserve(f, decision, 1_000)).toMatchObject({ ok: true, created: false });
    expect(await reservationCount(f.mandateId)).toBe(1);
  });

  it('rethrows the server\'s own COMMIT error unchanged: that outcome is known (rolled back)', async () => {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS deferred_probe (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
    const attempt = withTransaction(db.pool, async (c) => {
      await c.query('INSERT INTO deferred_probe VALUES (1), (1)');
    });
    await expect(attempt).rejects.toMatchObject({ code: SQLSTATE.UNIQUE_VIOLATION });
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM deferred_probe');
    expect(rows[0]).toEqual({ n: 0 });
    await db.pool.query('DROP TABLE deferred_probe');
  });
});

describe('pooled session hygiene (second review finding L7)', () => {
  it('resets session settings before a client goes back to the pool', async () => {
    // One connection, so the second transaction is guaranteed to reuse the first one's session.
    const pool = createPool({ ...db.config, poolMax: 1 }, { applicationName: 'mandate-test-l7' });
    try {
      const firstPid = await withTransaction(pool, async (c) => {
        await c.query(`SELECT set_config('mandate.leak', 'from-previous-borrower', false)`);
        await c.query('SET search_path = pg_temp');
        return (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      });
      const seen = await withTransaction(pool, async (c) => {
        const { rows } = await c.query<{ pid: number; leak: string | null; path: string }>(
          `SELECT pg_backend_pid() AS pid, current_setting('mandate.leak', true) AS leak, current_setting('search_path') AS path`,
        );
        return rows[0];
      });
      expect(seen?.pid).toBe(firstPid);
      expect(seen?.leak ?? '').toBe('');
      expect(seen?.path).toBe('"$user", public');
    } finally {
      await pool.end();
    }
  });

  it('sets an idle-in-transaction timeout and keeps statement_timeout after the reset', async () => {
    const values = await withTransaction(db.pool, async (c) => {
      await c.query(`SET statement_timeout = '1s'`);
      return null;
    }).then(() =>
      withTransaction(db.pool, async (c) =>
        (await c.query<{ idle: string; statement: string }>(`SELECT current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('statement_timeout') AS statement`))
          .rows[0],
      ),
    );
    expect(values).toEqual({ idle: '1min', statement: '30s' });
  });
});

describe('order versus release under snapshot isolation (third review finding H1)', () => {
  it.each(['REPEATABLE READ', 'SERIALIZABLE'])('refuses to release or commit a hold, or create an order, under %s', async (level) => {
    const f = await createMandate(db.pool, BUDGET);
    const rows = await createDecisionRows(db.pool, f, 1_000);
    const held = await withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: usd(1_000), expiresAt: inOneHour() }));
    if (!held.ok) throw new Error('setup failed');
    const attempt = async (sql: string, params: unknown[]) => {
      const client = await db.pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${level}`);
        await client.query('SELECT 1 FROM purchase_order LIMIT 1'); // take the snapshot first, as the attack does
        return await client.query(sql, params).then(
          () => 'accepted',
          (error: unknown) => sqlState(error),
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    expect(await attempt(`UPDATE budget_reservation SET state = 'RELEASED' WHERE id = $1`, [held.reservationId])).toBe(SQLSTATE.UNSUPPORTED_ISOLATION);
    expect(await attempt(`UPDATE budget_reservation SET state = 'COMMITTED', committed_amount_minor_units = 1000 WHERE id = $1`, [held.reservationId])).toBe(
      SQLSTATE.UNSUPPORTED_ISOLATION,
    );
    expect(
      await attempt(
        `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, idempotency_key, payment_variant, amount_minor_units, currency)
         VALUES ($1, $2, 'snapshot-order-0001', 'APPROVAL_LINK', 1000, 'USD')`,
        [rows.requestId, rows.decisionId],
      ),
    ).toBe(SQLSTATE.UNSUPPORTED_ISOLATION);
  });

  it('replays the reported attack: a REPEATABLE READ releaser after a committed order is refused, the hold stays', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const rows = await createDecisionRows(db.pool, f, 1_000);
    const held = await withTransaction(db.pool, (c) => reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: usd(1_000), expiresAt: inOneHour() }));
    if (!held.ok) throw new Error('setup failed');
    const releaser = await db.pool.connect();
    try {
      await releaser.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await releaser.query('SELECT count(*) FROM purchase_order');
      await placeOrder(db.pool, rows, 1_000); // commits in its own READ COMMITTED transaction
      await expect(releaser.query(`UPDATE budget_reservation SET state = 'RELEASED' WHERE id = $1`, [held.reservationId])).rejects.toMatchObject({
        code: SQLSTATE.UNSUPPORTED_ISOLATION,
      });
    } finally {
      await releaser.query('ROLLBACK');
      releaser.release();
    }
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBe(1_000);
  });
});

describe('a COMMIT the server answers with ROLLBACK (third review finding M2)', () => {
  it('throws TransactionRolledBackError instead of reporting success when work swallowed a statement error', async () => {
    const f = await createMandate(db.pool, BUDGET);
    const decision = await createDecision(db.pool, f, 100);
    const attempt = withTransaction(db.pool, async (c) => {
      await reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: decision, amount: usd(100), expiresAt: inOneHour() });
      await c.query('SELECT 1 / 0').catch(() => undefined); // a caller bug: the error is swallowed, the transaction is aborted
      return 'reported success';
    });
    await expect(attempt).rejects.toBeInstanceOf(TransactionRolledBackError);
    expect(await reservationCount(f.mandateId)).toBe(0);
  });
});
