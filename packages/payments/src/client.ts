import { type Money, MoneySchema, addMoney } from '@mandate/shared';
import { z } from 'zod';
import { fromPaypalAmount, toPaypalAmount } from './amount.js';
import type { PaypalConfig } from './config.js';
import { PaymentError, codeForStatus } from './errors.js';
import { ErrorBodySchema, type OrderResponse, OrderResponseSchema, type OrderStatus, TokenResponseSchema } from './schemas.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PaypalClientOptions {
  config: PaypalConfig;
  fetch?: FetchLike;
  now?: () => number;
}

/** PayPal-Request-Id: the same key replays the first result instead of creating a second order or capture. */
const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,108}$/);
/** Stored as the order's custom_id, linking every PayPal order to the policy decision or approval that allowed it. */
const ReferenceSchema = z.string().regex(/^[A-Za-z0-9_:-]{1,127}$/);
const OrderIdSchema = z.string().regex(/^[A-Z0-9]{1,64}$/);

export type PaymentSource =
  /** The buyer approves on PayPal. saveForLater asks PayPal to vault the wallet on success. */
  | { kind: 'buyer-approval'; saveForLater?: boolean }
  /** Charges a previously vaulted wallet with no buyer present. VERIFY: the spike tests whether sandbox allows this. */
  | { kind: 'vaulted'; vaultId: string };

export interface CreateOrderInput {
  amount: Money;
  idempotencyKey: string;
  reference: string;
  description?: string;
  paymentSource?: PaymentSource;
}

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  /** Where the buyer approves the order, when PayPal needs them to. */
  approveUrl?: string;
  reference?: string;
  vault?: { id?: string; status: string; customerId?: string };
  captures: { id: string; status: string; amount: Money }[];
}

// Refresh the cached token this long before PayPal says it expires.
const TOKEN_SKEW_MS = 60_000;

interface SendOptions {
  body?: unknown;
  idempotencyKey?: string;
  /** A transport failure or 5xx here leaves the outcome unknown: the caller must reconcile, never blindly retry. */
  movesMoney: boolean;
}

/** Thin Orders v2 client. The only code in the repo that holds PayPal credentials. Sandbox only. */
export class PaypalClient {
  readonly #config: PaypalConfig;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(options: PaypalClientOptions) {
    this.#config = options.config;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
  }

  async createOrder(input: CreateOrderInput): Promise<OrderSummary> {
    const idempotencyKey = IdempotencyKeySchema.parse(input.idempotencyKey);
    const source = input.paymentSource ?? { kind: 'buyer-approval' };
    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: ReferenceSchema.parse(input.reference),
          amount: toPaypalAmount(input.amount),
          ...(input.description === undefined ? {} : { description: input.description.slice(0, 127) }),
        },
      ],
      payment_source: { paypal: this.#paypalSource(source) },
    };
    const raw = await this.#send('POST', '/v2/checkout/orders', { body, idempotencyKey, movesMoney: true });
    return summarize(parseOrder(raw));
  }

  /** Captures an approved order and checks PayPal captured exactly the amount we expected. */
  async captureOrder(orderId: string, idempotencyKey: string, expected: Money): Promise<OrderSummary> {
    const path = `/v2/checkout/orders/${OrderIdSchema.parse(orderId)}/capture`;
    const raw = await this.#send('POST', path, {
      body: {},
      idempotencyKey: IdempotencyKeySchema.parse(idempotencyKey),
      movesMoney: true,
    });
    const order = summarize(parseOrder(raw));
    assertCaptured(order, MoneySchema.parse(expected));
    return order;
  }

  async getOrder(orderId: string): Promise<OrderSummary> {
    const raw = await this.#send('GET', `/v2/checkout/orders/${OrderIdSchema.parse(orderId)}`, { movesMoney: false });
    return summarize(parseOrder(raw));
  }

  #paypalSource(source: PaymentSource): Record<string, unknown> {
    if (source.kind === 'vaulted') return { vault_id: z.string().min(1).max(64).parse(source.vaultId) };
    return {
      experience_context: {
        return_url: this.#config.returnUrl,
        cancel_url: this.#config.cancelUrl,
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
      ...(source.saveForLater ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT' } } } : {}),
    };
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt) return this.#token.value;

    const basic = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret.reveal()}`).toString('base64');
    const response = await this.#request(`${this.#config.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }, false);
    if (!response.ok) throw await toError(response);

    const parsed = TokenResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new PaymentError('PAYPAL_BAD_RESPONSE', { status: response.status });
    this.#token = {
      value: parsed.data.access_token,
      expiresAt: this.#now() + parsed.data.expires_in * 1000 - TOKEN_SKEW_MS,
    };
    return this.#token.value;
  }

  async #send(method: 'GET' | 'POST', path: string, options: SendOptions): Promise<unknown> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (options.idempotencyKey !== undefined) headers['PayPal-Request-Id'] = options.idempotencyKey;

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    const response = await this.#request(`${this.#config.baseUrl}${path}`, init, options.movesMoney);
    if (!response.ok) {
      if (response.status === 401) this.#token = undefined;
      const error = await toError(response);
      if (options.movesMoney && error.code === 'PAYPAL_UNAVAILABLE') {
        throw new PaymentError('UNKNOWN_OUTCOME', error.details);
      }
      throw error;
    }
    return readJson(response);
  }

  async #request(url: string, init: RequestInit, movesMoney: boolean): Promise<Response> {
    try {
      return await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#config.timeoutMs) });
    } catch {
      // Timeouts and network failures: the request may or may not have reached PayPal.
      throw new PaymentError(movesMoney ? 'UNKNOWN_OUTCOME' : 'PAYPAL_UNAVAILABLE');
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PaymentError('PAYPAL_BAD_RESPONSE', { status: response.status });
  }
}

async function toError(response: Response): Promise<PaymentError> {
  let body: z.infer<typeof ErrorBodySchema> = {};
  try {
    const parsed = ErrorBodySchema.safeParse(await response.json());
    if (parsed.success) body = parsed.data;
  } catch {
    // Error bodies are best-effort; the status code alone decides the error code.
  }
  return new PaymentError(codeForStatus(response.status), {
    status: response.status,
    ...(body.debug_id === undefined ? {} : { debugId: body.debug_id }),
    ...(body.details === undefined ? {} : { issues: body.details.map((detail) => detail.issue) }),
  });
}

function parseOrder(raw: unknown): OrderResponse {
  const parsed = OrderResponseSchema.safeParse(raw);
  if (!parsed.success) throw new PaymentError('PAYPAL_BAD_RESPONSE');
  return parsed.data;
}

function summarize(order: OrderResponse): OrderSummary {
  const unit = order.purchase_units[0];
  const approve = order.links.find((link) => link.rel === 'payer-action' || link.rel === 'approve');
  const vault = order.payment_source?.paypal?.attributes?.vault;
  let captures: OrderSummary['captures'];
  try {
    captures = (unit?.payments?.captures ?? []).map((capture) => ({
      id: capture.id,
      status: capture.status,
      amount: fromPaypalAmount(capture.amount),
    }));
  } catch {
    throw new PaymentError('PAYPAL_BAD_RESPONSE');
  }
  return {
    id: order.id,
    status: order.status,
    ...(approve === undefined ? {} : { approveUrl: approve.href }),
    ...(unit?.custom_id === undefined ? {} : { reference: unit.custom_id }),
    ...(vault === undefined
      ? {}
      : {
          vault: {
            status: vault.status,
            ...(vault.id === undefined ? {} : { id: vault.id }),
            ...(vault.customer === undefined ? {} : { customerId: vault.customer.id }),
          },
        }),
    captures,
  };
}

function assertCaptured(order: OrderSummary, expected: Money): void {
  const completed = order.captures.filter((capture) => capture.status === 'COMPLETED');
  if (order.status !== 'COMPLETED' || completed.length === 0) return;
  try {
    const total = completed.map((capture) => capture.amount).reduce((sum, amount) => addMoney(sum, amount));
    if (total.amountMinor === expected.amountMinor && total.currency === expected.currency) return;
  } catch {
    // Mixed currencies fall through to the mismatch below.
  }
  throw new PaymentError('AMOUNT_MISMATCH');
}
