import { describe, expect, it, vi } from 'vitest';
import { approvalPayload, loadZapierConfig, ZapierApprovalNotifier, ZapierConfigError } from '../src/modules/approvals/zapier.js';
import type { ApprovalRequest } from '../src/modules/purchases/ports.js';

const REQUEST: ApprovalRequest = {
  approvalId: '00000000-0000-4000-8000-0000000000b1',
  purchaseId: '00000000-0000-4000-8000-0000000000a1',
  token: 'T'.repeat(43),
  expiresAt: new Date('2026-11-06T10:00:00Z'),
  amount: { amountMinor: 32_399, currency: 'USD' },
  reasons: [{ code: 'THRESHOLD_EXCEEDED', message: 'The cart total is at or above the approval threshold.', ruleId: 'mandate.approval_threshold', severity: 'REVIEW' }],
};
const CONFIG = { webhookUrl: 'https://hooks.zapier.com/hooks/catch/1/abc/', webAppUrl: 'https://web.example/' };

describe('loadZapierConfig', () => {
  it('is off when nothing is set, and reads both values when both are set', () => {
    expect(loadZapierConfig({})).toBeUndefined();
    expect(loadZapierConfig({ ZAPIER_APPROVAL_WEBHOOK_URL: '', WEB_APP_URL: '' })).toBeUndefined();
    expect(loadZapierConfig({ ZAPIER_APPROVAL_WEBHOOK_URL: CONFIG.webhookUrl, WEB_APP_URL: 'http://localhost:5173' })).toEqual({
      webhookUrl: CONFIG.webhookUrl,
      webAppUrl: 'http://localhost:5173',
    });
  });

  it.each([
    ['a non-Zapier host', { ZAPIER_APPROVAL_WEBHOOK_URL: 'https://example.com/hook', WEB_APP_URL: 'https://web.example' }, ['ZAPIER_APPROVAL_WEBHOOK_URL']],
    ['http for the hook', { ZAPIER_APPROVAL_WEBHOOK_URL: 'http://hooks.zapier.com/x', WEB_APP_URL: 'https://web.example' }, ['ZAPIER_APPROVAL_WEBHOOK_URL']],
    ['http for a public web app', { ZAPIER_APPROVAL_WEBHOOK_URL: CONFIG.webhookUrl, WEB_APP_URL: 'http://web.example' }, ['WEB_APP_URL']],
    ['only the hook', { ZAPIER_APPROVAL_WEBHOOK_URL: CONFIG.webhookUrl }, ['WEB_APP_URL']],
    ['only the web app', { WEB_APP_URL: 'https://web.example' }, ['ZAPIER_APPROVAL_WEBHOOK_URL']],
  ])('rejects %s, naming the variable only', (_label, env, variables) => {
    try {
      loadZapierConfig(env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ZapierConfigError);
      expect((error as ZapierConfigError).variables).toEqual(variables);
      expect((error as Error).message).not.toContain('example');
    }
  });
});

describe('approvalPayload', () => {
  it('carries the summary and a review link with the token in the fragment', () => {
    expect(approvalPayload(REQUEST, CONFIG.webAppUrl)).toEqual({
      event: 'approval.requested',
      approvalId: REQUEST.approvalId,
      purchaseId: REQUEST.purchaseId,
      amountMinor: 32_399,
      currency: 'USD',
      amountDisplay: '$323.99',
      expiresAt: '2026-11-06T10:00:00.000Z',
      reasons: [{ code: 'THRESHOLD_EXCEEDED', message: 'The cart total is at or above the approval threshold.' }],
      reviewUrl: `https://web.example/#/approve/${'T'.repeat(43)}`,
    });
  });

  it('formats zero- and three-decimal currencies exactly', () => {
    expect(approvalPayload({ ...REQUEST, amount: { amountMinor: 1500, currency: 'JPY' } }, CONFIG.webAppUrl).amountDisplay).toMatch(/1,500$/);
    expect(approvalPayload({ ...REQUEST, amount: { amountMinor: 1234, currency: 'KWD' } }, CONFIG.webAppUrl).amountDisplay).toMatch(/1\.234$/);
  });
});

describe('ZapierApprovalNotifier', () => {
  it('posts JSON to the hook, refusing redirects and bounding the wait', async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response('{}', { status: 200 })));
    await new ZapierApprovalNotifier(CONFIG, fetch).notify(REQUEST);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(CONFIG.webhookUrl);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-2xx answer so the flow records notify_failed', async () => {
    const fetch = () => Promise.resolve(new Response('nope', { status: 410 }));
    await expect(new ZapierApprovalNotifier(CONFIG, fetch).notify(REQUEST)).rejects.toThrow('410');
  });

  it('uses the platform fetch by default', () => {
    expect(new ZapierApprovalNotifier(CONFIG)).toBeInstanceOf(ZapierApprovalNotifier);
  });
});
