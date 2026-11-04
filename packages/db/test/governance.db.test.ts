import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSetUserRole } from '../src/mandates.js';
import { recordRefundOutcome, recordVerifiedCapture, requestRefund } from '../src/orders.js';
import { SQLSTATE, sqlState, withTransaction } from '../src/pool.js';
import { reserveBudget } from '../src/reservations.js';
import { LARGE_OBJECT_CREATORS, publicLargeObjectCreators, runtimeRoleProblems } from '../src/roles.js';
import {
  activeReservedTotal,
  connectAsRuntimeRole,
  createDecisionRows,
  createMandate,
  createTestDatabase,
  createUser,
  inOneHour,
  type MandateFixture,
  placeOrder,
  type RuntimeConnection,
  superuser,
  type TestDatabase,
} from './support/test-database.js';

// Decisions of the third review round (migration 0007): organization roles, refunds tracked apart from the payment,
// and large-object hardening. Everything the runtime does here runs as a login that is only in mandate_runtime.

let db: TestDatabase;
let app: RuntimeConnection;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await connectAsRuntimeRole(db);
});

afterAll(async () => {
  await app.drop();
  await db.drop();
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'accepted',
    (error: unknown) => sqlState(error) ?? String(error),
  );

describe('organization roles (decision 1)', () => {
  let org: MandateFixture;
  let owner: string;
  let admin: string;
  let approver2: string;
  let requester2: string;
  const setRole = (actor: string, target: string, role: 'requester' | 'approver' | 'admin' | 'owner') =>
    withTransaction(app.pool, (c) => adminSetUserRole(c, actor, target, role));
  const roleOf = async (id: string) => (await db.pool.query<{ role: string }>('SELECT role FROM app_user WHERE id = $1', [id])).rows[0]?.role;

  beforeAll(async () => {
    org = await createMandate(db.pool, 10_000);
    owner = await createUser(db.pool, org.organizationId, 'owner');
    admin = await createUser(db.pool, org.organizationId, 'admin');
    approver2 = await createUser(db.pool, org.organizationId, 'approver');
    requester2 = await createUser(db.pool, org.organizationId, 'requester');
  });

  it('refuses every self-assignment, privileged or not', async () => {
    expect(await code(setRole(requester2, requester2, 'owner'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(setRole(admin, admin, 'owner'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(setRole(owner, owner, 'requester'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await roleOf(admin)).toBe('admin');
  });

  it('refuses requesters and approvers as actors, and admins of other organizations', async () => {
    const elsewhere = await createMandate(db.pool, 1_000);
    const foreignOwner = await createUser(db.pool, elsewhere.organizationId, 'owner');
    expect(await code(setRole(org.requesterId, requester2, 'approver'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(setRole(org.userId, requester2, 'approver'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(setRole(foreignOwner, requester2, 'approver'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await roleOf(requester2)).toBe('requester');
  });

  it('lets an admin move others between requester and approver, but not grant or remove admin or owner', async () => {
    await setRole(admin, requester2, 'approver');
    await setRole(admin, requester2, 'requester');
    expect(await code(setRole(admin, requester2, 'admin'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(setRole(admin, approver2, 'owner'))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(setRole(admin, owner, 'requester'))).toBe(SQLSTATE.NOT_AUTHORIZED);
  });

  it('lets an owner grant and remove admin and owner, auditing each change under the owner', async () => {
    await setRole(owner, approver2, 'admin');
    await setRole(owner, approver2, 'owner');
    await setRole(owner, approver2, 'approver');
    const { rows } = await db.pool.query<{ action: string; actor_type: string; actor_id: string; before: string; after: string }>(
      `SELECT action, actor_type, actor_id, detail ->> 'before' AS before, detail ->> 'after' AS after
         FROM audit_log WHERE subject_type = 'app_user' AND subject_id = $1 AND action = 'app_user.role_change' ORDER BY created_at, id`,
      [approver2],
    );
    expect(rows).toEqual([
      { action: 'app_user.role_change', actor_type: 'user', actor_id: owner, before: 'approver', after: 'admin' },
      { action: 'app_user.role_change', actor_type: 'user', actor_id: owner, before: 'admin', after: 'owner' },
      { action: 'app_user.role_change', actor_type: 'user', actor_id: owner, before: 'owner', after: 'approver' },
    ]);
  });

  it('keeps at least one owner and keeps a mandate approver from becoming a requester, for every writer', async () => {
    expect(await code(db.pool.query(`UPDATE app_user SET role = 'admin' WHERE id = $1`, [owner]))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(db.pool.query('DELETE FROM app_user WHERE id = $1', [owner]))).toBe(SQLSTATE.NOT_AUTHORIZED);
    expect(await code(setRole(admin, org.userId, 'requester'))).toBe(SQLSTATE.APPROVER_NOT_ELIGIBLE);
    expect(await code(db.pool.query(`UPDATE app_user SET role = 'requester' WHERE id = $1`, [org.userId]))).toBe(SQLSTATE.APPROVER_NOT_ELIGIBLE);
  });

  it('cannot change roles directly or forge role audit entries as the runtime role', async () => {
    expect(await code(app.pool.query(`UPDATE app_user SET role = 'owner' WHERE id = $1`, [requester2]))).toBe('42501');
    expect(
      await code(
        app.pool.query(
          `INSERT INTO audit_log (organization_id, actor_type, actor_id, action, subject_type, subject_id) VALUES ($1, 'user', $2, 'app_user.role_change', 'app_user', $3)`,
          [org.organizationId, owner, requester2],
        ),
      ),
    ).toBe(SQLSTATE.NOT_AUTHORIZED);
  });
});

describe('refunds are tracked apart from the payment (decision 4)', () => {
  let f: MandateFixture;
  let n = 0;
  const key = (prefix: string) => `${prefix}-${++n}-${Date.now()}`;

  beforeAll(async () => {
    f = await createMandate(db.pool, 100_000);
  });

  /** A captured order of `amount`, written as the runtime role through the real helpers. */
  async function capturedOrder(amount: number): Promise<{ orderId: string; decisionId: string }> {
    const rows = await createDecisionRows(db.pool, f, amount);
    const held = await withTransaction(app.pool, (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: { amountMinor: amount, currency: 'USD' }, expiresAt: inOneHour() }),
    );
    if (!held.ok) throw new Error('setup failed');
    const orderId = await placeOrder(app.pool, rows, amount);
    const captured = await withTransaction(app.pool, (c) =>
      recordVerifiedCapture(c, orderId, { providerOrderId: key('PO'), captureId: key('CAP'), status: 'COMPLETED', amount: { amountMinor: amount, currency: 'USD' } }),
    );
    if (!captured.ok) throw new Error(`setup failed: ${captured.reason}`);
    return { orderId, decisionId: rows.decisionId };
  }
  const state = async (orderId: string, decisionId: string) =>
    (
      await db.pool.query<{ order_state: string; hold_state: string }>(
        `SELECT o.state AS order_state, r.state AS hold_state FROM purchase_order o JOIN budget_reservation r ON r.policy_decision_id = o.policy_decision_id
          WHERE o.id = $1 AND r.policy_decision_id = $2`,
        [orderId, decisionId],
      )
    ).rows[0];

  it('leaves the captured order CAPTURED and its spend committed when PayPal rejects the refund', async () => {
    const o = await capturedOrder(1_000);
    const requested = await withTransaction(app.pool, (c) => requestRefund(c, { orderId: o.orderId, idempotencyKey: key('refund'), amount: { amountMinor: 1_000, currency: 'USD' } }));
    if (!requested.ok) throw new Error(requested.reason);
    const outcome = await withTransaction(app.pool, (c) =>
      recordRefundOutcome(c, requested.refundId, { providerRefundId: key('RF'), status: 'FAILED', amount: { amountMinor: 1_000, currency: 'USD' } }),
    );
    expect(outcome).toEqual({ ok: true, outcome: 'REJECTED', alreadyRecorded: false });
    expect(await state(o.orderId, o.decisionId)).toEqual({ order_state: 'CAPTURED', hold_state: 'COMMITTED' });
    expect(await activeReservedTotal(db.pool, f.mandateId)).toBeGreaterThanOrEqual(1_000);
  });

  it('completes a refund only on PayPal status COMPLETED for exactly the requested amount, still leaving the order CAPTURED', async () => {
    const o = await capturedOrder(800);
    const requested = await withTransaction(app.pool, (c) => requestRefund(c, { orderId: o.orderId, idempotencyKey: key('refund'), amount: { amountMinor: 300, currency: 'USD' } }));
    if (!requested.ok) throw new Error(requested.reason);
    const id = requested.refundId;
    const record = (status: string, amountMinor: number, providerRefundId = 'RF-OK-1') =>
      withTransaction(app.pool, (c) => recordRefundOutcome(c, id, { providerRefundId, status, amount: { amountMinor, currency: 'USD' } }));
    expect(await record('PENDING', 300)).toEqual({ ok: false, reason: 'STILL_PENDING' });
    expect(await record('COMPLETED', 299)).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
    expect(await record('COMPLETED', 300)).toEqual({ ok: true, outcome: 'COMPLETED', alreadyRecorded: false });
    expect(await record('COMPLETED', 300)).toEqual({ ok: true, outcome: 'COMPLETED', alreadyRecorded: true });
    expect(await record('FAILED', 300)).toEqual({ ok: false, reason: 'CONFLICTING_OUTCOME' });
    expect(await state(o.orderId, o.decisionId)).toEqual({ order_state: 'CAPTURED', hold_state: 'COMMITTED' });
  });

  it('refuses COMPLETED without PayPal evidence, and any change to a decided refund, even from the owner', async () => {
    const o = await capturedOrder(500);
    const requested = await withTransaction(app.pool, (c) => requestRefund(c, { orderId: o.orderId, idempotencyKey: key('refund'), amount: { amountMinor: 500, currency: 'USD' } }));
    if (!requested.ok) throw new Error(requested.reason);
    expect(await code(app.pool.query(`UPDATE refund SET status = 'COMPLETED' WHERE id = $1`, [requested.refundId]))).toBe(SQLSTATE.CHECK_VIOLATION);
    expect(await code(app.pool.query(`UPDATE refund SET status = 'COMPLETED', provider_refund_id = 'RF-X', provider_status = 'PENDING' WHERE id = $1`, [requested.refundId]))).toBe(
      SQLSTATE.CHECK_VIOLATION,
    );
    await app.pool.query(`UPDATE refund SET status = 'REJECTED', provider_status = 'CANCELLED' WHERE id = $1`, [requested.refundId]);
    expect(await code(db.pool.query(`UPDATE refund SET status = 'COMPLETED', provider_refund_id = 'RF-Y', provider_status = 'COMPLETED' WHERE id = $1`, [requested.refundId]))).toBe(
      SQLSTATE.ILLEGAL_APPROVAL_CHANGE,
    );
    expect(await code(db.pool.query('DELETE FROM refund WHERE id = $1', [requested.refundId]))).toBe(SQLSTATE.APPEND_ONLY);
    expect(await code(app.pool.query('UPDATE refund SET amount_minor_units = 1 WHERE id = $1', [requested.refundId]))).toBe('42501');
  });

  it('never lets requested and completed refunds exceed the capture, and refunds only captured orders', async () => {
    const o = await capturedOrder(1_000);
    const ask = (amountMinor: number, idempotencyKey = key('refund')) =>
      withTransaction(app.pool, (c) => requestRefund(c, { orderId: o.orderId, idempotencyKey, amount: { amountMinor, currency: 'USD' } }));
    const first = await ask(600);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(await ask(401)).toEqual({ ok: false, reason: 'EXCEEDS_CAPTURED' });
    // The database refuses it too, for a writer that skips the helper.
    expect(
      await code(app.pool.query(`INSERT INTO refund (order_id, idempotency_key, amount_minor_units, currency) VALUES ($1, $2, 401, 'USD')`, [o.orderId, key('raw')])),
    ).toBe(SQLSTATE.MISMATCHED_ROW);
    expect(await ask(400)).toMatchObject({ ok: true, created: true });

    const pendingRows = await createDecisionRows(db.pool, f, 100);
    await withTransaction(app.pool, (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: pendingRows.decisionId, amount: { amountMinor: 100, currency: 'USD' }, expiresAt: inOneHour() }),
    );
    const pending = await placeOrder(app.pool, pendingRows, 100);
    expect(await withTransaction(app.pool, (c) => requestRefund(c, { orderId: pending, idempotencyKey: key('refund'), amount: { amountMinor: 100, currency: 'USD' } }))).toEqual({
      ok: false,
      reason: 'ORDER_NOT_CAPTURED',
    });
    expect(
      await code(app.pool.query(`INSERT INTO refund (order_id, idempotency_key, amount_minor_units, currency) VALUES ($1, $2, 100, 'USD')`, [pending, key('raw')])),
    ).toBe(SQLSTATE.MISMATCHED_ROW);
  });

  it('answers a retried refund request with the same refund, and refuses the key for a different refund', async () => {
    const o = await capturedOrder(200);
    const idempotencyKey = key('retry');
    const first = await withTransaction(app.pool, (c) => requestRefund(c, { orderId: o.orderId, idempotencyKey, amount: { amountMinor: 200, currency: 'USD' } }));
    if (!first.ok) throw new Error(first.reason);
    expect(await withTransaction(app.pool, (c) => requestRefund(c, { orderId: o.orderId, idempotencyKey, amount: { amountMinor: 200, currency: 'USD' } }))).toEqual({
      ok: true,
      created: false,
      refundId: first.refundId,
    });
    expect(await withTransaction(app.pool, (c) => requestRefund(c, { orderId: o.orderId, idempotencyKey, amount: { amountMinor: 100, currency: 'USD' } }))).toEqual({
      ok: false,
      reason: 'IDEMPOTENCY_KEY_REUSED',
    });
  });
});

describe('captured amount must equal the order amount before spend is committed (decision 3)', () => {
  it('refuses a capture for any other amount, writing nothing, so the hold stays HELD', async () => {
    const f = await createMandate(db.pool, 10_000);
    const rows = await createDecisionRows(db.pool, f, 1_000);
    await withTransaction(app.pool, (c) =>
      reserveBudget(c, { mandateId: f.mandateId, policyDecisionId: rows.decisionId, amount: { amountMinor: 1_050, currency: 'USD' }, expiresAt: inOneHour() }),
    );
    const orderId = await placeOrder(app.pool, rows, 1_000);
    for (const amountMinor of [999, 1_001, 1_050]) {
      const result = await withTransaction(app.pool, (c) =>
        recordVerifiedCapture(c, orderId, { providerOrderId: 'PO-D3', captureId: `CAP-D3-${amountMinor}`, status: 'COMPLETED', amount: { amountMinor, currency: 'USD' } }),
      );
      expect(result).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
    }
    const { rows: hold } = await db.pool.query<{ state: string; order_state: string }>(
      `SELECT r.state, o.state AS order_state FROM budget_reservation r JOIN purchase_order o ON o.policy_decision_id = r.policy_decision_id WHERE o.id = $1`,
      [orderId],
    );
    expect(hold[0]).toEqual({ state: 'HELD', order_state: 'PAYMENT_PENDING' });
  });
});

describe('large objects (hardening)', () => {
  it.each([
    ['lo_create', 'SELECT lo_create(0)'],
    ['lo_creat', 'SELECT lo_creat(-1)'],
    ['lo_from_bytea', `SELECT lo_from_bytea(0, '\\x00'::bytea)`],
  ])('refuses %s to the runtime role', async (_label, sql) => {
    expect(await code(app.pool.query(sql))).toBe('42501');
  });

  it('leaves no large-object creator executable by PUBLIC, and the runtime role passes its check', async () => {
    expect(await publicLargeObjectCreators(db.pool)).toEqual([]);
    const client = await app.pool.connect();
    try {
      expect(await runtimeRoleProblems(client)).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('flags the runtime role when large-object creation is open again', async () => {
    const database = db.config.target.split('/').pop() ?? '';
    await superuser('GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO PUBLIC', database);
    try {
      const client = await app.pool.connect();
      try {
        expect(await runtimeRoleProblems(client)).toEqual([expect.stringMatching(/can create large objects \(pg_catalog\.lo_create\(oid\)\)/)]);
      } finally {
        client.release();
      }
    } finally {
      await superuser(`REVOKE EXECUTE ON FUNCTION ${LARGE_OBJECT_CREATORS.join(', ')} FROM PUBLIC`, database);
    }
    expect(await publicLargeObjectCreators(db.pool)).toEqual([]);
  });
});
