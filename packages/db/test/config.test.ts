import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { connectionOptions, DatabaseConfigError, loadDatabaseConfig, withCredentials, withDatabase } from '../src/config.js';

describe('loadDatabaseConfig', () => {
  it('defaults to the docker compose database on loopback', () => {
    const config = loadDatabaseConfig({});
    expect(config.connectionString.reveal()).toBe('postgres://mandate:mandate@127.0.0.1:5432/mandate');
    expect(config).toMatchObject({ target: '127.0.0.1:5432/mandate', poolMax: 10, connectTimeoutMs: 5_000, statementTimeoutMs: 30_000 });
  });

  it('builds the URL from POSTGRES_* and encodes awkward passwords', () => {
    const config = loadDatabaseConfig({ POSTGRES_PORT: '5433', POSTGRES_PASSWORD: 'p@ss:w/rd%', POSTGRES_DB: 'other' });
    const url = new URL(config.connectionString.reveal());
    expect(decodeURIComponent(url.password)).toBe('p@ss:w/rd%');
    expect(config.target).toBe('127.0.0.1:5433/other');
  });

  it('prefers DATABASE_URL over POSTGRES_* (Render provides one)', () => {
    const config = loadDatabaseConfig({ DATABASE_URL: 'postgresql://u:secret@db.internal:6543/prod', POSTGRES_PORT: '5433' });
    expect(config.target).toBe('db.internal:6543/prod');
  });

  it('treats empty values as unset', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: '', POSTGRES_PORT: '' }).target).toBe('127.0.0.1:5432/mandate');
  });

  it('never prints the connection string', () => {
    const config = loadDatabaseConfig({ POSTGRES_PASSWORD: 'hunter2-secret' });
    for (const rendered of [JSON.stringify(config), String(config.connectionString), inspect(config), config.target]) {
      expect(rendered).not.toContain('hunter2-secret');
    }
  });

  it.each([
    ['a non-postgres URL', { DATABASE_URL: 'mysql://u:p@h/db' }, ['DATABASE_URL']],
    ['an invalid port', { POSTGRES_PORT: '99999' }, ['POSTGRES_PORT']],
    ['a database name with SQL in it', { POSTGRES_DB: 'x; drop' }, ['POSTGRES_DB']],
    ['a pool size of zero', { DATABASE_POOL_MAX: '0' }, ['DATABASE_POOL_MAX']],
  ])('rejects %s, naming the variables only', (_label, env, variables) => {
    try {
      loadDatabaseConfig(env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as DatabaseConfigError).variables).toEqual(variables);
      for (const value of Object.values(env)) expect((error as Error).message).not.toContain(value);
    }
  });

  it('withDatabase swaps only the database and validates its name', () => {
    const base = loadDatabaseConfig({ POSTGRES_PASSWORD: 'pw' });
    const other = withDatabase(base, 'mandate_test_abc');
    expect(other.target).toBe('127.0.0.1:5432/mandate_test_abc');
    expect(new URL(other.connectionString.reveal()).password).toBe('pw');
    expect(() => withDatabase(base, 'x"; DROP DATABASE mandate; --')).toThrow(DatabaseConfigError);
  });
});

describe('connection purpose (review finding M5)', () => {
  const env = { DATABASE_URL: 'postgres://mandate_app:app-secret@db.internal:5432/mandate', DATABASE_ADMIN_URL: 'postgres://owner:owner-secret@db.internal:5432/mandate' };

  it('connects the runtime with DATABASE_URL and administration with DATABASE_ADMIN_URL', () => {
    expect(new URL(loadDatabaseConfig(env).connectionString.reveal()).username).toBe('mandate_app');
    expect(new URL(loadDatabaseConfig(env, 'admin').connectionString.reveal()).username).toBe('owner');
  });

  it('falls back to DATABASE_URL for administration when no admin URL is set', () => {
    expect(new URL(loadDatabaseConfig({ DATABASE_URL: env.DATABASE_URL }, 'admin').connectionString.reveal()).username).toBe('mandate_app');
  });

  it('withCredentials swaps only the login and validates the role name', () => {
    const base = loadDatabaseConfig({});
    const app = new URL(withCredentials(base, 'mandate_app', 'p@ss/word').connectionString.reveal());
    expect([app.username, decodeURIComponent(app.password), app.host, app.pathname]).toEqual(['mandate_app', 'p@ss/word', '127.0.0.1:5432', '/mandate']);
    expect(() => withCredentials(base, 'x; DROP ROLE y', 'p')).toThrow(DatabaseConfigError);
  });
});

describe('production fails closed (second review finding L10)', () => {
  const runtimeUrl = 'postgres://mandate_app:app-secret@db.internal:5432/mandate';
  const adminUrl = 'postgres://owner:owner-secret@db.internal:5432/mandate';
  const fails = (env: Record<string, string>, purpose: 'runtime' | 'admin', variables: string[]) => {
    try {
      loadDatabaseConfig({ NODE_ENV: 'production', ...env }, purpose);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as DatabaseConfigError).variables).toEqual(variables);
      expect((error as Error).message).not.toMatch(/secret/);
    }
  };

  it('refuses to fall back to the POSTGRES_* laptop defaults', () => {
    fails({}, 'runtime', ['DATABASE_URL']);
    fails({ POSTGRES_PASSWORD: 'x' }, 'runtime', ['DATABASE_URL']);
  });

  it('refuses administration without DATABASE_ADMIN_URL, even when DATABASE_URL is set', () => {
    fails({ DATABASE_URL: runtimeUrl }, 'admin', ['DATABASE_ADMIN_URL']);
  });

  it('refuses a runtime process that holds the admin URL at all', () => {
    fails({ DATABASE_URL: runtimeUrl, DATABASE_ADMIN_URL: adminUrl }, 'runtime', ['DATABASE_ADMIN_URL']);
  });

  it('refuses an admin URL that logs in as the runtime user, however it is spelled', () => {
    fails({ DATABASE_URL: runtimeUrl, DATABASE_ADMIN_URL: 'postgres://mandate_app:other@DB.INTERNAL/mandate?sslmode=require' }, 'admin', ['DATABASE_ADMIN_URL', 'DATABASE_URL']);
  });

  it('treats NODE_ENV case-insensitively', () => {
    expect(() => loadDatabaseConfig({ NODE_ENV: 'Production' })).toThrow(DatabaseConfigError);
  });

  it('accepts the runtime URL alone, and distinct runtime and admin URLs for administration', () => {
    expect(loadDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: runtimeUrl }).target).toBe('db.internal:5432/mandate');
    expect(loadDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: runtimeUrl, DATABASE_ADMIN_URL: adminUrl }, 'admin').target).toBe('db.internal:5432/mandate');
  });

  it('keeps the local defaults outside production', () => {
    expect(loadDatabaseConfig({ NODE_ENV: 'development' }).target).toBe('127.0.0.1:5432/mandate');
  });
});

describe('connectionOptions (second review finding L8)', () => {
  it('splits the URL into pg fields and hands the password over only through a function', () => {
    const options = connectionOptions(loadDatabaseConfig({ DATABASE_URL: 'postgres://app%40x:p%40ss%3Aword@[::1]:6543/my_db?sslmode=require' }));
    expect(options).toMatchObject({ host: '::1', port: 6543, database: 'my_db', user: 'app@x', ssl: true });
    expect(options.password()).toBe('p@ss:word');
    expect(inspect(options, { depth: Infinity })).not.toContain('p@ss');
    expect(JSON.stringify(options)).not.toContain('p@ss');
  });

  it('defaults the port and leaves TLS off without sslmode', () => {
    expect(connectionOptions(loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@db.internal/x' }))).toMatchObject({ port: 5432, ssl: false });
    expect(connectionOptions(loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@db.internal/x?sslmode=disable' })).ssl).toBe(false);
  });

  it.each(['?sslmode=prefer', '?application_name=x', '?host=/tmp', ''])('refuses a URL it would not honour exactly (%s, or no database)', (suffix) => {
    const url = suffix === '' ? 'postgres://u:p@db.internal' : `postgres://u:p@db.internal/x${suffix}`;
    expect(() => loadDatabaseConfig({ DATABASE_URL: url })).toThrow(DatabaseConfigError);
  });
});

describe('superuser purpose (db:harden)', () => {
  const su = 'postgres://postgres:su-secret@db.internal:5432/mandate';
  it('uses DATABASE_SUPERUSER_URL, else the admin resolution', () => {
    expect(new URL(loadDatabaseConfig({ DATABASE_SUPERUSER_URL: su }, 'superuser').connectionString.reveal()).username).toBe('postgres');
    expect(loadDatabaseConfig({}, 'superuser').target).toBe('127.0.0.1:5432/mandate');
  });

  it('requires DATABASE_SUPERUSER_URL in production, and keeps it away from the runtime', () => {
    expect(() => loadDatabaseConfig({ NODE_ENV: 'production', DATABASE_ADMIN_URL: 'postgres://o:p@db.internal/mandate' }, 'superuser')).toThrow(DatabaseConfigError);
    expect(() => loadDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://a:p@db.internal/mandate', DATABASE_SUPERUSER_URL: su })).toThrow(DatabaseConfigError);
  });
});
