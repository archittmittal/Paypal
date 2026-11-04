import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from '../src/pool.js';
import { reserveBudget } from '../src/reservations.js';

// Compile-time checks: `pnpm typecheck` fails if a @ts-expect-error line stops being an error.
describe('reserveBudget signature (review finding L8)', () => {
  const input = { mandateId: 'm', policyDecisionId: 'd', amount: { amountMinor: 1, currency: 'USD' }, expiresAt: new Date() };

  it('accepts a single client but not a Pool, whose queries would each run in their own transaction', () => {
    const withClient = (client: PoolClient) => reserveBudget(client, input);
    // @ts-expect-error -- a Pool is not a TransactionClient: the row lock would not survive between queries
    const withPool = (pool: Pool) => reserveBudget(pool, input);
    expect([typeof withClient, typeof withPool]).toEqual(['function', 'function']);
  });
});
