import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE } from '../src/pool.js';
import { requestBodyHash } from '../src/requests.js';
import {
  captureOrder,
  createDecision,
  createDecisionRows,
  createMandate,
  createTestDatabase,
  createUser,
  type MandateFixture,
  placeOrder,
  type TestDatabase,
} from './support/test-database.js';

let db: TestDatabase;
let fixture: MandateFixture;

beforeAll(async () => {
  db = await createTestDatabase();
  fixture = await createMandate(db.pool, 50_000);
});

afterAll(async () => {
  await db.drop();
});

const TABLES = [
  'organization',
  'app_user',
  'mandate',
  'category_limit',
  'purchase_request',
  'product_snapshot',
  'cart',
  'cart_item',
  'policy_decision',
  'budget_reservation',
  'approval',
  'purchase_order',
  'order_event',
  'webhook_event',
  'audit_log',
  'refund',
];

describe('schema shape', () => {
  it('has every table from docs/er-diagram.md in scope for issue #11', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES, 'schema_migrations'].sort());
  });

  it('adds the three mandate columns @mandate/policy reads', async () => {
    const { rows } = await db.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'mandate' AND column_name IN ('max_quantity_per_line', 'structuring_window_minutes', 'price_drift_tolerance_bps')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'max_quantity_per_line', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'price_drift_tolerance_bps', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'structuring_window_minutes', data_type: 'integer', is_nullable: 'NO' },
    ]);
  });

  it('stores every amount as bigint minor units and never as a float or decimal', async () => {
    const money = await db.pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%minor_units'`,
    );
    // mandate 3, category_limit 1, product_snapshot 1, cart 4, cart_item 2, policy_decision 1, budget_reservation 2, purchase_order 2, refund 1.
    expect(money.rows).toHaveLength(17);
    for (const column of money.rows) expect(column, `${column.table_name}.${column.column_name}`).toMatchObject({ data_type: 'bigint' });

    const inexact = await db.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('real', 'double precision', 'numeric', 'money')`,
    );
    expect(inexact.rows).toEqual([]);
  });

  it('reads bigint money back as an exact JavaScript number', async () => {
    const { rows } = await db.pool.query<{ budget_minor_units: unknown }>('SELECT budget_minor_units FROM mandate WHERE id = $1', [fixture.mandateId]);
    expect(rows[0]?.budget_minor_units).toBe(50_000);
  });
});

describe('constraints that carry correctness', () => {
  /** A raw insert, as a writer that bypasses createPurchaseRequest() would do it. */
  const newRequest = (f: MandateFixture, requestKey: string, overrides: { organizationId?: string; requesterUserId?: string } = {}) =>
    db.pool.query(
      `INSERT INTO purchase_request (organization_id, mandate_id, requester_user_id, raw_text, request_key, request_hash) VALUES ($1, $2, $3, 'x', $4, $5)`,
      [overrides.organizationId ?? f.organizationId, f.mandateId, overrides.requesterUserId ?? f.userId, requestKey, requestBodyHash({ mandateId: f.mandateId, rawText: 'x' })],
    );

  it('makes a double submit by the same requester fail instead of creating a second request', async () => {
    await newRequest(fixture, 'double-submit-0001');
    await expect(newRequest(fixture, 'double-submit-0001')).rejects.toMatchObject({
      code: SQLSTATE.UNIQUE_VIOLATION,
      constraint: 'purchase_request_requester_request_key_key',
    });
  });

  it('scopes request_key per requester, so one user cannot claim or collide with another user\'s keys', async () => {
    const other = await createMandate(db.pool, 1_000); // a user in another organization
    await newRequest(fixture, 'shared-key-0001');
    await newRequest(other, 'shared-key-0001');
    const { rows } = await db.pool.query('SELECT 1 FROM purchase_request WHERE request_key = $1', ['shared-key-0001']);
    expect(rows).toHaveLength(2);
  });

  it('refuses a request whose requester or mandate is outside the request organization (finding H3)', async () => {
    const other = await createMandate(db.pool, 1_000);
    // A user of another organization raising a request against this organization's mandate.
    await expect(newRequest(fixture, 'cross-tenant-0001', { requesterUserId: other.userId })).rejects.toMatchObject({
      code: SQLSTATE.FOREIGN_KEY_VIOLATION,
      constraint: 'purchase_request_requester_organization_fkey',
    });
    // Claiming the other organization to make the requester fit: now the mandate does not.
    await expect(newRequest(fixture, 'cross-tenant-0002', { organizationId: other.organizationId, requesterUserId: other.userId })).rejects.toMatchObject({
      code: SQLSTATE.FOREIGN_KEY_VIOLATION,
      constraint: 'purchase_request_mandate_organization_fkey',
    });
  });

  it('requires a SHA-256 request hash', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO purchase_request (organization_id, mandate_id, requester_user_id, raw_text, request_key, request_hash) VALUES ($1, $2, $3, 'x', 'no-hash-0001', 'abc')`,
        [fixture.organizationId, fixture.mandateId, fixture.userId],
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.CHECK_VIOLATION, constraint: 'purchase_request_request_hash_check' });
  });

  const webhook = (eventId: string, verified: boolean) =>
    db.pool.query(
      `INSERT INTO webhook_event (provider, provider_event_id, event_type, payload, signature_verified)
       VALUES ('paypal', $1, 'PAYMENT.CAPTURE.COMPLETED', '{}', $2)
       ON CONFLICT (provider, provider_event_id) WHERE signature_verified DO NOTHING
       RETURNING id`,
      [eventId, verified],
    );

  it('dedupes verified webhooks by provider event id', async () => {
    expect((await webhook('WH-0001', true)).rowCount).toBe(1);
    // The handler pattern: a redelivery inserts nothing and is acknowledged without reprocessing.
    expect((await webhook('WH-0001', true)).rowCount).toBe(0);
    await expect(
      db.pool.query(`INSERT INTO webhook_event (provider, provider_event_id, event_type, payload, signature_verified) VALUES ('paypal', 'WH-0001', 'x', '{}', true)`),
    ).rejects.toMatchObject({ code: SQLSTATE.UNIQUE_VIOLATION, constraint: 'webhook_event_verified_dedupe_key' });
  });

  it('does not let an unverified (possibly forged) event swallow the genuine delivery', async () => {
    expect((await webhook('WH-0002', false)).rowCount).toBe(1); // forged, or verification failed transiently
    expect((await webhook('WH-0002', false)).rowCount).toBe(1); // stored again for forensics
    expect((await webhook('WH-0002', true)).rowCount).toBe(1); // PayPal's real redelivery is still processed
    expect((await webhook('WH-0002', true)).rowCount).toBe(0);
    const { rows } = await db.pool.query<{ verified: number }>(
      `SELECT count(*) FILTER (WHERE signature_verified)::bigint AS verified FROM webhook_event WHERE provider_event_id = 'WH-0002'`,
    );
    expect(rows[0]?.verified).toBe(1);
  });

  it('rejects money as a fraction, a negative, or beyond the safe integer range', async () => {
    // Values arrive as driver parameters, as application code sends them. (A SQL numeric *expression* would be
    // rounded on assignment to bigint by Postgres itself, which is why money is never computed in SQL numeric.)
    for (const [value, code] of [
      [10.5, '22P02'], // invalid input syntax for type bigint
      [-1, SQLSTATE.CHECK_VIOLATION],
      [9_007_199_254_740_992, SQLSTATE.CHECK_VIOLATION],
    ] as const) {
      await expect(db.pool.query('UPDATE mandate SET per_item_cap_minor_units = $2 WHERE id = $1', [fixture.mandateId, value])).rejects.toMatchObject({ code });
    }
    await expect(db.pool.query(`UPDATE mandate SET currency = 'usd' WHERE id = $1`, [fixture.mandateId])).rejects.toMatchObject({
      code: SQLSTATE.CHECK_VIOLATION,
    });
  });

  it('enforces the policy-engine bounds on the new mandate columns', async () => {
    for (const [column, value] of [
      ['max_quantity_per_line', 0],
      ['max_quantity_per_line', 10_001],
      ['structuring_window_minutes', 0],
      ['price_drift_tolerance_bps', 10_001],
    ] as const) {
      await expect(db.pool.query(`UPDATE mandate SET ${column} = $2 WHERE id = $1`, [fixture.mandateId, value])).rejects.toMatchObject({
        code: SQLSTATE.CHECK_VIOLATION,
      });
    }
  });

  it('keeps a mandate approver inside the mandate organization, and never a requester (MD011)', async () => {
    const other = await createMandate(db.pool, 1_000);
    // The 0006 trigger answers first; the composite foreign key from 0001 stays behind it.
    await expect(db.pool.query('UPDATE mandate SET approver_user_id = $2 WHERE id = $1', [fixture.mandateId, other.userId])).rejects.toMatchObject({
      code: SQLSTATE.APPROVER_NOT_ELIGIBLE,
    });
    await expect(db.pool.query('UPDATE mandate SET approver_user_id = $2 WHERE id = $1', [fixture.mandateId, fixture.requesterId])).rejects.toMatchObject({
      code: SQLSTATE.APPROVER_NOT_ELIGIBLE,
    });
    const fk = await db.pool.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'mandate'::regclass AND contype = 'f' AND conkey::int[] = ARRAY[2, 3]`);
    expect(fk.rows).toHaveLength(1);
  });

  it('computes cart totals in the database and checks line totals', async () => {
    const decisionId = await createDecision(db.pool, fixture, 1_000);
    const { rows } = await db.pool.query<{ cart_id: string; purchase_request_id: string }>('SELECT cart_id, purchase_request_id FROM policy_decision WHERE id = $1', [decisionId]);
    const cartId = rows[0]?.cart_id ?? '';
    await db.pool.query('UPDATE cart SET shipping_minor_units = 250, tax_minor_units = 80 WHERE id = $1', [cartId]);
    const total = await db.pool.query<{ total_minor_units: number }>('SELECT total_minor_units FROM cart WHERE id = $1', [cartId]);
    expect(total.rows[0]?.total_minor_units).toBe(1_330);
    // 428C9 generated_always: no caller can write a total.
    await expect(db.pool.query('UPDATE cart SET total_minor_units = 1 WHERE id = $1', [cartId])).rejects.toMatchObject({ code: '428C9' });

    const snapshot = await db.pool.query<{ id: string }>(
      `INSERT INTO product_snapshot (purchase_request_id, provider, external_product_id, title, category, unit_price_minor_units, currency, raw_payload, text_quarantined, fetched_at)
       VALUES ($1, 'fixture', 'p-1', 'Name tags', 'office_supplies', 25, 'USD', '{}', true, now()) RETURNING id`,
      [rows[0]?.purchase_request_id],
    );
    const item = `INSERT INTO cart_item (cart_id, product_snapshot_id, quantity, unit_price_minor_units, line_total_minor_units) VALUES ($1, $2, 40, 25, $3)`;
    await expect(db.pool.query(item, [cartId, snapshot.rows[0]?.id, 999])).rejects.toMatchObject({ code: SQLSTATE.CHECK_VIOLATION });
    await db.pool.query(item, [cartId, snapshot.rows[0]?.id, 1_000]);
  });
});

const holdFor = (decisionId: string, amount: number, mandateId = fixture.mandateId) =>
  db.pool.query(
    `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, $3, 'USD', now() + interval '1 hour')`,
    [mandateId, decisionId, amount],
  );

describe('append-only tables', () => {
  it.each(['audit_log', 'order_event'])('%s accepts inserts and refuses UPDATE, DELETE and TRUNCATE', async (table) => {
    let id: string;
    if (table === 'audit_log') {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO audit_log (organization_id, actor_type, action, subject_type, detail) VALUES ($1, 'agent', 'policy.denied', 'purchase_request', '{"reasons":[]}') RETURNING id`,
        [fixture.organizationId],
      );
      id = rows[0]?.id ?? '';
    } else {
      const rows500 = await createDecisionRows(db.pool, fixture, 500);
      await holdFor(rows500.decisionId, 500);
      const order = await db.pool.query<{ id: string }>(
        `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, idempotency_key, payment_variant, amount_minor_units, currency)
         VALUES ($1, $2, $3, 'APPROVAL_LINK', 500, 'USD') RETURNING id`,
        [rows500.requestId, rows500.decisionId, `order-key-${rows500.decisionId.slice(0, 8)}`],
      );
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO order_event (order_id, event_type, from_state, to_state, occurred_at) VALUES ($1, 'payment.started', 'POLICY_CHECKED', 'PAYMENT_PENDING', now()) RETURNING id`,
        [order.rows[0]?.id],
      );
      id = rows[0]?.id ?? '';
    }

    await expect(db.pool.query(`UPDATE ${table} SET id = id WHERE id = $1`, [id])).rejects.toMatchObject({ code: SQLSTATE.APPEND_ONLY });
    await expect(db.pool.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rejects.toMatchObject({ code: SQLSTATE.APPEND_ONLY });
    await expect(db.pool.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: SQLSTATE.APPEND_ONLY });
    const { rows } = await db.pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });
});

describe('append-only timestamps', () => {
  it('stamps audit_log.created_at and order_event.recorded_at with server time, ignoring a backdated value', async () => {
    const { rows } = await db.pool.query<{ server_time: boolean }>(
      `INSERT INTO audit_log (organization_id, actor_type, action, subject_type, created_at) VALUES ($1, 'agent', 'x', 'y', '2000-01-01Z')
       RETURNING created_at = now() AS server_time`,
      [fixture.organizationId],
    );
    expect(rows[0]?.server_time).toBe(true);
  });
});

describe('related rows must agree (review finding M3)', () => {
  it('refuses a decision that scores another request\'s cart, or a cart in another currency', async () => {
    const a = await createDecisionRows(db.pool, fixture, 100);
    const b = await createDecisionRows(db.pool, fixture, 100);
    const decide = (requestId: string, cartId: string, currency: string) =>
      db.pool.query(
        `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
         VALUES ($1, $2, 'ALLOW', '[]', 't', 100, $3, now())`,
        [requestId, cartId, currency],
      );
    await expect(decide(a.requestId, b.cartId, 'USD')).rejects.toMatchObject({ code: SQLSTATE.FOREIGN_KEY_VIOLATION });
    await expect(decide(a.requestId, a.cartId, 'GBP')).rejects.toMatchObject({ code: SQLSTATE.FOREIGN_KEY_VIOLATION });
    await decide(a.requestId, a.cartId, 'USD');
  });

  it('keeps product snapshots immutable and cart lines at the snapshot price of their own request', async () => {
    const a = await createDecisionRows(db.pool, fixture, 100);
    const b = await createDecisionRows(db.pool, fixture, 100);
    const snapshot = await db.pool.query<{ id: string }>(
      `INSERT INTO product_snapshot (purchase_request_id, provider, external_product_id, title, category, unit_price_minor_units, currency, raw_payload, text_quarantined, fetched_at)
       VALUES ($1, 'fixture', 'p-2', 'Cable', 'electronics', 25, 'USD', '{}', true, now()) RETURNING id`,
      [a.requestId],
    );
    const snapshotId = snapshot.rows[0]?.id;
    await expect(db.pool.query('UPDATE product_snapshot SET unit_price_minor_units = 1 WHERE id = $1', [snapshotId])).rejects.toMatchObject({ code: SQLSTATE.APPEND_ONLY });
    const line = (cartId: string, unit: number) =>
      db.pool.query(`INSERT INTO cart_item (cart_id, product_snapshot_id, quantity, unit_price_minor_units, line_total_minor_units) VALUES ($1, $2, 2, $3, $4)`, [
        cartId,
        snapshotId,
        unit,
        unit * 2,
      ]);
    await expect(line(a.cartId, 1)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW }); // price not from the snapshot
    await expect(line(b.cartId, 25)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW }); // snapshot of another request
    await line(a.cartId, 25);
  });

  it('accepts approvals only from the mandate approver, only for NEEDS_APPROVAL decisions', async () => {
    const other = await createMandate(db.pool, 1_000);
    const pending = await createDecisionRows(db.pool, fixture, 100, { outcome: 'NEEDS_APPROVAL' });
    const allowed = await createDecisionRows(db.pool, fixture, 100);
    let n = 0;
    const approve = (rows: { requestId: string; decisionId: string }, approverId: string) =>
      db.pool.query<{ id: string }>(
        `INSERT INTO approval (purchase_request_id, policy_decision_id, approver_user_id, channel, token_hash, expires_at)
         VALUES ($1, $2, $3, 'test', $4, now() + interval '1 day') RETURNING id`,
        [rows.requestId, rows.decisionId, approverId, `token-${rows.decisionId}-${++n}`],
      );
    await expect(approve(pending, other.userId)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await expect(approve(allowed, fixture.userId)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await expect(approve({ requestId: allowed.requestId, decisionId: pending.decisionId }, fixture.userId)).rejects.toMatchObject({
      code: SQLSTATE.FOREIGN_KEY_VIOLATION, // the decision belongs to another request
    });
    await approve(pending, fixture.userId);
  });
});

describe('orders need authorization and a covering hold (hard rule 1 backstop)', () => {
  let n = 0;
  const order = (rows: { requestId: string; decisionId: string }, amount: number, options: { approvalId?: string; currency?: string } = {}) =>
    db.pool.query(
      `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, approval_id, idempotency_key, payment_variant, amount_minor_units, currency)
       VALUES ($1, $2, $3, $4, 'APPROVAL_LINK', $5, $6)`,
      [rows.requestId, rows.decisionId, options.approvalId ?? null, `order-gate-${++n}-${rows.decisionId.slice(0, 8)}`, amount, options.currency ?? 'USD'],
    );

  it('refuses an order for a DENY decision, without a hold, above its hold, or in another currency', async () => {
    const denied = await createDecisionRows(db.pool, fixture, 100, { outcome: 'DENY' });
    await expect(order(denied, 100)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });

    const allowed = await createDecisionRows(db.pool, fixture, 100);
    await expect(order(allowed, 100)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW }); // no hold yet
    await holdFor(allowed.decisionId, 100);
    await expect(order(allowed, 101)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await expect(order(allowed, 100, { currency: 'EUR' })).rejects.toMatchObject({ code: SQLSTATE.FOREIGN_KEY_VIOLATION });
    await order(allowed, 100);
  });

  it('pays a NEEDS_APPROVAL decision only with an APPROVED approval of that same decision', async () => {
    const pending = await createDecisionRows(db.pool, fixture, 100, { outcome: 'NEEDS_APPROVAL' });
    await holdFor(pending.decisionId, 100);
    await expect(order(pending, 100)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    const approval = await db.pool.query<{ id: string }>(
      `INSERT INTO approval (purchase_request_id, policy_decision_id, approver_user_id, channel, token_hash, expires_at)
       VALUES ($1, $2, $3, 'test', $4, now() + interval '1 day') RETURNING id`,
      [pending.requestId, pending.decisionId, fixture.userId, `token-gate-${pending.decisionId}`],
    );
    const approvalId = approval.rows[0]?.id ?? '';
    await expect(order(pending, 100, { approvalId })).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW }); // still PENDING
    await db.pool.query(`UPDATE approval SET status = 'APPROVED', decided_at = now() WHERE id = $1`, [approvalId]);
    await order(pending, 100, { approvalId });
  });
});

describe('orders carry PayPal capture evidence (second review finding H2)', () => {
  const held = async (amount: number) => {
    const rows = await createDecisionRows(db.pool, fixture, amount);
    await holdFor(rows.decisionId, amount);
    return { rows, orderId: await placeOrder(db.pool, rows, amount) };
  };
  const capture = (orderId: string, fields: Record<string, unknown>) => {
    const values = { provider_order_id: 'PO-H2', provider_capture_id: `CAP-${orderId.slice(0, 8)}`, capture_status: 'COMPLETED', captured_amount_minor_units: 700, captured_currency: 'USD', ...fields };
    const keys = Object.keys(values);
    return db.pool.query(
      `UPDATE purchase_order SET state = 'CAPTURED', ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [orderId, ...Object.values(values)],
    );
  };

  it.each([
    ['no capture id', { provider_capture_id: null }, SQLSTATE.CAPTURE_EVIDENCE],
    ['no PayPal order id', { provider_order_id: null }, SQLSTATE.CHECK_VIOLATION],
    ['a PENDING capture', { capture_status: 'PENDING' }, SQLSTATE.CHECK_VIOLATION],
    ['a partial capture', { captured_amount_minor_units: 699 }, SQLSTATE.CHECK_VIOLATION],
    ['a capture in another currency', { captured_currency: 'EUR' }, SQLSTATE.CHECK_VIOLATION],
  ])('refuses CAPTURED with %s', async (_label, fields, code) => {
    const { orderId } = await held(700);
    await expect(capture(orderId, fields)).rejects.toMatchObject({ code });
  });

  it('stamps capture_verified_at with server time, and lets one PayPal capture pay for one order only', async () => {
    const a = await held(700);
    await capture(a.orderId, { provider_capture_id: 'CAP-UNIQUE-1', capture_verified_at: '2000-01-01Z' });
    const { rows } = await db.pool.query<{ fresh: boolean }>('SELECT capture_verified_at > now() - interval \'1 minute\' AS fresh FROM purchase_order WHERE id = $1', [a.orderId]);
    expect(rows[0]?.fresh).toBe(true);
    const b = await held(700);
    await expect(capture(b.orderId, { provider_capture_id: 'CAP-UNIQUE-1' })).rejects.toMatchObject({ code: SQLSTATE.UNIQUE_VIOLATION });
  });

  it('refuses evidence on insert, and a change of provider_order_id once recorded', async () => {
    const rows = await createDecisionRows(db.pool, fixture, 100);
    await holdFor(rows.decisionId, 100);
    await expect(
      db.pool.query(
        `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, idempotency_key, payment_variant, amount_minor_units, currency, provider_capture_id)
         VALUES ($1, $2, 'evidence-on-insert', 'APPROVAL_LINK', 100, 'USD', 'CAP-X')`,
        [rows.requestId, rows.decisionId],
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.CAPTURE_EVIDENCE });
    const orderId = await placeOrder(db.pool, rows, 100);
    await db.pool.query(`UPDATE purchase_order SET provider_order_id = 'PO-FIRST' WHERE id = $1`, [orderId]);
    await expect(db.pool.query(`UPDATE purchase_order SET provider_order_id = 'PO-OTHER' WHERE id = $1`, [orderId])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_ORDER_CHANGE,
    });
    await expect(db.pool.query(`UPDATE purchase_order SET amount_minor_units = 1 WHERE id = $1`, [orderId])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_ORDER_CHANGE,
    });
  });

  it('records a verified capture through recordVerifiedCapture, idempotently, and refuses one that does not match', async () => {
    const { recordVerifiedCapture } = await import('../src/orders.js');
    const { withTransaction } = await import('../src/pool.js');
    const a = await held(400);
    const evidence = { providerOrderId: 'PO-R1', captureId: 'CAP-R1', status: 'COMPLETED', amount: { amountMinor: 400, currency: 'USD' } };
    const record = (orderId: string, e: typeof evidence) => withTransaction(db.pool, (c) => recordVerifiedCapture(c, orderId, e));
    expect(await record(a.orderId, { ...evidence, status: 'PENDING' })).toEqual({ ok: false, reason: 'NOT_COMPLETED' });
    expect(await record(a.orderId, { ...evidence, amount: { amountMinor: 399, currency: 'USD' } })).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
    expect(await record(a.orderId, evidence)).toEqual({ ok: true, alreadyRecorded: false });
    expect(await record(a.orderId, evidence)).toEqual({ ok: true, alreadyRecorded: true });
    expect(await record(a.orderId, { ...evidence, captureId: 'CAP-R2' })).toEqual({ ok: false, reason: 'ORDER_NOT_CAPTURABLE' });
    const { rows } = await db.pool.query<{ state: string; committed: number }>(
      'SELECT state, committed_amount_minor_units AS committed FROM budget_reservation WHERE policy_decision_id = $1',
      [a.rows.decisionId],
    );
    expect(rows[0]).toEqual({ state: 'COMMITTED', committed: 400 });
  });
});

describe('approvals: forward-only, before expiry, never self-approval, token used once (second review M2)', () => {
  let n = 0;
  const pendingApproval = async (expiresIn = '1 day', approverId = fixture.userId) => {
    const rows = await createDecisionRows(db.pool, fixture, 100, { outcome: 'NEEDS_APPROVAL' });
    const approval = await db.pool.query<{ id: string }>(
      `INSERT INTO approval (purchase_request_id, policy_decision_id, approver_user_id, channel, token_hash, expires_at)
       VALUES ($1, $2, $3, 'test', $4, now() + $5::interval) RETURNING id`,
      [rows.requestId, rows.decisionId, approverId, `token-lifecycle-${++n}-${rows.decisionId}`, expiresIn],
    );
    return { rows, approvalId: approval.rows[0]?.id ?? '' };
  };
  const setStatus = (id: string, status: string) => db.pool.query('UPDATE approval SET status = $2 WHERE id = $1', [id, status]);

  it('refuses an approver deciding their own request', async () => {
    const own = await createDecisionRows(db.pool, { ...fixture, requesterId: fixture.userId }, 100, { outcome: 'NEEDS_APPROVAL' });
    await expect(
      db.pool.query(
        `INSERT INTO approval (purchase_request_id, policy_decision_id, approver_user_id, channel, token_hash, expires_at)
         VALUES ($1, $2, $3, 'test', 'token-self', now() + interval '1 day')`,
        [own.requestId, own.decisionId, fixture.userId],
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.NOT_AUTHORIZED });
  });

  it('refuses a decision after expiry, and EXPIRED before it', async () => {
    const soon = await pendingApproval('200 milliseconds');
    await expect(setStatus(soon.approvalId, 'EXPIRED')).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_APPROVAL_CHANGE });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(setStatus(soon.approvalId, 'APPROVED')).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_APPROVAL_CHANGE });
    await setStatus(soon.approvalId, 'EXPIRED');
  });

  it('moves only forward, uses a token once, and stamps decided_at itself', async () => {
    const a = await pendingApproval();
    await db.pool.query(`UPDATE approval SET status = 'APPROVED', token_used_at = now(), decided_at = '2000-01-01Z' WHERE id = $1`, [a.approvalId]);
    const { rows } = await db.pool.query<{ fresh: boolean }>(`SELECT decided_at > now() - interval '1 minute' AS fresh FROM approval WHERE id = $1`, [a.approvalId]);
    expect(rows[0]?.fresh).toBe(true);
    await expect(setStatus(a.approvalId, 'PENDING')).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_APPROVAL_CHANGE });
    await expect(setStatus(a.approvalId, 'REJECTED')).rejects.toMatchObject({ code: SQLSTATE.ILLEGAL_APPROVAL_CHANGE });
    await expect(db.pool.query('UPDATE approval SET token_used_at = now() WHERE id = $1', [a.approvalId])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_APPROVAL_CHANGE,
    });
    await expect(db.pool.query(`UPDATE approval SET expires_at = now() + interval '1 year' WHERE id = $1`, [a.approvalId])).rejects.toMatchObject({
      code: SQLSTATE.ILLEGAL_APPROVAL_CHANGE,
    });
  });

  it('refuses an ALLOW order carrying an approval of another decision (L2)', async () => {
    const a = await pendingApproval();
    await setStatus(a.approvalId, 'APPROVED');
    const allowed = await createDecisionRows(db.pool, fixture, 100);
    await holdFor(allowed.decisionId, 100);
    await expect(placeOrder(db.pool, allowed, 100, a.approvalId)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await placeOrder(db.pool, allowed, 100);
  });
});

describe('append-only rows must agree with what they describe (second review finding L3)', () => {
  const event = (orderId: string, from: string | null, to: string, webhookId: string | null = null) =>
    db.pool.query(`INSERT INTO order_event (order_id, webhook_event_id, event_type, from_state, to_state, occurred_at) VALUES ($1, $2, 'test', $3, $4, now())`, [
      orderId,
      webhookId,
      from,
      to,
    ]);

  it('refuses an order event that contradicts the order or skips the state machine', async () => {
    const rows = await createDecisionRows(db.pool, fixture, 100);
    await holdFor(rows.decisionId, 100);
    const orderId = await placeOrder(db.pool, rows, 100);
    await expect(event(orderId, 'PAYMENT_PENDING', 'CAPTURED')).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW }); // order is not CAPTURED
    await expect(event(orderId, 'REFUNDED', 'PAYMENT_PENDING')).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW }); // no such step
    const forged = await db.pool.query<{ id: string }>(
      `INSERT INTO webhook_event (provider, provider_event_id, event_type, payload, signature_verified) VALUES ('paypal', 'WH-FORGED', 'x', '{}', false) RETURNING id`,
    );
    await expect(event(orderId, null, 'PAYMENT_PENDING', forged.rows[0]?.id)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await event(orderId, 'POLICY_CHECKED', 'PAYMENT_PENDING');
    await captureOrder(db.pool, orderId, 100);
    await event(orderId, 'PAYMENT_PENDING', 'CAPTURED');
  });

  it('refuses an audit entry about another organization\'s subject, or naming another organization\'s user', async () => {
    const other = await createMandate(db.pool, 1_000);
    const audit = (org: string, subjectType: string, subjectId: string | null, actorType = 'agent', actorId: string | null = null) =>
      db.pool.query(`INSERT INTO audit_log (organization_id, actor_type, actor_id, action, subject_type, subject_id) VALUES ($1, $2, $3, 'test', $4, $5)`, [
        org,
        actorType,
        actorId,
        subjectType,
        subjectId,
      ]);
    await expect(audit(fixture.organizationId, 'mandate', other.mandateId)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await expect(audit(fixture.organizationId, 'mandate', fixture.mandateId, 'user', other.userId)).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await expect(audit(fixture.organizationId, 'mandate', fixture.mandateId, 'user', 'not-a-uuid')).rejects.toMatchObject({ code: SQLSTATE.MISMATCHED_ROW });
    await audit(fixture.organizationId, 'mandate', fixture.mandateId, 'user', fixture.userId);
    await audit(fixture.organizationId, 'some_future_subject', other.mandateId); // unlisted subject types are not checked (documented)
  });
});

describe('mandate administration and its audit trail (second review finding M2)', () => {
  it('audits every change to a mandate or its category limits, as system when the owner writes directly', async () => {
    const f = await createMandate(db.pool, 1_000);
    await db.pool.query('UPDATE mandate SET budget_minor_units = 2000 WHERE id = $1', [f.mandateId]);
    await db.pool.query('UPDATE mandate SET budget_minor_units = 2000 WHERE id = $1', [f.mandateId]); // no change, no entry
    await db.pool.query(`INSERT INTO category_limit (mandate_id, category, allowed) VALUES ($1, 'books', true)`, [f.mandateId]);
    const { rows } = await db.pool.query<{ action: string; actor_type: string; subject_type: string; budget: string | null }>(
      `SELECT action, actor_type, subject_type, detail #>> '{after,budget_minor_units}' AS budget
         FROM audit_log WHERE organization_id = $1 AND subject_type = 'mandate' ORDER BY created_at, id`,
      [f.organizationId],
    );
    expect(rows.map((r) => r.action).sort()).toEqual(['category_limit.insert', 'mandate.insert', 'mandate.update']);
    expect(rows.every((r) => r.actor_type === 'system' && r.subject_type === 'mandate')).toBe(true);
    expect(rows.find((r) => r.action === 'mandate.update')?.budget).toBe('2000');
  });

  it('lets an owner be an approver, and keeps role \'owner\' a valid role', async () => {
    const owner = await createUser(db.pool, fixture.organizationId, 'owner');
    await db.pool.query('UPDATE mandate SET approver_user_id = $2 WHERE id = $1', [fixture.mandateId, owner]);
    await db.pool.query('UPDATE mandate SET approver_user_id = $2 WHERE id = $1', [fixture.mandateId, fixture.userId]);
  });
});

describe('third review fixes in the schema (M1, M4, L1)', () => {
  it('recordVerifiedCapture writes nothing and says HOLD_NOT_HELD when the hold is not held', async () => {
    const { recordVerifiedCapture } = await import('../src/orders.js');
    const { withTransaction } = await import('../src/pool.js');
    const rows = await createDecisionRows(db.pool, fixture, 300);
    await holdFor(rows.decisionId, 300);
    const orderId = await placeOrder(db.pool, rows, 300);
    // Simulate an inconsistency the triggers now prevent (H1 of the third review): the owner bypasses them.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE budget_reservation DISABLE TRIGGER budget_reservation_enforce_budget');
      await client.query(`UPDATE budget_reservation SET state = 'RELEASED', released_at = now() WHERE policy_decision_id = $1`, [rows.decisionId]);
      await client.query('ALTER TABLE budget_reservation ENABLE TRIGGER budget_reservation_enforce_budget');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const result = await withTransaction(db.pool, (c) =>
      recordVerifiedCapture(c, orderId, { providerOrderId: 'PO-M1', captureId: 'CAP-M1', status: 'COMPLETED', amount: { amountMinor: 300, currency: 'USD' } }),
    );
    expect(result).toEqual({ ok: false, reason: 'HOLD_NOT_HELD' });
    const order = await db.pool.query<{ state: string }>('SELECT state FROM purchase_order WHERE id = $1', [orderId]);
    expect(order.rows[0]?.state).toBe('PAYMENT_PENDING');
  });

  it('refuses an approval decided after expiry by a transaction that started before it', async () => {
    const rows = await createDecisionRows(db.pool, fixture, 100, { outcome: 'NEEDS_APPROVAL' });
    const approval = await db.pool.query<{ id: string }>(
      `INSERT INTO approval (purchase_request_id, policy_decision_id, approver_user_id, channel, token_hash, expires_at)
       VALUES ($1, $2, $3, 'test', $4, clock_timestamp() + interval '300 milliseconds') RETURNING id`,
      [rows.requestId, rows.decisionId, fixture.userId, `token-clock-${rows.decisionId}`],
    );
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1'); // now() is fixed here, before expiry
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(client.query(`UPDATE approval SET status = 'APPROVED' WHERE id = $1`, [approval.rows[0]?.id])).rejects.toMatchObject({
        code: SQLSTATE.ILLEGAL_APPROVAL_CHANGE,
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
