import { describe, expect, it } from 'vitest';
import type { MandateView } from '../src/api';
import { resolvePath } from '../src/App';
import { fromForm, toForm, toSlug } from '../src/mandateForm';

const MANDATE: MandateView = {
  id: '00000000-0000-4000-8000-000000000021',
  name: 'Club supplies',
  status: 'ACTIVE',
  currency: 'USD',
  budgetMinor: 100_000,
  perItemCapMinor: 20_000,
  approvalThresholdMinor: 30_000,
  maxQuantityPerLine: 10,
  structuringWindowMinutes: 1440,
  priceDriftToleranceBps: 200,
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2027-01-01T00:00:00.000Z',
  policyVersion: '0.1.0',
  approver: { id: '00000000-0000-4000-8000-000000000012', displayName: 'Arjun' },
  categoryLimits: [
    { category: 'electronics', allowed: true, capMinor: 50_000 },
    { category: 'gift-cards', allowed: false },
  ],
};

describe('mandate form', () => {
  it('shows exact amounts and round-trips to the same PATCH body', () => {
    const form = toForm(MANDATE);
    expect(form).toMatchObject({ budget: '1000.00', perItemCap: '200.00', approvalThreshold: '300.00', maxQuantityPerLine: '10' });
    expect(form.categories).toEqual([
      { category: 'electronics', allowed: true, cap: '500.00' },
      { category: 'gift-cards', allowed: false, cap: '' },
    ]);
    expect(fromForm(form, 'USD')).toEqual({
      ok: true,
      change: {
        status: 'ACTIVE',
        budgetMinor: 100_000,
        perItemCapMinor: 20_000,
        approvalThresholdMinor: 30_000,
        maxQuantityPerLine: 10,
        categoryLimits: [
          { category: 'electronics', allowed: true, capMinor: 50_000 },
          { category: 'gift-cards', allowed: false },
        ],
      },
    });
  });

  it('turns typed category names into policy slugs', () => {
    expect(toSlug('  Office Supplies ')).toBe('office-supplies');
    expect(toSlug('Gift cards & vouchers')).toBe('gift-cards-vouchers');
    const form = { ...toForm(MANDATE), categories: [{ category: 'Office Supplies', allowed: true, cap: '' }] };
    const result = fromForm(form, 'USD');
    expect(result.ok && result.change.categoryLimits).toEqual([{ category: 'office-supplies', allowed: true }]);
  });

  it('refuses inexact or invalid amounts instead of rounding them, field by field', () => {
    const form = { ...toForm(MANDATE), budget: '1000.005', approvalThreshold: 'lots', maxQuantityPerLine: '2.5' };
    const result = fromForm(form, 'USD');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['approvalThreshold', 'budget', 'maxQuantityPerLine']);
    expect(result.errors.budget).toContain('USD');
  });

  it.each([['0'], ['10001'], [''], ['ten']])('refuses %j units per line', (value) => {
    expect(fromForm({ ...toForm(MANDATE), maxQuantityPerLine: value }, 'USD').ok).toBe(false);
  });

  it('flags empty, duplicate and badly capped categories by row', () => {
    const form = {
      ...toForm(MANDATE),
      categories: [
        { category: 'electronics', allowed: true, cap: '' },
        { category: 'Electronics', allowed: true, cap: '' },
        { category: '!!', allowed: true, cap: '' },
        { category: 'software', allowed: true, cap: '12.345' },
      ],
    };
    const result = fromForm(form, 'USD');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors.categories ?? {})).toEqual(['1', '2', '3']);
  });

  it('keeps an unknown status from the API as ACTIVE in the form', () => {
    expect(toForm({ ...MANDATE, status: 'SOMETHING' }).status).toBe('ACTIVE');
  });
});

describe('routes', () => {
  it('accepts known routes and purchase ids, and falls back to the request screen', () => {
    expect(resolvePath('#/mandate')).toBe('#/mandate');
    expect(resolvePath('#/purchases/00000000-0000-4000-8000-0000000000a1')).toBe('#/purchases/00000000-0000-4000-8000-0000000000a1');
    expect(resolvePath('#/purchases/<script>')).toBe('#/request');
    expect(resolvePath('')).toBe('#/request');
    expect(resolvePath(`#/approve/${'a'.repeat(43)}`)).toBe(`#/approve/${'a'.repeat(43)}`);
    expect(resolvePath('#/approve/short')).toBe('#/request');
  });
});
