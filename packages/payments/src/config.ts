import { inspect } from 'node:util';
import { z } from 'zod';

const REDACTED = '[REDACTED]';

/** Holds a credential. Every serialization path prints [REDACTED]; only reveal() returns the value. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Sandbox only (hard rule 6). There is deliberately no setting that selects the live API. */
export const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

export interface PaypalConfig {
  baseUrl: typeof PAYPAL_SANDBOX_BASE_URL;
  clientId: string;
  clientSecret: Secret;
  timeoutMs: number;
  returnUrl: string;
  cancelUrl: string;
}

/** Names only, never values: a value could be the secret itself. */
export class PaypalConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid PayPal configuration: ${variables.join(', ')}`);
    this.name = 'PaypalConfigError';
    this.variables = variables;
  }
}

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

const EnvSchema = z.object({
  PAYPAL_CLIENT_ID: z.preprocess(emptyAsUnset, z.string().min(1)),
  PAYPAL_CLIENT_SECRET: z.preprocess(emptyAsUnset, z.string().min(1)),
  PAYPAL_TIMEOUT_MS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1_000).max(60_000).default(20_000)),
  PAYPAL_RETURN_URL: z.preprocess(emptyAsUnset, z.url({ protocol: /^https?$/ }).default('https://example.com/paypal/return')),
  PAYPAL_CANCEL_URL: z.preprocess(emptyAsUnset, z.url({ protocol: /^https?$/ }).default('https://example.com/paypal/cancel')),
});

/**
 * The only place the payments module reads configuration or credentials. Reads the given env
 * object only, so callers and tests control exactly what is visible.
 */
export function loadPaypalConfig(env: Readonly<Record<string, string | undefined>> = process.env): PaypalConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const variables = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'env')))].sort();
    throw new PaypalConfigError(variables);
  }
  return {
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    clientId: parsed.data.PAYPAL_CLIENT_ID,
    clientSecret: new Secret(parsed.data.PAYPAL_CLIENT_SECRET),
    timeoutMs: parsed.data.PAYPAL_TIMEOUT_MS,
    returnUrl: parsed.data.PAYPAL_RETURN_URL,
    cancelUrl: parsed.data.PAYPAL_CANCEL_URL,
  };
}
