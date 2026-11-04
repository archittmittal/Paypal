import pg from 'pg';
import type { Db, Queryable } from './db.js';

/** The parts of `pg.Pool` used here, so the adapter can be tested without a server. */
export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
}

export interface ClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(error?: Error | boolean): void;
}

export const POOL_MAX = 10;

export function createPgPool(connectionString: string): pg.Pool {
  // sslmode in the URL is honoured by pg itself (Render's external URLs need it; internal ones do not).
  return new pg.Pool({ connectionString, max: POOL_MAX, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

function queryable(target: { query: ClientLike['query'] }): Queryable {
  return {
    query: async <R>(text: string, params: readonly unknown[] = []) => {
      const result = await target.query(text, [...params]);
      return { rows: result.rows as R[] };
    },
    exec: async (sql: string) => {
      // Without params pg uses the simple protocol, which accepts several statements.
      await target.query(sql);
    },
  };
}

export function createPgDb(pool: PoolLike): Db {
  return {
    ...queryable(pool),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(queryable(client));
        await client.query('COMMIT');
        client.release();
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
          client.release();
        } catch (rollbackError) {
          // A connection that cannot roll back is broken: destroy it instead of returning it to the pool.
          client.release(rollbackError instanceof Error ? rollbackError : true);
        }
        throw error;
      }
    },
    close: () => pool.end(),
  };
}
