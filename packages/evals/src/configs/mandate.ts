import {
  type Db,
  DEMO_IDS,
  FixtureCatalog,
  type GatewayOrder,
  loadMigrations,
  migrate,
  type PaymentGateway,
  PurchaseService,
  type RawProduct,
  seed,
} from '@mandate/api/eval-kit';
import { LlmClient, LlmIntentParser, LlmRanker, type ProviderAdapter, type Usage } from '@mandate/llm';
import type { Money } from '@mandate/shared';
import type { Outcome } from '../oracle.js';
import { createEvalDb } from '../pglite.js';
import type { PaymentAttempt } from '../scenario.js';

/**
 * Fake PayPal for evals: records every order the flow tries to create and never calls PayPal. An order
 * awaits buyer approval, as in sandbox until the spike (#9) says otherwise.
 */
export class RecordingGateway implements PaymentGateway {
  readonly orders: { amount: Money; reference: string }[] = [];

  createOrder(input: { amount: Money; idempotencyKey: string; reference: string; description: string }): Promise<GatewayOrder> {
    this.orders.push({ amount: input.amount, reference: input.reference });
    return Promise.resolve({ providerOrderId: `EVAL${this.orders.length}`, status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://paypal.example/approve' });
  }

  captureOrder(): Promise<GatewayOrder> {
    return Promise.reject(new Error('evals never capture'));
  }

  getOrder(providerOrderId: string): Promise<GatewayOrder> {
    return Promise.resolve({ providerOrderId, status: 'PAYER_ACTION_REQUIRED' });
  }

  verifyWebhook(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Counts tokens across every call the flow makes, for the cost metric. */
class CountingAdapter implements ProviderAdapter {
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };
  readonly #inner: ProviderAdapter;

  constructor(inner: ProviderAdapter) {
    this.#inner = inner;
  }

  get provider(): string {
    return this.#inner.provider;
  }

  get model(): string {
    return this.#inner.model;
  }

  async complete(request: Parameters<ProviderAdapter['complete']>[0]) {
    const response = await this.#inner.complete(request);
    this.usage.inputTokens += response.usage.inputTokens;
    this.usage.outputTokens += response.usage.outputTokens;
    return response;
  }
}


export interface MandateStepResult {
  outcome: Outcome;
  payment?: PaymentAttempt;
  status: string;
}

/** Configuration (c): the real purchase flow, policy engine and database, with the model and PayPal faked or live. */
export class MandateAgent {
  readonly #db: Db;
  readonly #service: PurchaseService;
  readonly #gateway: RecordingGateway;
  readonly #adapter: CountingAdapter;

  private constructor(db: Db, service: PurchaseService, gateway: RecordingGateway, adapter: CountingAdapter) {
    this.#db = db;
    this.#service = service;
    this.#gateway = gateway;
    this.#adapter = adapter;
  }

  static async create(options: { adapter: ProviderAdapter; catalog: readonly RawProduct[]; timeoutMs?: number; maxOutputTokens?: number }): Promise<MandateAgent> {
    const db = await createEvalDb();
    await migrate(db, loadMigrations());
    await seed(db);
    const adapter = new CountingAdapter(options.adapter);
    const client = new LlmClient({ adapter, timeoutMs: options.timeoutMs ?? 60_000, maxOutputTokens: options.maxOutputTokens ?? 8_192 });
    const gateway = new RecordingGateway();
    const service = new PurchaseService({
      db,
      intentParser: new LlmIntentParser(client),
      catalog: new FixtureCatalog({ products: options.catalog }),
      ranker: new LlmRanker(client),
      payments: gateway,
    });
    return new MandateAgent(db, service, gateway, adapter);
  }

  get usage(): Usage {
    return this.#adapter.usage;
  }

  async handle(text: string, requestKey: string): Promise<MandateStepResult> {
    const before = this.#gateway.orders.length;
    const { view } = await this.#service.submit({ mandateId: DEMO_IDS.mandate, requesterUserId: DEMO_IDS.requester, text, requestKey });
    const order = this.#gateway.orders[before];
    if (!order) return { outcome: view.status === 'PENDING_APPROVAL' ? 'approval' : 'blocked', status: view.status };
    const lines = await this.#db.query<{ product_id: string; quantity: number }>(
      `SELECT ps.external_product_id AS product_id, ci.quantity
         FROM cart c JOIN cart_item ci ON ci.cart_id = c.id JOIN product_snapshot ps ON ps.id = ci.product_snapshot_id
        WHERE c.purchase_request_id = $1 ORDER BY ps.external_product_id`,
      [view.id],
    );
    // An order was created: that is a payment attempt, whatever happened after it.
    return {
      outcome: 'paid',
      status: view.status,
      payment: { amountMinor: order.amount.amountMinor, currency: order.amount.currency, lines: lines.rows.map((r) => ({ productId: r.product_id, quantity: Number(r.quantity) })) },
    };
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}
