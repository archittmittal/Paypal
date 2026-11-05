import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable } from '@mandate/api/eval-kit';

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

/** A fresh in-memory Postgres per scenario, so no scenario sees another's history. */
export async function createEvalDb(): Promise<Db> {
  const pglite = await PGlite.create();
  return {
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}
