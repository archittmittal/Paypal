import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable } from '../../src/db/db.js';

interface PgliteLike {
  query<T>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(query: string): Promise<unknown>;
}

function wrap(target: PgliteLike): Queryable {
  return {
    query: async <R>(text: string, params: readonly unknown[] = []) => ({ rows: (await target.query<R>(text, [...params])).rows }),
    exec: async (sql: string) => {
      await target.exec(sql);
    },
  };
}

/** A fresh in-memory Postgres (PGlite) behind the same `Db` interface the API uses. */
export async function createTestDb(): Promise<Db> {
  const pglite = await PGlite.create();
  return {
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}
