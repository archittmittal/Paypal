import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/db.js';
import type { PaymentGateway } from '../purchases/ports.js';
import type { PurchaseService } from '../purchases/service.js';

/** The fields we read. Everything else in the event is stored for forensics but never trusted. */
const WebhookEventSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  event_type: z.string().regex(/^[A-Z0-9._]{1,128}$/),
  resource: z.record(z.string(), z.unknown()),
});

const OrderIdSchema = z.string().regex(/^[A-Z0-9]{1,64}$/);
const RelatedOrderSchema = z.object({ supplementary_data: z.object({ related_ids: z.object({ order_id: OrderIdSchema }) }) });

/**
 * Which PayPal order an event is about. Order events carry it as resource.id; capture events under
 * supplementary_data.related_ids. VERIFY on the sandbox: exact event names and payload shapes (CLAUDE.md VERIFY 3).
 */
export function providerOrderIdOf(eventType: string, resource: Record<string, unknown>): string | undefined {
  if (eventType.startsWith('CHECKOUT.ORDER.')) return OrderIdSchema.safeParse(resource.id).data;
  if (eventType.startsWith('PAYMENT.CAPTURE.')) return RelatedOrderSchema.safeParse(resource).data?.supplementary_data.related_ids.order_id;
  return undefined;
}

export type WebhookOutcome =
  | { status: 200; result: 'processed' | 'duplicate' | 'ignored' }
  | { status: 400; result: 'malformed' }
  | { status: 401; result: 'unverified' }
  | { status: 503; result: 'verification_unavailable' | 'processing_failed' };

/**
 * PayPal webhooks (hard rule 5: dedupe by event id). The order of checks matters:
 * 1. Verify the signature with PayPal. If PayPal cannot be asked, answer 503 so it redelivers later.
 * 2. Insert into webhook_event; the unique (provider, provider_event_id) makes a redelivery a no-op.
 * 3. Unverified events are stored for forensics and never processed.
 * 4. A verified event only triggers reconcile(), which reads the order from PayPal. The event's own
 *    status or amount is never used to change money state.
 */
export class PaypalWebhookHandler {
  readonly #db: Db;
  readonly #payments: PaymentGateway;
  readonly #purchases: PurchaseService;

  constructor(deps: { db: Db; payments: PaymentGateway; purchases: PurchaseService }) {
    this.#db = deps.db;
    this.#payments = deps.payments;
    this.#purchases = deps.purchases;
  }

  async handle(headers: Readonly<Record<string, string | string[] | undefined>>, body: unknown): Promise<WebhookOutcome> {
    const parsed = WebhookEventSchema.safeParse(body);
    if (!parsed.success) return { status: 400, result: 'malformed' };
    const event = parsed.data;

    let verified: boolean;
    try {
      verified = await this.#payments.verifyWebhook(headers, body);
    } catch {
      return { status: 503, result: 'verification_unavailable' };
    }

    const inserted = await this.#db.query<{ id: string }>(
      `INSERT INTO webhook_event (provider, provider_event_id, event_type, payload, signature_verified, processing_state)
       VALUES ('paypal', $1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [event.id, event.event_type, JSON.stringify(body), verified, verified ? 'RECEIVED' : 'IGNORED'],
    );
    let webhookEventId = inserted.rows[0]?.id;
    if (!webhookEventId) {
      // A redelivery. Only a verified event whose processing failed or never finished is worth another try.
      const existing = await this.#db.query<{ id: string; processing_state: string; signature_verified: boolean }>(
        "SELECT id, processing_state, signature_verified FROM webhook_event WHERE provider = 'paypal' AND provider_event_id = $1",
        [event.id],
      );
      const row = existing.rows[0];
      if (!row?.signature_verified || !verified || (row.processing_state !== 'FAILED' && row.processing_state !== 'RECEIVED')) {
        return { status: 200, result: 'duplicate' };
      }
      webhookEventId = row.id;
    }
    if (!verified) return { status: 401, result: 'unverified' };

    const providerOrderId = providerOrderIdOf(event.event_type, event.resource);
    const requestId = providerOrderId === undefined ? undefined : await this.#purchases.requestForProviderOrder(providerOrderId);
    if (requestId === undefined) {
      await this.#setState(webhookEventId, 'IGNORED');
      return { status: 200, result: 'ignored' };
    }

    try {
      await this.#purchases.reconcile(requestId);
    } catch {
      // Stored as FAILED; PayPal redelivers on 5xx and the redelivery is processed again.
      // reconcileUnknown() is the backstop if PayPal gives up.
      await this.#setState(webhookEventId, 'FAILED');
      return { status: 503, result: 'processing_failed' };
    }
    await this.#setState(webhookEventId, 'PROCESSED');
    return { status: 200, result: 'processed' };
  }

  async #setState(id: string, state: 'PROCESSED' | 'FAILED' | 'IGNORED'): Promise<void> {
    await this.#db.query('UPDATE webhook_event SET processing_state = $2 WHERE id = $1', [id, state]);
  }
}

export function paypalWebhookRoutes(handler: PaypalWebhookHandler) {
  return (app: FastifyInstance): void => {
    app.post('/webhooks/paypal', async (request, reply) => {
      const outcome = await handler.handle(request.headers, request.body);
      if (outcome.status !== 200) request.log.warn({ result: outcome.result }, 'paypal webhook not processed');
      return reply.status(outcome.status).send({ result: outcome.result });
    });
  };
}
