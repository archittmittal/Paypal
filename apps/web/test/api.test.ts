import { describe, expect, it, vi } from 'vitest';
import { ApiError, MandateApi, newRequestKey } from '../src/api';
import { errorText, failureText } from '../src/copy';

const MANDATE = '00000000-0000-4000-8000-000000000021';
const PURCHASE = {
  id: '00000000-0000-4000-8000-0000000000a1',
  mandateId: MANDATE,
  status: 'DENIED',
  cart: { currency: 'USD', totalMinor: 10_000, items: [{ title: 'Gift card', category: 'gift-cards', quantity: 1, unitPriceMinor: 10_000, lineTotalMinor: 10_000 }] },
  decision: {
    outcome: 'DENY',
    reasons: [{ code: 'CATEGORY_NOT_ALLOWED', message: 'Category "gift-cards" is not allowed by the mandate.', ruleId: 'category.allowed', severity: 'BLOCK' }],
    policyVersion: '0.1.0',
    evaluatedTotal: { amountMinor: 10_000, currency: 'USD' },
  },
};

function respond(status: number, body: unknown) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
}

describe('MandateApi', () => {
  it('posts a purchase as JSON and validates the response', async () => {
    const fetch = respond(201, PURCHASE);
    const api = new MandateApi('http://api.example/', fetch);
    const view = await api.submitPurchase(MANDATE, { requesterUserId: MANDATE, text: 'gift card', requestKey: 'web-00000001' });
    expect(view.decision?.outcome).toBe('DENY');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`http://api.example/mandates/${MANDATE}/purchases`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({ requesterUserId: MANDATE, text: 'gift card', requestKey: 'web-00000001' });
  });

  it('turns API errors into ApiError with the code, never the body text', async () => {
    const api = new MandateApi('http://api.example', respond(403, { error: 'REQUESTER_NOT_ALLOWED', message: 'Request rejected' }));
    await expect(api.getPurchase(PURCHASE.id)).rejects.toEqual(new ApiError(403, 'REQUESTER_NOT_ALLOWED'));
    const plain = new MandateApi('http://api.example', () => Promise.resolve(new Response('gateway page', { status: 502 })));
    await expect(plain.getPurchase(PURCHASE.id)).rejects.toEqual(new ApiError(502, 'HTTP_ERROR'));
  });

  it('refuses a response that does not match the schema, such as a float amount', async () => {
    const api = new MandateApi('http://api.example', respond(200, { ...PURCHASE, cart: { ...PURCHASE.cart, totalMinor: 99.5 } }));
    await expect(api.getPurchase(PURCHASE.id)).rejects.toEqual(new ApiError(200, 'UNEXPECTED_RESPONSE'));
  });

  it('reports an unreachable API as NETWORK', async () => {
    const api = new MandateApi('http://api.example', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(api.getSummary(MANDATE)).rejects.toEqual(new ApiError(0, 'NETWORK'));
  });

  it('builds list queries and unwraps items', async () => {
    const fetch = respond(200, { items: [] });
    const api = new MandateApi('http://api.example', fetch);
    await api.listPurchases(MANDATE, { status: 'DENIED', limit: 5 });
    await api.listPurchases(MANDATE);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      `http://api.example/mandates/${MANDATE}/purchases?status=DENIED&limit=5`,
      `http://api.example/mandates/${MANDATE}/purchases`,
    ]);
  });

  it('captures and patches with the right method and body', async () => {
    const fetch = respond(200, PURCHASE);
    const api = new MandateApi('http://api.example', fetch);
    await api.capture(PURCHASE.id);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
    const mandateFetch = respond(404, { error: 'MANDATE_NOT_FOUND' });
    await expect(new MandateApi('http://api.example', mandateFetch).updateMandate(MANDATE, MANDATE, { budgetMinor: 1 })).rejects.toMatchObject({ status: 404 });
    expect(JSON.parse(mandateFetch.mock.calls[0]?.[1]?.body as string)).toEqual({ actorUserId: MANDATE, budgetMinor: 1 });
    expect(mandateFetch.mock.calls[0]?.[1]?.method).toBe('PATCH');
  });

  it('previews and decides approvals with the token in the body, never the URL', async () => {
    const preview = respond(200, { purchase: PURCHASE, approval: { status: 'PENDING', expiresAt: '2026-11-06T10:00:00.000Z' } });
    const token = 'T'.repeat(43);
    await expect(new MandateApi('http://api.example', preview).previewApproval(token)).resolves.toMatchObject({ approval: { status: 'PENDING' } });
    const decide = respond(200, PURCHASE);
    await new MandateApi('http://api.example', decide).decideApproval(token, 'REJECT');
    for (const [url, init] of [...preview.mock.calls, ...decide.mock.calls]) {
      expect(url).not.toContain(token);
      expect(init?.method).toBe('POST');
    }
    expect(JSON.parse(decide.mock.calls[0]?.[1]?.body as string)).toEqual({ token, decision: 'REJECT', channel: 'zapier' });
  });

  it('makes request keys the API accepts', () => {
    expect(newRequestKey()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(newRequestKey()).not.toBe(newRequestKey());
  });
});

describe('copy', () => {
  it('explains failures in plain words, with a fallback for unknown codes', () => {
    expect(failureText('UNKNOWN_CANDIDATE')).toContain('not in the search results');
    expect(failureText('SOMETHING_NEW')).toBe('Stopped: SOMETHING_NEW.');
    expect(failureText(undefined)).toBe('Stopped before anything was paid.');
  });

  it('maps errors to something a person can act on', () => {
    expect(errorText(new ApiError(0, 'NETWORK'))).toContain('not reachable');
    expect(errorText(new ApiError(400, 'VALIDATION_FAILED'))).toContain('refused the input');
    expect(errorText(new ApiError(403, 'X'))).toContain('not allowed');
    expect(errorText(new ApiError(404, 'X'))).toContain('Not found');
    expect(errorText(new ApiError(200, 'UNEXPECTED_RESPONSE'))).toContain('unexpected format');
    expect(errorText(new ApiError(500, 'X'))).toBe('The API returned an error (500).');
    expect(errorText(new Error('x'))).toBe('Something went wrong. Try again.');
  });
});
