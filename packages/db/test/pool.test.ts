import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '../src/config.js';
import { CommitOutcomeUnknownError, createClient, createPool, isConnectionFailure, parseInt8, sqlState } from '../src/pool.js';

describe('parseInt8', () => {
  it('converts safe bigint strings exactly', () => {
    expect(parseInt8('0')).toBe(0);
    expect(parseInt8('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseInt8('-42')).toBe(-42);
  });

  it('refuses values it could not represent exactly, instead of rounding', () => {
    expect(() => parseInt8('9007199254740992')).toThrow(RangeError);
    expect(() => parseInt8('-9007199254740992')).toThrow(RangeError);
  });
});

describe('sqlState', () => {
  it('reads the SQLSTATE from driver errors and ignores everything else', () => {
    expect(sqlState(Object.assign(new Error('x'), { code: 'MD001' }))).toBe('MD001');
    expect(sqlState(new Error('x'))).toBeUndefined();
    expect(sqlState({ code: 23505 })).toBeUndefined();
    expect(sqlState(null)).toBeUndefined();
    expect(sqlState('MD001')).toBeUndefined();
  });
});

describe('pool and client objects never show the password (second review finding L8)', () => {
  // Default util.inspect only. With showHidden: true, pg's own non-enumerable password property on a connected client
  // is visible (third review nit); nothing in this codebase inspects with showHidden.
  it('keeps it out of default util.inspect at any depth, before connecting', async () => {
    const config = loadDatabaseConfig({ DATABASE_URL: 'postgres://app:hunter2-very-secret@127.0.0.1:1/x' });
    const pool = createPool(config, { onError: () => undefined });
    const client = createClient(config);
    try {
      for (const target of [pool, client]) {
        expect(inspect(target, { depth: Infinity })).not.toContain('hunter2-very-secret');
      }
    } finally {
      await pool.end();
    }
  });
});

describe('isConnectionFailure and CommitOutcomeUnknownError (second review finding M3)', () => {
  it('treats a missing SQLSTATE, class 08 and a terminated session as connection failures, and server errors as known', () => {
    expect(isConnectionFailure(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error('x'), { code: '08006' }))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error('x'), { code: '57P01' }))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isConnectionFailure(Object.assign(new Error('x'), { code: '40001' }))).toBe(false);
  });

  it('keeps the original error as its cause', () => {
    const cause = new Error('socket hang up');
    const error = new CommitOutcomeUnknownError({ cause });
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('CommitOutcomeUnknownError');
  });
});
