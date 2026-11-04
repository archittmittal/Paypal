import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseConfig } from './config.js';
import { createClient, isConnectionFailure } from './pool.js';

/** packages/db/migrations: plain SQL, applied in version order, forward-only. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Any constant works; it only has to be the same for every runner. Serializes concurrent `db:migrate` runs. */
export const MIGRATION_LOCK_KEY = 727_160_001;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export class MigrationError extends Error {
  readonly version: string | undefined;

  constructor(message: string, version?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
    this.version = version;
  }
}

function timeoutMs(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('timeouts must be non-negative integers (milliseconds)');
  return ms;
}

/**
 * Line endings are normalized first, so a Windows checkout does not look like an edited migration, and a leading
 * UTF-8 byte-order mark (which some editors add) is ignored for the same reason.
 */
export function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).digest('hex');
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/;

/**
 * Splits a migration into top-level statements with every comment, string literal, quoted identifier and
 * dollar-quoted body blanked out, so a keyword inside any of them is never mistaken for a statement (finding L4).
 * A single left-to-right scan, the way the server's lexer reads it: '--' inside a string is not a comment, and a
 * quote inside a comment does not open a string. Handles '' and E'\'' escapes, "" in identifiers, nested block
 * comments and $tag$ quoting. Unterminated constructs are an error rather than a guess.
 * Known limit: SQL-standard bodies (BEGIN ATOMIC ... END) contain bare semicolons and are refused; use $$ bodies.
 */
export function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const unterminated = (what: string) => new MigrationError(`unterminated ${what} in migration`);
  while (i < sql.length) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';
    const previous = i > 0 ? (sql[i - 1] ?? '') : '';
    if (ch === '-' && next === '-') {
      // The server ends a line comment at \n or \r, so a lone \r (old Mac line ending) ends it too (third review, L2).
      let end = i + 2;
      while (end < sql.length && sql[end] !== '\n' && sql[end] !== '\r') end++;
      i = end;
      current += ' ';
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= sql.length) throw unterminated('block comment');
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      current += ' ';
    } else if (ch === "'") {
      // An escape string is E'...' where the E is a token of its own, not the end of an identifier such as "name".
      const before = i >= 2 ? (sql[i - 2] ?? '') : '';
      const escapes = (previous === 'E' || previous === 'e') && !IDENTIFIER_CHAR.test(before);
      i++;
      for (;;) {
        if (i >= sql.length) throw unterminated('string literal');
        const c = sql[i];
        if (escapes && c === '\\') {
          i += 2;
        } else if (c === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (c === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      current += "''";
    } else if (ch === '"') {
      i++;
      for (;;) {
        if (i >= sql.length) throw unterminated('quoted identifier');
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      current += '"x"';
    } else if (ch === '$' && !IDENTIFIER_CHAR.test(previous) && DOLLAR_TAG.test(sql.slice(i, i + 130))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 130))?.[0] ?? '$$';
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw unterminated(`dollar-quoted body ${tag}`);
      i = end + tag.length;
      current += ' ';
    } else if (ch === ';') {
      statements.push(current);
      current = '';
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== '');
}

/** The runner wraps each file in one transaction; a file that ends or splits it would be applied partially. */
const TRANSACTION_CONTROL = /^(?:BEGIN|COMMIT|ROLLBACK|END|ABORT|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/i;

export function assertNoTransactionControl(filename: string, sql: string): void {
  for (const statement of topLevelStatements(sql)) {
    if (TRANSACTION_CONTROL.test(statement)) {
      throw new MigrationError(`${filename} contains a transaction-control statement (${statement.split(/\s+/)[0] ?? ''}); the runner already wraps each file in one transaction`);
    }
  }
}

/**
 * Turns a directory listing into ordered migrations. Every .sql file must be named NNNN_snake_case.sql and
 * versions must run 0001, 0002, ... with no gap or duplicate, so a mis-numbered file fails loudly here.
 */
export function parseMigrations(entries: readonly { filename: string; sql: string }[]): MigrationFile[] {
  const migrations = entries
    .filter((entry) => entry.filename.endsWith('.sql'))
    .map(({ filename, sql }) => {
      const match = FILENAME.exec(filename);
      if (!match) throw new MigrationError(`Migration file name must look like 0001_name.sql: ${filename}`);
      assertNoTransactionControl(filename, sql);
      return { version: match[1] ?? '', name: match[2] ?? '', sql, checksum: checksum(sql) };
    })
    .sort((a, b) => a.version.localeCompare(b.version));

  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (migration.version !== expected) {
      throw new MigrationError(`Expected migration ${expected}, found ${migration.version} (gap or duplicate)`, migration.version);
    }
  });
  return migrations;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return parseMigrations(readdirSync(dir).map((filename) => ({ filename, sql: readFileSync(join(dir, filename), 'utf8') })));
}

/**
 * Decides what to run. Refuses when the database has a version this code does not know (it is newer than the
 * checkout) or when an applied migration's file changed since it ran (migrations are forward-only: add a new one).
 */
export function planMigrations(files: readonly MigrationFile[], applied: readonly AppliedMigration[]): MigrationFile[] {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (file === undefined) {
      throw new MigrationError(`Database has migration ${row.version}_${row.name}, which this checkout does not; update your branch`, row.version);
    }
    if (file.name !== row.name || file.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${row.version}_${row.name} changed after it was applied. Never edit an applied migration; add a new one`,
        row.version,
      );
    }
  }
  const done = new Set(applied.map((row) => row.version));
  return files.filter((file) => !done.has(file.version));
}

/**
 * Every session-level change one migration can make, undone before the next migration runs, so a SET (search_path,
 * role, timeouts, a custom setting), a temp table, a prepared statement, an open cursor or a LISTEN cannot leak from
 * one migration into another (third review nit). Then the runner's own timeouts are set again.
 * Not DISCARD ALL: it would also release the advisory lock that serializes runners.
 */
async function isolateSession(client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, lockTimeout: string, statementTimeout: string): Promise<void> {
  for (const sql of ['RESET ALL', 'RESET ROLE', 'RESET SESSION AUTHORIZATION', 'DISCARD TEMP', 'DISCARD PLANS', 'DEALLOCATE ALL', 'CLOSE ALL', 'UNLISTEN *']) {
    await client.query(sql);
  }
  await client.query(`SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)`, [lockTimeout, statementTimeout]);
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export interface MigrateOptions {
  migrations?: readonly MigrationFile[];
  log?: (line: string) => void;
  /**
   * How long a migration statement may wait for a table lock before failing, rather than stalling live traffic
   * behind it. Applies to the migrations only, never to waiting for another runner.
   */
  lockTimeoutMs?: number;
  /** Upper bound on any single migration statement. 0 disables it. */
  statementTimeoutMs?: number;
}

/**
 * Applies pending migrations. Safe to run concurrently (session advisory lock), each migration is atomic
 * (one transaction with its bookkeeping row), and a failed migration leaves the database at the previous version.
 * A second runner waits for the first, however long it takes, then finds nothing left to do.
 */
export async function migrate(config: DatabaseConfig, options: MigrateOptions = {}): Promise<MigrateResult> {
  const files = options.migrations ?? loadMigrations();
  const log = options.log ?? (() => undefined);
  const lockTimeout = String(timeoutMs(options.lockTimeoutMs, 15_000));
  const statementTimeout = String(timeoutMs(options.statementTimeoutMs, 10 * 60_000));
  let connectionLost = false;
  const client = createClient(config, 'mandate-migrate', () => {
    connectionLost = true;
  });
  // Server WARNINGs and NOTICEs from a migration (for example 0007 on large objects) reach the operator.
  client.on('notice', (notice) => log(`${notice.severity ?? 'NOTICE'}: ${notice.message ?? ''}`));
  await client.connect();
  try {
    // Waiting for another runner is unbounded: lock_timeout and statement_timeout both apply to an advisory lock
    // wait, so they are cleared first and only set, for the migrations themselves, once the lock is held.
    await client.query(`SELECT set_config('lock_timeout', '0', false), set_config('statement_timeout', '0', false)`);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)`, [lockTimeout, statementTimeout]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          version    text PRIMARY KEY,
          name       text NOT NULL,
          checksum   text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<AppliedMigration>('SELECT version, name, checksum FROM public.schema_migrations ORDER BY version');
      const pending = planMigrations(files, rows);

      for (const migration of pending) {
        const label = `Migration ${migration.version}_${migration.name}`;
        log(`applying ${migration.version}_${migration.name}`);
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
            migration.version,
            migration.name,
            migration.checksum,
          ]);
        } catch (error) {
          // The messages say only what is known (finding M3). A transaction that never reached COMMIT is never
          // committed: if ROLLBACK cannot be sent, the server discards it when the session ends.
          const rolledBack = await client.query('ROLLBACK').then(
            () => true,
            () => false,
          );
          const reason = error instanceof Error ? error.message : String(error);
          throw new MigrationError(
            rolledBack
              ? `${label} failed and was rolled back: ${reason}`
              : `${label} failed and was not committed (the connection was lost; the server discards the open transaction): ${reason}`,
            migration.version,
            { cause: error },
          );
        }
        try {
          await client.query('COMMIT');
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (connectionLost || isConnectionFailure(error)) {
            throw new MigrationError(
              `${label}: outcome unknown, the connection failed during COMMIT (${reason}). Rerun db:migrate: it skips the migration if this COMMIT took effect and applies it otherwise`,
              migration.version,
              { cause: error },
            );
          }
          throw new MigrationError(`${label} failed at COMMIT and was rolled back: ${reason}`, migration.version, { cause: error });
        }
        // Committed. A failure from here on is not a failed migration: it is reported as what it is.
        try {
          await isolateSession(client, lockTimeout, statementTimeout);
        } catch (error) {
          throw new MigrationError(`${label} was applied, but resetting the session afterwards failed; rerun db:migrate`, migration.version, { cause: error });
        }
      }
      return { applied: pending.map((m) => `${m.version}_${m.name}`), alreadyApplied: rows.length };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}
