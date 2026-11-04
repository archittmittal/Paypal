import { type Money, MoneySchema } from '@mandate/shared';
import type { TransactionClient } from './pool.js';

/**
 * What PayPal returned for a capture, as the payments module read it from captureOrder() or getOrder(). This module
 * never calls PayPal (hard rule 1: only packages/payments does); it records evidence the caller already verified.
 */
export interface CaptureEvidence {
  providerOrderId: string;
  captureId: string;
  /** PayPal's capture status. Only COMPLETED is recorded as a capture. */
  status: string;
  amount: Money;
}

export type RecordCaptureResult =
  | { ok: true; alreadyRecorded: boolean }
  /**
   * HOLD_NOT_HELD: the decision's reservation is not HELD (or is missing), so the spend could not be committed and
   * nothing was written. The capture is real at PayPal: the caller must keep the evidence and escalate to
   * reconciliation, never drop it.
   */
  | { ok: false; reason: 'ORDER_NOT_FOUND' | 'NOT_COMPLETED' | 'AMOUNT_MISMATCH' | 'PROVIDER_ORDER_MISMATCH' | 'ORDER_NOT_CAPTURABLE' | 'HOLD_NOT_HELD' };

/**
 * Marks an order CAPTURED with its PayPal evidence and turns its hold into committed spend, in the caller's
 * transaction (findings H1, H2). Migration 0006 enforces the same rules again: an order reaches CAPTURED only from
 * PAYMENT_PENDING or UNKNOWN_OUTCOME and only with complete evidence of a COMPLETED capture of exactly the order
 * amount, and a hold commits only against such an order, for the captured amount.
 *
 * Idempotent: recording the same capture again returns alreadyRecorded=true. Never call it on the strength of the
 * database alone; the evidence must come from PayPal's response for this order.
 */
export async function recordVerifiedCapture(client: TransactionClient, orderId: string, evidence: CaptureEvidence): Promise<RecordCaptureResult> {
  const amount = MoneySchema.parse(evidence.amount);
  const { rows } = await client.query<{
    state: string;
    amount_minor_units: number;
    currency: string;
    provider_order_id: string | null;
    provider_capture_id: string | null;
    policy_decision_id: string;
  }>(
    `SELECT state, amount_minor_units, currency, provider_order_id, provider_capture_id, policy_decision_id
       FROM public.purchase_order WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const order = rows[0];
  if (order === undefined) return { ok: false, reason: 'ORDER_NOT_FOUND' };
  if (order.provider_capture_id !== null) {
    return order.provider_capture_id === evidence.captureId ? { ok: true, alreadyRecorded: true } : { ok: false, reason: 'ORDER_NOT_CAPTURABLE' };
  }
  if (evidence.status !== 'COMPLETED') return { ok: false, reason: 'NOT_COMPLETED' };
  if (amount.amountMinor !== order.amount_minor_units || amount.currency !== order.currency) return { ok: false, reason: 'AMOUNT_MISMATCH' };
  if (order.provider_order_id !== null && order.provider_order_id !== evidence.providerOrderId) return { ok: false, reason: 'PROVIDER_ORDER_MISMATCH' };
  if (order.state !== 'PAYMENT_PENDING' && order.state !== 'UNKNOWN_OUTCOME') return { ok: false, reason: 'ORDER_NOT_CAPTURABLE' };
  // Check, and lock, the hold before writing anything, so the order and the spend are recorded together or not at
  // all (third review, M1).
  const hold = await client.query<{ state: string }>(
    'SELECT state FROM public.budget_reservation WHERE policy_decision_id = $1 FOR UPDATE',
    [order.policy_decision_id],
  );
  if (hold.rows[0]?.state !== 'HELD') return { ok: false, reason: 'HOLD_NOT_HELD' };

  await client.query(
    `UPDATE public.purchase_order
        SET state = 'CAPTURED', provider_order_id = $2, provider_capture_id = $3, capture_status = $4,
            captured_amount_minor_units = $5, captured_currency = $6
      WHERE id = $1`,
    [orderId, evidence.providerOrderId, evidence.captureId, evidence.status, amount.amountMinor, amount.currency],
  );
  const committed = await client.query(
    `UPDATE public.budget_reservation
        SET state = 'COMMITTED', committed_amount_minor_units = $2
      WHERE policy_decision_id = $1 AND state = 'HELD'`,
    [order.policy_decision_id, amount.amountMinor],
  );
  // The hold is locked above, so this cannot happen; if it ever does, fail the transaction rather than report success.
  if (committed.rowCount !== 1) throw new Error('the hold changed while locked; nothing should be committed');
  return { ok: true, alreadyRecorded: false };
}

export interface RequestRefundInput {
  orderId: string;
  /** Generated before the refund call to PayPal and reused on every retry of it. */
  idempotencyKey: string;
  amount: Money;
  reason?: string;
}

export type RequestRefundResult =
  | { ok: true; created: boolean; refundId: string }
  | { ok: false; reason: 'ORDER_NOT_FOUND' | 'ORDER_NOT_CAPTURED' | 'CURRENCY_MISMATCH' | 'EXCEEDS_CAPTURED' | 'IDEMPOTENCY_KEY_REUSED' };

/**
 * Records that a refund is being requested, before the payments module calls PayPal (decision 4, migration 0007). The
 * order's own state never changes: refunds are tracked in their own rows. Refunds requested or completed for an order
 * never exceed what was captured. Idempotent on the key: a retry returns the same refund.
 */
export async function requestRefund(client: TransactionClient, input: RequestRefundInput): Promise<RequestRefundResult> {
  const amount = MoneySchema.parse(input.amount);
  const existing = await client.query<{ id: string; order_id: string; amount_minor_units: number; currency: string }>(
    'SELECT id, order_id, amount_minor_units, currency FROM public.refund WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    const same = prior.order_id === input.orderId.toLowerCase() && prior.amount_minor_units === amount.amountMinor && prior.currency === amount.currency;
    return same ? { ok: true, created: false, refundId: prior.id } : { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
  }
  // The same lock the refund trigger takes, so the sum below cannot go stale before the insert.
  const order = await client.query<{ state: string; currency: string; captured: number | null }>(
    'SELECT state, currency, captured_amount_minor_units AS captured FROM public.purchase_order WHERE id = $1 FOR NO KEY UPDATE',
    [input.orderId],
  );
  const o = order.rows[0];
  if (o === undefined) return { ok: false, reason: 'ORDER_NOT_FOUND' };
  if (o.captured === null || !['CAPTURED', 'SHIPPED', 'DELIVERED'].includes(o.state)) return { ok: false, reason: 'ORDER_NOT_CAPTURED' };
  if (o.currency !== amount.currency) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  const open = await client.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_minor_units), 0)::bigint AS total FROM public.refund WHERE order_id = $1 AND status <> 'REJECTED'`,
    [input.orderId],
  );
  if ((open.rows[0]?.total ?? 0) + amount.amountMinor > o.captured) return { ok: false, reason: 'EXCEEDS_CAPTURED' };
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.refund (order_id, idempotency_key, amount_minor_units, currency, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.orderId, input.idempotencyKey, amount.amountMinor, amount.currency, input.reason ?? null],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('INSERT ... RETURNING returned no row');
  return { ok: true, created: true, refundId: id };
}

/** What PayPal returned for a refund, as the payments module read it. */
export interface RefundEvidence {
  providerRefundId: string;
  /** PayPal's refund status. Only COMPLETED completes the refund; anything final and unsuccessful rejects it. */
  status: string;
  amount: Money;
}

export type RecordRefundResult =
  | { ok: true; outcome: 'COMPLETED' | 'REJECTED'; alreadyRecorded: boolean }
  | { ok: false; reason: 'REFUND_NOT_FOUND' | 'AMOUNT_MISMATCH' | 'STILL_PENDING' | 'CONFLICTING_OUTCOME' };

/** PayPal refund statuses that end a refund without money returned. PENDING is not one of them. */
const UNSUCCESSFUL_REFUND = new Set(['FAILED', 'CANCELLED']);

/**
 * Records PayPal's verified outcome of a refund. COMPLETED only with PayPal status COMPLETED for exactly the requested
 * amount; FAILED or CANCELLED rejects it; PENDING records nothing. Either way the captured order keeps its state: a
 * rejected refund never turns a captured payment into FAILED (decision 4).
 */
export async function recordRefundOutcome(client: TransactionClient, refundId: string, evidence: RefundEvidence): Promise<RecordRefundResult> {
  const amount = MoneySchema.parse(evidence.amount);
  const { rows } = await client.query<{ status: string; amount_minor_units: number; currency: string; provider_refund_id: string | null }>(
    'SELECT status, amount_minor_units, currency, provider_refund_id FROM public.refund WHERE id = $1 FOR UPDATE',
    [refundId],
  );
  const refund = rows[0];
  if (refund === undefined) return { ok: false, reason: 'REFUND_NOT_FOUND' };
  const outcome = evidence.status === 'COMPLETED' ? 'COMPLETED' : UNSUCCESSFUL_REFUND.has(evidence.status) ? 'REJECTED' : undefined;
  if (outcome === undefined) return { ok: false, reason: 'STILL_PENDING' };
  if (refund.status !== 'REQUESTED') {
    return refund.status === outcome && refund.provider_refund_id === evidence.providerRefundId
      ? { ok: true, outcome, alreadyRecorded: true }
      : { ok: false, reason: 'CONFLICTING_OUTCOME' };
  }
  if (outcome === 'COMPLETED' && (amount.amountMinor !== refund.amount_minor_units || amount.currency !== refund.currency)) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }
  await client.query('UPDATE public.refund SET status = $2, provider_refund_id = $3, provider_status = $4 WHERE id = $1', [
    refundId,
    outcome,
    evidence.providerRefundId,
    evidence.status,
  ]);
  return { ok: true, outcome, alreadyRecorded: false };
}
