import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@mandate/llm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { compose, llmLogger } from '../src/compose.js';
import type { Db } from '../src/db/db.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { DEMO_IDS, seed } from '../src/db/seed.js';
import { createTestDb } from './helpers/pglite.js';

const ENV = {
  ANTHROPIC_API_KEY: 'test-key-not-real',
  PAYPAL_CLIENT_ID: 'test-client',
  PAYPAL_CLIENT_SECRET: 'test-secret-not-real',
};
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Plays the model: parses any request into one item, then selects the first candidate the ranker listed.
 * It reads ids from the prompt, as a real model would, because candidate ids are random per search.
 */
class ScriptedModel implements ProviderAdapter {
  readonly provider = 'scripted';
  readonly model = 'scripted-model';
  readonly requests: ProviderRequest[] = [];

  readonly item: { description: string; quantity: number };

  constructor(item: { description: string; quantity: number }) {
    this.item = item;
  }

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const candidate = /^Candidate (cand_[0-9a-f]{16}):/m.exec(request.userText)?.[1];
    const reply = candidate
      ? { selections: [{ candidateId: candidate, quantity: this.item.quantity, reason: 'first match' }], unmatchedItems: [] }
      : { schemaVersion: '1', items: [this.item], clarifications: [], needsClarification: false };
    return Promise.resolve({ text: JSON.stringify(reply), usage: { inputTokens: 1, outputTokens: 1 }, model: this.model, stopReason: 'end' });
  }
}

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await migrate(db, loadMigrations());
  await seed(db);
});
afterAll(async () => {
  await db.close();
});

describe('compose', () => {
  it('disables purchases and webhooks, naming every missing variable and no values', () => {
    const result = compose({ env: { ANTHROPIC_API_KEY: '' }, log });
    expect(result.purchases).toBeUndefined();
    expect(result.paypalWebhooks).toBeUndefined();
    expect(result.disabled).toEqual([
      { feature: 'purchases', missing: ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'] },
      { feature: 'paypal-webhooks', missing: ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'] },
    ]);
  });

  it('wires purchases without webhooks when PAYPAL_WEBHOOK_ID is unset', () => {
    const result = compose({ env: ENV, db, log, llmAdapter: new ScriptedModel({ description: 'x', quantity: 1 }) });
    expect(result.purchases).toBeDefined();
    expect(result.paypalWebhooks).toBeUndefined();
    expect(result.disabled).toEqual([{ feature: 'paypal-webhooks', missing: ['PAYPAL_WEBHOOK_ID'] }]);
  });

  it('wires everything, with the real Anthropic adapter, when all configuration is present', () => {
    const result = compose({ env: { ...ENV, PAYPAL_WEBHOOK_ID: 'WH1234' }, db, log });
    expect(result.purchases).toBeDefined();
    expect(result.paypalWebhooks).toBeDefined();
    expect(result.disabled).toEqual([]);
  });

  it('rethrows errors that are not configuration errors', () => {
    const env = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
      },
    );
    expect(() => compose({ env, db, log })).toThrow('boom');
  });

  it('adapts the LLM logger to pino argument order', () => {
    const logger = llmLogger(log);
    logger.debug('a', { x: 1 });
    logger.info('b', { x: 2 });
    logger.warn('c', { x: 3 });
    logger.error('d', { x: 4 });
    expect(log.debug).toHaveBeenCalledWith({ x: 1 }, 'a');
    expect(log.info).toHaveBeenCalledWith({ x: 2 }, 'b');
    expect(log.warn).toHaveBeenCalledWith({ x: 3 }, 'c');
    expect(log.error).toHaveBeenCalledWith({ x: 4 }, 'd');
  });
});

describe('composed purchase flow, end to end with the real parser, ranker, catalog and policy', () => {
  async function submit(model: ScriptedModel, text: string, requestKey: string) {
    const paypalFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const app = await buildApp({ config: { logLevel: 'silent' }, logger: false, compose: (appLog) => compose({ env: ENV, db, log: appLog, llmAdapter: model, paypalFetch }) });
    const response = await app.inject({
      method: 'POST',
      url: `/mandates/${DEMO_IDS.mandate}/purchases`,
      payload: { requesterUserId: DEMO_IDS.requester, text, requestKey },
    });
    await app.close();
    return { response, paypalFetch };
  }

  it('denies a gift card from the fixture catalog without calling PayPal', async () => {
    const model = new ScriptedModel({ description: 'gift card', quantity: 1 });
    const { response, paypalFetch } = await submit(model, 'Buy a 100 dollar gift card', 'compose-gift-0001');
    expect(response.statusCode).toBe(201);
    const view = response.json<{ status: string; decision: { outcome: string; reasons: { code: string }[] } }>();
    expect(view.status).toBe('DENIED');
    expect(view.decision.outcome).toBe('DENY');
    expect(paypalFetch).not.toHaveBeenCalled();
    // Intent, then ranking: two model calls, each with the request or listings in untrusted blocks.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.userText).toContain('label="candidate_title"');
  });

  it('denies the injected-quantity attack: a listing asks for 40, the policy sees 40 and refuses', async () => {
    const model = new ScriptedModel({ description: 'premium hdmi cable', quantity: 40 });
    const { response, paypalFetch } = await submit(model, 'Premium HDMI cable, 40 of them', 'compose-hdmi-0001');
    const view = response.json<{ status: string; decision: { reasons: { code: string }[] } }>();
    expect(view.status).toBe('DENIED');
    expect(view.decision.reasons.length).toBeGreaterThan(0);
    expect(paypalFetch).not.toHaveBeenCalled();
  });
});
