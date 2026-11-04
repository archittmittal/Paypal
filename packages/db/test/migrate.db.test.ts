import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, MIGRATION_LOCK_KEY, MigrationError, migrate, type MigrationFile, parseMigrations } from '../src/migrations.js';
import { createClient } from '../src/pool.js';
import { hardenDatabase, LARGE_OBJECT_CREATORS, publicLargeObjectCreators } from '../src/roles.js';
import { superuser } from './support/test-database.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

let db: TestDatabase | undefined;

// Everything in packages/db/migrations, so these tests keep working as migrations are added.
const ALL = loadMigrations();
const ALL_NAMES = ALL.map((m) => `${m.version}_${m.name}`);
const ALL_VERSIONS = ALL.map((m) => m.version);
const NEXT_VERSION = String(ALL.length + 1).padStart(4, '0');

afterEach(async () => {
  await db?.drop();
  db = undefined;
});

async function emptyDatabase(): Promise<TestDatabase> {
  db = await createTestDatabase({ migrated: false });
  return db;
}

async function appliedVersions(target: TestDatabase): Promise<string[]> {
  const { rows } = await target.pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
  return rows.map((r) => r.version);
}

describe('migration runner (real Postgres)', () => {
  it('applies every migration to an empty database, then is a no-op', async () => {
    const target = await emptyDatabase();
    const first = await migrate(target.config);
    expect(first).toEqual({ applied: ALL_NAMES, alreadyApplied: 0 });
    expect(await migrate(target.config)).toEqual({ applied: [], alreadyApplied: ALL.length });
    expect(await appliedVersions(target)).toEqual(ALL_VERSIONS);
  });

  it('serializes concurrent runners so each migration is applied exactly once', async () => {
    const target = await emptyDatabase();
    const results = await Promise.all([migrate(target.config), migrate(target.config), migrate(target.config)]);
    expect(results.flatMap((r) => r.applied).sort()).toEqual(ALL_NAMES);
    expect(await appliedVersions(target)).toEqual(ALL_VERSIONS);
  });

  it('rolls a failing migration back completely and leaves earlier ones in place', async () => {
    const target = await emptyDatabase();
    const broken: MigrationFile[] = parseMigrations([
      ...ALL.map((m) => ({ filename: `${m.version}_${m.name}.sql`, sql: m.sql })),
      { filename: `${NEXT_VERSION}_broken.sql`, sql: 'CREATE TABLE half_done (id int); SELECT 1 / 0;' },
    ]);
    await expect(migrate(target.config, { migrations: broken })).rejects.toThrow(new RegExp(`${NEXT_VERSION}_broken failed and was rolled back`));
    expect(await appliedVersions(target)).toEqual(ALL_VERSIONS);
    const { rows } = await target.pool.query(`SELECT to_regclass('public.half_done') AS t`);
    expect(rows[0]).toEqual({ t: null });
  });

  it('refuses to run when an applied migration was edited', async () => {
    const target = await emptyDatabase();
    await migrate(target.config);
    await target.pool.query(`UPDATE schema_migrations SET checksum = 'edited' WHERE version = '0001'`);
    await expect(migrate(target.config)).rejects.toBeInstanceOf(MigrationError);
  });

  it('refuses to run when the database is ahead of this checkout', async () => {
    const target = await emptyDatabase();
    await migrate(target.config);
    await target.pool.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, 'from_another_branch', 'x')`, [NEXT_VERSION]);
    await expect(migrate(target.config)).rejects.toThrow(/does not; update your branch/);
  });
});

describe('migration runner locking and connection loss (review findings L1, M1)', () => {
  it('waits for another runner longer than lock_timeout instead of failing', async () => {
    const target = await emptyDatabase();
    const holder = createClient(target.config, 'mandate-test-holder');
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const started = Date.now();
      const run = migrate(target.config, { lockTimeoutMs: 200 });
      await new Promise((resolve) => setTimeout(resolve, 600)); // three times the lock timeout
      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      expect((await run).applied).toEqual(ALL_NAMES);
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    } finally {
      await holder.end();
    }
  });

  it('rejects, rather than crashing the process, when its connection is killed while it waits', async () => {
    const target = await emptyDatabase();
    const holder = createClient(target.config, 'mandate-test-holder');
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      const run = migrate(target.config).then(
        () => 'migrated',
        () => 'rejected',
      );
      let pid: number | undefined;
      for (let i = 0; i < 200 && pid === undefined; i++) {
        const { rows } = await holder.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE application_name = 'mandate-migrate' AND datname = current_database() AND wait_event_type = 'Lock'`,
        );
        pid = rows[0]?.pid;
        if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pid).toBeDefined();
      await holder.query('SELECT pg_terminate_backend($1)', [pid]);
      expect(await run).toBe('rejected');
      expect(await appliedVersionsOrNone(target)).toEqual([]);
    } finally {
      await holder.end();
    }
  });
});

async function appliedVersionsOrNone(target: TestDatabase): Promise<string[]> {
  const { rows } = await target.pool.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations')::text AS t`);
  return rows[0]?.t === null ? [] : appliedVersions(target);
}

describe('forward migration over existing rows (backfills in 0003 and 0004, refusals in 0006)', () => {
  /** Rows as they would exist in a database still at 0002: requests without organization or hash, a committed hold. */
  async function seedAt0002(target: TestDatabase, crossTenant: boolean): Promise<{ requestId: string; reservationId: string; organizationId: string }> {
    const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await target.pool.query<T>(sql, params)).rows[0] as T;
    const org = await q<{ id: string }>(`INSERT INTO organization (name, default_currency) VALUES ('o', 'USD') RETURNING id`);
    const approver = await q<{ id: string }>(`INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'a@x.test', 'approver') RETURNING id`, [org.id]);
    let requester = approver;
    if (crossTenant) {
      const otherOrg = await q<{ id: string }>(`INSERT INTO organization (name, default_currency) VALUES ('other', 'USD') RETURNING id`);
      requester = await q<{ id: string }>(`INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'b@x.test', 'requester') RETURNING id`, [otherOrg.id]);
    }
    const mandate = await q<{ id: string }>(
      `INSERT INTO mandate (organization_id, approver_user_id, name, currency, budget_minor_units, per_item_cap_minor_units, approval_threshold_minor_units,
                            max_quantity_per_line, structuring_window_minutes, price_drift_tolerance_bps, starts_at, ends_at, policy_version)
       VALUES ($1, $2, 'm', 'USD', 10000, 10000, 10000, 10, 60, 0, now() - interval '1 day', now() + interval '1 year', 't') RETURNING id`,
      [org.id, approver.id],
    );
    const request = await q<{ id: string }>(
      `INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key) VALUES ($1, $2, 'old request', 'old-request-0001') RETURNING id`,
      [mandate.id, requester.id],
    );
    const cart = await q<{ id: string }>(`INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, quoted_at) VALUES ($1, 'USD', 700, now()) RETURNING id`, [request.id]);
    const decision = await q<{ id: string }>(
      `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
       VALUES ($1, $2, 'ALLOW', '[]', 't', 700, 'USD', now()) RETURNING id`,
      [request.id, cart.id],
    );
    const reservation = await q<{ id: string }>(
      `INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, 700, 'USD', now() + interval '1 hour') RETURNING id`,
      [mandate.id, decision.id],
    );
    await target.pool.query(`UPDATE budget_reservation SET state = 'COMMITTED', committed_at = now() WHERE id = $1`, [reservation.id]);
    return { requestId: request.id, reservationId: reservation.id, organizationId: org.id };
  }

  it('backfills organization_id, a never-matching request hash, and the committed amount', async () => {
    const target = await emptyDatabase();
    await migrate(target.config, { migrations: ALL.slice(0, 2) });
    const rows = await seedAt0002(target, false);
    await migrate(target.config, { migrations: ALL.slice(0, 5) });

    const request = await target.pool.query<{ organization_id: string; request_hash: string }>('SELECT organization_id, request_hash FROM purchase_request WHERE id = $1', [rows.requestId]);
    expect(request.rows[0]).toEqual({ organization_id: rows.organizationId, request_hash: '0'.repeat(64) });
    const hold = await target.pool.query<{ committed_amount_minor_units: number }>('SELECT committed_amount_minor_units FROM budget_reservation WHERE id = $1', [rows.reservationId]);
    expect(hold.rows[0]?.committed_amount_minor_units).toBe(700);
  });

  it('fails and rolls back 0003 when an existing request crosses organizations, rather than keep it', async () => {
    const target = await emptyDatabase();
    await migrate(target.config, { migrations: ALL.slice(0, 2) });
    await seedAt0002(target, true);
    await expect(migrate(target.config)).rejects.toThrow(/0003_request_idempotency failed and was rolled back/);
    expect(await appliedVersions(target)).toEqual(['0001', '0002']);
    const { rows } = await target.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_request' AND column_name = 'request_hash'`);
    expect(rows).toEqual([]);
  });

  it('refuses 0006 over a COMMITTED hold that predates capture evidence, naming the rule and changing nothing (L5)', async () => {
    const target = await emptyDatabase();
    await migrate(target.config, { migrations: ALL.slice(0, 2) });
    await seedAt0002(target, false);
    await migrate(target.config, { migrations: ALL.slice(0, 5) });
    const error = await migrate(target.config).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).message).toMatch(/0006_payment_evidence_and_admin failed and was rolled back: migration 0006 refused existing data: 1 reservation\(s\) are COMMITTED/);
    expect(((error as MigrationError).cause as { code?: string }).code).toBe('MD013');
    expect(await appliedVersions(target)).toEqual(['0001', '0002', '0003', '0004', '0005']);
  });

  it('refuses 0006 over rows that break 0004 rules written before 0004 existed (L5)', async () => {
    const target = await emptyDatabase();
    await migrate(target.config, { migrations: ALL.slice(0, 2) });
    const q = async (sql: string, params: unknown[] = []) => (await target.pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
    const org = await q(`INSERT INTO organization (name, default_currency) VALUES ('o', 'USD') RETURNING id`);
    const approver = await q(`INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'a@x.test', 'approver') RETURNING id`, [org]);
    const mandate = await q(
      `INSERT INTO mandate (organization_id, approver_user_id, name, currency, budget_minor_units, per_item_cap_minor_units, approval_threshold_minor_units,
                            max_quantity_per_line, structuring_window_minutes, price_drift_tolerance_bps, starts_at, ends_at, policy_version)
       VALUES ($1, $2, 'm', 'USD', 10000, 10000, 10000, 10, 60, 0, now() - interval '1 day', now() + interval '1 year', 't') RETURNING id`,
      [org, approver],
    );
    const request = await q(`INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key) VALUES ($1, $2, 'x', 'deny-hold-0001') RETURNING id`, [mandate, approver]);
    const cart = await q(`INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, quoted_at) VALUES ($1, 'USD', 100, now()) RETURNING id`, [request]);
    const decision = await q(
      `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
       VALUES ($1, $2, 'DENY', '[]', 't', 100, 'USD', now()) RETURNING id`,
      [request, cart],
    );
    // 0002 checked only the budget, so a hold for a DENY decision was accepted then.
    await q(`INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, 100, 'USD', now() + interval '1 hour') RETURNING id`, [mandate, decision]);
    await expect(migrate(target.config)).rejects.toThrow(/reservation\(s\) do not match their policy decision/);
    expect(await appliedVersions(target)).toEqual(['0001', '0002', '0003', '0004', '0005']);
  });
});

describe('ambiguous COMMIT in the migration runner (second review finding M3)', () => {
  it('says the outcome is unknown when the connection dies during COMMIT, and a rerun settles it', async () => {
    const target = await emptyDatabase();
    // The sequence is not transactional, so only the first attempt sleeps at COMMIT (in a deferred constraint trigger).
    const slow: MigrationFile[] = parseMigrations([
      ...ALL.map((m) => ({ filename: `${m.version}_${m.name}.sql`, sql: m.sql })),
      {
        filename: `${NEXT_VERSION}_slow_commit.sql`,
        sql: `
          CREATE SEQUENCE IF NOT EXISTS slow_commit_attempts;
          CREATE TABLE slow_commit_probe (id int);
          CREATE FUNCTION slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF nextval('slow_commit_attempts') = 1 THEN PERFORM pg_sleep(5); END IF;
            RETURN NULL;
          END $$;
          CREATE CONSTRAINT TRIGGER slow_commit AFTER INSERT ON slow_commit_probe DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION slow_commit();
          INSERT INTO slow_commit_probe VALUES (1);`,
      },
    ]);
    await migrate(target.config); // everything but the slow one
    const run = migrate(target.config, { migrations: slow }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const deadline = Date.now() + 10_000;
    let pid: number | undefined;
    while (pid === undefined) {
      const { rows } = await target.pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name = 'mandate-migrate' AND datname = current_database() AND state = 'active' AND query = 'COMMIT'`,
      );
      pid = rows[0]?.pid;
      if (pid === undefined) {
        if (Date.now() > deadline) throw new Error('COMMIT never started');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await target.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    const error = await run;
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).message).toMatch(new RegExp(`${NEXT_VERSION}_slow_commit: outcome unknown, the connection failed during COMMIT`));
    expect((error as MigrationError).message).not.toMatch(/rolled back/);
    // The server rolled it back here; the rerun the message asks for applies it exactly once.
    expect(await appliedVersions(target)).toEqual(ALL_VERSIONS);
    expect((await migrate(target.config, { migrations: slow })).applied).toEqual([`${NEXT_VERSION}_slow_commit`]);
    expect(await migrate(target.config, { migrations: slow })).toEqual({ applied: [], alreadyApplied: ALL.length + 1 });
  });
});

describe('migration session isolation (third review nit)', () => {
  it('lets no session setting, temp table or role change of one migration reach the next', async () => {
    const target = await emptyDatabase();
    const leaky: MigrationFile[] = parseMigrations([
      ...ALL.map((m) => ({ filename: `${m.version}_${m.name}.sql`, sql: m.sql })),
      {
        filename: `${NEXT_VERSION}_leaky.sql`,
        sql: `SET search_path = pg_temp; SET lock_timeout = 0; SET statement_timeout = 0; SELECT set_config('mandate.leak', 'yes', false);
              CREATE TEMP TABLE leaked (id int); SET application_name = 'leaked';`,
      },
      {
        filename: `${String(ALL.length + 2).padStart(4, '0')}_check.sql`,
        sql: `DO $check$
              BEGIN
                IF coalesce(current_setting('mandate.leak', true), '') <> '' THEN RAISE EXCEPTION 'custom setting leaked'; END IF;
                IF current_setting('search_path') <> '"$user", public' THEN RAISE EXCEPTION 'search_path leaked: %', current_setting('search_path'); END IF;
                IF current_setting('lock_timeout') <> '15s' THEN RAISE EXCEPTION 'lock_timeout not restored: %', current_setting('lock_timeout'); END IF;
                IF current_setting('statement_timeout') <> '10min' THEN RAISE EXCEPTION 'statement_timeout not restored: %', current_setting('statement_timeout'); END IF;
                IF current_setting('application_name') <> 'mandate-migrate' THEN RAISE EXCEPTION 'application_name leaked'; END IF;
                IF to_regclass('pg_temp.leaked') IS NOT NULL THEN RAISE EXCEPTION 'temp table leaked'; END IF;
                IF current_user <> session_user THEN RAISE EXCEPTION 'role leaked'; END IF;
              END $check$;`,
      },
    ]);
    const result = await migrate(target.config, { migrations: leaky });
    expect(result.applied).toHaveLength(ALL.length + 2);
  });
});

describe('large-object hardening in 0007 (third review nit)', () => {
  it('revokes large-object creation when migrating as a superuser, and otherwise leaves it to db:harden', async () => {
    const target = await emptyDatabase();
    const lines: string[] = [];
    await migrate(target.config, { log: (line) => lines.push(line) });
    const { rows } = await target.pool.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    expect(lines.some((l) => /^WARNING: large-object creation is still open/.test(l))).toBe(rows[0]?.rolsuper !== true);
    const open = await publicLargeObjectCreators(target.pool);
    if (rows[0]?.rolsuper === true) {
      expect(open).toEqual([]);
      expect(await hardenDatabase(target.pool)).toEqual([]); // idempotent
    } else {
      expect(open.length).toBeGreaterThan(0); // a non-superuser cannot revoke; the migration warned instead
      await expect(hardenDatabase(target.pool)).rejects.toThrow(/must run as a superuser/);
      // What `pnpm db:harden` does, as the superuser CI provides.
      await superuser(`REVOKE EXECUTE ON FUNCTION ${LARGE_OBJECT_CREATORS.join(', ')} FROM PUBLIC`, target.config.target.split('/').pop() ?? '');
      expect(await publicLargeObjectCreators(target.pool)).toEqual([]);
    }
  });
});

describe('0007 over existing refund states', () => {
  it('refuses an order already in a refund state, changing nothing', async () => {
    const target = await emptyDatabase();
    await migrate(target.config, { migrations: ALL.slice(0, 6) });
    const q = async (sql: string, params: unknown[] = []) => (await target.pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
    const org = await q(`INSERT INTO organization (name, default_currency) VALUES ('o', 'USD') RETURNING id`);
    const approver = await q(`INSERT INTO app_user (organization_id, email, role) VALUES ($1, 'a@x.test', 'approver') RETURNING id`, [org]);
    const mandate = await q(
      `INSERT INTO mandate (organization_id, approver_user_id, name, currency, budget_minor_units, per_item_cap_minor_units, approval_threshold_minor_units,
                            max_quantity_per_line, structuring_window_minutes, price_drift_tolerance_bps, starts_at, ends_at, policy_version)
       VALUES ($1, $2, 'm', 'USD', 10000, 10000, 10000, 10, 60, 0, now() - interval '1 day', now() + interval '1 year', 't') RETURNING id`,
      [org, approver],
    );
    const request = await q(
      `INSERT INTO purchase_request (organization_id, mandate_id, requester_user_id, raw_text, request_key, request_hash) VALUES ($1, $2, $3, 'x', 'refund-state-0001', $4) RETURNING id`,
      [org, mandate, approver, '0'.repeat(64)],
    );
    const cart = await q(`INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, quoted_at) VALUES ($1, 'USD', 100, now()) RETURNING id`, [request]);
    const decision = await q(
      `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
       VALUES ($1, $2, 'ALLOW', '[]', 't', 100, 'USD', now()) RETURNING id`,
      [request, cart],
    );
    await q(`INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, 100, 'USD', now() + interval '1 hour') RETURNING id`, [mandate, decision]);
    const order = await q(
      `INSERT INTO purchase_order (purchase_request_id, policy_decision_id, idempotency_key, payment_variant, amount_minor_units, currency) VALUES ($1, $2, 'refund-state-order', 'APPROVAL_LINK', 100, 'USD') RETURNING id`,
      [request, decision],
    );
    await target.pool.query(
      `UPDATE purchase_order SET state = 'CAPTURED', provider_order_id = 'PO-R', provider_capture_id = 'CAP-R', capture_status = 'COMPLETED', captured_amount_minor_units = 100, captured_currency = 'USD' WHERE id = $1`,
      [order],
    );
    await target.pool.query(`UPDATE purchase_order SET state = 'REFUND_REQUESTED' WHERE id = $1`, [order]); // legal under 0006
    await expect(migrate(target.config)).rejects.toThrow(/0007_roles_refunds_hardening failed and was rolled back: migration 0007 refused existing data: 1 order/);
    expect(await appliedVersions(target)).toEqual(ALL_VERSIONS.slice(0, 6));
  });
});

describe('0008 over existing audit actions (final verification, Low finding 3)', () => {
  it('refuses a stored action that is not lower-case dotted identifiers, changing nothing', async () => {
    const target = await emptyDatabase();
    await migrate(target.config, { migrations: ALL.slice(0, 7) });
    const org = (await target.pool.query<{ id: string }>(`INSERT INTO organization (name, default_currency) VALUES ('o', 'USD') RETURNING id`)).rows[0]?.id;
    await target.pool.query(`INSERT INTO audit_log (organization_id, actor_type, action, subject_type) VALUES ($1, 'system', 'Legacy Action', 'test')`, [org]);
    await expect(migrate(target.config)).rejects.toThrow(/0008_audit_action_format failed and was rolled back: migration 0008 refused existing data: 1 audit_log row/);
    expect(await appliedVersions(target)).toEqual(ALL_VERSIONS.slice(0, 7));
  });
});

