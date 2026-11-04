import { addMoney, type Money } from '@mandate/shared';
import {
  type FetchLike,
  loadPaypalConfig,
  PaymentError,
  PaypalClient,
  PaypalConfigError,
  type OrderSummary,
} from '@mandate/payments';
import { GatewayError, type GatewayOrder, type PaymentGateway } from '../purchases/ports.js';

type ClientSurface = Pick<PaypalClient, 'createOrder' | 'captureOrder' | 'getOrder' | 'verifyWebhookSignature'>;

/**
 * The purchase flow's view of PayPal. The only file in the API that imports @mandate/payments
 * (hard rule 1, enforced by test/boundary.test.ts). Buyer-approval orders only until the spike (#9)
 * shows whether sandbox allows charging a vaulted wallet with no buyer present.
 */
export class PaypalGateway implements PaymentGateway {
  readonly #client: ClientSurface;

  constructor(client: ClientSurface) {
    this.#client = client;
  }

  async createOrder(input: { amount: Money; idempotencyKey: string; reference: string; description: string }): Promise<GatewayOrder> {
    return mapErrors(async () => {
      const order = await this.#client.createOrder({ ...input, paymentSource: { kind: 'buyer-approval' } });
      return toGatewayOrder(order);
    });
  }

  async captureOrder(providerOrderId: string, idempotencyKey: string, expected: Money): Promise<GatewayOrder> {
    return mapErrors(async () => toGatewayOrder(await this.#client.captureOrder(providerOrderId, idempotencyKey, expected)));
  }

  async getOrder(providerOrderId: string): Promise<GatewayOrder> {
    return mapErrors(async () => toGatewayOrder(await this.#client.getOrder(providerOrderId)));
  }

  async verifyWebhook(headers: Readonly<Record<string, string | string[] | undefined>>, event: unknown): Promise<boolean> {
    return this.#client.verifyWebhookSignature(headers, event);
  }
}

function toGatewayOrder(order: OrderSummary): GatewayOrder {
  const completed = order.captures.filter((c) => c.status === 'COMPLETED');
  let captured: Money | undefined;
  try {
    captured = completed.reduce<Money | undefined>((sum, c) => (sum ? addMoney(sum, c.amount) : c.amount), undefined);
  } catch {
    // Captures in different currencies cannot be summed; leave it unset so reconciliation does not mark CAPTURED.
    captured = undefined;
  }
  return {
    providerOrderId: order.id,
    status: order.status,
    ...(order.approveUrl === undefined ? {} : { approveUrl: order.approveUrl }),
    ...(captured === undefined ? {} : { capturedAmount: captured }),
  };
}

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PaymentError) {
      throw new GatewayError(error.code === 'UNKNOWN_OUTCOME' ? 'UNKNOWN_OUTCOME' : 'REJECTED', error.code);
    }
    // Anything unclassified after a money-moving call could have reached PayPal: treat it as unknown.
    throw new GatewayError('UNKNOWN_OUTCOME', 'UNCLASSIFIED');
  }
}

export type PaypalGatewayFromEnv =
  | { ok: true; gateway: PaypalGateway; webhooksEnabled: boolean }
  | { ok: false; variables: readonly string[] };

/**
 * Builds the gateway from the environment. Lives here because only this module may import @mandate/payments.
 * Invalid or missing configuration returns the variable names only, never their values.
 */
export function paypalGatewayFromEnv(env: Readonly<Record<string, string | undefined>>, fetchImpl?: FetchLike): PaypalGatewayFromEnv {
  let config;
  try {
    config = loadPaypalConfig(env);
  } catch (error) {
    if (error instanceof PaypalConfigError) return { ok: false, variables: error.variables };
    throw error;
  }
  const client = new PaypalClient({ config, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { ok: true, gateway: new PaypalGateway(client), webhooksEnabled: config.webhookId !== undefined };
}
