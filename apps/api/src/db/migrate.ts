import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

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
