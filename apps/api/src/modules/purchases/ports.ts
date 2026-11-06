import type { Reason } from '@mandate/policy';
import type { Candidate, Money, Proposal, PurchaseIntent } from '@mandate/shared';

/**
 * The purchase flow depends on these interfaces, not on the LLM or PayPal directly. Real implementations:
 * intent parser (#17), catalog (#16) and ranker (#18) from packages/llm; the payment gateway from
 * modules/payments (the only module allowed to import @mandate/payments, hard rule 1).
 */

export interface IntentParser {
  parse(text: string): Promise<PurchaseIntent>;
}

/** A normalized, quarantined candidate plus what the policy engine needs that the model never sees. */
export interface CatalogProduct {
  candidate: Candidate;
  /** Category slug set by catalog normalization (docs/llm-layer.md section 3). */
  category: string;
  provider: string;
  /** The raw catalog response for this product, kept for eval replay and disputes. */
  raw: unknown;
}

export interface Catalog {
  search(intent: PurchaseIntent): Promise<CatalogProduct[]>;
  /**
   * Current unit prices by source product id, for the re-quote before paying an approved order.
   * Optional: a catalog without it skips the price-drift check (VERIFY with #16 that Channel3 supports it).
   */
  requote?(sourceProductIds: readonly string[]): Promise<ReadonlyMap<string, Money>>;
}

export interface ApprovalRequest {
  approvalId: string;
  purchaseId: string;
  /** Single-use secret for the approve/reject link. Never log or store it. */
  token: string;
  expiresAt: Date;
  amount: Money;
  reasons: readonly Reason[];
}

export interface ApprovalNotifier {
  notify(request: ApprovalRequest): Promise<void>;
}

export interface Ranker {
  /** Returns candidate ids and quantities only. Prices in the proposal, if any, are never read. */
  rank(intent: PurchaseIntent, candidates: readonly Candidate[]): Promise<Proposal>;
}

export interface GatewayOrder {
  providerOrderId: string;
  /** PayPal's order status, e.g. PAYER_ACTION_REQUIRED or COMPLETED. */
  status: string;
  approveUrl?: string;
  /** Sum of COMPLETED captures, when PayPal reports any. */
  capturedAmount?: Money;
  /** A capture is PENDING: PayPal took the money but has not settled it. Not paid yet; the budget stays held. */
  capturePending?: true;
}

export type GatewayFailureKind = 'UNKNOWN_OUTCOME' | 'REJECTED';

/** A payment failure with the outcome classified. UNKNOWN_OUTCOME must be reconciled, never retried blindly. */
export class GatewayError extends Error {
  readonly kind: GatewayFailureKind;
  readonly code: string;

  constructor(kind: GatewayFailureKind, code: string) {
    super(`Payment ${kind === 'UNKNOWN_OUTCOME' ? 'outcome unknown' : 'rejected'}: ${code}`);
    this.name = 'GatewayError';
    this.kind = kind;
    this.code = code;
  }
}

export interface PaymentGateway {
  createOrder(input: { amount: Money; idempotencyKey: string; reference: string; description: string }): Promise<GatewayOrder>;
  captureOrder(providerOrderId: string, idempotencyKey: string, expected: Money): Promise<GatewayOrder>;
  /** Read-only and authoritative: reconciliation trusts this, never a webhook payload. */
  getOrder(providerOrderId: string): Promise<GatewayOrder>;
  /** Throws when PayPal cannot be asked, so the webhook is answered non-2xx and redelivered. */
  verifyWebhook(headers: Readonly<Record<string, string | string[] | undefined>>, event: unknown): Promise<boolean>;
}
