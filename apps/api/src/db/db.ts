/**
 * The narrow database surface the API uses. `pg` implements it in production (./pg.ts); tests use PGlite,
 * which is real Postgres compiled to WebAssembly, so SQL and constraints behave the same.
 */
export interface Queryable {
  /** One parameterised statement. Always pass values as params, never by string concatenation. */
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
  /** Runs a multi-statement script with no parameters (migrations only). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs `fn` in one transaction: COMMIT if it resolves, ROLLBACK if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * `pg` returns bigint columns as strings to avoid precision loss; PGlite may return numbers or bigints.
 * Money is compared in BigInt either way.
 */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError('Expected an integer database value');
}
