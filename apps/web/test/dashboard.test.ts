import { describe, expect, it } from 'vitest';
import type { MandateView, PurchaseListItem, Summary } from '../src/api';
import { age, budgetSegments, categoryRows, countBy, describeAudit, filterItems } from '../src/dashboard';

const SUMMARY: Summary = {
  mandateId: '00000000-0000-4000-8000-000000000021',
  currency: 'USD',
  budgetMinor: 100_000,
  committedMinor: 20_000,
  heldMinor: 30_000,
  remainingMinor: 50_000,
  byCategory: [
    { category: 'electronics', committedMinor: 20_000, heldMinor: 25_000 },
    { category: 'office-supplies', committedMinor: 0, heldMinor: 5_000 },
  ],
  byStatus: {},
  pendingApprovals: 1,
  blocked: 2,
};

const MANDATE = {
  categoryLimits: [
    { category: 'electronics', allowed: true, capMinor: 50_000 },
    { category: 'gift-cards', allowed: false },
    { category: 'office-supplies', allowed: true },
    { category: 'software', allowed: true, capMinor: 25_000 },
  ],
} as unknown as MandateView;

const item = (status: string): PurchaseListItem => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  status,
  failureCode: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  text: 't',
  requester: 'Riya',
  outcome: null,
  reasonCodes: [],
  totalMinor: null,
  currency: null,
});

describe('dashboard helpers', () => {
  it('splits the budget into spent, held and left', () => {
    expect(budgetSegments(SUMMARY)).toEqual({ committed: 20_000, held: 30_000, remaining: 50_000, shares: [0.2, 0.3, 0.5] });
  });

  it('keeps the meter sane when spend passes the budget or the budget is zero', () => {
    const over = budgetSegments({ ...SUMMARY, budgetMinor: 40_000, remainingMinor: -10_000 });
    expect(over.remaining).toBe(0);
    expect(over.shares[0] + over.shares[1] + over.shares[2]).toBeCloseTo(1);
    expect(budgetSegments({ ...SUMMARY, budgetMinor: 0, committedMinor: 0, heldMinor: 0, remainingMinor: 0 }).shares).toEqual([0, 0, 0]);
  });

  it('lists categories against their caps, allowed first, busiest first', () => {
    expect(categoryRows(SUMMARY, MANDATE)).toEqual([
      { category: 'electronics', allowed: true, spentMinor: 20_000, heldMinor: 25_000, capMinor: 50_000, share: 0.9 },
      { category: 'office-supplies', allowed: true, spentMinor: 0, heldMinor: 5_000, capMinor: null, share: null },
      { category: 'software', allowed: true, spentMinor: 0, heldMinor: 0, capMinor: 25_000, share: 0 },
      { category: 'gift-cards', allowed: false, spentMinor: 0, heldMinor: 0, capMinor: null, share: null },
    ]);
  });

  it('shows spend in a category the mandate no longer lists, as not allowed', () => {
    const rows = categoryRows({ ...SUMMARY, byCategory: [{ category: 'furniture', committedMinor: 100, heldMinor: 0 }] }, MANDATE);
    expect(rows.find((r) => r.category === 'furniture')).toMatchObject({ allowed: false, spentMinor: 100 });
  });

  it('groups requests for the filters', () => {
    const statuses = ['DENIED', 'REJECTED', 'FAILED', 'EXPIRED', 'PENDING_APPROVAL', 'NEEDS_CLARIFICATION', 'PAYMENT_PENDING', 'CAPTURED', 'UNKNOWN_OUTCOME', 'NO_MATCH'];
    const items = statuses.map(item);
    expect(countBy(items)).toEqual({ all: 10, blocked: 4, waiting: 2, paid: 3 });
    expect(filterItems(items, 'all')).toHaveLength(10);
    expect(filterItems(items, 'paid').map((i) => i.status)).toEqual(['PAYMENT_PENDING', 'CAPTURED', 'UNKNOWN_OUTCOME']);
  });

  it.each([
    ['2026-11-05T10:00:00.000Z', 'just now'],
    ['2026-11-05T09:48:00.000Z', '12 min'],
    ['2026-11-05T07:00:00.000Z', '3 h'],
    ['2026-11-02T10:00:00.000Z', '3 days'],
    ['2026-11-05T10:05:00.000Z', 'just now'],
  ])('age(%s) = %s', (iso, text) => {
    expect(age(iso, new Date('2026-11-05T10:00:30.000Z'))).toBe(text);
  });

  it('describes audit entries in plain words, keeping unknown ones as they are', () => {
    expect(describeAudit({ at: '', actorType: 'system', actorId: null, action: 'policy.decided', policyVersion: '0.1.0' })).toEqual({
      what: 'Mandate decided',
      who: 'Mandate',
    });
    expect(describeAudit({ at: '', actorType: 'robot', actorId: null, action: 'new.thing', policyVersion: null })).toEqual({ what: 'new.thing', who: 'robot' });
  });
});
