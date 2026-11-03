import { type Money, MoneySchema } from '@mandate/shared';

/** PayPal's wire format for money: a decimal string, never a float. */
export interface PaypalAmount {
  currency_code: string;
  value: string;
}

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

// PayPal rejects decimals for these currencies. VERIFY against PayPal's currency-codes page
// before supporting anything beyond USD in the demo.
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

function exponentOf(currency: string): number {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

/** Formats integer minor units as PayPal's decimal string using string math only. */
export function toPaypalAmount(money: Money): PaypalAmount {
  const { amountMinor, currency } = MoneySchema.parse(money);
  const exponent = exponentOf(currency);
  if (exponent === 0) return { currency_code: currency, value: String(amountMinor) };

  const digits = String(amountMinor).padStart(exponent + 1, '0');
  return {
    currency_code: currency,
    value: `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`,
  };
}

/** Parses a PayPal amount back to minor units. Rejects anything that is not an exact decimal. */
export function fromPaypalAmount(amount: PaypalAmount): Money {
  const exponent = exponentOf(amount.currency_code);
  const pattern = exponent === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${exponent}}))?$`);
  const match = pattern.exec(amount.value);
  if (!match) throw new AmountError(`Not a valid ${amount.currency_code} amount`);

  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(exponent, '0');
  const parsed = MoneySchema.safeParse({
    amountMinor: Number(BigInt(`${whole}${fraction}`)),
    currency: amount.currency_code,
  });
  if (!parsed.success) throw new AmountError(`Amount out of range for ${amount.currency_code}`);
  return parsed.data;
}
