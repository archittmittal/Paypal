import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable } from './db.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Fixed key for pg_advisory_xact_lock, so two deploys starting at once cannot migrate concurrently. */
const MIGRATION_LOCK_KEY = 728_301_455;
const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function checksum(sql: string): string {
  // Line endings are normalised so a Windows checkout does not look like an edited migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const match = FILE_NAME.exec(file);
    if (!match?.[1] || !match[2]) throw new MigrationError(`Bad migration file name: ${file}`);
    if (seen.has(match[1])) throw new MigrationError(`Duplicate migration version: ${match[1]}`);
    seen.add(match[1]);
    const sql = readFileSync(join(dir, file), 'utf8');
    return { version: match[1], name: match[2], sql, checksum: checksum(sql) };
  });
}

export interface MigrationStatus {
  /** schema_migrations exists. False on a database that was never migrated. */
  initialized: boolean;
  /** Local migrations not applied yet, in order. */
  pending: string[];
  /** Applied migrations whose file changed since. */
  edited: string[];
  /**
   * Applied migrations this checkout does not know that are NOT simply newer than all of its migrations (a gap or
   * a foreign version): the database's history differs from the code's.
   */
  unknown: string[];
  /**
   * Applied migrations newer than every local one, with all local ones applied unchanged: the database has been
   * migrated for a later release (the operator migrates before deploying it). Compatible under the forward-only,
   * backward-compatible migration rule, so the running release may keep serving.
   */
  ahead: string[];
}

/**
 * Compares the database with the local migrations without changing anything: no lock, no CREATE TABLE. The API
 * runs this at startup (src/db/startup.ts). Needs only SELECT on schema_migrations, which the runtime role has.
 */
export async function migrationStatus(db: Queryable, migrations: readonly Migration[]): Promise<MigrationStatus> {
  const table = await db.query<{ exists: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
  if (!table.rows[0]?.exists) return { initialized: false, pending: migrations.map((m) => m.version), edited: [], unknown: [], ahead: [] };
  const { rows } = await db.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const applied = new Set(rows.map((row) => row.version));
  const newest = migrations.reduce((max, m) => (m.version > max ? m.version : max), '');
  const notLocal = rows.filter((row) => !byVersion.has(row.version)).map((row) => row.version);
  // Versions are fixed-width (NNNN), so string order is numeric order.
  const ahead = notLocal.filter((version) => version > newest);
  return {
    initialized: true,
    pending: migrations.filter((m) => !applied.has(m.version)).map((m) => m.version),
    edited: rows.filter((row) => byVersion.has(row.version) && byVersion.get(row.version)?.checksum !== row.checksum).map((row) => row.version),
    unknown: notLocal.filter((version) => version <= newest),
    ahead,
  };
}

/**
 * Human-readable reasons the schema does not match this checkout; empty when it does. Names versions only.
 * `allowAhead`: a database migrated for a later release is not a problem (the API at start-up); `pnpm db:status`
 * passes false, because an operator expects an exact match for the commit being deployed.
 */
export function migrationStatusProblems(status: MigrationStatus, options: { allowAhead?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (!status.initialized) problems.push('the database has never been migrated (no schema_migrations table)');
  else if (status.pending.length > 0) problems.push(`pending migrations: ${status.pending.join(', ')}`);
  if (status.edited.length > 0) problems.push(`applied migrations edited since: ${status.edited.join(', ')}`);
  if (status.unknown.length > 0) problems.push(`applied migrations unknown to this code (not newer than its own; histories differ): ${status.unknown.join(', ')}`);
  if (status.ahead.length > 0 && options.allowAhead !== true) {
    problems.push(`applied migrations newer than this code (database is migrated for a later release): ${status.ahead.join(', ')}`);
  }
  return problems;
}

/**
 * Applies pending migrations in one transaction (all or nothing) under an advisory lock.
 * Refuses to run if an applied migration was edited or is missing locally: never rewrite history,
 * add a new migration instead. Returns the versions applied by this call.
 */
export async function migrate(db: Db, migrations: readonly Migration[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await tx.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );

    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    for (const row of rows) {
      const local = byVersion.get(row.version);
      if (!local) throw new MigrationError(`Applied migration ${row.version} is missing locally`);
      if (local.checksum !== row.checksum) throw new MigrationError(`Applied migration ${row.version} was edited`);
    }

    const applied = new Set(rows.map((row) => row.version));
    const pending = migrations.filter((m) => !applied.has(m.version));
    for (const migration of pending) {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
    }
    return pending.map((m) => m.version);
  });
}
