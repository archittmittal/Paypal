/**
 * Money in the UI. Amounts are integer minor units (hard rule 4); conversion to and from text is done on
 * digit strings, never through floating point.
 */

/** Minor-unit digits for a currency (2 for USD, 0 for JPY), from the platform's ISO 4217 data. */
export function currencyExponent(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** 123456 USD -> "1234.56" (exact). */
export function minorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('Amount must be a safe integer of minor units');
  const exponent = currencyExponent(currency);
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
  return `${minor < 0 ? '-' : ''}${whole}${fraction}`;
}

/** 123456 USD -> "$1,234.56". Formats the exact decimal string, so no float rounding is involved. */
export function formatMoney(minor: number, currency: string): string {
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  return format.format(minorToDecimal(minor, currency) as `${number}`);
}

/**
 * "1,234.5" USD -> 123450. Returns null for anything that is not a plain non-negative amount with at most
 * the currency's minor digits: "12.345" USD is refused, never rounded.
 */
export function parseMoneyInput(text: string, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '');
  const pattern = exponent === 0 ? /^(\d{1,15})$/ : new RegExp(`^(\\d{1,15})(?:\\.(\\d{0,${exponent}}))?$`);
  const match = pattern.exec(cleaned);
  if (!match) return null;
  const minor = BigInt(`${match[1] ?? '0'}${(match[2] ?? '').padEnd(exponent, '0')}`);
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(minor);
}
