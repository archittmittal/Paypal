import { POSTGRES_URL, presentVariables } from '../config.js';
import { DEFAULT_APP_LOGIN } from './roles.js';

/**
 * Configuration for the operator commands (`pnpm db:migrate`, `db:status`, `db:roles`, `db:seed`). These run as
 * the database OWNER, from a trusted machine, never inside the API process (docs/deployment-render.md).
 *
 *   MIGRATION_DATABASE_URL   the owner's connection string. Required with NODE_ENV=production.
 *   DATABASE_URL             accepted instead outside production only (local docker compose, where they are the same).
 */
export class OperatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorConfigError';
  }
}

export interface OperatorDatabase {
  url: string;
  /** Which variable it came from, for the log line (never the value). */
  source: 'MIGRATION_DATABASE_URL' | 'DATABASE_URL';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when the URL's host is this machine (a local docker compose or CI database). */
export function isLoopbackDatabase(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

export function resolveOperatorDatabase(env: Readonly<Record<string, string | undefined>>): OperatorDatabase {
  const present = presentVariables(env);
  const production = present.NODE_ENV === 'production';
  let target: OperatorDatabase;
  const migration = present.MIGRATION_DATABASE_URL;
  if (migration !== undefined) {
    if (!POSTGRES_URL.test(migration)) throw new OperatorConfigError('MIGRATION_DATABASE_URL is not a postgres:// URL');
    target = { url: migration, source: 'MIGRATION_DATABASE_URL' };
  } else {
    if (production) throw new OperatorConfigError('MIGRATION_DATABASE_URL is required with NODE_ENV=production (the database owner\'s URL)');
    const runtime = present.DATABASE_URL;
    if (runtime === undefined) throw new OperatorConfigError('set MIGRATION_DATABASE_URL (or, outside production, DATABASE_URL)');
    if (!POSTGRES_URL.test(runtime)) throw new OperatorConfigError('DATABASE_URL is not a postgres:// URL');
    target = { url: runtime, source: 'DATABASE_URL' };
  }
  // A remote (e.g. Render) database is changed only on purpose: the operator procedure sets NODE_ENV=production.
  // Without it, a stray URL in .env could migrate or seed a deployed database from an unmerged branch.
  if (!production && !isLoopbackDatabase(target.url)) {
    throw new OperatorConfigError(`${target.source} points to a remote database; set NODE_ENV=production to run operator commands against it on purpose`);
  }
  return target;
}

/** Why `pnpm db:seed` must not run, or undefined. Demo data in production only when asked for explicitly. */
export function seedRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const present = presentVariables(env);
  if (present.NODE_ENV === 'production' && present.MANDATE_SEED_DEMO !== '1') {
    return 'refusing to write demo data with NODE_ENV=production; set MANDATE_SEED_DEMO=1 to seed a demo deployment on purpose';
  }
  return undefined;
}

export interface RuntimeLogin {
  login: string;
  password: string;
}

/** MANDATE_APP_DB_USER (default mandate_app) and MANDATE_APP_DB_PASSWORD, for `pnpm db:roles`. */
export function resolveRuntimeLogin(env: Readonly<Record<string, string | undefined>>): RuntimeLogin {
  const present = presentVariables(env);
  const password = present.MANDATE_APP_DB_PASSWORD;
  if (password === undefined) throw new OperatorConfigError('MANDATE_APP_DB_PASSWORD is required (16-256 printable ASCII characters, no spaces)');
  return { login: present.MANDATE_APP_DB_USER ?? DEFAULT_APP_LOGIN, password };
}

/**
 * The same server and database as `ownerUrl`, logged in as the runtime login: used by `pnpm db:roles` to check
 * the new login from its own side. Only kept in memory; never printed.
 */
export function urlForLogin(ownerUrl: string, login: RuntimeLogin): string {
  const url = new URL(ownerUrl);
  url.username = encodeURIComponent(login.login);
  url.password = encodeURIComponent(login.password);
  return url.toString();
}
