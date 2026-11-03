import { PaymentError, type OrderSummary, type PaypalClient } from '@mandate/payments';
import { describe, expect, it } from 'vitest';
import { PaypalGateway } from '../src/modules/payments/gateway.js';
import { GatewayError } from '../src/modules/purchases/ports.js';

const amount = { amountMinor: 1000, currency: 'USD' };

function gateway(result: OrderSummary | Error) {
  const calls: unknown[] = [];
  const respond = () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
  const client: Pick<PaypalClient, 'createOrder' | 'captureOrder'> = {
    createOrder: (input: unknown) => {
      calls.push(input);
      return respond();
    },
    captureOrder: (...args: unknown[]) => {
      calls.push(args);
      return respond();
    },
  };
  return { gw: new PaypalGateway(client), calls };
}

describe('PaypalGateway', () => {
  it('creates buyer-approval orders and maps the summary', async () => {
    const { gw, calls } = gateway({ id: 'PP1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://paypal.example/a', captures: [] });
    const result = await gw.createOrder({ amount, idempotencyKey: 'pay-123456789', reference: 'ref', description: 'd' });
    expect(result).toEqual({ providerOrderId: 'PP1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://paypal.example/a' });
    expect(calls[0]).toMatchObject({ paymentSource: { kind: 'buyer-approval' } });
  });

  it('captures and omits a missing approve link', async () => {
    const { gw, calls } = gateway({ id: 'PP1', status: 'COMPLETED', captures: [] });
    expect(await gw.captureOrder('PP1', 'cap-123456789', amount)).toEqual({ providerOrderId: 'PP1', status: 'COMPLETED' });
    expect(calls[0]).toEqual(['PP1', 'cap-123456789', amount]);
  });

  it.each([
    [new PaymentError('UNKNOWN_OUTCOME'), 'UNKNOWN_OUTCOME', 'UNKNOWN_OUTCOME'],
    [new PaymentError('PAYPAL_UNPROCESSABLE', { status: 422 }), 'REJECTED', 'PAYPAL_UNPROCESSABLE'],
    [new PaymentError('AMOUNT_MISMATCH'), 'REJECTED', 'AMOUNT_MISMATCH'],
    [new Error('socket hang up'), 'UNKNOWN_OUTCOME', 'UNCLASSIFIED'],
  ])('classifies %s', async (error, kind, code) => {
    const { gw } = gateway(error);
    const failure = await gw.captureOrder('PP1', 'cap-123456789', amount).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure).toMatchObject({ kind, code });
  });
});
