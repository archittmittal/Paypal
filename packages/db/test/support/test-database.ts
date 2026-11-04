import { randomBytes } from 'node:crypto';
import { type DatabaseConfig, loadDatabaseConfig, Secret, withCredentials, withDatabase } from '../../src/config.js';
import { migrate } from '../../src/migrations.js';
import { recordVerifiedCapture } from '../../src/orders.js';
import { createClient, createPool, type Pool, type Queryable, withTransaction } from '../../src/pool.js';
import { requestBodyHash } from '../../src/requests.js';
import { LARGE_OBJECT_CREATORS, provisionLoginRole } from '../../src/roles.js';

export interface TestDatabase {
  config: DatabaseConfig;
  pool: Pool;
  drop: () => Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The server test databases are created on. Refuses anything but loopback unless MANDATE_TEST_DB_ALLOW_REMOTE=1,
 * so a DATABASE_URL pointing at a shared or production server is never used for CREATE/DROP DATABASE.
 */
export function testServerConfig(): DatabaseConfig {
  const config = loadDatabaseConfig(process.env, 'admin');
  const host = new URL(config.connectionString.reveal()).hostname;
  if (!LOOPBACK.has(host) && process.env['MANDATE_TEST_DB_ALLOW_REMOTE'] !== '1') {
    throw new Error(`refusing to create test databases on ${config.target}: not a loopback host (set MANDATE_TEST_DB_ALLOW_REMOTE=1 to override)`);
  }
  return config;
}

/**
 * Creates a uniquely named database on the configured server (docker compose by default), optionally migrated.
 * Needs a role with CREATEDB (and CREATEROLE for migration 0005 the first time), which the compose superuser has.
 */
export async function createTestDatabase(options: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const base = testServerConfig();
  const name = `mandate_test_${randomBytes(6).toString('hex')}`;
  await admin(base, `CREATE DATABASE ${name}`);
  const config = withDatabase(base, name);
  if (options.migrated !== false) {
    await migrate(config);
    // As a deployment would after migrating as a non-superuser (CI): `pnpm db:harden`. A no-op where 0007 did it.
    await superuser(`REVOKE EXECUTE ON FUNCTION ${LARGE_OBJECT_CREATORS.join(', ')} FROM PUBLIC`, name);
  }
  const pool = createPool(config, { applicationName: 'mandate-test' });
  return {
    config,
    pool,
    drop: async () => {
      await pool.end();
      await admin(base, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/**
 * A superuser connection to the test server, for the few tests that must set up what only a superuser can (granting
 * predefined pg_* roles). MANDATE_TEST_SUPERUSER_URL when set (CI, where migrations run as a non-superuser), else the
 * admin connection, which must then be a superuser: the test fails rather than skip.
 */
export async function superuser(sql: string, database?: string): Promise<void> {
  const url = process.env['MANDATE_TEST_SUPERUSER_URL'];
  const base = testServerConfig();
  const server = url === undefined || url === '' ? base : { ...base, connectionString: new Secret(url), target: 'superuser' };
  const config = database === undefined ? server : withDatabase(server, database);
  const client = createClient(config, 'mandate-test-superuser');
  await client.connect();
  try {
    const { rows } = await client.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (rows[0]?.rolsuper !== true) throw new Error('this test needs a superuser: set MANDATE_TEST_SUPERUSER_URL');
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function admin(config: DatabaseConfig, sql: string): Promise<void> {
  const client = createClient(config, 'mandate-test-admin');
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export interface RuntimeConnection {
  role: string;
  pool: Pool;
  drop: () => Promise<void>;
}

/** A fresh LOGIN role, member of mandate_runtime only, and a pool connected as it. Roles are server-wide: drop it. */
export async function connectAsRuntimeRole(db: TestDatabase): Promise<RuntimeConnection> {
  const role = `mandate_test_app_${randomBytes(5).toString('hex')}`;
  const password = randomBytes(24).toString('base64url');
  const client = createClient(db.config, 'mandate-test-admin');
  await client.connect();
  try {
    await provisionLoginRole(client, role, password);
  } finally {
    await client.end();
  }
  const pool = createPool(withCredentials(db.config, role, password), { applicationName: 'mandate-test-runtime', onError: () => undefined });
  return {
    role,
    pool,
    drop: async () => {
      await pool.end();
      await admin(db.config, `DROP ROLE IF EXISTS ${role}`);
    },
  };
}

let counter = 0;
const key = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}_${++counter}`;

export interface MandateFixture {
  organizationId: string;
  /** The mandate's approver. */
  userId: string;
  /** A requester in the same organization, who raises the fixture's purchase requests. */
  requesterId: string;
  mandateId: string;
}

/** Adds a user with the given role to an organization. */
export async function createUser(db: Queryable, organizationId: string, role: 'requester' | 'approver' | 'admin' | 'owner'): Promise<string> {
  const user = await db.query<{ id: string }>(`INSERT INTO app_user (organization_id, email, role) VALUES ($1, $2, $3) RETURNING id`, [
    organizationId,
    `${key(role)}@example.test`,
    role,
  ]);
  return user.rows[0]?.id ?? '';
}

/**
 * An organization, one approver, one requester and one mandate active from yesterday for a year, with the given
 * budget. Written by the owner connection, as onboarding would.
 */
export async function createMandate(db: Queryable, budgetMinor: number, currency = 'USD'): Promise<MandateFixture> {
  const org = await db.query<{ id: string }>(`INSERT INTO organization (name, default_currency) VALUES ('Test org', $1) RETURNING id`, [currency]);
  const organizationId = org.rows[0]?.id ?? '';
  const userId = await createUser(db, organizationId, 'approver');
  const requesterId = await createUser(db, organizationId, 'requester');
  const mandate = await db.query<{ id: string }>(
    `INSERT INTO mandate (organization_id, approver_user_id, name, currency, budget_minor_units, per_item_cap_minor_units,
                          approval_threshold_minor_units, max_quantity_per_line, structuring_window_minutes,
                          price_drift_tolerance_bps, starts_at, ends_at, policy_version)
     VALUES ($1, $2, 'Test mandate', $3, $4, $4, $4, 100, 1440, 200, now() - interval '1 day', now() + interval '1 year', 'test')
     RETURNING id`,
    [organizationId, userId, currency, budgetMinor],
  );
  return { organizationId, userId, requesterId, mandateId: mandate.rows[0]?.id ?? '' };
}

export interface DecisionFixture {
  requestId: string;
  cartId: string;
  decisionId: string;
}

/** A purchase request, its cart and a policy decision: the rows a reservation hangs off. */
export async function createDecisionRows(
  db: Queryable,
  fixture: MandateFixture,
  totalMinor: number,
  options: { currency?: string; outcome?: 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY' } = {},
): Promise<DecisionFixture> {
  const currency = options.currency ?? 'USD';
  const rawText = 'test request';
  const request = await db.query<{ id: string }>(
    `INSERT INTO purchase_request (organization_id, mandate_id, requester_user_id, raw_text, request_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [fixture.organizationId, fixture.mandateId, fixture.requesterId, rawText, key('req'), requestBodyHash({ mandateId: fixture.mandateId, rawText })],
  );
  const requestId = request.rows[0]?.id ?? '';
  const cart = await db.query<{ id: string }>(
    `INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, quoted_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [requestId, currency, totalMinor],
  );
  const cartId = cart.rows[0]?.id ?? '';
  const decision = await db.query<{ id: string }>(
    `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
     VALUES ($1, $2, $3, '[]', 'test', $4, $5, now()) RETURNING id`,
    [requestId, cartId, options.outcome ?? 'ALLOW', totalMinor, currency],
  );
  return { requestId, cartId, decisionId: decision.rows[0]?.id ?? '' };
}

/** createDecisionRows, returning only the decision id. */
export async function createDecision(db: Queryable, fixture: MandateFixture, totalMinor: number, currency = 'USD'): Promise<string> {
  return (await createDecisionRows(db, fixture, totalMinor, { currency })).decisionId;
}

export async function activeReservedTotal(db: Queryable, mandateId: string): Promise<number> {
  const { rows } = await db.query<{ total: number }>('SELECT public.mandate_active_total($1) AS total', [mandateId]);
  return rows[0]?.total ?? 0;
}

/** Resolves once the given backend is waiting on a lock, proving two transactions really contended. */
export async function waitUntilBlockedOnLock(db: Queryable, pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ wait_event_type: string | null }>('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

export const inOneHour = () => new Date(Date.now() + 3_600_000);

/** Inserts the PAYMENT_PENDING order that pays for a decision (it needs a covering HELD reservation first). */
export async function placeOrder(db: Queryable, rows: { requestId: string; decisionId: string }, amountMinor: number, approvalId: string | null = null): Promise<string> {
  const order = await db.query<{ id: string }>(
    `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, approval_id, idempotency_key, payment_variant, amount_minor_units, currency)
     VALUES ($1, $2, $3, $4, 'APPROVAL_LINK', $5, 'USD') RETURNING id`,
    [rows.requestId, rows.decisionId, approvalId, key('order'), amountMinor],
  );
  return order.rows[0]?.id ?? '';
}

/** Records a COMPLETED PayPal capture of the order's full amount and commits its hold, as the payments flow would. */
export async function captureOrder(pool: Pool, orderId: string, amountMinor: number): Promise<void> {
  const result = await withTransaction(pool, (c) =>
    recordVerifiedCapture(c, orderId, { providerOrderId: key('PP'), captureId: key('CAP'), status: 'COMPLETED', amount: { amountMinor, currency: 'USD' } }),
  );
  if (!result.ok) throw new Error(`capture setup failed: ${result.reason}`);
}
