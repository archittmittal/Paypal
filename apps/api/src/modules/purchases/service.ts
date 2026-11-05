import { createHash, randomBytes } from 'node:crypto';
import { checkPriceDrift, evaluate, type Reason } from '@mandate/policy';
import { PurchaseIntentSchema, type Money } from '@mandate/shared';
import { toBigInt, type Db, type Queryable } from '../../db/db.js';
import { commitReservation, releaseReservation, reserveBudget } from '../../db/reservations.js';
import { buildCart, type SnapshotRef } from './cart.js';
import { loadHistory, lockMandate } from './policy-inputs.js';
import { GatewayError, type ApprovalNotifier, type Catalog, type IntentParser, type PaymentGateway, type Ranker } from './ports.js';

export type PurchaseStatus =
  | 'RECEIVED'
  | 'NEEDS_CLARIFICATION'
  | 'NO_MATCH'
  | 'QUOTED'
  | 'DENIED'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'EXPIRED'
  | 'PAYMENT_PENDING'
  | 'UNKNOWN_OUTCOME'
  | 'CAPTURED'
  | 'FAILED';

export type PurchaseErrorCode =
  | 'NOT_FOUND'
  | 'MANDATE_NOT_FOUND'
  | 'REQUESTER_NOT_ALLOWED'
  | 'REQUEST_KEY_CONFLICT'
  | 'INVALID_STATE'
  | 'PAYMENT_NOT_CAPTURABLE'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_ALREADY_DECIDED'
  | 'APPROVAL_EXPIRED';

export class PurchaseError extends Error {
  readonly code: PurchaseErrorCode;

  constructor(code: PurchaseErrorCode) {
    super(code);
    this.name = 'PurchaseError';
    this.code = code;
  }
}

/** What the API returns. Titles are quarantined retailer text: render as text, never as HTML. */
export interface PurchaseView {
  id: string;
  mandateId: string;
  status: PurchaseStatus;
  failureCode?: string;
  clarifications?: string[];
  cart?: {
    currency: string;
    totalMinor: number;
    items: { title: string; category: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
  };
  decision?: { outcome: string; reasons: Reason[]; policyVersion: string; evaluatedTotal: Money };
  order?: { id: string; state: string; providerStatus?: string; approveUrl?: string };
}

export interface SubmitInput {
  mandateId: string;
  requesterUserId: string;
  text: string;
  requestKey: string;
}

export interface PurchaseServiceDeps {
  db: Db;
  intentParser: IntentParser;
  catalog: Catalog;
  ranker: Ranker;
  payments: PaymentGateway;
  /** Sends the approver their single-use link (Zapier, #26). Without one, approvals can only expire. */
  approvalNotifier?: ApprovalNotifier;
  now?: () => Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface OrderRow {
  id: string;
  state: string;
  provider_order_id: string | null;
  amount_minor_units: unknown;
  currency: string;
  policy_decision_id: string;
  organization_id: string;
  mandate_id: string;
  requester_user_id: string;
}

interface ApprovalRow {
  id: string;
  status: string;
  expires_at: Date | string;
  approver_user_id: string;
  policy_decision_id: string;
  request_id: string;
  mandate_id: string;
  requester_user_id: string;
  organization_id: string;
  amount_minor_units: unknown;
  currency: string;
  price_drift_tolerance_bps: number;
  reservation_id: string;
}

const APPROVAL_SELECT = `
  SELECT a.id, a.status, a.expires_at, a.approver_user_id, a.policy_decision_id,
         pr.id AS request_id, pr.mandate_id, pr.requester_user_id, m.organization_id,
         pd.evaluated_total_minor_units AS amount_minor_units, pd.currency, m.price_drift_tolerance_bps,
         br.id AS reservation_id
    FROM approval a
    JOIN purchase_request pr ON pr.id = a.purchase_request_id
    JOIN mandate m ON m.id = pr.mandate_id
    JOIN policy_decision pd ON pd.id = a.policy_decision_id
    JOIN budget_reservation br ON br.policy_decision_id = a.policy_decision_id`;

/** After a money-moving call starts, an error we cannot classify is an unknown outcome, never a safe failure. */
function asGatewayError(error: unknown): GatewayError {
  return error instanceof GatewayError ? error : new GatewayError('UNKNOWN_OUTCOME', 'UNCLASSIFIED');
}

/** How long a reservation, and the approval holding it, stays valid (docs/er-diagram.md). */
export const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

interface Context {
  requestId: string;
  mandateId: string;
  organizationId: string;
  requesterUserId: string;
}

/**
 * The purchase flow (docs/uml.md sections 2-4): request -> intent -> candidates -> proposal -> cart priced in
 * code -> policy decision under the mandate lock -> reservation -> PayPal order. The LLM ports only ever
 * propose; this class decides what is stored and what is paid (hard rules 1 and 2).
 */
export class PurchaseService {
  readonly #deps: PurchaseServiceDeps;
  readonly #now: () => Date;

  constructor(deps: PurchaseServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Idempotent on requestKey: a repeat returns the stored result and never pays twice. */
  async submit(input: SubmitInput): Promise<{ view: PurchaseView; created: boolean }> {
    const { db } = this.#deps;
    const existing = await this.#findByKey(input);
    if (existing) return { view: await this.get(existing), created: false };

    const owner = await db.query<{ organization_id: string }>(
      `SELECT m.organization_id FROM mandate m JOIN app_user u ON u.organization_id = m.organization_id
        WHERE m.id = $1 AND u.id = $2`,
      [input.mandateId, input.requesterUserId],
    );
    const organizationId = owner.rows[0]?.organization_id;
    if (!organizationId) {
      const mandate = await db.query('SELECT 1 FROM mandate WHERE id = $1', [input.mandateId]);
      throw new PurchaseError(mandate.rows.length === 0 ? 'MANDATE_NOT_FOUND' : 'REQUESTER_NOT_ALLOWED');
    }

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key)
       VALUES ($1, $2, $3, $4) ON CONFLICT (request_key) DO NOTHING RETURNING id`,
      [input.mandateId, input.requesterUserId, input.text, input.requestKey],
    );
    const requestId = inserted.rows[0]?.id;
    if (!requestId) {
      // Lost a race with an identical submit: return the winner's result.
      const winner = await this.#findByKey(input);
      if (!winner) throw new PurchaseError('REQUEST_KEY_CONFLICT');
      return { view: await this.get(winner), created: false };
    }

    const ctx: Context = { requestId, mandateId: input.mandateId, organizationId, requesterUserId: input.requesterUserId };
    await this.#audit(db, ctx, 'user', input.requesterUserId, 'request.received', {});
    try {
      await this.#process(ctx, input.text);
    } catch (error) {
      await this.#fail(ctx, 'INTERNAL').catch(() => undefined);
      throw error;
    }
    return { view: await this.get(requestId), created: true };
  }

  async get(requestId: string): Promise<PurchaseView> {
    const { db } = this.#deps;
    const request = await db.query<{ id: string; mandate_id: string; status: PurchaseStatus; failure_code: string | null; parsed_intent: unknown }>(
      'SELECT id, mandate_id, status, failure_code, parsed_intent FROM purchase_request WHERE id = $1',
      [requestId],
    );
    const row = request.rows[0];
    if (!row) throw new PurchaseError('NOT_FOUND');
    const view: PurchaseView = { id: row.id, mandateId: row.mandate_id, status: row.status };
    if (row.failure_code !== null) view.failureCode = row.failure_code;
    if (row.status === 'NEEDS_CLARIFICATION') {
      const intent = PurchaseIntentSchema.safeParse(row.parsed_intent);
      if (intent.success) view.clarifications = intent.data.clarifications;
    }

    const cart = await db.query<{ currency: string; total_minor_units: unknown }>(
      'SELECT currency, total_minor_units FROM cart WHERE purchase_request_id = $1',
      [requestId],
    );
    if (cart.rows[0]) {
      const items = await db.query<{ title: string; category: string; quantity: number; unit_price_minor_units: unknown; line_total_minor_units: unknown }>(
        `SELECT ps.title, ps.category, ci.quantity, ci.unit_price_minor_units, ci.line_total_minor_units
           FROM cart c JOIN cart_item ci ON ci.cart_id = c.id JOIN product_snapshot ps ON ps.id = ci.product_snapshot_id
          WHERE c.purchase_request_id = $1 ORDER BY ci.id`,
        [requestId],
      );
      view.cart = {
        currency: cart.rows[0].currency,
        totalMinor: Number(toBigInt(cart.rows[0].total_minor_units)),
        items: items.rows.map((item) => ({
          title: item.title,
          category: item.category,
          quantity: item.quantity,
          unitPriceMinor: Number(toBigInt(item.unit_price_minor_units)),
          lineTotalMinor: Number(toBigInt(item.line_total_minor_units)),
        })),
      };
    }

    const decision = await db.query<{ outcome: string; reasons: Reason[]; policy_version: string; evaluated_total_minor_units: unknown; currency: string }>(
      `SELECT outcome, reasons, policy_version, evaluated_total_minor_units, currency FROM policy_decision
        WHERE purchase_request_id = $1 ORDER BY decided_at DESC LIMIT 1`,
      [requestId],
    );
    if (decision.rows[0]) {
      const d = decision.rows[0];
      view.decision = {
        outcome: d.outcome,
        reasons: d.reasons,
        policyVersion: d.policy_version,
        evaluatedTotal: { amountMinor: Number(toBigInt(d.evaluated_total_minor_units)), currency: d.currency },
      };
    }

    const order = await db.query<{ id: string; state: string; provider_status: string | null; approve_url: string | null }>(
      'SELECT id, state, provider_status, approve_url FROM payment_order WHERE purchase_request_id = $1',
      [requestId],
    );
    if (order.rows[0]) {
      const o = order.rows[0];
      view.order = {
        id: o.id,
        state: o.state,
        ...(o.provider_status === null ? {} : { providerStatus: o.provider_status }),
        // Only while the buyer still has to act; a captured order has nothing to approve.
        ...(o.approve_url === null || o.state !== 'PAYMENT_PENDING' ? {} : { approveUrl: o.approve_url }),
      };
    }
    return view;
  }

  /** Captures an ALLOW-ed order after the buyer approved it on PayPal. */
  /**
   * Settles an order from PayPal's own record (failure mode 4). Used for UNKNOWN_OUTCOME and whenever a webhook
   * says something changed: the webhook only triggers this, and its payload is never trusted for money state.
   */
  async reconcile(requestId: string): Promise<PurchaseView> {
    const { db, payments } = this.#deps;
    const order = await this.#orderRow(requestId);
    if (!order) throw new PurchaseError((await this.#exists(requestId)) ? 'INVALID_STATE' : 'NOT_FOUND');
    if (order.state !== 'UNKNOWN_OUTCOME' && order.state !== 'PAYMENT_PENDING') return this.get(requestId);

    const ctx: Context = { requestId, mandateId: order.mandate_id, organizationId: order.organization_id, requesterUserId: order.requester_user_id };
    const expected: Money = { amountMinor: Number(toBigInt(order.amount_minor_units)), currency: order.currency };

    if (order.provider_order_id === null) {
      // The create call never confirmed. Retrying with the same PayPal-Request-Id returns the original order if
      // PayPal created one, and creates it once if not (VERIFY: PayPal's idempotency window on the sandbox).
      const reservationId = await this.#reservationFor(db, order.policy_decision_id);
      if (reservationId) {
        await this.#createPayment(ctx, { orderId: order.id, decisionId: order.policy_decision_id, reservationId, amount: expected });
      }
      return this.get(requestId);
    }

    let remote;
    try {
      remote = await payments.getOrder(order.provider_order_id);
    } catch {
      // PayPal could not be asked: nothing is known yet, so nothing changes.
      return this.get(requestId);
    }

    if (remote.status === 'COMPLETED') {
      const captured = remote.capturedAmount;
      if (captured?.amountMinor === expected.amountMinor && captured.currency === expected.currency) {
        await this.#markCaptured(ctx, order, expected, remote.status, order.state);
      } else {
        // PayPal says paid, but not the amount we approved. A human must look; never mark it settled.
        await db.transaction(async (tx) => {
          await tx.query("UPDATE payment_order SET state = 'UNKNOWN_OUTCOME', provider_status = $2 WHERE id = $1", [order.id, remote.status]);
          await this.#event(tx, order.id, 'amount_mismatch', order.state, 'UNKNOWN_OUTCOME', { captured: captured ?? null });
          await this.#setStatus(tx, requestId, 'UNKNOWN_OUTCOME');
          await this.#audit(tx, ctx, 'system', null, 'payment.amount_mismatch', { expected, captured: captured ?? null });
        });
      }
      return this.get(requestId);
    }

    if (remote.status === 'VOIDED') {
      await db.transaction(async (tx) => {
        await tx.query("UPDATE payment_order SET state = 'FAILED', provider_status = $2 WHERE id = $1", [order.id, remote.status]);
        await this.#event(tx, order.id, 'voided', order.state, 'FAILED', {});
        const reservationId = await this.#reservationFor(tx, order.policy_decision_id);
        if (reservationId) await releaseReservation(tx, reservationId, this.#now());
        await tx.query("UPDATE purchase_request SET status = 'FAILED', failure_code = 'PAYPAL_VOIDED' WHERE id = $1", [requestId]);
        await this.#audit(tx, ctx, 'system', null, 'payment.voided', {});
      });
      return this.get(requestId);
    }

    // Not paid yet (CREATED, SAVED, PAYER_ACTION_REQUIRED, APPROVED): the order is simply still pending.
    await db.transaction(async (tx) => {
      await tx.query("UPDATE payment_order SET state = 'PAYMENT_PENDING', provider_status = $2 WHERE id = $1", [order.id, remote.status]);
      await this.#event(tx, order.id, 'reconciled', order.state, 'PAYMENT_PENDING', { providerStatus: remote.status });
      await this.#setStatus(tx, requestId, 'PAYMENT_PENDING');
    });
    if (remote.status === 'APPROVED') {
      // The buyer approved on PayPal: capture now, so the purchase completes even if they never return to our page.
      try {
        return await this.capture(requestId);
      } catch (error) {
        if (error instanceof PurchaseError && error.code === 'PAYMENT_NOT_CAPTURABLE') return this.get(requestId);
        throw error;
      }
    }
    return this.get(requestId);
  }

  /** Reconciles every order whose outcome is unknown. Run periodically. Returns how many were settled. */
  async reconcileUnknown(): Promise<number> {
    const { rows } = await this.#deps.db.query<{ purchase_request_id: string }>(
      "SELECT purchase_request_id FROM payment_order WHERE state = 'UNKNOWN_OUTCOME' ORDER BY created_at",
    );
    let settled = 0;
    for (const { purchase_request_id: requestId } of rows) {
      const view = await this.reconcile(requestId);
      if (view.order?.state !== 'UNKNOWN_OUTCOME') settled += 1;
    }
    return settled;
  }

  /** The PayPal order id is how a webhook names an order; this maps it back to our request. */
  async requestForProviderOrder(providerOrderId: string): Promise<string | undefined> {
    const { rows } = await this.#deps.db.query<{ purchase_request_id: string }>(
      'SELECT purchase_request_id FROM payment_order WHERE provider_order_id = $1',
      [providerOrderId],
    );
    return rows[0]?.purchase_request_id;
  }

  async capture(requestId: string): Promise<PurchaseView> {
    const { db, payments } = this.#deps;
    const order = await this.#orderRow(requestId);
    if (!order) throw new PurchaseError((await this.#exists(requestId)) ? 'INVALID_STATE' : 'NOT_FOUND');
    if (order.state !== 'PAYMENT_PENDING' || order.provider_order_id === null) throw new PurchaseError('INVALID_STATE');

    const ctx: Context = { requestId, mandateId: order.mandate_id, organizationId: order.organization_id, requesterUserId: order.requester_user_id };
    const expected: Money = { amountMinor: Number(toBigInt(order.amount_minor_units)), currency: order.currency };
    try {
      const result = await payments.captureOrder(order.provider_order_id, `cap-${order.id}`, expected);
      if (result.status !== 'COMPLETED') {
        await db.transaction(async (tx) => {
          await tx.query('UPDATE payment_order SET provider_status = $2 WHERE id = $1', [order.id, result.status]);
          await this.#event(tx, order.id, 'capture_pending', 'PAYMENT_PENDING', 'PAYMENT_PENDING', { providerStatus: result.status });
        });
        return await this.get(requestId);
      }
      await this.#markCaptured(ctx, order, expected, result.status, 'PAYMENT_PENDING');
    } catch (error) {
      // Once a money-moving call has started, an unclassified error means the money may have moved.
      const failure = asGatewayError(error);
      if (failure.kind === 'UNKNOWN_OUTCOME') {
        await this.#markUnknown(ctx, order.id, failure.code);
        return this.get(requestId);
      }
      // Usually "buyer has not approved yet". The order stays open; expiry and cancellation are #13.
      await db.transaction((tx) => this.#event(tx, order.id, 'capture_rejected', 'PAYMENT_PENDING', 'PAYMENT_PENDING', { code: failure.code }));
      throw new PurchaseError('PAYMENT_NOT_CAPTURABLE');
    }
    return this.get(requestId);
  }

  async #process(ctx: Context, text: string): Promise<void> {
    const { db, intentParser, catalog, ranker } = this.#deps;

    let intent;
    try {
      intent = PurchaseIntentSchema.parse(await intentParser.parse(text));
    } catch {
      return this.#fail(ctx, 'INTENT_FAILED');
    }
    await db.query('UPDATE purchase_request SET parsed_intent = $2 WHERE id = $1', [ctx.requestId, JSON.stringify(intent)]);
    if (intent.needsClarification) return this.#setStatus(db, ctx.requestId, 'NEEDS_CLARIFICATION');

    let products;
    try {
      products = await catalog.search(intent);
    } catch {
      return this.#fail(ctx, 'CATALOG_FAILED');
    }
    if (products.length === 0) return this.#setStatus(db, ctx.requestId, 'NO_MATCH');

    const snapshots = new Map<string, SnapshotRef>();
    for (const product of products) {
      const { candidate } = product;
      const row = await db.query<{ id: string }>(
        `INSERT INTO product_snapshot (purchase_request_id, provider, external_product_id, title, category,
           unit_price_minor_units, currency, raw_payload, text_quarantined, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9) RETURNING id`,
        [
          ctx.requestId,
          product.provider,
          candidate.sourceProductId,
          candidate.title,
          product.category,
          candidate.unitPrice.amountMinor,
          candidate.unitPrice.currency,
          JSON.stringify(product.raw ?? null),
          candidate.fetchedAt,
        ],
      );
      snapshots.set(candidate.id, {
        snapshotId: row.rows[0]?.id ?? '',
        productId: candidate.sourceProductId,
        category: product.category,
        unitPriceMinor: candidate.unitPrice.amountMinor,
        currency: candidate.unitPrice.currency,
      });
    }

    let proposal;
    try {
      proposal = await ranker.rank(intent, products.map((p) => p.candidate));
    } catch {
      return this.#fail(ctx, 'RANKING_FAILED');
    }
    const cart = buildCart(proposal, snapshots);
    if (!cart.ok) {
      if (cart.reason === 'NO_SELECTION') return this.#setStatus(db, ctx.requestId, 'NO_MATCH');
      // The model proposed something code refuses to price: visible on the dashboard, never paid.
      await this.#audit(db, ctx, 'agent', null, 'proposal.rejected', { reason: cart.reason });
      return this.#fail(ctx, cart.reason);
    }

    const now = this.#now();
    const cartRow = await db.query<{ id: string }>(
      `INSERT INTO cart (purchase_request_id, currency, subtotal_minor_units, shipping_minor_units, tax_minor_units, total_minor_units, quoted_at)
       VALUES ($1, $2, $3, 0, 0, $3, $4) RETURNING id`,
      [ctx.requestId, cart.currency, cart.subtotalMinor, now],
    );
    const cartId = cartRow.rows[0]?.id ?? '';
    for (const line of cart.lines) {
      await db.query(
        'INSERT INTO cart_item (cart_id, product_snapshot_id, quantity, unit_price_minor_units, line_total_minor_units) VALUES ($1, $2, $3, $4, $5)',
        [cartId, line.snapshotId, line.quantity, line.unitPriceMinor, line.lineTotalMinor],
      );
    }
    await this.#setStatus(db, ctx.requestId, 'QUOTED');

    const decided = await db.transaction(async (tx) => {
      const mandate = await lockMandate(tx, ctx.mandateId);
      if (!mandate) throw new PurchaseError('MANDATE_NOT_FOUND');
      const history = await loadHistory(tx, ctx.mandateId);
      const decision = evaluate(
        mandate,
        {
          currency: cart.currency,
          items: cart.lines.map((l) => ({ productId: l.productId, category: l.category, unitPriceMinor: l.unitPriceMinor, quantity: l.quantity })),
          // The catalog does not quote shipping or tax yet; the cart stores 0 for both (VERIFY with #16).
          shippingMinor: 0,
          taxMinor: 0,
        },
        history,
        now,
      );
      const decisionRow = await tx.query<{ id: string }>(
        `INSERT INTO policy_decision (purchase_request_id, cart_id, outcome, reasons, policy_version, evaluated_total_minor_units, currency, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          ctx.requestId,
          cartId,
          decision.outcome,
          JSON.stringify(decision.reasons),
          decision.policyVersion,
          decision.evaluatedTotal.amountMinor,
          decision.evaluatedTotal.currency,
          decision.decidedAt,
        ],
      );
      const decisionId = decisionRow.rows[0]?.id ?? '';
      await this.#audit(tx, ctx, 'system', null, 'policy.decided', { outcome: decision.outcome, reasons: decision.reasons }, decision.policyVersion);

      if (decision.outcome === 'DENY') {
        await this.#setStatus(tx, ctx.requestId, 'DENIED');
        return undefined;
      }

      const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
      const reserved = await reserveBudget(tx, {
        mandateId: ctx.mandateId,
        policyDecisionId: decisionId,
        amountMinor: decision.evaluatedTotal.amountMinor,
        currency: decision.evaluatedTotal.currency,
        expiresAt,
      });
      // The policy engine saw the same locked history, so this cannot fail unless the two disagree.
      if (!reserved.ok) throw new Error(`Reservation refused after ${decision.outcome}: ${reserved.reason}`);

      if (decision.outcome === 'NEEDS_APPROVAL') {
        // Single-use link token: only its hash is stored, and the plain token leaves this process once,
        // through the notifier (Zapier, #26).
        const token = randomBytes(32).toString('base64url');
        const approval = await tx.query<{ id: string }>(
          `INSERT INTO approval (purchase_request_id, policy_decision_id, approver_user_id, token_hash, expires_at)
           SELECT $1, $2, approver_user_id, $3, $4 FROM mandate WHERE id = $5 RETURNING id`,
          [ctx.requestId, decisionId, hashToken(token), expiresAt, ctx.mandateId],
        );
        await this.#setStatus(tx, ctx.requestId, 'PENDING_APPROVAL');
        return {
          kind: 'approval' as const,
          approvalId: approval.rows[0]?.id ?? '',
          token,
          expiresAt,
          amount: decision.evaluatedTotal,
          reasons: decision.reasons,
        };
      }

      const orderId = await this.#openOrder(tx, ctx, decisionId, decision.evaluatedTotal);
      return { kind: 'order' as const, orderId, decisionId, reservationId: reserved.reservationId, amount: decision.evaluatedTotal };
    });

    if (decided?.kind === 'order') await this.#createPayment(ctx, decided);
    if (decided?.kind === 'approval') await this.#notifyApprover(ctx, decided);
  }

  /**
   * What the approver is being asked to decide, for the review page. Read-only: it never changes the approval,
   * so opening the link twice is harmless. The token travels in the request body, like the decision.
   */
  async previewApproval(token: string): Promise<{ purchase: PurchaseView; approval: { status: string; expiresAt: string } }> {
    const found = await this.#approvalByHash(this.#deps.db, hashToken(token));
    if (!found) throw new PurchaseError('APPROVAL_NOT_FOUND');
    return {
      purchase: await this.get(found.request_id),
      approval: { status: found.status, expiresAt: new Date(found.expires_at).toISOString() },
    };
  }

  /**
   * Applies the approver's decision. The token is the only credential: single use, stored as a hash,
   * checked against expiry server-side. An approval leads to payment only after a re-quote passes the
   * mandate's price-drift tolerance, so the approved amount is the paid amount (failure mode 3).
   */
  async decideApproval(token: string, decision: 'APPROVE' | 'REJECT', channel: string): Promise<PurchaseView> {
    const { db, catalog } = this.#deps;
    const tokenHash = hashToken(token);
    const found = await this.#approvalByHash(db, tokenHash);
    if (!found) throw new PurchaseError('APPROVAL_NOT_FOUND');

    // Re-quote outside the transaction: a network call must never hold the mandate or approval lock.
    let requotedTotal: Money | undefined;
    if (decision === 'APPROVE' && found.status === 'PENDING' && catalog.requote) {
      requotedTotal = await this.#requote(found.request_id).catch(() => undefined);
    }

    const result = await db.transaction(async (tx) => {
      const approval = await this.#approvalByHash(tx, tokenHash, true);
      if (!approval) throw new PurchaseError('APPROVAL_NOT_FOUND');
      if (approval.status !== 'PENDING') throw new PurchaseError('APPROVAL_ALREADY_DECIDED');
      const ctx: Context = {
        requestId: approval.request_id,
        mandateId: approval.mandate_id,
        organizationId: approval.organization_id,
        requesterUserId: approval.requester_user_id,
      };
      const now = this.#now();
      if (new Date(approval.expires_at).getTime() <= now.getTime()) {
        await this.#closeApproval(tx, ctx, approval, 'EXPIRED', now);
        return { kind: 'expired' as const };
      }
      if (decision === 'REJECT') {
        await this.#closeApproval(tx, ctx, approval, 'REJECTED', now, channel);
        return { kind: 'done' as const, requestId: ctx.requestId };
      }

      const approved: Money = { amountMinor: Number(toBigInt(approval.amount_minor_units)), currency: approval.currency };
      await tx.query("UPDATE approval SET status = 'APPROVED', decided_at = $2, channel = $3 WHERE id = $1", [approval.id, now, channel]);
      await this.#audit(tx, ctx, 'user', approval.approver_user_id, 'approval.approved', { channel });

      const drift = requotedTotal
        ? checkPriceDrift(approved, requotedTotal, approval.price_drift_tolerance_bps)
        : catalog.requote
          ? // The re-quote failed: without a fresh price there is no safe amount to pay.
            { code: 'PRICE_DRIFT' as const }
          : null;
      if (drift) {
        await releaseReservation(tx, approval.reservation_id, now);
        await tx.query("UPDATE purchase_request SET status = 'FAILED', failure_code = 'PRICE_DRIFT' WHERE id = $1", [ctx.requestId]);
        await this.#audit(tx, ctx, 'system', null, 'payment.price_drift', { approved, requoted: requotedTotal ?? null });
        return { kind: 'done' as const, requestId: ctx.requestId };
      }

      const orderId = await this.#openOrder(tx, ctx, approval.policy_decision_id, approved, approval.id);
      return {
        kind: 'order' as const,
        ctx,
        order: { orderId, decisionId: approval.policy_decision_id, reservationId: approval.reservation_id, amount: approved },
      };
    });

    if (result.kind === 'expired') throw new PurchaseError('APPROVAL_EXPIRED');
    if (result.kind === 'order') {
      await this.#createPayment(result.ctx, result.order);
      return this.get(result.ctx.requestId);
    }
    return this.get(result.requestId);
  }

  /**
   * Releases budget that nobody will use: approvals past their deadline, and orders the buyer never approved
   * before the reservation expired. Run periodically. Returns how many requests it closed.
   */
  async sweepExpired(): Promise<number> {
    const { db } = this.#deps;
    const now = this.#now();
    const stale = await db.query<{ request_id: string }>(
      `SELECT a.purchase_request_id AS request_id FROM approval a WHERE a.status = 'PENDING' AND a.expires_at <= $1
       UNION
       SELECT o.purchase_request_id FROM payment_order o
         JOIN budget_reservation br ON br.policy_decision_id = o.policy_decision_id
        WHERE o.state = 'PAYMENT_PENDING' AND br.state = 'HELD' AND br.expires_at <= $1`,
      [now],
    );
    let closed = 0;
    for (const { request_id: requestId } of stale.rows) {
      const did = await db.transaction(async (tx) => {
        const approval = await this.#approvalByRequest(tx, requestId);
        if (approval?.status === 'PENDING' && new Date(approval.expires_at).getTime() <= now.getTime()) {
          await this.#closeApproval(tx, this.#ctxOf(approval), approval, 'EXPIRED', now);
          return true;
        }
        const order = await tx.query<{ id: string; reservation_id: string; organization_id: string; mandate_id: string; requester_user_id: string }>(
          `SELECT o.id, br.id AS reservation_id, m.organization_id, pr.mandate_id, pr.requester_user_id
             FROM payment_order o
             JOIN budget_reservation br ON br.policy_decision_id = o.policy_decision_id
             JOIN purchase_request pr ON pr.id = o.purchase_request_id
             JOIN mandate m ON m.id = pr.mandate_id
            WHERE o.purchase_request_id = $1 AND o.state = 'PAYMENT_PENDING' AND br.state = 'HELD' AND br.expires_at <= $2
              FOR UPDATE OF o`,
          [requestId, now],
        );
        const o = order.rows[0];
        if (!o) return false;
        const ctx: Context = { requestId, mandateId: o.mandate_id, organizationId: o.organization_id, requesterUserId: o.requester_user_id };
        await tx.query("UPDATE payment_order SET state = 'FAILED' WHERE id = $1", [o.id]);
        await this.#event(tx, o.id, 'expired', 'PAYMENT_PENDING', 'FAILED', {});
        await releaseReservation(tx, o.reservation_id, now);
        await tx.query("UPDATE purchase_request SET status = 'FAILED', failure_code = 'EXPIRED' WHERE id = $1", [requestId]);
        await this.#audit(tx, ctx, 'system', null, 'payment.expired', {});
        return true;
      });
      if (did) closed += 1;
    }
    return closed;
  }

  async #openOrder(tx: Queryable, ctx: Context, decisionId: string, amount: Money, approvalId: string | null = null): Promise<string> {
    const order = await tx.query<{ id: string }>(
      `INSERT INTO payment_order (purchase_request_id, policy_decision_id, approval_id, idempotency_key, state, payment_variant, amount_minor_units, currency)
       VALUES ($1, $2, $3, $4, 'PAYMENT_PENDING', 'APPROVAL_LINK', $5, $6) RETURNING id`,
      [ctx.requestId, decisionId, approvalId, `pay-${decisionId}`, amount.amountMinor, amount.currency],
    );
    const orderId = order.rows[0]?.id ?? '';
    await this.#event(tx, orderId, 'created', null, 'PAYMENT_PENDING', {});
    await this.#setStatus(tx, ctx.requestId, 'PAYMENT_PENDING');
    return orderId;
  }

  async #notifyApprover(
    ctx: Context,
    approval: { approvalId: string; token: string; expiresAt: Date; amount: Money; reasons: Reason[] },
  ): Promise<void> {
    const { approvalNotifier, db } = this.#deps;
    if (!approvalNotifier) return;
    try {
      await approvalNotifier.notify({ ...approval, purchaseId: ctx.requestId });
      await this.#audit(db, ctx, 'system', null, 'approval.notified', {});
    } catch {
      // The request stays PENDING_APPROVAL and the budget held; the sweep releases it at expiry.
      await this.#audit(db, ctx, 'system', null, 'approval.notify_failed', {});
    }
  }

  async #requote(requestId: string): Promise<Money | undefined> {
    const { db, catalog } = this.#deps;
    const lines = await db.query<{ external_product_id: string; quantity: number; currency: string }>(
      `SELECT ps.external_product_id, ci.quantity, c.currency
         FROM cart c JOIN cart_item ci ON ci.cart_id = c.id JOIN product_snapshot ps ON ps.id = ci.product_snapshot_id
        WHERE c.purchase_request_id = $1`,
      [requestId],
    );
    if (!catalog.requote || lines.rows.length === 0) return undefined;
    const prices = await catalog.requote(lines.rows.map((l) => l.external_product_id));
    let total = 0n;
    for (const line of lines.rows) {
      const price = prices.get(line.external_product_id);
      if (!price || price.currency !== line.currency) return undefined;
      total += BigInt(price.amountMinor) * BigInt(line.quantity);
    }
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return { amountMinor: Number(total), currency: lines.rows[0]?.currency ?? '' };
  }

  async #closeApproval(tx: Queryable, ctx: Context, approval: ApprovalRow, outcome: 'REJECTED' | 'EXPIRED', now: Date, channel: string | null = null): Promise<void> {
    await tx.query('UPDATE approval SET status = $2, decided_at = $3, channel = COALESCE($4, channel) WHERE id = $1', [approval.id, outcome, now, channel]);
    await releaseReservation(tx, approval.reservation_id, now);
    await this.#setStatus(tx, ctx.requestId, outcome);
    await this.#audit(
      tx,
      ctx,
      outcome === 'REJECTED' ? 'user' : 'system',
      outcome === 'REJECTED' ? approval.approver_user_id : null,
      outcome === 'REJECTED' ? 'approval.rejected' : 'approval.expired',
      channel ? { channel } : {},
    );
  }

  #ctxOf(approval: ApprovalRow): Context {
    return {
      requestId: approval.request_id,
      mandateId: approval.mandate_id,
      organizationId: approval.organization_id,
      requesterUserId: approval.requester_user_id,
    };
  }

  async #approvalByHash(q: Queryable, tokenHash: string, lock = false): Promise<ApprovalRow | undefined> {
    return (await q.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.token_hash = $1${lock ? ' FOR UPDATE OF a' : ''}`, [tokenHash])).rows[0];
  }

  async #approvalByRequest(q: Queryable, requestId: string): Promise<ApprovalRow | undefined> {
    return (await q.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.purchase_request_id = $1 FOR UPDATE OF a`, [requestId])).rows[0];
  }

  /** Runs after the decision transaction commits, so the idempotency key is stored before money can move. */
  async #createPayment(ctx: Context, order: { orderId: string; decisionId: string; reservationId: string; amount: Money }): Promise<void> {
    const { db, payments } = this.#deps;
    try {
      const created = await payments.createOrder({
        amount: order.amount,
        idempotencyKey: `pay-${order.decisionId}`,
        reference: order.decisionId,
        // Fixed text only: retailer or model text never goes to PayPal.
        description: `Mandate purchase ${ctx.requestId}`,
      });
      await db.transaction(async (tx) => {
        // Also the success path of a reconcile retry, which starts from UNKNOWN_OUTCOME.
        await tx.query(
          "UPDATE payment_order SET provider_order_id = $2, provider_status = $3, approve_url = $4, state = 'PAYMENT_PENDING' WHERE id = $1",
          [order.orderId, created.providerOrderId, created.status, created.approveUrl ?? null],
        );
        await this.#setStatus(tx, ctx.requestId, 'PAYMENT_PENDING');
        await this.#event(tx, order.orderId, 'provider_order_created', null, 'PAYMENT_PENDING', { providerStatus: created.status });
        await this.#audit(tx, ctx, 'system', null, 'payment.order_created', { providerStatus: created.status });
      });
    } catch (error) {
      const failure = asGatewayError(error);
      if (failure.kind === 'UNKNOWN_OUTCOME') return this.#markUnknown(ctx, order.orderId, failure.code);
      await db.transaction(async (tx) => {
        await tx.query("UPDATE payment_order SET state = 'FAILED' WHERE id = $1", [order.orderId]);
        await this.#event(tx, order.orderId, 'failed', 'PAYMENT_PENDING', 'FAILED', { code: failure.code });
        await releaseReservation(tx, order.reservationId, this.#now());
        await tx.query("UPDATE purchase_request SET status = 'FAILED', failure_code = $2 WHERE id = $1", [ctx.requestId, failure.code]);
        await this.#audit(tx, ctx, 'system', null, 'payment.failed', { code: failure.code });
      });
    }
  }

  /** The reservation stays HELD: the money may have moved. Reconciliation via get-order is #13. */
  async #orderRow(requestId: string): Promise<OrderRow | undefined> {
    const { rows } = await this.#deps.db.query<OrderRow>(
      `SELECT o.id, o.state, o.provider_order_id, o.amount_minor_units, o.currency, o.policy_decision_id,
              m.organization_id, pr.mandate_id, pr.requester_user_id
         FROM payment_order o JOIN purchase_request pr ON pr.id = o.purchase_request_id JOIN mandate m ON m.id = pr.mandate_id
        WHERE o.purchase_request_id = $1`,
      [requestId],
    );
    return rows[0];
  }

  async #markCaptured(ctx: Context, order: OrderRow, amount: Money, providerStatus: string, fromState: string): Promise<void> {
    await this.#deps.db.transaction(async (tx) => {
      await tx.query("UPDATE payment_order SET state = 'CAPTURED', provider_status = $2 WHERE id = $1", [order.id, providerStatus]);
      await this.#event(tx, order.id, 'captured', fromState, 'CAPTURED', { providerStatus });
      const reservation = await this.#reservationFor(tx, order.policy_decision_id);
      if (reservation) await commitReservation(tx, reservation);
      await this.#setStatus(tx, ctx.requestId, 'CAPTURED');
      await this.#audit(tx, ctx, 'system', null, 'payment.captured', { amountMinor: amount.amountMinor, currency: amount.currency });
    });
  }

  async #markUnknown(ctx: Context, orderId: string, code: string): Promise<void> {
    await this.#deps.db.transaction(async (tx) => {
      await tx.query("UPDATE payment_order SET state = 'UNKNOWN_OUTCOME' WHERE id = $1", [orderId]);
      await this.#event(tx, orderId, 'unknown_outcome', 'PAYMENT_PENDING', 'UNKNOWN_OUTCOME', { code });
      await this.#setStatus(tx, ctx.requestId, 'UNKNOWN_OUTCOME');
      await this.#audit(tx, ctx, 'system', null, 'payment.unknown_outcome', { code });
    });
  }

  async #findByKey(input: SubmitInput): Promise<string | undefined> {
    const { rows } = await this.#deps.db.query<{ id: string; mandate_id: string; requester_user_id: string; raw_text: string }>(
      'SELECT id, mandate_id, requester_user_id, raw_text FROM purchase_request WHERE request_key = $1',
      [input.requestKey],
    );
    const row = rows[0];
    if (!row) return undefined;
    // Same key, different request: refuse instead of returning someone else's result.
    if (row.mandate_id !== input.mandateId || row.requester_user_id !== input.requesterUserId || row.raw_text !== input.text) {
      throw new PurchaseError('REQUEST_KEY_CONFLICT');
    }
    return row.id;
  }

  async #exists(requestId: string): Promise<boolean> {
    return (await this.#deps.db.query('SELECT 1 FROM purchase_request WHERE id = $1', [requestId])).rows.length > 0;
  }

  async #reservationFor(tx: Queryable, decisionId: string): Promise<string | undefined> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM budget_reservation WHERE policy_decision_id = $1', [decisionId]);
    return rows[0]?.id;
  }

  async #fail(ctx: Context, code: string): Promise<void> {
    await this.#deps.db.query("UPDATE purchase_request SET status = 'FAILED', failure_code = $2 WHERE id = $1", [ctx.requestId, code]);
    await this.#audit(this.#deps.db, ctx, 'system', null, 'request.failed', { code });
  }

  async #setStatus(q: Queryable, requestId: string, status: PurchaseStatus): Promise<void> {
    await q.query('UPDATE purchase_request SET status = $2 WHERE id = $1', [requestId, status]);
  }

  async #event(q: Queryable, orderId: string, type: string, from: string | null, to: string, payload: unknown): Promise<void> {
    await q.query(
      'INSERT INTO order_event (order_id, event_type, from_state, to_state, payload, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [orderId, type, from, to, JSON.stringify(payload), this.#now()],
    );
  }

  async #audit(
    q: Queryable,
    ctx: Context,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    action: string,
    detail: unknown,
    policyVersion: string | null = null,
  ): Promise<void> {
    await q.query(
      `INSERT INTO audit_log (organization_id, actor_type, actor_id, action, subject_type, subject_id, detail, policy_version)
       VALUES ($1, $2, $3, $4, 'purchase_request', $5, $6, $7)`,
      [ctx.organizationId, actorType, actorId, action, ctx.requestId, JSON.stringify(detail), policyVersion],
    );
  }
}
