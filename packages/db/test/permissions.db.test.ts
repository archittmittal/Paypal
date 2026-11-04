import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCredentials } from '../src/config.js';
import { adminCreateMandate, adminRemoveCategoryLimit, adminSetCategoryLimit, adminUpdateMandate, type MandateSettings } from '../src/mandates.js';
import { recordVerifiedCapture } from '../src/orders.js';
import { createClient, SQLSTATE, sqlState, withTransaction } from '../src/pool.js';
import { createPurchaseRequest } from '../src/requests.js';
import { reserveBudget } from '../src/reservations.js';
import { provisionLoginRole, publicConnectDatabases, restrictPublicConnect, RoleProvisioningError, RUNTIME_ROLE, runtimeRoleProblems } from '../src/roles.js';
import {
  admin,
  connectAsRuntimeRole,
  superuser,
  createMandate,
  createTestDatabase,
  createUser,
  inOneHour,
  type MandateFixture,
  type RuntimeConnection,
  type TestDatabase,
} from './support/test-database.js';

// Review finding M5: the application connects as a LOGIN role that is only a member of mandate_runtime
// (migration 0005). Every test below runs real statements as that role.

let db: TestDatabase;
let app: RuntimeConnection;
let tenant: MandateFixture;
let owner: string;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await connectAsRuntimeRole(db);
  tenant = await createMandate(db.pool, 10_000); // written by the owner, as onboarding would
  owner = (await db.pool.query<{ owner: string }>('SELECT current_user AS owner')).rows[0]?.owner ?? '';
});

afterAll(async () => {
  await app.drop();
  await db.drop();
});

const PERMISSION_DENIED = '42501';

describe('runtime role: the purchase path works with least privilege', () => {
  it('raises a request, prices it, decides, reserves, orders and audits', async () => {
    const result = await withTransaction(app.pool, async (c) => {
      const request = await createPurchaseRequest(c, { requesterUserId: tenant.userId, requestKey: 'runtime-path-0001', body: { mandateId: tenant.mandateId, rawText: 'name tags' } });
      if (!request.ok) throw new Error(request.reason);
      const cart = await c.query<{ id: string }>(`INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, quoted_at) VALUES ($1, 'USD', 500, now()) RETURNING id`, [request.requestId]);
      const decision = await c.query<{ id: string }>(
        `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
         VALUES ($1, $2, 'ALLOW', '[]', 'test', 500, 'USD', now()) RETURNING id`,
        [request.requestId, cart.rows[0]?.id],
      );
      const decisionId = decision.rows[0]?.id ?? '';
      const hold = await reserveBudget(c, { mandateId: tenant.mandateId, policyDecisionId: decisionId, amount: { amountMinor: 500, currency: 'USD' }, expiresAt: inOneHour() });
      const order = await c.query<{ id: string }>(
        `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, idempotency_key, payment_variant, amount_minor_units, currency)
         VALUES ($1, $2, 'runtime-order-0001', 'APPROVAL_LINK', 500, 'USD') RETURNING id`,
        [request.requestId, decisionId],
      );
      await c.query(`INSERT INTO order_event (order_id, event_type, to_state, occurred_at) VALUES ($1, 'payment.started', 'PAYMENT_PENDING', now())`, [order.rows[0]?.id]);
      await c.query(`INSERT INTO audit_log (organization_id, actor_type, action, subject_type, subject_id) VALUES ($1, 'agent', 'order.created', 'purchase_order', $2)`, [
        tenant.organizationId,
        order.rows[0]?.id,
      ]);
      const captured = await recordVerifiedCapture(c, order.rows[0]?.id ?? '', {
        providerOrderId: 'PAYPAL1',
        captureId: 'CAPTURE1',
        status: 'COMPLETED',
        amount: { amountMinor: 500, currency: 'USD' },
      });
      return { hold, captured };
    });
    expect(result.hold.ok).toBe(true);
    expect(result.captured).toEqual({ ok: true, alreadyRecorded: false });
  });

  it('passes its own least-privilege check, and the owner connection does not', async () => {
    const client = await app.pool.connect();
    try {
      expect(await runtimeRoleProblems(client)).toEqual([]);
    } finally {
      client.release();
    }
    const ownerClient = await db.pool.connect();
    try {
      // Superuser locally, the owning non-superuser migration role in CI: either way it is not least privilege.
      expect(await runtimeRoleProblems(ownerClient)).toEqual(expect.arrayContaining([expect.stringMatching(/superuser|owns/)]));
    } finally {
      ownerClient.release();
    }
  });
});

describe('runtime role: what it must not be able to do', () => {
  let auditId: string;

  beforeAll(async () => {
    const { rows } = await app.pool.query<{ id: string }>(
      `INSERT INTO audit_log (organization_id, actor_type, action, subject_type) VALUES ($1, 'agent', 'probe', 'test') RETURNING id`,
      [tenant.organizationId],
    );
    auditId = rows[0]?.id ?? '';
  });

  it.each([
    ['UPDATE audit_log', `UPDATE audit_log SET action = 'rewritten'`],
    ['DELETE FROM audit_log', 'DELETE FROM audit_log'],
    ['TRUNCATE audit_log', 'TRUNCATE audit_log'],
    ['UPDATE order_event', `UPDATE order_event SET event_type = 'rewritten'`],
    ['DELETE FROM order_event', 'DELETE FROM order_event'],
    ['TRUNCATE order_event', 'TRUNCATE order_event'],
    ['DELETE FROM budget_reservation', 'DELETE FROM budget_reservation'],
    ['disable the append-only trigger', 'ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only'],
    ['disable the budget trigger', 'ALTER TABLE budget_reservation DISABLE TRIGGER ALL'],
    ['rewrite a column with ALTER ... USING', `ALTER TABLE audit_log ALTER COLUMN detail TYPE jsonb USING '{}'::jsonb`],
    ['take ownership of a table', `ALTER TABLE audit_log OWNER TO CURRENT_USER`],
    ['drop a table', 'DROP TABLE audit_log'],
    ['bypass triggers with session_replication_role', 'SET session_replication_role = replica'],
    ['become the owner', () => `SET ROLE "${owner}"`],
    ['grant itself superuser', 'ALTER ROLE CURRENT_USER SUPERUSER'],
    ['create a temp table (the H2 shadowing attack)', 'CREATE TEMP TABLE budget_reservation (mandate_id uuid)'],
    ['create a table', 'CREATE TABLE public.sneaky (id int)'],
    ['edit migration history', `UPDATE schema_migrations SET checksum = 'x'`],
    ['edit evidence columns of a request', `UPDATE purchase_request SET raw_text = 'rewritten'`],
    ['edit a reservation amount', 'UPDATE budget_reservation SET amount_minor_units = 0'],
    ['edit the snapshot price', 'UPDATE product_snapshot SET unit_price_minor_units = 0'],
    ['create organizations', `INSERT INTO organization (name, default_currency) VALUES ('x', 'USD')`],
    // Second review M2: budgets, caps, approvers and category limits change only through the admin functions.
    ['raise a budget directly', 'UPDATE mandate SET budget_minor_units = 9007199254740991'],
    ['reassign an approver directly', () => `UPDATE mandate SET approver_user_id = '${tenant.requesterId}'`],
    ['create a mandate directly', () => `INSERT INTO mandate (id) VALUES ('${tenant.mandateId}')`],
    ['add a category limit directly', () => `INSERT INTO category_limit (mandate_id, category, allowed) VALUES ('${tenant.mandateId}', 'x', true)`],
    ['loosen a category limit directly', 'UPDATE category_limit SET allowed = true'],
    ['delete a category limit directly', 'DELETE FROM category_limit'],
    ['call the internal authorization helper', () => `SELECT public.mandate_admin_authorize('${tenant.userId}', '${tenant.organizationId}')`],
    ['promote a user', `UPDATE app_user SET role = 'admin'`],
  ])('cannot %s', async (_label, sql) => {
    await expect(app.pool.query(typeof sql === 'function' ? sql() : sql)).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it('left the probe row untouched', async () => {
    const { rows } = await db.pool.query<{ action: string }>('SELECT action FROM audit_log WHERE id = $1', [auditId]);
    expect(rows).toEqual([{ action: 'probe' }]);
  });
});

describe('privilege matrix', () => {
  // A new table fails this test until its runtime privileges are decided in a migration and listed here.
  const EXPECTED: Record<string, string> = {
    app_user: 'SELECT',
    approval: 'SELECT INSERT UPDATE',
    audit_log: 'SELECT INSERT',
    budget_reservation: 'SELECT INSERT UPDATE',
    cart: 'SELECT INSERT',
    cart_item: 'SELECT INSERT',
    category_limit: 'SELECT',
    mandate: 'SELECT UPDATE', // UPDATE on updated_at only, for row locks; see the column test below
    order_event: 'SELECT INSERT',
    organization: 'SELECT',
    policy_decision: 'SELECT INSERT',
    product_snapshot: 'SELECT INSERT',
    purchase_order: 'SELECT INSERT UPDATE',
    purchase_request: 'SELECT INSERT UPDATE',
    refund: 'SELECT INSERT UPDATE',
    schema_migrations: 'SELECT',
    webhook_event: 'SELECT INSERT UPDATE',
  };

  it('grants mandate_runtime exactly the expected privileges on every table, and never TRUNCATE, REFERENCES or TRIGGER', async () => {
    const { rows } = await db.pool.query<{ table_name: string; privileges: string }>(
      `SELECT c.relname AS table_name,
              concat_ws(' ',
                CASE WHEN has_table_privilege($1, c.oid, 'SELECT') THEN 'SELECT' END,
                CASE WHEN has_table_privilege($1, c.oid, 'INSERT') THEN 'INSERT' END,
                CASE WHEN has_any_column_privilege($1, c.oid, 'UPDATE') THEN 'UPDATE' END,
                CASE WHEN has_table_privilege($1, c.oid, 'DELETE') THEN 'DELETE' END,
                CASE WHEN has_table_privilege($1, c.oid, 'TRUNCATE') THEN 'TRUNCATE' END,
                CASE WHEN has_table_privilege($1, c.oid, 'REFERENCES') THEN 'REFERENCES' END,
                CASE WHEN has_table_privilege($1, c.oid, 'TRIGGER') THEN 'TRIGGER' END) AS privileges
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`,
      [RUNTIME_ROLE],
    );
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.privileges]))).toEqual(EXPECTED);
  });
});

describe('privilege matrix: columns and functions', () => {
  it('lets mandate_runtime update only updated_at on mandate, and evidence plus state on purchase_order', async () => {
    const { rows } = await db.pool.query<{ table_name: string; columns: string }>(
      `SELECT c.relname AS table_name, string_agg(a.attname, ' ' ORDER BY a.attname) AS columns
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relname IN ('mandate', 'purchase_order', 'refund') AND c.relnamespace = 'public'::regnamespace
          AND has_column_privilege($1, c.oid, a.attnum, 'UPDATE')
        GROUP BY c.relname ORDER BY c.relname`,
      [RUNTIME_ROLE],
    );
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.columns.split(' ').sort()]))).toEqual({
      mandate: ['updated_at'],
      purchase_order: ['capture_status', 'captured_amount_minor_units', 'captured_currency', 'provider_capture_id', 'provider_order_id', 'state'],
      refund: ['provider_refund_id', 'provider_status', 'status'],
    });
  });

  it('lets only mandate_runtime run the admin functions, never PUBLIC', async () => {
    const { rows } = await db.pool.query<{ proname: string; runtime: boolean; public: boolean }>(
      `SELECT p.proname, has_function_privilege($1, p.oid, 'EXECUTE') AS runtime, has_function_privilege('public', p.oid, 'EXECUTE') AS public
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'admin\\_%' OR p.proname = 'mandate_admin_authorize')
        ORDER BY p.proname`,
      [RUNTIME_ROLE],
    );
    expect(rows).toEqual([
      { proname: 'admin_create_mandate', runtime: true, public: false },
      { proname: 'admin_remove_category_limit', runtime: true, public: false },
      { proname: 'admin_set_category_limit', runtime: true, public: false },
      { proname: 'admin_set_user_role', runtime: true, public: false },
      { proname: 'admin_update_mandate', runtime: true, public: false },
      { proname: 'mandate_admin_authorize', runtime: false, public: false },
    ]);
  });
});

describe('mandate administration through the runtime role (second review finding M2)', () => {
  let adminId: string;
  let ownerId: string;
  let foreignAdmin: string;
  const settings = (overrides: Partial<MandateSettings> = {}): MandateSettings => ({
    approverUserId: tenant.userId,
    name: 'Admin-made',
    currency: 'USD',
    budgetMinor: 5_000,
    perItemCapMinor: 1_000,
    approvalThresholdMinor: 2_000,
    maxQuantityPerLine: 10,
    structuringWindowMinutes: 60,
    priceDriftToleranceBps: 100,
    startsAt: new Date(Date.now() - 86_400_000),
    endsAt: new Date(Date.now() + 86_400_000 * 30),
    policyVersion: 'test',
    ...overrides,
  });

  beforeAll(async () => {
    adminId = await createUser(db.pool, tenant.organizationId, 'admin');
    ownerId = await createUser(db.pool, tenant.organizationId, 'owner');
    const elsewhere = await createMandate(db.pool, 1_000);
    foreignAdmin = await createUser(db.pool, elsewhere.organizationId, 'admin');
  });

  it.each([
    ['a requester (their own spending permissions)', () => tenant.requesterId],
    ['an approver', () => tenant.userId],
    ['an admin of another organization', () => foreignAdmin],
    ['nobody (unknown id)', () => '00000000-0000-4000-8000-0000000000ff'],
  ])('refuses %s', async (_label, actor) => {
    await expect(adminCreateMandate(app.pool, actor(), tenant.organizationId, settings())).rejects.toMatchObject({ code: SQLSTATE.NOT_AUTHORIZED });
    await expect(adminUpdateMandate(app.pool, actor(), tenant.mandateId, { ...settings({ budgetMinor: 999_999 }), status: 'ACTIVE' })).rejects.toMatchObject({
      code: SQLSTATE.NOT_AUTHORIZED,
    });
    await expect(adminSetCategoryLimit(app.pool, actor(), tenant.mandateId, { category: 'gift_cards', allowed: true, capMinor: null })).rejects.toMatchObject({
      code: SQLSTATE.NOT_AUTHORIZED,
    });
    await expect(adminRemoveCategoryLimit(app.pool, actor(), tenant.mandateId, 'gift_cards')).rejects.toMatchObject({ code: SQLSTATE.NOT_AUTHORIZED });
    const { rows } = await db.pool.query<{ budget: number }>('SELECT budget_minor_units AS budget FROM mandate WHERE id = $1', [tenant.mandateId]);
    expect(rows[0]?.budget).toBe(10_000);
  });

  it('lets an admin and an owner manage mandates and limits, auditing each change under their user id', async () => {
    const created = await withTransaction(app.pool, (c) => adminCreateMandate(c, adminId, tenant.organizationId, settings()));
    await withTransaction(app.pool, (c) => adminUpdateMandate(c, ownerId, created, { ...settings({ budgetMinor: 6_000 }), status: 'PAUSED' }));
    await withTransaction(app.pool, (c) => adminSetCategoryLimit(c, adminId, created, { category: 'books', allowed: true, capMinor: 500 }));
    expect(await withTransaction(app.pool, (c) => adminRemoveCategoryLimit(c, adminId, created, 'books'))).toBe(true);
    expect(await withTransaction(app.pool, (c) => adminRemoveCategoryLimit(c, adminId, created, 'books'))).toBe(false);

    const { rows } = await db.pool.query<{ action: string; actor_type: string; actor_id: string }>(
      `SELECT action, actor_type, actor_id FROM audit_log WHERE subject_type = 'mandate' AND subject_id = $1 ORDER BY created_at, id`,
      [created],
    );
    expect(rows).toEqual([
      { action: 'mandate.insert', actor_type: 'user', actor_id: adminId },
      { action: 'mandate.update', actor_type: 'user', actor_id: ownerId },
      { action: 'category_limit.insert', actor_type: 'user', actor_id: adminId },
      { action: 'category_limit.delete', actor_type: 'user', actor_id: adminId },
    ]);
    const mandate = await db.pool.query<{ status: string; budget: number }>('SELECT status, budget_minor_units AS budget FROM mandate WHERE id = $1', [created]);
    expect(mandate.rows[0]).toEqual({ status: 'PAUSED', budget: 6_000 });
  });

  it('refuses an approver outside the organization or with the requester role, even for an admin', async () => {
    const elsewhere = await createMandate(db.pool, 1_000);
    await expect(adminCreateMandate(app.pool, adminId, tenant.organizationId, settings({ approverUserId: elsewhere.userId }))).rejects.toMatchObject({
      code: SQLSTATE.APPROVER_NOT_ELIGIBLE,
    });
    await expect(adminCreateMandate(app.pool, adminId, tenant.organizationId, settings({ approverUserId: tenant.requesterId }))).rejects.toMatchObject({
      code: SQLSTATE.APPROVER_NOT_ELIGIBLE,
    });
  });

  it('still refuses a budget cut below held spend, for an admin too', async () => {
    const created = await withTransaction(app.pool, (c) => adminCreateMandate(c, adminId, tenant.organizationId, settings({ budgetMinor: 1_000 })));
    await db.pool.query(
      `INSERT INTO purchase_request (organization_id, mandate_id, requester_user_id, raw_text, request_key, request_hash) VALUES ($1, $2, $3, 'x', 'admin-cut-0001', $4)`,
      [tenant.organizationId, created, tenant.requesterId, '0'.repeat(64)],
    );
    const req = (await db.pool.query<{ id: string }>(`SELECT id FROM purchase_request WHERE request_key = 'admin-cut-0001'`)).rows[0]?.id;
    const cart = (await db.pool.query<{ id: string }>(`INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, quoted_at) VALUES ($1, 'USD', 800, now()) RETURNING id`, [req])).rows[0]?.id;
    const decision = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at) VALUES ($1, $2, 'ALLOW', '[]', 't', 800, 'USD', now()) RETURNING id`,
        [req, cart],
      )
    ).rows[0]?.id ?? '';
    await withTransaction(app.pool, (c) => reserveBudget(c, { mandateId: created, policyDecisionId: decision, amount: { amountMinor: 800, currency: 'USD' }, expiresAt: inOneHour() }));
    await expect(withTransaction(app.pool, (c) => adminUpdateMandate(c, adminId, created, { ...settings({ budgetMinor: 799 }), status: 'ACTIVE' }))).rejects.toMatchObject({
      code: SQLSTATE.BUDGET_EXCEEDED,
    });
  });

  it('lets the runtime touch updated_at (needed for row locks) without changing anything or writing an audit entry', async () => {
    const before = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE subject_id = $1', [tenant.mandateId]);
    await app.pool.query(`UPDATE mandate SET updated_at = '2000-01-01Z' WHERE id = $1`, [tenant.mandateId]);
    const after = await db.pool.query<{ n: number; recent: boolean }>(
      `SELECT (SELECT count(*)::int FROM audit_log WHERE subject_id = $1) AS n, (SELECT updated_at > now() - interval '1 minute' FROM mandate WHERE id = $1) AS recent`,
      [tenant.mandateId],
    );
    expect(after.rows[0]).toEqual({ n: before.rows[0]?.n, recent: true });
  });
});

describe('the runtime role\'s reach (second review finding M4)', () => {
  it('has CONNECT on this database through mandate_runtime, and PUBLIC does not', async () => {
    const { rows } = await db.pool.query<{ public_connect: boolean; runtime_connect: boolean }>(
      `SELECT has_database_privilege('public', current_database(), 'CONNECT') AS public_connect,
              has_database_privilege($1, current_database(), 'CONNECT') AS runtime_connect`,
      [RUNTIME_ROLE],
    );
    expect(rows[0]).toEqual({ public_connect: false, runtime_connect: true });
  });

  it('refuses a login role that is not in mandate_runtime', async () => {
    const role = `mandate_test_outsider_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(24).toString('base64url');
    await admin(db.config, `CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    try {
      const outsider = createClient(withCredentials(db.config, role, password), 'mandate-test-outsider');
      await expect(outsider.connect()).rejects.toMatchObject({ code: '42501' });
      await outsider.end().catch(() => undefined);
    } finally {
      await admin(db.config, `DROP ROLE ${role}`);
    }
  });
});

describe('login role provisioning: exact membership allowlist (second review findings M1, L6)', () => {
  const fresh = () => `mandate_test_prov_${randomBytes(4).toString('hex')}`;
  const password = () => randomBytes(24).toString('base64url');
  const withAdmin = async <T>(work: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> => {
    const client = createClient(db.config, 'mandate-test-admin');
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const membershipsOf = (role: string) =>
    withAdmin(async (c) =>
      (
        await c.query<{ name: string }>(
          `SELECT g.rolname AS name FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = $1::regrole ORDER BY 1`,
          [role],
        )
      ).rows.map((r) => r.name),
    );

  it('revokes a harmless extra membership and ends with mandate_runtime only', async () => {
    const role = fresh();
    const extra = fresh();
    await admin(db.config, `CREATE ROLE ${extra} NOLOGIN; CREATE ROLE ${role} LOGIN; GRANT ${extra} TO ${role}`);
    try {
      const result = await withAdmin((c) => provisionLoginRole(c, role, password()));
      expect(result).toMatchObject({ created: false, revokedMemberships: [extra] });
      expect(await membershipsOf(role)).toEqual([RUNTIME_ROLE]);
    } finally {
      await admin(db.config, `DROP ROLE IF EXISTS ${role}; DROP ROLE IF EXISTS ${extra}`);
    }
  });

  it.each([
    ['a member of pg_write_server_files', (role: string) => `CREATE ROLE ${role} LOGIN; GRANT pg_write_server_files TO ${role}`],
    ['a member of a role that holds pg_read_server_files', (role: string) => `CREATE ROLE ${role}_g NOLOGIN; GRANT pg_read_server_files TO ${role}_g; CREATE ROLE ${role} LOGIN; GRANT ${role}_g TO ${role}`],
    ['a member of a CREATEROLE role', (role: string) => `CREATE ROLE ${role}_g NOLOGIN CREATEROLE; CREATE ROLE ${role} LOGIN; GRANT ${role}_g TO ${role}`],
    ['CREATEDB', (role: string) => `CREATE ROLE ${role} LOGIN CREATEDB`],
  ])('refuses an existing role that is %s, changing nothing', async (_label, setup) => {
    const role = fresh();
    // Set up as a superuser: granting predefined roles needs one, and CI migrates as a non-superuser.
    await superuser(setup(role));
    try {
      const before = await membershipsOf(role);
      await expect(withAdmin((c) => provisionLoginRole(c, role, password()))).rejects.toBeInstanceOf(RoleProvisioningError);
      expect(await membershipsOf(role)).toEqual(before);
      expect(before).not.toContain(RUNTIME_ROLE);
      const attrs = await withAdmin(async (c) => (await c.query<{ createdb: boolean }>('SELECT rolcreatedb AS createdb FROM pg_roles WHERE rolname = $1', [role])).rows[0]);
      expect(attrs?.createdb).toBe(setup(role).includes('CREATEDB'));
    } finally {
      await superuser(`DROP ROLE IF EXISTS ${role}; DROP ROLE IF EXISTS ${role}_g`);
    }
  });

  it('flags an extra membership, even a harmless one, in runtimeRoleProblems', async () => {
    const extra = fresh();
    await admin(db.config, `CREATE ROLE ${extra} NOLOGIN; GRANT ${extra} TO ${app.role}`);
    try {
      const client = await app.pool.connect();
      try {
        expect(await runtimeRoleProblems(client)).toEqual([expect.stringMatching(new RegExp(`must be a member of ${RUNTIME_ROLE} only.*${extra}`))]);
      } finally {
        client.release();
      }
    } finally {
      await admin(db.config, `DROP ROLE ${extra}`);
    }
  });
});

describe('third review fixes for the runtime role (M3, M4)', () => {
  it('cannot forge an audit entry that looks like an admin change', async () => {
    const adminId = await createUser(db.pool, tenant.organizationId, 'admin');
    await expect(
      app.pool.query(
        `INSERT INTO audit_log (organization_id, actor_type, actor_id, action, subject_type, subject_id, detail)
         VALUES ($1, 'user', $2, 'mandate.update', 'mandate', $3, '{"after":{"budget_minor_units":1}}')`,
        [tenant.organizationId, adminId, tenant.mandateId],
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.NOT_AUTHORIZED });
  });

  it('flags a privilege granted directly to the login role, and provisioning refuses such a role', async () => {
    await admin(db.config, `GRANT TRIGGER ON purchase_order TO ${app.role}`);
    try {
      const client = await app.pool.connect();
      try {
        expect(await runtimeRoleProblems(client)).toEqual([expect.stringMatching(/holds privileges of its own.*purchase_order: TRIGGER/)]);
      } finally {
        client.release();
      }
      const owner = createClient(db.config, 'mandate-test-admin');
      await owner.connect();
      try {
        await expect(provisionLoginRole(owner, app.role, randomBytes(24).toString('base64url'))).rejects.toThrow(/holds privileges of its own/);
      } finally {
        await owner.end();
      }
    } finally {
      await admin(db.config, `REVOKE TRIGGER ON purchase_order FROM ${app.role}`);
    }
  });
});

describe('final verification Low findings', () => {
  const savedSettingsOf = async (role: string) =>
    (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_db_role_setting WHERE setrole = $1::regrole`, [role])).rows[0]?.n;

  it('L1: flags settings the login saved on itself, and re-provisioning removes them', async () => {
    // Its own login: re-provisioning sets a new password, which would break the shared one.
    const own = await connectAsRuntimeRole(db);
    try {
      const database = db.config.target.split('/').pop() ?? '';
      await own.pool.query(`ALTER ROLE CURRENT_USER SET search_path = 'evil'`);
      await own.pool.query(`ALTER ROLE CURRENT_USER IN DATABASE "${database}" SET statement_timeout = 0`);
      expect(await savedSettingsOf(own.role)).toBe(2);
      const client = await own.pool.connect();
      try {
        expect(await runtimeRoleProblems(client)).toEqual([expect.stringMatching(/has saved settings \(all databases, .+\) that apply to every session/)]);
      } finally {
        client.release(true);
      }
      const owner = createClient(db.config, 'mandate-test-admin');
      await owner.connect();
      try {
        const result = await provisionLoginRole(owner, own.role, randomBytes(24).toString('base64url'));
        expect(result.resetSettings).toEqual(['all databases', database]);
      } finally {
        await owner.end();
      }
      expect(await savedSettingsOf(own.role)).toBe(0);
    } finally {
      await own.drop();
    }
  });

  it('L2: lists other databases open to PUBLIC, and restrictPublicConnect closes one', async () => {
    const other = `mandate_test_pub_${randomBytes(4).toString('hex')}`;
    await admin(db.config, `CREATE DATABASE ${other}`);
    try {
      expect(await publicConnectDatabases(db.pool)).toContain(other);
      // Mandate databases grant CONNECT to mandate_runtime, not PUBLIC, so this one is never listed.
      expect(await publicConnectDatabases(db.pool)).not.toContain(db.config.target.split('/').pop());
      await restrictPublicConnect(db.pool, [other]);
      expect(await publicConnectDatabases(db.pool)).not.toContain(other);
    } finally {
      await admin(db.config, `DROP DATABASE IF EXISTS ${other} WITH (FORCE)`);
    }
  });

  it.each(['APP_USER.role_change', ' app_user.role_change', 'app_user.role_change ', 'Mandate.update', 'mandate..update', 'mandate-update'])(
    'L3: refuses the look-alike audit action %j',
    async (action) => {
      const ownerId = await createUser(db.pool, tenant.organizationId, 'owner');
      const outcome = await app.pool
        .query(`INSERT INTO audit_log (organization_id, actor_type, actor_id, action, subject_type) VALUES ($1, 'user', $2, $3, 'app_user')`, [
          tenant.organizationId,
          ownerId,
          action,
        ])
        .then(
          () => 'accepted',
          (error: unknown) => sqlState(error),
        );
      // The format check (0008), or the reserved-prefix guard (0007) when the spelling still starts with a reserved prefix.
      expect([SQLSTATE.CHECK_VIOLATION, SQLSTATE.NOT_AUTHORIZED]).toContain(outcome);
      const stored = await db.pool.query('SELECT 1 FROM audit_log WHERE action = $1', [action]);
      expect(stored.rows).toEqual([]);
    },
  );

  it('L3: still accepts ordinary lower-case dotted actions', async () => {
    await app.pool.query(`INSERT INTO audit_log (organization_id, actor_type, action, subject_type) VALUES ($1, 'agent', 'policy.denied', 'purchase_request')`, [
      tenant.organizationId,
    ]);
  });
});
