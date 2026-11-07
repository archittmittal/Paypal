import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiConfigError, loadApiConfig, PROVISIONING_VARIABLES } from '../src/config.js';
import type { Db, Queryable } from '../src/db/db.js';
import { loadMigrations, migrate, migrationStatus, migrationStatusProblems, MIGRATIONS_DIR, type Migration } from '../src/db/migrate.js';
import { isLoopbackDatabase, OperatorConfigError, resolveOperatorDatabase, resolveRuntimeLogin, seedRefusal, urlForLogin } from '../src/db/operator.js';
import {
  applyRuntimeGrants,
  DEFAULT_APP_LOGIN,
  provisioningPrivilegeProblem,
  provisionRuntimeRole,
  RoleProvisioningError,
  roleExists,
  RUNTIME_ROLE,
  RUNTIME_TABLE_PRIVILEGES,
  runtimePrivilegesFor,
  runtimeRoleProblems,
  scramVerifier,
} from '../src/db/roles.js';
import { checkDatabaseAtStartup, DatabaseNotReadyError, safeDatabaseError } from '../src/db/startup.js';
import { createTestDb } from './helpers/pglite.js';

// Issue #14: production configuration, operator commands, the start-up database gate and the least-privilege
// runtime role. PGlite is real Postgres, so roles, grants, SET ROLE and permission errors behave as on a server.
// apps/api/test/deploy.integration.test.ts repeats the key checks over real network logins (TEST_DATABASE_URL).

const PASSWORD = 'test-only-password-1234567890';
const migrations = loadMigrations();
// Fake connection strings are assembled at run time: CI's secret scan (TruffleHog, --results=verified,unknown)
// fails on credential-shaped literals even when they are fake, so none appears in the source.
const pgUrl = (user: string, password: string, rest: string) => `postgresql:/` + `/${user}:${password}@${rest}`;
const FAKE_URL = pgUrl('runtime-user', 'LEAK-MARKER', 'db.example.invalid:5432/mandate');
const LOCAL_URL = pgUrl('runtime-user', 'LEAK-MARKER', '127.0.0.1:5432/mandate');

/** The thrown error's message, or fails the test when nothing is thrown. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return expect.unreachable('expected an error');
}

describe('loadApiConfig in production (fail closed)', () => {
  it('keeps the development result shape unchanged', () => {
    expect(loadApiConfig({})).toEqual({ port: 3000, host: '127.0.0.1', logLevel: 'info' });
    expect(loadApiConfig({ NODE_ENV: 'development' })).toEqual({ port: 3000, host: '127.0.0.1', logLevel: 'info' });
  });

  it('requires DATABASE_URL with NODE_ENV=production', () => {
    expect(() => loadApiConfig({ NODE_ENV: 'production' })).toThrow('Invalid API configuration: DATABASE_URL (required with NODE_ENV=production)');
    expect(loadApiConfig({ NODE_ENV: 'production', DATABASE_URL: FAKE_URL })).toMatchObject({ production: true, databaseUrl: FAKE_URL });
  });

  it.each(PROVISIONING_VARIABLES)('refuses %s on the API service in production, naming it and never its value', (name) => {
    try {
      loadApiConfig({ NODE_ENV: 'production', DATABASE_URL: FAKE_URL, [name]: pgUrl('owner', 'OWNER-SECRET', 'db.example.invalid/mandate') });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiConfigError);
      expect((error as ApiConfigError).variables).toEqual([name]);
      expect((error as Error).message).not.toMatch(/OWNER-SECRET|LEAK-MARKER/);
    }
  });

  it('allows provisioning variables outside production (local compose uses one URL for everything)', () => {
    expect(loadApiConfig({ MIGRATION_DATABASE_URL: FAKE_URL, MANDATE_APP_DB_PASSWORD: PASSWORD }).port).toBe(3000);
  });

  it('rejects an unknown NODE_ENV and an invalid override flag, naming the variables only', () => {
    expect(() => loadApiConfig({ NODE_ENV: 'prod' })).toThrow('Invalid API configuration: NODE_ENV');
    expect(() => loadApiConfig({ MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME: 'yes' })).toThrow('MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME');
  });

  it('reads the privileged-runtime override only when explicitly 1', () => {
    expect(loadApiConfig({ MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME: '1' }).allowPrivilegedRuntime).toBe(true);
    expect(loadApiConfig({ MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME: '0' }).allowPrivilegedRuntime).toBeUndefined();
  });

  it('never prints a DATABASE_URL it rejects', () => {
    const message = thrownMessage(() => loadApiConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://x:LEAK-MARKER@h/d' }));
    expect(message).toBe('Invalid API configuration: DATABASE_URL');
  });
});

describe('operator configuration (pnpm db:*)', () => {
  it('prefers MIGRATION_DATABASE_URL and accepts DATABASE_URL only outside production', () => {
    expect(resolveOperatorDatabase({ MIGRATION_DATABASE_URL: LOCAL_URL, DATABASE_URL: 'postgres://other' })).toEqual({ url: LOCAL_URL, source: 'MIGRATION_DATABASE_URL' });
    expect(resolveOperatorDatabase({ DATABASE_URL: LOCAL_URL })).toEqual({ url: LOCAL_URL, source: 'DATABASE_URL' });
    expect(() => resolveOperatorDatabase({ NODE_ENV: 'production', DATABASE_URL: FAKE_URL })).toThrow('MIGRATION_DATABASE_URL is required with NODE_ENV=production');
    expect(() => resolveOperatorDatabase({})).toThrow(OperatorConfigError);
  });

  it('refuses a remote database unless NODE_ENV=production says it is on purpose (a stray URL in .env)', () => {
    for (const env of [{ MIGRATION_DATABASE_URL: FAKE_URL }, { DATABASE_URL: FAKE_URL }]) {
      const message = thrownMessage(() => resolveOperatorDatabase(env));
      expect(message).toMatch(/points to a remote database; set NODE_ENV=production/);
      expect(message).not.toContain('LEAK-MARKER');
    }
    expect(resolveOperatorDatabase({ NODE_ENV: 'production', MIGRATION_DATABASE_URL: FAKE_URL }).url).toBe(FAKE_URL);
  });

  it.each([
    ['127.0.0.1:5432/m', true],
    ['localhost/m', true],
    ['127.0.0.2:5432/m', true],
    ['[::1]:5432/m', true],
    ['db.example.invalid/m', false],
    ['dpg-abc.singapore-postgres.render.com/m', false],
  ])('treats %s as loopback: %s', (rest, loopback) => {
    expect(isLoopbackDatabase(pgUrl('u', 'p', rest))).toBe(loopback);
  });

  it('rejects non-postgres URLs without printing them', () => {
    for (const env of [{ MIGRATION_DATABASE_URL: 'mysql://LEAK-MARKER' }, { DATABASE_URL: 'mysql://LEAK-MARKER' }]) {
      expect(thrownMessage(() => resolveOperatorDatabase(env))).not.toContain('LEAK-MARKER');
    }
  });

  it('refuses demo data in production unless MANDATE_SEED_DEMO=1', () => {
    expect(seedRefusal({})).toBeUndefined();
    expect(seedRefusal({ NODE_ENV: 'production' })).toMatch(/MANDATE_SEED_DEMO=1/);
    expect(seedRefusal({ NODE_ENV: 'production', MANDATE_SEED_DEMO: '1' })).toBeUndefined();
  });

  it('reads the runtime login, defaulting its name', () => {
    expect(resolveRuntimeLogin({ MANDATE_APP_DB_PASSWORD: PASSWORD })).toEqual({ login: DEFAULT_APP_LOGIN, password: PASSWORD });
    expect(resolveRuntimeLogin({ MANDATE_APP_DB_PASSWORD: PASSWORD, MANDATE_APP_DB_USER: 'api_login' }).login).toBe('api_login');
    expect(() => resolveRuntimeLogin({})).toThrow('MANDATE_APP_DB_PASSWORD is required');
  });

  it('builds the runtime login URL on the same server and database, encoding the password', () => {
    const url = new URL(urlForLogin(pgUrl('owner', 'ownerpw', 'db.example.invalid:5432/mandate?sslmode=require'), { login: 'mandate_app', password: 'p@ss:/w?rd#1234567' }));
    expect(url.username).toBe('mandate_app');
    expect(decodeURIComponent(url.password)).toBe('p@ss:/w?rd#1234567');
    expect([url.hostname, url.port, url.pathname, url.search]).toEqual(['db.example.invalid', '5432', '/mandate', '?sslmode=require']);
  });
});

describe('safeDatabaseError', () => {
  it('removes connection strings and keeps the error code', () => {
    const error = Object.assign(new Error(`connect failed for ${FAKE_URL}`), { code: 'ECONNREFUSED' });
    expect(safeDatabaseError(error)).toBe('connect failed for <connection string> [ECONNREFUSED]');
    expect(safeDatabaseError('nope')).toBe('unknown error');
    expect(safeDatabaseError(new Error('plain'))).toBe('plain');
  });
});

describe('migrationStatus (read-only schema check)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('reports a never-migrated database without creating anything', async () => {
    const status = await migrationStatus(db, migrations);
    expect(status).toEqual({ initialized: false, pending: migrations.map((m) => m.version), edited: [], unknown: [], ahead: [] });
    expect(migrationStatusProblems(status)).toEqual(['the database has never been migrated (no schema_migrations table)']);
    const table = await db.query<{ exists: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
    expect(table.rows[0]?.exists).toBe(false);
  });

  it('is clean after migrating, and names pending and edited versions', async () => {
    await migrate(db, migrations.slice(0, 2));
    expect(migrationStatusProblems(await migrationStatus(db, migrations))).toEqual([`pending migrations: ${migrations.slice(2).map((m) => m.version).join(', ')}`]);
    await migrate(db, migrations);
    expect(migrationStatusProblems(await migrationStatus(db, migrations))).toEqual([]);
    const edited: Migration[] = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m));
    expect(migrationStatusProblems(await migrationStatus(db, edited))).toEqual(['applied migrations edited since: 0001']);
  });

  it('separates a database migrated for a later release (ahead) from a foreign history (unknown)', async () => {
    await migrate(db, migrations);
    const older = migrations.slice(0, -1);
    const newest = migrations.at(-1)?.version ?? '';
    const ahead = await migrationStatus(db, older);
    expect([ahead.ahead, ahead.unknown, ahead.pending]).toEqual([[newest], [], []]);
    expect(migrationStatusProblems(ahead, { allowAhead: true })).toEqual([]);
    expect(migrationStatusProblems(ahead)).toEqual([`applied migrations newer than this code (database is migrated for a later release): ${newest}`]);

    await db.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ('0000', 'foreign', 'x')");
    const foreign = await migrationStatus(db, migrations);
    expect([foreign.unknown, foreign.ahead]).toEqual([['0000'], []]);
    expect(migrationStatusProblems(foreign, { allowAhead: true })).toEqual(['applied migrations unknown to this code (not newer than its own; histories differ): 0000']);
  });
});

describe('least-privilege runtime role', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await migrate(db, migrations);
  });
  afterEach(async () => {
    await db.close();
  });

  async function asRole<T>(role: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    await db.query(`SET ROLE ${role}`);
    try {
      return await fn(db);
    } finally {
      await db.query('RESET ROLE');
    }
  }

  const denied = (sql: string) => asRole(DEFAULT_APP_LOGIN, (q) => q.query(sql));
  const problems = () => asRole(DEFAULT_APP_LOGIN, (q) => runtimeRoleProblems(q));

  /** Everything provisioning could change, to show that a refusal changed nothing. */
  const roleSnapshot = async () =>
    (
      await db.query(
        `SELECT r.rolname, r.rolcanlogin, r.rolpassword, r.rolvaliduntil::text AS valid,
                (SELECT array_agg(g.rolname ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
                (SELECT count(*)::int FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = r.oid) AS table_grants
           FROM pg_authid r WHERE r.rolname IN ($1, $2) ORDER BY r.rolname`,
        [DEFAULT_APP_LOGIN, RUNTIME_ROLE],
      )
    ).rows;

  it('lists every table the migrations create, so a new table\'s access is always a deliberate decision', async () => {
    const { rows } = await db.query<{ table: string }>("SELECT tablename AS table FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    expect(rows.map((r) => r.table).sort()).toEqual(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort());
    const created = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .flatMap((file) => [...readFileSync(join(MIGRATIONS_DIR, file), 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]));
    for (const table of created) expect(Object.keys(RUNTIME_TABLE_PRIVILEGES), table).toContain(table);
    expect(runtimePrivilegesFor('not_a_listed_table')).toEqual(['SELECT']);
  });

  it('formats SCRAM verifiers and rejects weak or unusual passwords', () => {
    expect(scramVerifier(PASSWORD, Buffer.alloc(16))).toMatch(/^SCRAM-SHA-256\$4096:A{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(scramVerifier(PASSWORD, Buffer.alloc(16))).toBe(scramVerifier(PASSWORD, Buffer.alloc(16)));
    expect(() => scramVerifier('short')).toThrow(RangeError);
    expect(() => scramVerifier('has a space in it 1234567')).toThrow(RangeError);
  });

  it('provisions the group and login idempotently, with exactly the grant matrix', async () => {
    const first = await provisionRuntimeRole(db, { password: PASSWORD });
    expect(first).toMatchObject({ group: RUNTIME_ROLE, login: DEFAULT_APP_LOGIN, createdGroup: true, createdLogin: true });
    const second = await provisionRuntimeRole(db, { password: `${PASSWORD}-rotated` });
    expect(second).toMatchObject({ createdGroup: false, createdLogin: false, tables: first.tables });
    expect(await roleExists(db, RUNTIME_ROLE)).toBe(true);

    const { rows } = await db.query<{ table: string; privileges: string[] }>(
      `SELECT c.relname AS table, array_agg(a.privilege_type ORDER BY a.privilege_type) AS privileges
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.grantee = $1::regrole
        GROUP BY c.relname ORDER BY c.relname`,
      [RUNTIME_ROLE],
    );
    expect(rows.length).toBe(first.tables);
    for (const row of rows) expect(row.privileges).toEqual([...runtimePrivilegesFor(row.table)].sort());

    const login = await db.query<{ login: boolean; super: boolean; valid: string }>(
      "SELECT rolcanlogin AS login, rolsuper AS super, rolvaliduntil::text AS valid FROM pg_roles WHERE rolname = $1",
      [DEFAULT_APP_LOGIN],
    );
    expect(login.rows[0]).toEqual({ login: true, super: false, valid: 'infinity' });
    expect(await problems()).toEqual([]);
  });

  it('lets the login do the API\'s work and nothing destructive', async () => {
    await provisionRuntimeRole(db, { password: PASSWORD });
    const org = await asRole(DEFAULT_APP_LOGIN, (q) =>
      q.query<{ id: string }>("INSERT INTO organization (name, default_currency) VALUES ('runtime test', 'USD') RETURNING id"),
    );
    const orgId = org.rows[0]?.id;
    expect(orgId).toBeDefined();
    await asRole(DEFAULT_APP_LOGIN, (q) =>
      q.query("INSERT INTO audit_log (organization_id, actor_type, action, subject_type, subject_id) VALUES ($1, 'system', 'test.event', 'organization', $1)", [orgId]),
    );
    await asRole(DEFAULT_APP_LOGIN, (q) => q.query("UPDATE organization SET name = 'renamed' WHERE id = $1", [orgId]));
    await asRole(DEFAULT_APP_LOGIN, (q) => q.query('SELECT count(*) FROM schema_migrations'));

    for (const sql of [
      'UPDATE audit_log SET action = action',
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
      'DELETE FROM payment_order',
      'DELETE FROM organization',
      'UPDATE schema_migrations SET name = name',
      'INSERT INTO schema_migrations (version, name, checksum) VALUES (\'9999\', \'x\', \'x\')',
      'CREATE TABLE intruder (x int)',
      'CREATE SCHEMA intruder',
      'ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only',
      'DROP TABLE payment_order',
    ]) {
      await expect(denied(sql), sql).rejects.toThrow(/permission denied|must be owner/);
    }
  });

  it('runs migrations and provisioning as a non-superuser CREATEROLE owner, like Render\'s database user', async () => {
    const fresh = await createTestDb();
    try {
      await fresh.exec(`CREATE ROLE render_owner CREATEROLE; GRANT CREATE ON SCHEMA public TO render_owner;`);
      await fresh.query('SET ROLE render_owner');
      await migrate(fresh, migrations);
      const result = await provisionRuntimeRole(fresh, { password: PASSWORD });
      expect(result.createdLogin).toBe(true);
      expect(await provisioningPrivilegeProblem(fresh)).toBeUndefined();
      expect((await provisionRuntimeRole(fresh, { password: `${PASSWORD}-2` })).createdLogin).toBe(false);
      await fresh.query(`SET ROLE ${DEFAULT_APP_LOGIN}`);
      expect(await runtimeRoleProblems(fresh)).toEqual([]);
      await fresh.query('RESET ROLE');
    } finally {
      await fresh.close();
    }
  });

  it('names the missing privilege when the owner cannot create or administer the roles', async () => {
    await db.exec('CREATE ROLE weak_owner NOCREATEROLE');
    expect(await asRole('weak_owner', (q) => provisioningPrivilegeProblem(q))).toMatch(/weak_owner lacks CREATEROLE/);
    await db.query('SET ROLE weak_owner');
    try {
      await expect(provisionRuntimeRole(db, { password: PASSWORD })).rejects.toThrow(RoleProvisioningError);
    } finally {
      await db.query('RESET ROLE');
    }
    expect(await roleExists(db, DEFAULT_APP_LOGIN)).toBe(false);

    // PostgreSQL 16+: a CREATEROLE owner that did not create a role needs ADMIN OPTION on it (group or login).
    await db.exec('CREATE ROLE other_owner CREATEROLE');
    await db.exec(`CREATE ROLE ${DEFAULT_APP_LOGIN} LOGIN`);
    expect(await asRole('other_owner', (q) => provisioningPrivilegeProblem(q))).toMatch(/lacks ADMIN OPTION on existing role mandate_app/);
    await db.exec(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
    expect(await asRole('other_owner', (q) => provisioningPrivilegeProblem(q))).toMatch(/lacks ADMIN OPTION on existing role mandate_runtime/);
  });

  it.each([
    ['a privileged existing login', `CREATE ROLE ${DEFAULT_APP_LOGIN} LOGIN CREATEDB PASSWORD 'old-password-1234567'`, /privileged attribute/],
    ['a login that belongs to another role', `CREATE ROLE extra NOLOGIN; CREATE ROLE ${DEFAULT_APP_LOGIN} LOGIN PASSWORD 'old-password-1234567' IN ROLE extra`, /member of extra/],
    ['a login that owns objects', `CREATE ROLE ${DEFAULT_APP_LOGIN} LOGIN PASSWORD 'old-password-1234567'; CREATE TABLE owned_by_login (x int); ALTER TABLE owned_by_login OWNER TO ${DEFAULT_APP_LOGIN}`, /owns objects/],
    ['a login with grants of its own', `CREATE ROLE ${DEFAULT_APP_LOGIN} LOGIN PASSWORD 'old-password-1234567'; GRANT SELECT ON audit_log TO ${DEFAULT_APP_LOGIN}`, /privileges of its own/],
    ['a group role that can log in', `CREATE ROLE ${RUNTIME_ROLE} LOGIN`, /has LOGIN or a privileged attribute/],
    ['a group role that belongs to another role', `CREATE ROLE extra NOLOGIN; CREATE ROLE ${RUNTIME_ROLE} NOLOGIN IN ROLE extra`, /member of extra/],
  ])('refuses %s and changes nothing', async (_label, setup, message) => {
    await db.exec(setup);
    const before = await roleSnapshot();
    await expect(provisionRuntimeRole(db, { password: PASSWORD })).rejects.toThrow(message);
    expect(await roleSnapshot()).toEqual(before);
  });

  it('rejects bad role names and identical login and group names before touching the database', async () => {
    await expect(provisionRuntimeRole(db, { password: PASSWORD, login: 'Bad-Name' })).rejects.toThrow(RangeError);
    await expect(provisionRuntimeRole(db, { password: PASSWORD, login: RUNTIME_ROLE })).rejects.toThrow(RangeError);
    await expect(provisionRuntimeRole(db, { password: 'short' })).rejects.toThrow(RangeError);
    expect(await roleExists(db, RUNTIME_ROLE)).toBe(false);
  });

  it.each([
    ['an attribute on the group (SET ROLE escalation)', `ALTER ROLE ${RUNTIME_ROLE} CREATEDB`, `${DEFAULT_APP_LOGIN} can SET ROLE to privileged role(s): ${RUNTIME_ROLE}`],
    ['a column grant on schema_migrations to the group', `GRANT UPDATE (checksum) ON schema_migrations TO ${RUNTIME_ROLE}`, `${DEFAULT_APP_LOGIN} has UPDATE on schema_migrations, beyond least privilege`],
    ['a column grant to PUBLIC', 'GRANT INSERT (version, name, checksum) ON schema_migrations TO PUBLIC', `${DEFAULT_APP_LOGIN} has INSERT on schema_migrations, beyond least privilege`],
    ['TRIGGER and MAINTAIN on a table', `GRANT TRIGGER, MAINTAIN ON payment_order TO ${RUNTIME_ROLE}`, `${DEFAULT_APP_LOGIN} has TRIGGER, MAINTAIN on payment_order, beyond least privilege`],
    ['REFERENCES on a table', `GRANT REFERENCES ON mandate TO ${RUNTIME_ROLE}`, `${DEFAULT_APP_LOGIN} has REFERENCES on mandate, beyond least privilege`],
    ['CREATE on the database', `GRANT CREATE ON DATABASE postgres TO ${RUNTIME_ROLE}`, `${DEFAULT_APP_LOGIN} can create schemas in this database`],
    ['ADMIN OPTION on the group', `GRANT ${RUNTIME_ROLE} TO ${DEFAULT_APP_LOGIN} WITH ADMIN OPTION`, `${DEFAULT_APP_LOGIN} holds ADMIN OPTION on: ${RUNTIME_ROLE}`],
    ['a saved setting on the login', `ALTER ROLE ${DEFAULT_APP_LOGIN} SET search_path = pg_temp, public`, `${DEFAULT_APP_LOGIN} has saved settings (all databases); run pnpm db:roles to reset them`],
    ['CREATE on another schema', `CREATE SCHEMA scratch; GRANT CREATE ON SCHEMA scratch TO ${RUNTIME_ROLE}`, `${DEFAULT_APP_LOGIN} can create objects in schema(s): scratch`],
  ])('reports %s', async (_label, grant, expected) => {
    await provisionRuntimeRole(db, { password: PASSWORD });
    await db.exec(grant);
    expect(await problems()).toContain(expected);
  });

  it('finds the remaining ways the login can exceed least privilege, and re-applying grants repairs table grants', async () => {
    await provisionRuntimeRole(db, { password: PASSWORD });
    await db.exec(`GRANT DELETE, TRUNCATE ON audit_log TO ${RUNTIME_ROLE}; REVOKE SELECT ON shipment FROM ${RUNTIME_ROLE};
                   GRANT UPDATE ON payment_order TO ${DEFAULT_APP_LOGIN}; GRANT CREATE ON SCHEMA public TO ${RUNTIME_ROLE};
                   GRANT INSERT (version) ON schema_migrations TO PUBLIC;
                   CREATE ROLE wider NOLOGIN; GRANT wider TO ${RUNTIME_ROLE}; ALTER ROLE ${DEFAULT_APP_LOGIN} CREATEDB;`);
    expect(await problems()).toEqual(
      expect.arrayContaining([
        `${DEFAULT_APP_LOGIN} has CREATEDB`,
        `${RUNTIME_ROLE} is itself a member of: wider`,
        expect.stringMatching(/holds privileges of its own/),
        expect.stringMatching(/cannot read shipment/),
        `${DEFAULT_APP_LOGIN} has DELETE, TRUNCATE on audit_log, beyond least privilege`,
        `${DEFAULT_APP_LOGIN} has INSERT on schema_migrations, beyond least privilege`,
        `${DEFAULT_APP_LOGIN} can create objects in schema(s): public`,
      ]),
    );
    await applyRuntimeGrants(db);
    const after = await problems();
    expect(after.some((p) => /audit_log|shipment|schema_migrations/.test(p))).toBe(false);
  });

  it('provisioning again clears saved settings, ADMIN OPTION and an expiry on the login', async () => {
    await provisionRuntimeRole(db, { password: PASSWORD });
    await db.exec(`ALTER ROLE ${DEFAULT_APP_LOGIN} SET search_path = pg_temp; ALTER ROLE ${DEFAULT_APP_LOGIN} VALID UNTIL '2000-01-01';
                   GRANT ${RUNTIME_ROLE} TO ${DEFAULT_APP_LOGIN} WITH ADMIN OPTION`);
    expect((await problems()).length).toBeGreaterThan(0);
    await provisionRuntimeRole(db, { password: PASSWORD });
    expect(await problems()).toEqual([]);
    const valid = await db.query<{ valid: string }>('SELECT rolvaliduntil::text AS valid FROM pg_roles WHERE rolname = $1', [DEFAULT_APP_LOGIN]);
    expect(valid.rows[0]?.valid).toBe('infinity');
  });

  it('reports the owner and a superuser as privileged', async () => {
    expect(await runtimeRoleProblems(db)).toEqual(expect.arrayContaining([expect.stringMatching(/is a superuser/), expect.stringMatching(/owns \(or can act as the owner of\)/)]));
    await db.exec(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN; CREATE ROLE plain_login LOGIN`);
    expect(await asRole('plain_login', (q) => runtimeRoleProblems(q))).toEqual(
      expect.arrayContaining([`plain_login must be a member of ${RUNTIME_ROLE} only, but is a member of: nothing`, expect.stringMatching(/cannot read/)]),
    );
  });
});

describe('checkDatabaseAtStartup (never serve an incompatible schema or a privileged login in production)', () => {
  let db: Db;
  let warnings: string[];
  beforeEach(async () => {
    db = await createTestDb();
    warnings = [];
  });
  afterEach(async () => {
    await db.close();
  });
  const options = (production: boolean, allowPrivilegedRuntime = false) => ({ production, allowPrivilegedRuntime, warn: (m: string) => warnings.push(m), migrations });

  it('refuses a database that was never migrated or is behind, even with the override', async () => {
    await expect(checkDatabaseAtStartup(db, options(true, true))).rejects.toThrow(/never been migrated.*pnpm db:migrate/);
    await migrate(db, migrations.slice(0, 1));
    await expect(checkDatabaseAtStartup(db, options(false))).rejects.toThrow(DatabaseNotReadyError);
    await expect(checkDatabaseAtStartup(db, options(false))).rejects.toThrow(/pending migrations/);
  });

  it('keeps serving the running release on a database migrated for the next one (no outage on restart)', async () => {
    await migrate(db, migrations);
    await provisionRuntimeRole(db, { password: PASSWORD });
    await db.query(`SET ROLE ${DEFAULT_APP_LOGIN}`);
    expect(await checkDatabaseAtStartup(db, { ...options(true), migrations: migrations.slice(0, -1) })).toEqual({ accepted: [] });
    expect(warnings).toEqual([`database is migrated for a later release (${migrations.at(-1)?.version}); serving with this release until it is deployed`]);
    await db.query('RESET ROLE');
  });

  it('refuses a database whose history differs from the code (a foreign or edited migration)', async () => {
    await migrate(db, migrations);
    await db.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ('0000', 'foreign', 'x')");
    await expect(checkDatabaseAtStartup(db, options(true, true))).rejects.toThrow(/histories differ\): 0000; .*does not match this code/);
    await db.query("DELETE FROM schema_migrations WHERE version = '0000'");
    const edited = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m));
    await expect(checkDatabaseAtStartup(db, { ...options(true, true), migrations: edited })).rejects.toThrow(/edited since: 0001/);
  });

  it('in production refuses a privileged login unless explicitly allowed, then warns about every finding', async () => {
    await migrate(db, migrations);
    await expect(checkDatabaseAtStartup(db, options(true))).rejects.toThrow(/is a superuser.*restricted login created by `pnpm db:roles`/);
    const accepted = await checkDatabaseAtStartup(db, options(true, true));
    expect(accepted.accepted.length).toBeGreaterThan(1);
    expect(warnings).toHaveLength(accepted.accepted.length);
    expect(warnings.every((w) => w.includes('accepted by MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1'))).toBe(true);
  });

  it('outside production only warns about a privileged login, in one summary line', async () => {
    await migrate(db, migrations);
    expect((await checkDatabaseAtStartup(db, options(false))).accepted.length).toBeGreaterThan(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not enforced outside NODE_ENV=production\): \d+ finding\(s\)/);
  });

  it('starts cleanly in production with the restricted login', async () => {
    await migrate(db, migrations);
    await provisionRuntimeRole(db, { password: PASSWORD });
    await db.query(`SET ROLE ${DEFAULT_APP_LOGIN}`);
    expect(await checkDatabaseAtStartup(db, options(true))).toEqual({ accepted: [] });
    expect(warnings).toEqual([]);
    await db.query('RESET ROLE');
  });

  it('reports an unreachable database without leaking the connection string', async () => {
    const unreachable: Queryable = {
      query: () => Promise.reject(Object.assign(new Error(`connect ECONNREFUSED via ${FAKE_URL}`), { code: 'ECONNREFUSED' })),
      exec: () => Promise.resolve(),
    };
    const error = await checkDatabaseAtStartup(unreachable, options(true)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseNotReadyError);
    expect((error as Error).message).toBe('Refusing to start: could not check the database: connect ECONNREFUSED via <connection string> [ECONNREFUSED]');
  });
});
