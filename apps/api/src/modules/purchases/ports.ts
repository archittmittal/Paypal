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
}
