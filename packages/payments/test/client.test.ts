import { describe, expect, it } from 'vitest';
import { type FetchLike, PaypalClient } from '../src/client.js';
import { loadPaypalConfig } from '../src/config.js';
import { PaymentError, type PaymentErrorCode } from '../src/errors.js';

const config = loadPaypalConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' });
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });
const KEY = 'decision-0001-create';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | Error;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const token = (expiresIn = 3600) => json(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: expiresIn });

const created = {
  id: 'ORDER1',
  status: 'PAYER_ACTION_REQUIRED',
  links: [
    { href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1', rel: 'self' },
    { href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1', rel: 'payer-action' },
  ],
  purchase_units: [{ custom_id: 'decision-1' }],
};

const captured = (value = '19.99') => ({
  id: 'ORDER1',
  status: 'COMPLETED',
  payment_source: { paypal: { attributes: { vault: { id: 'vault-9', status: 'VAULTED', customer: { id: 'cust-3' } } } } },
  purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value } }] } }],
});

function harness(replies: Reply[], now: () => number = () => 0) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unexpected call');
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { calls, client: new PaypalClient({ config, fetch, now }) };
}

async function expectCode(promise: Promise<unknown>, code: PaymentErrorCode): Promise<PaymentError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PaymentError);
  expect((error as PaymentError).code).toBe(code);
  return error as PaymentError;
}

describe('createOrder', () => {
  it('sends a sandbox CAPTURE order with the idempotency key and returns the approval link', async () => {
    const { calls, client } = harness([token(), json(201, created)]);
    const order = await client.createOrder({ amount: usd(1999), idempotencyKey: KEY, reference: 'decision-1' });

    expect(order).toEqual({
      id: 'ORDER1',
      status: 'PAYER_ACTION_REQUIRED',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
      reference: 'decision-1',
      captures: [],
    });
    expect(calls[0]?.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(calls[0]?.headers['Authorization']).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(calls[1]).toMatchObject({
      url: 'https://api-m.sandbox.paypal.com/v2/checkout/orders',
      method: 'POST',
      headers: { Authorization: 'Bearer tok-1', 'PayPal-Request-Id': KEY },
      body: {
        intent: 'CAPTURE',
        purchase_units: [{ custom_id: 'decision-1', amount: { currency_code: 'USD', value: '19.99' } }],
      },
    });
    expect(calls[1]?.body).not.toHaveProperty(['payment_source', 'paypal', 'attributes']);
  });

  it('asks PayPal to vault the wallet when saveForLater is set', async () => {
    const { calls, client } = harness([token(), json(201, created)]);
    await client.createOrder({
      amount: usd(500),
      idempotencyKey: KEY,
      reference: 'decision-1',
      paymentSource: { kind: 'buyer-approval', saveForLater: true },
    });
    expect(calls[1]?.body).toMatchObject({
      payment_source: { paypal: { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT' } } } },
    });
  });

  it('charges a vaulted wallet with vault_id and no buyer redirect', async () => {
    const { calls, client } = harness([token(), json(201, captured('5.00'))]);
    const order = await client.createOrder({
      amount: usd(500),
      idempotencyKey: KEY,
      reference: 'decision-2',
      paymentSource: { kind: 'vaulted', vaultId: 'vault-9' },
    });
    expect(calls[1]?.body).toMatchObject({ payment_source: { paypal: { vault_id: 'vault-9' } } });
    expect(order.status).toBe('COMPLETED');
    expect(order.captures).toEqual([{ id: 'CAP1', status: 'COMPLETED', amount: usd(500) }]);
  });

  it.each([
    ['a short idempotency key', { idempotencyKey: 'short' }],
    ['an idempotency key with spaces', { idempotencyKey: 'has spaces in it' }],
    ['a reference with a slash', { reference: 'a/b' }],
    ['a float amount', { amount: usd(1.5) }],
  ])('validates input before any network call: %s', async (_label, override) => {
    const { calls, client } = harness([]);
    await expect(
      client.createOrder({ amount: usd(100), idempotencyKey: KEY, reference: 'decision-1', ...override }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('treats a network failure on create as an unknown outcome', async () => {
    const { client } = harness([token(), new TypeError('socket hang up')]);
    await expectCode(client.createOrder({ amount: usd(100), idempotencyKey: KEY, reference: 'd' }), 'UNKNOWN_OUTCOME');
  });

  it('treats a 5xx on create as an unknown outcome and keeps the debug id', async () => {
    const { client } = harness([token(), json(503, { debug_id: 'dbg-1' })]);
    const error = await expectCode(
      client.createOrder({ amount: usd(100), idempotencyKey: KEY, reference: 'd' }),
      'UNKNOWN_OUTCOME',
    );
    expect(error.details).toEqual({ status: 503, debugId: 'dbg-1' });
  });

  it('maps a 422 to UNPROCESSABLE with issue codes only', async () => {
    const { client } = harness([
      token(),
      json(422, { debug_id: 'dbg-2', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'card text' }] }),
    ]);
    const error = await expectCode(
      client.createOrder({ amount: usd(100), idempotencyKey: KEY, reference: 'd' }),
      'PAYPAL_UNPROCESSABLE',
    );
    expect(error.details).toEqual({ status: 422, debugId: 'dbg-2', issues: ['INSTRUMENT_DECLINED'] });
    expect(error.message).not.toContain('card text');
  });

  it('rejects an order response that fails the schema', async () => {
    const { client } = harness([token(), json(201, { id: 'order with spaces', status: 'CREATED' })]);
    await expectCode(client.createOrder({ amount: usd(100), idempotencyKey: KEY, reference: 'd' }), 'PAYPAL_BAD_RESPONSE');
  });

  it('rejects a capture amount PayPal formatted with too many decimals', async () => {
    const { client } = harness([token(), json(201, captured('5.001'))]);
    await expectCode(client.createOrder({ amount: usd(100), idempotencyKey: KEY, reference: 'd' }), 'PAYPAL_BAD_RESPONSE');
  });
});

describe('captureOrder', () => {
  it('captures with its own idempotency key and reports the vault result', async () => {
    const { calls, client } = harness([token(), json(201, captured())]);
    const order = await client.captureOrder('ORDER1', 'decision-0001-capture', usd(1999));

    expect(calls[1]).toMatchObject({
      url: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1/capture',
      method: 'POST',
      headers: { 'PayPal-Request-Id': 'decision-0001-capture' },
    });
    expect(order.vault).toEqual({ id: 'vault-9', status: 'VAULTED', customerId: 'cust-3' });
  });

  it('raises AMOUNT_MISMATCH when PayPal captured a different amount', async () => {
    const { client } = harness([token(), json(201, captured('20.00'))]);
    await expectCode(client.captureOrder('ORDER1', 'decision-0001-capture', usd(1999)), 'AMOUNT_MISMATCH');
  });

  it('raises AMOUNT_MISMATCH on a currency mismatch', async () => {
    const { client } = harness([token(), json(201, captured())]);
    await expectCode(
      client.captureOrder('ORDER1', 'decision-0001-capture', { amountMinor: 1999, currency: 'EUR' }),
      'AMOUNT_MISMATCH',
    );
  });

  it('refuses an order id that could change the request path', async () => {
    const { calls, client } = harness([]);
    await expect(client.captureOrder('../ORDER1', 'decision-0001-capture', usd(1))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('treats a timeout on capture as an unknown outcome, never a failure', async () => {
    const { client } = harness([token(), new DOMException('timed out', 'TimeoutError')]);
    await expectCode(client.captureOrder('ORDER1', 'decision-0001-capture', usd(1999)), 'UNKNOWN_OUTCOME');
  });
});

describe('getOrder and tokens', () => {
  it('reuses the cached token until shortly before it expires', async () => {
    let clock = 0;
    const { calls, client } = harness(
      [token(3600), json(200, created), json(200, created), token(3600), json(200, created)],
      () => clock,
    );
    await client.getOrder('ORDER1');
    clock = 3_000_000;
    await client.getOrder('ORDER1');
    clock = 3_550_000;
    await client.getOrder('ORDER1');
    expect(calls.map((call) => call.url.endsWith('/v1/oauth2/token'))).toEqual([true, false, false, true, false]);
  });

  it('drops the cached token after a 401 so the next call re-authenticates', async () => {
    const { calls, client } = harness([token(), json(401, {}), token(), json(200, created)]);
    await expectCode(client.getOrder('ORDER1'), 'PAYPAL_AUTH');
    await client.getOrder('ORDER1');
    expect(calls.filter((call) => call.url.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });

  it.each([
    [400, 'PAYPAL_BAD_REQUEST'],
    [403, 'PAYPAL_AUTH'],
    [404, 'PAYPAL_NOT_FOUND'],
    [429, 'PAYPAL_RATE_LIMITED'],
    [500, 'PAYPAL_UNAVAILABLE'],
  ] as const)('maps HTTP %i on a read to %s', async (status, code) => {
    const { client } = harness([token(), new Response('not json', { status })]);
    await expectCode(client.getOrder('ORDER1'), code);
  });

  it('maps a network failure on a read to UNAVAILABLE, not UNKNOWN_OUTCOME', async () => {
    const { client } = harness([token(), new TypeError('fetch failed')]);
    await expectCode(client.getOrder('ORDER1'), 'PAYPAL_UNAVAILABLE');
  });

  it('rejects rejected credentials and malformed token responses', async () => {
    await expectCode(harness([json(401, { error: 'invalid_client' })]).client.getOrder('ORDER1'), 'PAYPAL_AUTH');
    await expectCode(harness([json(200, { access_token: '' })]).client.getOrder('ORDER1'), 'PAYPAL_BAD_RESPONSE');
    await expectCode(harness([new Response('<html>', { status: 200 })]).client.getOrder('ORDER1'), 'PAYPAL_BAD_RESPONSE');
  });
});
