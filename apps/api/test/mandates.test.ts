import { LlmClient, LlmIntentParser, LlmRanker, type ProviderAdapter, type ProviderRequest, type ProviderResponse } from '@mandate/llm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { compose } from '../src/compose.js';
import type { Db } from '../src/db/db.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { DEMO_IDS, seed } from '../src/db/seed.js';
import { FixtureCatalog } from '../src/modules/catalog/fixture.js';
import { MandateError, MandateService } from '../src/modules/mandates/service.js';
import type { GatewayOrder, PaymentGateway } from '../src/modules/purchases/ports.js';
import { PurchaseService } from '../src/modules/purchases/service.js';
import { createTestDb } from './helpers/pglite.js';

/** Plays the model: one item per request, then the first listed candidate. */
class FirstCandidateModel implements ProviderAdapter {
  readonly provider = 'scripted';
  readonly model = 'scripted';
  #item: { description: string; quantity: number } = { description: 'x', quantity: 1 };

  set(item: { description: string; quantity: number }): void {
    this.#item = item;
  }

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    const candidate = /^Candidate (cand_[0-9a-f]{16}):/m.exec(request.userText)?.[1];
    const reply = candidate
      ? { selections: [{ candidateId: candidate, quantity: this.#item.quantity, reason: 'first' }], unmatchedItems: [] }
      : { schemaVersion: '1', items: [this.#item], clarifications: [], needsClarification: false };
    return Promise.resolve({ text: JSON.stringify(reply), usage: { inputTokens: 0, outputTokens: 0 }, model: 'scripted', stopReason: 'end' });
  }
}

class PendingGateway implements PaymentGateway {
  #n = 0;
  createOrder(): Promise<GatewayOrder> {
    return Promise.resolve({ providerOrderId: `ORDER${++this.#n}`, status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://paypal.example/approve' });
  }
  captureOrder(): Promise<GatewayOrder> {
    return Promise.reject(new Error('not used'));
  }
  getOrder(id: string): Promise<GatewayOrder> {
    return Promise.resolve({ providerOrderId: id, status: 'PAYER_ACTION_REQUIRED' });
  }
  verifyWebhook(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

let db: Db;
let app: FastifyInstance;
const model = new FirstCandidateModel();

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db, loadMigrations());
  await seed(db);
  const client = new LlmClient({ adapter: model, timeoutMs: 5_000, maxOutputTokens: 1_000 });
  const purchases = new PurchaseService({
    db,
    intentParser: new LlmIntentParser(client),
    catalog: new FixtureCatalog(),
    ranker: new LlmRanker(client),
    payments: new PendingGateway(),
  });
  // Two markers (paid, held), a gift card (denied), and two speakerphones that need approval. A single line
  // cannot reach the 30000 threshold without passing the 20000 per-line cap, so the threshold is lowered for it.
  for (const [description, quantity, key] of [
    ['whiteboard markers', 2, 'mandates-test-0001'],
    ['digital gift card', 1, 'mandates-test-0002'],
    ['conference speakerphone', 2, 'mandates-test-0003'],
  ] as const) {
    model.set({ description, quantity });
    if (key === 'mandates-test-0003') await db.query('UPDATE mandate SET approval_threshold_minor_units = 15000 WHERE id = $1', [DEMO_IDS.mandate]);
    await purchases.submit({ mandateId: DEMO_IDS.mandate, requesterUserId: DEMO_IDS.requester, text: `Buy ${quantity} ${description}`, requestKey: key });
  }
  await db.query('UPDATE mandate SET approval_threshold_minor_units = 30000 WHERE id = $1', [DEMO_IDS.mandate]);
  app = await buildApp({ config: { logLevel: 'silent', webOrigins: ['https://web.example'] }, logger: false, mandates: new MandateService(db) });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('GET /mandates/:id', () => {
  it('returns the mandate with its limits and approver', async () => {
    const response = await app.inject({ method: 'GET', url: `/mandates/${DEMO_IDS.mandate}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: DEMO_IDS.mandate,
      name: 'Club supplies, Nov-Dec 2026',
      currency: 'USD',
      budgetMinor: 100_000,
      perItemCapMinor: 20_000,
      approvalThresholdMinor: 30_000,
      maxQuantityPerLine: 10,
      status: 'ACTIVE',
      startsAt: '2026-11-01T00:00:00.000Z',
      approver: { id: DEMO_IDS.approver },
    });
    const { categoryLimits } = response.json<{ categoryLimits: unknown[] }>();
    expect(categoryLimits).toContainEqual({ category: 'gift-cards', allowed: false });
    expect(categoryLimits).toContainEqual({ category: 'electronics', allowed: true, capMinor: 50_000 });
  });

  it('404s an unknown mandate and 400s a bad id', async () => {
    expect((await app.inject({ method: 'GET', url: '/mandates/00000000-0000-4000-8000-0000000000ff' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/mandates/not-a-uuid' })).statusCode).toBe(400);
  });
});

describe('GET /mandates/:id/summary', () => {
  it('reports held spend by category, statuses, approvals and blocked attempts', async () => {
    const response = await app.inject({ method: 'GET', url: `/mandates/${DEMO_IDS.mandate}/summary` });
    expect(response.statusCode).toBe(200);
    const summary = response.json<Record<string, unknown>>();
    expect(summary).toMatchObject({
      currency: 'USD',
      budgetMinor: 100_000,
      committedMinor: 0,
      pendingApprovals: 1,
      blocked: 1,
      byStatus: { PAYMENT_PENDING: 1, DENIED: 1, PENDING_APPROVAL: 1 },
    });
    // Held: markers (2 x 1150) plus the speakerphones awaiting approval (2 x 8900).
    expect(summary.heldMinor).toBe(2_300 + 17_800);
    expect(summary.remainingMinor).toBe(100_000 - 2_300 - 17_800);
    expect(summary.byCategory).toEqual([
      { category: 'electronics', committedMinor: 0, heldMinor: 17_800 },
      { category: 'office-supplies', committedMinor: 0, heldMinor: 2_300 },
    ]);
  });

  it('404s an unknown mandate', async () => {
    expect((await app.inject({ method: 'GET', url: '/mandates/00000000-0000-4000-8000-0000000000ff/summary' })).statusCode).toBe(404);
  });
});

describe('GET /mandates/:id/purchases', () => {
  it('lists newest first, with decisions and reason codes', async () => {
    const response = await app.inject({ method: 'GET', url: `/mandates/${DEMO_IDS.mandate}/purchases` });
    const { items } = response.json<{ items: { status: string; outcome: string | null; reasonCodes: string[]; requester: string; totalMinor: number | null; text: string }[] }>();
    expect(items.map((i) => i.status)).toEqual(['PENDING_APPROVAL', 'DENIED', 'PAYMENT_PENDING']);
    expect(items[1]).toMatchObject({ outcome: 'DENY', text: 'Buy 1 digital gift card', totalMinor: 10_000, currency: 'USD' });
    expect(items[1]?.reasonCodes).toContain('CATEGORY_NOT_ALLOWED');
    expect(items[2]?.reasonCodes).toEqual(['WITHIN_MANDATE']);
    expect(typeof items[0]?.requester).toBe('string');
  });

  it('filters by status and limits', async () => {
    const pending = await app.inject({ method: 'GET', url: `/mandates/${DEMO_IDS.mandate}/purchases?status=PENDING_APPROVAL` });
    expect(pending.json<{ items: unknown[] }>().items).toHaveLength(1);
    const one = await app.inject({ method: 'GET', url: `/mandates/${DEMO_IDS.mandate}/purchases?limit=1` });
    expect(one.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/mandates/${DEMO_IDS.mandate}/purchases?status=PAID` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/mandates/00000000-0000-4000-8000-0000000000ff/purchases' })).statusCode).toBe(404);
  });
});

describe('GET /purchases/:id/audit', () => {
  it('returns who did what, oldest first, without detail payloads', async () => {
    const list = await app.inject({ method: 'GET', url: `/mandates/${DEMO_IDS.mandate}/purchases?status=DENIED` });
    const id = list.json<{ items: { id: string }[] }>().items[0]?.id ?? '';
    const response = await app.inject({ method: 'GET', url: `/purchases/${id}/audit` });
    expect(response.statusCode).toBe(200);
    const { entries } = response.json<{ entries: { action: string; actorType: string; actorId: string | null; detail?: unknown }[] }>();
    expect(entries[0]).toMatchObject({ action: 'request.received', actorType: 'user', actorId: DEMO_IDS.requester });
    expect(entries.map((e) => e.action)).toContain('policy.decided');
    expect(entries.every((e) => e.detail === undefined)).toBe(true);
  });

  it('404s an unknown request and 400s a bad id', async () => {
    expect((await app.inject({ method: 'GET', url: '/purchases/00000000-0000-4000-8000-0000000000ff/audit' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/purchases/nope/audit' })).statusCode).toBe(400);
  });
});

describe('PATCH /mandates/:id', () => {
  it('lets an admin change limits, replaces category limits, and audits the change', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/mandates/${DEMO_IDS.mandate}`,
      payload: {
        actorUserId: DEMO_IDS.admin,
        approvalThresholdMinor: 25_000,
        categoryLimits: [
          { category: 'office-supplies', allowed: true },
          { category: 'electronics', allowed: true, capMinor: 40_000 },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ approvalThresholdMinor: 25_000, budgetMinor: 100_000, categoryLimits: [{ category: 'electronics', allowed: true, capMinor: 40_000 }, { category: 'office-supplies', allowed: true }] });
    const audit = await db.query<{ action: string; actor_id: string }>("SELECT action, actor_id FROM audit_log WHERE action = 'mandate.updated'");
    expect(audit.rows).toEqual([{ action: 'mandate.updated', actor_id: DEMO_IDS.admin }]);
  });

  it('refuses a non-admin, an unknown mandate, and invalid bodies', async () => {
    const patch = (url: string, payload: unknown) => app.inject({ method: 'PATCH', url, payload: payload as Record<string, unknown> });
    const url = `/mandates/${DEMO_IDS.mandate}`;
    expect((await patch(url, { actorUserId: DEMO_IDS.requester, budgetMinor: 1 })).statusCode).toBe(403);
    expect((await patch('/mandates/00000000-0000-4000-8000-0000000000ff', { actorUserId: DEMO_IDS.admin })).statusCode).toBe(404);
    expect((await patch(url, { actorUserId: DEMO_IDS.admin, budgetMinor: 1.5 })).statusCode).toBe(400);
    expect((await patch(url, { actorUserId: DEMO_IDS.admin, extra: true })).statusCode).toBe(400);
    expect((await patch(url, { actorUserId: DEMO_IDS.admin, categoryLimits: [{ category: 'a', allowed: true }, { category: 'a', allowed: false }] })).statusCode).toBe(400);
    expect((await patch(url, { actorUserId: DEMO_IDS.admin, categoryLimits: [{ category: 'Gift Cards', allowed: true }] })).statusCode).toBe(400);
  });

  it('MandateService.update rejects an unknown mandate directly', async () => {
    await expect(new MandateService(db).update('00000000-0000-4000-8000-0000000000ff', DEMO_IDS.admin, {})).rejects.toEqual(new MandateError('MANDATE_NOT_FOUND'));
  });
});

describe('CORS', () => {
  it('allows the configured web origin only', async () => {
    const preflight = (origin: string) =>
      app.inject({ method: 'OPTIONS', url: `/mandates/${DEMO_IDS.mandate}`, headers: { origin, 'access-control-request-method': 'PATCH' } });
    expect((await preflight('https://web.example')).headers['access-control-allow-origin']).toBe('https://web.example');
    expect((await preflight('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is off when no web origin is configured', async () => {
    const plain = await buildApp({ config: { logLevel: 'silent' }, logger: false });
    const response = await plain.inject({ method: 'GET', url: '/health', headers: { origin: 'https://web.example' } });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await plain.close();
  });
});

describe('compose', () => {
  it('wires the mandates service whenever the database is present', () => {
    const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    expect(compose({ env: {}, db, log }).mandates).toBeInstanceOf(MandateService);
    expect(compose({ env: {}, log }).mandates).toBeUndefined();
  });
});
