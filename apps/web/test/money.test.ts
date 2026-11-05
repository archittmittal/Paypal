import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMoney, minorToDecimal, parseMoneyInput } from '../src/money';

describe('money in the UI', () => {
  it('knows minor-unit exponents', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it.each([
    [0, 'USD', '0.00'],
    [5, 'USD', '0.05'],
    [123456, 'USD', '1234.56'],
    [-150, 'USD', '-1.50'],
    [500, 'JPY', '500'],
    [1234, 'KWD', '1.234'],
    [Number.MAX_SAFE_INTEGER, 'USD', '90071992547409.91'],
  ])('minorToDecimal(%i, %s) = %s', (minor, currency, text) => {
    expect(minorToDecimal(minor, currency)).toBe(text);
  });

  it('refuses non-integer minor units', () => {
    expect(() => minorToDecimal(1.5, 'USD')).toThrow(RangeError);
  });

  it('formats with grouping and symbol, exactly', () => {
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'USD')).toBe('$90,071,992,547,409.91');
    expect(formatMoney(500, 'JPY')).toBe('\u00A5500');
  });

  it.each([
    ['12', 'USD', 1200],
    ['12.3', 'USD', 1230],
    ['12.34', 'USD', 1234],
    ['$1,234.50', 'USD', 123450],
    [' 0.07 ', 'USD', 7],
    ['12.', 'USD', 1200],
    ['500', 'JPY', 500],
    ['1.234', 'KWD', 1234],
    // 0.1 + 0.2 territory: string arithmetic keeps it exact.
    ['0.30', 'USD', 30],
  ])('parseMoneyInput(%j, %s) = %i', (text, currency, minor) => {
    expect(parseMoneyInput(text, currency)).toBe(minor);
  });

  it.each([['12.345', 'USD'], ['-1', 'USD'], ['1e3', 'USD'], ['', 'USD'], ['abc', 'USD'], ['1.5', 'JPY'], ['999999999999999', 'USD']])(
    'refuses %j in %s rather than rounding',
    (text, currency) => {
      expect(parseMoneyInput(text, currency)).toBeNull();
    },
  );
});
