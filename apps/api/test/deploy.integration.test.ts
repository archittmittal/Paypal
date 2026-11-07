import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { createPgDb, createPgPool } from '../src/db/pg.js';
import { roleExists, RUNTIME_ROLE } from '../src/db/roles.js';

// Issue #14 end to end on a real server, as an operator and Render would run it: a non-superuser CREATEROLE owner
// (like Render's database user) migrates and provisions through the CLI, then the API process starts with the
// restricted login, serves /health and /ready, and shuts down cleanly. It also refuses to start in the unsafe cases.
//
// Needs TEST_DATABASE_URL with a role that can CREATE ROLE and CREATE DATABASE (the compose and CI superuser).
// It creates its own database `mandate_<hex>_test` and roles with a random suffix, and drops them afterwards.
// mandate_runtime is cluster-wide, so if it already exists (created outside this test) the run is skipped.
const adminUrl = process.env.TEST_DATABASE_URL;
const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const suffix = randomBytes(4).toString('hex');
const OWNER = `render_owner_${suffix}`;
const LOGIN = `mandate_app_${suffix}`;
const DATABASE = `mandate_${suffix}_test`;
const OWNER_PASSWORD = randomBytes(18).toString('base64url');
const LOGIN_PASSWORD = randomBytes(18).toString('base64url');

function urlFor(user: string, password: string): string {
  const url = new URL(adminUrl ?? 'postgres://unused');
  url.username = user;
  url.password = password;
  url.pathname = `/${DATABASE}`;
  return url.toString();
}

interface Run {
  code: number | null;
  output: string;
}

/** Runs a TypeScript entry point the way package.json does, with ONLY the given environment (no .env file). */
function run(script: string, args: string[], env: Record<string, string>, until?: (output: string) => boolean): { done: Promise<Run>; kill: (signal: NodeJS.Signals) => void; ready: Promise<void> } {
  const child = spawn(process.execPath, ['--import', './scripts/resolve-ts.ts', script, ...args], {
    cwd: API_DIR,
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  let output = '';
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    if (until?.(output)) resolveReady();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const done = new Promise<Run>((resolve) => child.on('exit', (code) => resolve({ code, output })));
  return { done, kill: (signal) => child.kill(signal), ready };
}

const cli = (command: string, env: Record<string, string>) => run('scripts/db.ts', [command], env).done;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

const preexistingGroup = adminUrl
  ? await (async () => {
      const probe = createPgDb(createPgPool(adminUrl));
      try {
        return await roleExists(probe, RUNTIME_ROLE);
      } finally {
        await probe.close();
      }
    })()
  : false;
if (adminUrl && preexistingGroup) {
  // Say so loudly instead of skipping in silence (e.g. after rehearsing `pnpm db:roles` against docker compose).
  console.warn(
    `deploy.integration.test.ts SKIPPED: role ${RUNTIME_ROLE} already exists on the TEST_DATABASE_URL server (roles are cluster-wide). ` +
      'Use a fresh server, e.g. `docker compose down -v && docker compose up -d --wait`, to run it.',
  );
}

describe.skipIf(!adminUrl || preexistingGroup)('deployment on a real Postgres server (operator CLI and API process)', () => {
  let admin: Db;
  const ownerEnv = () => ({ NODE_ENV: 'production', MIGRATION_DATABASE_URL: urlFor(OWNER, OWNER_PASSWORD) });
  const secrets = [OWNER_PASSWORD, LOGIN_PASSWORD];
  const leaksNoSecret = (output: string) => secrets.every((secret) => !output.includes(secret));

  beforeAll(async () => {
    admin = createPgDb(createPgPool(adminUrl ?? ''));
    // Like Render's database user: owns its database, may create roles, is not a superuser.
    await admin.exec(`CREATE ROLE ${OWNER} LOGIN CREATEROLE PASSWORD '${OWNER_PASSWORD}'`);
    await admin.exec(`CREATE DATABASE ${DATABASE} OWNER ${OWNER}`);
  }, 60_000);

  afterAll(async () => {
    await admin.exec(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    for (const role of [LOGIN, RUNTIME_ROLE, OWNER]) await admin.exec(`DROP ROLE IF EXISTS ${role}`);
    await admin.close();
  }, 60_000);

  it('the API refuses to start on a database that was never migrated', async () => {
    const result = await run('src/server.ts', [], { NODE_ENV: 'production', DATABASE_URL: urlFor(OWNER, OWNER_PASSWORD), PORT: String(await freePort()) }).done;
    expect(result.code).toBe(1);
    expect(result.output).toContain('Refusing to start: the database has never been migrated');
    expect(leaksNoSecret(result.output)).toBe(true);
  }, 30_000);

  it('migrates, provisions and checks through the operator CLI, idempotently, without printing secrets', async () => {
    const migrateRun = await cli('migrate', ownerEnv());
    expect(migrateRun.code, migrateRun.output).toBe(0);
    expect(migrateRun.output).toMatch(/Connecting with MIGRATION_DATABASE_URL\nApplied: 0001/);
    expect(migrateRun.output).toContain('mandate_runtime does not exist yet; run pnpm db:roles');

    const refusedSeed = await cli('seed', ownerEnv());
    expect(refusedSeed.code).toBe(1);
    expect(refusedSeed.output).toContain('MANDATE_SEED_DEMO=1');

    const roles = await cli('roles', { ...ownerEnv(), MANDATE_APP_DB_USER: LOGIN, MANDATE_APP_DB_PASSWORD: LOGIN_PASSWORD });
    expect(roles.code, roles.output).toBe(0);
    expect(roles.output).toContain(`Created mandate_runtime; created login ${LOGIN}`);
    expect(roles.output).toContain(`Login ${LOGIN} connects and passes the least-privilege check.`);

    const again = await cli('migrate', ownerEnv());
    expect(again.output).toMatch(/Up to date\nRe-applied mandate_runtime grants on \d+ tables/);
    const status = await cli('status', ownerEnv());
    expect(status.code).toBe(0);
    expect(status.output).toMatch(/Up to date \(\d+ migrations\)/);
    const seeded = await cli('seed', { ...ownerEnv(), MANDATE_SEED_DEMO: '1' });
    expect(seeded.code, seeded.output).toBe(0);

    for (const output of [migrateRun.output, roles.output, again.output, status.output, seeded.output]) expect(leaksNoSecret(output)).toBe(true);
  }, 120_000);

  it('the CLI refuses to run in production without the owner URL', async () => {
    const result = await cli('migrate', { NODE_ENV: 'production', DATABASE_URL: urlFor(LOGIN, LOGIN_PASSWORD) });
    expect(result.code).toBe(1);
    expect(result.output).toContain('MIGRATION_DATABASE_URL is required with NODE_ENV=production');
  }, 30_000);

  it('the API starts with the restricted login, is live and ready, and shuts down cleanly on SIGTERM', async () => {
    const port = await freePort();
    const server = run('src/server.ts', [], { NODE_ENV: 'production', DATABASE_URL: urlFor(LOGIN, LOGIN_PASSWORD), HOST: '127.0.0.1', PORT: String(port) }, (o) =>
      o.includes('Server listening'),
    );
    await Promise.race([server.ready, server.done.then((r) => Promise.reject(new Error(`exited early: ${r.output}`)))]);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect([ready.status, await ready.json()]).toEqual([200, { status: 'ready', checks: { postgres: 'ok' } }]);

    server.kill('SIGTERM');
    const exit = await server.done;
    expect(exit.code).toBe(0);
    expect(exit.output).toContain('shutting down');
    expect(exit.output).not.toContain('database login is not least-privilege');
    expect(leaksNoSecret(exit.output)).toBe(true);
  }, 60_000);

  it('the API refuses the owner login in production, and accepts it only with the explicit override', async () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: urlFor(OWNER, OWNER_PASSWORD), PORT: String(await freePort()), HOST: '127.0.0.1' };
    const refused = await run('src/server.ts', [], env).done;
    expect(refused.code).toBe(1);
    expect(refused.output).toMatch(/Refusing to start: .*owns \(or can act as the owner of\)/);
    expect(leaksNoSecret(refused.output)).toBe(true);

    const overridden = run('src/server.ts', [], { ...env, MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME: '1' }, (o) => o.includes('Server listening'));
    await Promise.race([overridden.ready, overridden.done.then((r) => Promise.reject(new Error(`exited early: ${r.output}`)))]);
    overridden.kill('SIGTERM');
    const exit = await overridden.done;
    expect(exit.output).toContain('accepted by MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1');
    expect(exit.code).toBe(0);
  }, 60_000);

  it('the API refuses provisioning credentials and a missing DATABASE_URL in production', async () => {
    const withOwner = await run('src/server.ts', [], { NODE_ENV: 'production', DATABASE_URL: urlFor(LOGIN, LOGIN_PASSWORD), MIGRATION_DATABASE_URL: urlFor(OWNER, OWNER_PASSWORD) }).done;
    expect(withOwner.code).toBe(1);
    expect(withOwner.output).toContain('Invalid API configuration: MIGRATION_DATABASE_URL');
    const missing = await run('src/server.ts', [], { NODE_ENV: 'production' }).done;
    expect(missing.code).toBe(1);
    expect(missing.output).toContain('Invalid API configuration: DATABASE_URL (required with NODE_ENV=production)');
    expect(leaksNoSecret(withOwner.output + missing.output)).toBe(true);
  }, 30_000);

  it('the API refuses to start when the database is unreachable, without printing the URL', async () => {
    const url = new URL(urlFor(LOGIN, LOGIN_PASSWORD));
    url.port = String(await freePort());
    const result = await run('src/server.ts', [], { NODE_ENV: 'production', DATABASE_URL: url.toString() }).done;
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Refusing to start: could not check the database: .*ECONNREFUSED/);
    expect(leaksNoSecret(result.output)).toBe(true);
  }, 30_000);

  it('the restricted login cannot modify the schema, migrations or append-only tables over a real connection', async () => {
    const asLogin = createPgDb(createPgPool(urlFor(LOGIN, LOGIN_PASSWORD)));
    try {
      for (const sql of ['CREATE TABLE intruder (x int)', 'DELETE FROM schema_migrations', 'TRUNCATE audit_log', 'ALTER TABLE payment_order DISABLE TRIGGER ALL', 'DROP TABLE mandate']) {
        await expect(asLogin.query(sql), sql).rejects.toThrow(/permission denied|must be owner/);
      }
      expect((await asLogin.query<{ n: string }>('SELECT count(*)::text AS n FROM mandate')).rows[0]?.n).toBe('1');
    } finally {
      await asLogin.close();
    }
  }, 30_000);
});
