import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/pool.js';
import { createPurchaseRequest, requestBodyHash } from '../src/requests.js';
import { createMandate, createTestDatabase, type MandateFixture, type TestDatabase } from './support/test-database.js';

// Review finding H3: idempotent purchase requests, scoped per requester, bound to the request body.

let db: TestDatabase;
let tenant: MandateFixture;

beforeAll(async () => {
  db = await createTestDatabase();
  tenant = await createMandate(db.pool, 10_000);
});

afterAll(async () => {
  await db.drop();
});

const create = (requesterUserId: string, requestKey: string, mandateId: string, rawText: string) =>
  withTransaction(db.pool, (c) => createPurchaseRequest(c, { requesterUserId, requestKey, body: { mandateId, rawText } }));

describe('createPurchaseRequest (real Postgres)', () => {
  it('creates once, then answers a true retry with the same request', async () => {
    const first = await create(tenant.userId, 'retry-key-0001', tenant.mandateId, '40 name tags');
    const retry = await create(tenant.userId, 'retry-key-0001', tenant.mandateId, '40 name tags');
    expect(first).toMatchObject({ ok: true, created: true });
    expect(retry).toEqual({ ok: true, created: false, requestId: first.ok ? first.requestId : '' });
    const { rows } = await db.pool.query<{ request_hash: string }>('SELECT request_hash FROM purchase_request WHERE request_key = $1', ['retry-key-0001']);
    expect(rows).toEqual([{ request_hash: requestBodyHash({ mandateId: tenant.mandateId, rawText: '40 name tags' }) }]);
  });

  it('refuses the same key with a different body instead of returning the first request', async () => {
    await create(tenant.userId, 'reuse-key-0001', tenant.mandateId, '40 name tags');
    expect(await create(tenant.userId, 'reuse-key-0001', tenant.mandateId, '400 name tags')).toEqual({ ok: false, reason: 'REQUEST_KEY_REUSED' });
    // Same organization, another mandate: still a different body, so still refused.
    const second = await db.pool.query<{ id: string }>(
      `INSERT INTO mandate (organization_id, approver_user_id, name, currency, budget_minor_units, per_item_cap_minor_units,
                            approval_threshold_minor_units, max_quantity_per_line, structuring_window_minutes, price_drift_tolerance_bps,
                            starts_at, ends_at, policy_version)
       SELECT organization_id, approver_user_id, 'Second mandate', currency, budget_minor_units, per_item_cap_minor_units,
              approval_threshold_minor_units, max_quantity_per_line, structuring_window_minutes, price_drift_tolerance_bps,
              starts_at, ends_at, policy_version
         FROM mandate WHERE id = $1 RETURNING id`,
      [tenant.mandateId],
    );
    expect(await create(tenant.userId, 'reuse-key-0001', second.rows[0]?.id ?? '', '40 name tags')).toEqual({ ok: false, reason: 'REQUEST_KEY_REUSED' });
  });

  it('lets two requesters use the same key independently', async () => {
    const other = await createMandate(db.pool, 10_000);
    const a = await create(tenant.userId, 'shared-key-0002', tenant.mandateId, 'pens');
    const b = await create(other.userId, 'shared-key-0002', other.mandateId, 'paper');
    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toMatchObject({ ok: true, created: true });
    expect(a.ok && b.ok && a.requestId !== b.requestId).toBe(true);
  });

  it('refuses a requester from another organization, and an unknown mandate', async () => {
    const outsider = await createMandate(db.pool, 10_000);
    expect(await create(outsider.userId, 'outsider-0001', tenant.mandateId, 'x')).toEqual({ ok: false, reason: 'REQUESTER_NOT_IN_ORGANIZATION' });
    expect(await create(tenant.userId, 'nomandate-0001', '00000000-0000-4000-8000-00000000dead', 'x')).toEqual({ ok: false, reason: 'MANDATE_NOT_FOUND' });
  });

  it('settles a concurrent double submit into one request', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create(tenant.userId, 'race-key-0001', tenant.mandateId, 'hdmi cable')));
    const ids = new Set(results.map((r) => (r.ok ? r.requestId : r.reason)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
  });

  it('validates the key and text before touching the database', async () => {
    await expect(create(tenant.userId, 'short', tenant.mandateId, 'x')).rejects.toThrow(RangeError);
    await expect(create(tenant.userId, 'empty-text-0001', tenant.mandateId, '')).rejects.toThrow(RangeError);
  });

  // Second review nits: the mandate id's case, and length in characters as Postgres counts them.
  it('treats the same mandate id in upper case as the same body on retry', async () => {
    const first = await create(tenant.userId, 'case-key-0001', tenant.mandateId, 'stapler');
    const retry = await create(tenant.userId, 'case-key-0001', tenant.mandateId.toUpperCase(), 'stapler');
    expect(retry).toEqual({ ok: true, created: false, requestId: first.ok ? first.requestId : '' });
  });

  it('counts characters, not UTF-16 units: 4000 emoji fit the column and are accepted', async () => {
    const text = '\u{1F4CE}'.repeat(4_000); // 8000 UTF-16 units
    expect(await create(tenant.userId, 'emoji-key-0001', tenant.mandateId, text)).toMatchObject({ ok: true, created: true });
    await expect(create(tenant.userId, 'emoji-key-0002', tenant.mandateId, `${text}x`)).rejects.toThrow(RangeError);
  });
});
