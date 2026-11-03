import { describe, expect, it } from 'vitest';
import { AmountError, fromPaypalAmount, toPaypalAmount } from '../src/amount.js';

describe('toPaypalAmount', () => {
  it.each([
    [0, 'USD', '0.00'],
    [5, 'USD', '0.05'],
    [99, 'USD', '0.99'],
    [1999, 'USD', '19.99'],
    [100000, 'EUR', '1000.00'],
    [Number.MAX_SAFE_INTEGER, 'USD', '90071992547409.91'],
    [1500, 'JPY', '1500'],
  ])('formats %i %s as %s', (amountMinor, currency, value) => {
    expect(toPaypalAmount({ amountMinor, currency })).toEqual({ currency_code: currency, value });
  });

  it('rejects a float amount instead of rounding it', () => {
    expect(() => toPaypalAmount({ amountMinor: 10.5, currency: 'USD' })).toThrow();
  });
});

describe('fromPaypalAmount', () => {
  it.each([
    ['19.99', 'USD', 1999],
    ['19.9', 'USD', 1990],
    ['19', 'USD', 1900],
    ['0.01', 'USD', 1],
    ['1500', 'JPY', 1500],
  ])('parses %s %s as %i minor units', (value, currency, amountMinor) => {
    expect(fromPaypalAmount({ currency_code: currency, value })).toEqual({ amountMinor, currency });
  });

  it.each([
    ['too many decimals', '1.999', 'USD'],
    ['a negative value', '-1.00', 'USD'],
    ['an exponent', '1e3', 'USD'],
    ['decimals on a zero-decimal currency', '15.00', 'JPY'],
    ['an empty string', '', 'USD'],
    ['a lowercase currency', '1.00', 'usd'],
    ['beyond safe integers', '90071992547409.92', 'USD'],
  ])('rejects %s', (_label, value, currency) => {
    expect(() => fromPaypalAmount({ currency_code: currency, value })).toThrow(AmountError);
  });

  it('round-trips through toPaypalAmount', () => {
    for (const amountMinor of [0, 1, 10, 101, 123456789]) {
      const money = { amountMinor, currency: 'USD' };
      expect(fromPaypalAmount(toPaypalAmount(money))).toEqual(money);
    }
  });
});
