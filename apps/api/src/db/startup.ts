import type { Queryable } from './db.js';
import { loadMigrations, type Migration, migrationStatus, migrationStatusProblems } from './migrate.js';
import { runtimeRoleProblems } from './roles.js';

/** The API must not serve from this database. Messages name versions, roles and tables, never credentials. */
export class DatabaseNotReadyError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Refusing to start: ${problems.join('; ')}`);
    this.name = 'DatabaseNotReadyError';
    this.problems = problems;
  }
}

const CONNECTION_STRING = /postgres(ql)?:\/\/\S+/gi;

/**
 * A database error as one line that is safe to log: connection strings are removed, and only the message and the
 * SQLSTATE / errno code are kept. pg messages name hosts, databases and users at most, never passwords.
 */
export function safeDatabaseError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  const message = error.message.replace(CONNECTION_STRING, '<connection string>');
  return typeof code === 'string' && code !== '' ? `${message} [${code}]` : message;
}

export interface StartupCheckOptions {
  /** NODE_ENV=production: a privileged runtime login refuses the start unless explicitly allowed. */
  production: boolean;
  /** MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1. */
  allowPrivilegedRuntime: boolean;
  warn: (message: string) => void;
  /** Defaults to the migrations in this checkout. */
  migrations?: readonly Migration[];
}

export interface StartupCheckResult {
  /** Least-privilege findings that were only warned about (outside production, or explicitly allowed). */
  accepted: string[];
}

/**
 * Runs before the API listens. Fails closed:
 *   1. The database must be reachable and contain every migration of this checkout, unchanged: no pending, edited
 *      or foreign migration. Never overridable, so an incompatible schema is never served. A database that is only
 *      AHEAD (migrated for a later release, every extra version newer than this code's) is accepted with a warning:
 *      migrations are forward-only and backward compatible, and refusing it would take the running release down
 *      on its next restart (a Free instance restarts after every idle spin-down) while the next one is deployed.
 *   2. The login must be least-privilege (runtimeRoleProblems). In production a finding refuses the start unless
 *      MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1; elsewhere (the local compose superuser) findings are warnings.
 * Read-only: catalog and schema_migrations reads, no locks.
 */
export async function checkDatabaseAtStartup(db: Queryable, options: StartupCheckOptions): Promise<StartupCheckResult> {
  let schemaProblems: string[];
  let ahead: string[];
  let historyDiffers: boolean;
  let roleProblems: string[];
  try {
    const status = await migrationStatus(db, options.migrations ?? loadMigrations());
    schemaProblems = migrationStatusProblems(status, { allowAhead: true });
    ahead = status.ahead;
    historyDiffers = status.edited.length > 0 || status.unknown.length > 0;
    roleProblems = schemaProblems.length > 0 ? [] : await runtimeRoleProblems(db);
  } catch (error) {
    throw new DatabaseNotReadyError([`could not check the database: ${safeDatabaseError(error)}`]);
  }
  if (schemaProblems.length === 0 && ahead.length > 0) {
    options.warn(`database is migrated for a later release (${ahead.join(', ')}); serving with this release until it is deployed`);
  }
  if (schemaProblems.length > 0) {
    throw new DatabaseNotReadyError([
      ...schemaProblems,
      historyDiffers
        ? "the database's migration history does not match this code; deploy the commit it was migrated from (docs/deployment-render.md, troubleshooting)"
        : 'run `pnpm db:migrate` with MIGRATION_DATABASE_URL (docs/deployment-render.md), then deploy again',
    ]);
  }
  if (roleProblems.length === 0) return { accepted: [] };
  if (options.production && !options.allowPrivilegedRuntime) {
    throw new DatabaseNotReadyError([
      ...roleProblems,
      'DATABASE_URL must use the restricted login created by `pnpm db:roles` (docs/deployment-render.md)',
    ]);
  }
  if (options.production) {
    // An explicit production override: every finding, at every start, so it stays visible in the logs.
    for (const problem of roleProblems) options.warn(`database login is not least-privilege (accepted by MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1): ${problem}`);
  } else {
    // Local development usually runs as the compose superuser: one summary line, not one per table.
    const shown = roleProblems.slice(0, 3).join('; ');
    options.warn(
      `database login is not least-privilege (not enforced outside NODE_ENV=production): ${roleProblems.length} finding(s), e.g. ${shown}. ` +
        'Production requires the restricted login from `pnpm db:roles`.',
    );
  }
  return { accepted: roleProblems };
}
