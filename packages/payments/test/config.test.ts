import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PAYPAL_SANDBOX_BASE_URL, PaypalConfigError, loadPaypalConfig } from '../src/config.js';

const valid = { PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: 'super-secret-value' };

describe('loadPaypalConfig', () => {
  it('loads credentials with sandbox-only defaults', () => {
    const config = loadPaypalConfig(valid);
    expect(config).toMatchObject({ baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId: 'client-id', timeoutMs: 20_000 });
    expect(config.clientSecret.reveal()).toBe('super-secret-value');
  });

  it('never prints the secret through any serialization path', () => {
    const { clientSecret } = loadPaypalConfig(valid);
    for (const text of [String(clientSecret), JSON.stringify({ clientSecret }), inspect(clientSecret)]) {
      expect(text).not.toContain('super-secret-value');
    }
  });

  it('ignores any attempt to point at the live API', () => {
    expect(loadPaypalConfig({ ...valid, PAYPAL_BASE_URL: 'https://api-m.paypal.com' }).baseUrl).toBe(PAYPAL_SANDBOX_BASE_URL);
  });

  it('names missing or empty variables without echoing values', () => {
    try {
      loadPaypalConfig({ PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: undefined, PAYPAL_TIMEOUT_MS: '5' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PaypalConfigError);
      expect((error as PaypalConfigError).variables).toEqual(['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_TIMEOUT_MS']);
    }
  });

  it('rejects a non-http return url', () => {
    expect(() => loadPaypalConfig({ ...valid, PAYPAL_RETURN_URL: 'javascript:alert(1)' })).toThrow(PaypalConfigError);
  });
});

describe('PAYPAL_WEBHOOK_ID', () => {
  const base = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' };
  it('is optional and read when set', () => {
    expect(loadPaypalConfig(base).webhookId).toBeUndefined();
    expect(loadPaypalConfig({ ...base, PAYPAL_WEBHOOK_ID: '' }).webhookId).toBeUndefined();
    expect(loadPaypalConfig({ ...base, PAYPAL_WEBHOOK_ID: 'WH8PB0123456' }).webhookId).toBe('WH8PB0123456');
  });

  it('rejects a malformed id by name only', () => {
    expect(() => loadPaypalConfig({ ...base, PAYPAL_WEBHOOK_ID: 'not an id!' })).toThrow('PAYPAL_WEBHOOK_ID');
  });
});
