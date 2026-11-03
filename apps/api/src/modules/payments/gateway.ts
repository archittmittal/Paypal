import { PaymentError, type PaypalClient } from '@mandate/payments';
import type { Money } from '@mandate/shared';
import { GatewayError, type GatewayOrder, type PaymentGateway } from '../purchases/ports.js';

/**
 * The purchase flow's view of PayPal. The only file in the API that imports @mandate/payments
 * (hard rule 1, enforced by test/boundary.test.ts). Buyer-approval orders only until the spike (#9)
 * shows whether sandbox allows charging a vaulted wallet with no buyer present.
 */
export class PaypalGateway implements PaymentGateway {
  readonly #client: Pick<PaypalClient, 'createOrder' | 'captureOrder'>;

  constructor(client: Pick<PaypalClient, 'createOrder' | 'captureOrder'>) {
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
}

function toGatewayOrder(order: { id: string; status: string; approveUrl?: string }): GatewayOrder {
  return { providerOrderId: order.id, status: order.status, ...(order.approveUrl === undefined ? {} : { approveUrl: order.approveUrl }) };
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
