import { describe, expect, it, vi } from 'vitest';
import { createPgDb, createPgPool, POOL_MAX, type ClientLike, type PoolLike } from '../src/db/pg.js';

function fakePool(options: { failOn?: string } = {}) {
  const log: string[] = [];
  const released: unknown[] = [];
  const client: ClientLike = {
    query: (text) => {
      log.push(text);
      if (options.failOn !== undefined && text === options.failOn) return Promise.reject(new Error(`${text} failed`));
      return Promise.resolve({ rows: [{ text }] });
    },
    release: (error) => {
      released.push(error);
    },
  };
  const end = vi.fn(() => Promise.resolve());
  const pool: PoolLike = {
    query: (text, params) => Promise.resolve({ rows: [{ text, params }] }),
    connect: () => Promise.resolve(client),
    end,
  };
  return { pool, log, released, end };
}

describe('createPgDb', () => {
  it('passes parameters through and returns rows', async () => {
    const db = createPgDb(fakePool().pool);
    expect(await db.query('SELECT $1', [1])).toEqual({ rows: [{ text: 'SELECT $1', params: [1] }] });
    expect(await db.query('SELECT 1')).toEqual({ rows: [{ text: 'SELECT 1', params: [] }] });
  });

  it('runs exec without params, so pg uses the multi-statement protocol', async () => {
    const { pool } = fakePool();
    const spy = vi.spyOn(pool, 'query');
    await createPgDb(pool).exec('SELECT 1; SELECT 2;');
    expect(spy).toHaveBeenCalledWith('SELECT 1; SELECT 2;');
  });

  it('commits and releases on success', async () => {
    const { pool, log, released } = fakePool();
    const result = await createPgDb(pool).transaction(async (tx) => {
      await tx.exec('SELECT 1');
      return (await tx.query('SELECT 2')).rows;
    });
    expect(result).toEqual([{ text: 'SELECT 2' }]);
    expect(log).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT']);
    expect(released).toEqual([undefined]);
  });

  it('rolls back, releases and rethrows when the callback fails', async () => {
    const { pool, log, released } = fakePool();
    await expect(
      createPgDb(pool).transaction(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
    expect(released).toEqual([undefined]);
  });

  it('destroys the connection when ROLLBACK itself fails', async () => {
    const { pool, released } = fakePool({ failOn: 'ROLLBACK' });
    await expect(createPgDb(pool).transaction(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('destroys the connection when COMMIT fails and ROLLBACK fails with a non-Error', async () => {
    const { pool, released } = fakePool();
    let calls = 0;
    const client: ClientLike = {
      query: (text) => {
        calls += 1;
        if (text === 'COMMIT') return Promise.reject(new Error('commit failed'));
        // A driver can reject with a non-Error; the adapter must still destroy the connection.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        if (text === 'ROLLBACK') return Promise.reject('connection lost');
        return Promise.resolve({ rows: [] });
      },
      release: (error) => {
        released.push(error);
      },
    };
    pool.connect = () => Promise.resolve(client);
    await expect(createPgDb(pool).transaction(() => Promise.resolve(1))).rejects.toThrow('commit failed');
    expect(calls).toBe(3);
    expect(released).toEqual([true]);
  });

  it('closes the pool', async () => {
    const { pool, end } = fakePool();
    await createPgDb(pool).close();
    expect(end).toHaveBeenCalled();
  });
});

describe('createPgPool', () => {
  it('creates a bounded pool without connecting', async () => {
    const pool = createPgPool('postgres://127.0.0.1:1/none');
    expect(pool.options.max).toBe(POOL_MAX);
    await pool.end();
  });
});
