import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, MandateSchema } from '@mandate/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { toBigInt } from '../src/db/db.js';
import { checksum, loadMigrations, migrate, MigrationError, type Migration } from '../src/db/migrate.js';
import { commitReservation, releaseReservation, reserveBudget } from '../src/db/reservations.js';
import { DEMO_IDS, seed } from '../src/db/seed.js';
import { createTestDb } from './helpers/pglite.js';

const migrations = loadMigrations();
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db, migrations);
  await seed(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** Runs a statement that must fail inside its own transaction, so the failure does not poison later tests. */
async function rejects(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.transaction((tx) => tx.query(sql, params));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`Expected failure: ${sql}`);
}

let counter = 0;
/** Creates a purchase request and policy decision so a reservation has something to hang on. */
async function decision(): Promise<string> {
  counter += 1;
  const request = await db.query<{ id: string }>(
    'INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key) VALUES ($1, $2, $3, $4) RETURNING id',
    [DEMO_IDS.mandate, DEMO_IDS.requester, 'need pens', `req-key-${counter}-${Date.now()}`],
  );
  const result = await db.query<{ id: string }>(
    `INSERT INTO policy_decision (purchase_request_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
     VALUES ($1, 'ALLOW', '[]'::jsonb, '0.1.0', 0, 'USD', now()) RETURNING id`,
    [request.rows[0]?.id],
  );
  return result.rows[0]?.id ?? '';
}

describe('migrations', () => {
  it('applies every shipped migration in order and records its checksum', async () => {
    expect(migrations[0]?.version).toBe('0001');
    const { rows } = await db.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    expect(rows).toEqual(migrations.map((m) => ({ version: m.version, checksum: m.checksum })));
  });

  it('is a no-op the second time', async () => {
    expect(await migrate(db, migrations)).toEqual([]);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const edited = migrations.map((m) => ({ ...m, checksum: checksum(`${m.sql}\n-- edited`) }));
    await expect(migrate(db, edited)).rejects.toThrow('Applied migration 0001 was edited');
  });

  it('refuses to run when an applied migration is missing locally', async () => {
    await expect(migrate(db, [])).rejects.toThrow(MigrationError);
  });

  it('applies new migrations in order and rolls back all of them if one fails', async () => {
    const fresh = await createTestDb();
    try {
      const extra: Migration[] = [
        { version: '9001', name: 'ok', sql: 'CREATE TABLE t2 (id int);', checksum: 'a' },
        { version: '9002', name: 'bad', sql: 'CREATE TABLE t3 (id nonsense_type);', checksum: 'b' },
      ];
      await expect(migrate(fresh, [...migrations, ...extra])).rejects.toThrow();
      const { rows } = await fresh.query("SELECT to_regclass('organization') AS t");
      expect(rows).toEqual([{ t: null }]);
      expect(await migrate(fresh, [...migrations, extra[0]!])).toEqual([...migrations.map((m) => m.version), '9001']);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it('treats CRLF and LF checkouts as the same migration', () => {
    expect(checksum('a;\r\nb;\r\n')).toBe(checksum('a;\nb;\n'));
  });

  it.each([
    ['a bad file name', ['1_init.sql']],
    ['a duplicate version', ['0001_a.sql', '0001_b.sql']],
  ])('rejects %s', (_label, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    for (const file of files) writeFileSync(join(dir, file), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
  });
});

describe('schema constraints', () => {
  it('rejects a cart whose total is not subtotal + shipping + tax', async () => {
    const request = await db.query<{ id: string }>(
      'INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key) VALUES ($1, $2, $3, $4) RETURNING id',
      [DEMO_IDS.mandate, DEMO_IDS.requester, 'cart test', 'cart-total-check-1'],
    );
    const message = await rejects(
      "INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, shipping_minor_units, tax_minor_units, total_minor_units, quoted_at) VALUES ($1, 'USD', 1000, 100, 10, 1, now())",
      [request.rows[0]?.id],
    );
    expect(message).toMatch(/check constraint/);
  });

  it('rejects a snapshot that skipped quarantine', async () => {
    const message = await rejects(
      `INSERT INTO product_snapshot (purchase_request_id, provider, external_product_id, title, category, unit_price_minor_units, currency, raw_payload, text_quarantined, fetched_at)
       SELECT id, 'channel3', 'x', 't', 'office-supplies', 100, 'USD', '{}'::jsonb, false, now() FROM purchase_request LIMIT 1`,
    );
    expect(message).toMatch(/check constraint/);
  });

  it.each([
    ['a lowercase currency', "UPDATE mandate SET currency = 'usd'"],
    ['a negative budget', 'UPDATE mandate SET budget_minor_units = -1'],
    ['an end before the start', 'UPDATE mandate SET ends_at = starts_at'],
    ['a free-text category', "UPDATE category_limit SET category = 'Gift Cards!'"],
    ['an unknown mandate status', "UPDATE mandate SET status = 'MAYBE'"],
  ])('rejects %s', async (_label, sql) => {
    expect(await rejects(sql)).toMatch(/check constraint/);
  });

  it('dedupes request keys and webhook events in the database', async () => {
    expect(
      await rejects(
        'INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key) VALUES ($1, $2, $3, $4)',
        [DEMO_IDS.mandate, DEMO_IDS.requester, 'again', 'cart-total-check-1'],
      ),
    ).toMatch(/unique/);
    const insert =
      "INSERT INTO webhook_event (provider, provider_event_id, event_type, payload, signature_verified) VALUES ('paypal', 'WH-1', 'PAYMENT.CAPTURE.COMPLETED', '{}'::jsonb, true)";
    await db.query(insert);
    expect(await rejects(insert)).toMatch(/unique/);
  });

  it('keeps audit_log append-only for update, delete and truncate', async () => {
    await db.query("INSERT INTO audit_log (organization_id, actor_type, action, subject_type) VALUES ($1, 'system', 'test', 'mandate')", [
      DEMO_IDS.organization,
    ]);
    for (const sql of ["UPDATE audit_log SET action = 'erased'", 'DELETE FROM audit_log', 'TRUNCATE audit_log']) {
      expect(await rejects(sql)).toMatch(/append-only/);
    }
    const { rows } = await db.query<{ n: unknown }>('SELECT count(*) AS n FROM audit_log');
    expect(toBigInt(rows[0]?.n)).toBe(1n);
  });

  it('keeps order_event append-only', async () => {
    // Row triggers only fire on rows that exist, so create an order with one event first.
    const decisionId = await decision();
    const order = await db.query<{ id: string }>(
      `INSERT INTO payment_order (purchase_request_id, policy_decision_id, idempotency_key, state, payment_variant, amount_minor_units, currency)
       SELECT purchase_request_id, id, 'order-key-append-only', 'PAYMENT_PENDING', 'APPROVAL_LINK', 1000, 'USD'
         FROM policy_decision WHERE id = $1 RETURNING id`,
      [decisionId],
    );
    await db.query("INSERT INTO order_event (order_id, event_type, to_state, occurred_at) VALUES ($1, 'created', 'PAYMENT_PENDING', now())", [
      order.rows[0]?.id,
    ]);
    for (const sql of ["UPDATE order_event SET event_type = 'x'", 'DELETE FROM order_event', 'TRUNCATE order_event']) {
      expect(await rejects(sql)).toMatch(/append-only/);
    }
  });
});

describe('budget reservations', () => {
  const expiresAt = new Date('2026-11-05T00:00:00Z');
  const reserve = async (amountMinor: number, currency = 'USD', mandateId: string = DEMO_IDS.mandate) => {
    const policyDecisionId = await decision();
    return db.transaction((tx) => reserveBudget(tx, { mandateId, policyDecisionId, amountMinor, currency, expiresAt }));
  };

  it('holds budget up to the limit and refuses the next unit', async () => {
    const held = await reserve(60_000);
    expect(held.ok).toBe(true);
    expect(await reserve(40_001)).toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
    const last = await reserve(40_000);
    expect(last.ok).toBe(true);

    // Releasing frees budget; committing keeps it counted.
    if (!held.ok || !last.ok) throw new Error('unreachable');
    expect(await db.transaction((tx) => releaseReservation(tx, held.reservationId, new Date()))).toBe(true);
    expect(await db.transaction((tx) => releaseReservation(tx, held.reservationId, new Date()))).toBe(false);
    expect(await db.transaction((tx) => commitReservation(tx, last.reservationId))).toBe(true);
    expect(await db.transaction((tx) => commitReservation(tx, last.reservationId))).toBe(false);
    expect((await reserve(60_000)).ok).toBe(true);
    expect(await reserve(1)).toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
  });

  it('refuses another currency and an unknown mandate', async () => {
    expect(await reserve(1, 'EUR')).toEqual({ ok: false, reason: 'CURRENCY_MISMATCH' });
    expect(await reserve(1, 'USD', '00000000-0000-4000-8000-0000000000ff')).toEqual({ ok: false, reason: 'MANDATE_NOT_FOUND' });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects amount %s before touching the database', async (amount) => {
    await expect(reserve(amount)).rejects.toThrow(RangeError);
  });
});

describe('seed', () => {
  it('is idempotent', async () => {
    await seed(db);
    const { rows } = await db.query<{ n: unknown }>('SELECT count(*) AS n FROM category_limit WHERE mandate_id = $1', [DEMO_IDS.mandate]);
    expect(toBigInt(rows[0]?.n)).toBe(4n);
  });

  it('produces a mandate the policy engine accepts', async () => {
    const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM mandate WHERE id = $1', [DEMO_IDS.mandate]);
    const limits = await db.query<{ category: string; allowed: boolean; cap_minor_units: unknown }>(
      'SELECT category, allowed, cap_minor_units FROM category_limit WHERE mandate_id = $1 ORDER BY category',
      [DEMO_IDS.mandate],
    );
    const m = rows[0] ?? {};
    const mandate = MandateSchema.parse({
      id: m.id,
      status: m.status,
      currency: m.currency,
      budgetMinor: Number(toBigInt(m.budget_minor_units)),
      perItemCapMinor: Number(toBigInt(m.per_item_cap_minor_units)),
      approvalThresholdMinor: Number(toBigInt(m.approval_threshold_minor_units)),
      maxQuantityPerLine: m.max_quantity_per_line,
      structuringWindowMinutes: m.structuring_window_minutes,
      priceDriftToleranceBps: m.price_drift_tolerance_bps,
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      categoryLimits: limits.rows.map((l) => ({
        category: l.category,
        allowed: l.allowed,
        ...(l.cap_minor_units === null ? {} : { capMinor: Number(toBigInt(l.cap_minor_units)) }),
      })),
    });
    const pens = { productId: 'p', category: 'office-supplies', unitPriceMinor: 500, quantity: 2 };
    const decisionResult = evaluate(mandate, { currency: 'USD', items: [pens], shippingMinor: 0, taxMinor: 0 }, { records: [] }, new Date('2026-11-10T00:00:00Z'));
    expect(decisionResult.outcome).toBe('ALLOW');
  });
});

describe('toBigInt', () => {
  it.each([
    [5n, 5n],
    [7, 7n],
    ['-12', -12n],
    ['90071992547409930', 90071992547409930n],
  ])('converts %s', (input, expected) => {
    expect(toBigInt(input)).toBe(expected);
  });

  it.each([1.5, '1.5', '', null, undefined, {}])('rejects %s', (input) => {
    expect(() => toBigInt(input)).toThrow(TypeError);
  });
});
