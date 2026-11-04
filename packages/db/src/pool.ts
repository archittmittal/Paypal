import pg from 'pg';
import { connectionOptions, type DatabaseConfig } from './config.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: a pool, a pooled client or a standalone client. */
export type Queryable = Pick<pg.ClientBase, 'query'>;
/**
 * One connection, as `withTransaction` hands out. A Pool does not qualify: each of its queries may run on a
 * different connection in its own implicit transaction, so a row lock taken by one would be gone by the next.
 */
export type TransactionClient = pg.ClientBase;

/**
 * bigint (int8) arrives from Postgres as a string. Money columns are capped at Number.MAX_SAFE_INTEGER by the
 * minor_units domain, so converting is exact; anything larger is refused instead of silently rounded.
 */
export function parseInt8(value: string): number {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('int8 value exceeds the safe integer range');
  }
  return Number(parsed);
}

// Scoped to pools built here: pg's global type registry is left alone.
const types: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) => {
    if (oid === pg.types.builtins.INT8 && format !== 'binary') return parseInt8;
    const fallback: unknown = pg.types.getTypeParser(oid, format);
    return fallback;
  },
};

export interface PoolOptions {
  /**
   * Called when an idle client fails (e.g. the server restarted). Without a listener pg would crash the process.
   * Defaults to a one-line warning carrying only the SQLSTATE or error name.
   */
  onError?: (error: Error) => void;
  applicationName?: string;
}

/**
 * Settings shared by pools and standalone clients. The password is a function (see connectionOptions), so neither
 * the pool nor its clients hold it in an enumerable property. TCP keepalive lets the OS notice a dead peer, and the
 * server ends a session that sits idle inside a transaction (finding L7).
 */
function clientConfig(config: DatabaseConfig, applicationName: string): pg.ClientConfig {
  return {
    ...connectionOptions(config),
    connectionTimeoutMillis: config.connectTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
    keepAlive: true,
    application_name: applicationName,
    types,
  };
}

export function createPool(config: DatabaseConfig, options: PoolOptions = {}): Pool {
  const pool = new pg.Pool({
    ...clientConfig(config, options.applicationName ?? 'mandate'),
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
  });
  // The default reports the failure without its message, which could name the host or the user.
  pool.on('error', options.onError ?? ((error: Error) => console.warn(`[db] idle client error: ${sqlState(error) ?? error.name}`)));
  return pool;
}

/**
 * A single connection outside the pool, for the migration runner's session-scoped advisory lock.
 * pg emits 'error' when the connection drops, and an EventEmitter with no listener throws, which would crash
 * the process between two statements. The listener only records the failure: the next query on the client
 * rejects on its own, so the caller still sees the error where it can handle it.
 */
export function createClient(config: DatabaseConfig, applicationName = 'mandate', onError: (error: Error) => void = () => undefined): pg.Client {
  const client = new pg.Client(clientConfig(config, applicationName));
  client.on('error', onError);
  return client;
}

/**
 * COMMIT was sent but no answer came back: the connection failed first. The server may have committed or rolled
 * back, and nothing on this side can tell which (finding M3). Callers must not treat this as a failure: they
 * re-read the state (or retry an idempotent operation such as reserveBudget(), which returns the existing hold).
 */
export class CommitOutcomeUnknownError extends Error {
  constructor(options?: ErrorOptions) {
    super('the connection failed during COMMIT; the transaction may or may not have committed', options);
    this.name = 'CommitOutcomeUnknownError';
  }
}

/**
 * The server answered COMMIT with ROLLBACK: the transaction had already failed (a statement errored and `work`
 * caught the error instead of rethrowing it), so nothing was committed. Without this check withTransaction would
 * report success for writes that never happened (third review, M2).
 */
export class TransactionRolledBackError extends Error {
  constructor() {
    super('COMMIT was answered with ROLLBACK: an earlier statement in the transaction failed, so nothing was committed');
    this.name = 'TransactionRolledBackError';
  }
}

/**
 * True when an error means the connection itself failed rather than the server rejecting a statement: no SQLSTATE
 * at all (a socket error, "Connection terminated"), class 08 (connection exception), or the server shutting down or
 * terminating the session (57P01-57P03).
 */
export function isConnectionFailure(error: unknown): boolean {
  const code = sqlState(error);
  return code === undefined || code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03';
}

/**
 * Runs `work` inside one READ COMMITTED transaction on one pooled client. Commits on success, rolls back on any
 * error and rethrows it. READ COMMITTED is explicit because the budget invariant (migration 0002) relies on it.
 *
 * While the client is checked out, pg-pool removes its own idle-error handling, so this function listens for
 * connection errors itself; without that, a connection dropped mid-transaction crashes the process. A client
 * whose connection failed, or whose ROLLBACK failed, is destroyed rather than returned to the pool.
 *
 * COMMIT outcomes: if the server answers COMMIT with an error, the transaction was rolled back and that error is
 * rethrown; if it answers with ROLLBACK (an earlier statement failed and `work` swallowed the error),
 * TransactionRolledBackError is thrown. If the connection fails during COMMIT, CommitOutcomeUnknownError is thrown.
 *
 * Before a client goes back to the pool its session is reset with DISCARD ALL (finding L7), so settings, advisory
 * locks or prepared statements from one transaction never leak into the next borrower's. A client that cannot be
 * reset is destroyed. Only this function resets: queries run directly on the pool (pool.query) do not.
 */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionError: Error | undefined;
  let destroy = false;
  const onError = (error: Error) => {
    connectionError = error;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      if (connectionError === undefined) {
        await client.query('ROLLBACK').catch(() => {
          destroy = true;
        });
      }
      throw error;
    }
    let committed: pg.QueryResult;
    try {
      committed = await client.query('COMMIT');
    } catch (error) {
      if (connectionError !== undefined || isConnectionFailure(error)) {
        destroy = true;
        throw new CommitOutcomeUnknownError({ cause: error });
      }
      throw error; // the server answered: the transaction was rolled back
    }
    if (committed.command === 'ROLLBACK') throw new TransactionRolledBackError();
    return result;
  } finally {
    client.removeListener('error', onError);
    if (connectionError === undefined && !destroy) {
      await client.query('DISCARD ALL').catch(() => {
        destroy = true;
      });
    }
    client.release(connectionError ?? destroy);
  }
}

/** Postgres SQLSTATE of a driver error, if it carries one. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** SQLSTATEs raised by the schema's own rules (migrations 0002, 0004, 0006) and the constraints callers rely on. */
export const SQLSTATE = {
  BUDGET_EXCEEDED: 'MD001',
  APPEND_ONLY: 'MD002',
  ILLEGAL_RESERVATION_CHANGE: 'MD003',
  UNSUPPORTED_ISOLATION: 'MD004',
  CURRENCY_MISMATCH: 'MD005',
  MANDATE_INACTIVE: 'MD006',
  MISMATCHED_ROW: 'MD007',
  ILLEGAL_ORDER_CHANGE: 'MD008',
  CAPTURE_EVIDENCE: 'MD009',
  NOT_AUTHORIZED: 'MD010',
  APPROVER_NOT_ELIGIBLE: 'MD011',
  ILLEGAL_APPROVAL_CHANGE: 'MD012',
  MIGRATION_REFUSED_DATA: 'MD013',
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
} as const;
