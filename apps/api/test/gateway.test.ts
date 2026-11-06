import { PaymentError, type OrderSummary, type PaypalClient } from '@mandate/payments';
import { describe, expect, it } from 'vitest';
import { PaypalGateway } from '../src/modules/payments/gateway.js';
import { GatewayError } from '../src/modules/purchases/ports.js';

const amount = { amountMinor: 1000, currency: 'USD' };

function gateway(result: OrderSummary | Error) {
  const calls: unknown[] = [];
  const respond = () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
  const client: Pick<PaypalClient, 'createOrder' | 'captureOrder' | 'getOrder' | 'verifyWebhookSignature'> = {
    createOrder: (input: unknown) => {
      calls.push(input);
      return respond();
    },
    captureOrder: (...args: unknown[]) => {
      calls.push(args);
      return respond();
    },
    getOrder: (id: string) => {
      calls.push(id);
      return respond();
    },
    verifyWebhookSignature: (headers: unknown, event: unknown) => {
      calls.push([headers, event]);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(true);
    },
  };
  return { gw: new PaypalGateway(client), calls };
}

describe('PaypalGateway', () => {
  it('reads an order and sums only COMPLETED captures', async () => {
    const { gw, calls } = gateway({
      id: 'PP1',
      status: 'COMPLETED',
      captures: [
        { id: 'C1', status: 'COMPLETED', amount: { amountMinor: 600, currency: 'USD' } },
        { id: 'C2', status: 'COMPLETED', amount: { amountMinor: 400, currency: 'USD' } },
        { id: 'C3', status: 'DECLINED', amount: { amountMinor: 999, currency: 'USD' } },
      ],
    });
    expect(await gw.getOrder('PP1')).toEqual({ providerOrderId: 'PP1', status: 'COMPLETED', capturedAmount: amount });
    expect(calls[0]).toBe('PP1');
  });

  it('leaves capturedAmount unset when captures are in mixed currencies', async () => {
    const { gw } = gateway({
      id: 'PP1',
      status: 'COMPLETED',
      captures: [
        { id: 'C1', status: 'COMPLETED', amount: { amountMinor: 600, currency: 'USD' } },
        { id: 'C2', status: 'COMPLETED', amount: { amountMinor: 400, currency: 'EUR' } },
      ],
    });
    expect((await gw.getOrder('PP1')).capturedAmount).toBeUndefined();
  });

  it('delegates webhook verification to the client', async () => {
    const { gw, calls } = gateway({ id: 'PP1', status: 'COMPLETED', captures: [] });
    expect(await gw.verifyWebhook({ a: 'b' }, { id: 'WH-1' })).toBe(true);
    expect(calls[0]).toEqual([{ a: 'b' }, { id: 'WH-1' }]);
  });


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

  it('flags a PENDING capture: PayPal holds the money but has not settled it', async () => {
    const { gw } = gateway({
      id: 'PP1',
      status: 'COMPLETED',
      captures: [{ id: 'C1', status: 'PENDING', amount }],
    });
    expect(await gw.captureOrder('PP1', 'cap-123456789', amount)).toEqual({ providerOrderId: 'PP1', status: 'COMPLETED', capturePending: true });
  });

  it.each([
    [new PaymentError('UNKNOWN_OUTCOME'), 'UNKNOWN_OUTCOME', 'UNKNOWN_OUTCOME'],
    [new PaymentError('PAYPAL_UNPROCESSABLE', { status: 422 }), 'REJECTED', 'PAYPAL_UNPROCESSABLE'],
    // Money moved, but not the amount we approved: a human must reconcile it, never treat it as "not captured".
    [new PaymentError('AMOUNT_MISMATCH'), 'UNKNOWN_OUTCOME', 'AMOUNT_MISMATCH'],
    [new Error('socket hang up'), 'UNKNOWN_OUTCOME', 'UNCLASSIFIED'],
  ])('classifies %s', async (error, kind, code) => {
    const { gw } = gateway(error);
    const failure = await gw.captureOrder('PP1', 'cap-123456789', amount).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure).toMatchObject({ kind, code });
  });
});
